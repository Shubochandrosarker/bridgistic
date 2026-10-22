/**
 * Session and role helpers on top of D1. Sessions are opaque random ids in an
 * HttpOnly Secure cookie; the row carries the expiry, so sign-out deletes the
 * row and revocation is immediate.
 */

export interface User {
  id: string;
  email: string;
  name: string;
  role: "owner" | "admin" | "member";
  status: "active" | "disabled";
  created_at: string;
}

export interface Org {
  id: string;
  name: string;
  plan: string;
  status: string;
  owner_user_id: string;
  created_at: string;
}

export const SESSION_COOKIE = "brg_session";
const SESSION_DAYS = 30;

export interface AuthEnv {
  DB: D1Database;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function sessionExpiryIso(days = SESSION_DAYS): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

export async function createSession(db: D1Database, userId: string): Promise<string> {
  const id = crypto.randomUUID().replace(/-/g, "") + crypto.randomUUID().replace(/-/g, "");
  await db.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)").bind(id, userId, sessionExpiryIso()).run();
  return id;
}

/**
 * The cookie is scoped to .bridgistic.app when the console runs on one of its
 * subdomains, so one session works on admin., dashboard. and marketplace.
 * Hosts outside that zone (e.g. *.pages.dev) get a host-only cookie — browsers
 * reject a Domain attribute that is not a suffix of the current host.
 */
export function sessionCookie(value: string, maxAgeSeconds = SESSION_DAYS * 86_400, domain?: string): string {
  const d = domain ? `; Domain=${domain}` : "";
  return `${SESSION_COOKIE}=${value}; Path=/${d}; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

export function clearedSessionCookie(domain?: string): string {
  const d = domain ? `; Domain=${domain}` : "";
  return `${SESSION_COOKIE}=; Path=/${d}; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/** Registrable-domain suffix to share the session across, or undefined when not on one. */
export function sharedCookieDomain(host: string | null): string | undefined {
  if (host && /(^|\.)bridgistic\.app$/.test(host)) return ".bridgistic.app";
  return undefined;
}

export function readSessionId(request: Request): string | null {
  const header = request.headers.get("Cookie") ?? "";
  for (const part of header.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === SESSION_COOKIE) return rest.join("=");
  }
  return null;
}

export async function currentUser(db: D1Database, request: Request): Promise<User | null> {
  const sessionId = readSessionId(request);
  if (!sessionId) return null;
  const row = await db
    .prepare(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.expires_at > ? AND u.status = 'active'`
    )
    .bind(sessionId, nowIso())
    .first<User>();
  return row ?? null;
}

export async function destroySession(db: D1Database, request: Request): Promise<void> {
  const sessionId = readSessionId(request);
  if (sessionId) await db.prepare("DELETE FROM sessions WHERE id = ?").bind(sessionId).run();
}

export class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

export async function requireUser(db: D1Database, request: Request): Promise<User> {
  const user = await currentUser(db, request);
  if (!user) throw new HttpError(401, "unauthorized", "Sign in required.");
  return user;
}

export async function requireStaff(db: D1Database, request: Request): Promise<User> {
  const user = await requireUser(db, request);
  if (user.role !== "owner" && user.role !== "admin") throw new HttpError(403, "forbidden", "Platform staff only.");
  return user;
}

export async function userOrgs(db: D1Database, userId: string): Promise<(Org & { membership_role: string })[]> {
  const { results } = await db
    .prepare(
      `SELECT o.*, m.role AS membership_role FROM orgs o
       JOIN memberships m ON m.org_id = o.id WHERE m.user_id = ? ORDER BY o.created_at ASC`
    )
    .bind(userId)
    .all<Org & { membership_role: string }>();
  return results ?? [];
}

/** Throws unless the user belongs to the org (any role). Returns the membership role. */
export async function requireOrgMember(db: D1Database, userId: string, orgId: string): Promise<string> {
  const row = await db.prepare("SELECT role FROM memberships WHERE org_id = ? AND user_id = ?").bind(orgId, userId).first<{ role: string }>();
  if (!row) throw new HttpError(404, "not_found", "Workspace not found.");
  return row.role;
}

export async function audit(db: D1Database, actor: string, action: string, target = "", detail = ""): Promise<void> {
  await db.prepare("INSERT INTO audit (id, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), actor, action, target, detail).run();
}

export async function syncLog(db: D1Database, action: string, keyMask: string, domain: string, detail = ""): Promise<void> {
  await db.prepare("INSERT INTO sync_log (id, action, key_mask, domain, detail) VALUES (?, ?, ?, ?, ?)").bind(crypto.randomUUID(), action, keyMask, domain, detail).run();
}

export async function getSetting(db: D1Database, key: string): Promise<unknown | null> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.value);
  } catch {
    return row.value;
  }
}

export async function putSetting(db: D1Database, key: string, value: unknown): Promise<void> {
  await db
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, JSON.stringify(value))
    .run();
}
