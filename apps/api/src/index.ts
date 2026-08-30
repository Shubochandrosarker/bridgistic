/**
 * api.bridgistic.app — accounts, plans, billing, sites, jobs.
 *
 * Phase 1-3 scaffold. Every route below is declared so the surface is visible
 * and reviewable; the handlers land with their phase. The implemented read
 * routes resolve identity and tenancy here; unfinished action routes return
 * 501 with the phase that will implement them rather than pretending to work.
 */

import { authenticate, resolveOrganization } from "./auth.ts";
import { OrgScope, membershipsForUser } from "./db/scope.ts";
import type { JobRunRow, PageCursor } from "./db/scope.ts";
import type { SqlDatabase } from "./db/scope.ts";
import { can } from "@bridgistic/identity";
import { fromSubscription } from "./entitlements.ts";
import { endOfPeriod, counterName, periodFor } from "./usage-counter.ts";
import { evaluateQuota } from "@bridgistic/tools";
import { PLAN_IDS, PLANS } from "@bridgistic/types";
import type { PlanId } from "@bridgistic/types";
import type { Env } from "./env.ts";

export { UsageCounter } from "./usage-counter.ts";

interface RouteSpec {
  method: string;
  pattern: string;
  phase: number;
  summary: string;
}

/** The API surface, in one list, so it can be diffed in review. */
export const ROUTES: readonly RouteSpec[] = [
  { method: "GET", pattern: "/v1/health", phase: 0, summary: "Liveness. No auth." },

  { method: "POST", pattern: "/v1/auth/token", phase: 1, summary: "OAuth 2.1 + PKCE token exchange." },
  { method: "GET", pattern: "/v1/me", phase: 1, summary: "The caller, their orgs and their role in each." },

  { method: "GET", pattern: "/v1/orgs/:orgId", phase: 1, summary: "Org detail." },
  { method: "GET", pattern: "/v1/orgs/:orgId/members", phase: 1, summary: "Team seats." },
  { method: "POST", pattern: "/v1/orgs/:orgId/members", phase: 1, summary: "Invite. Bounded by the plan's seats." },

  { method: "GET", pattern: "/v1/orgs/:orgId/sites", phase: 1, summary: "Connected sites, health, last seen." },
  { method: "POST", pattern: "/v1/orgs/:orgId/sites", phase: 1, summary: "Connect a site. Enforces sites.max." },
  { method: "DELETE", pattern: "/v1/sites/:siteId", phase: 1, summary: "Disconnect. Releases the seat." },
  { method: "POST", pattern: "/v1/sites/:siteId/transfer", phase: 1, summary: "Audited move between orgs." },

  { method: "GET", pattern: "/v1/sites/:siteId/scopes", phase: 2, summary: "Per-site grants, with last-used." },
  { method: "PUT", pattern: "/v1/sites/:siteId/scopes", phase: 2, summary: "Narrow below the plan. Never widen." },
  { method: "DELETE", pattern: "/v1/sites/:siteId/scopes/:scope", phase: 2, summary: "One-click revoke." },

  { method: "GET", pattern: "/v1/orgs/:orgId/entitlements", phase: 2, summary: "Resolved plan or WPistic key map." },

  { method: "GET", pattern: "/v1/orgs/:orgId/usage", phase: 3, summary: "Counter, roll-up, soft/hard limit state." },
  { method: "GET", pattern: "/v1/orgs/:orgId/actions", phase: 3, summary: "Audit log. Digests only." },
  { method: "POST", pattern: "/v1/billing/checkout", phase: 3, summary: "Stripe checkout session." },
  { method: "POST", pattern: "/v1/billing/portal", phase: 3, summary: "Stripe customer portal." },
  { method: "POST", pattern: "/v1/webhooks/stripe", phase: 3, summary: "Idempotent by event id." },

  { method: "GET", pattern: "/v1/orgs/:orgId/jobs", phase: 4, summary: "Scheduled jobs." },
  { method: "POST", pattern: "/v1/orgs/:orgId/jobs", phase: 4, summary: "Create. Validates cron, zone, interval floor." },
  { method: "PATCH", pattern: "/v1/jobs/:jobId", phase: 4, summary: "Update. Re-arms the job's Durable Object." },
  { method: "DELETE", pattern: "/v1/jobs/:jobId", phase: 4, summary: "Delete. Cancels the alarm." },
  { method: "GET", pattern: "/v1/jobs/:jobId/runs", phase: 4, summary: "Run history, per-step outcomes." },
  { method: "POST", pattern: "/v1/runs/:runId/rerun", phase: 4, summary: "Re-run with the original vars." },

  { method: "GET", pattern: "/v1/orgs/:orgId/approvals", phase: 4, summary: "Pending approvals." },
  { method: "POST", pattern: "/v1/approvals/:id/decide", phase: 4, summary: "Approve/reject. Needs step-up auth." },
] as const;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    // Every response carries a request id so one customer report maps to one
    // log line — the free repo already does this and it is worth keeping.
    const requestId = request.headers.get("X-Bridgistic-Request-Id") ?? crypto.randomUUID();
    const headers = { "Content-Type": "application/json", "X-Bridgistic-Request-Id": requestId };

    if (url.pathname === "/v1/health") {
      return new Response(JSON.stringify({ ok: true, service: "bridgistic-api" }), { headers });
    }

    const matched = ROUTES.map((route) => ({ route, params: matchParams(route, request.method, url.pathname) }))
      .find((candidate) => candidate.params !== undefined);
    if (matched) {
      if (isImplementedRead(matched.route, request.method)) {
        return handleRead(request, env, requestId, matched.route.pattern, matched.params!, url.searchParams);
      }

      return new Response(
        JSON.stringify({
          error: "not_implemented",
          message: `${matched.route.method} ${matched.route.pattern} lands in phase ${matched.route.phase}: ${matched.route.summary}`,
          phase: matched.route.phase,
          requestId,
        }),
        { status: 501, headers }
      );
    }

    return new Response(JSON.stringify({ error: "not_found", message: "Resource not found.", requestId }), {
      status: 404,
      headers,
    });
  },
} satisfies ExportedHandler<Env>;

