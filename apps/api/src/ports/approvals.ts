/**
 * The approval store, backed by `approvals` in D1.
 *
 * An approval is created when the gate refuses a call, not when a caller asks
 * for one — so the row is the record of a real attempt, and there is no way to
 * pre-create an approval for a call that was never made.
 *
 * The decision itself is not here. Deciding requires a role, step-up freshness
 * and an organization scope, and it belongs to the API route that a human
 * reaches with a session. This port only opens the request.
 */

import type { ApprovalStore } from "@bridgistic/executor";
import type { SqlDatabase } from "../db/scope.ts";

/**
 * How long an approval waits for an answer.
 *
 * Bounded because a destructive action approved three days after it was
 * proposed is being approved against a site that has moved on. The run it
 * blocks becomes `skipped` rather than sitting in the history as a zombie.
 */
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1_000;

export interface D1ApprovalStoreOptions {
  readonly db: SqlDatabase;
  readonly now?: () => number;
  readonly newId?: () => string;
}

export class D1ApprovalStore implements ApprovalStore {
  readonly #db: SqlDatabase;
  readonly #now: () => number;
  readonly #newId: () => string;

  constructor(options: D1ApprovalStoreOptions) {
    this.#db = options.db;
    this.#now = options.now ?? (() => Date.now());
    this.#newId = options.newId ?? (() => `apr_${crypto.randomUUID().replace(/-/g, "")}`);
  }

  async request(input: {
    organizationId: string;
    siteId: string | null;
    actorId: string;
    actorType: "user" | "api_key" | "mcp_session" | "service_account" | "scheduler" | "system";
    tool: string;
    scopeRequested: string;
    requestHash: string;
    summary: string;
  }): Promise<string> {
    if (input.siteId === null) {
      // Every approval-gated class acts on a site. Reaching here without one
      // means the caller took a path that should not exist, and recording an
      // approval nobody could act on would turn that into a row a human might
      // later click "approve" on.
      throw new Error("An approval requires a site.");
    }

    const id = this.#newId();
    const now = this.#now();

    await this.#db
      .prepare(
        `INSERT INTO approvals (
           id, organization_id, site_id, tool, scope_requested, request_digest,
           summary, requested_by_type, requested_by_id, status,
           step_up_verified_at, decided_by, decided_at, expires_at, created_at
         ) VALUES (?,?,?,?,?,?,?,?,?,'pending',NULL,NULL,NULL,?,?)`
      )
      .bind(
        id,
        input.organizationId,
        input.siteId,
        input.tool,
        input.scopeRequested,
        input.requestHash,
        input.summary,
        // `service_account` and `system` are executor-side actor types the
        // approvals table does not carry. They map to `api_key`, which is what
        // they are on the wire — an unattended credential — rather than being
        // dropped, which would abort the insert on the CHECK.
        toRequestedByType(input.actorType),
        input.actorId,
        now + APPROVAL_TTL_MS,
        now
      )
      .run();

    return id;
  }
}

function toRequestedByType(actorType: string): "user" | "api_key" | "mcp_session" | "scheduler" {
  switch (actorType) {
    case "user":
      return "user";
    case "mcp_session":
      return "mcp_session";
    case "scheduler":
      return "scheduler";
    default:
      return "api_key";
  }
}
