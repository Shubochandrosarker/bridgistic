/**
 * Tenant isolation, against a real database with the real migrations.
 *
 * A mock would prove that the mock filters. These tests build two
 * organizations with real rows and try to reach across, which is the thing
 * that must never work.
 *
 * `node:sqlite` runs the same SQL D1 does, so a query that passes here is a
 * query D1 will execute the same way.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { OrgScope, membershipsForUser } from "../src/db/scope.ts";
import type { SqlDatabase, SqlStatement, Caller } from "../src/db/scope.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

/** A D1-shaped adapter over node:sqlite, so production code runs unchanged. */
function adapt(db: DatabaseSync): SqlDatabase {
  return {
    prepare(sql: string): SqlStatement {
      let bound: unknown[] = [];
      const statement: SqlStatement = {
        bind(...values: unknown[]) {
          bound = values;
          return statement;
        },
        async first<T>() {
          return (db.prepare(sql).get(...(bound as never[])) as T) ?? null;
        },
        async all<T>() {
          return { results: db.prepare(sql).all(...(bound as never[])) as T[] };
        },
        async run() {
          return db.prepare(sql).run(...(bound as never[]));
        },
      };
      return statement;
    },
  };
}

let db: DatabaseSync;
let sql: SqlDatabase;

const NOW = 1_800_000_000;

before(() => {
  db = new DatabaseSync(":memory:");
  const dir = join(root, "db", "migrations");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(dir, file), "utf8"));
  }
  sql = adapt(db);

  // Two organizations, each with a site, a member, and grants. Alice is in
  // acme; Mallory is in evil. Neither should ever see the other's rows.
  db.exec(`
    INSERT INTO organizations (id,name,slug,wpistic_org_id,created_at,updated_at) VALUES
      ('org_acme','Acme','acme',NULL,${NOW},${NOW}),
      ('org_evil','Evil','evil',NULL,${NOW},${NOW});

    INSERT INTO users (id,email,name,created_at,last_seen_at) VALUES
      ('usr_alice','alice@example.com','Alice',${NOW},NULL),
      ('usr_mallory','mallory@example.com','Mallory',${NOW},NULL),
      ('usr_bob','bob@example.com','Bob',${NOW},NULL);

    INSERT INTO memberships (organization_id,user_id,role,created_at) VALUES
      ('org_acme','usr_alice','owner',${NOW}),
      ('org_acme','usr_bob','viewer',${NOW}),
      ('org_evil','usr_mallory','owner',${NOW});

    INSERT INTO sites (id,organization_id,site_url,label,key_id,key_secret_enc,enc_key_version,key_scopes,health,plugin_version,created_at,last_seen_at) VALUES
      ('site_acme','org_acme','https://acme.example','Acme','wpk_1','enc',1,'["site:read","posts:read","posts:write"]','healthy',NULL,${NOW},NULL),
      ('site_acme2','org_acme','https://acme2.example',NULL,'wpk_3','enc',1,'["site:read"]','healthy',NULL,${NOW},NULL),
      ('site_evil','org_evil','https://evil.example','Evil','wpk_2','enc',1,'["site:read","php:execute"]','healthy',NULL,${NOW},NULL);

    INSERT INTO site_scope_grants (site_id,scope,granted_by,granted_at,last_used_at) VALUES
      ('site_acme','site:read','usr_alice',${NOW},NULL),
      ('site_acme','posts:read','usr_alice',${NOW},NULL),
      -- Granted but NOT in the key's ceiling, so it must not be effective.
      ('site_acme','php:execute','usr_alice',${NOW},NULL),
      ('site_evil','php:execute','usr_mallory',${NOW},NULL);

    INSERT INTO subscriptions (id,organization_id,plan,billing_interval,status,api_addon,stripe_customer_id,stripe_subscription_id,trial_ends_at,current_period_start,current_period_end,created_at,updated_at) VALUES
      ('sub_acme','org_acme','agency','monthly','active',0,NULL,NULL,NULL,${NOW},${NOW + 2592000},${NOW},${NOW}),
      ('sub_evil','org_evil','free','monthly','active',0,NULL,NULL,NULL,${NOW},${NOW + 2592000},${NOW},${NOW});
  `);
});

const alice: Caller = {
  userId: "usr_alice",
  organizationId: "org_acme",
  role: "owner",
  isMachineToken: false,
};
const mallory: Caller = {
  userId: "usr_mallory",
  organizationId: "org_evil",
  role: "owner",
  isMachineToken: false,
};

// ------------------------------------------------------------- the basics --

test("a scope sees its own organization's sites and no others", async () => {
  const acme = OrgScope.forCaller(sql, alice);
  const ids = (await acme.listSites()).map((s) => s.id).sort();
  assert.deepEqual(ids, ["site_acme", "site_acme2"]);

  const evil = OrgScope.forCaller(sql, mallory);
  assert.deepEqual((await evil.listSites()).map((s) => s.id), ["site_evil"]);
});

// ------------------------------------------------------- reaching across --

test("another organization's site id resolves to undefined, not to a row", async () => {
  // The whole point. Mallory knows the id — ids appear in URLs, logs and
  // support tickets — and knowing it must buy nothing.
  const evil = OrgScope.forCaller(sql, mallory);
  assert.equal(await evil.site("site_acme"), undefined);
  assert.equal(await evil.site("site_acme2"), undefined);

  // And the reverse.
  const acme = OrgScope.forCaller(sql, alice);
  assert.equal(await acme.site("site_evil"), undefined);
});

