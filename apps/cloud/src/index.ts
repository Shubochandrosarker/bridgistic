import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import { BridgisticMcpAgent } from "./agent.js";
import defaultHandler from "./default-handler.js";
import { checkRateLimits, LIMITS, type RateLimitRule } from "./rate-limit.js";
import { hashIdentifier, logEvent, newRequestId } from "./observability.js";

export { BridgisticMcpAgent };

/**
 * mcp.bridgistic.app entry point. This Worker is simultaneously:
 *  - an OAuth 2.1 *server* to the AI client (Claude, ChatGPT, ...), handled
 *    by OAuthProvider itself (token/registration/metadata endpoints, PKCE,
 *    grant storage in OAUTH_KV);
 *  - an OAuth 2.1 *client* to the connecting WordPress site, handled by our
 *    own code in default-handler.ts (/authorize, /wp-callback).
 *
 * Every tool call that reaches BridgisticMcpAgent has already been through
 * OAuthProvider's Bearer-token validation - by the time init() runs on the
 * Durable Object, `this.props.tenantId` is trustworthy.
 */
const provider = new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: BridgisticMcpAgent.serve("/mcp"),
  defaultHandler,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  // Advertise CIMD for current MCP clients while retaining the DCR endpoint
  // below as the compatibility fallback for clients that still use RFC 7591.
  // OpenAI's review connector supports both paths and prefers CIMD when it is
  // advertised by the authorization server.
  clientIdMetadataDocumentEnabled: true,
  resourceMetadata: {
    resource: "https://mcp.bridgistic.app/mcp",
    authorization_servers: ["https://mcp.bridgistic.app"],
    scopes_supported: ["site:read", "posts:read"],
    bearer_methods_supported: ["header"],
    resource_name: "Bridgistic WordPress MCP",
  },
  // AI clients hold this and use it directly against WordPress-derived
  // scopes; keep it short so a leaked client-side token has a small window.
  accessTokenTTL: 3600,
});

interface RateLimitEnv {
  OAUTH_KV: KVNamespace;
  OPENAI_APPS_CHALLENGE?: string;
}

/**
 * Bearer tokens reach /mcp before OAuthProvider has validated them, so the
 * pre-auth per-tenant bucket keys off a digest of the presented token rather
 * than a tenant id we do not yet have. That still isolates one client's budget
 * from another's, which is the point, and the digest is one-way so the token
 * itself is never stored in KV or logged.
 */
async function tenantBucketId(request: Request): Promise<string | null> {
  const auth = request.headers.get("authorization");
  if (!auth) return null;
  const match = /^Bearer\s+(.+)$/i.exec(auth);
  if (!match) return null;
  return hashIdentifier(match[1]);
}

export default {
  async fetch(request: Request, env: RateLimitEnv, ctx: ExecutionContext): Promise<Response> {
    const started = Date.now();
    const requestId = newRequestId();
    const url = new URL(request.url);
    if (
      url.hostname === "mcp.bridgistic.app" &&
      url.pathname === "/.well-known/openai-apps-challenge" &&
      request.method === "GET" &&
      env.OPENAI_APPS_CHALLENGE
    ) {
      return new Response(env.OPENAI_APPS_CHALLENGE, {
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      });
    }
    const ip = request.headers.get("cf-connecting-ip") || "unknown";
    const isMcp = url.pathname === "/mcp";
    const routeClass = isMcp ? "mcp" : "auth";

    // Layered: one abusive IP, one runaway connected site, and an absolute
    // ceiling that bounds how much D1/Durable Object work a distributed flood
    // can force. See rate-limit.ts for the KV consistency caveat.
    const rules: RateLimitRule[] = [
      { scope: "ip", id: `${ip}:${routeClass}`, limit: isMcp ? LIMITS.mcpPerIp : LIMITS.authPerIp },
    ];
    if (isMcp) {
      const tenant = await tenantBucketId(request);
      if (tenant) rules.push({ scope: "tenant", id: tenant, limit: LIMITS.mcpPerTenant });
    }
    rules.push({ scope: "global", id: routeClass, limit: isMcp ? LIMITS.mcpGlobal : LIMITS.authGlobal });

    const decision = await checkRateLimits(env.OAUTH_KV, rules);
    if (decision.limited) {
      logEvent({
        requestId,
        route: url.pathname,
        result: "rate_limited",
        status: 429,
        latencyMs: Date.now() - started,
        errorCategory: `rate_limit_${decision.scope}`,
      });
      return new Response(
        JSON.stringify({
          error: "rate_limited",
          scope: decision.scope,
          message: `Too many requests. Retry in ${decision.retryAfterSeconds} seconds.`,
          retry_after_seconds: decision.retryAfterSeconds,
          request_id: requestId,
        }),
        {
          status: 429,
          headers: {
            "Content-Type": "application/json",
            "Retry-After": String(decision.retryAfterSeconds),
            "X-Bridgistic-Request-Id": requestId,
          },
        }
      );
    }

    // provider.fetch's Env type includes OAUTH_PROVIDER, which the library
    // injects internally before dispatching to apiHandler/defaultHandler -
    // it's not a real wrangler.toml binding, so it can't appear on the Env
    // type this top-level fetch actually receives from the runtime.
    // Some MCP review clients probe the OpenID Connect discovery alias even
    // when the server advertises OAuth authorization-server metadata. Route
    // that compatibility path through the provider so the issuer, endpoints,
    // and supported methods stay generated from one canonical configuration.
    const isOAuthMetadataRequest =
      request.method === "GET" &&
      (url.pathname === "/.well-known/oauth-authorization-server" ||
        url.pathname === "/.well-known/openid-configuration");
    const providerRequest =
      request.method === "GET" && url.pathname === "/.well-known/openid-configuration"
        ? new Request(new URL("/.well-known/oauth-authorization-server", url), request)
        : request;

    let response: Response;
    try {
      response = await provider.fetch(providerRequest, env as unknown as Parameters<typeof provider.fetch>[1], ctx);
      if (isOAuthMetadataRequest && response.ok) {
        const metadata = (await response.clone().json()) as Record<string, unknown>;
        metadata.scopes_supported = ["site:read", "posts:read"];
        response = new Response(JSON.stringify(metadata), response);
        response.headers.set("content-type", "application/json");
      }
    } catch (err) {
      logEvent({
        requestId,
        route: url.pathname,
        result: "error",
        status: 500,
        latencyMs: Date.now() - started,
        errorCategory: err instanceof Error ? err.name : "unknown",
      });
      throw err;
    }

    logEvent({
      requestId,
      route: url.pathname,
      result: response.status < 400 ? "ok" : "rejected",
      status: response.status,
      latencyMs: Date.now() - started,
    });

    // Correlation id on every response, so a user reporting a failure can hand
    // over something that maps to exactly one log line.
    const withId = new Response(response.body, response);
    withId.headers.set("X-Bridgistic-Request-Id", requestId);
    return withId;
  },
};
