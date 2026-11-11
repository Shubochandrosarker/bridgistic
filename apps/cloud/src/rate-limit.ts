/**
 * Layered fixed-window rate limiting for the Worker, backed by the OAUTH_KV
 * namespace the OAuth provider already requires.
 *
 * KNOWN LIMITATION, stated plainly because the alternative is pretending
 * otherwise: KV has no atomic increment and is eventually consistent across
 * colos. This is read-then-write, so N requests racing inside one window can
 * each read the same count and all be admitted. In practice that means the
 * effective ceiling is "roughly the configured limit, per colo", not an exact
 * quota. That is adequate for its actual job — blunting a hammering token, a
 * scripted /authorize flood, or a single runaway client — and inadequate as a
 * billing-grade counter. Layering (below) is what keeps a single-dimension
 * miss from being a free pass.
 *
 * Moving to an exact limiter means either Cloudflare's native rate-limiting
 * binding or a Durable Object counter; both are recorded as follow-ups in
 * docs/CLOUD_CONNECTOR.md. Neither changes the call sites here.
 *
 * Layers, checked cheapest-first and short-circuiting on the first hit:
 *   - per-IP + route class  — one abusive network source
 *   - per-tenant            — one compromised or looping connected site
 *   - global per route class — an absolute ceiling so a distributed flood
 *                              still cannot drive unbounded D1/DO work
 */

const WINDOW_SECONDS = 60;

export interface RateLimitDecision {
  limited: boolean;
  /** Which layer tripped; used for the 429 body and for logging. */
  scope?: "ip" | "tenant" | "global";
  retryAfterSeconds: number;
}

export interface RateLimitRule {
  /** Dimension name, part of the KV key. */
  scope: "ip" | "tenant" | "global";
  /** Identifier within the dimension ("global" carries a constant). */
  id: string;
  limit: number;
}

/**
 * Increment one fixed-window counter and report whether it is over its limit.
 *
 * Exported on its own because a single-dimension check is genuinely useful in
 * tests and at call sites that only have one identifier to hand.
 */
export async function isRateLimited(
  kv: KVNamespace,
  key: string,
  limit: number,
  windowSeconds = WINDOW_SECONDS
): Promise<boolean> {
  const bucket = Math.floor(Date.now() / 1000 / windowSeconds);
  const bucketKey = `ratelimit:${key}:${bucket}`;
  const current = Number((await kv.get(bucketKey)) ?? "0");
  if (current >= limit) {
    return true;
  }
  // TTL covers this window plus the next, so a slow write near the window
  // boundary can't leave a bucket permanently uncounted.
  await kv.put(bucketKey, String(current + 1), { expirationTtl: windowSeconds * 2 });
  return false;
}

/** Seconds until the current fixed window rolls over — a truthful Retry-After. */
export function secondsUntilWindowReset(windowSeconds = WINDOW_SECONDS): number {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return windowSeconds - (nowSeconds % windowSeconds) || windowSeconds;
}

/**
 * Apply every rule in order, stopping at the first one that trips.
 *
 * Order matters: a request that already failed the per-IP check should not go
 * on to consume budget from the tenant and global buckets, or one noisy source
 * would drain the ceilings that exist to protect everyone else.
 */
export async function checkRateLimits(
  kv: KVNamespace,
  rules: RateLimitRule[],
  windowSeconds = WINDOW_SECONDS
): Promise<RateLimitDecision> {
  for (const rule of rules) {
    const limited = await isRateLimited(kv, `${rule.scope}:${rule.id}`, rule.limit, windowSeconds);
    if (limited) {
      return { limited: true, scope: rule.scope, retryAfterSeconds: secondsUntilWindowReset(windowSeconds) };
    }
  }
  return { limited: false, retryAfterSeconds: 0 };
}

/**
 * Production limits, per minute.
 *
 * /mcp is generous because a legitimate MCP client lists tools, then calls
 * several in a row while the model works; the OAuth routes are tight because a
 * real person walks through them once per connected site. The global ceilings
 * are set well above aggregate expected traffic — they exist to bound the blast
 * radius of a distributed flood, not to shape normal load.
 */
export const LIMITS = {
  mcpPerIp: 120,
  mcpPerTenant: 300,
  mcpGlobal: 6000,
  authPerIp: 20,
  authGlobal: 600,
} as const;
