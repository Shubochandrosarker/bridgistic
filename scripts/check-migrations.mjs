#!/usr/bin/env node
/**
 * Apply every migration in order to an in-memory SQLite database, then apply a
 * realistic legacy `tenants` fixture through 0001 and assert the three things
 * that must survive it.
 *
 * D1 is SQLite, so this catches syntax errors, bad references and broken
 * CHECK constraints before a `wrangler d1 execute` does — on a table nobody
 * can afford to get wrong twice.
 *
 * Run: npm run lint:sql
 */

import { DatabaseSync } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(root, "db", "migrations");

const files = readdirSync(migrationsDir)
  .filter((f) => f.endsWith(".sql"))
  .sort();

// Applied only against a deployment that still holds the legacy `tenants`
// table. Kept out of the ordered set on purpose — a fresh database must never
// run it, because it reads a table that does not exist there.
const legacyDir = join(migrationsDir, "legacy");
const legacyFiles = readdirSync(legacyDir).filter((f) => f.endsWith(".sql")).sort();

if (files.length === 0) {
  console.error("No migrations found in db/migrations.");
  process.exit(1);
}

const failures = [];

function applyAll(db, label) {
  for (const file of files) {
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    try {
      db.exec(sql);
    } catch (err) {
      failures.push(`${label}: ${file} — ${err.message}`);
      return false;
    }
  }
  return true;
}

// --- 1. A fresh database -----------------------------------------------------
{
  const db = new DatabaseSync(":memory:");
  if (applyAll(db, "fresh")) console.log(`  ok   fresh database — ${files.length} migrations`);
  db.close();
}

// --- 2. A database that already holds legacy `tenants` rows ------------------
{
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE tenants (
      id TEXT PRIMARY KEY,
      site_url TEXT NOT NULL UNIQUE,
      key_id TEXT NOT NULL,
      key_secret_enc TEXT NOT NULL,
      scopes TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER
    );
    INSERT INTO tenants VALUES
      ('ten_aaa', 'https://acme.example',  'wpk_1', 'v2.aes256gcm.AAAA.BBBB', '["site:read","posts:write"]', 1750000000, 1755000000),
      ('ten_bbb', 'https://beta.example',  'wpk_2', 'v2.aes256gcm.CCCC.DDDD', '["site:read"]',                1750000001, NULL);
  `);

  let ok = applyAll(db, "with-legacy-tenants");
  if (ok) {
    // Only the backfill, never the drop — the drop is a separate, later,
    // irreversible step with hand-checked preconditions.
    const backfill = readFileSync(join(legacyDir, "0001_backfill_tenants.sql"), "utf8");
    try {
      db.exec(backfill);
      // Idempotent: running it twice must not duplicate anything.
      db.exec(backfill);
    } catch (err) {
      failures.push(`with-legacy-tenants: legacy backfill — ${err.message}`);
      ok = false;
    }
  }
  if (ok) {
    const check = (label, sql, expected) => {
      const got = db.prepare(sql).get();
      const value = Object.values(got ?? {})[0];
      if (String(value) !== String(expected)) {
        failures.push(`with-legacy-tenants: ${label} — expected ${expected}, got ${value}`);
      } else {
        console.log(`  ok   ${label}`);
      }
    };

    check("every tenant became a site", "SELECT COUNT(*) FROM sites", 2);
    check("every site got an org", "SELECT COUNT(*) FROM organizations", 2);
    check("every org got a Free subscription", "SELECT COUNT(*) FROM subscriptions WHERE plan='free'", 2);

    // 1. Live OAuth tokens keep resolving: sites.id must equal tenants.id.
    check(
      "site ids are preserved so live OAuth tokens still resolve",
      "SELECT COUNT(*) FROM sites s JOIN tenants t ON t.id = s.id",
      2
    );
    // 2. No re-encryption: the envelope is carried across byte for byte.
    check(
      "encrypted secrets are copied verbatim — no site has to reconnect",
      "SELECT COUNT(*) FROM sites s JOIN tenants t ON t.id = s.id WHERE s.key_secret_enc = t.key_secret_enc",
      2
    );
    // 3. Nobody silently gains or loses access.
    check(
      "granted scopes are unchanged",
      "SELECT COUNT(*) FROM sites s JOIN tenants t ON t.id = s.id WHERE s.scopes_granted = t.scopes",
      2
    );
    check(
      "the legacy table is kept as the rollback path",
      "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='tenants'",
      1
    );
  }
  db.close();
}

// --- 2b. The irreversible drop, on a database that has already been backfilled
{
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE tenants (
      id TEXT PRIMARY KEY, site_url TEXT NOT NULL UNIQUE, key_id TEXT NOT NULL,
      key_secret_enc TEXT NOT NULL, scopes TEXT NOT NULL,
      created_at INTEGER NOT NULL, last_used_at INTEGER
    );
    INSERT INTO tenants VALUES ('ten_aaa','https://acme.example','wpk_1','enc','[]',1750000000,NULL);
  `);
  applyAll(db, "drop");
  for (const file of legacyFiles) {
    try {
      db.exec(readFileSync(join(legacyDir, file), "utf8"));
    } catch (err) {
      failures.push(`drop: legacy/${file} — ${err.message}`);
    }
  }
  const left = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='tenants'").get();
  if (left.n !== 0) failures.push("drop: legacy/0002 left the tenants table behind");
  else console.log("  ok   the legacy table drops cleanly once the backfill is verified");
  db.close();
}

