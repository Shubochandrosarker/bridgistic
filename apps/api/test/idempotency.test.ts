/**
 * Idempotency, against real SQLite.
 *
 * The property being proven is narrow and important: two attempts at the same
 * key never both get `claimed`. Everything else follows from that, and nothing
 * substitutes for it — a store that is merely usually correct produces
 * duplicate charges, duplicate posts and duplicate emails, rarely, under load,
 * where they are hardest to reproduce.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { D1IdempotencyStore, CLAIM_TTL_MS } from "../src/db/idempotency.ts";
import type { SqlDatabase } from "../src/db/scope.ts";
import { adapt, migratedDatabase } from "./helpers/sqlite.ts";

const NOW = 1_800_000_000_000;

let db: DatabaseSync;
let sql: SqlDatabase;
let clock: { now: number };

beforeEach(() => {
  db = migratedDatabase();
  db.exec(`
    INSERT INTO organizations (id,name,slug,wpistic_org_id,created_at,updated_at)
    VALUES ('org_1','Acme','acme',NULL,1,1);
  `);
  sql = adapt(db);
  clock = { now: NOW };
});

const store = () => new D1IdempotencyStore(sql, () => clock.now);

const claimInput = (overrides: Partial<Parameters<D1IdempotencyStore["claim"]>[0]> = {}) => ({
  key: "idem-key-1",
  requestHash: "hash-a",
  organizationId: "org_1",
  siteId: null,
  actorId: "usr_1",
  tool: "bridgistic_create_post",
  createdAt: NOW,
  ...overrides,
});

// ------------------------------------------------------------ the property --

test("the first claim wins and the second is in flight", async () => {
  const s = store();
  assert.deepEqual(await s.claim(claimInput()), { kind: "claimed" });
  assert.deepEqual(await s.claim(claimInput()), { kind: "in_flight" });
});

test("N concurrent attempts at one key produce exactly one claim", async () => {
  // The failure this prevents needs two requests landing within a few
  // milliseconds, which is why it survives testing and then happens in
  // production. Run it a hundred times at once.
  const s = store();
  const outcomes = await Promise.all(Array.from({ length: 100 }, () => s.claim(claimInput())));
  const claimed = outcomes.filter((o) => o.kind === "claimed");

  assert.equal(claimed.length, 1, `${claimed.length} callers were told to proceed`);
  assert.equal(outcomes.filter((o) => o.kind === "in_flight").length, 99);
});

test("across separate store instances, still exactly one claim", async () => {
  // Two Workers, two store objects, one database. The guarantee has to come
  // from the database, not from anything held in a process.
  const outcomes = await Promise.all(
    Array.from({ length: 20 }, () => new D1IdempotencyStore(sql, () => clock.now).claim(claimInput()))
  );
  assert.equal(outcomes.filter((o) => o.kind === "claimed").length, 1);
});

// ---------------------------------------------------------------- replay ----

test("a succeeded claim replays its result rather than acting again", async () => {
  const s = store();
  await s.claim(claimInput());
  await s.settle("idem-key-1", "succeeded", { postId: 42 });

  const outcome = await s.claim(claimInput());
  assert.equal(outcome.kind, "replay");
  assert.deepEqual(outcome.kind === "replay" && outcome.result, { postId: 42 });
});

test("a failed claim may be retried", async () => {
  // The request did not take effect. Refusing forever strands the caller on a
  // key they can neither reuse nor replace.
  const s = store();
  await s.claim(claimInput());
  await s.settle("idem-key-1", "failed");

  assert.deepEqual(await s.claim(claimInput()), { kind: "claimed" });
});

test("a stored result that will not parse is treated as absent, not as a crash", async () => {
  const s = store();
  await s.claim(claimInput());
  db.prepare(`UPDATE idempotency_claims SET state='succeeded', result_json='{ not json' WHERE key=?`).run(
    "idem-key-1"
  );

  const outcome = await s.claim(claimInput());
  assert.equal(outcome.kind, "replay");
  assert.equal(outcome.kind === "replay" && outcome.result, null);
});

// -------------------------------------------------------------- conflict ----

test("the same key with different arguments is a conflict, whatever the first call did", async () => {
  // Checked before state, so a succeeded call cannot replay its result to a
  // caller who sent different arguments.
  for (const settleAs of ["succeeded", "failed", null] as const) {
    db.exec("DELETE FROM idempotency_claims");
    const s = store();
    await s.claim(claimInput({ requestHash: "hash-a" }));
    if (settleAs) await s.settle("idem-key-1", settleAs, { first: true });

    const outcome = await s.claim(claimInput({ requestHash: "hash-b" }));
    assert.equal(outcome.kind, "conflict", `after ${settleAs ?? "pending"}, a different request was not a conflict`);
  }
});

// ------------------------------------------------------------- expiry -------

test("a claim left pending by a crash can be retaken once it expires", async () => {
  const s = store();
  await s.claim(claimInput());
  assert.deepEqual(await s.claim(claimInput()), { kind: "in_flight" });

  clock.now = NOW + CLAIM_TTL_MS + 1;
  assert.deepEqual(await s.claim(claimInput()), { kind: "claimed" }, "the key was blocked forever");
});

test("a claim is not retaken while its call could still be running", async () => {
  const s = store();
  await s.claim(claimInput());

  clock.now = NOW + CLAIM_TTL_MS - 1;
  assert.deepEqual(await s.claim(claimInput()), { kind: "in_flight" });
});

test("the sweeper expires abandoned claims and reports how many", async () => {
  const s = store();
  await s.claim(claimInput({ key: "k1" }));
  await s.claim(claimInput({ key: "k2" }));
  await s.claim(claimInput({ key: "k3" }));
  await s.settle("k3", "succeeded", {});

  clock.now = NOW + CLAIM_TTL_MS + 1;
  assert.equal(await s.sweep(), 2, "a settled claim was swept, or an abandoned one was missed");

  // Mapped to plain objects: node:sqlite returns null-prototype rows, and
  // assert.deepEqual compares prototypes.
  const states = (db.prepare(`SELECT key, state FROM idempotency_claims ORDER BY key`).all() as {
    key: string;
    state: string;
  }[]).map((row) => ({ key: row.key, state: row.state }));
  assert.deepEqual(states, [
    { key: "k1", state: "expired" },
    { key: "k2", state: "expired" },
    { key: "k3", state: "succeeded" },
  ]);
});

test("a settle arriving after expiry does not resurrect the claim", async () => {
  // The caller has already been told the call failed. Two answers must not
  // diverge, so a late settle is dropped rather than applied.
  const s = store();
  await s.claim(claimInput());
  clock.now = NOW + CLAIM_TTL_MS + 1;
  await s.sweep();

  await s.settle("idem-key-1", "succeeded", { late: true });

  const row = db.prepare(`SELECT state, result_json FROM idempotency_claims WHERE key = ?`).get("idem-key-1") as {
    state: string;
    result_json: string | null;
  };
  assert.equal(row.state, "expired");
  assert.equal(row.result_json, null);
});

test("settling a key that was never claimed writes nothing", async () => {
  const s = store();
  await s.settle("never-claimed", "succeeded", { x: 1 });
  const row = db.prepare(`SELECT COUNT(*) AS n FROM idempotency_claims`).get() as { n: number };
  assert.equal(row.n, 0);
});

// ------------------------------------------------------------- isolation ----

test("keys are per-organization rows and carry their owner", async () => {
  // Two organizations using the same key string is not a collision to resolve
  // by luck — it must be visible in the row who owns it, so an incident review
  // can answer "whose call was this".
  const s = store();
  await s.claim(claimInput({ key: "shared-key", organizationId: "org_1", actorId: "usr_1" }));

  const row = db
    .prepare(`SELECT organization_id, actor_id, tool FROM idempotency_claims WHERE key = ?`)
    .get("shared-key") as { organization_id: string; actor_id: string; tool: string };
  assert.equal(row.organization_id, "org_1");
  assert.equal(row.actor_id, "usr_1");
  assert.equal(row.tool, "bridgistic_create_post");
});

// -------------------------------------------------- the audit vocabulary ----

test("action_log accepts every outcome and actor type the executor writes", async () => {
  // These CHECK constraints and the executor's vocabularies had drifted apart.
  // A timed-out call, or one from a service account, would have failed to
  // write its audit row — losing the entry for exactly the calls most worth
  // auditing, as a constraint error in production.
  db.exec(`
    INSERT INTO users (id,email,name,created_at,last_seen_at) VALUES ('usr_1','a@b.co','A',1,NULL);
  `);
  const outcomes = ["success", "failed", "denied", "pending_approval", "rate_limited", "timeout", "cancelled"];
  const actors = ["user", "api_key", "mcp_session", "service_account", "scheduler", "system"];

  let n = 0;
  for (const outcome of outcomes) {
    for (const actorType of actors) {
      db.prepare(
        `INSERT INTO action_log (id,organization_id,site_id,actor_type,actor_id,tool,request_digest,outcome,duration_ms,actions_consumed,created_at)
         VALUES (?,?,NULL,?,?,?,?,?,?,?,?)`
      ).run(`act_${n++}`, "org_1", actorType, "usr_1", "bridgistic_list_posts", "deadbeef", outcome, 5, 1, NOW);
    }
  }
  const row = db.prepare(`SELECT COUNT(*) AS n FROM action_log`).get() as { n: number };
  assert.equal(row.n, outcomes.length * actors.length);
});

test("action_log still refuses a value outside the vocabulary", async () => {
  // Widening the CHECK must not have removed it.
  db.exec(`INSERT INTO users (id,email,name,created_at,last_seen_at) VALUES ('usr_2','c@d.co','C',1,NULL);`);
  assert.throws(() =>
    db
      .prepare(
        `INSERT INTO action_log (id,organization_id,site_id,actor_type,actor_id,tool,request_digest,outcome,duration_ms,actions_consumed,created_at)
         VALUES (?,?,NULL,?,?,?,?,?,?,?,?)`
      )
      .run("act_bad", "org_1", "user", "usr_2", "t", "d", "probably", 5, 1, NOW)
  );
  assert.throws(() =>
    db
      .prepare(
        `INSERT INTO action_log (id,organization_id,site_id,actor_type,actor_id,tool,request_digest,outcome,duration_ms,actions_consumed,created_at)
         VALUES (?,?,NULL,?,?,?,?,?,?,?,?)`
      )
      .run("act_bad2", "org_1", "robot", "usr_2", "t", "d", "success", 5, 1, NOW)
  );
});
