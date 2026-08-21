/**
 * The snapshot store.
 *
 * Every test here is about a refusal. The store's job is to make a gated call
 * either genuinely reversible or not happen, so the cases that matter are the
 * ones where it cannot deliver a rollback path and has to say so rather than
 * return an id.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { PluginSnapshotStore, SNAPSHOT_TTL_MS } from "../src/ports/snapshots.ts";
import { adapt, migratedDatabase } from "./helpers/sqlite.ts";
import { snapshotTargetFor, isUnavailable } from "@bridgistic/tools";
import { allContracts } from "@bridgistic/contracts";
import type { SqlDatabase } from "../src/db/scope.ts";
import type { Transport, TransportRequest, TransportResult } from "@bridgistic/executor";

const NOW = 1_800_000_000_000;

let db: DatabaseSync;
let sql: SqlDatabase;

beforeEach(() => {
  db = migratedDatabase();
  sql = adapt(db);
  db.exec(`
    INSERT INTO organizations (id,name,slug,wpistic_org_id,created_at,updated_at)
      VALUES ('org_1','Acme','acme',NULL,1800000000,1800000000);
    INSERT INTO sites (id,organization_id,site_url,label,key_id,key_secret_enc,enc_key_version,key_scopes,health,plugin_version,created_at,last_seen_at)
      VALUES ('site_1','org_1','https://shop.example',NULL,'wpk_1','enc',1,'[]','healthy',NULL,1800000000,NULL);
  `);
});

function store(reply: TransportResult, seen?: TransportRequest[]) {
  const transport: Transport = {
    async call(request) {
      seen?.push(request);
      return reply;
    },
  };
  return new PluginSnapshotStore({
    db: sql,
    transport,
    now: () => NOW,
    newId: () => "snp_1",
  });
}

const took = (data: unknown): TransportResult => ({ ok: true, data });

const input = (overrides: Partial<Parameters<PluginSnapshotStore["create"]>[0]> = {}) => ({
  organizationId: "org_1",
  siteId: "site_1",
  tool: "bridgistic_update_option",
  args: { name: "blogname", value: "New" },
  reason: "operational operation",
  ...overrides,
});

// ---------------------------------------------------------------- taking ---

test("a snapshot is taken on the site and recorded against the organization", async () => {
  const seen: TransportRequest[] = [];
  const result = await store(took({ snapshot_id: "snap_abc", byte_size: 1234 }), seen).create(input());

  assert.equal(result.ok, true);
  assert.equal(result.ok && result.id, "snp_1");

  // The capture is targeted at the option the call is about to change.
  assert.equal(seen[0]?.args.type, "option");
  assert.deepEqual(seen[0]?.args.target, { name: "blogname" });

  const row = db.prepare(`SELECT * FROM snapshots WHERE id='snp_1'`).get() as Record<string, unknown>;
  assert.equal(row.remote_id, "snap_abc", "the plugin's id is what a restore needs");
  assert.equal(row.organization_id, "org_1");
  assert.equal(row.size_bytes, 1234);
  assert.equal(row.expires_at, NOW + SNAPSHOT_TTL_MS);
  assert.equal(row.restored_at, null);
});

test("the label names the call, not its arguments", async () => {
  // The label is shown in WordPress admin. Arguments can carry customer data.
  const seen: TransportRequest[] = [];
  await store(took({ snapshot_id: "snap_abc" }), seen).create(
    input({ tool: "bridgistic_fs_write", args: { path: "/wp-content/x.txt", content: "SECRET-VALUE" } })
  );

  assert.equal(seen[0]?.args.label, "Bridgistic: before bridgistic_fs_write");
  assert.ok(!JSON.stringify(seen[0]?.args).includes("SECRET-VALUE"), "an argument reached the label");
});

// -------------------------------------------------------------- refusing ---

test("a tool with no constructible target is refused, with the reason", async () => {
  // Arbitrary PHP can change anything, and the plugin has no whole-site
  // capture. There is no honest snapshot to take.
  const result = await store(took({ snapshot_id: "snap_abc" })).create(
    input({ tool: "bridgistic_execute_php", args: { code: "echo 1;" } })
  );

  assert.equal(result.ok, false);
  assert.match(result.ok === false ? result.reason : "", /no bounded target/);

  const count = db.prepare(`SELECT COUNT(*) AS c FROM snapshots`).get() as { c: number };
  assert.equal(count.c, 0, "a row was written for a snapshot that was never taken");
});

test("a site that cannot take the snapshot refuses the call it guards", async () => {
  for (const failure of [
    { ok: false as const, kind: "site_error" as const, message: "disk full" },
    { ok: false as const, kind: "unreachable" as const, message: "no route" },
    { ok: false as const, kind: "timeout" as const, message: "too slow" },
  ]) {
    const result = await store(failure).create(input());
    assert.equal(result.ok, false, `${failure.kind} was treated as a snapshot`);
  }
});

test("a site that answers without an id is not treated as having snapshotted", async () => {
  // The plugin returning 200 and no snapshot_id would otherwise produce a row
  // whose remote_id is undefined — a rollback path that resolves to nothing.
  for (const data of [{}, { snapshot_id: "" }, { snapshot_id: 7 }, null, "ok", { snapshot_id: "x".repeat(200) }]) {
    const result = await store(took(data)).create(input());
    assert.equal(result.ok, false, `${JSON.stringify(data)} was accepted as a snapshot`);
  }
  const count = db.prepare(`SELECT COUNT(*) AS c FROM snapshots`).get() as { c: number };
  assert.equal(count.c, 0);
});

test("a missing identifier is refused rather than snapshotting the wrong record", async () => {
  // Snapshotting post 0, or the whole options table, in place of the record
  // actually being changed is worse than refusing: the gate would report a
  // rollback that restores something else.
  for (const args of [{}, { id: "not-a-number" }, { id: 0 }, { id: -1 }, { id: 1.5 }]) {
    const result = await store(took({ snapshot_id: "snap_abc" })).create(
      input({ tool: "bridgistic_update_user", args })
    );
    assert.equal(result.ok, false, `${JSON.stringify(args)} was accepted`);
  }
});

// ------------------------------------------------------------ completeness -

test("every tool that requires a snapshot has a decision recorded for it", async () => {
  // The failure this prevents is a tool joining the snapshot-requiring set
  // without anybody deciding what it captures. The store refuses an unknown
  // tool, so the consequence would be a tool that can never run — findable
  // here rather than by a customer.
  const undecided = allContracts()
    .filter((c) => c.requiresSnapshot)
    .filter((c) => snapshotTargetFor(c.name, { id: 1, name: "n", path: "/p" }) === undefined);

  assert.deepEqual(undecided.map((c) => c.name), [], "tools requiring a snapshot with no target decision");
});

test("no tool that needs no snapshot has a target defined for it", async () => {
  // The reverse drift: a target left behind after a tool's class changed would
  // be dead code that looks like a live safety control.
  const stray = allContracts()
    .filter((c) => !c.requiresSnapshot)
    .filter((c) => snapshotTargetFor(c.name, { id: 1, name: "n", path: "/p" }) !== undefined);

  assert.deepEqual(stray.map((c) => c.name), []);
});

test("a refusal reason never carries an argument value", async () => {
  const result = await store(took({ snapshot_id: "s" })).create(
    input({ tool: "bridgistic_execute_php", args: { code: "$secret = 'hunter2';" } })
  );
  assert.ok(result.ok === false && !result.reason.includes("hunter2"));
});
