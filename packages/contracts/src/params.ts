/**
 * Parameter fragments shared across contracts.
 *
 * The interesting one is what is NOT here: `force`.
 */

import type { JsonSchema } from "./json-schema.ts";

/**
 * Which connected site to act on.
 *
 * A site *alias*, never a URL. The hosted platform resolves the alias to an
 * origin from a row the caller's organization owns, so a caller cannot point a
 * tool at an address of their choosing. That is the difference between a
 * transport and a proxy, and it is the reason the SSRF surface is one
 * onboarding form rather than every tool call.
 */
export const SITE_PARAM: JsonSchema = {
  type: "string",
  minLength: 1,
  maxLength: 64,
  pattern: "^[a-z0-9][a-z0-9_-]*$",
  description:
    'Site alias to target (e.g. "example-store"). Omit when the organization has exactly one connected site.',
};

/** Preview a write without performing it. Nothing persisted, queued or snapshotted. */
export const DRY_RUN_PARAM: JsonSchema = {
  type: "boolean",
  description:
    "If true, return what WOULD change without modifying anything. Nothing is persisted, snapshotted, or queued.",
};

/** Re-submission token after a human approved a queued operation. */
export const APPROVAL_ID_PARAM: JsonSchema = {
  type: "string",
  minLength: 8,
  maxLength: 128,
  pattern: "^[A-Za-z0-9_-]+$",
  description:
    "Approval id returned by a previous call that required approval. Re-send the SAME arguments plus this id " +
    "once an approver has granted it.",
};

/** Deduplicates a retry so it does not become a second mutation. */
export const IDEMPOTENCY_KEY_PARAM: JsonSchema = {
  type: "string",
  minLength: 8,
  maxLength: 128,
  pattern: "^[A-Za-z0-9_.:-]+$",
  description:
    "Client-generated key that makes a retry safe. Re-sending the same key with the same arguments returns the " +
    "original result instead of acting again. Required for writes.",
};

/**
 * Guard parameters a caller may legitimately set.
 *
 * BR-013 — `force` was here and has been removed.
 *
 * The pinned engine's `guardParams` includes a client-settable boolean
 * documented as "Bypass the snapshot-required abort (irreversible)". That is a
 * flag, in a tool call, that turns off a safety gate — and on the hosted
 * platform the entity filling in that flag is a language model acting on a
 * prompt that may itself have come from a web page the model was asked to
 * read.
 *
 * INVARIANT 3 says destructive operations require approval and a snapshot
 * *always*, with no tier that turns it off. A boolean argument that turns it
 * off is the same hole with a friendlier name.
 *
 * Proceeding without a snapshot is still possible — sometimes a snapshot
 * genuinely cannot be taken and the work genuinely must happen — but it is an
 * organization policy decision made by a human with an elevated role, recorded
 * as an approval with a reason, and never an argument. See
 * `SECURITY_MODEL.md` §1 and the `snapshot_required` error code, which returns
 * the approval id to take to a person.
 */
export const GUARD_PARAMS: Readonly<Record<string, JsonSchema>> = {
  dry_run: DRY_RUN_PARAM,
  approval_id: APPROVAL_ID_PARAM,
  idempotency_key: IDEMPOTENCY_KEY_PARAM,
};

/**
 * Argument names a contract may never declare, with the reason.
 *
 * `url` is deliberately NOT here. `bridgistic_upload_media` takes one, and it
 * is a legitimate argument: the file to put in the media library. It is a data
 * *source*, not a request *target* — nothing about it changes which site the
 * call goes to.
 *
 * It is still fetched server-side by WordPress, so it is still an SSRF vector,
 * just one belonging to the plugin rather than to the transport. Banning the
 * name would have been the easy answer and the wrong one: it would have
 * removed a feature without removing the risk, which lives in what the plugin
 * does with the value. `assertUrlParamsGuarded` below is the rule that
 * actually applies — every URL-shaped argument must carry `format: https-url`,
 * so no contract can accept a bare string and hope the handler remembers.
 */
export const FORBIDDEN_PARAM_NAMES: Readonly<Record<string, string>> = {
  force: "a caller-settable bypass of a safety gate — see BR-013, use an approval with a reason",
  skip_snapshot: "same as force, under another name",
  organization_id: "server-derived from the token; trusting the client's copy is a tenancy break",
  org_id: "server-derived from the token",
  user_id: "server-derived from the token",
  actor: "server-derived from the token",
  plan: "server-derived; a caller-supplied plan is a free upgrade",
  scopes: "server-derived from the intersection in SECURITY_MODEL.md §2",
  limit_override: "server-derived; a caller-supplied limit is not a limit",
  site_url: "a caller-supplied destination turns the transport into a proxy — pass `site`, an alias",
  target_url: "same as site_url",
  endpoint: "same as site_url",
  callback_url: "an outbound target chosen by the caller",
  credential: "credentials never travel in an argument",
  password: "credentials never travel in an argument",
  api_key: "credentials never travel in an argument",
  token: "credentials never travel in an argument",
};

/** Pagination, identical everywhere it appears. */
export const PER_PAGE_PARAM: JsonSchema = {
  type: "integer",
  minimum: 1,
  maximum: 100,
  description: "Results per page (max 100).",
};

export const PAGE_PARAM: JsonSchema = {
  type: "integer",
  minimum: 1,
  maximum: 10_000,
  description: "1-based page number.",
};

/** A WordPress object id. */
export const ID_PARAM: JsonSchema = {
  type: "integer",
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
  description: "WordPress object id.",
};


/**
 * Names that carry a URL. Any argument called one of these must be
 * `format: "https-url"` — see the note on FORBIDDEN_PARAM_NAMES.
 */
const URL_SHAPED = new Set(["url", "source_url", "image_url", "media_url", "href", "link"]);

/** Throws if a contract accepts a URL-shaped argument without the guard. */
export function assertUrlParamsGuarded(
  toolName: string,
  properties: Readonly<Record<string, { readonly format?: string }>>
): void {
  for (const [name, schema] of Object.entries(properties)) {
    if (!URL_SHAPED.has(name)) continue;
    if (schema.format === "https-url") continue;
    throw new Error(
      `${toolName}: argument "${name}" carries a URL and must declare format: "https-url". ` +
        `A bare string here is fetched server-side by the WordPress plugin, which makes it a ` +
        `request-forgery vector whose only defence would be the handler remembering to check it.`
    );
  }
}
