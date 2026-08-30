/**
 * The implemented API read surface.
 *
 * These tests exercise the Worker handler against the real migrated schema so
 * authentication, organization resolution and the OrgScope SQL filters are
 * tested together. The handler must not turn a missing credential or another
 * organization's resource into a permissive response.
 */

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import api from "../src/index.ts";
import type { Env } from "../src/env.ts";
import { adapt, migratedDatabase } from "./helpers/sqlite.ts";

const NOW = 1_800_000_000;
const SESSION = "s".repeat(48);

let db: DatabaseSync;
let env: Env;

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

beforeEach(async () => {
  db = migratedDatabase();
  db.exec(`
    INSERT INTO organizations (id,name,slug,wpistic_org_id,created_at,updated_at)
      VALUES ('org_1','Acme','acme',NULL,${NOW},${NOW});
    INSERT INTO users (id,email,name,created_at,last_seen_at)
      VALUES ('usr_1','alice@example.com','Alice',${NOW},NULL);
    INSERT INTO memberships (organization_id,user_id,role,created_at)
      VALUES ('org_1','usr_1','operator',${NOW});
    INSERT INTO sessions (id,user_id,organization_id,token_hash,created_at,expires_at,stepped_up_at,revoked_at,credential_version)
      VALUES ('ses_1','usr_1','org_1','${await sha256Hex(SESSION)}',${NOW},${NOW + 3600},NULL,NULL,1);
    INSERT INTO sites (id,organization_id,site_url,label,key_id,key_secret_enc,enc_key_version,key_scopes,health,plugin_version,created_at,last_seen_at)
      VALUES ('site_1','org_1','https://shop.example','Shop','wpk_1','enc',1,'["site:read","posts:read"]','healthy','1.2.0',${NOW},NULL);
    INSERT INTO site_scope_grants (site_id,scope,granted_by,granted_at,last_used_at)
      VALUES ('site_1','site:read','usr_1',${NOW},NULL),('site_1','posts:read','usr_1',${NOW},NULL);
  `);
  env = {
    DB: adapt(db) as unknown as D1Database,
    USAGE_COUNTER: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async () =>
          new Response(JSON.stringify({ consumed: 12, pending: 3, pendingCount: 1, expiredCount: 0 }), {
            headers: { "Content-Type": "application/json" },
          }),
      }),
    } as unknown as DurableObjectNamespace,
    TENANT_ENC_KEY: "test-only-key",
    ENVIRONMENT: "live",
  };
});

function request(path: string, init: RequestInit = {}): Request {
  return new Request(`https://api.bridgistic.app${path}`, {
    ...init,
    headers: { Cookie: `bridgistic_session=${SESSION}`, ...(init.headers ?? {}) },
  });
}

async function body(response: Response): Promise<Record<string, unknown>> {
  return (await response.json()) as Record<string, unknown>;
}

