/**
 * api.bridgistic.app — accounts, plans, billing, sites, jobs.
 *
 * Phase 1-3 scaffold. Every route below is declared so the surface is visible
 * and reviewable; the handlers land with their phase. A route that is not yet
 * implemented returns 501 with the phase that will implement it, rather than
 * 404 — a 404 reads as "wrong URL" and sends people looking in the wrong place.
 */

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
  async fetch(request: Request, _env: Env): Promise<Response> {
    const url = new URL(request.url);
    // Every response carries a request id so one customer report maps to one
    // log line — the free repo already does this and it is worth keeping.
    const requestId = request.headers.get("X-Bridgistic-Request-Id") ?? crypto.randomUUID();
    const headers = { "Content-Type": "application/json", "X-Bridgistic-Request-Id": requestId };

    if (url.pathname === "/v1/health") {
      return new Response(JSON.stringify({ ok: true, service: "bridgistic-api" }), { headers });
    }

    const matched = ROUTES.find((r) => matches(r, request.method, url.pathname));
    if (matched) {
      return new Response(
        JSON.stringify({
          error: "not_implemented",
          message: `${matched.method} ${matched.pattern} lands in phase ${matched.phase}: ${matched.summary}`,
          phase: matched.phase,
        }),
        { status: 501, headers }
      );
    }

    return new Response(JSON.stringify({ error: "not_found" }), { status: 404, headers });
  },
} satisfies ExportedHandler<Env>;

function matches(route: RouteSpec, method: string, pathname: string): boolean {
  if (route.method !== method) return false;
  const expected = route.pattern.split("/");
  const actual = pathname.split("/");
  if (expected.length !== actual.length) return false;
  return expected.every((segment, i) => segment.startsWith(":") || segment === actual[i]);
}
