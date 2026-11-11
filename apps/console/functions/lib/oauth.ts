/**
 * OAuth sign-in for Google and GitHub.
 *
 * Flow: /api/auth/oauth/:provider/start sets a signed state cookie and
 * redirects to the provider; /callback exchanges the code, fetches the
 * verified email, finds or creates the Bridgistic account (with a personal
 * workspace) and issues the normal session cookie. Client secrets live only
 * in deployment secrets — the buttons render only for configured providers.
 */

import { createSession, sessionCookies, sharedCookieDomain } from "./auth.ts";

export interface OAuthEnv {
  DB: D1Database;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
}

export function providerConfigured(env: OAuthEnv, provider: string): boolean {
  if (provider === "github") return Boolean(env.GITHUB_CLIENT_ID && env.GITHUB_CLIENT_SECRET);
  if (provider === "google") return Boolean(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);
  return false;
}

function callbackUrl(request: Request, provider: string): string {
  const url = new URL(request.url);
  return `${url.origin}/api/auth/oauth/${provider}/callback`;
}

function b64url(input: ArrayBuffer | Uint8Array): string {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Hosts an OAuth flow may return the user to. Anything else is ignored. */
const RETURN_HOSTS = new Set(["dashboard.bridgistic.app", "admin.bridgistic.app", "marketplace.bridgistic.app", "bridgistic.app"]);

export const MEMBER_HOME = "https://dashboard.bridgistic.app/";

function safeReturnUrl(raw: string | null): string | null {
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" || !RETURN_HOSTS.has(url.hostname)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

async function createState(db: D1Database, nextUrl: string | null): Promise<string> {
  const state = b64url(crypto.getRandomValues(new Uint8Array(24)));
  await db
    .prepare("INSERT INTO oauth_states (state, provider, next_url, expires_at) VALUES (?, 'generic', ?, ?)")
    .bind(state, nextUrl ?? "", new Date(Date.now() + 600_000).toISOString())
    .run();
  return state;
}

/** Marks the state consumed and returns the validated return origin, if any. */
async function consumeState(db: D1Database, state: string): Promise<string | null> {
  const row = await db
    .prepare("SELECT state, next_url FROM oauth_states WHERE state = ? AND expires_at > ?")
    .bind(state, new Date().toISOString())
    .first<{ state: string; next_url: string }>();
  if (!row) return null;
  await db.prepare("DELETE FROM oauth_states WHERE state = ?").bind(state).run();
  return safeReturnUrl(row.next_url);
}

export async function oauthStart(request: Request, env: OAuthEnv, provider: string): Promise<Response> {
  if (!providerConfigured(env, provider)) {
    return Response.json({ error: "provider_not_configured", message: `${provider} sign-in is not configured on this deployment.` }, { status: 503 });
  }
  const redirect = callbackUrl(request, provider);
  const returnTo = safeReturnUrl(new URL(request.url).searchParams.get("next"));
  const state = await createState(env.DB, returnTo);
  const authorize =
    provider === "github"
      ? `https://github.com/login/oauth/authorize?client_id=${encodeURIComponent(env.GITHUB_CLIENT_ID!)}&redirect_uri=${encodeURIComponent(redirect)}&scope=${encodeURIComponent("read:user user:email")}&state=${encodeURIComponent(state)}`
      : `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(env.GOOGLE_CLIENT_ID!)}&redirect_uri=${encodeURIComponent(redirect)}&response_type=code&scope=${encodeURIComponent("openid email profile")}&state=${encodeURIComponent(state)}`;
  return new Response(null, { status: 302, headers: { Location: authorize } });
}

interface Profile {
  email: string;
  name: string;
}

async function exchangeGithub(env: OAuthEnv, code: string, redirect: string): Promise<Profile | null> {
  const tokenRes = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: redirect }),
  });
  const tokenJson = (await tokenRes.json()) as { access_token?: string };
  if (!tokenJson.access_token) return null;
  const headers = { Authorization: `Bearer ${tokenJson.access_token}`, Accept: "application/vnd.github+json", "User-Agent": "bridgistic-console" };
  const userRes = await fetch("https://api.github.com/user", { headers });
  const user = (await userRes.json()) as { name?: string; login?: string; email?: string | null };
  let email = user.email ?? "";
  if (!email) {
    const emailRes = await fetch("https://api.github.com/user/emails", { headers });
    const emails = (await emailRes.json()) as { email: string; primary: boolean; verified: boolean }[];
    email = (Array.isArray(emails) ? emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified) : undefined)?.email ?? "";
  }
  if (!email) return null;
  return { email: email.toLowerCase(), name: user.name || user.login || email.split("@")[0] };
}

