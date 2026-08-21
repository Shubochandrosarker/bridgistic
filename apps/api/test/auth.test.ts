/**
 * Authentication, against a real database.
 *
 * Every test here is about a credential that should NOT work: expired,
 * revoked, rotated out from under, belonging to a removed member, presented
 * alongside another, or pointing at somebody else's organization.
 */

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { authenticate, sessionTokenFrom, resolveOrganization } from "../src/auth.ts";
import type { SqlDatabase, SqlStatement, Caller } from "../src/db/scope.ts";
import { generateApiKey } from "@bridgistic/identity";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

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

const NOW = 1_800_000_000;
const SESSION_TOKEN = "s".repeat(48);
const REMOVED_TOKEN = "r".repeat(48);
const EXPIRED_TOKEN = "e".repeat(48);
const REVOKED_TOKEN = "v".repeat(48);
const ROTATED_TOKEN = "o".repeat(48);
const SUSPENDED_TOKEN = "u".repeat(48);

let db: DatabaseSync;
let sql: SqlDatabase;
let liveKey: string;
let revokedKey: string;
let testEnvKey: string;

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

before(async () => {
  db = new DatabaseSync(":memory:");
  const dir = join(root, "db", "migrations");
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(dir, file), "utf8"));
  }
  sql = adapt(db);

  db.exec(`
    INSERT INTO organizations (id,name,slug,wpistic_org_id,created_at,updated_at) VALUES
      ('org_acme','Acme','acme',NULL,${NOW},${NOW});
    INSERT INTO users (id,email,name,created_at,last_seen_at) VALUES
      ('usr_alice','alice@example.com','Alice',${NOW},NULL),
      ('usr_removed','removed@example.com','Removed',${NOW},NULL),
      ('usr_suspended','sus@example.com','Suspended',${NOW},NULL);
    UPDATE users SET status = 'suspended' WHERE id = 'usr_suspended';
    INSERT INTO memberships (organization_id,user_id,role,created_at) VALUES
      ('org_acme','usr_alice','operator',${NOW}),
      ('org_acme','usr_suspended','operator',${NOW});
  `);

  const sessions: [string, string, number, number | null, number][] = [
    // token, user, expiresAt, revokedAt, credentialVersion
    [SESSION_TOKEN, "usr_alice", NOW + 3600, null, 1],
    [REMOVED_TOKEN, "usr_removed", NOW + 3600, null, 1],
    [EXPIRED_TOKEN, "usr_alice", NOW - 1, null, 1],
    [REVOKED_TOKEN, "usr_alice", NOW + 3600, NOW - 1, 1],
    // Issued before a password change bumped users.credential_version.
    [ROTATED_TOKEN, "usr_alice", NOW + 3600, null, 0],
    [SUSPENDED_TOKEN, "usr_suspended", NOW + 3600, null, 1],
  ];
  for (const [token, user, expires, revoked, version] of sessions) {
    db.prepare(
      `INSERT INTO sessions (id,user_id,organization_id,token_hash,created_at,expires_at,stepped_up_at,revoked_at,credential_version)
       VALUES (?,?,?,?,?,?,NULL,?,?)`
    ).run(`ses_${token.slice(0, 3)}`, user, "org_acme", await sha256Hex(token), NOW - 10, expires, revoked, version);
  }

  const live = await generateApiKey("live");
  const revoked = await generateApiKey("live");
  const testEnv = await generateApiKey("test");
  liveKey = live.plaintext;
  revokedKey = revoked.plaintext;
  testEnvKey = testEnv.plaintext;

  const insertKey = (id: string, publicId: string, hash: string, env: string, revokedAt: number | null, role: string, siteId: string | null) =>
    db.prepare(
      `INSERT INTO api_keys (id,organization_id,prefix,key_hash,label,created_by,created_at,revoked_at,role,environment,site_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(id, "org_acme", publicId, hash, "k", "usr_alice", NOW - 10, revokedAt, role, env, siteId);

  insertKey("key_live", live.publicId, live.secretHash, "live", null, "operator", null);
  insertKey("key_revoked", revoked.publicId, revoked.secretHash, "live", NOW - 1, "operator", null);
  insertKey("key_test", testEnv.publicId, testEnv.secretHash, "test", null, "viewer", null);
});

const ctx = () => ({ db: sql, now: NOW, environment: "live" as const });

const withHeaders = (headers: Record<string, string>) => new Request("https://api.bridgistic.app/v1/me", { headers });

// ------------------------------------------------------------- sessions ----

test("a live session resolves to its member's role", async () => {
  const result = await authenticate(withHeaders({ Cookie: `bridgistic_session=${SESSION_TOKEN}` }), ctx());
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.caller.userId, "usr_alice");
  assert.equal(result.ok && result.caller.organizationId, "org_acme");
  assert.equal(result.ok && result.caller.role, "operator");
  assert.equal(result.ok && result.caller.isMachineToken, false);
});

test("expired, revoked and rotated sessions all fail", async () => {
  for (const [token, expected] of [
    [EXPIRED_TOKEN, "expired"],
    [REVOKED_TOKEN, "revoked"],
    // "Sign out everywhere" is a button that does nothing without this.
    [ROTATED_TOKEN, "revoked"],
  ] as const) {
    const result = await authenticate(withHeaders({ Cookie: `bridgistic_session=${token}` }), ctx());
    assert.equal(result.ok, false, `${token.slice(0, 3)} was accepted`);
    assert.equal(result.ok === false && result.reason, expected);
  }
});

test("a session outliving its membership stops working", async () => {
  // Somebody removed from a team keeps a valid, unexpired session cookie. Only
  // the membership check notices, and it is the check most easily forgotten.
  const result = await authenticate(withHeaders({ Cookie: `bridgistic_session=${REMOVED_TOKEN}` }), ctx());
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "no_membership");
});

test("a suspended user's live sessions stop immediately, not at expiry", async () => {
  const result = await authenticate(withHeaders({ Cookie: `bridgistic_session=${SUSPENDED_TOKEN}` }), ctx());
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "revoked");
});

test("cookie parsing cannot be confused by a similar name", async () => {
  // `not_bridgistic_session=fake` must not satisfy a substring match.
  assert.equal(sessionTokenFrom(`not_bridgistic_session=${SESSION_TOKEN}`), undefined);
  assert.equal(sessionTokenFrom(`xbridgistic_session=${SESSION_TOKEN}`), undefined);
  assert.equal(sessionTokenFrom(`other=x; bridgistic_session=${SESSION_TOKEN}`), SESSION_TOKEN);
  assert.equal(sessionTokenFrom(`bridgistic_session=${SESSION_TOKEN}; other=y`), SESSION_TOKEN);
  assert.equal(sessionTokenFrom(null), undefined);
  assert.equal(sessionTokenFrom(""), undefined);
});

test("a malformed session token is rejected before it is used as a lookup key", async () => {
  for (const bad of ["short", "x".repeat(200), "has spaces here padded to length aaaaaaaaaaaaaaaa", "with\nnewline"]) {
    assert.equal(sessionTokenFrom(`bridgistic_session=${bad}`), undefined, `${bad.slice(0, 12)} accepted`);
  }
});

// ------------------------------------------------------------ API keys -----

test("a live key resolves with the role fixed at mint time", async () => {
  const result = await authenticate(withHeaders({ Authorization: `Bearer ${liveKey}` }), ctx());
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.caller.role, "operator");
  assert.equal(result.ok && result.caller.isMachineToken, true);
  assert.equal(result.ok && result.caller.organizationId, "org_acme");
});

test("every key rejection looks identical to the caller", async () => {
  // Distinguishing "expired" from "unknown" confirms the key was real.
  const unknown = await generateApiKey("live");
  for (const key of [revokedKey, unknown.plaintext, testEnvKey, "brg_live_bad_key", "garbage"]) {
    const result = await authenticate(withHeaders({ Authorization: `Bearer ${key}` }), ctx());
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "invalid_credential");
  }
});

test("a test-environment key never authenticates against live", async () => {
  const result = await authenticate(withHeaders({ Authorization: `Bearer ${testEnvKey}` }), ctx());
  assert.equal(result.ok, false);

  // …and works in its own environment, so this is separation, not breakage.
  const inTest = await authenticate(withHeaders({ Authorization: `Bearer ${testEnvKey}` }), {
    ...ctx(),
    environment: "test",
  });
  assert.equal(inTest.ok, true);
  assert.equal(inTest.ok && inTest.caller.role, "viewer");
});

// ---------------------------------------------------------- both, neither --

test("presenting two credentials is refused rather than resolved by precedence", async () => {
  // "Whichever is more privileged wins" is how a low-privilege key smuggles a
  // high-privilege session past a check that only looked at the key.
  const result = await authenticate(
    withHeaders({ Authorization: `Bearer ${liveKey}`, Cookie: `bridgistic_session=${SESSION_TOKEN}` }),
    ctx()
  );
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "invalid_credential");
});

test("no credential is its own failure, distinct from a bad one", async () => {
  const result = await authenticate(withHeaders({}), ctx());
  assert.equal(result.ok === false && result.reason, "missing_credential");
});

// ------------------------------------------------------ path organization --

test("an organization id in the path is checked, never trusted", async () => {
  const caller: Caller = {
    userId: "usr_alice",
    organizationId: "org_acme",
    role: "operator",
    isMachineToken: false,
  };

  assert.equal(resolveOrganization(caller, "org_acme").ok, true);
  assert.equal(resolveOrganization(caller, undefined).ok, true, "an absent id means the caller's own");

  // Not silently redirected to the caller's own org: that would hide an
  // attempt rather than record one.
  const other = resolveOrganization(caller, "org_evil");
  assert.equal(other.ok, false);
  assert.equal(other.ok === false && other.reason, "organization_mismatch");
});
