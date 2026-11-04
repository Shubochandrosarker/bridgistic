/**
 * The executor against the real adapters, not fakes.
 *
 * `packages/executor/test` proves the pipeline's logic with in-memory ports.
 * That is the right test for the ordering and the failure handling, and it
 * cannot catch an adapter that disagrees with the schema, or a race that only
 * exists because two callers share a database. These are the Phase 3
 * acceptance criteria run through D1 (real SQLite, real migrations), the real
 * signed transport, and the real idempotency, metering, snapshot, lock, audit
 * and approval stores.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createExecutor } from "../src/ports/index.ts";
import { adapt, migratedDatabase } from "./helpers/sqlite.ts";
import { encryptSecret } from "@bridgistic/crypto";
import { Logger } from "@bridgistic/observability";
import type { SqlDatabase } from "../src/db/scope.ts";
import type { CounterNamespace } from "../src/ports/metering.ts";
import { periodFor } from "../src/usage-counter.ts";

const NOW = 1_800_000_000_000;
const ENC_KEY = btoa("bridgistic-test-key-never-real!!");

let db: DatabaseSync;
let sql: SqlDatabase;

beforeEach(async () => {
  db = migratedDatabase();
  sql = adapt(db);
  const seconds = Math.floor(NOW / 1000);
  db.exec(`
    INSERT INTO organizations (id,name,slug,wpistic_org_id,created_at,updated_at)
      VALUES ('org_1','Acme','acme',NULL,${seconds},${seconds});
    INSERT INTO users (id,email,name,created_at,last_seen_at)
      VALUES ('usr_alice','alice@example.com','Alice',${seconds},NULL);
    INSERT INTO memberships (organization_id,user_id,role,created_at)
      VALUES ('org_1','usr_alice','owner',${seconds});
    INSERT INTO sites (id,organization_id,site_url,label,key_id,key_secret_enc,enc_key_version,key_scopes,health,plugin_version,created_at,last_seen_at)
      VALUES ('site_1','org_1','https://shop.example',NULL,'wpk_1','x',1,'["posts:read","posts:write","plugins:manage","options:write"]','healthy',NULL,${seconds},NULL);
    INSERT INTO subscriptions (id,organization_id,plan,billing_interval,status,api_addon,stripe_customer_id,stripe_subscription_id,trial_ends_at,current_period_start,current_period_end,created_at,updated_at)
      VALUES ('sub_1','org_1','agency','monthly','active',0,NULL,NULL,NULL,${seconds},${seconds + 2592000},${seconds},${seconds});
  `);
  const sealed = await encryptSecret("wpk_secret_value", ENC_KEY);
  db.prepare(
    `INSERT INTO site_credentials (site_id,version,key_id,key_secret_enc,enc_key_version,created_at,retired_at)
     VALUES ('site_1',1,'wpk_1',?,1,?,NULL)`
  ).run(sealed, seconds);
});

/**
 * An in-memory stand-in for the UsageCounter Durable Object.
 *
 * Not the real object — a Durable Object needs a runtime this test does not
 * have — but it serialises per organization the same way, which is the
 * property the metering port depends on.
 */
function counters() {
  const consumed = new Map<string, number>();
  const pending = new Map<string, number>();
  const namespace: CounterNamespace = {
    idFromName: (name) => name as unknown as DurableObjectId,
    get: (id) => ({
      async fetch(request: Request) {
        const org = String(id);
        const path = new URL(request.url).pathname;
        const body = (await request.json()) as Record<string, unknown>;
        if (path === "/reserve") {
          pending.set(`${org}:${body.idempotencyKey}`, Number(body.cost));
          return json({ admitted: true, reservationId: String(body.idempotencyKey), verdict: { state: "ok" } });
        }
        const key = `${org}:${body.reservationId}`;
        if (pending.delete(key)) {
          consumed.set(org, (consumed.get(org) ?? 0) + Number(body.actual ?? 0));
        }
        return json({ consumed: consumed.get(org) ?? 0 });
      },
    }),
  };
  return { namespace, consumed, pending };
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } });

const siteOk = (data: unknown = {}) =>
  async () => json({ ok: true, data });

