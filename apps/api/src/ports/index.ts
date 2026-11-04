/**
 * The composition root: one set of ports, built once, shared by every surface.
 *
 * `IMPLEMENTATION_PLAN.md` Phase 3 says MCP, the API and the scheduler all call
 * the same executor and that handlers become thin adapters. This is where that
 * becomes true in code — the three surfaces build their executor here and none
 * of them assembles its own, because three assemblies is three chances for one
 * of them to be missing a gate, and the one that is missing it will be the one
 * nobody tested because it was "the same as the others".
 *
 * Nothing here makes a policy decision. Every port is constructed from the
 * environment's bindings and handed over; the decisions live in the executor
 * and in the scope model.
 */

import { ActionExecutor } from "@bridgistic/executor";
import type { ExecutorPorts } from "@bridgistic/executor";
import { Logger } from "@bridgistic/observability";
import { D1IdempotencyStore } from "../db/idempotency.ts";
import { DurableMeteringStore } from "./metering.ts";
import { D1AuditLog } from "./audit.ts";
import { D1ApprovalStore } from "./approvals.ts";
import { D1ConcurrencyLock } from "./locks.ts";
import { PluginSnapshotStore } from "./snapshots.ts";
import { WordPressTransport } from "../transport.ts";
import type { SqlDatabase } from "../db/scope.ts";
import type { Env } from "../env.ts";

export interface ExecutorDeps {
  readonly db: SqlDatabase;
  readonly counters: ConstructorParameters<typeof DurableMeteringStore>[0]["counters"];
  readonly encryptionKey: string;
  /** Injected in tests. Production uses the platform `fetch`. */
  readonly fetchImpl?: typeof fetch;
  readonly now?: () => number;
  readonly newId?: () => string;
  /** Injected in tests so log lines can be asserted rather than printed. */
  readonly logger?: Logger;
}

/**
 * Build the seven ports.
 *
 * The transport is constructed first because the snapshot store calls the site
 * through it: a snapshot is taken by the plugin, over the same signed
 * transport as any other call, and there is no second path to a site.
 */
export function createExecutorPorts(deps: ExecutorDeps): ExecutorPorts {
  const now = deps.now ?? (() => Date.now());
  const newId = deps.newId ?? (() => `act_${crypto.randomUUID().replace(/-/g, "")}`);

  const transport = new WordPressTransport({
    db: deps.db,
    encryptionKey: deps.encryptionKey,
    ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}),
  });

  return {
    idempotency: new D1IdempotencyStore(deps.db, now),
    metering: new DurableMeteringStore({ counters: deps.counters, db: deps.db, now }),
    approvals: new D1ApprovalStore({ db: deps.db, now }),
    snapshots: new PluginSnapshotStore({ db: deps.db, transport, now }),
    locks: new D1ConcurrencyLock({ db: deps.db, now }),
    transport,
    audit: new D1AuditLog(deps.db),
    now,
    newId,
  };
}

/** The executor every surface uses. */
export function createExecutor(deps: ExecutorDeps): ActionExecutor {
  return new ActionExecutor(
    createExecutorPorts(deps),
    // `LogFields` is a closed vocabulary on purpose, so there is no service
    // tag to attach here — the sink adds it.
    deps.logger ?? new Logger()
  );
}

/** The same, from a Worker's bindings. */
export function executorFor(env: Env): ActionExecutor {
  return createExecutor({
    db: env.DB as unknown as SqlDatabase,
    counters: env.USAGE_COUNTER as unknown as ExecutorDeps["counters"],
    encryptionKey: env.TENANT_ENC_KEY,
  });
}
