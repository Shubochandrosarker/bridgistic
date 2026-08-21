/**
 * The executor, driven through the failures that matter.
 *
 * The ports are fakes precisely so they can be made to fail in ways a real
 * database is awkward to arrange: throwing mid-call, returning a duplicate
 * claim, refusing a lock, timing out. The question every test asks is the same
 * one — after this went wrong, is the quota back, is the lock released, and is
 * the audit trail honest?
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { ActionExecutor } from "../src/executor.ts";
import type { ExecutorPorts, ClaimOutcome, TransportResult, AuditEntry } from "../src/ports.ts";
import { Logger } from "@bridgistic/observability";
import { planScopes } from "@bridgistic/types";
import type { ExecuteRequest } from "../src/executor.ts";

const NOW = 1_800_000_000_000;
const KEY = "idem-00000001";

interface Harness {
  ports: ExecutorPorts;
  executor: ActionExecutor;
  audit: AuditEntry[];
  reserved: { id: string; cost: number }[];
  settledReservations: { id: string; actual: number; organizationId: string }[];
  releasedReservations: string[];
  releasedOrganizations: string[];
  claims: { key: string; state: string }[];
  snapshots: number;
  approvals: number;
  locksHeld: string[];
  locksReleased: string[];
}

function harness(overrides: {
  transport?: () => Promise<TransportResult>;
  claim?: () => Promise<ClaimOutcome>;
  admit?: boolean;
  lockAvailable?: boolean;
} = {}): Harness {
  const audit: AuditEntry[] = [];
  const reserved: { id: string; cost: number }[] = [];
  const settledReservations: { id: string; actual: number; organizationId: string }[] = [];
  const releasedReservations: string[] = [];
  const releasedOrganizations: string[] = [];
  const claims: { key: string; state: string }[] = [];
  const locksHeld: string[] = [];
  const locksReleased: string[] = [];
  let snapshots = 0;
  let approvals = 0;
  let counter = 0;

  const ports: ExecutorPorts = {
    idempotency: {
      claim: overrides.claim ?? (async () => ({ kind: "claimed" })),
      async settle(key, state) {
        claims.push({ key, state });
      },
    },
    metering: {
      async reserve({ cost }) {
        if (overrides.admit === false) {
          return { admitted: false, reason: "quota_exceeded" };
        }
        const reservation = { id: `res_${++counter}`, cost };
        reserved.push(reservation);
        return { admitted: true, reservation };
      },
      async settle({ organizationId, reservationId, actual }) {
        settledReservations.push({ id: reservationId, actual, organizationId });
      },
      async release({ organizationId, reservationId }) {
        releasedReservations.push(reservationId);
        releasedOrganizations.push(organizationId);
      },
    },
    approvals: {
      async request() {
        approvals++;
        return `approval-${approvals}0000000`;
      },
    },
    snapshots: {
      async create() {
        snapshots++;
        return `snap_${snapshots}`;
      },
    },
    locks: {
      async acquire(key) {
        if (overrides.lockAvailable === false) return null;
        locksHeld.push(key);
        return async () => {
          locksReleased.push(key);
        };
      },
    },
    transport: {
      call: overrides.transport ?? (async () => ({ ok: true, data: { done: true } })),
    },
    audit: {
      async record(entry) {
        audit.push(entry);
      },
    },
    now: () => NOW,
    newId: () => `id_${++counter}`,
  };

  const executor = new ActionExecutor(ports, new Logger({ sink: () => {}, minLevel: "error" }));

  return {
    ports,
    executor,
    audit,
    reserved,
    settledReservations,
    releasedReservations,
    releasedOrganizations,
    claims,
    get snapshots() {
      return snapshots;
    },
    get approvals() {
      return approvals;
    },
    locksHeld,
    locksReleased,
  } as Harness;
}

function request(overrides: Partial<ExecuteRequest> = {}): ExecuteRequest {
  const scopes = planScopes("agency");
  return {
    tool: "bridgistic_list_posts",
    args: { site: "shop" },
    siteId: "site_1",
    requestId: "req_1",
    caller: {
      organizationId: "org_1",
      actorId: "usr_1",
      isMachineToken: false,
      plan: "agency",
      planScopes: scopes,
      siteScopes: scopes,
      keyScopes: scopes,
      stepUpSatisfied: true,
      grantedApprovals: [],
      codeExecutionOptIn: true,
      role: "operator",
      actorType: "user",
    },
    ...overrides,
  };
}

// ------------------------------------------------------------ happy path ---

test("a permitted read runs, settles its reservation and is audited", async () => {
  const h = harness();
  const result = await h.executor.execute(request());

  assert.equal(result.ok, true);
  assert.equal(h.reserved.length, 1);
  assert.deepEqual(h.settledReservations, [{ id: "res_1", actual: 1, organizationId: "org_1" }]);
  assert.deepEqual(h.releasedReservations, []);
  assert.equal(h.audit[0]!.outcome, "success");
  assert.equal(h.audit[0]!.requestDigest.length, 64, "the digest is recorded, not the arguments");
});

test("the audit records a digest and never the arguments", async () => {
  const h = harness();
  await h.executor.execute(
    request({
      tool: "bridgistic_db_query",
      args: { site: "shop", sql: "SELECT user_pass FROM wp_users", idempotency_key: KEY, approval_id: "approval-real-1" },
      caller: { ...request().caller, grantedApprovals: ["approval-real-1"] },
    })
  );

  const serialised = JSON.stringify(h.audit);
  assert.ok(!serialised.includes("user_pass"), "an argument value reached the audit log");
  assert.ok(!serialised.includes("SELECT"), "SQL reached the audit log");
});

// --------------------------------------------------------------- denials ---

test("a denied call costs nothing: no reservation, no lock, no snapshot", async () => {
  const h = harness();
  const result = await h.executor.execute(
    request({ caller: { ...request().caller, siteScopes: [] } })
  );

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error, "scope_denied");
  assert.equal(h.reserved.length, 0, "a denied call reserved quota");
  assert.equal(h.locksHeld.length, 0, "a denied call took a lock");
  assert.equal(h.snapshots, 0);
  // …but it IS audited. "Somebody tried and was refused" is what an incident
  // review needs, and it is invisible if only successes are recorded.
  assert.equal(h.audit[0]!.outcome, "denied");
  assert.equal(h.audit[0]!.errorClass, "scope_denied");
});

test("the role is checked as well as the scope", async () => {
  // A Viewer on a site granted posts:write still may not write. The scope
  // check cannot see that, because scope is about the site and role is about
  // the person.
  const h = harness();
  const result = await h.executor.execute(
    request({
      tool: "bridgistic_create_post",
      args: { site: "shop", title: "x", idempotency_key: KEY },
      caller: { ...request().caller, role: "viewer" },
    })
  );

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error, "forbidden");
  assert.equal(h.reserved.length, 0);
});

test("an approver cannot execute, even holding every scope", async () => {
  const h = harness();
  const result = await h.executor.execute(
    request({
      tool: "bridgistic_create_post",
      args: { site: "shop", title: "x", idempotency_key: KEY },
      caller: { ...request().caller, role: "approver" },
    })
  );
  assert.equal(result.ok === false && result.error, "forbidden");
});

// -------------------------------------------------------------- approvals --

test("a destructive call creates an approval rather than telling the caller to find one", async () => {
  const h = harness();
  const result = await h.executor.execute(
    request({
      tool: "bridgistic_toggle_plugin",
      args: { site: "shop", plugin: "w/w.php", state: "deactivate", idempotency_key: KEY },
    })
  );

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error, "approval_required");
  assert.ok(result.ok === false && result.approvalId, "no approval id was returned");
  assert.equal(h.approvals, 1);
  // Nothing was touched while waiting for a human.
  assert.equal(h.reserved.length, 0);
  assert.equal(h.snapshots, 0);
  assert.equal(h.audit[0]!.outcome, "denied");
  assert.ok(h.audit[0]!.approvalId);
});

test("a granted approval lets the call through, and it snapshots first", async () => {
  const h = harness();
  const result = await h.executor.execute(
    request({
      tool: "bridgistic_toggle_plugin",
      args: {
        site: "shop",
        plugin: "w/w.php",
        state: "activate",
        approval_id: "approval-granted-1",
        idempotency_key: KEY,
      },
      caller: { ...request().caller, role: "admin", grantedApprovals: ["approval-granted-1"] },
    })
  );

  assert.equal(result.ok, true);
  assert.equal(h.snapshots, 1, "a destructive call ran without a snapshot");
  assert.equal(result.ok && result.snapshotId, "snap_1");
});

// ------------------------------------------------------------ idempotency --

test("a replayed key returns the first result without acting again", async () => {
  let called = 0;
  const h = harness({
    claim: async () => ({ kind: "replay", result: { original: true } }),
    transport: async () => {
      called++;
      return { ok: true, data: { second: true } };
    },
  });

  const result = await h.executor.execute(
    request({ tool: "bridgistic_create_post", args: { site: "shop", title: "x", idempotency_key: KEY } })
  );

  assert.equal(result.ok, true);
  assert.deepEqual(result.ok && result.data, { original: true });
  assert.equal(called, 0, "a replay performed the call a second time");
  assert.equal(result.ok && result.actionsConsumed, 0, "a replay was charged");
});

test("the same key with different arguments is a conflict, never a replay", async () => {
  // Returning the first call's result for the second call's arguments is worse
  // than either outcome the caller expected.
  const h = harness({ claim: async () => ({ kind: "conflict" }) });
  const result = await h.executor.execute(
    request({ tool: "bridgistic_create_post", args: { site: "shop", title: "different", idempotency_key: KEY } })
  );

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error, "idempotency_conflict");
  assert.equal(h.reserved.length, 0);
});

test("a concurrent attempt at the same key is refused, not queued", async () => {
  const h = harness({ claim: async () => ({ kind: "in_flight" }) });
  const result = await h.executor.execute(
    request({ tool: "bridgistic_create_post", args: { site: "shop", title: "x", idempotency_key: KEY } })
  );
  assert.equal(result.ok === false && result.error, "conflict");
});

test("the claim is taken before the site is called", async () => {
  const order: string[] = [];
  const h = harness({
    claim: async () => {
      order.push("claim");
      return { kind: "claimed" };
    },
    transport: async () => {
      order.push("call");
      return { ok: true, data: {} };
    },
  });

  await h.executor.execute(
    request({ tool: "bridgistic_create_post", args: { site: "shop", title: "x", idempotency_key: KEY } })
  );
  assert.deepEqual(order, ["claim", "call"], "the side effect happened before the claim");
});

// ------------------------------------------------------------- unwinding ---

test("a quota refusal releases nothing because nothing was taken", async () => {
  const h = harness({ admit: false });
  const result = await h.executor.execute(
    request({ tool: "bridgistic_create_post", args: { site: "shop", title: "x", idempotency_key: KEY } })
  );

  assert.equal(result.ok === false && result.error, "quota_exceeded");
  assert.equal(h.locksHeld.length, 0, "a quota-refused call took a lock");
  assert.deepEqual(h.claims, [{ key: KEY, state: "failed" }], "the claim was not settled");
});

test("a busy site releases the reservation before refusing", async () => {
  // Otherwise the quota is spent on a call that never happened.
  const h = harness({ lockAvailable: false });
  const result = await h.executor.execute(
    request({ tool: "bridgistic_create_post", args: { site: "shop", title: "x", idempotency_key: KEY } })
  );

  assert.equal(result.ok === false && result.error, "conflict");
  assert.deepEqual(h.releasedReservations, ["res_1"], "the reservation leaked");
  assert.deepEqual(h.settledReservations, []);
});

test("an unreachable site costs nothing", async () => {
  const h = harness({
    transport: async () => ({ ok: false, kind: "unreachable", message: "could not connect" }),
  });
  const result = await h.executor.execute(request());

  assert.equal(result.ok === false && result.error, "site_unreachable");
  assert.equal(result.ok === false && result.actionsConsumed, 0);
  assert.deepEqual(h.releasedReservations, ["res_1"], "an unreachable site was charged");
  assert.equal(h.locksReleased.length, 1, "the lock was not released");
});

test("a site that answered and failed is charged at the read rate", async () => {
  // Otherwise a broken loop is an unmetered one.
  const h = harness({
    transport: async () => ({ ok: false, kind: "site_error", message: "500 from site", status: 500 }),
  });
  const result = await h.executor.execute(request());

  assert.equal(result.ok === false && result.error, "site_error");
  assert.deepEqual(h.settledReservations, [{ id: "res_1", actual: 1, organizationId: "org_1" }]);
  assert.equal(h.audit[0]!.outcome, "failed");
});

test("a timeout is its own outcome, and releases everything", async () => {
  const h = harness({ transport: async () => ({ ok: false, kind: "timeout", message: "timed out" }) });
  const result = await h.executor.execute(request());

  assert.equal(result.ok === false && result.error, "timeout");
  assert.equal(h.audit[0]!.outcome, "timeout");
  assert.equal(h.locksReleased.length, 1);
});

test("a thrown transport releases the reservation rather than charging for it", async () => {
  // We do not know whether the site was reached, and charging for a call we
  // cannot account for is the wrong side to err on.
  const h = harness({
    transport: async () => {
      throw new Error("socket exploded");
    },
  });
  const result = await h.executor.execute(request());

  assert.equal(result.ok === false && result.error, "internal");
  assert.deepEqual(h.releasedReservations, ["res_1"], "a crashed call kept its quota");
  assert.deepEqual(h.settledReservations, []);
  assert.equal(h.locksReleased.length, 1, "a crashed call held its lock");
  // This request carries no idempotency key, so there is no claim to settle.
  // Asserted rather than assumed: settling a key that was never claimed would
  // write a row keyed on nothing.
  assert.deepEqual(h.claims, []);
});

test("a crash after the claim marks it failed so a retry is not blocked forever", async () => {
  // A claim left `pending` by a crashed handler is a key the caller can never
  // reuse — their retry is refused as in-flight against a call that will never
  // finish.
  const h = harness({
    transport: async () => {
      throw new Error("boom");
    },
  });
  await h.executor.execute(
    request({ tool: "bridgistic_create_post", args: { site: "shop", title: "x", idempotency_key: KEY } })
  );
  assert.deepEqual(h.claims, [{ key: KEY, state: "failed" }]);
});

test("the lock is released on every path out, including the throw", async () => {
  for (const transport of [
    async (): Promise<TransportResult> => ({ ok: true, data: {} }),
    async (): Promise<TransportResult> => ({ ok: false, kind: "site_error", message: "no" }),
    async (): Promise<TransportResult> => {
      throw new Error("boom");
    },
  ]) {
    const h = harness({ transport });
    await h.executor.execute(request());
    assert.equal(h.locksReleased.length, 1, "a lock was left held");
    assert.deepEqual(h.locksHeld, h.locksReleased);
  }
});

test("an internal error message says nothing about what went wrong inside", async () => {
  const h = harness({
    transport: async () => {
      throw new Error("connection to 10.0.0.5:3306 failed with password=hunter2");
    },
  });
  const result = await h.executor.execute(request());

  assert.equal(result.ok, false);
  const message = result.ok === false ? result.message : "";
  assert.ok(!message.includes("10.0.0.5"));
  assert.ok(!message.includes("hunter2"));
});

// ---------------------------------------------------------------- dry run --

test("a dry run changes nothing and costs nothing", async () => {
  const h = harness();
  const result = await h.executor.execute(
    request({
      tool: "bridgistic_create_post",
      args: { site: "shop", title: "x", dry_run: true, idempotency_key: KEY },
    })
  );

  assert.equal(result.ok, true);
  assert.equal(h.reserved.length, 0, "a dry run reserved quota");
  assert.equal(h.snapshots, 0, "a dry run took a snapshot");
  assert.equal(h.locksHeld.length, 0, "a dry run took a lock");
});

// ----------------------------------------------------- one security model --

test("the same call is decided identically whichever surface it came from", async () => {
  // The whole point of the executor. MCP, the API and the scheduler differ
  // only in actorType, and that must not change the answer.
  const results = [];
  for (const actorType of ["user", "api_key", "scheduler"] as const) {
    const h = harness();
    results.push(
      await h.executor.execute(
        request({
          tool: "bridgistic_toggle_plugin",
          args: { site: "shop", plugin: "w/w.php", state: "deactivate", idempotency_key: KEY },
          caller: { ...request().caller, role: "admin", actorType },
        })
      )
    );
  }

  const codes = results.map((r) => (r.ok === false ? r.error : "ok"));
  assert.deepEqual(codes, ["approval_required", "approval_required", "approval_required"]);
});

test("a machine token cannot reach a credential-class tool through any surface", async () => {
  const h = harness();
  const result = await h.executor.execute(
    request({
      tool: "bridgistic_create_user",
      args: { site: "shop", login: "x", email: "x@y.co", idempotency_key: KEY },
      caller: { ...request().caller, role: "admin", isMachineToken: true, actorType: "api_key" },
    })
  );

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error, "forbidden");
  assert.equal(h.reserved.length, 0);
});
