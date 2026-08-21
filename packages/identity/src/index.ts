/**
 * `@bridgistic/identity` — who is calling, and what they may do.
 *
 * Pure policy. No database, no HTTP, no Cloudflare bindings — so every rule in
 * here is testable without infrastructure, and the rules are the part that
 * must not be wrong.
 */

export { ROLES, PERMISSIONS, ROLE_PERMISSIONS, isRole, can, permissionForRiskClass, canDecideApproval, canChangeRole } from "./roles.ts";
export type { Role, Permission } from "./roles.ts";

export {
  KEY_ENVIRONMENTS,
  KEY_PRODUCT_PREFIX,
  generateApiKey,
  parseApiKey,
  hashSecret,
  constantTimeEqual,
  verifyApiKey,
  maskApiKey,
} from "./api-key.ts";
export type { KeyEnvironment, GeneratedKey, ParsedKey, StoredKey, KeyVerdict, KeyRejection } from "./api-key.ts";

export {
  STEP_UP_WINDOW_SECONDS,
  SESSION_LIFETIME_SECONDS,
  checkSession,
  isStepUpFresh,
  stepUpReasonForRiskClass,
  sessionsToRevoke,
} from "./session.ts";
export type { SessionState, SessionVerdict, StepUpReason } from "./session.ts";
