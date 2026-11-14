/**
 * Email verification and password reset. Licenses, billing and paired sites
 * are matched to accounts by email, so a password signup only receives them
 * once it proves it owns that inbox. Tokens are random, single-use, stored
 * only as SHA-256 hashes, and short-lived.
 */
import { audit, nowIso, type User } from "./auth.ts";
import { hashPassword, randomHex, toHex } from "./crypto.ts";
import { brandedEmail, mailConfigured, sendMail, type MailEnv } from "./mail.ts";

export const DASHBOARD_ORIGIN = "https://dashboard.bridgistic.app";
const VERIFY_TTL_MS = 24 * 3_600_000;
const RESET_TTL_MS = 3_600_000;
const MAX_PER_WINDOW = 3;
const WINDOW_MS = 15 * 60_000;

export interface EmailAuthEnv extends MailEnv {
  DB: D1Database;
}

export function isEmailVerified(user: Pick<User, "role"> & { email_verified_at?: string | null }): boolean {
  return Boolean(user.email_verified_at) || user.role === "owner";
}

export function unverifiedResponse(): Response {
  return Response.json(
    { error: "email_unverified", message: "Verify your email to see licenses, billing and sites bought with it. Check your inbox or resend the link from the dashboard." },
    { status: 403 }
  );
}

async function sha256Hex(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)));
}

async function recentCount(db: D1Database, userId: string, purpose: string): Promise<number> {
  const since = new Date(Date.now() - WINDOW_MS).toISOString();
  const row = await db.prepare("SELECT count(*) AS n FROM email_tokens WHERE user_id = ? AND purpose = ? AND created_at > ?").bind(userId, purpose, since).first<{ n: number }>();
  return Number(row?.n ?? 0);
}

