/**
 * `@bridgistic/contracts` — the canonical, versioned tool contract.
 *
 * Every surface that can invoke a tool reads its definition from here: the MCP
 * server, the REST API, the scheduler's queue consumer, the dashboard's typed
 * client, and the drift check against the free public repository.
 *
 * There is deliberately no way to describe a tool anywhere else. A second
 * description would be a second security policy.
 */

export { validate, compileSchema } from "./json-schema.ts";
export type { JsonSchema, JsonType, ValidationError, ValidationResult } from "./json-schema.ts";

export type { ToolContract, ErrorEnvelope, ErrorCode, MeterUnit } from "./types.ts";
export { ERROR_CODES, OPAQUE_DENIAL_CODES } from "./types.ts";

export {
  SITE_PARAM,
  DRY_RUN_PARAM,
  APPROVAL_ID_PARAM,
  IDEMPOTENCY_KEY_PARAM,
  GUARD_PARAMS,
  FORBIDDEN_PARAM_NAMES,
  PER_PAGE_PARAM,
  PAGE_PARAM,
  ID_PARAM,
} from "./params.ts";

export {
  CONTRACT_VERSION,
  TOOL_OUTPUT_SCHEMA,
  allContracts,
  contractFor,
  contractsFor,
} from "./registry.ts";

export { validateToolInput, assertCallable, mcpToolDescriptors } from "./validate.ts";
export type { CallerContext, CallableVerdict } from "./validate.ts";
