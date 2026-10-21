// Cloudflare Pages Function: GET /api/offer-status
//
// Reports whether the $29.99 Lifetime Deal welcome offer is still open.
// Terms (set by Shuvo): open until 31 Dec 2026 23:59:59 Asia/Dhaka (UTC+6,
// assumed) and capped at 100 licenses. The sold count is read server-side from
// Paddle with a READ-ONLY API key (permission: transaction.read only). The key
// lives in the Pages project as the encrypted secret PADDLE_API_KEY and is never
// sent to the browser. Without a key the endpoint closes by date only and
// returns sold/remaining as null, so the page never shows an invented number.
//
// Env (Pages project settings → Variables and Secrets):
//   PADDLE_API_KEY   secret, optional  read-only key (pdl_live_apikey_...)
//   PADDLE_ENV       optional          "sandbox" for sandbox-api.paddle.com
//   OFFER_ENDS_AT    optional          RFC 3339, default 2026-12-31T23:59:59+06:00
//   OFFER_CAP        optional          default 100
//   LTD_PRICE_ID     optional          default pri_01m58k6epsqzbr3qbab84t6p90
//   OFFER_FORCE_CLOSED optional        "1" closes the offer immediately

const DEFAULTS = {
  endsAt: "2026-12-31T23:59:59+06:00",
  cap: 100,
  priceId: "pri_01m58k6epsqzbr3qbab84t6p90",
};
const ALLOWED_ORIGINS = new Set([
  "https://bridgistic.app",
  "https://www.bridgistic.app",
  "https://pay.bridgistic.app",
]);
const CACHE_SECONDS = 60;
const MAX_PAGES = 40; // 30 per page (Paddle maximum) → up to 1200 one-time transactions scanned

export function cfg(env = {}) {
  const cap = Number.parseInt(env.OFFER_CAP ?? "", 10);
  return {
    endsAt: Date.parse(env.OFFER_ENDS_AT || DEFAULTS.endsAt),
    endsAtIso: env.OFFER_ENDS_AT || DEFAULTS.endsAt,
    cap: Number.isFinite(cap) && cap > 0 ? cap : DEFAULTS.cap,
    priceId: /^pri_[a-z0-9]{26}$/.test(env.LTD_PRICE_ID || "") ? env.LTD_PRICE_ID : DEFAULTS.priceId,
    base: env.PADDLE_ENV === "sandbox" ? "https://sandbox-api.paddle.com" : "https://api.paddle.com",
    forceClosed: env.OFFER_FORCE_CLOSED === "1",
  };
}

// Count LTD licenses sold: quantity of the LTD price on paid/completed one-time
// transactions, excluding transactions fully refunded or charged back
// (adjusted grand total 0 while the original total was above 0).
export function countFromTransactions(transactions, priceId) {
  let sold = 0;
  for (const t of transactions) {
    if (!t || !["paid", "completed"].includes(t.status)) continue;
    const d = t.details || {};
    const orig = Number(d.totals?.grand_total ?? 0);
    const adj = Number(d.adjusted_totals?.grand_total ?? orig);
    if (orig > 0 && adj <= 0) continue;
    for (const li of d.line_items || []) {
      if (li.price_id === priceId) sold += Number(li.quantity) || 0;
    }
  }
  return sold;
}

export async function soldFromPaddle(c, apiKey, fetchImpl = fetch) {
  let url = `${c.base}/transactions?status=paid,completed&subscription_id=null&per_page=30&order_by=id[ASC]`;
  const all = [];
  for (let page = 0; page < MAX_PAGES && url; page++) {
    const r = await fetchImpl(url, { headers: { Authorization: `Bearer ${apiKey}`, "Paddle-Version": "1" } });
    if (!r.ok) throw new Error(`paddle ${r.status}`);
    const j = await r.json();
    all.push(...(j.data || []));
    url = j.meta?.pagination?.has_more ? j.meta.pagination.next : null;
  }
  if (url) throw new Error("too many transactions to count safely");
  return countFromTransactions(all, c.priceId);
}

export async function offerStatus(env, now = Date.now(), fetchImpl = fetch) {
  const c = cfg(env);
  const beforeEnd = now < c.endsAt;
  let sold = null;
  let source = "none";
  if (beforeEnd && !c.forceClosed && env.PADDLE_API_KEY) {
    try {
      sold = await soldFromPaddle(c, env.PADDLE_API_KEY, fetchImpl);
      source = "paddle";
    } catch {
      source = "error";
    }
  }
  const open = beforeEnd && !c.forceClosed && (sold === null || sold < c.cap);
  return {
    open,
    reason: c.forceClosed ? "closed_manually" : !beforeEnd ? "ended" : sold !== null && sold >= c.cap ? "sold_out" : "open",
    ends_at: c.endsAtIso,
    cap: c.cap,
    sold: source === "paddle" ? sold : null,
    remaining: source === "paddle" ? Math.max(0, c.cap - sold) : null,
    source,
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
