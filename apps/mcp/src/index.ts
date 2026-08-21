/**
 * bridgistic.app/mcp — the hosted, multi-tenant MCP endpoint.
 *
 * This app starts from the free repo's `cloud/src` and is MIGRATED, not
 * rewritten. That code already carries 194 passing tests across 43 suites,
 * including a 59-test SSRF guard and a tenant-isolation suite; throwing it away
 * to "start clean" would discard the most reviewed code in the org.
 *
 * What moves across unchanged (Phase 0):
 *   cloud/src/index.ts            → src/index.ts        (OAuth provider wiring)
 *   cloud/src/agent.ts            → src/agent.ts        (BridgisticMcpAgent DO)
 *   cloud/src/default-handler.ts  → src/default-handler.ts
 *   cloud/src/pkce.ts             → src/pkce.ts
 *   cloud/src/url-guard.ts        → src/url-guard.ts    ← do NOT reimplement
 *   cloud/src/crypto.ts           → src/crypto.ts
 *   cloud/src/observability.ts    → src/observability.ts
 *   cloud/src/wp-oauth-client.ts  → src/wp-oauth-client.ts
 *   cloud/test/**                 → test/**             (all 194 must still pass)
 *
 * What changes here, and only this:
 *   - `tenant-registry.ts` / `tenants-db.ts` resolve through `sites` +
 *     `organizations` instead of the flat `tenants` table.
 *   - Every tool call is admitted by the plan, metered on the UsageCounter
 *     Durable Object, and written to `action_log` as a digest.
 *   - Tool definitions come from `@bridgistic/tools` rather than a second copy,
 *     which is what retires `scripts/check-cloud-tools-drift.js`.
 *
 * Until that migration lands this Worker only answers /health, so it can be
 * deployed and routed without pretending to serve MCP.
 */

export interface Env {
  DB: D1Database;
  OAUTH_KV: KVNamespace;
  TENANT_ENC_KEY: string;
  /**
   * Bound once `cloud/src/agent.ts` is migrated in and exported from this file.
   * Declaring the class in wrangler.toml without exporting it here makes
   * `wrangler deploy` fail, so the binding and the export land together.
   */
  MCP_OBJECT?: DurableObjectNamespace;
  /** Cross-script binding to `bridgistic-api`; bound after that Worker exists. */
  USAGE_COUNTER?: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, _env: Env): Promise<Response> {
    const url = new URL(request.url);
    const requestId = request.headers.get("X-Bridgistic-Request-Id") ?? crypto.randomUUID();
    const headers = { "Content-Type": "application/json", "X-Bridgistic-Request-Id": requestId };

    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ ok: true, service: "bridgistic-mcp" }), { headers });
    }

    return new Response(
      JSON.stringify({
        error: "not_implemented",
        message: "The hosted MCP endpoint lands in phase 1 by importing cloud/src. See docs/MIGRATION-PHASE-0.md and IMPLEMENTATION_PLAN.md.",
      }),
      { status: 501, headers }
    );
  },
} satisfies ExportedHandler<Env>;
