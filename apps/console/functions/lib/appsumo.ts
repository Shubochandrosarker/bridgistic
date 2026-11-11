/**
 * AppSumo redemption: hashed codes, webhook upserts, one license per code.
 * Raw codes are never persisted. The newly issued BRG- license key is returned
 * once on first redeem (and again to the same account if they retry).
 */
import { audit } from "./auth.ts";
import { issueLicense, maskKey, type LicenseRow } from "./licenses.ts";

export const APPSUMO_SITE_LIMITS: Record<number, number> = { 1: 1, 2: 3, 3: 5 };

export type MarketplaceCodeRow = {
  id: string;
  marketplace: string;
  code_hash: string;
  code_hint: string;
  tier: number;
  site_limit: number;
  status: string;
  owner_email: string;
  license_id: string | null;
  external_id: string;
};

export function normalizeAppsumoCode(code: string): string {
  return code.trim();
}

export function codeHint(code: string): string {
  const value = normalizeAppsumoCode(code);
  return value.length <= 4 ? "••••" : value.slice(-4);
}

export function tierFromUnknown(value: unknown): number {
  const n = Number(value);
  return n === 2 || n === 3 ? n : 1;
}

export function siteLimitForTier(tier: number): number {
  return APPSUMO_SITE_LIMITS[tier] ?? 1;
}

export async function hashRedemptionCode(code: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalizeAppsumoCode(code)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  const len = Math.max(a.length, b.length);
  let out = a.length === b.length ? 0 : 1;
  for (let i = 0; i < len; i++) out |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return out === 0;
}

/** Accept Bearer, X-Appsumo-Secret, or X-Webhook-Secret. */
export function webhookSecretMatches(request: Request, secret: string | undefined): boolean {
  if (!secret) return false;
  const expected = new TextEncoder().encode(secret);
  const auth = request.headers.get("authorization") ?? "";
  const bearer = auth.replace(/^Bearer\s+/i, "");
  const candidates = [bearer, request.headers.get("x-appsumo-secret") ?? "", request.headers.get("x-webhook-secret") ?? ""];
  return candidates.some((value) => value.length > 0 && bytesEqual(new TextEncoder().encode(value), expected));
}

export function parseAppsumoEvent(body: Record<string, unknown>): { event: string; licenseKey: string; prevLicenseKey: string; tier: number } | null {
  const licenseKey = String(body.license_key ?? body.licenseKey ?? body.code ?? "").trim();
  if (!licenseKey) return null;
  return {
    event: String(body.event ?? body.event_type ?? "purchase").toLowerCase(),
    licenseKey,
    prevLicenseKey: String(body.prev_license_key ?? body.prevLicenseKey ?? "").trim(),
    tier: tierFromUnknown(body.tier ?? body.plan_id ?? body.license_tier),
  };
}