test("health is public and carries a correlation id", async () => {
  const response = await api.fetch(new Request("https://api.bridgistic.app/v1/health"), {} as Env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Content-Type"), "application/json");
  assert.ok(response.headers.get("X-Bridgistic-Request-Id"));
});

test("implemented reads require a verified credential", async () => {
  const response = await api.fetch(new Request("https://api.bridgistic.app/v1/orgs/org_1/sites"), env);
  assert.equal(response.status, 401);
  const result = await body(response);
  assert.equal(result.error, "unauthenticated");
  assert.equal(result.requestId, response.headers.get("X-Bridgistic-Request-Id"));
});

test("the read surface resolves the session organization and filters sites", async () => {
  const response = await api.fetch(request("/v1/orgs/org_1/sites", { headers: { "X-Bridgistic-Request-Id": "req-sites" } }), env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("X-Bridgistic-Request-Id"), "req-sites");
  assert.equal(response.headers.get("Cache-Control"), "no-store");

  const result = await body(response);
  const sites = result.sites as Array<Record<string, unknown>>;
  assert.equal(sites.length, 1);
  assert.equal(sites[0]?.id, "site_1");
  assert.equal(sites[0]?.site_url, "https://shop.example");
  assert.equal(JSON.stringify(result).includes("enc"), false, "credential material reached the response");
});

test("another organization's org and site resources are opaque 404s", async () => {
  const orgResponse = await api.fetch(request("/v1/orgs/org_other"), env);
  assert.equal(orgResponse.status, 404);

  const siteResponse = await api.fetch(request("/v1/sites/site_other/scopes"), env);
  assert.equal(siteResponse.status, 404);
  assert.equal((await body(siteResponse)).error, "not_found");
});

test("a role without site permission cannot use a site read route", async () => {
  db.prepare(`UPDATE memberships SET role = 'billing_manager' WHERE organization_id = 'org_1' AND user_id = 'usr_1'`).run();

  const orgResponse = await api.fetch(request("/v1/orgs/org_1"), env);
  assert.equal(orgResponse.status, 200, "billing visibility should not remove org visibility");

  const siteResponse = await api.fetch(request("/v1/orgs/org_1/sites"), env);
  assert.equal(siteResponse.status, 403);
  assert.equal((await body(siteResponse)).error, "forbidden");
});

test("effective site scopes come from the scoped intersection view", async () => {
  const response = await api.fetch(request("/v1/sites/site_1/scopes"), env);
  assert.equal(response.status, 200);
  assert.deepEqual((await body(response)).scopes, ["posts:read", "site:read"]);
});

test("entitlements and usage are derived from server-side subscription and counter state", async () => {
  db.exec(`
    INSERT INTO subscriptions (id,organization_id,plan,billing_interval,status,api_addon,
      stripe_customer_id,stripe_subscription_id,trial_ends_at,current_period_start,
      current_period_end,created_at,updated_at)
    VALUES ('sub_1','org_1','starter','monthly','active',0,NULL,NULL,NULL,${NOW},${NOW + 2592000},${NOW},${NOW});
    INSERT INTO usage_counters (organization_id,period,actions_consumed,reads,writes,destructive,failures,
      soft_limit_notified_at,hard_limit_hit_at,updated_at)
    VALUES ('org_1','2026-08',12,8,4,0,0,NULL,NULL,${NOW});
  `);
  db.prepare(`UPDATE memberships SET role = 'billing_manager' WHERE organization_id = 'org_1' AND user_id = 'usr_1'`).run();

  const entitlements = await api.fetch(request("/v1/orgs/org_1/entitlements"), env);
  assert.equal(entitlements.status, 200);
  const entitlementBody = await body(entitlements);
  assert.equal(entitlementBody.plan, "starter");
  assert.equal((entitlementBody.entitlements as Record<string, unknown>)["bridgistic.sites.max"], 3);
  assert.equal(JSON.stringify(entitlementBody).includes("stripe_customer"), false);

  const usage = await api.fetch(request("/v1/orgs/org_1/usage"), env);
  assert.equal(usage.status, 200);
  const usageBody = await body(usage);
  assert.equal(usageBody.plan, "starter");
  assert.equal(usageBody.period, "2026-08");
  assert.deepEqual(usageBody.counter, { consumed: 12, pending: 3, pendingCount: 1, expiredCount: 0 });
  assert.equal((usageBody.verdict as Record<string, unknown>).used, 15);
  assert.deepEqual(usageBody.rollups, [
    {
      period: "2026-08",
      actions_consumed: 12,
      reads: 8,
      writes: 4,
      destructive: 0,
      failures: 0,
      soft_limit_notified_at: null,
      hard_limit_hit_at: null,
      updated_at: NOW,
    },
  ]);
});

test("audit, jobs, runs, and approvals expose scoped safe views", async () => {
  db.exec(`
    INSERT INTO action_log (id,organization_id,site_id,actor_type,actor_id,tool,scope_used,
      approval_id,snapshot_id,idempotency_key,request_digest,outcome,error_code,duration_ms,
      actions_consumed,request_id,created_at)
    VALUES ('act_1','org_1','site_1','user','usr_1','bridgistic_list_posts','posts:read',NULL,NULL,
      'idem_1','digest_1','success',NULL,25,1,'req_1',${NOW});
    INSERT INTO jobs (id,organization_id,site_id,name,playbook_slug,vars_json,schedule_kind,cron_expr,
      interval_seconds,run_once_at,timezone,next_run_at,last_run_at,last_status,enabled,dry_run,
      overlap_policy,catchup_policy,max_retries,retry_backoff_seconds,timeout_seconds,concurrency_key,
      notify_on,created_by,created_at,updated_at)
    VALUES ('job_1','org_1','site_1','Nightly','nightly','{"secret":"do-not-return"}','cron','0 2 * * *',
      NULL,NULL,'Asia/Dhaka',${NOW + 3600},NULL,NULL,1,1,'skip','skip_missed',3,60,300,'site:site_1',
      '["failure"]','usr_1',${NOW},${NOW});
    INSERT INTO job_runs (id,job_id,organization_id,site_id,scheduled_for,started_at,finished_at,status,
      attempt,snapshot_id,approval_id,steps_summary_json,error_code,actions_consumed,idempotency_key,created_at)
    VALUES ('run_1','job_1','org_1','site_1',${NOW},${NOW},${NOW + 2},'success',0,NULL,NULL,
      '[{"index":0,"tool":"bridgistic_list_posts","outcome":"success","requestDigest":"digest_1","durationMs":2,"errorCode":null,"secret":"no"}]',NULL,1,'job_1:${NOW}:0',${NOW + 2});
    INSERT INTO approvals (id,organization_id,site_id,tool,scope_requested,request_digest,summary,
      requested_by_type,requested_by_id,status,step_up_verified_at,decided_by,decided_at,expires_at,created_at)
    VALUES ('apr_1','org_1','site_1','bridgistic_delete_post','posts:write','digest_2','Delete one post',
      'user','usr_1','pending',NULL,NULL,NULL,${NOW + 3600},${NOW});
  `);

  const actions = await api.fetch(request("/v1/orgs/org_1/actions?limit=1"), env);
  assert.equal(actions.status, 200);
  const actionBody = await body(actions);
  assert.equal((actionBody.actions as Array<Record<string, unknown>>)[0]?.request_digest, "digest_1");
  assert.equal((actionBody.actions as Array<Record<string, unknown>>)[0]?.request_args, undefined);

  const jobs = await api.fetch(request("/v1/orgs/org_1/jobs"), env);
  assert.equal(jobs.status, 200);
  const jobBody = await body(jobs);
  assert.equal((jobBody.jobs as Array<Record<string, unknown>>)[0]?.id, "job_1");
  assert.equal(JSON.stringify(jobBody).includes("do-not-return"), false);

  const runs = await api.fetch(request("/v1/jobs/job_1/runs"), env);
  assert.equal(runs.status, 200);
  const runBody = await body(runs);
  const run = (runBody.runs as Array<Record<string, unknown>>)[0]!;
  assert.equal(run.error_message, undefined);
  assert.equal(run.steps_summary_json, undefined);
  assert.equal(JSON.stringify(runBody).includes('"secret"'), false);
  assert.deepEqual(run.steps_summary, [
    {
      index: 0,
      tool: "bridgistic_list_posts",
      outcome: "success",
      requestDigest: "digest_1",
      durationMs: 2,
      errorCode: null,
    },
  ]);

  const approvals = await api.fetch(request("/v1/orgs/org_1/approvals"), env);
  assert.equal(approvals.status, 200);
  assert.equal(((await body(approvals)).approvals as Array<Record<string, unknown>>)[0]?.id, "apr_1");
});

test("job runs remain opaque across organizations and reject malformed cursors", async () => {
  const crossOrg = await api.fetch(request("/v1/jobs/job_other/runs"), env);
  assert.equal(crossOrg.status, 404);

  const invalid = await api.fetch(request("/v1/orgs/org_1/actions?cursor=not-valid"), env);
  assert.equal(invalid.status, 400);
  assert.equal((await body(invalid)).error, "invalid_request");
});
