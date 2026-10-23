/**
 * The license engine.
 *
 * Implements the WPistic Control Plane license contract consumed by the
 * Bridgistic plugin (includes/class-license-link.php):
 *   POST /api/v1/licenses/activate    {key, domain, installation_uuid, site_url,
 *                                      home_url, environment, product_version,
 *                                      wp_version, php_version}
 *   POST /api/v1/licenses/validate    {activation_token, domain, environment,
 *                                      installation_uuid, plugin_version}
 *   POST /api/v1/licenses/deactivate  {activation_token, installation_uuid}
 * Every response carries an HMAC-SHA256 signature over canonical JSON keyed by
 * the verification_key issued once at activation; the raw key is never stored.
 */

import { randomHex, signLicenseResponse, encryptSecret } from "./crypto.ts";
import { syncLog } from "./auth.ts";

export interface LicenseRow {
  id: string;
  key: string;
  product: string;
  plan: string;
  status: string;
  site_limit: number;
  owner_email: string;
  org_id: string | null;
  notes: string;
  site_connection: string;
  issued_at: string;
  expires_at: string | null;
}

export function licenseKey(plan: string): string {
  const block = () => randomHex(2).toUpperCase();
  const planCode = plan === "lifetime" ? "LTD" : plan === "yearly" ? "YR" : plan === "monthly" ? "MO" : "STD";
  return `BRG-${planCode}-${block()}${block()}-${block()}${block()}-${block()}${block()}`;
}

export function maskKey(key: string): string {
  return key.length <= 10 ? "••••••" : `${key.slice(0, 7)}…${key.slice(-4)}`;
}

/** Masked license-owner email so a site can show which account unlocks Pro. */
export function maskEmail(email: string): string {
  if (!email || !email.includes("@")) return "";
  const [local, domain] = email.split("@");
  return `${local.slice(0, 2)}${"•".repeat(Math.max(1, local.length - 2))}@${domain}`;
}

/**
 * The plugin pairs its dashboard key at activation: the console stores it
 * encrypted so the license owner's dashboard connects the site with zero
 * manual steps. Same trust model as org-connected sites (AES-GCM at rest).
 */
async function storeConnection(db: D1Database, licenseId: string, siteUrl: string, dk: { key_id?: unknown; secret?: unknown } | undefined, encryptionKey: string | undefined): Promise<void> {
  const keyId = String(dk?.key_id ?? "").trim();
  const secret = String(dk?.secret ?? "").trim();
  if (!encryptionKey || !keyId || !secret) return;
  const normalized = siteUrl.startsWith("http") ? siteUrl : `https://${siteUrl}`;
  let host = normalized;
  try {
    host = new URL(normalized).origin;
  } catch {
    // keep raw
  }
  const payload = JSON.stringify({ site_url: host, key_id: keyId, secret_enc: await encryptSecret(secret, encryptionKey), updated_at: new Date().toISOString() });
  await db.prepare("UPDATE licenses SET site_connection = ? WHERE id = ?").bind(payload, licenseId).run();
}

const BRIDGISTIC_ENTITLEMENTS: Record<string, unknown> = {
  "bridgistic.schedules": "unlimited",
  "bridgistic.snapshots": "advanced",
  "bridgistic.audit_export": true,
  "bridgistic.dashboard": true,
  "bridgistic.skills_marketplace": "member",
};

function licenseExpired(license: LicenseRow): boolean {
  return license.expires_at !== null && new Date(license.expires_at).getTime() < Date.now();
}

function errorBody(code: string, message: string, status: number): Response {
  return Response.json({ success: false, error: { code, message } }, { status });
}

interface ActivationInput {
  key: string;
  domain: string;
  installation_uuid: string;
  site_url?: string;
  home_url?: string;
  environment?: string;
  product_version?: string;
  wp_version?: string;
  php_version?: string;
  dashboard_key?: { key_id?: unknown; secret?: unknown };
}