test("a missing site and another organization's site are indistinguishable", async () => {
  // If these differed, the API would be an existence oracle for every site id
  // on the platform: guess ids, and the error shape tells you which are real.
  const evil = OrgScope.forCaller(sql, mallory);
  assert.equal(await evil.site("site_acme"), await evil.site("site_does_not_exist_at_all"));
});

test("another organization's grants cannot be read through a guessed id", async () => {
  const evil = OrgScope.forCaller(sql, mallory);
  assert.deepEqual(await evil.siteScopes("site_acme"), [], "acme's grants leaked to evil");
  assert.deepEqual(await evil.siteKeyScopes("site_acme"), []);

  // Mallory's own site still works, so this is isolation and not breakage.
  assert.deepEqual(await evil.siteScopes("site_evil"), ["php:execute"]);
});

test("counts and plans are per-organization", async () => {
  assert.equal(await OrgScope.forCaller(sql, alice).siteCount(), 2);
  assert.equal(await OrgScope.forCaller(sql, mallory).siteCount(), 1);
  assert.equal(await OrgScope.forCaller(sql, alice).plan(), "agency");
  assert.equal(await OrgScope.forCaller(sql, mallory).plan(), "free");
});

test("members are per-organization", async () => {
  const acme = await OrgScope.forCaller(sql, alice).members();
  assert.deepEqual(acme.map((m) => m.user_id).sort(), ["usr_alice", "usr_bob"]);
  assert.equal(await OrgScope.forCaller(sql, alice).ownerCount(), 1);

  const evil = await OrgScope.forCaller(sql, mallory).members();
  assert.deepEqual(evil.map((m) => m.user_id), ["usr_mallory"]);
});

// ------------------------------------------------------------ BR-010 view --

test("effective scope is the grant intersected with the key's ceiling", async () => {
  // `php:execute` is granted on site_acme, and the key the plugin minted does
  // not carry it. Authorising it would send a call the site rejects.
  const acme = OrgScope.forCaller(sql, alice);
  assert.deepEqual(await acme.siteScopes("site_acme"), ["posts:read", "site:read"]);
  assert.ok(
    !(await acme.siteScopes("site_acme")).includes("php:execute"),
    "a grant beyond the key ceiling became effective"
  );

  // The ceiling itself is readable, and is wider than the effective set here
  // because `posts:write` is in the key but was never granted.
  assert.deepEqual(await acme.siteKeyScopes("site_acme"), ["site:read", "posts:read", "posts:write"]);
});

test("a site with no grants has no effective scopes", async () => {
  // The correct default after connection: authorised for nothing.
  assert.deepEqual(await OrgScope.forCaller(sql, alice).siteScopes("site_acme2"), []);
});

// ------------------------------------------------------- machine tokens ----

test("a key restricted to one site cannot see the organization's others", async () => {
  const restricted = OrgScope.forCaller(sql, {
    userId: "key_1",
    organizationId: "org_acme",
    role: "operator",
    isMachineToken: true,
    restrictedToSiteId: "site_acme",
  });

  assert.deepEqual((await restricted.listSites()).map((s) => s.id), ["site_acme"]);
  assert.ok(await restricted.site("site_acme"));
  assert.equal(await restricted.site("site_acme2"), undefined, "a restricted key reached a sibling site");
  assert.deepEqual(await restricted.siteScopes("site_acme2"), []);
});

// ----------------------------------------------------------- memberships ---

test("membershipsForUser returns only that user's memberships", async () => {
  assert.deepEqual(
    (await membershipsForUser(sql, "usr_alice")).map((m) => m.organizationId),
    ["org_acme"]
  );
  assert.deepEqual(
    (await membershipsForUser(sql, "usr_mallory")).map((m) => m.organizationId),
    ["org_evil"]
  );
  assert.deepEqual(await membershipsForUser(sql, "usr_nobody"), []);
});

// ------------------------------------------------------------ injection ----

test("ids are bound, not interpolated", async () => {
  // If any of these changed the query rather than being compared as a value,
  // the parameter binding has been bypassed somewhere.
  const evil = OrgScope.forCaller(sql, mallory);
  for (const attack of [
    "site_acme' OR '1'='1",
    "' OR 1=1 --",
    "site_evil'; DROP TABLE sites; --",
    "site_evil' UNION SELECT * FROM sites WHERE organization_id='org_acme",
  ]) {
    assert.equal(await evil.site(attack), undefined, `injection succeeded: ${attack}`);
  }

  // The table is still there, and unchanged.
  assert.equal(await OrgScope.forCaller(sql, alice).siteCount(), 2);
});

test("malformed key_scopes yields no ceiling rather than an unbounded one", async () => {
  // No ceiling must mean nothing is authorised, never "everything".
  db.exec(
    `INSERT INTO sites (id,organization_id,site_url,label,key_id,key_secret_enc,enc_key_version,key_scopes,health,plugin_version,created_at,last_seen_at)
     VALUES ('site_broken','org_acme','https://broken.example',NULL,'wpk_9','enc',1,'not json at all','unknown',NULL,${NOW},NULL)`
  );
  assert.deepEqual(await OrgScope.forCaller(sql, alice).siteKeyScopes("site_broken"), []);
});
