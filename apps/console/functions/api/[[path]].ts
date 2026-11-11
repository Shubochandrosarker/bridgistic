/**
 * Bridgistic console API — one catch-all Pages Function.
 *
 * Surfaces:
 *   /api/health                     liveness
 *   /api/auth/*                     signup / signin / signout / me
 *   /api/orgs, /api/sites/*         workspaces and connected WordPress sites
 *   /api/v1/licenses/*              the WPistic license contract (plugin-facing)
 *   /api/market/*                   the skills marketplace (public + gated files)
 *   /api/ai/generate                website-agent generation via the stored AI key
 *   /api/admin/*                    platform admin (owner/staff only)
 *   /api/webhooks/appsumo           AppSumo license webhook (when the secret is set)
 *   /api/appsumo/redeem             signed-in AppSumo code redemption
 */

import { hashPassword, verifyPassword, randomHex, encryptSecret, decryptSecret } from "../lib/crypto.ts";
import {
  HttpError,
  audit,
  clearedSessionCookies,
  createSession,
  currentUser,
  destroySession,
  getSetting,
  putSetting,
  requireOrgMember,
  requireOwner,
  requireUser,
  sessionCookies,
  sharedCookieDomain,
  syncLog,
  userOrgs,
  type User,
} from "../lib/auth.ts";
import { activateLicense, deactivateLicense, issueLicense, licenseKey, maskKey, validateLicense, type LicenseRow } from "../lib/licenses.ts";
import { handleAppsumoRedeem, handleAppsumoWebhook, seedMarketplaceCode } from "../lib/appsumo.ts";
import { callSite, keyMask, normalizeSiteUrl, SiteCallError } from "../lib/wp.ts";
import { catalogForClient, listActionRuns, runAction } from "../lib/actions.ts";
import { listAgentRuns, listAgents, runAgent } from "../lib/agents.ts";
import { chat, type ChatMessage } from "../lib/ai.ts";
import { gunzipSync, zipSync, type Zippable } from "fflate";
import { oauthCallback, oauthProviders, oauthStart, type OAuthEnv } from "../lib/oauth.ts";
import { handlePasswordForgot, handlePasswordReset, handleVerifyConfirm, handleVerifyResend, isEmailVerified, sendVerification, unverifiedResponse } from "../lib/email-auth.ts";

/** Skills whose file payload exceeded D1's statement limit are stored gzipped with a `gz:` prefix. */
function parseFiles(raw: string): { path: string; size: number; text: string }[] {
  const value = raw.startsWith("gz:") ? new TextDecoder().decode(gunzipSync(Uint8Array.from(atob(raw.slice(3)), (c) => c.charCodeAt(0)))) : raw;
  return JSON.parse(value);
}

/** Origins allowed to call the API with credentials (the dashboard SPA). */
const TRUSTED_ORIGINS = new Set([
  "https://bridgistic.app",
  "https://www.bridgistic.app",
  "https://dashboard.bridgistic.app",
  "https://app.bridgistic.app",
  "https://pay.bridgistic.app",
  "https://admin.bridgistic.app",
  "https://marketplace.bridgistic.app",
]);

function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("Origin") ?? "";
  if (!origin || !TRUSTED_ORIGINS.has(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

export const onRequest: PagesFunction<Env> = async (context) => {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/api";
  const cors = corsHeaders(request);
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...cors, "Access-Control-Max-Age": "86400" } });
  const withCors = (response: Response): Response => {
    if (!Object.keys(cors).length) return response;
    for (const [k, v] of Object.entries(cors)) response.headers.set(k, v);
    return response;
  };
  try {
    return withCors(await route(request, env, path, url));
  } catch (e) {
    if (e instanceof HttpError) return withCors(Response.json({ error: e.code, message: e.message }, { status: e.status }));
    if (e instanceof SiteCallError) return withCors(Response.json({ error: e.code, message: e.message }, { status: e.status }));
    const message = e instanceof Error ? e.message : "Unexpected error.";
    return withCors(Response.json({ error: "server_error", message }, { status: 500 }));
  }
};

interface Env {
  DB: D1Database;
  ADMIN_SETUP_TOKEN?: string;
  SECRET_ENCRYPTION_KEY?: string;
  LICENSE_SERVICE_TOKEN?: string;
  APPSUMO_WEBHOOK_SECRET?: string;
  OPENROUTER_KEY?: string;
  AI_GATEWAY_URL?: string;
  AI_GATEWAY_TOKEN?: string;
  AI_GATEWAY_MODEL?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  PLATFORM_OWNER_EMAIL?: string;
  CF_EMAIL_API_TOKEN?: string;
  CF_EMAIL_ACCOUNT_ID?: string;
  MAIL_FROM?: string;
  MAIL_FROM_NAME?: string;
  MAIL_REPLY_TO?: string;
  HOSTINGER_MAIL_TOKEN?: string;
  HOSTINGER_MAILBOX_ID?: string;
  PLUGINS?: R2Bucket;
}

// -- Plugin distribution manifest (sanitized: fixed keys, no user input) ----
const PLUGIN_MANIFEST = {
  latest: {
    version: "1.5.12",
    key: "bridgistic-wordpress-plugin-1.5.12.zip",
    filename: "bridgistic-wordpress-plugin-1.5.12.zip",
    size: 1296007,
  },
  github: "https://github.com/Wordpressistic/bridgistic/releases/latest",
  download_path: "/api/plugin/download",
};


