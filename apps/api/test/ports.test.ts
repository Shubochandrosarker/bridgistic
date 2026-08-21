/**
 * The executor's D1- and Durable-Object-backed ports, against real migrations.
 *
 * These are the adapters that turn the executor's decisions into rows and
 * reservations. The tests are about the cases where an adapter could quietly
 * do the wrong thing: lose an audit row, admit an unmetered call, take a plan
 * from the wrong place, or record an approval nobody can act on.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { D1AuditLog } from "../src/ports/audit.ts";
import { D1ApprovalStore, APPROVAL_TTL_MS } from "../src/ports/approvals.ts";
import { DurableMeteringStore } from "../src/ports/metering.ts";
import type { CounterNamespace } from "../src/ports/metering.ts";
import { adapt, migratedDatabase } from "./helpers/sqlite.ts";
import type { SqlDatabase } from "../src/db/scope.ts";
import type { AuditEntry } from "@bridgistic/executor";

const NOW = 1_800_000_000;

let db: DatabaseSync;
let sql: SqlDatabase;

beforeEach(() => {
  db = migratedDatabase();
  sql = adapt(db);
  db.exec(`
    INSERT INTO organizations (id,name,slug,wpistic_org_id,created_at,updated_at) VALUES
      ('org_1','Acme','acme',NULL,${NOW},${NOW}),
      ('org_free','Free','free',NULL,${NOW},${NOW}),
      ('org_lapsed','Lapsed','lapsed',NULL,${NOW},${NOW});
    INSERT INTO users (id,email,name,created_at,last_seen_at) VALUES
      ('usr_alice','alice@example.com','Alice',${NOW},NULL);
    INSERT INTO sites (id,organization_id,site_url,label,key_id,key_secret_enc,enc_key_version,key_scopes,health,plugin_version,created_at,last_seen_at) VALUES
      ('site_1','org_1','https://shop.example',NULL,'wpk_1','enc',1,'[]','healthy',NULL,${NOW},NULL);
    INSERT INTO subscriptions (id,organization_id,plan,billing_interval,status,api_addon,stripe_customer_id,stripe_subscription_id,trial_ends_at,current_period_start,current_period_end,created_at,updated_at) VALUES
      ('sub_1','org_1','agency','monthly','active',0,NULL,NULL,NULL,${NOW},${NOW + 2592000},${NOW},${NOW}),
      ('sub_lapsed','org_lapsed','agency','monthly','past_due',0,NULL,NULL,NULL,${NOW},${NOW + 2592000},${NOW},${NOW});
  `);
});

// ------------------------------------------------------------------ audit ---

const entry = (overrides: Partial<AuditEntry> = {}): AuditEntry => ({
  id: "act_1",
  organizationId: "org_1",
  siteId: "site_1",
  actorId: "usr_alice",
  actorType: "user",
  tool: "bridgistic_list_posts",
  requestDigest: "a".repeat(64),
  outcome: "success",
  durationMs: 12,
  actionsConsumed: 1,
  createdAt: NOW,
  ...overrides,
});

test("a denied call is recorded, not only a successful one", async () => {
  // A log of what worked cannot answer the question an incident asks.
  await new D1AuditLog(sql).record(entry({ outcome: "denied", errorClass: "scope_denied", actionsConsumed: 0 }));

  const row = db.prepare(`SELECT outcome, error_code, actions_consumed FROM action_log WHERE id='act_1'`).get() as Record<string, unknown>;
  assert.equal(row.outcome, "denied");
  assert.equal(row.error_code, "scope_denied");
  assert.equal(row.actions_consumed, 0);
});

test("every executor outcome and actor type satisfies the table's CHECKs", async () => {
  // A CHECK the executor can violate is a lost audit row at exactly the moment
  // one matters — a timeout on a destructive call.
  const outcomes = ["success", "denied", "failed", "timeout", "cancelled"] as const;
  const actors = ["user", "api_key", "service_account", "scheduler", "system"] as const;
  const log = new D1AuditLog(sql);

  let n = 0;
  for (const outcome of outcomes) {
    for (const actorType of actors) {
      await log.record(entry({ id: `act_${++n}`, outcome, actorType }));
    }
  }

  const count = db.prepare(`SELECT COUNT(*) AS c FROM action_log`).get() as { c: number };
  assert.equal(count.c, outcomes.length * actors.length);
});

test("a clock that stepped backwards does not cost us the row", async () => {
  // duration_ms and actions_consumed carry CHECK (>= 0). Aborting the insert
  // would lose the record of the call entirely, which is the worse outcome.
  await new D1AuditLog(sql).record(entry({ durationMs: -5, actionsConsumed: -1 }));
  const row = db.prepare(`SELECT duration_ms, actions_consumed FROM action_log WHERE id='act_1'`).get() as Record<string, number>;
  assert.equal(row.duration_ms, 0);
  assert.equal(row.actions_consumed, 0);
});

test("no argument can reach a row, only its digest", async () => {
  await new D1AuditLog(sql).record(entry({ tool: "bridgistic_db_query" }));
  const row = db.prepare(`SELECT * FROM action_log WHERE id='act_1'`).get() as Record<string, unknown>;

  // The whole row, serialised, must not contain anything argument-shaped. The
  // port has no parameter through which an argument could arrive, and this
  // asserts that stays true.
  const serialised = JSON.stringify(row);
  assert.ok(!serialised.includes("SELECT"), "a statement reached the audit row");
  assert.equal(row.request_digest, "a".repeat(64));
});

// -------------------------------------------------------------- approvals ---

const approvals = () =>
  new D1ApprovalStore({ db: sql, now: () => NOW, newId: () => "apr_1" });

test("an approval is pending, scoped and time-bounded when created", async () => {
  const id = await approvals().request({
    organizationId: "org_1",
    siteId: "site_1",
    actorId: "usr_alice",
    actorType: "user",
    tool: "bridgistic_db_query",
    scopeRequested: "db:write",
    requestHash: "b".repeat(64),
    summary: "bridgistic_db_query on site site_1",
  });

  assert.equal(id, "apr_1");
  const row = db.prepare(`SELECT * FROM approvals WHERE id='apr_1'`).get() as Record<string, unknown>;
  assert.equal(row.status, "pending");
  assert.equal(row.scope_requested, "db:write");
  assert.equal(row.decided_by, null);
  assert.equal(row.step_up_verified_at, null, "an approval must not be born step-up satisfied");
  assert.equal(row.expires_at, NOW + APPROVAL_TTL_MS);
});

test("an approval without a site is refused rather than recorded", async () => {
  // Every approval-gated class acts on a site. A row without one is something
  // a human could later click approve on, for a call nobody can place.
  await assert.rejects(
    () =>
      approvals().request({
        organizationId: "org_1",
        siteId: null,
        actorId: "usr_alice",
        actorType: "user",
        tool: "bridgistic_db_query",
        scopeRequested: "db:write",
        requestHash: "b".repeat(64),
        summary: "x",
      }),
    /requires a site/
  );
  const count = db.prepare(`SELECT COUNT(*) AS c FROM approvals`).get() as { c: number };
  assert.equal(count.c, 0);
});

test("every executor actor type maps onto the table's CHECK", async () => {
  // `service_account` and `system` do not exist in this table's vocabulary.
  // Passing them through unmapped would abort the insert and lose the gate.
  const actors = ["user", "api_key", "service_account", "scheduler", "system"] as const;
  let n = 0;
  for (const actorType of actors) {
    const store = new D1ApprovalStore({ db: sql, now: () => NOW, newId: () => `apr_${++n}` });
    await store.request({
      organizationId: "org_1",
      siteId: "site_1",
      actorId: "actor",
      actorType,
      tool: "bridgistic_db_query",
      scopeRequested: "db:write",
      requestHash: "b".repeat(64),
      summary: "s",
    });
  }
  const count = db.prepare(`SELECT COUNT(*) AS c FROM approvals`).get() as { c: number };
  assert.equal(count.c, actors.length);
});

// --------------------------------------------------------------- metering ---

interface Recorded {
  readonly organization: string;
  readonly path: string;
  readonly body: Record<string, unknown>;
}

function counters(reply: unknown, options: { throws?: boolean; status?: number } = {}) {
  const seen: Recorded[] = [];
  const namespace: CounterNamespace = {
    idFromName: (name) => name as unknown as DurableObjectId,
    get: (id) => ({
      async fetch(request: Request) {
        const url = new URL(request.url);
        seen.push({
          organization: String(id),
          path: url.pathname,
          body: (await request.json()) as Record<string, unknown>,
        });
        if (options.throws) throw new Error("the object is unavailable");
        return new Response(JSON.stringify(reply), {
          status: options.status ?? 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    }),
  };
  return { namespace, seen };
}

const admitted = { admitted: true, reservationId: "idem-1", verdict: { state: "ok" } };

test("the plan comes from the organization's own row, never from the call", async () => {
  // SECURITY_MODEL §9: a plan that arrived with the request is a limit the
  // caller chose.
  const { namespace, seen } = counters(admitted);
  const store = new DurableMeteringStore({ counters: namespace, db: sql, now: () => NOW });

  await store.reserve({ organizationId: "org_1", cost: 5, idempotencyKey: "idem-1" });
  assert.equal(seen[0]?.body.plan, "agency");
  assert.equal(seen[0]?.organization, "org_1");
});

test("no subscription, and a lapsed one, both meter as free", async () => {
  // Default deny reaches quota too: a missing record must not read as
  // "unmetered", and an unpaid account must not keep the limit it stopped
  // paying for.
  for (const [organizationId, expected] of [
    ["org_free", "free"],
    ["org_lapsed", "free"],
  ] as const) {
    const { namespace, seen } = counters(admitted);
    const store = new DurableMeteringStore({ counters: namespace, db: sql, now: () => NOW });
    await store.reserve({ organizationId, cost: 1, idempotencyKey: "k" });
    assert.equal(seen[0]?.body.plan, expected, `${organizationId} metered wrong`);
  }
});

test("an unreachable counter denies rather than admitting an unmetered call", async () => {
  // The failure mode to avoid is an outage that silently becomes free
  // unlimited execution.
  const { namespace } = counters(admitted, { throws: true });
  const store = new DurableMeteringStore({ counters: namespace, db: sql, now: () => NOW });

  const outcome = await store.reserve({ organizationId: "org_1", cost: 1, idempotencyKey: "k" });
  assert.equal(outcome.admitted, false);
});

test("a reply this adapter does not understand is a denial", async () => {
  for (const reply of [
    {},
    { admitted: true },
    { admitted: true, reservationId: "" },
    { admitted: "yes", reservationId: "x" },
    null,
  ]) {
    const { namespace } = counters(reply);
    const store = new DurableMeteringStore({ counters: namespace, db: sql, now: () => NOW });
    const outcome = await store.reserve({ organizationId: "org_1", cost: 1, idempotencyKey: "k" });
    assert.equal(outcome.admitted, false, `admitted on ${JSON.stringify(reply)}`);
  }
});

test("a quota rejection carries how long until it clears", async () => {
  const { namespace } = counters({
    admitted: false,
    reservationId: "",
    verdict: { state: "hard_limit", resetAt: NOW + 60_000 },
  });
  const store = new DurableMeteringStore({ counters: namespace, db: sql, now: () => NOW });

  const outcome = await store.reserve({ organizationId: "org_1", cost: 1, idempotencyKey: "k" });
  assert.equal(outcome.admitted, false);
  assert.equal(outcome.admitted === false && outcome.reason, "quota_exceeded");
  assert.equal(outcome.admitted === false && outcome.retryAfterMs, 60_000);

  // A reset already in the past is not reported as a negative wait.
  const late = new DurableMeteringStore({ counters: namespace, db: sql, now: () => NOW + 120_000 });
  const outcome2 = await late.reserve({ organizationId: "org_1", cost: 1, idempotencyKey: "k" });
  assert.equal(outcome2.admitted === false && outcome2.retryAfterMs, undefined);
});

test("settle and release reach the organization's own counter", async () => {
  const { namespace, seen } = counters({ consumed: 1 });
  const store = new DurableMeteringStore({ counters: namespace, db: sql, now: () => NOW });

  await store.settle({ organizationId: "org_1", reservationId: "idem-1", actual: 3 });
  await store.release({ organizationId: "org_free", reservationId: "idem-2" });

  assert.deepEqual(
    seen.map((s) => [s.organization, s.path]),
    [
      ["org_1", "/settle"],
      ["org_free", "/release"],
    ]
  );
  assert.equal(seen[0]?.body.actual, 3);
});

test("a settle that cannot be delivered does not throw into the executor", async () => {
  // The executor calls settle in a finally. Throwing there would replace the
  // real outcome with a metering error; the reservation expires on the
  // counter's own alarm regardless, so the quota comes back either way.
  const { namespace } = counters({}, { throws: true });
  const store = new DurableMeteringStore({ counters: namespace, db: sql, now: () => NOW });

  await store.settle({ organizationId: "org_1", reservationId: "idem-1", actual: 1 });
  await store.release({ organizationId: "org_1", reservationId: "idem-1" });
});