async function exchangeGoogle(env: OAuthEnv, code: string, redirect: string): Promise<Profile | null> {
  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID!,
      client_secret: env.GOOGLE_CLIENT_SECRET!,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirect,
    }),
  });
  const tokenJson = (await tokenRes.json()) as { access_token?: string };
  if (!tokenJson.access_token) return null;
  const infoRes = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${tokenJson.access_token}` },
  });
  const info = (await infoRes.json()) as { email?: string; email_verified?: boolean; name?: string };
  if (!info.email || info.email_verified === false) return null;
  return { email: info.email.toLowerCase(), name: info.name || info.email.split("@")[0] };
}

export async function oauthCallback(request: Request, env: OAuthEnv, provider: string, url: URL): Promise<Response> {
  const code = url.searchParams.get("code") ?? "";
  const state = url.searchParams.get("state") ?? "";
  const fail = (reason: string) =>
    new Response(null, { status: 302, headers: { Location: `/signin?oauth_error=${encodeURIComponent(reason)}` } });
  if (!providerConfigured(env, provider)) return fail("provider_not_configured");
  if (!code || !state) return fail("invalid_state");
  const returnTo = await consumeState(env.DB, state);
  if (returnTo === null) return fail("invalid_state");

  const redirect = callbackUrl(request, provider);
  const profile = provider === "github" ? await exchangeGithub(env, code, redirect) : await exchangeGoogle(env, code, redirect);
  if (!profile) return fail("exchange_failed");

  const db = env.DB;
  let user = await db.prepare("SELECT id, email, name, role, status FROM users WHERE email = ?").bind(profile.email).first<{ id: string; email: string; name: string; role: string; status: string }>();
  if (!user) {
    const id = crypto.randomUUID();
    await db
      .prepare("INSERT INTO users (id, email, name, password_hash, role) VALUES (?, ?, ?, 'oauth', 'member')")
      .bind(id, profile.email, profile.name)
      .run();
    const orgId = crypto.randomUUID();
    await db.prepare("INSERT INTO orgs (id, name, plan, owner_user_id) VALUES (?, ?, 'free', ?)").bind(orgId, `${profile.name}'s workspace`, id).run();
    await db.prepare("INSERT INTO memberships (org_id, user_id, role) VALUES (?, ?, 'owner')").bind(orgId, id).run();
    user = { id, email: profile.email, name: profile.name, role: "member", status: "active" };
    await db.prepare("INSERT INTO audit (id, actor, action, target, detail) VALUES (?, ?, 'user.oauth_signup', ?, ?)").bind(crypto.randomUUID(), profile.email, profile.email, provider).run();
  }
  if (user.status !== "active") return fail("account_disabled");
  // The provider verified this email. An unverified password account with the
  // same email may have been created by someone else: verify it, drop its
  // password and sign out its other sessions so only the inbox owner remains.
  const verified = await db.prepare("SELECT email_verified_at FROM users WHERE id = ?").bind(user.id).first<{ email_verified_at: string | null }>();
  if (!verified?.email_verified_at) {
    await db.prepare("UPDATE users SET email_verified_at = datetime('now'), password_hash = CASE WHEN password_hash = 'oauth' THEN password_hash ELSE 'oauth' END WHERE id = ?").bind(user.id).run();
    await db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id).run();
  }

  // Staff land on the console (their root routes to the master dashboard);
  // every non-staff account lands on the member dashboard, and an explicit
  // `next` origin (validated against the allowlist) always wins.
  const landing = returnTo ?? (user.role === "owner" || user.role === "admin" ? new URL(request.url).origin : MEMBER_HOME);
  const sessionId = await createSession(db, user.id);
  const headers = new Headers({ Location: landing });
  for (const cookie of sessionCookies(sessionId, undefined, sharedCookieDomain(new URL(request.url).hostname))) {
    headers.append("Set-Cookie", cookie);
  }
  return new Response(null, { status: 302, headers });
}

/** Which providers this deployment can offer on the sign-in buttons. */
export function oauthProviders(env: OAuthEnv): { github: boolean; google: boolean } {
  return { github: providerConfigured(env, "github"), google: providerConfigured(env, "google") };
}