const IMPLEMENTED_READS = new Set([
  "GET /v1/me",
  "GET /v1/orgs/:orgId",
  "GET /v1/orgs/:orgId/members",
  "GET /v1/orgs/:orgId/sites",
  "GET /v1/sites/:siteId/scopes",
  "GET /v1/orgs/:orgId/entitlements",
  "GET /v1/orgs/:orgId/usage",
  "GET /v1/orgs/:orgId/actions",
  "GET /v1/orgs/:orgId/jobs",
  "GET /v1/jobs/:jobId/runs",
  "GET /v1/orgs/:orgId/approvals",
]);

function isImplementedRead(route: RouteSpec, method: string): boolean {
  return IMPLEMENTED_READS.has(`${method} ${route.pattern}`);
}

function matchParams(route: RouteSpec, method: string, pathname: string): Record<string, string> | undefined {
  if (route.method !== method) return undefined;
  const expected = route.pattern.split("/");
  const actual = pathname.split("/");
  if (expected.length !== actual.length) return undefined;

  const params: Record<string, string> = {};
  for (let i = 0; i < expected.length; i++) {
    const pattern = expected[i]!;
    const value = actual[i]!;
    if (!pattern.startsWith(":")) {
      if (pattern !== value) return undefined;
      continue;
    }
    let decoded: string;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      return undefined;
    }
    if (decoded === "") return undefined;
    params[pattern.slice(1)] = decoded;
  }
  return params;
}

