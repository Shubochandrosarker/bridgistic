/**
 * Sessions and step-up authentication.
 *
 * Step-up is the control that makes "approval + snapshot + step-up" mean
 * something. Approval proves somebody agreed; step-up proves the person at the
 * keyboard right now is the person who owns the account — which is what stops
 * a stolen session cookie from deactivating a plugin at 3am.
 *
 * The freshness window is short and non-negotiable per plan. A step-up that
 * lasts a working day is a session by another name.
 */

/** How recently the actor must have re-authenticated, per risk. */
export const STEP_UP_WINDOW_SECONDS = {
  /** Destructive and credential work. Short enough that it means "just now". */
  destructive: 300,
  /**
   * Code execution. Shorter still — arbitrary PHP is the highest privilege in
   * the product, and five minutes of it is a long time.
   */
  code_execution: 120,
  /** Changing account security settings, keys, or another member's role. */
  account_security: 300,
} as const;

export type StepUpReason = keyof typeof STEP_UP_WINDOW_SECONDS;

export interface SessionState {
  readonly userId: string;
  readonly organizationId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  /** When step-up was last completed. Null if never. */
  readonly steppedUpAt: number | null;
  /** Set when the session has been revoked explicitly. */
  readonly revokedAt: number | null;
  /**
   * Credential version this session was issued against.
   *
   * A password change, an MFA reset or a site credential rotation bumps the
   * version, and every session issued under the old one stops being valid.
   * Without this, "log out everywhere" is a button that does nothing.
   */
  readonly credentialVersion: number;
}

export type SessionVerdict =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "expired" | "revoked" | "stale_credential" };

export function checkSession(
  session: SessionState,
  context: { readonly now: number; readonly currentCredentialVersion: number }
): SessionVerdict {
  if (session.revokedAt !== null && session.revokedAt <= context.now) {
    return { ok: false, reason: "revoked" };
  }
  if (session.expiresAt <= context.now) {
    return { ok: false, reason: "expired" };
  }
  // Strictly less-than: a session issued at the current version is fine, one
  // issued before a rotation is not.
  if (session.credentialVersion < context.currentCredentialVersion) {
    return { ok: false, reason: "stale_credential" };
  }
  return { ok: true };
}

/**
 * Has this session stepped up recently enough for `reason`?
 *
 * A machine token can never satisfy this — it has nobody to challenge — which
 * is why `allowedForMachineToken` refuses credential-class scopes outright
 * rather than letting them arrive here and fail confusingly.
 */
export function isStepUpFresh(
  session: SessionState,
  reason: StepUpReason,
  now: number
): { readonly fresh: boolean; readonly expiresInSeconds: number } {
  if (session.steppedUpAt === null) return { fresh: false, expiresInSeconds: 0 };

  const window = STEP_UP_WINDOW_SECONDS[reason];
  const age = now - session.steppedUpAt;

  // A step-up timestamped in the future is a clock problem or a forged one.
  // Either way it is not evidence, so it is treated as absent.
  if (age < 0) return { fresh: false, expiresInSeconds: 0 };

  const remaining = window - age;
  return { fresh: remaining > 0, expiresInSeconds: Math.max(0, remaining) };
}

/**
 * The step-up reason a risk class needs, or null when none is required.
 *
 * Mapped from the class rather than the tool name so a new tool is covered by
 * its classification the day it is added.
 */
export function stepUpReasonForRiskClass(riskClass: string): StepUpReason | null {
  switch (riskClass) {
    case "destructive":
    case "credential":
      return "destructive";
    case "code_execution":
      return "code_execution";
    default:
      return null;
  }
}

/** Default session lifetime. Long enough to work, short enough to matter. */
export const SESSION_LIFETIME_SECONDS = 12 * 60 * 60;

/**
 * Sessions to invalidate when something security-relevant changes.
 *
 * Returns the ids to revoke rather than revoking them, so the caller decides
 * the transaction — and so this is testable without a database.
 *
 * `keepCurrent` exists for the password-change case: revoking every session
 * including the one doing the changing logs the user out mid-flow, which
 * trains people to avoid changing their password.
 */
export function sessionsToRevoke(
  sessions: readonly SessionState[],
  options: { readonly userId: string; readonly keepSessionId?: string },
  identify: (session: SessionState) => string
): string[] {
  return sessions
    .filter((session) => session.userId === options.userId)
    .filter((session) => session.revokedAt === null)
    .map(identify)
    .filter((id) => id !== options.keepSessionId);
}