async function route(request: Request, env: Env, path: string, url: URL): Promise<Response> {
  const db = env.DB;
  const method = request.method;
  const seg = path.split("/").filter(Boolean);

  if (path === "/api/health" && method === "GET") return Response.json({ ok: true, service: "bridgistic-console" });

  // -- Plugin distribution (R2 stream, sanitized) ----------------------------
  if (path === "/api/plugin/versions" && method === "GET") {
    const user = await currentUser(db, request);
    if (!user) return Response.json({ error: "signin_required", message: "Sign in to download the plugin." }, { status: 401 });
    return Response.json({ plugin: PLUGIN_MANIFEST });
  }

  if (path === "/api/plugin/download" && method === "GET") {
    const user = await currentUser(db, request);
    if (!user) return Response.json({ error: "signin_required", message: "Sign in to download the plugin." }, { status: 401 });
    if (!env.PLUGINS) return Response.json({ error: "storage_unavailable", message: "Plugin storage is not configured." }, { status: 503 });
    const object = await env.PLUGINS.get(PLUGIN_MANIFEST.latest.key);
    if (!object) return Response.json({ error: "not_found", message: "Release artifact missing." }, { status: 404 });
    await audit(db, user.email, "plugin.download", "v" + PLUGIN_MANIFEST.latest.version);
    return new Response(object.body, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${PLUGIN_MANIFEST.latest.filename}"`,
        "Content-Length": String(object.size),
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex",
      },
    });
  }

  // ── Auth ───────────────────────────────────────────────────────────────────
  if (path === "/api/auth/signup" && method === "POST") {
    const body = await request.json<Record<string, string>>();
    const email = String(body.email ?? "").trim().toLowerCase();
    const password = String(body.password ?? "");
    const name = String(body.name ?? "").trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return Response.json({ error: "invalid_email", message: "Enter a valid email." }, { status: 400 });
    if (password.length < 8) return Response.json({ error: "weak_password", message: "The password must be at least 8 characters." }, { status: 400 });
    const existing = await db.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
    if (existing) return Response.json({ error: "email_taken", message: "An account with this email already exists." }, { status: 409 });
    const isOwner = Boolean(env.ADMIN_SETUP_TOKEN) && String(body.setup_token ?? "") === env.ADMIN_SETUP_TOKEN;
    const role = isOwner ? "owner" : "member";
    const id = crypto.randomUUID();
    await db
      .prepare("INSERT INTO users (id, email, name, password_hash, role) VALUES (?, ?, ?, ?, ?)")
      .bind(id, email, name || email.split("@")[0] || "Member", await hashPassword(password), role)
      .run();
    const orgId = crypto.randomUUID();
    const orgName = isOwner ? "Bridgistic Platform" : `${name || email.split("@")[0]}'s workspace`;
    await db.prepare("INSERT INTO orgs (id, name, plan, owner_user_id) VALUES (?, ?, ?, ?)").bind(orgId, orgName, isOwner ? "platform" : "free", id).run();
    await db.prepare("INSERT INTO memberships (org_id, user_id, role) VALUES (?, ?, 'owner')").bind(orgId, id).run();
    await audit(db, email, "user.signup", email, isOwner ? "owner claim" : "self signup");
    if (isOwner) await db.prepare("UPDATE users SET email_verified_at = datetime('now') WHERE id = ?").bind(id).run();
    const verification = isOwner ? { sent: false } : await sendVerification(env, { id, email });
    const sessionId = await createSession(db, id);
    return jsonWithCookie({ ok: true, user: { id, email, name, role, email_verified: isOwner }, verification_sent: verification.sent }, sessionCookies(sessionId, undefined, sharedCookieDomain(url.hostname)));
  }

  if (path === "/api/auth/signin" && method === "POST") {
    const body = await request.json<Record<string, string>>();
    const email = String(body.email ?? "").trim().toLowerCase();
    const row = await db.prepare("SELECT * FROM users WHERE email = ?").bind(email).first<{ id: string; email: string; name: string; role: string; status: string; password_hash: string }>();
    if (!row || row.status !== "active" || !(await verifyPassword(String(body.password ?? ""), row.password_hash))) {
      return Response.json({ error: "invalid_credentials", message: "Email or password is incorrect." }, { status: 401 });
    }
    const sessionId = await createSession(db, row.id);
    return jsonWithCookie({ ok: true, user: { id: row.id, email: row.email, name: row.name, role: row.role, email_verified: isEmailVerified(row as unknown as User) } }, sessionCookies(sessionId, undefined, sharedCookieDomain(url.hostname)));
  }

  if (path === "/api/auth/verify" && method === "POST") return handleVerifyConfirm(env, request);
  if (path === "/api/auth/password/forgot" && method === "POST") return handlePasswordForgot(env, request);
  if (path === "/api/auth/password/reset" && method === "POST") return handlePasswordReset(env, request);

  if (path === "/api/auth/signout" && method === "POST") {
    await destroySession(db, request);
    return jsonWithCookie({ ok: true }, clearedSessionCookies(sharedCookieDomain(url.hostname)));
  }

  // ── OAuth sign-in (Google / GitHub) ────────────────────────────────────────
  if (path === "/api/auth/oauth/providers" && method === "GET") {
    return Response.json({ providers: oauthProviders(env as OAuthEnv) });
  }
  if (seg[1] === "auth" && seg[2] === "oauth" && seg[4] === "start" && method === "GET") {
    return oauthStart(request, env as OAuthEnv, seg[3]);
  }
  if (seg[1] === "auth" && seg[2] === "oauth" && seg[4] === "manifest" && method === "GET") {
    // GitHub App manifest flow lands here with a one-time code; the owner
    // exchanges it for the app credentials, which then live in secrets.
    const manifestCode = url.searchParams.get("code") ?? "";
    const exchange = await fetch(`https://api.github.com/app-manifests/${encodeURIComponent(manifestCode)}/conversions`, {
      method: "POST",
      headers: { Accept: "application/vnd.github+json", "User-Agent": "bridgistic-console" },
    });
    const app = (await exchange.json()) as { slug?: string; client_id?: string; client_secret?: string; html_url?: string };
    return new Response(
      JSON.stringify({ ok: exchange.ok, slug: app.slug, client_id: app.client_id, client_secret: app.client_secret, html_url: app.html_url }, null, 2),
      { status: exchange.ok ? 200 : 502, headers: { "Content-Type": "application/json" } }
    );
  }

  if (seg[1] === "auth" && seg[2] === "oauth" && seg[4] === "callback" && method === "GET") {
    return oauthCallback(request, env as OAuthEnv, seg[3], url);
  }

  // ── WPistic license contract (plugin-facing) ──────────────────────────────
  if (path === "/api/v1/licenses/activate" && method === "POST") return activateLicense(env, await request.json());
  if (path === "/api/v1/licenses/validate" && method === "POST") return validateLicense(env, await request.json());
  if (path === "/api/v1/licenses/deactivate" && method === "POST") return deactivateLicense(db, await request.json());

  if (path === "/api/webhooks/appsumo" && method === "POST") return handleAppsumoWebhook(request, env);

  // ── Marketplace (public reads) ─────────────────────────────────────────────
  if (seg[1] === "market") return marketRoutes(request, env, seg, method, url);

  // ── Dashboard bridge relay ─────────────────────────────────────────────────
  // dashboard.bridgistic.app signs site calls in the browser; on hosts whose
  // edge answers CORS preflights without the right headers those calls can
  // never start. This relay performs the same signed call server-side. The
  // key stays in the caller's browser and is not stored here; the call is
  // still authenticated by the site's HMAC check, and SSRF guards apply.
  //
  // Public by design: connecting a site happens before (or without) a console
  // sign-in, and the site's HMAC check — not a dashboard session — authenticates
  // the call. Sitting above requireUser keeps the signed-out "connect a site"
  // flow working; the relay stores nothing and applies the same SSRF guards.
  if (path === "/api/relay" && method === "POST") {
    const body = await request.json<{ site_id?: string; site_url?: string; key_id?: string; secret?: string; method?: string; path?: string; body?: Record<string, unknown> }>();
    let siteUrl = String(body.site_url ?? "");
    let keyId = String(body.key_id ?? "").trim();
    let secret = String(body.secret ?? "").trim();
    const pairedSiteId = String(body.site_id ?? "").trim();
    if (pairedSiteId) {
      const user = await requireUser(db, request);
      if (!isEmailVerified(user)) return unverifiedResponse();
      const license = await db.prepare("SELECT id, owner_email, status, expires_at, site_connection FROM licenses WHERE id = ?").bind(pairedSiteId).first<{ id: string; owner_email: string; status: string; expires_at: string | null; site_connection: string }>();
      const ownerAccess = user.role === "owner" || user.role === "admin";
      if (!license || (license.owner_email.toLowerCase() !== user.email.toLowerCase() && !ownerAccess)) {
        return Response.json({ error: "site_not_found", message: "That connected site is not available to this account." }, { status: 404 });
      }
      if (license.status !== "active" || (license.expires_at && license.expires_at <= new Date().toISOString())) {
        return Response.json({ error: "license_inactive", message: "This site license is not active." }, { status: 403 });
      }
      if (!license.site_connection || !env.SECRET_ENCRYPTION_KEY) {
        return Response.json({ error: "no_pairing", message: "This site has not published a dashboard pairing yet." }, { status: 404 });
      }
      try {
        const parsed = JSON.parse(license.site_connection) as { site_url?: string; key_id?: string; secret_enc?: string };
        if (!parsed.site_url || !parsed.key_id || !parsed.secret_enc) throw new Error("incomplete pairing");
        siteUrl = parsed.site_url;
        keyId = parsed.key_id;
        secret = await decryptSecret(parsed.secret_enc, env.SECRET_ENCRYPTION_KEY);
      } catch {
        return Response.json({ error: "no_pairing", message: "The stored site pairing is incomplete. Reconnect the site from WordPress." }, { status: 404 });
      }
    }
    siteUrl = normalizeSiteUrl(siteUrl);
    let routePath = String(body.path ?? "site-info").replace(/[^a-z0-9_\-/.?=&]/gi, "");
    const httpMethod = ["GET", "POST", "PUT", "DELETE"].includes(String(body.method ?? "").toUpperCase()) ? (String(body.method).toUpperCase() as "GET" | "POST" | "PUT" | "DELETE") : "GET";
    if (!keyId || !secret) return Response.json({ error: "missing_key", message: "The relay needs a connected site key." }, { status: 400 });
    if (routePath.length > 200) return Response.json({ error: "bad_path", message: "The bridge path is too long." }, { status: 400 });
    // Some host edges cache bridge GETs by URL alone until the plugin marks
    // the namespace no-store (1.5.6). The per-request buster keeps live data
    // correct on 1.5.4/1.5.5 sites too. The plugin's HMAC covers the route
    // only (get_route() drops the query), so callSite signs the route and
    // sends the buster as an unsigned, read-only query param.
    if (httpMethod === "GET") {
      const buster = `_cb=${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
      routePath = `${routePath}${routePath.includes("?") ? "&" : "?"}${buster}`;
    }
    const result = await callSite(siteUrl, keyId, secret, httpMethod, routePath, body.body);
    return Response.json(result, { status: result.ok ? 200 : result.status >= 400 && result.status < 600 ? result.status : 502 });
  }

  // Everything below needs an account.
  const user = await requireUser(db, request);

  if (path === "/api/auth/verify/resend" && method === "POST") return handleVerifyResend(env, user);
  // Licenses, billing and paired sites are matched by email: only an account
  // that proved it owns the inbox may see or use them.
  const EMAIL_ENTITLED = new Set(["/api/me/sites", "/api/me/billing", "/api/me/billing/portal", "/api/me/resolve-license", "/api/me/site-connections"]);
  if (EMAIL_ENTITLED.has(path) && !isEmailVerified(user)) return unverifiedResponse();

  if (path === "/api/appsumo/redeem" && method === "POST") return handleAppsumoRedeem(request, env, user);

  if (path === "/api/me" && method === "GET") {
    const orgs = await userOrgs(db, user.id);
    const unlock = await paidUnlock(db, user);
    return Response.json({ user: { id: user.id, email: user.email, name: user.name, role: user.role, email_verified: isEmailVerified(user) }, orgs, paid_unlock: unlock }, { headers: { "Cache-Control": "no-store" } });
  }

  // Account-owned license activations are the source of truth for the
  // dashboard site picker. This endpoint deliberately returns metadata only;
  // relay calls resolve the encrypted key server-side by license id.
  if (path === "/api/me/sites" && method === "GET") {
    const { results } = await db.prepare(
      `SELECT l.id, l.key, l.plan, l.status, l.expires_at, l.site_connection,
              a.domain, a.site_url, a.last_validated_at
       FROM licenses l
       LEFT JOIN activations a ON a.license_id = l.id AND a.status = 'active'
       WHERE lower(l.owner_email) = lower(?) AND l.status = 'active'
         AND (l.expires_at IS NULL OR l.expires_at > ?)
       ORDER BY a.last_validated_at DESC, l.issued_at DESC`
    ).bind(user.email, new Date().toISOString()).all<{ id: string; key: string; plan: string; status: string; expires_at: string | null; site_connection: string; domain: string | null; site_url: string | null; last_validated_at: string | null }>();
    const seen = new Set<string>();
    const sites = (results ?? []).flatMap((row) => {
      if (!row.site_connection || seen.has(row.id)) return [];
      try {
        const paired = JSON.parse(row.site_connection) as { site_url?: string; key_id?: string };
        const siteUrl = paired.site_url || row.site_url || (row.domain ? `https://${row.domain}` : "");
        if (!siteUrl) return [];
        seen.add(row.id);
        return [{
          id: row.id,
          site_url: siteUrl,
          domain: row.domain || new URL(siteUrl).hostname,
          status: "activated",
          plan: row.plan,
          license_mask: maskKey(row.key),
          paired: true,
          key_id: paired.key_id || null,
          last_validated_at: row.last_validated_at,
        }];
      } catch {
        return [];
      }
    });
    return Response.json({ sites }, { headers: { "Cache-Control": "no-store" } });
  }

  if (path === "/api/me/billing" && method === "GET") return billingSummary(db, env, user);
  if (path === "/api/me/billing/portal" && method === "POST") return billingPortal(request, env, user);

  if (path === "/api/orgs" && method === "POST") {
    const body = await request.json<{ name?: string }>();
    const name = String(body.name ?? "").trim();
    if (!name) return Response.json({ error: "invalid_name", message: "Give the workspace a name." }, { status: 400 });
    const id = crypto.randomUUID();
    await db.prepare("INSERT INTO orgs (id, name, plan, owner_user_id) VALUES (?, ?, 'free', ?)").bind(id, name, user.id).run();
    await db.prepare("INSERT INTO memberships (org_id, user_id, role) VALUES (?, ?, 'owner')").bind(id, user.id).run();
    await audit(db, user.email, "org.create", name);
    return Response.json({ ok: true, id, name });
  }

  if (seg[1] === "orgs" && seg[3] === "sites") {
    const orgId = seg[2];
    await requireOrgMember(db, user.id, orgId);
    if (method === "GET") {
      const { results } = await db.prepare("SELECT id, url, name, wp_version, php_version, key_id, key_mask, scopes, status, last_seen, created_at FROM sites WHERE org_id = ? ORDER BY created_at ASC").bind(orgId).all();
      return Response.json({ sites: results ?? [] });
    }
    if (method === "POST") return connectSite(request, env, user, orgId);
  }

  if (seg[1] === "sites" && seg[3] === "call" && method === "POST") {
    return siteCall(request, env, user, seg[2]);
  }
  if (seg[1] === "sites" && method === "DELETE" && seg[2]) {
    const siteId = seg[2];
    const site = await env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(siteId).first<{ id: string; org_id: string; url: string }>();
    if (!site) return Response.json({ error: "not_found", message: "Site not found." }, { status: 404 });
    await requireOrgMember(db, user.id, site.org_id);
    await db.prepare("DELETE FROM sites WHERE id = ?").bind(siteId).run();
    await audit(db, user.email, "site.disconnect", site.url);
    return Response.json({ ok: true });
  }

  // ── Actions: catalog-driven operations on a connected site ─────────────────
  // The catalog lives server-side (lib/actions.ts) so the browser can only run
  // what exists, and every attempted call lands in action_runs.
  if (path === "/api/actions" && method === "GET") return Response.json({ actions: catalogForClient() });

  if (path === "/api/actions/run" && method === "POST") {
    const body = await request.json<{ site_id?: string; action?: string; params?: Record<string, unknown> }>();
    const outcome = await runAction(env, user, body);
    if (!outcome.ok) {
      return Response.json(
        { error: outcome.error, message: outcome.message, run_id: outcome.run_id, duration_ms: outcome.duration_ms },
        { status: outcome.status }
      );
    }
    return Response.json({ ok: true, status: outcome.status, data: outcome.data, run_id: outcome.run_id, duration_ms: outcome.duration_ms });
  }

  if (path === "/api/actions/runs" && method === "GET") {
    const requested = Number(url.searchParams.get("limit") ?? 0);
    return Response.json({
      runs: await listActionRuns(db, user.id, {
        siteId: url.searchParams.get("site_id") ?? "",
        limit: Number.isFinite(requested) && requested > 0 ? requested : undefined,
      }),
    });
  }

  // ── Agents: the AI registry ────────────────────────────────────────────────
  if (path === "/api/agents" && method === "GET") return Response.json({ agents: await listAgents(db, user.id) });

  if (path === "/api/agents/runs" && method === "GET") {
    const requested = Number(url.searchParams.get("limit") ?? 0);
    return Response.json({
      runs: await listAgentRuns(db, user.id, {
        slug: url.searchParams.get("slug") ?? "",
        limit: Number.isFinite(requested) && requested > 0 ? requested : undefined,
      }),
    });
  }

  if (seg[1] === "agents" && seg.length === 4 && seg[3] === "run" && method === "POST") {
    const body = await request.json<{ site_id?: string; params?: Record<string, unknown> }>();
    const outcome = await runAgent(env, user, seg[2] ?? "", body);
    if (!outcome.ok) {
      return Response.json(
        { error: outcome.error, message: outcome.message, run_id: outcome.run_id, duration_ms: outcome.duration_ms },
        { status: outcome.status }
      );
    }
    return Response.json({ ok: true, output: outcome.output, model: outcome.model, provider: outcome.provider, run_id: outcome.run_id, duration_ms: outcome.duration_ms });
  }

  // ── Agency team ────────────────────────────────────────────────────────────
  if (seg[1] === "orgs" && seg[3] === "team") {
    const orgId = seg[2];
    const role = await requireOrgMember(db, user.id, orgId);
    if (method === "GET") {
      const { results } = await db
        .prepare(
          `SELECT u.id, u.email, u.name, u.status, m.role FROM memberships m
           JOIN users u ON u.id = m.user_id WHERE m.org_id = ? ORDER BY u.created_at ASC`
        )
        .bind(orgId)
        .all();
      return Response.json({ team: results ?? [] });
    }
    if (method === "POST") {
      if (role !== "owner") return Response.json({ error: "forbidden", message: "Only the workspace owner manages the team." }, { status: 403 });
      const body = await request.json<{ email?: string; member_role?: string }>();
      const email = String(body.email ?? "").trim().toLowerCase();
      const memberRole = ["operator", "approver", "viewer"].includes(String(body.member_role)) ? String(body.member_role) : "viewer";
      const target = await db.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: string }>();
      if (!target) return Response.json({ error: "no_account", message: "That person needs a Bridgistic account first." }, { status: 404 });
      await db.prepare("INSERT OR IGNORE INTO memberships (org_id, user_id, role) VALUES (?, ?, ?)").bind(orgId, target.id, memberRole).run();
      await audit(db, user.email, "team.add", email, memberRole);
      return Response.json({ ok: true });
    }
    if (method === "DELETE" && seg[4]) {
      if (role !== "owner") return Response.json({ error: "forbidden", message: "Only the workspace owner manages the team." }, { status: 403 });
      await db.prepare("DELETE FROM memberships WHERE org_id = ? AND user_id = ?").bind(orgId, seg[4]).run();
      await audit(db, user.email, "team.remove", seg[4]);
      return Response.json({ ok: true });
    }
  }

  // ── AI generation (website agents) ─────────────────────────────────────────
  if (path === "/api/ai/generate" && method === "POST") return aiGenerate(request, env, user);

  if (path === "/api/me/installs" && method === "GET") {
    const { results } = await db
      .prepare("SELECT target AS slug, at, detail FROM audit WHERE actor = ? AND action = 'market.install' ORDER BY at DESC LIMIT 100")
      .bind(user.email)
      .all();
    return Response.json({ installs: results ?? [] });
  }

  // ── Connect with the license key ───────────────────────────────────────────
  // Customers naturally paste their BRG- license key into the connect form.
  // When the licensed site has pushed its auto-paired dashboard key, resolve
  // the license to that connection — the site connects with zero further
  // steps. Only the license owner (or platform staff) may resolve it.
  if (path === "/api/me/resolve-license" && method === "POST") {
    const body = await request.json<{ key?: string }>();
    const key = String(body.key ?? "").trim();
    if (!key.startsWith("BRG-")) return Response.json({ error: "not_a_license", message: "That is not a license key (BRG-…)." }, { status: 400 });
    const license = await db
      .prepare("SELECT id, owner_email, status, site_connection FROM licenses WHERE key = ?")
      .bind(key)
      .first<{ id: string; owner_email: string; status: string; site_connection: string }>();
    if (!license) return Response.json({ error: "license_not_found", message: "This license key was not found." }, { status: 404 });
    const staff = user.role === "owner" || user.role === "admin";
    if (license.owner_email !== user.email && !staff) {
      return Response.json({ error: "not_your_license", message: "This license belongs to a different Bridgistic account. Sign in with the account that purchased it." }, { status: 403 });
    }
    if (license.status !== "active") return Response.json({ error: "license_inactive", message: "This license is not active." }, { status: 403 });
    if (!license.site_connection || !env.SECRET_ENCRYPTION_KEY) {
      return Response.json({ error: "no_pairing", message: "This site has not pushed its dashboard key yet. In WP Admin → Bridgistic → Premium Features, click Check now (plugin 1.5.7+), then try again." }, { status: 404 });
    }
    try {
      const parsed = JSON.parse(license.site_connection) as { site_url?: string; key_id?: string; secret_enc?: string };
      if (!parsed.site_url || !parsed.key_id || !parsed.secret_enc) throw new Error("incomplete");
      return Response.json({ site_url: parsed.site_url, key_id: parsed.key_id, secret: await decryptSecret(parsed.secret_enc, env.SECRET_ENCRYPTION_KEY) });
    } catch {
      return Response.json({ error: "no_pairing", message: "The stored pairing is incomplete. Click Check now in WP Admin → Bridgistic → Premium Features, then try again." }, { status: 404 });
    }
  }

  // ── Auto-paired sites from license activations ─────────────────────────────
  // The plugin pushes its dashboard key at activation/validate; the license
  // owner's dashboard picks the connection up here with zero manual steps.
  if (path === "/api/me/site-connections" && method === "GET") {
    const unlock = await paidUnlock(db, user);
    if (!unlock.unlocked) return Response.json({ connections: [] });
    if (!env.SECRET_ENCRYPTION_KEY) return Response.json({ connections: [] });
    const { results } = await db
      .prepare("SELECT id, site_connection FROM licenses WHERE owner_email = ? AND status = 'active' AND (expires_at IS NULL OR expires_at > ?)")
      .bind(user.email, new Date().toISOString())
      .all<{ id: string; site_connection: string }>();
    const connections: { site_url: string; key_id: string; secret: string; plan: string }[] = [];
    for (const row of results ?? []) {
      if (!row.site_connection) continue;
      try {
        const parsed = JSON.parse(row.site_connection) as { site_url?: string; key_id?: string; secret_enc?: string };
        if (!parsed.site_url || !parsed.key_id || !parsed.secret_enc) continue;
        connections.push({ site_url: parsed.site_url, key_id: parsed.key_id, secret: await decryptSecret(parsed.secret_enc, env.SECRET_ENCRYPTION_KEY), plan: unlock.plan ?? "" });
      } catch {
        // corrupt row — skip rather than fail the whole list
      }
    }
    return Response.json({ connections });
  }

  // ── Platform admin ─────────────────────────────────────────────────────────
  if (seg[1] === "admin") {
    await requireOwner(db, request, env.PLATFORM_OWNER_EMAIL);
    return adminRoutes(request, env, seg, method, url, user);
  }

  return Response.json({ error: "not_found", message: "Unknown API route." }, { status: 404 });
}