function executor(fetchImpl: typeof fetch, counterNamespace: CounterNamespace) {
  return createExecutor({
    db: sql,
    counters: counterNamespace,
    encryptionKey: ENC_KEY,
    fetchImpl,
    now: () => NOW,
    // Quiet: the pipeline logs, and a passing test should not print.
    logger: new Logger({ sink: () => undefined }),
  });
}

const caller = (overrides: Record<string, unknown> = {}) => ({
  organizationId: "org_1",
  actorId: "usr_alice",
  isMachineToken: false,
  plan: "agency" as const,
  planScopes: ["site:read", "posts:read", "posts:write", "plugins:manage", "options:write"],
  siteScopes: ["site:read", "posts:read", "posts:write", "plugins:manage", "options:write"],
  keyScopes: ["posts:read", "posts:write", "plugins:manage", "options:write"],
  stepUpSatisfied: true,
  role: "owner" as const,
  actorType: "user" as const,
  ...overrides,
});

// --------------------------------------------- acceptance: approval gate ---

test("a destructive call without approval is refused, and nothing reaches the site", async () => {
  // Phase 3 acceptance. Through the real approval store, so the refusal also
  // has to produce a row a human can act on.
  const { namespace } = counters();
  let siteCalls = 0;

  const result = await executor(async () => {
    siteCalls++;
    return json({ ok: true, data: {} });
  }, namespace).execute({
    tool: "bridgistic_toggle_plugin",
    args: { site: "shop", plugin: "w/w.php", state: "activate", idempotency_key: "k".repeat(20) },
    caller: caller(),
    siteId: "site_1",
    requestId: "req_1",
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error, "approval_required");
  assert.equal(siteCalls, 0, "a destructive call reached the site with no approval");

  // The gate created something to approve, rather than telling the caller to
  // go and find one.
  const approval = db.prepare(`SELECT * FROM approvals`).get() as Record<string, unknown>;
  assert.ok(approval, "no approval was created");
  assert.equal(approval.status, "pending");
  assert.equal(approval.organization_id, "org_1");
  assert.equal(approval.step_up_verified_at, null);

  // And it is in the audit log as denied, with a digest and no arguments.
  const logged = db.prepare(`SELECT * FROM action_log`).get() as Record<string, unknown>;
  assert.equal(logged.outcome, "pending_approval");
  assert.ok(!JSON.stringify(logged).includes("w/w.php"), "an argument reached the audit row");
});

test("a safe read runs, is metered once, and is audited", async () => {
  const { namespace, consumed } = counters();
  const result = await executor(siteOk({ posts: [] }) as unknown as typeof fetch, namespace).execute({
    tool: "bridgistic_list_posts",
    args: { site: "shop" },
    caller: caller(),
    siteId: "site_1",
    requestId: "req_2",
  });

  assert.equal(result.ok, true, result.ok === false ? result.message : "");
  assert.equal(consumed.get(`org_1:${periodFor(NOW)}`), 1);

  const logged = db.prepare(`SELECT outcome, actions_consumed FROM action_log`).get() as Record<string, unknown>;
  assert.equal(logged.outcome, "success");
});

// ------------------------------------ acceptance: duplicate under retry ----

test("a repeated key replays the first result instead of acting again", async () => {
  // Phase 3 acceptance, and the reason the claim exists. This runs the retry
  // SEQUENTIALLY on purpose: concurrently, the per-site lock also serialises
  // the attempts, so a concurrent test cannot tell whether the claim or the
  // lock did the work. A retry arriving after the first call finished meets a
  // free lock, so only the claim can stop it.
  const { namespace } = counters();
  let siteCalls = 0;
  const exec = executor(async () => {
    siteCalls++;
    return json({ ok: true, data: { id: siteCalls } });
  }, namespace);

  const attempt = () =>
    exec.execute({
      tool: "bridgistic_create_post",
      args: { site: "shop", title: "Hello", idempotency_key: "idem-".padEnd(24, "x") },
      caller: caller(),
      siteId: "site_1",
      requestId: "req_3",
    });

  const first = await attempt();
  const second = await attempt();

  assert.equal(first.ok, true, first.ok === false ? first.message : "");
  assert.equal(siteCalls, 1, `the site was mutated ${siteCalls} times for one key`);

  // The replay returns what the first call returned, rather than an error: a
  // retry of a call that already happened is the client doing the right thing.
  assert.equal(second.ok, true);
  assert.deepEqual(second.ok && second.data, first.ok && first.data);

  const claims = db.prepare(`SELECT key, state FROM idempotency_claims`).all() as { state: string }[];
  assert.equal(claims.length, 1, "one key produced more than one claim");
  assert.equal(claims[0]?.state, "succeeded");
});

test("twenty simultaneous attempts on one key mutate the site once", async () => {
  // The concurrent case. Two controls stand between these attempts and a
  // double mutation — the claim and the per-site lock — and this asserts the
  // outcome they exist to produce rather than which of them produced it. The
  // test above isolates the claim; this one is here because the outcome is
  // what a customer experiences, and it must hold under real overlap.
  const { namespace } = counters();
  let siteCalls = 0;
  const exec = executor(async () => {
    siteCalls++;
    // Yield, so the attempts genuinely overlap rather than each running to
    // completion before the next begins.
    await new Promise((resolve) => setTimeout(resolve, 1));
    return json({ ok: true, data: { id: 1 } });
  }, namespace);

  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      exec.execute({
        tool: "bridgistic_create_post",
        args: { site: "shop", title: "Hello", idempotency_key: "burst".padEnd(24, "z") },
        caller: caller(),
        siteId: "site_1",
        requestId: "req_burst",
      })
    )
  );

  assert.equal(siteCalls, 1, `the site was mutated ${siteCalls} times for one key`);
  assert.ok(results.some((r) => r.ok), "every attempt failed");
});

