/**
 * AppSumo redemption: hashed codes, webhook upserts, one license per code.
 * Raw codes are never persisted. The newly issued BRG- license key is returned
 * once on first redeem (and again to the same account if they retry).
 */
import { audit } from "./auth.ts";
import { issueLicense, maskKey, type LicenseRow } from "./licenses.ts";

export const APPSUMO_SITE_LIMITS: Record<number, number> = { 1: 1, 2: 3, 3: 5 };

export type AppsumoCodeRow = {
  code_hash: string;
  plan: string;
  site_limit: number;
  status: string;
  license_id: string | null;
  redeemed_by_user_id: string | null;
  redeemed_at: string | null;
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
): Promise<AppsumoCodeRow> {
  const hash = await hashRedemptionCode(input.code);
  const existing = await db.prepare("SELECT * FROM appsumo_redemption_codes WHERE code_hash = ?").bind(hash).first<AppsumoCodeRow>();
  const siteLimit = siteLimitForTier(tierFromUnknown(input.tier));
  if (existing) {
    if (existing.status === "available") {
      await db.prepare("UPDATE appsumo_redemption_codes SET site_limit = ? WHERE code_hash = ?").bind(siteLimit, hash).run();
      return { ...existing, site_limit: siteLimit };
    }
    return existing;
  }
  await db
    .prepare(
      `INSERT INTO appsumo_redemption_codes (code_hash, plan, site_limit, status)
       VALUES (?, 'lifetime', ?, 'available')`
    )
    .bind(hash, siteLimit)
    .run();
  return (await db.prepare("SELECT * FROM appsumo_redemption_codes WHERE code_hash = ?").bind(hash).first<AppsumoCodeRow>()) as AppsumoCodeRow;
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
  const row = await env.DB.prepare("SELECT * FROM appsumo_redemption_codes WHERE code_hash = ?").bind(hash).first<AppsumoCodeRow>();

  if (parsed.event === "refund" || parsed.event === "deactivate" || parsed.event === "deactivated") {
    if (row) {
      await env.DB.prepare("UPDATE appsumo_redemption_codes SET status = 'refunded' WHERE code_hash = ?").bind(row.code_hash).run();
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
      await env.DB.prepare("UPDATE appsumo_redemption_codes SET site_limit = ? WHERE code_hash = ?").bind(siteLimit, row.code_hash).run();
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
  const row = await env.DB.prepare("SELECT * FROM appsumo_redemption_codes WHERE code_hash = ?").bind(hash).first<AppsumoCodeRow>();
  if (!row) {
    return Response.json({ error: "invalid_code", message: "This marketplace code is not recognized. Check it against your AppSumo account, or write to support@bridgistic.app." }, { status: 400 });
  }
  if (row.status === "refunded" || row.status === "revoked") {
    return Response.json({ error: "redemption_unavailable", message: "This AppSumo code is no longer active." }, { status: 409 });
  }
  if (row.status === "redeemed") {
    if (row.redeemed_by_user_id && row.redeemed_by_user_id !== user.id) {
      return Response.json({ error: "redemption_already_used", message: "This marketplace code has already been redeemed." }, { status: 409 });
    }
    const license = row.license_id
      ? await env.DB.prepare("SELECT * FROM licenses WHERE id = ?").bind(row.license_id).first<LicenseRow>()
      : null;
    if (!license) {
      return Response.json({ error: "license_missing", message: "This code was redeemed but the license could not be loaded. Email support@bridgistic.app." }, { status: 500 });
    }
    if (license.owner_email.toLowerCase() !== user.email.toLowerCase()) {
      return Response.json({ error: "redemption_already_used", message: "This marketplace code has already been redeemed." }, { status: 409 });
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
    plan: row.plan || "lifetime",
    ownerEmail: user.email,
    siteLimit: row.site_limit || 1,
    orgId: org?.org_id ?? null,
    notes: `AppSumo ${row.plan || "lifetime"} · ${row.site_limit} site(s)`,
    expiresAt: null,
  });
  const updated = await env.DB
    .prepare(
      `UPDATE appsumo_redemption_codes
       SET status = 'redeemed', license_id = ?, redeemed_by_user_id = ?, redeemed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
       WHERE code_hash = ? AND status = 'available'`
    )
    .bind(license.id, user.id, row.code_hash)
    .run();
  if (!updated.meta || (updated.meta as { changes?: number }).changes === 0) {
    return Response.json({ error: "redemption_race", message: "The marketplace code could not be redeemed; retry safely." }, { status: 409 });
  }
  if (org?.org_id) {
    await env.DB.prepare("UPDATE orgs SET plan = 'lifetime' WHERE id = ?").bind(org.org_id).run();
  }
  await audit(env.DB, user.email, "appsumo.redeemed", maskKey(license.key), `limit ${license.site_limit}`);
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
): Promise<AppsumoCodeRow> {
  const row = await upsertPendingCode(db, { code: input.code, tier: tierFromUnknown(input.tier), marketplace: input.marketplace });
  await audit(db, actorEmail, "admin.marketplace_code.seed", codeHint(input.code), `limit ${row.site_limit}`);
  return row;
}