async function handleRead(
  request: Request,
  env: Env,
  requestId: string,
  pattern: string,
  params: Record<string, string>,
  query: URLSearchParams,
): Promise<Response> {
  const db = env.DB as unknown as SqlDatabase;
  const auth = await authenticate(request, { db, now: Math.floor(Date.now() / 1_000), environment: env.ENVIRONMENT });
  if (!auth.ok) return error("unauthenticated", "Authentication required.", requestId, 401);

  if (pattern === "/v1/me") {
    const organizations = auth.caller.isMachineToken
      ? [{ organizationId: auth.caller.organizationId, role: auth.caller.role }]
      : await membershipsForUser(db, auth.caller.userId);
    return json(
      {
        userId: auth.caller.userId,
        organizationId: auth.caller.organizationId,
        role: auth.caller.role,
        organizations,
      },
      requestId
    );
  }

  const organization = resolveOrganization(auth.caller, params.orgId);
  if (!organization.ok) return error("not_found", "Resource not found.", requestId, 404);

  if (!mayRead(auth.caller.role, pattern)) {
    return error("forbidden", "You are not allowed to read this resource.", requestId, 403);
  }

  const scope = OrgScope.forCaller(db, auth.caller);
  if (pattern === "/v1/orgs/:orgId") {
    const row = await scope.organization();
    return row === undefined
      ? error("not_found", "Resource not found.", requestId, 404)
      : json({ organization: row }, requestId);
  }
  if (pattern === "/v1/orgs/:orgId/members") return json({ members: await scope.members() }, requestId);
  if (pattern === "/v1/orgs/:orgId/sites") return json({ sites: await scope.listSites() }, requestId);

  if (pattern === "/v1/orgs/:orgId/entitlements") {
    const subscription = await scope.subscription();
    const plan = planId(subscription?.plan) ?? "free";
    const resolved = fromSubscription(plan);
    return json(
      {
        source: resolved.source,
        plan: resolved.plan,
        checkAfter: resolved.checkAfter,
        entitlements: resolved.entitlements,
        subscription: subscription ?? null,
      },
      requestId
    );
  }

  if (pattern === "/v1/orgs/:orgId/usage") {
    // A site-restricted key cannot safely read an organization-wide counter.
    // Do not turn an org roll-up into a site estimate; that would be false data
    // and would expose activity from the other sites in the organization.
    if (auth.caller.restrictedToSiteId !== undefined) {
      return error("forbidden", "This key cannot read organization-wide usage.", requestId, 403);
    }
    const options = parsePageOptions(query);
    if (!options.ok) return error("invalid_request", options.message, requestId, 400);

    const nowMs = Date.now();
    const period = periodFor(nowMs);
    const live = await readLiveCounter(env, auth.caller.organizationId, period);
    if (!live) return error("meter_unavailable", "Usage is temporarily unavailable.", requestId, 503);
    const plan = planId(await scope.plan()) ?? "free";
    const limit = PLANS[plan].actionsPerMonth;
    const used = live.consumed + live.pending;
    return json(
      {
        period,
        plan,
        limit,
        verdict: evaluateQuota(used, limit, endOfPeriod(nowMs)),
        counter: live,
        rollups: await scope.usageRollups(),
      },
      requestId
    );
  }

  if (pattern === "/v1/orgs/:orgId/actions") {
    const options = parsePageOptions(query);
    if (!options.ok) return error("invalid_request", options.message, requestId, 400);
    const page = await scope.actions(options);
    return json({ actions: page.items, nextCursor: page.nextCursor }, requestId);
  }

  if (pattern === "/v1/orgs/:orgId/jobs") {
    return json({ jobs: await scope.jobs() }, requestId);
  }

  if (pattern === "/v1/jobs/:jobId/runs") {
    const options = parsePageOptions(query);
    if (!options.ok) return error("invalid_request", options.message, requestId, 400);
    const page = await scope.jobRuns(params.jobId!, options);
    return page === undefined
      ? error("not_found", "Resource not found.", requestId, 404)
      : json({ runs: page.items.map(publicRun), nextCursor: page.nextCursor }, requestId);
  }

  if (pattern === "/v1/orgs/:orgId/approvals") {
    return json({ approvals: await scope.pendingApprovals(Math.floor(Date.now() / 1_000)) }, requestId);
  }

  const site = await scope.site(params.siteId!);
  if (site === undefined) return error("not_found", "Resource not found.", requestId, 404);
  return json({ siteId: site.id, scopes: await scope.siteScopes(site.id) }, requestId);
}

function mayRead(role: Parameters<typeof can>[0], pattern: string): boolean {
  switch (pattern) {
    case "/v1/orgs/:orgId":
      return can(role, "org.read");
    case "/v1/orgs/:orgId/members":
      return can(role, "member.read");
    case "/v1/orgs/:orgId/sites":
    case "/v1/sites/:siteId/scopes":
      return can(role, "site.read");
    case "/v1/orgs/:orgId/entitlements":
      return can(role, "billing.read");
    case "/v1/orgs/:orgId/usage":
      return can(role, "usage.read");
    case "/v1/orgs/:orgId/actions":
      return can(role, "audit.read");
    case "/v1/orgs/:orgId/jobs":
    case "/v1/jobs/:jobId/runs":
      return can(role, "job.read");
    case "/v1/orgs/:orgId/approvals":
      return can(role, "approval.request") || can(role, "approval.decide");
    default:
      return false;
  }
}