/** POST /activate — binds one site to one license, up to site_limit. */
export async function activateLicense(env: LicenseEnv, input: ActivationInput): Promise<Response> {
  const db = env.DB;
  const rawKey = String(input.key ?? "").trim();
  const domain = String(input.domain ?? "").toLowerCase().replace(/^www\./, "");
  const installationUuid = String(input.installation_uuid ?? "");
  if (!rawKey || rawKey.length > 200) return errorBody("invalid_key", "Enter a valid license key.", 400);
  if (!domain) return errorBody("invalid_domain", "The activation must carry a domain.", 400);

  const license = await db.prepare("SELECT * FROM licenses WHERE key = ?").bind(rawKey).first<LicenseRow>();
  if (!license) {
    await syncLog(db, "activate", maskKey(rawKey), domain, "unknown key");
    return errorBody("license_not_found", "This license key was not found.", 404);
  }
  if (license.product !== "bridgistic") return errorBody("wrong_product", "This license key is not for Bridgistic.", 400);
  if (license.status === "revoked") return errorBody("license_revoked", "This license has been revoked.", 403);
  if (license.status === "suspended") return errorBody("license_suspended", "This license is suspended. Contact support.", 403);
  if (licenseExpired(license)) return errorBody("license_expired", "This license has expired.", 403);

  const existing = await db
    .prepare("SELECT * FROM activations WHERE license_id = ? AND domain = ? AND installation_uuid = ? AND status = 'active'")
    .bind(license.id, domain, installationUuid)
    .first<{ id: string; activation_token: string; verification_key: string }>();

  let activationToken: string;
  let verificationKey: string;
  if (existing) {
    activationToken = existing.activation_token;
    verificationKey = existing.verification_key;
    await db.prepare("UPDATE activations SET last_validated_at = ? WHERE id = ?").bind(new Date().toISOString(), existing.id).run();
  } else {
    const count = await db
      .prepare("SELECT COUNT(*) AS n FROM activations WHERE license_id = ? AND status = 'active'")
      .bind(license.id)
      .first<{ n: number }>();
    if ((count?.n ?? 0) >= license.site_limit) {
      await syncLog(db, "activate", maskKey(license.key), domain, `site limit reached (${license.site_limit})`);
      return errorBody("site_limit_reached", `This license is already active on ${license.site_limit} site${license.site_limit === 1 ? "" : "s"}. Deactivate one first or upgrade.`, 409);
    }
    activationToken = randomHex(48);
    verificationKey = randomHex(32);
    await db
      .prepare(
        `INSERT INTO activations (id, license_id, activation_token, verification_key, domain, environment,
          installation_uuid, site_url, wp_version, php_version, product_version, last_validated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        crypto.randomUUID(),
        license.id,
        activationToken,
        verificationKey,
        domain,
        String(input.environment ?? "production"),
        installationUuid,
        String(input.site_url ?? ""),
        String(input.wp_version ?? ""),
        String(input.php_version ?? ""),
        String(input.product_version ?? ""),
        new Date().toISOString()
      )
      .run();
  }
  await syncLog(db, "activate", maskKey(license.key), domain, `plan=${license.plan}`);
  await storeConnection(db, license.id, String(input.site_url ?? input.home_url ?? `https://${domain}`), input.dashboard_key, env.SECRET_ENCRYPTION_KEY);

  const body: Record<string, unknown> = {
    success: true,
    product: license.product,
    status: "active",
    plan: license.plan,
    expires_at: license.expires_at,
    member: maskEmail(license.owner_email),
    activation: { domain, environment: String(input.environment ?? "production"), installation_uuid: installationUuid },
    entitlements: BRIDGISTIC_ENTITLEMENTS,
    activation_token: activationToken,
    verification_key: verificationKey,
  };
  await signLicenseResponse(body, verificationKey);
  return Response.json(body);
}

interface ValidateInput {
  activation_token: string;
  domain?: string;
  environment?: string;
  installation_uuid?: string;
  plugin_version?: string;
  dashboard_key?: { key_id?: unknown; secret?: unknown };
}

/** The env the license engine needs: the database plus the at-rest key. */
export interface LicenseEnv {
  DB: D1Database;
  SECRET_ENCRYPTION_KEY?: string;
}

/** POST /validate — replays the signed status for a live activation. */
export async function validateLicense(env: LicenseEnv, input: ValidateInput): Promise<Response> {
  const db = env.DB;
  const token = String(input.activation_token ?? "");
  if (!token) return errorBody("invalid_token", "The activation token is required.", 400);
  const activation = await db.prepare("SELECT * FROM activations WHERE activation_token = ?").bind(token).first<{
    id: string;
    license_id: string;
    verification_key: string;
    domain: string;
    environment: string;
    installation_uuid: string;
    status: string;
  }>();
  if (!activation) {
    await syncLog(db, "validate", "", "", "unknown token");
    return errorBody("activation_not_found", "This activation no longer exists.", 404);
  }
  const license = await db.prepare("SELECT * FROM licenses WHERE id = ?").bind(activation.license_id).first<LicenseRow>();
  if (!license || license.status !== "active" || licenseExpired(license)) {
    const status = license?.status === "suspended" ? "suspended" : license?.status === "revoked" ? "revoked" : "expired";
    await syncLog(db, "validate", maskKey(license?.key ?? ""), activation.domain, `license ${status}`);
    const body: Record<string, unknown> = {
      success: true,
      product: license?.product ?? "bridgistic",
      status,
      plan: license?.plan ?? "",
      expires_at: license?.expires_at ?? null,
      member: license ? maskEmail(license.owner_email) : "",
      entitlements: {},
      activation: { domain: activation.domain, environment: activation.environment, installation_uuid: activation.installation_uuid },
    };
    await signLicenseResponse(body, activation.verification_key);
    return Response.json(body);
  }
  await db.prepare("UPDATE activations SET last_validated_at = ? WHERE id = ?").bind(new Date().toISOString(), activation.id).run();
  await syncLog(db, "validate", maskKey(license.key), activation.domain, "ok");
  // A live site keeps its dashboard pairing fresh: every validate re-pushes
  // the key, so "Check now" in WP Admin heals a lost or rotated pairing.
  const activationRow = await db.prepare("SELECT site_url FROM activations WHERE id = ?").bind(activation.id).first<{ site_url: string }>();
  await storeConnection(db, license.id, String(activationRow?.site_url ?? `https://${activation.domain}`), input.dashboard_key, env.SECRET_ENCRYPTION_KEY);

  const body: Record<string, unknown> = {
    success: true,
    product: license.product,
    status: "active",
    plan: license.plan,
    expires_at: license.expires_at,
    member: maskEmail(license.owner_email),
    activation: { domain: activation.domain, environment: activation.environment, installation_uuid: activation.installation_uuid },
    entitlements: BRIDGISTIC_ENTITLEMENTS,
  };
  await signLicenseResponse(body, activation.verification_key);
  return Response.json(body);
}

interface DeactivateInput {
  activation_token: string;
  installation_uuid?: string;
}

/** POST /deactivate — releases the seat immediately. */
export async function deactivateLicense(db: D1Database, input: DeactivateInput): Promise<Response> {
  const token = String(input.activation_token ?? "");
  const activation = await db.prepare("SELECT * FROM activations WHERE activation_token = ?").bind(token).first<{
    id: string;
    license_id: string;
    domain: string;
    status: string;
  }>();
  if (activation) {
    await db.prepare("DELETE FROM activations WHERE id = ?").bind(activation.id).run();
    const license = await db.prepare("SELECT * FROM licenses WHERE id = ?").bind(activation.license_id).first<LicenseRow>();
    await syncLog(db, "deactivate", maskKey(license?.key ?? ""), activation.domain, "released");
  }
  return Response.json({ success: true, status: "deactivated" });
}

/** Admin issuance. Returns the full key once — it is never shown again. */
export async function issueLicense(
  db: D1Database,
  opts: { plan: string; ownerEmail: string; siteLimit: number; orgId: string | null; notes: string; expiresAt: string | null }
): Promise<LicenseRow> {
  const id = crypto.randomUUID();
  const key = licenseKey(opts.plan);
  await db
    .prepare(
      `INSERT INTO licenses (id, key, product, plan, status, site_limit, owner_email, org_id, notes, expires_at)
       VALUES (?, ?, 'bridgistic', ?, 'active', ?, ?, ?, ?, ?)`
    )
    .bind(id, key, opts.plan, opts.siteLimit, opts.ownerEmail, opts.orgId, opts.notes, opts.expiresAt)
    .run();
  await syncLog(db, "issue", maskKey(key), "", `plan=${opts.plan} for ${opts.ownerEmail || "unassigned"}`);
  const row = await db.prepare("SELECT * FROM licenses WHERE id = ?").bind(id).first<LicenseRow>();
  return row as LicenseRow;
}
