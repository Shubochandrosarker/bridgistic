import { generateCodeVerifier, deriveCodeChallenge } from "./pkce.js";
import { buildWpAuthorizeUrl, exchangeWpCode } from "./wp-oauth-client.js";
import { upsertTenant } from "./tenants-db.js";
import { checkSiteUrl } from "./url-guard.js";
import { logEvent, newRequestId } from "./observability.js";
import type { Env } from "./agent.js";

/**
 * Handles everything that isn't the `/mcp` API route or a path
 * @cloudflare/workers-oauth-provider serves itself (token/registration/
 * metadata endpoints). Two routes, forming the "Worker as OAuth client to
 * WordPress" half of the handshake - the "Worker as OAuth server to the AI
 * client" half is entirely the OAuthProvider library's job.
 *
 * FLOW_TTL / WP_STATE_TTL: both short-lived, single-use-in-practice KV
 * entries reusing the OAUTH_KV binding the library already requires, so no
 * second KV namespace is needed.
 */

const FLOW_TTL = 600;

interface ParsedAuthRequest {
  redirectUri: string;
  state: string;
  [key: string]: unknown;
}

interface StoredFlow {
  authRequest: ParsedAuthRequest;
}

interface StoredWpState {
  flowId: string;
  siteUrl: string;
  codeVerifier: string;
}

interface OAuthEnv extends Env {
  OAUTH_KV: KVNamespace;
  // Injected by @cloudflare/workers-oauth-provider before calling this handler.
  OAUTH_PROVIDER: {
    parseAuthRequest(request: Request): Promise<ParsedAuthRequest>;
    completeAuthorization(options: {
      request: unknown;
      userId: string;
      metadata: unknown;
      scope: string[];
      props: unknown;
    }): Promise<{ redirectTo: string }>;
  };
}

// Dynamic client registration writes the client record to Cloudflare KV, then
// the AI client immediately follows the returned client_id to /authorize.
// KV is eventually consistent across edge locations, so a just-created client
// can briefly look missing at the authorization edge. Retry only that known
// lookup race; do not turn arbitrary authorization errors into blind retries.
const CLIENT_LOOKUP_RETRY_DELAYS_MS = [0, 100, 300, 700];

function isMissingClientError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /invalid client(?:\. the clientid provided does not match to this client\.)?/i.test(message);
}

export async function parseAuthRequestWithRetry(
  provider: OAuthEnv["OAUTH_PROVIDER"],
  request: Request
): Promise<ParsedAuthRequest> {
  let lastError: unknown;
  for (const delay of CLIENT_LOOKUP_RETRY_DELAYS_MS) {
    if (delay) await new Promise<void>((resolve) => setTimeout(resolve, delay));
    try {
      return await provider.parseAuthRequest(request);
    } catch (error) {
      lastError = error;
      if (!isMissingClientError(error)) throw error;
    }
  }
  throw lastError;
}