interface PageOptions {
  readonly ok: true;
  readonly limit: number;
  readonly cursor?: PageCursor;
}

function parsePageOptions(query: URLSearchParams): PageOptions | { readonly ok: false; readonly message: string } {
  const rawLimit = query.get("limit");
  const limit = rawLimit === null ? 50 : Number(rawLimit);
  if (rawLimit !== null && !/^\d{1,3}$/.test(rawLimit)) {
    return { ok: false, message: "limit must be an integer from 1 to 100." };
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    return { ok: false, message: "limit must be an integer from 1 to 100." };
  }

  const rawCursor = query.get("cursor");
  if (rawCursor === null) return { ok: true, limit };
  if (rawCursor.length > 160) return { ok: false, message: "cursor is invalid." };
  const separator = rawCursor.indexOf(":");
  if (separator <= 0 || separator === rawCursor.length - 1) return { ok: false, message: "cursor is invalid." };
  const createdAt = Number(rawCursor.slice(0, separator));
  const id = rawCursor.slice(separator + 1);
  if (!/^\d{1,13}$/.test(rawCursor.slice(0, separator)) || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
    return { ok: false, message: "cursor is invalid." };
  }
  if (!Number.isSafeInteger(createdAt) || createdAt < 0) return { ok: false, message: "cursor is invalid." };
  return { ok: true, limit, cursor: { createdAt, id } };
}

function planId(value: unknown): PlanId | undefined {
  return typeof value === "string" && (PLAN_IDS as readonly string[]).includes(value)
    ? (value as PlanId)
    : undefined;
}

interface LiveCounter {
  readonly consumed: number;
  readonly pending: number;
  readonly pendingCount: number;
  readonly expiredCount: number;
}

interface CounterNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): { fetch(request: Request): Promise<Response> };
}

async function readLiveCounter(env: Env, organizationId: string, period: string): Promise<LiveCounter | undefined> {
  const namespace = env.USAGE_COUNTER as unknown as Partial<CounterNamespace>;
  if (typeof namespace.idFromName !== "function" || typeof namespace.get !== "function") return undefined;
  try {
    const id = namespace.idFromName(counterName(organizationId, period));
    const response = await namespace.get(id).fetch(new Request("https://usage-counter.internal/read"));
    if (!response.ok) return undefined;
    const value = (await response.json()) as Partial<LiveCounter>;
    if (!validCounterNumber(value.consumed) || !validCounterNumber(value.pending)) return undefined;
    if (!validCounterNumber(value.pendingCount) || !validCounterNumber(value.expiredCount)) return undefined;
    return {
      consumed: value.consumed,
      pending: value.pending,
      pendingCount: value.pendingCount,
      expiredCount: value.expiredCount,
    };
  } catch {
    return undefined;
  }
}

function validCounterNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function publicRun(row: JobRunRow): Omit<JobRunRow, "steps_summary_json"> & { readonly steps_summary: unknown[] } {
  const { steps_summary_json: stepsSummaryJson, ...safeRow } = row;
  return {
    ...safeRow,
    steps_summary: safeSteps(stepsSummaryJson),
  };
}

function safeSteps(value: string): unknown[] {
  if (value.length > 256_000) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, 100).flatMap((step) => {
      if (typeof step !== "object" || step === null) return [];
      const item = step as Record<string, unknown>;
      return [{
        index: typeof item.index === "number" && Number.isSafeInteger(item.index) ? item.index : null,
        tool: typeof item.tool === "string" && item.tool.length <= 128 ? item.tool : null,
        outcome: typeof item.outcome === "string" && item.outcome.length <= 64 ? item.outcome : null,
        requestDigest: typeof item.requestDigest === "string" && item.requestDigest.length <= 128 ? item.requestDigest : null,
        durationMs: typeof item.durationMs === "number" && Number.isSafeInteger(item.durationMs) ? item.durationMs : null,
        errorCode: typeof item.errorCode === "string" && item.errorCode.length <= 128 ? item.errorCode : null,
      }];
    });
  } catch {
    return [];
  }
}

function error(code: string, message: string, requestId: string, status: number): Response {
  return json({ error: code, message, requestId }, requestId, status);
}

function json(body: unknown, requestId: string, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json",
      "X-Bridgistic-Request-Id": requestId,
    },
  });
}