function jsonWithCookie(body: unknown, cookies: string[]): Response {
  const headers = new Headers({ "Content-Type": "application/json", "Cache-Control": "no-store" });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(JSON.stringify(body), { status: 200, headers });
}

const WPISTIC_API_URL = "https://api.wpistic.com";
const BILLING_RETURN_HOSTS = new Set(["bridgistic.app", "www.bridgistic.app", "dashboard.bridgistic.app", "app.bridgistic.app"]);

function billingReturnUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && BILLING_RETURN_HOSTS.has(url.hostname);
  } catch {
    return false;
  }
}

async function serviceBilling(env: Env, path: string, body: unknown): Promise<Response> {
  if (!env.LICENSE_SERVICE_TOKEN) return Response.json({ error: "billing_not_configured", message: "Billing service is not configured." }, { status: 503 });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    return await fetch(`${WPISTIC_API_URL}/api/v1/service/billing${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.LICENSE_SERVICE_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function billingSummary(db: D1Database, env: Env, user: User): Promise<Response> {
  try {
    const upstream = await serviceBilling(env, "/summary", { product: "bridgistic", emails: [user.email] });
    if (upstream.ok) {
      const json = await upstream.json() as { accounts?: Array<Record<string, unknown>> };
      const subscriptions = json.accounts ?? [];
      return Response.json({ billing_provider: subscriptions[0]?.billing_provider ?? null, subscriptions, upstream_error: false }, { headers: { "Cache-Control": "no-store" } });
    }
  } catch {
    // Use the local license record below when the billing service is briefly
    // unavailable; customers should still see the entitlement they own.
  }

  const { results } = await db.prepare(
    `SELECT id, plan, status, notes, issued_at, expires_at
     FROM licenses WHERE lower(owner_email) = lower(?) AND status = 'active'
     ORDER BY issued_at DESC`
  ).bind(user.email).all<{ id: string; plan: string; status: string; notes: string; issued_at: string; expires_at: string | null }>();
  const subscriptions = (results ?? []).map((row) => {
    // Stripe is the only payment provider. Anything else (manual issue, AppSumo,
    // keys migrated from the retired gateway) is a directly issued license with no portal.
    const provider = /stripe/i.test(row.notes) ? "stripe" : "license";
    const plan = row.plan === "monthly" ? { interval: "month", amount: 1200 } : row.plan === "yearly" ? { interval: "year", amount: 9900 } : { interval: "lifetime", amount: 0 }; // lifetime is no longer sold (AppSumo/legacy): no price to show
    return {
      billing_provider: provider,
      subscription_id: row.id,
      plan: row.plan,
      plan_name: row.plan === "lifetime" ? "Lifetime" : "Pro",
      interval: plan.interval,
      amount: plan.amount,
      currency: "USD",
      status: row.plan === "lifetime" ? "lifetime" : row.status,
      renews_at: row.plan === "lifetime" ? null : row.expires_at,
      ends_at: null,
      cancel_at_period_end: false,
      invoices: [],
      manage: provider === "stripe" ? ({ type: "stripe_portal" } as const) : ({ type: "support" } as const),
    };
  });
  return Response.json({ billing_provider: subscriptions[0]?.billing_provider ?? null, subscriptions, upstream_error: subscriptions.length === 0 }, { headers: { "Cache-Control": "no-store" } });
}

async function billingPortal(request: Request, env: Env, user: User): Promise<Response> {
  const body = await request.json<{ return_url?: string }>();
  const returnUrl = String(body.return_url ?? "");
  if (!billingReturnUrl(returnUrl)) return Response.json({ error: "invalid_return_url", message: "The billing return URL is not allowed." }, { status: 400 });
  const upstream = await serviceBilling(env, "/portal", { email: user.email, return_url: returnUrl });
  const json = await upstream.json().catch(() => ({})) as { portal_url?: string; error?: { message?: string }; message?: string };
  if (!upstream.ok || !json.portal_url) return Response.json({ error: "billing_portal_unavailable", message: json.error?.message ?? json.message ?? "Could not open the billing portal." }, { status: upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502 });
  return Response.json({ url: json.portal_url }, { headers: { "Cache-Control": "no-store" } });
}

/** Paid marketplace unlock: an active Bridgistic license assigned to this email. */
async function paidUnlock(db: D1Database, user: User): Promise<{ unlocked: boolean; plan: string | null }> {
  if (!isEmailVerified(user)) return { unlocked: false, plan: null };
  const row = await db
    .prepare("SELECT plan FROM licenses WHERE owner_email = ? AND status = 'active' AND (expires_at IS NULL OR expires_at > ?) LIMIT 1")
    .bind(user.email, new Date().toISOString())
    .first<{ plan: string }>();
  return { unlocked: Boolean(row), plan: row?.plan ?? null };
}

// ── Site connect + proxied calls ─────────────────────────────────────────────

async function connectSite(request: Request, env: Env, user: User, orgId: string): Promise<Response> {
  if (!env.SECRET_ENCRYPTION_KEY) return Response.json({ error: "not_configured", message: "SECRET_ENCRYPTION_KEY is not set on the deployment." }, { status: 503 });
  const body = await request.json<{ url?: string; name?: string; key_id?: string; secret?: string }>();
  let url = String(body.url ?? "");
  let keyId = String(body.key_id ?? "").trim();
  let secret = String(body.secret ?? "").trim();
  const name = String(body.name ?? "").trim();

  // A BRG- license key resolves to the licensed site's auto-paired key —
  // customers paste the one code they have.
  if (keyId.startsWith("BRG-")) {
    if (!isEmailVerified(user)) return unverifiedResponse();
    const license = await env.DB.prepare("SELECT owner_email, status, site_connection FROM licenses WHERE key = ?").bind(keyId).first<{ owner_email: string; status: string; site_connection: string }>();
    const staff = user.role === "owner" || user.role === "admin";
    if (!license) return Response.json({ error: "license_not_found", message: "This license key was not found." }, { status: 404 });
    if (license.owner_email !== user.email && !staff) {
      return Response.json({ error: "not_your_license", message: "This license belongs to a different Bridgistic account. Sign in with the account that purchased it." }, { status: 403 });
    }
    if (license.status !== "active") return Response.json({ error: "license_inactive", message: "This license is not active." }, { status: 403 });
    if (!license.site_connection) {
      return Response.json({ error: "no_pairing", message: "This site has not pushed its dashboard key yet. In WP Admin → Bridgistic → Premium Features, click Check now (plugin 1.5.7+), then try again." }, { status: 404 });
    }
    try {
      const parsed = JSON.parse(license.site_connection) as { site_url?: string; key_id?: string; secret_enc?: string };
      if (!parsed.site_url || !parsed.key_id || !parsed.secret_enc) throw new Error("incomplete");
      url = parsed.site_url;
      keyId = parsed.key_id;
      secret = await decryptSecret(parsed.secret_enc, env.SECRET_ENCRYPTION_KEY);
    } catch {
      return Response.json({ error: "no_pairing", message: "The stored pairing is incomplete. Click Check now in WP Admin → Bridgistic → Premium Features, then try again." }, { status: 404 });
    }
  }

  const normalized = normalizeSiteUrl(url);
  if (!keyId || !secret) return Response.json({ error: "missing_key", message: "A key ID and secret from the site's WP Admin are required." }, { status: 400 });

  const probe = await callSite(normalized, keyId, secret, "GET", "site-info");
  if (!probe.ok) {
    return Response.json(
      { error: "connect_failed", message: probe.error?.message ?? "The site did not accept the key. Check the key ID and secret." },
      { status: probe.status === 401 || probe.status === 403 ? 401 : 502 }
    );
  }
  const info = probe.data as { site?: { name?: string; url?: string }; wordpress?: { version?: string }; php?: { version?: string }; bridge?: { scopes?: string[] } } | null;
  const id = crypto.randomUUID();
  await env.DB
    .prepare(
      `INSERT INTO sites (id, org_id, url, name, wp_version, php_version, key_id, key_mask, secret_enc, scopes, status, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'connected', ?)
       ON CONFLICT(org_id, url) DO UPDATE SET name=excluded.name, wp_version=excluded.wp_version,
         php_version=excluded.php_version, key_id=excluded.key_id, key_mask=excluded.key_mask,
         secret_enc=excluded.secret_enc, scopes=excluded.scopes, status='connected', last_seen=excluded.last_seen`
    )
    .bind(
      id,
      orgId,
      normalized,
      name || info?.site?.name || new URL(normalized).hostname,
      String(info?.wordpress?.version ?? ""),
      String(info?.php?.version ?? ""),
      keyId,
      keyMask(keyId),
      await encryptSecret(secret, env.SECRET_ENCRYPTION_KEY),
      JSON.stringify(info?.bridge?.scopes ?? []),
      new Date().toISOString()
    )
    .run();
  await audit(env.DB, user.email, "site.connect", normalized);
  return Response.json({ ok: true, id, site: { name: info?.site?.name ?? "", wp_version: info?.wordpress?.version ?? "", scopes: info?.bridge?.scopes ?? [] } });
}

async function siteCall(request: Request, env: Env, user: User, siteId: string): Promise<Response> {
  if (!env.SECRET_ENCRYPTION_KEY) return Response.json({ error: "not_configured", message: "SECRET_ENCRYPTION_KEY is not set." }, { status: 503 });
  const site = await env.DB.prepare("SELECT * FROM sites WHERE id = ?").bind(siteId).first<{ id: string; org_id: string; url: string; key_id: string; secret_enc: string; status: string }>();
  if (!site) return Response.json({ error: "not_found", message: "Site not found." }, { status: 404 });
  await requireOrgMember(env.DB, user.id, site.org_id);
  const body = await request.json<{ method?: string; path?: string; body?: Record<string, unknown> }>();
  const httpMethod = ["GET", "POST", "PUT", "DELETE"].includes(String(body.method ?? "").toUpperCase()) ? (String(body.method).toUpperCase() as "GET" | "POST" | "PUT" | "DELETE") : "GET";
  const routePath = String(body.path ?? "site-info");
  const secret = await decryptSecret(site.secret_enc, env.SECRET_ENCRYPTION_KEY);
  const result = await callSite(site.url, site.key_id, secret, httpMethod, routePath, body.body);
  if (result.ok) {
    await env.DB.prepare("UPDATE sites SET last_seen = ? WHERE id = ?").bind(new Date().toISOString(), siteId).run();
    await audit(env.DB, user.email, `site.${httpMethod.toLowerCase()}`, `${new URL(site.url).hostname}${routePath.slice(0, 80)}`);
  }
  return Response.json(result, { status: result.ok ? 200 : result.status >= 400 && result.status < 600 ? result.status : 502 });
}

// ── Marketplace ──────────────────────────────────────────────────────────────

async function marketRoutes(request: Request, env: Env, seg: string[], method: string, url: URL): Promise<Response> {
  const db = env.DB;

  if (seg[2] === "items" && method === "GET") {
    const requested = url.searchParams.get("tier") ?? "free";
    const category = url.searchParams.get("category") ?? "";
    const q = (url.searchParams.get("q") ?? "").toLowerCase();
    // The public directory lists free skills only. The pro collection is
    // returned exclusively to signed-in accounts with an active license;
    // archived rows are never listed anywhere.
    let tier = "free";
    if (requested === "pro") {
      const user = await currentUser(db, request);
      if (!user) return Response.json({ error: "signin_required", message: "Sign in to see the Pro collection." }, { status: 401 });
      const staff = user.role === "owner" || user.role === "admin";
      if (!staff && !(await paidUnlock(db, user)).unlocked) {
        return Response.json({ error: "license_required", message: "The Pro collection needs an active Bridgistic license." }, { status: 403 });
      }
      tier = "pro";
    }
    let sql = "SELECT slug, name, description, category, author, handle, tier, version, installs, updated FROM skills WHERE tier = ?";
    const binds: unknown[] = [tier];
    if (category) {
      sql += " AND category = ?";
      binds.push(category);
    }
    if (q) {
      sql += " AND (lower(name) LIKE ? OR lower(description) LIKE ?)";
      binds.push(`%${q}%`, `%${q}%`);
    }
    sql += " ORDER BY installs DESC";
    const { results } = await db.prepare(sql).bind(...binds).all();
    return Response.json({ items: results ?? [] });
  }

  if (seg[2] === "item" && seg[3] && method === "GET") {
    // Archived rows are listed nowhere and fetched nowhere.
    const item = await db
      .prepare("SELECT slug, name, description, category, author, handle, tier, version, installs, updated FROM skills WHERE slug = ? AND tier != 'archive'")
      .bind(seg[3])
      .first();
    if (!item) return Response.json({ error: "not_found", message: "Skill not found." }, { status: 404 });
    return Response.json({ item });
  }

  if (seg[2] === "content" && seg[3] && method === "GET") {
    // File content: free items for any signed-in account, paid items need an
    // active Bridgistic license. Anonymous visitors get metadata only.
    const item = await db.prepare("SELECT * FROM skills WHERE slug = ?").bind(seg[3]).first<{ slug: string; tier: string; files: string; installs: number; name: string; version: string; author: string }>();
    if (!item) return Response.json({ error: "not_found", message: "Skill not found." }, { status: 404 });
    let authorized = item.tier === "free";
    if (!authorized) {
      const user = await currentUser(db, request);
      if (user) authorized = (await paidUnlock(db, user)).unlocked || user.role === "owner" || user.role === "admin";
    } else {
      const user = await currentUser(db, request);
      authorized = Boolean(user);
    }
    return Response.json({
      slug: item.slug,
      tier: item.tier,
      authorized,
      files: authorized ? parseFiles(item.files) : [],
    });
  }

  if (seg[2] === "install" && seg[3] && method === "POST") {
    const item = await db.prepare("SELECT slug, tier, installs, files, name, version, author FROM skills WHERE slug = ?").bind(seg[3]).first<{ slug: string; tier: string; installs: number; files: string; name: string; version: string; author: string }>();
    if (!item) return Response.json({ error: "not_found", message: "Skill not found." }, { status: 404 });
    const user = await requireUser(db, request);
    if (item.tier === "paid" && !(await paidUnlock(db, user)).unlocked && user.role !== "owner" && user.role !== "admin") {
      return Response.json({ error: "license_required", message: "This skill is part of Bridgistic Pro. Activate a license to install it." }, { status: 403 });
    }
    await db.prepare("UPDATE skills SET installs = installs + 1 WHERE slug = ?").bind(item.slug).run();
    await audit(db, user.email, "market.install", item.slug);
    return Response.json({ ok: true, slug: item.slug, files: parseFiles(item.files), install_command: `bridgistic skills install @${"wordpressistic"}/${item.slug}` });
  }

  if (seg[2] === "download" && seg[3] && method === "GET") {
    const item = await db.prepare("SELECT slug, tier, files FROM skills WHERE slug = ?").bind(seg[3]).first<{ slug: string; tier: string; files: string }>();
    if (!item) return Response.json({ error: "not_found", message: "Skill not found." }, { status: 404 });
    const user = await currentUser(db, request);
    if (!user) return Response.json({ error: "signin_required", message: "Create a free account to download." }, { status: 401 });
    if (item.tier === "paid" && !(await paidUnlock(db, user)).unlocked && user.role !== "owner" && user.role !== "admin") {
      return Response.json({ error: "license_required", message: "This pack is part of Bridgistic Pro." }, { status: 403 });
    }
    const files = parseFiles(item.files) as { path: string; text: string }[];
    const zipped: Zippable = {};
    for (const file of files) zipped[file.path] = new TextEncoder().encode(file.text);
    const archive = zipSync(zipped);
    await db.prepare("UPDATE skills SET installs = installs + 1 WHERE slug = ?").bind(item.slug).run();
    await audit(db, user.email, "market.download", item.slug);
    return new Response(archive as unknown as BodyInit, {
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${item.slug}.zip"`,
      },
    });
  }

  if (seg[2] === "categories" && method === "GET") {
    const { results } = await db.prepare("SELECT category, COUNT(*) AS n, tier FROM skills GROUP BY category, tier ORDER BY n DESC").all();
    return Response.json({ categories: results ?? [] });
  }

  return Response.json({ error: "not_found", message: "Unknown marketplace route." }, { status: 404 });
}

