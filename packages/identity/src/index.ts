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

export {
  generateCodeVerifier,
  deriveCodeChallenge,
  isValidCodeVerifier,
  isValidCodeChallenge,
  verifyCodeChallenge,
  generateOpaqueToken,
  isRegisteredRedirectUri,
  verifyAuthorizationCode,
  AUTHORIZATION_CODE_TTL_SECONDS,
  OAUTH_STATE_TTL_SECONDS,
} from "./pkce.ts";
export type { PkceRejection, CodeRejection, AuthorizationCodeRecord } from "./pkce.ts";

export {
  CONNECTION_STATES,
  SITE_STATES,
  CONNECTION_CHALLENGE_TTL_SECONDS,
  OWNERSHIP_CLAIM_TTL_SECONDS,
  canTransition,
  verifyConnection,
  claimConnection,
  isSiteUsable,
  canTransferSite,
  planRotation,
  canClaimMigratedSite,
} from "./site-connection.ts";
export type {
  ConnectionState,
  SiteState,
  Connection,
  TransitionResult,
  ClaimContext,
  TransferContext,
  RotationEffect,
} from "./site-connection.ts";