// ------------------------------------- acceptance: reservation released ----

test("a call that never reaches the site releases its reservation", async () => {
  // Phase 3 acceptance: a killed call must not burn quota. Here the site is
  // unreachable, which the transport reports as `unreachable` — the outcome
  // the executor releases rather than charges.
  const { namespace, consumed, pending } = counters();

  const result = await executor(async () => {
    throw new TypeError("fetch failed");
  }, namespace).execute({
    tool: "bridgistic_list_posts",
    args: { site: "shop" },
    caller: caller(),
    siteId: "site_1",
    requestId: "req_4",
  });

  assert.equal(result.ok, false);
  assert.equal(consumed.get(`org_1:${periodFor(NOW)}`) ?? 0, 0, "an unreachable site was billed for");
  assert.equal(pending.size, 0, "the reservation was left hanging");
});

// ------------------------------------------------------ locks and scopes ---

test("a scope the site's key does not carry is refused before anything is spent", async () => {
  // BR-010: a grant wider than the key the plugin minted authorises a call the
  // site will reject. Refused here, so it costs nothing.
  const { namespace, consumed } = counters();
  let siteCalls = 0;

  const result = await executor(async () => {
    siteCalls++;
    return json({ ok: true, data: {} });
  }, namespace).execute({
    tool: "bridgistic_list_posts",
    args: { site: "shop" },
    caller: caller({ siteScopes: ["site:read"], keyScopes: ["site:read"] }),
    siteId: "site_1",
    requestId: "req_5",
  });

  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.error, "scope_denied");
  assert.equal(siteCalls, 0);
  assert.equal(consumed.get(`org_1:${periodFor(NOW)}`) ?? 0, 0);
});

test("the site lock is released, so a second call is not blocked by the first", async () => {
  // A lock leaked by a finished call blocks a site until its TTL expires,
  // which is the kind of failure that looks like "the site is down".
  const { namespace } = counters();
  const exec = executor(siteOk() as unknown as typeof fetch, namespace);

  for (const requestId of ["req_a", "req_b"]) {
    const result = await exec.execute({
      tool: "bridgistic_create_post",
      args: { site: "shop", title: "x", idempotency_key: `${requestId}`.padEnd(24, "y") },
      caller: caller(),
      siteId: "site_1",
      requestId,
    });
    assert.equal(result.ok, true, `${requestId}: ${result.ok === false ? result.message : ""}`);
  }

  const locks = db.prepare(`SELECT COUNT(*) AS c FROM execution_locks`).get() as { c: number };
  assert.equal(locks.c, 0, "a finished call left its lock behind");
});