async function issueToken(db: D1Database, userId: string, purpose: "verify" | "reset", ttlMs: number): Promise<string> {
  const token = randomHex(32);
  await db
    .prepare("INSERT INTO email_tokens (token_hash, user_id, purpose, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(await sha256Hex(token), userId, purpose, new Date(Date.now() + ttlMs).toISOString(), nowIso())
    .run();
  return token;
}

async function consumeToken(db: D1Database, token: string, purpose: "verify" | "reset"): Promise<string | null> {
  if (!/^[a-f0-9]{64}$/.test(token)) return null;
  const hash = await sha256Hex(token);
  const row = await db
    .prepare("SELECT user_id, expires_at, used_at FROM email_tokens WHERE token_hash = ? AND purpose = ?")
    .bind(hash, purpose)
    .first<{ user_id: string; expires_at: string; used_at: string | null }>();
  if (!row || row.used_at || row.expires_at <= nowIso()) return null;
  const update = await db.prepare("UPDATE email_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL").bind(nowIso(), hash).run();
  if (!update.meta?.changes) return null;
  return row.user_id;
}

/** Sends (or re-sends) the verification link. Quietly rate limited. */
export async function sendVerification(env: EmailAuthEnv, user: { id: string; email: string }): Promise<{ sent: boolean; reason?: string }> {
  if (!mailConfigured(env)) return { sent: false, reason: "mail_unavailable" };
  if ((await recentCount(env.DB, user.id, "verify")) >= MAX_PER_WINDOW) return { sent: false, reason: "rate_limited" };
  const token = await issueToken(env.DB, user.id, "verify", VERIFY_TTL_MS);
  const link = `${DASHBOARD_ORIGIN}/verify-email?token=${token}`;
  const mail = brandedEmail({
    heading: "Confirm your email",
    intro: `Confirm ${user.email} to finish setting up your Bridgistic account. Your licenses, billing and connected sites appear once your email is confirmed.`,
    cta: "Confirm my email",
    link,
    footnote: "This link works once and expires in 24 hours. If you did not create a Bridgistic account, ignore this email.",
  });
  const sent = await sendMail(env, { to: user.email, subject: "Confirm your Bridgistic email", ...mail });
  return sent ? { sent } : { sent, reason: "mail_failed" };
}

export async function handleVerifyResend(env: EmailAuthEnv, user: User & { email_verified_at?: string | null }): Promise<Response> {
  if (user.email_verified_at) return Response.json({ ok: true, already_verified: true });
  const result = await sendVerification(env, user);
  if (result.reason === "rate_limited") return Response.json({ error: "rate_limited", message: "We just sent a link. Wait a few minutes before asking again." }, { status: 429 });
  if (!result.sent) return Response.json({ error: "mail_unavailable", message: "Email is temporarily unavailable. Try again shortly." }, { status: 503 });
  return Response.json({ ok: true });
}

export async function handleVerifyConfirm(env: EmailAuthEnv, request: Request): Promise<Response> {
  const body = await request.json<{ token?: string }>().catch(() => ({} as { token?: string }));
  const userId = await consumeToken(env.DB, String(body.token ?? ""), "verify");
  if (!userId) return Response.json({ error: "invalid_token", message: "This confirmation link is invalid or has expired. Sign in and resend a new one." }, { status: 400 });
  await env.DB.prepare("UPDATE users SET email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?").bind(nowIso(), userId).run();
  const user = await env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(userId).first<{ email: string }>();
  await audit(env.DB, user?.email ?? userId, "user.email_verified", user?.email ?? "");
  return Response.json({ ok: true });
}

/** Always answers the same way, so it cannot be used to discover accounts. */
export async function handlePasswordForgot(env: EmailAuthEnv, request: Request): Promise<Response> {
  const body = await request.json<{ email?: string }>().catch(() => ({} as { email?: string }));
  const email = String(body.email ?? "").trim().toLowerCase();
  const generic = Response.json({ ok: true, message: "If an account uses that email, a reset link is on its way." });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return generic;
  const user = await env.DB.prepare("SELECT id, email, status FROM users WHERE email = ?").bind(email).first<{ id: string; email: string; status: string }>();
  if (!user || user.status !== "active" || !mailConfigured(env)) return generic;
  if ((await recentCount(env.DB, user.id, "reset")) >= MAX_PER_WINDOW) return generic;
  const token = await issueToken(env.DB, user.id, "reset", RESET_TTL_MS);
  const mail = brandedEmail({
    heading: "Reset your password",
    intro: `Someone asked to reset the password for the Bridgistic account ${user.email}. Choose a new password with the button below.`,
    cta: "Choose a new password",
    link: `${DASHBOARD_ORIGIN}/reset-password?token=${token}`,
    footnote: "This link works once and expires in 1 hour. If you did not ask for this, ignore this email; your password stays the same.",
  });
  await sendMail(env, { to: user.email, subject: "Reset your Bridgistic password", ...mail });
  await audit(env.DB, user.email, "user.password_reset_requested", user.email);
  return generic;
}

export async function handlePasswordReset(env: EmailAuthEnv, request: Request): Promise<Response> {
  const body = await request.json<{ token?: string; password?: string }>().catch(() => ({} as { token?: string; password?: string }));
  const password = String(body.password ?? "");
  if (password.length < 8) return Response.json({ error: "weak_password", message: "The password must be at least 8 characters." }, { status: 400 });
  const userId = await consumeToken(env.DB, String(body.token ?? ""), "reset");
  if (!userId) return Response.json({ error: "invalid_token", message: "This reset link is invalid or has expired. Ask for a new one." }, { status: 400 });
  // Resetting through the inbox proves ownership: verify the email and sign
  // out every other session (including any held by someone else).
  await env.DB.prepare("UPDATE users SET password_hash = ?, email_verified_at = COALESCE(email_verified_at, ?) WHERE id = ?").bind(await hashPassword(password), nowIso(), userId).run();
  await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
  await env.DB.prepare("UPDATE email_tokens SET used_at = ? WHERE user_id = ? AND purpose = 'reset' AND used_at IS NULL").bind(nowIso(), userId).run();
  const user = await env.DB.prepare("SELECT email FROM users WHERE id = ?").bind(userId).first<{ email: string }>();
  await audit(env.DB, user?.email ?? userId, "user.password_reset", user?.email ?? "");
  return Response.json({ ok: true, message: "Your password was changed. Sign in with the new password." });
}

