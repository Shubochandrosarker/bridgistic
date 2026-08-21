/**
 * The snapshot store: takes the snapshot on the site, records it here.
 *
 * The snapshot itself lives on the WordPress install — the plugin captures it
 * and owns the restore — so this port calls the site through the same signed
 * transport as any other tool, and keeps a row pointing at what the plugin
 * returned. `snapshots.remote_id` is the plugin's id; restoring goes back
 * through the plugin with it.
 *
 * ## It refuses more often than it succeeds, on purpose
 *
 * `snapshotTargetFor` builds the capture target from the call's own arguments,
 * and for a number of gated tools no target can be built at all — the plugin
 * captures one post, one user, one option, a list of named tables or one file,
 * and has no whole-site capture. Those come back `ok: false` and the executor
 * refuses the call. See `packages/tools/src/snapshot-targets.ts` for the list
 * and the reason for each, and BR-020 for what it costs.
 */

import { snapshotTargetFor, isUnavailable } from "@bridgistic/tools";
import { contractFor } from "@bridgistic/contracts";
import type { SnapshotStore, Transport } from "@bridgistic/executor";
import type { SqlDatabase } from "../db/scope.ts";

/**
 * How long a snapshot is kept.
 *
 * A flat window until plan-based retention lands with the sweep (Phase 5). It
 * is a floor, not a promise: the row carries `expires_at` so the sweep can find
 * it, and shortening it later shortens retention for snapshots already taken,
 * which is why it starts at the longest any plan will offer rather than the
 * shortest.
 */
export const SNAPSHOT_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

export interface PluginSnapshotStoreOptions {
  readonly db: SqlDatabase;
  readonly transport: Transport;
  readonly now?: () => number;
  readonly newId?: () => string;
}

interface CreatedSnapshot {
  readonly snapshot_id?: unknown;
  readonly byte_size?: unknown;
}

export class PluginSnapshotStore implements SnapshotStore {
  readonly #db: SqlDatabase;
  readonly #transport: Transport;
  readonly #now: () => number;
  readonly #newId: () => string;

  constructor(options: PluginSnapshotStoreOptions) {
    this.#db = options.db;
    this.#transport = options.transport;
    this.#now = options.now ?? (() => Date.now());
    this.#newId = options.newId ?? (() => `snp_${crypto.randomUUID().replace(/-/g, "")}`);
  }

  async create(input: {
    organizationId: string;
    siteId: string;
    tool: string;
    args: Record<string, unknown>;
    reason: string;
  }): Promise<{ readonly ok: true; readonly id: string } | { readonly ok: false; readonly reason: string }> {
    const plan = snapshotTargetFor(input.tool, input.args);
    if (plan === undefined) {
      // The executor only calls this for tools whose contract requires a
      // snapshot, so a tool with no entry is a tool that was added to that set
      // without deciding what it captures. Refused rather than defaulted:
      // a default here is a guess about what to roll back.
      return {
        ok: false,
        reason: "This tool requires a snapshot and none is defined for it.",
      };
    }
    if (isUnavailable(plan)) return { ok: false, reason: plan.reason };

    const contract = contractFor("bridgistic_snapshot_create");
    if (!contract) return { ok: false, reason: "The snapshot tool is not available." };

    const result = await this.#transport.call({
      organizationId: input.organizationId,
      siteId: input.siteId,
      contract,
      args: {
        type: plan.type,
        target: plan.target,
        // Names the call this protects, so a snapshot in the site's own list is
        // traceable to why it exists. No argument values: a label is shown in
        // WordPress admin, and the arguments can carry customer data.
        label: `Bridgistic: before ${input.tool}`,
      },
      requestId: `snapshot-${input.tool}`,
      timeoutMs: contract.timeoutMs,
    });

    if (!result.ok) {
      // The site could not take it. The call it guards must not proceed, so
      // this is a refusal rather than a warning — including for `unreachable`,
      // where nothing would have reached the site anyway.
      return { ok: false, reason: `The site could not take a snapshot: ${result.message}` };
    }

    const remoteId = remoteIdFrom(result.data);
    if (remoteId === undefined) {
      return { ok: false, reason: "The site did not return a snapshot id." };
    }

    const id = this.#newId();
    const now = this.#now();
    await this.#db
      .prepare(
        `INSERT INTO snapshots (
           id, organization_id, site_id, remote_id, reason, size_bytes,
           created_at, expires_at, restored_at
         ) VALUES (?,?,?,?,?,?,?,?,NULL)`
      )
      .bind(
        id,
        input.organizationId,
        input.siteId,
        remoteId,
        input.reason,
        byteSizeFrom(result.data),
        now,
        now + SNAPSHOT_TTL_MS
      )
      .run();

    return { ok: true, id };
  }
}

function remoteIdFrom(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  const id = (data as CreatedSnapshot).snapshot_id;
  return typeof id === "string" && id.length > 0 && id.length <= 128 ? id : undefined;
}

function byteSizeFrom(data: unknown): number | null {
  if (typeof data !== "object" || data === null) return null;
  const size = (data as CreatedSnapshot).byte_size;
  return typeof size === "number" && Number.isFinite(size) && size >= 0 ? Math.floor(size) : null;
}
