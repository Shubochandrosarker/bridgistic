// Cloudflare Pages Function: GET /api/offer-status
//
// Reports whether the $69 Lifetime Deal is active. The owner can close it with
// OFFER_FORCE_CLOSED; there is no public deadline or displayed license quota.
//
// Env (Pages project settings → Variables and Secrets):
//   LTD_PRICE_ID     optional          default pri_01m58k6epsqzbr3qbab84t6p90
//   OFFER_FORCE_CLOSED optional        "1" closes the offer immediately

const DEFAULTS = { priceId: "pri_01m58k6epsqzbr3qbab84t6p90" };
const ALLOWED_ORIGINS = new Set([
  "https://bridgistic.app",
  "https://www.bridgistic.app",
  "https://pay.bridgistic.app",
]);
const CACHE_SECONDS = 60;

export function cfg(env = {}) {
  return {
    priceId: /^pri_[a-z0-9]{26}$/.test(env.LTD_PRICE_ID || "") ? env.LTD_PRICE_ID : DEFAULTS.priceId,
    forceClosed: env.OFFER_FORCE_CLOSED === "1",
  };
}

export async function offerStatus(env, now = Date.now(), fetchImpl = fetch) {
  const c = cfg(env);
  void now;
  void fetchImpl;
  const open = !c.forceClosed;
  return {
    open,
    reason: c.forceClosed ? "closed_manually" : "open",
    ends_at: null,
    cap: null,
    sold: null,
    remaining: null,
    source: "owner",
    checked_at: new Date(now).toISOString(),
  };
}

function corsHeaders(request) {
  const origin = request.headers.get("Origin");
  const h = { Vary: "Origin" };
  if (origin && ALLOWED_ORIGINS.has(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

export async function onRequestGet({ request, env, waitUntil }) {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const key = new Request(new URL("/api/offer-status", request.url).toString());
  let body = null;
  if (cache) {
    const hit = await cache.match(key);
    if (hit) body = await hit.text();
  }
  if (!body) {
    body = JSON.stringify(await offerStatus(env));
    if (cache) {
      const toCache = new Response(body, { headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${CACHE_SECONDS}` } });
      const p = cache.put(key, toCache);
      if (waitUntil) waitUntil(p); else await p;
    }
  }
  return new Response(body, {
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${CACHE_SECONDS}`, ...corsHeaders(request) },
  });
}

export function onRequestOptions({ request }) {
  return new Response(null, { status: 204, headers: { "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Max-Age": "86400", ...corsHeaders(request) } });
}
