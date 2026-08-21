/**
 * Resolving who is calling.
 *
 * Everything downstream depends on this being right, and the failure mode is
 * silent: a `Caller` built from something the client sent is a tenancy break
 * that no later check catches, because every later check trusts this.
 *
 * So the rule is narrow and absolute — the organization, the user, the role
 * and any site restriction come from a credential we verified against the
 * database. Never from a header the client chose, never from a path parameter,
 * never from a body field. `FORBIDDEN_PARAM_NAMES` in the contract package
 * enforces the same rule from the other end.
 */

import {
  verifyApiKey,
  checkSession,
  isRole,
  type Role,
  type StoredKey,
  type SessionState,
  type KeyEnvironment,
} from "@bridgistic/identity";
import type { Caller, SqlDatabase } from "./db/scope.ts";

export type AuthFailure =
  | "missing_credential"
  | "invalid_credential"
  | "expired"
  | "revoked"
  | "no_membership"
  | "organization_mismatch";

export type AuthResult =
  | { readonly ok: true; readonly caller: Caller; readonly method: "session" | "api_key" }
  | { readonly ok: false; readonly reason: AuthFailure };

export interface AuthContext {
  readonly db: SqlDatabase;
  readonly now: number;
  readonly environment: KeyEnvironment;
}

/**
 * Resolve a request to a caller.
 *
 * Exactly one credential is accepted per request. Presenting both a session
 * and an API key is refused rather than resolved by precedence: a precedence
 * rule is a rule somebody has to remember, and "whichever is more privileged
 * wins" is how a low-privilege key gets used to smuggle a high-privilege
 * session past a check that only looked at the key.
 */
export async function authenticate(request: Request, context: AuthContext): Promise<AuthResult> {
  const authorization = request.headers.get("Authorization");
  const cookie = sessionTokenFrom(request.headers.get("Cookie"));

  const hasBearer = typeof authorization === "string" && /^Bearer\s+\S/i.test(authorization);
  if (hasBearer && cookie !== undefined) {
    return { ok: false, reason: "invalid_credential" };
  }
  if (hasBearer) return authenticateApiKey(authorization.replace(/^Bearer\s+/i, ""), context);
  if (cookie !== undefined) return authenticateSession(cookie, context);
  return { ok: false, reason: "missing_credential" };
}

/** SHA-256, hex. Session tokens are stored hashed, like API key secrets. */
async function hashToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Pull the session token out of a Cookie header.
 *
 * Parsed rather than regex-matched over the whole header, because
 * `Cookie: other=x; bridgistic_session=real` and
 * `Cookie: not_bridgistic_session=fake` must not be confusable.
 */
export function sessionTokenFrom(header: string | null): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    if (name !== "bridgistic_session") continue;
    const value = part.slice(separator + 1).trim();
    // Bounded and character-restricted before it is used as a lookup key.
    return /^[A-Za-z0-9_-]{32,128}$/.test(value) ? value : undefined;
  }
  return undefined;
}