function html(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      // These pages are self-contained: no scripts, no third-party assets, and
      // nothing that should ever be framed by another origin.
      //
      // NOTE: no form-action directive on purpose. The connect form POSTs to
      // this Worker, which 302s to the customer's WordPress site — a
      // `form-action 'self'` here made Chrome abort that cross-origin
      // redirect mid-navigation (net::ERR_ABORTED), bouncing the user back to
      // the connect form with no visible error.
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      "Referrer-Policy": "no-referrer",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * Every string interpolated into these templates is currently a constant, but
 * the connect form's error slot is the kind of place a user-echoing message
 * eventually lands, so it is escaped rather than trusted by position.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function siteUrlForm(flowId: string, error?: string): string {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect your WordPress site · Bridgistic</title>
<style>
  :root{color-scheme:light;--ink:#0b2346;--muted:#5d708e;--line:#d9e0e7;--paper:#fbfaf6;--green:#16866f;--gold:#d0aa5b;}
  *{box-sizing:border-box;}
  body{margin:0;min-height:100vh;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;color:var(--ink);background:radial-gradient(circle at 12% 0,#f3f8f5,transparent 42%),radial-gradient(circle at 92% 10%,#e9f4f1,transparent 34%),var(--paper);padding:48px 20px;}
  .card{max-width:460px;margin:0 auto;background:rgba(255,255,255,.94);border:1px solid var(--line);border-radius:22px;padding:36px 32px;box-shadow:0 18px 50px rgba(14,36,63,.10);}
  .brand{display:flex;align-items:center;gap:10px;margin:0 0 22px;font-size:1.15rem;font-weight:800;letter-spacing:-.04em;}
  .mark{width:36px;height:36px;border-radius:11px;display:grid;place-items:center;border:1px solid #9ccfd5;background:linear-gradient(135deg,#effcff,#d9f0eb);color:#047fcb;}
  .brand em{color:var(--green);font-style:normal;}
  .eyebrow{display:inline-flex;align-items:center;gap:8px;border:1px solid #c8dfd8;border-radius:999px;padding:5px 10px;color:#147761;background:#f0faf6;font-size:11px;font-weight:800;letter-spacing:.08em;text-transform:uppercase;margin-bottom:14px;}
  h1{font-size:1.55rem;line-height:1.15;letter-spacing:-.04em;margin:0 0 10px;}
  p{color:var(--muted);margin:0 0 20px;font-size:.95rem;line-height:1.5;}
  label{display:block;margin:0 0 8px;font-size:.82rem;font-weight:750;}
  input[type=url]{width:100%;padding:13px 14px;border:1px solid #cfd8e0;border-radius:12px;font-size:1rem;margin-bottom:16px;color:var(--ink);background:#fff;}
  input[type=url]:focus{outline:none;border-color:#4b9e99;box-shadow:0 0 0 4px rgba(75,158,153,.13);}
  button{width:100%;padding:13px;border:none;border-radius:12px;background:linear-gradient(135deg,#d9b665,#c99d4e);color:#102640;font-weight:800;font-size:.98rem;cursor:pointer;box-shadow:0 8px 18px rgba(177,135,57,.22);}
  .err{color:#9a2f24;background:#fbeae8;border:1px solid #f0c9c4;border-radius:12px;padding:10px 12px;font-size:.85rem;margin-bottom:14px;}
  .foot{margin-top:18px;font-size:.78rem;color:var(--muted);text-align:center;}
  .foot a{color:var(--ink);font-weight:650;text-decoration:none;}
</style></head>
<body><div class="card">
  <div class="brand"><span class="mark" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M12 3l2.2 6.4H21l-5.3 3.9 2 6.2L12 16.8 6.3 19.5l2-6.2L3 9.4h6.8L12 3z" fill="#047fcb"/></svg></span><span>Bridg<em>istic</em></span></div>
  <div class="eyebrow">Secure cloud connection</div>
  <h1>Connect your WordPress site</h1>
  <p>Enter the address of the site running the Bridgistic plugin. You'll approve the connection there, in your own WordPress admin.</p>
  ${error ? `<div class="err">${error}</div>` : ""}
  <form method="post" action="/authorize">
    <input type="hidden" name="flow_id" value="${flowId}" />
    <label for="site_url">WordPress site URL</label>
    <input id="site_url" type="url" name="site_url" placeholder="https://your-site.com" required autofocus autocomplete="url" />
    <button type="submit">Continue to WordPress</button>
  </form>
  <p class="foot">Powered by Bridgistic Cloud · <a href="https://dashboard.bridgistic.app/">Open dashboard</a> · <a href="mailto:support@bridgistic.app">support@bridgistic.app</a></p>
</div></body></html>`;
}

/**
 * Normalise and validate the site address typed into the connect form.
 *
 * Delegates to the SSRF guard in url-guard.ts: this used to accept any
 * https URL, including https://127.0.0.1 and https://169.254.169.254, both
 * of which the Worker would then have made server-side requests to.
 *
 * Exported for unit testing (see test/default-handler.test.ts).
 */
export function cleanSiteUrl(raw: string): string | null {
  return checkSiteUrl(raw).origin ?? null;
}

export default {
  async fetch(request: Request, env: OAuthEnv, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/authorize" && request.method === "GET") {
      let authRequest: ParsedAuthRequest;
      try {
        authRequest = await parseAuthRequestWithRetry(env.OAUTH_PROVIDER, request);
      } catch (error) {
        // A malformed or expired client request must never become a Cloudflare
        // 1101 page. The redirect URI cannot be trusted when client lookup
        // failed, so return a safe local error instead of redirecting.
        logEvent({
          requestId: newRequestId(),
          route: "/authorize",
          result: "rejected",
          status: 400,
          errorCategory: error instanceof Error ? error.name : "invalid_authorization_request",
        });
        return html(
          "This authorization request is invalid or expired. Return to your AI assistant and start the Bridgistic connection again.",
          400
        );
      }
      const flowId = crypto.randomUUID();
      const flow: StoredFlow = { authRequest };
      await env.OAUTH_KV.put(`flow:${flowId}`, JSON.stringify(flow), { expirationTtl: FLOW_TTL });
      return html(siteUrlForm(flowId));
    }

    if (url.pathname === "/authorize" && request.method === "POST") {
      const form = await request.formData();
      const flowId = String(form.get("flow_id") || "");
      const rawSiteUrl = String(form.get("site_url") || "");

      const flowRaw = await env.OAUTH_KV.get(`flow:${flowId}`);
      if (!flowRaw) {
        return html("This connection request expired. Go back to your AI assistant and try connecting again.", 400);
      }

      // The guard's reason is written for the person at the keyboard, so it
      // goes straight back into the form instead of a generic "invalid URL".
      const check = checkSiteUrl(rawSiteUrl);
      if (!check.ok || !check.origin) {
        logEvent({
          requestId: newRequestId(),
          route: "/authorize",
          result: "rejected",
          status: 400,
          errorCategory: "site_url_refused",
        });
        return html(siteUrlForm(flowId, escapeHtml(check.reason ?? "Enter a valid https:// site address.")), 400);
      }
      const siteUrl = check.origin;

      const codeVerifier = generateCodeVerifier();
      const codeChallenge = await deriveCodeChallenge(codeVerifier);
      const wpState = crypto.randomUUID();

      const stored: StoredWpState = { flowId, siteUrl, codeVerifier };
      await env.OAUTH_KV.put(`wpstate:${wpState}`, JSON.stringify(stored), { expirationTtl: FLOW_TTL });

      const redirectUri = `${url.origin}/wp-callback`;
      return Response.redirect(buildWpAuthorizeUrl(siteUrl, redirectUri, codeChallenge, wpState), 302);
    }

    if (url.pathname === "/wp-callback" && request.method === "GET") {
      const wpState = url.searchParams.get("state") || "";
      const storedRaw = await env.OAUTH_KV.get(`wpstate:${wpState}`);
      if (!storedRaw) {
        return html("This connection attempt expired or was already used. Go back to your AI assistant and try again.", 400);
      }
      await env.OAUTH_KV.delete(`wpstate:${wpState}`);
      const stored = JSON.parse(storedRaw) as StoredWpState;

      const flowRaw = await env.OAUTH_KV.get(`flow:${stored.flowId}`);
      if (!flowRaw) {
        return html("This connection request expired. Go back to your AI assistant and try connecting again.", 400);
      }
      const { authRequest } = JSON.parse(flowRaw) as StoredFlow;

      if (url.searchParams.get("error")) {
        // The admin clicked Deny in WordPress - bounce a standard OAuth
        // access_denied back through the AI client's own redirect_uri so it
        // can show its usual "connection cancelled" state instead of us
        // stranding the user on a Worker-hosted page.
        await env.OAUTH_KV.delete(`flow:${stored.flowId}`);
        const denyUrl = new URL(authRequest.redirectUri);
        denyUrl.searchParams.set("error", "access_denied");
        denyUrl.searchParams.set("state", authRequest.state);
        return Response.redirect(denyUrl.toString(), 302);
      }

      const code = url.searchParams.get("code") || "";
      if (!code) {
        return html("WordPress did not return an authorization code.", 400);
      }

      let tokenResult;
      try {
        const redirectUri = `${url.origin}/wp-callback`;
        tokenResult = await exchangeWpCode(stored.siteUrl, code, redirectUri, stored.codeVerifier);
      } catch (err) {
        return html(`Could not complete the connection: ${err instanceof Error ? err.message : String(err)}`, 502);
      }

      // The WP exchange above is caught, but everything after it used to run
      // uncaught: a D1 hiccup or an OAuth grant mismatch surfaced as
      // Cloudflare 1101 "Worker threw exception" with zero diagnostics.
      // Wrap the grant-completion region so the person connecting sees the
      // actual failure instead of a bare 1101 page.
      try {
        const tenantId = await upsertTenant(
          env.DB,
          env.TENANT_ENC_KEY,
          tokenResult.site_url,
          tokenResult.key_id,
          tokenResult.key_secret,
          tokenResult.scopes
        );

        await env.OAUTH_KV.delete(`flow:${stored.flowId}`);

        // completeAuthorization throws when a granted scope was never
        // requested by the MCP client. The plugin grants the key's own scope
        // set, which can be broader than a given client asked for — grant the
        // intersection so over-broad keys still connect, and fail with a
        // readable page only when there is no overlap at all.
        const requestedScopes = Array.isArray(authRequest.scope)
          ? authRequest.scope.map(String)
          : [];
        const grantedScopes = Array.isArray(tokenResult.scopes)
          ? tokenResult.scopes.map(String)
          : [];
        const effectiveScope = requestedScopes.length
          ? grantedScopes.filter((s) => requestedScopes.includes(s))
          : grantedScopes;
        if (!effectiveScope.length) {
          await env.OAUTH_KV.delete(`flow:${stored.flowId}`);
          return html(
            "The Bridgistic key on your site grants permissions that don't overlap with what your AI assistant requested. Regenerate the key with the matching permissions and reconnect.",
            400
          );
        }

        const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
          request: authRequest,
          userId: tenantId,
          scope: effectiveScope,
          metadata: { siteUrl: tokenResult.site_url },
          props: { tenantId },
        });

        // Branded success interstitial. The client's redirect_uri still
        // receives the code (meta-refresh after 2s) — the OAuth flow is
        // untouched — but the admin sees an unmistakable "it worked" page
        // instead of a bare redirect to an empty client callback.
        return html(
          `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connected — Bridgistic Cloud</title>
<meta http-equiv="refresh" content="2;url=${escapeHtml(redirectTo)}">
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:#f7faf9;color:#12201e;margin:0;padding:48px 20px;display:grid;place-items:center;min-height:90vh}
  .card{max-width:460px;width:100%;background:#fff;border:1px solid #ddebe6;border-radius:16px;padding:38px 34px;box-shadow:0 12px 40px rgba(20,20,40,.10);text-align:center}
  .tick{width:64px;height:64px;border-radius:50%;background:#00b86b;color:#fff;font-size:34px;display:grid;place-items:center;margin:0 auto 18px;box-shadow:0 10px 30px -8px rgba(0,184,107,.6);animation:pop .45s cubic-bezier(.2,.9,.3,1.3) both}
  @keyframes pop{from{transform:scale(.4);opacity:0}to{transform:scale(1);opacity:1}}
  h1{font-size:1.35rem;margin:0 0 8px}
  p{color:#4f6660;font-size:.95rem;margin:0 0 6px}
  .site{font-weight:700;color:#12201e}
  .next{margin-top:16px;font-size:.85rem;color:#565d6d}
  .next a{color:#0b8f57;font-weight:600;text-decoration:none}
</style></head>
<body><div class="card">
  <div class="tick">&#10003;</div>
  <h1>Site connected successfully</h1>
  <p><span class="site">${escapeHtml(tokenResult.site_url)}</span> is now linked to Bridgistic Cloud.</p>
  <p>Your AI assistant can use it right away.</p>
  <p class="next">Taking you back in a moment&hellip; <a href="${escapeHtml(redirectTo)}">Continue now &rarr;</a></p>
</div></body></html>`,
          200
        );
      } catch (err) {
        logEvent({
          requestId: newRequestId(),
          route: "/wp-callback",
          result: "error",
          status: 502,
          errorCategory: "grant_completion",
        });
        return html(
          `Connection succeeded with WordPress, but finalizing the grant failed: ${escapeHtml(err instanceof Error ? err.message : String(err))}<br><br>Go back to your AI assistant and try connecting again — if this repeats, contact support with this message.`,
          502
        );
      }
    }

    return new Response("Not found.", { status: 404 });
  },
};