export async function upsertPendingCode(
  db: D1Database,
  input: { code: string; tier: number; marketplace?: string; externalId?: string }
): Promise<MarketplaceCodeRow> {
  const hash = await hashRedemptionCode(input.code);
  const existing = await db.prepare("SELECT * FROM marketplace_codes WHERE code_hash = ?").bind(hash).first<MarketplaceCodeRow>();
  const tier = tierFromUnknown(input.tier);
  const siteLimit = siteLimitForTier(tier);
  if (existing) {
    if (existing.status === "pending") {
      await db.prepare("UPDATE marketplace_codes SET tier = ?, site_limit = ? WHERE id = ?").bind(tier, siteLimit, existing.id).run();
      return { ...existing, tier, site_limit: siteLimit };
    }
    return existing;
  }
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO marketplace_codes (id, marketplace, code_hash, code_hint, tier, site_limit, status, external_id)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)`
    )
    .bind(id, input.marketplace ?? "appsumo", hash, codeHint(input.code), tier, siteLimit, input.externalId ?? "")
    .run();
  return (await db.prepare("SELECT * FROM marketplace_codes WHERE id = ?").bind(id).first<MarketplaceCodeRow>()) as MarketplaceCodeRow;
}

export async function handleAppsumoWebhook(request: Request, env: { DB: D1Database; APPSUMO_WEBHOOK_SECRET?: string }): Promise<Response> {
  if (!webhookSecretMatches(request, env.APPSUMO_WEBHOOK_SECRET)) {
    return Response.json({ error: "unauthorized", message: "Invalid AppSumo webhook secret." }, { status: 401 });
  }
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const parsed = parseAppsumoEvent(body);
  if (!parsed) return Response.json({ error: "invalid_payload", message: "The webhook did not include a license key." }, { status: 400 });

  const lookupKey = parsed.prevLicenseKey || parsed.licenseKey;
  const hash = await hashRedemptionCode(lookupKey);
  const row = await env.DB.prepare("SELECT * FROM marketplace_codes WHERE code_hash = ?").bind(hash).first<MarketplaceCodeRow>();

  if (parsed.event === "refund" || parsed.event === "deactivate" || parsed.event === "deactivated") {
    if (row) {
      await env.DB.prepare("UPDATE marketplace_codes SET status = 'refunded' WHERE id = ?").bind(row.id).run();
      if (row.license_id) {
        await env.DB.prepare("UPDATE licenses SET status = 'revoked', notes = notes || ' · AppSumo refunded' WHERE id = ? AND status = 'active'").bind(row.license_id).run();
      }
    }
    return Response.json({ ok: true, event: parsed.event });
  }

  if (parsed.event === "upgrade" || parsed.event === "downgrade") {
    const tier = parsed.tier;
    const siteLimit = siteLimitForTier(tier);
    if (row) {
      await env.DB.prepare("UPDATE marketplace_codes SET tier = ?, site_limit = ? WHERE id = ?").bind(tier, siteLimit, row.id).run();
      if (row.license_id) {
        await env.DB.prepare("UPDATE licenses SET site_limit = ? WHERE id = ?").bind(siteLimit, row.license_id).run();
      }
    } else {
      await upsertPendingCode(env.DB, { code: parsed.licenseKey, tier, externalId: parsed.event });
    }
    return Response.json({ ok: true, event: parsed.event, tier, site_limit: siteLimit });
  }

  await upsertPendingCode(env.DB, { code: parsed.licenseKey, tier: parsed.tier, externalId: parsed.event });
  return Response.json({ ok: true, event: parsed.event });
}

export async function handleAppsumoRedeem(
  request: Request,
  env: { DB: D1Database },
  user: { id: string; email: string }
): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as { code?: string };
  const code = normalizeAppsumoCode(String(body.code ?? ""));
  if (code.length < 6 || code.length > 256) {
    return Response.json({ error: "invalid_code", message: "Enter the AppSumo code exactly as shown in your AppSumo account." }, { status: 400 });
  }
  const hash = await hashRedemptionCode(code);
  const row = await env.DB.prepare("SELECT * FROM marketplace_codes WHERE code_hash = ?").bind(hash).first<MarketplaceCodeRow>();
  if (!row) {
    return Response.json({ error: "invalid_code", message: "This marketplace code is not recognized. Check it against your AppSumo account, or write to support@bridgistic.app." }, { status: 400 });
  }
  if (row.status === "refunded" || row.status === "revoked") {
    return Response.json({ error: "redemption_unavailable", message: "This AppSumo code is no longer active." }, { status: 409 });
  }
  if (row.status === "redeemed") {
    if (row.owner_email.toLowerCase() !== user.email.toLowerCase()) {
      return Response.json({ error: "redemption_already_used", message: "This marketplace code has already been redeemed." }, { status: 409 });
    }
    const license = row.license_id
      ? await env.DB.prepare("SELECT * FROM licenses WHERE id = ?").bind(row.license_id).first<LicenseRow>()
      : null;
    if (!license) {
      return Response.json({ error: "license_missing", message: "This code was redeemed but the license could not be loaded. Email support@bridgistic.app." }, { status: 500 });
    }
    return Response.json({
      ok: true,
      repeated: true,
      message: "This code is already linked to your account.",
      license: { key: license.key, plan: license.plan, site_limit: license.site_limit },
    });
  }

  const org = await env.DB.prepare("SELECT org_id FROM memberships WHERE user_id = ? AND role = 'owner' LIMIT 1").bind(user.id).first<{ org_id: string }>();
  const license = await issueLicense(env.DB, {
    plan: "lifetime",
    ownerEmail: user.email,
    siteLimit: row.site_limit || siteLimitForTier(row.tier),
    orgId: org?.org_id ?? null,
    notes: `AppSumo tier ${row.tier} · hint …${row.code_hint}`,
    expiresAt: null,
  });
  const updated = await env.DB
    .prepare(
      `UPDATE marketplace_codes
       SET status = 'redeemed', owner_email = ?, license_id = ?, redeemed_at = datetime('now')
       WHERE id = ? AND status = 'pending'`
    )
    .bind(user.email, license.id, row.id)
    .run();
  if (!updated.meta || (updated.meta as { changes?: number }).changes === 0) {
    return Response.json({ error: "redemption_race", message: "The marketplace code could not be redeemed; retry safely." }, { status: 409 });
  }
  if (org?.org_id) {
    await env.DB.prepare("UPDATE orgs SET plan = 'lifetime' WHERE id = ?").bind(org.org_id).run();
  }
  await audit(env.DB, user.email, "appsumo.redeemed", maskKey(license.key), `tier ${row.tier}`);
  return Response.json({
    ok: true,
    repeated: false,
    message: `Redeemed successfully. This license covers ${license.site_limit} site${license.site_limit === 1 ? "" : "s"}.`,
    license: { key: license.key, plan: license.plan, site_limit: license.site_limit },
  });
}

export async function seedMarketplaceCode(
  db: D1Database,
  input: { code: string; tier?: number; marketplace?: string },
  actorEmail: string
): Promise<MarketplaceCodeRow> {
  const row = await upsertPendingCode(db, { code: input.code, tier: tierFromUnknown(input.tier), marketplace: input.marketplace });
  await audit(db, actorEmail, "admin.marketplace_code.seed", `…${row.code_hint}`, `tier ${row.tier}`);
  return row;
}