async function authenticateSession(token: string, context: AuthContext): Promise<AuthResult> {
  const row = await context.db
    .prepare(
      `SELECT s.id, s.user_id, s.organization_id, s.created_at, s.expires_at,
              s.stepped_up_at, s.revoked_at, s.credential_version,
              u.credential_version AS current_credential_version, u.status AS user_status
         FROM sessions s
         JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = ?`
    )
    .bind(await hashToken(token))
    .first<{
      id: string;
      user_id: string;
      organization_id: string;
      created_at: number;
      expires_at: number;
      stepped_up_at: number | null;
      revoked_at: number | null;
      credential_version: number;
      current_credential_version: number;
      user_status: string;
    }>();

  if (!row) return { ok: false, reason: "invalid_credential" };

  // A suspended or deleted user's live sessions must stop working immediately,
  // not at expiry.
  if (row.user_status !== "active") return { ok: false, reason: "revoked" };

  const session: SessionState = {
    userId: row.user_id,
    organizationId: row.organization_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    steppedUpAt: row.stepped_up_at,
    revokedAt: row.revoked_at,
    credentialVersion: row.credential_version,
  };

  const verdict = checkSession(session, {
    now: context.now,
    currentCredentialVersion: row.current_credential_version,
  });
  if (!verdict.ok) {
    return { ok: false, reason: verdict.reason === "expired" ? "expired" : "revoked" };
  }

  // The session names an organization, but the membership is what authorises.
  // A session outliving the membership it was issued under — somebody removed
  // from a team — must stop working, and only this check notices.
  const role = await roleFor(context.db, row.user_id, row.organization_id);
  if (role === undefined) return { ok: false, reason: "no_membership" };

  return {
    ok: true,
    method: "session",
    caller: {
      userId: row.user_id,
      organizationId: row.organization_id,
      role,
      isMachineToken: false,
    },
  };
}

async function authenticateApiKey(presented: string, context: AuthContext): Promise<AuthResult> {
  const verdict = await verifyApiKey(
    presented,
    async (publicId) => {
      const row = await context.db
        .prepare(
          `SELECT id, organization_id, prefix, key_hash, environment, revoked_at, expires_at, role, site_id
             FROM api_keys
            WHERE prefix = ?`
        )
        .bind(publicId)
        .first<{
          id: string;
          organization_id: string;
          prefix: string;
          key_hash: string;
          environment: string;
          revoked_at: number | null;
          expires_at: number | null;
          role: string;
          site_id: string | null;
        }>();
      if (!row) return undefined;

      const stored: StoredKey & { role: string; siteId: string | null } = {
        id: row.id,
        organizationId: row.organization_id,
        publicId: row.prefix,
        secretHash: row.key_hash,
        environment: row.environment as KeyEnvironment,
        revokedAt: row.revoked_at,
        expiresAt: row.expires_at,
        role: row.role,
        siteId: row.site_id,
      };
      return stored;
    },
    { environment: context.environment, now: context.now }
  );

  // Every rejection reason collapses to one answer. Distinguishing "expired"
  // from "unknown" in the response confirms the key was real.
  if (!verdict.ok) return { ok: false, reason: "invalid_credential" };

  const key = verdict.key as StoredKey & { role?: string; siteId?: string | null };
  const role = typeof key.role === "string" && isRole(key.role) ? key.role : undefined;
  if (role === undefined) return { ok: false, reason: "invalid_credential" };

  return {
    ok: true,
    method: "api_key",
    caller: {
      userId: key.id,
      organizationId: key.organizationId,
      role,
      isMachineToken: true,
      ...(key.siteId ? { restrictedToSiteId: key.siteId } : {}),
    },
  };
}

/** The role a user holds in an organization, or undefined if they hold none. */
async function roleFor(db: SqlDatabase, userId: string, organizationId: string): Promise<Role | undefined> {
  const row = await db
    .prepare(`SELECT role FROM memberships WHERE user_id = ? AND organization_id = ?`)
    .bind(userId, organizationId)
    .first<{ role: string }>();
  if (!row) return undefined;
  // A role the vocabulary does not know denies, rather than being cast through.
  return isRole(row.role) ? row.role : undefined;
}

/**
 * Which organization a request is acting on.
 *
 * Takes the id from the path and checks it against the caller's, rather than
 * trusting it. Returning `organization_mismatch` — not a silent switch to the
 * caller's own org — is deliberate: silently redirecting `/v1/orgs/{someone
 * else}/sites` to your own sites hides an attempt rather than recording one.
 */
export function resolveOrganization(caller: Caller, requested: string | undefined): AuthResult {
  if (requested !== undefined && requested !== caller.organizationId) {
    return { ok: false, reason: "organization_mismatch" };
  }
  return { ok: true, caller, method: caller.isMachineToken ? "api_key" : "session" };
}