// --- 3. Constraints actually bite -------------------------------------------
{
  const db = new DatabaseSync(":memory:");
  applyAll(db, "constraints");
  db.exec("PRAGMA foreign_keys = ON");
  const now = 1_750_000_000;
  db.exec(`
    INSERT INTO organizations VALUES ('org_1','Acme','acme',NULL,${now},${now});
    INSERT INTO users VALUES ('usr_1','a@example.com','A',${now},NULL);
    INSERT INTO memberships VALUES ('org_1','usr_1','owner',${now});
    INSERT INTO sites VALUES ('site_1','org_1','https://acme.example',NULL,'wpk_1','enc',1,'[]','unknown',NULL,${now},NULL);
  `);

  const rejects = (label, sql) => {
    try {
      db.exec(sql);
      failures.push(`constraints: ${label} — the database accepted it`);
    } catch {
      console.log(`  ok   ${label}`);
    }
  };

  rejects(
    "a cron job with no expression is rejected",
    `INSERT INTO jobs (id,organization_id,site_id,name,playbook_slug,vars_json,schedule_kind,cron_expr,interval_seconds,run_once_at,timezone,concurrency_key,created_by,created_at,updated_at)
     VALUES ('job_1','org_1','site_1','n','p','{}','cron',NULL,NULL,NULL,'UTC','site:site_1','usr_1',${now},${now})`
  );
  rejects(
    "an unknown membership role is rejected",
    `INSERT INTO memberships VALUES ('org_1','usr_1','superuser',${now})`
  );
  rejects(
    "a second site cannot claim the same URL",
    `INSERT INTO sites VALUES ('site_2','org_1','https://acme.example',NULL,'wpk_2','enc',1,'[]','unknown',NULL,${now},NULL)`
  );
  rejects(
    "an unknown action outcome is rejected",
    `INSERT INTO action_log (id,organization_id,site_id,actor_type,actor_id,tool,request_digest,outcome,duration_ms,created_at)
     VALUES ('act_1','org_1','site_1','user','usr_1','bridgistic_list_posts','deadbeef','maybe',5,${now})`
  );

  db.exec(`
    INSERT INTO jobs (id,organization_id,site_id,name,playbook_slug,vars_json,schedule_kind,cron_expr,interval_seconds,run_once_at,timezone,concurrency_key,created_by,created_at,updated_at)
    VALUES ('job_1','org_1','site_1','nightly','audit','{}','cron','0 2 * * *',NULL,NULL,'Asia/Dhaka','site:site_1','usr_1',${now},${now});
    INSERT INTO job_runs (id,job_id,organization_id,site_id,scheduled_for,status,attempt,steps_summary_json,idempotency_key,created_at)
    VALUES ('run_1','job_1','org_1','site_1',${now},'success',0,'[]','job_1:${now}:0',${now});
  `);
  rejects(
    "a redelivered run cannot execute twice",
    `INSERT INTO job_runs (id,job_id,organization_id,site_id,scheduled_for,status,attempt,steps_summary_json,idempotency_key,created_at)
     VALUES ('run_2','job_1','org_1','site_1',${now},'success',0,'[]','job_1:${now}:0',${now})`
  );

  db.exec(
    `INSERT INTO action_log (id,organization_id,site_id,actor_type,actor_id,tool,request_digest,outcome,duration_ms,idempotency_key,created_at)
     VALUES ('act_1','org_1','site_1','user','usr_1','bridgistic_create_post','deadbeef','success',5,'idem_1',${now})`
  );
  rejects(
    "a retried mutating call is deduplicated by the database, not by hope",
    `INSERT INTO action_log (id,organization_id,site_id,actor_type,actor_id,tool,request_digest,outcome,duration_ms,idempotency_key,created_at)
     VALUES ('act_2','org_1','site_1','user','usr_1','bridgistic_create_post','deadbeef','success',5,'idem_1',${now})`
  );

  db.exec(
    `INSERT INTO subscriptions (id,organization_id,plan,billing_interval,status,api_addon,current_period_start,current_period_end,created_at,updated_at)
     VALUES ('sub_x','org_1','agency','monthly','active',0,${now},${now + 2592000},${now},${now})`
  );
  rejects(
    "an org cannot hold two live subscriptions",
    `INSERT INTO subscriptions (id,organization_id,plan,billing_interval,status,api_addon,current_period_start,current_period_end,created_at,updated_at)
     VALUES ('sub_y','org_1','scale','monthly','active',0,${now},${now + 2592000},${now},${now})`
  );

  db.close();
}

if (failures.length > 0) {
  console.error("\nMigration check failed:");
  for (const f of failures) console.error(`  FAIL ${f}`);
  process.exit(1);
}
console.log(`\nAll ${files.length} migrations (+ ${legacyFiles.length} legacy) apply cleanly.`);