// ── AI (website agents) ──────────────────────────────────────────────────────

async function aiGenerate(request: Request, env: Env, user: User): Promise<Response> {
  const body = await request.json<{ prompt?: string; system?: string }>();
  const prompt = String(body.prompt ?? "").trim();
  if (!prompt) return Response.json({ error: "empty_prompt", message: "Write a prompt first." }, { status: 400 });
  const messages: ChatMessage[] = [
    ...(body.system ? [{ role: "system" as const, content: String(body.system) }] : []),
    { role: "user", content: prompt },
  ];
  const result = await chat(env, messages, { maxTokens: 1200 });
  if (!result.ok) return Response.json({ error: result.error, message: result.message }, { status: result.status });
  await audit(env.DB, user.email, "ai.generate", result.model);
  return Response.json({ ok: true, text: result.text, model: result.model });
}

// ── Platform admin ───────────────────────────────────────────────────────────

async function adminRoutes(request: Request, env: Env, seg: string[], method: string, url: URL, user: User): Promise<Response> {
  const db = env.DB;
  const id = seg[3];

  if (seg[2] === "marketplace-codes" && method === "GET") {
    const { results } = await db
      .prepare("SELECT substr(code_hash,1,8) AS hash_prefix, plan, site_limit, status, license_id, redeemed_by_user_id, created_at, redeemed_at FROM appsumo_redemption_codes ORDER BY created_at DESC LIMIT 200")
      .all();
    return Response.json({ codes: results ?? [] });
  }
  if (seg[2] === "marketplace-codes" && method === "POST") {
    const body = await request.json<{ code?: string; tier?: number }>();
    const code = String(body.code ?? "").trim();
    if (code.length < 6) return Response.json({ error: "invalid_code", message: "Enter a code of at least 6 characters." }, { status: 400 });
    const row = await seedMarketplaceCode(db, { code, tier: body.tier }, user.email);
    return Response.json({ ok: true, site_limit: row.site_limit, status: row.status });
  }

  if (seg[2] === "stats" && method === "GET") {
    const count = async (sql: string) => (await db.prepare(sql).first<{ n: number }>())?.n ?? 0;
    const byplan = await db.prepare("SELECT plan, COUNT(*) AS n FROM licenses WHERE status = 'active' GROUP BY plan").all<{ plan: string; n: number }>();
    return Response.json({
      users: await count("SELECT COUNT(*) AS n FROM users"),
      orgs: await count("SELECT COUNT(*) AS n FROM orgs"),
      sites: await count("SELECT COUNT(*) AS n FROM sites"),
      licenses_active: await count("SELECT COUNT(*) AS n FROM licenses WHERE status = 'active'"),
      activations: await count("SELECT COUNT(*) AS n FROM activations WHERE status = 'active'"),
      skills: await count("SELECT COUNT(*) AS n FROM skills"),
      installs: await count("SELECT COALESCE(SUM(installs),0) AS n FROM skills"),
      by_plan: byplan.results ?? [],
    });
  }

  if (seg[2] === "orgs") {
    if (method === "GET" && !id) {
      const { results } = await db
        .prepare(
          `SELECT o.*, u.email AS owner_email,
             (SELECT COUNT(*) FROM sites s WHERE s.org_id = o.id) AS site_count,
             (SELECT COUNT(*) FROM memberships m WHERE m.org_id = o.id) AS member_count
           FROM orgs o LEFT JOIN users u ON u.id = o.owner_user_id ORDER BY o.created_at DESC`
        )
        .all();
      return Response.json({ orgs: results ?? [] });
    }
    if (method === "POST" && !id) {
      const body = await request.json<{ name?: string; plan?: string }>();
      const name = String(body.name ?? "").trim();
      if (!name) return Response.json({ error: "invalid_name", message: "Name the organization." }, { status: 400 });
      const orgId = crypto.randomUUID();
      await db.prepare("INSERT INTO orgs (id, name, plan, owner_user_id) VALUES (?, ?, ?, ?)").bind(orgId, name, String(body.plan ?? "free"), user.id).run();
      await audit(db, user.email, "admin.org.create", name);
      return Response.json({ ok: true, id: orgId });
    }
    if (method === "PATCH" && id) {
      const body = await request.json<{ name?: string; plan?: string; status?: string }>();
      const org = await db.prepare("SELECT * FROM orgs WHERE id = ?").bind(id).first<{ id: string; name: string }>();
      if (!org) return Response.json({ error: "not_found", message: "Organization not found." }, { status: 404 });
      await db
        .prepare("UPDATE orgs SET name = COALESCE(?, name), plan = COALESCE(?, plan), status = COALESCE(?, status) WHERE id = ?")
        .bind(body.name ?? null, body.plan ?? null, body.status ?? null, id)
        .run();
      await audit(db, user.email, "admin.org.update", org.name, JSON.stringify(body));
      return Response.json({ ok: true });
    }
  }

  if (seg[2] === "users") {
    if (method === "GET" && !id) {
      const { results } = await db
        .prepare(
          `SELECT u.id, u.email, u.name, u.role, u.status, u.created_at,
             (SELECT COUNT(*) FROM orgs o WHERE o.owner_user_id = u.id) AS org_count
           FROM users u ORDER BY u.created_at DESC`
        )
        .all();
      return Response.json({ users: results ?? [] });
    }
    if (method === "POST" && !id) {
      const body = await request.json<{ email?: string; name?: string; password?: string; role?: string }>();
      const email = String(body.email ?? "").trim().toLowerCase();
      const password = String(body.password ?? randomHex(8));
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return Response.json({ error: "invalid_email", message: "Enter a valid email." }, { status: 400 });
      const dup = await db.prepare("SELECT id FROM users WHERE email = ?").bind(email).first();
      if (dup) return Response.json({ error: "email_taken", message: "That email already has an account." }, { status: 409 });
      const userId = crypto.randomUUID();
      await db
        .prepare("INSERT INTO users (id, email, name, password_hash, role) VALUES (?, ?, ?, ?, ?)")
        .bind(userId, email, String(body.name ?? email.split("@")[0]), await hashPassword(password), ["owner", "admin", "member"].includes(String(body.role)) ? String(body.role) : "member")
        .run();
      await audit(db, user.email, "admin.user.create", email);
      return Response.json({ ok: true, id: userId, temp_password: body.password ? undefined : password });
    }
    if (method === "PATCH" && id) {
      const body = await request.json<{ role?: string; status?: string; name?: string }>();
      await db
        .prepare("UPDATE users SET role = COALESCE(?, role), status = COALESCE(?, status), name = COALESCE(?, name) WHERE id = ?")
        .bind(body.role ?? null, body.status ?? null, body.name ?? null, id)
        .run();
      await audit(db, user.email, "admin.user.update", id, JSON.stringify(body));
      return Response.json({ ok: true });
    }
  }

  if (seg[2] === "sites" && method === "GET") {
    const { results } = await db
      .prepare(
        `SELECT s.id, s.url, s.name, s.wp_version, s.php_version, s.key_mask, s.status, s.last_seen, o.name AS org_name
         FROM sites s JOIN orgs o ON o.id = s.org_id ORDER BY s.created_at DESC`
      )
      .all();
    // License activation is the source of truth for sites activated directly
    // from WP Admin. Older deployments did not create a workspace `sites`
    // row, which made the owner console report zero sites while activations
    // were healthy. Include those rows without exposing dashboard secrets.
    const activations = await db
      .prepare(
        `SELECT a.id, a.site_url AS url, a.domain AS name, a.wp_version, a.php_version,
                a.status, a.last_validated_at AS last_seen, l.plan, l.owner_email,
                l.site_limit, l.key AS license_key
         FROM activations a JOIN licenses l ON l.id = a.license_id
         WHERE a.status = 'active' ORDER BY a.created_at DESC`
      )
      .all();
    const existing = new Set((results ?? []).map((row) => String((row as { url?: string }).url ?? "")));
    const activationRows = (activations.results ?? [])
      .filter((row) => !existing.has(String((row as { url?: string }).url ?? "")))
      .map((row) => ({ ...(row as Record<string, unknown>), key_mask: maskKey(String((row as { license_key?: string }).license_key ?? "")), org_name: String((row as { owner_email?: string }).owner_email ?? "") }));
    return Response.json({ sites: [...(results ?? []), ...activationRows] });
  }

  if (seg[2] === "plans") {
    if (method === "GET") {
      const { results } = await db.prepare("SELECT * FROM plans ORDER BY price_onetime ASC, price_monthly ASC").all();
      return Response.json({ plans: results ?? [] });
    }
    if (method === "PATCH" && id) {
      const body = await request.json<{ name?: string; price_monthly?: number; price_yearly?: number; price_onetime?: number; sites_max?: number; seats?: number; status?: string }>();
      await db
        .prepare(
          `UPDATE plans SET name = COALESCE(?, name), price_monthly = COALESCE(?, price_monthly),
             price_yearly = COALESCE(?, price_yearly), price_onetime = COALESCE(?, price_onetime),
             sites_max = COALESCE(?, sites_max), seats = COALESCE(?, seats), status = COALESCE(?, status)
           WHERE slug = ?`
        )
        .bind(
          body.name ?? null,
          body.price_monthly ?? null,
          body.price_yearly ?? null,
          body.price_onetime ?? null,
          body.sites_max ?? null,
          body.seats ?? null,
          body.status ?? null,
          id
        )
        .run();
      await audit(db, user.email, "admin.plan.update", id, JSON.stringify(body));
      return Response.json({ ok: true });
    }
  }

  if (seg[2] === "licenses") {
    if (method === "GET" && !id) {
      const { results } = await db
        .prepare(
          `SELECT l.id, l.key, l.product, l.plan, l.status, l.site_limit, l.owner_email, l.org_id, l.notes,
             l.issued_at, l.expires_at,
             (SELECT COUNT(*) FROM activations a WHERE a.license_id = l.id AND a.status = 'active') AS active_sites
           FROM licenses l ORDER BY l.issued_at DESC`
        )
        .all();
      return Response.json({ licenses: (results ?? []).map((row) => ({ ...(row as Record<string, unknown>), key_mask: maskKey(String((row as { key: string }).key)) })) });
    }
    if (method === "POST" && !id) {
      const body = await request.json<{ plan?: string; owner_email?: string; site_limit?: number; org_id?: string | null; notes?: string; expires_at?: string | null }>();
      const plan = ["lifetime", "monthly", "yearly"].includes(String(body.plan)) ? String(body.plan) : "lifetime";
      const siteLimit = Number(body.site_limit ?? (plan === "lifetime" ? 1 : 5));
      const license = await issueLicense(db, {
        plan,
        ownerEmail: String(body.owner_email ?? "").trim().toLowerCase(),
        siteLimit,
        orgId: body.org_id ?? null,
        notes: String(body.notes ?? ""),
        expiresAt: body.expires_at ?? null,
      });
      await audit(db, user.email, "admin.license.issue", maskKey(license.key), plan);
      return Response.json({ ok: true, license: { ...license, key_mask: maskKey(license.key) }, key: license.key });
    }
    if (id && method === "PATCH") {
      const body = await request.json<{ status?: string; site_limit?: number; owner_email?: string; notes?: string }>();
      const license = await db.prepare("SELECT * FROM licenses WHERE id = ?").bind(id).first<LicenseRow>();
      if (!license) return Response.json({ error: "not_found", message: "License not found." }, { status: 404 });
      await db
        .prepare("UPDATE licenses SET status = COALESCE(?, status), site_limit = COALESCE(?, site_limit), owner_email = COALESCE(?, owner_email), notes = COALESCE(?, notes) WHERE id = ?")
        .bind(body.status ?? null, body.site_limit ?? null, body.owner_email?.toLowerCase() ?? null, body.notes ?? null, id)
        .run();
      if (body.status === "revoked" || body.status === "suspended") {
        // Keep the rows so /validate can still report the new status to
        // sites; only explicit deactivation removes an activation.
        await db.prepare("UPDATE activations SET status = 'inactive' WHERE license_id = ?").bind(id).run();
        await syncLog(db, body.status, maskKey(license.key), "", "all activations released");
      }
      await audit(db, user.email, "admin.license.update", maskKey(license.key), JSON.stringify(body));
      return Response.json({ ok: true });
    }
    if (id && seg[4] === "regenerate" && method === "POST") {
      const license = await db.prepare("SELECT * FROM licenses WHERE id = ?").bind(id).first<LicenseRow>();
      if (!license) return Response.json({ error: "not_found", message: "License not found." }, { status: 404 });
      const newKey = licenseKey(license.plan);
      await db.prepare("UPDATE licenses SET key = ? WHERE id = ?").bind(newKey, id).run();
      await db.prepare("DELETE FROM activations WHERE license_id = ?").bind(id).run();
      await syncLog(db, "regenerate", maskKey(newKey), "", `was ${maskKey(license.key)}`);
      await audit(db, user.email, "admin.license.regenerate", maskKey(newKey));
      return Response.json({ ok: true, key: newKey });
    }
  }

  if (seg[2] === "synclogs" && method === "GET") {
    const { results } = await db.prepare("SELECT * FROM sync_log ORDER BY at DESC LIMIT 200").all();
    return Response.json({ logs: results ?? [] });
  }

  if (seg[2] === "audit" && method === "GET") {
    const { results } = await db.prepare("SELECT * FROM audit ORDER BY at DESC LIMIT 200").all();
    return Response.json({ entries: results ?? [] });
  }

  if (seg[2] === "settings") {
    if (method === "GET") {
      const keys = ["support_email", "timezone", "maintenance_mode", "default_site_limit", "session_days", "billing_email", "sync_email"];
      const out: Record<string, unknown> = {};
      for (const key of keys) out[key] = await getSetting(db, key);
      return Response.json({ settings: out });
    }
    if (method === "PUT") {
      const body = await request.json<Record<string, unknown>>();
      for (const [key, value] of Object.entries(body)) await putSetting(db, key, value);
      await audit(db, user.email, "admin.settings.update", "", Object.keys(body).join(","));
      return Response.json({ ok: true });
    }
  }

  if (seg[2] === "ai") {
    if (method === "GET") {
      const ai = (await getSetting(db, "ai")) as { openrouter_key?: string; openai_model?: string; provider_order?: string[] } | null;
      const key = ai?.openrouter_key ?? "";
      return Response.json({
        ai: {
          provider_order: ai?.provider_order ?? ["openai-compatible", "openrouter", "local-ragbrain", "safety-rule"],
          openai_model: ai?.openai_model ?? "openai/gpt-4o-mini",
          key_set: Boolean(key),
          key_mask: key ? `${key.slice(0, 8)}…${key.slice(-4)}` : null,
        },
      });
    }
    if (method === "PUT") {
      const body = await request.json<{ openrouter_key?: string; openai_model?: string; provider_order?: string[] }>();
      const current = ((await getSetting(db, "ai")) as Record<string, unknown> | null) ?? {};
      const next = { ...current };
      if (body.openrouter_key !== undefined) next.openrouter_key = String(body.openrouter_key).trim() || "";
      if (body.openai_model !== undefined) next.openai_model = String(body.openai_model).trim();
      if (body.provider_order !== undefined) next.provider_order = body.provider_order;
      await putSetting(db, "ai", next);
      await audit(db, user.email, "admin.ai.update", "", Object.keys(body).join(","));
      return Response.json({ ok: true });
    }
  }

  return Response.json({ error: "not_found", message: "Unknown admin route." }, { status: 404 });
}
