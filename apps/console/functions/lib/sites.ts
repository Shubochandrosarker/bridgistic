/**
 * Phase 1 (2026-10-26): api.wpistic.com is the single license issuer.
 *
 * The console no longer mints keys. For the plugin it is a thin, signature-
 * preserving proxy on the old URL (admin.bridgistic.app/api/v1/licenses/*, which
 * shipped plugins call), and it keeps exactly one thing of its own: a pairing row
 * per site activation holding the plugin's auto-paired dashboard key, encrypted.
 *
 *   activate   -> forward to wpistic (dashboard_key stripped), store pairing row
 *   validate   -> forward, refresh pairing row (re-pushed key, status, timestamp)
 *   deactivate -> delete pairing row, forward
 *
 * Keys minted by the retired console issuer (BRG-…) keep working: they are still
 * answered by the local engine in licenses.ts until they are reconciled.
 *
 * The dashboard reads /api/me/sites (licenses + activations from wpistic, merged
 * with pairing rows) and calls sites through /api/relay with a site_id; the relay
 * decrypts the secret server-side. No secret is ever returned to a browser.
 */

import { encryptSecret, decryptSecret, toHex } from "./crypto.ts";

export const DEFAULT_WPISTIC_LICENSE_API = "https://api.wpistic.com/api/v1/licenses";
export const DEFAULT_WPISTIC_SERVICE_API = "https://api.wpistic.com/api/v1/service/licenses";

export interface SitesEnv {
  DB: D1Database;
  SECRET_ENCRYPTION_KEY?: string;
  WPISTIC_LICENSE_API?: string;
  WPISTIC_SERVICE_API?: string;
  LICENSE_SERVICE_TOKEN?: string;
}

type Fetch = typeof fetch;

export async function sha256Hex(input: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)));
}

export function originOf(siteUrl: string, domain = ""): string {
  const raw = siteUrl || (domain ? `https://${domain}` : "");
  try {
    return new URL(raw.startsWith("http") ? raw : `https://${raw}`).origin;
  } catch {
    return raw;
  }
}

interface DashboardKey { key_id?: unknown; secret?: unknown }

function cleanKey(dk: DashboardKey | undefined): { keyId: string; secret: string } | null {
  const keyId = String(dk?.key_id ?? "").trim();
  const secret = String(dk?.secret ?? "").trim();
  return keyId && secret && keyId.length <= 100 && secret.length <= 400 ? { keyId, secret } : null;
}

/** Upsert the pairing row for one activation. No key = only status/timestamp refresh. */
export async function upsertPairing(
  env: SitesEnv,
  row: { id: string; source: "wpistic" | "legacy"; tokenHash: string | null; licenseRef?: string; siteUrl: string; domain: string; status: string; dashboardKey?: DashboardKey }
): Promise<void> {
  const now = new Date().toISOString();
  const key = cleanKey(row.dashboardKey);
  if (key && env.SECRET_ENCRYPTION_KEY) {
    const enc = await encryptSecret(key.secret, env.SECRET_ENCRYPTION_KEY);
    await env.DB.prepare(
      `INSERT INTO site_connections (id, source, activation_token_hash, license_ref, site_url, domain, key_id, secret_enc, status, last_validated_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         activation_token_hash = COALESCE(excluded.activation_token_hash, site_connections.activation_token_hash),
         site_url = excluded.site_url, domain = excluded.domain, key_id = excluded.key_id, secret_enc = excluded.secret_enc,
         status = excluded.status, last_validated_at = excluded.last_validated_at, updated_at = excluded.updated_at`
    )
      .bind(row.id, row.source, row.tokenHash, row.licenseRef ?? "", originOf(row.siteUrl, row.domain), row.domain, key.keyId, enc, row.status, now, now)
      .run();
    return;
  }
  await env.DB.prepare("UPDATE site_connections SET status = ?, last_validated_at = ?, updated_at = ?, activation_token_hash = COALESCE(activation_token_hash, ?) WHERE id = ?")
    .bind(row.status, now, now, row.tokenHash, row.id)
    .run();
}

export async function deletePairingByTokenHash(db: D1Database, tokenHash: string): Promise<void> {
  await db.prepare("DELETE FROM site_connections WHERE activation_token_hash = ?").bind(tokenHash).run();
}

export async function deletePairing(db: D1Database, id: string): Promise<void> {
  await db.prepare("DELETE FROM site_connections WHERE id = ?").bind(id).run();
}

// ── Plugin-facing proxy ──────────────────────────────────────────────────────

/** Forward one license call to api.wpistic.com; returns status + raw body (signature untouched). */
async function forward(env: SitesEnv, op: "activate" | "validate" | "deactivate", body: Record<string, unknown>, idem: string | null, fetchImpl: Fetch): Promise<{ status: number; text: string; json: Record<string, unknown> | null }> {
  const { dashboard_key: _dk, ...upstreamBody } = body; // the dashboard key never leaves the console
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json" };
  if (idem) headers["X-Idempotency-Key"] = idem.slice(0, 200);
  let res: Response;
  try {
    res = await fetchImpl(`${(env.WPISTIC_LICENSE_API || DEFAULT_WPISTIC_LICENSE_API).replace(/\/$/, "")}/${op}`, { method: "POST", headers, body: JSON.stringify(upstreamBody) });
  } catch {
    const text = JSON.stringify({ success: false, error: { code: "license_server_unreachable", message: "Could not reach the license server." } });
    return { status: 502, text, json: null };
  }
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try { json = JSON.parse(text); } catch { /* pass through */ }
  return { status: res.status, text, json };
}

function passthrough(r: { status: number; text: string }): Response {
  return new Response(r.text, { status: r.status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}

export async function proxyActivate(env: SitesEnv, body: Record<string, unknown>, idem: string | null, fetchImpl: Fetch = fetch): Promise<Response> {
  const r = await forward(env, "activate", body, idem, fetchImpl);
  const act = (r.json?.activation ?? null) as { id?: string; domain?: string } | null;
  const token = String(r.json?.activation_token ?? "");
  if (r.status >= 200 && r.status < 300 && token && act?.id) {
    await upsertPairing(env, {
      id: String(act.id), source: "wpistic", tokenHash: await sha256Hex(token),
      siteUrl: String(body.site_url ?? body.home_url ?? ""), domain: String(act.domain ?? body.domain ?? ""),
      status: "active", dashboardKey: body.dashboard_key as DashboardKey | undefined,
    });
  }
  return passthrough(r);
}

export async function proxyValidate(env: SitesEnv, body: Record<string, unknown>, fetchImpl: Fetch = fetch): Promise<Response> {
  const r = await forward(env, "validate", body, null, fetchImpl);
  const token = String(body.activation_token ?? "");
  if (token) {
    const tokenHash = await sha256Hex(token);
    const act = (r.json?.activation ?? null) as { id?: string; domain?: string } | null;
    if (r.status >= 200 && r.status < 300 && act?.id) {
      const status = String(r.json?.status ?? "active");
      await upsertPairing(env, {
        id: String(act.id), source: "wpistic", tokenHash,
        siteUrl: String(body.site_url ?? ""), domain: String(act.domain ?? body.domain ?? ""),
        status, dashboardKey: body.dashboard_key as DashboardKey | undefined,
      });
    } else if (r.status === 404 || (r.status >= 200 && r.status < 300 && r.json && r.json.activation === null)) {
      // Activation gone or suspended upstream: drop the pairing.
      await deletePairingByTokenHash(env.DB, tokenHash);
    }
  }
  return passthrough(r);
}

export async function proxyDeactivate(env: SitesEnv, body: Record<string, unknown>, fetchImpl: Fetch = fetch): Promise<Response> {
  const token = String(body.activation_token ?? "");
  if (token) await deletePairingByTokenHash(env.DB, await sha256Hex(token));
  return passthrough(await forward(env, "deactivate", body, null, fetchImpl));
}

// ── Account-side: which sites does this user own? ────────────────────────────

export interface UpstreamActivation { id: string; domain: string; site_url: string | null; environment: string; status: string; last_seen_at: string | null; deactivated_at: string | null }
export interface UpstreamLicense { id: string; key_hash: string; key_mask: string; product: string; plan: string; status: string; effective_status: string; max_activations: number; expires_at: string | null; activations: UpstreamActivation[] }

export async function lookupLicenses(env: SitesEnv, emails: string[], keyHashes: string[], fetchImpl: Fetch = fetch): Promise<UpstreamLicense[]> {
  if (!env.LICENSE_SERVICE_TOKEN || (emails.length === 0 && keyHashes.length === 0)) return [];
  const res = await fetchImpl(`${(env.WPISTIC_SERVICE_API || DEFAULT_WPISTIC_SERVICE_API).replace(/\/$/, "")}/lookup`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${env.LICENSE_SERVICE_TOKEN}` },
    body: JSON.stringify({ product: "bridgistic", emails, key_hashes: keyHashes }),
  });
  if (!res.ok) throw new Error(`license lookup failed (${res.status})`);
  const json = (await res.json()) as { licenses?: UpstreamLicense[] };
  return json.licenses ?? [];
}

export type SiteStatus = "activated" | "deactivated" | "expired" | "suspended";

export interface MySite {
  id: string; // activation id (relay site_id)
  site_url: string;
  domain: string;
  status: SiteStatus;
  license_status: string;
  plan: string;
  license_mask: string;
  license_id: string;
  source: "wpistic" | "legacy";
  paired: boolean; // the plugin pushed a dashboard key, so the relay can call it
  key_id: string | null;
  last_validated_at: string | null;
  expires_at: string | null;
}

export function siteStatus(licenseEffective: string, activationStatus: string): SiteStatus {
  if (activationStatus !== "active") return "deactivated";
  if (licenseEffective === "active" || licenseEffective === "grace_period" || licenseEffective === "trialing") return "activated";
  if (licenseEffective === "suspended" || licenseEffective === "revoked" || licenseEffective === "cancelled") return "suspended";
  return "expired";
}

const RECENT_MS = 7 * 86_400_000;

/** Build the per-site list from upstream licenses + local legacy licenses + pairing rows. Prunes rows whose activation is gone. */
export async function listMySites(
  env: SitesEnv,
  user: { id: string; email: string },
  fetchImpl: Fetch = fetch
): Promise<{ sites: MySite[]; licenses: { id: string; key_mask: string; plan: string; status: string; max_activations: number; used: number; expires_at: string | null; source: string }[]; unlocked: boolean; plan: string | null; upstream_error: boolean }> {
  const db = env.DB;
  const claims = await db.prepare("SELECT key_hash FROM license_claims WHERE user_id = ?").bind(user.id).all<{ key_hash: string }>();
  const claimHashes = (claims.results ?? []).map((r) => r.key_hash);
  let upstream: UpstreamLicense[] = [];
  let upstreamError = false;
  try {
    upstream = await lookupLicenses(env, [user.email], claimHashes, fetchImpl);
  } catch {
    upstreamError = true;
  }
  const pairings = new Map<string, { key_id: string; status: string; last_validated_at: string | null; site_url: string }>();
  {
    const ids: string[] = upstream.flatMap((l) => l.activations.map((a) => a.id));
    // Legacy: console-issued keys owned by this email, or claimed by key.
    const legacy = await db
      .prepare(
        `SELECT l.id, l.key, l.plan, l.status, l.site_limit, l.expires_at, a.id AS act_id, a.domain, a.site_url, a.status AS act_status, a.last_validated_at
         FROM licenses l LEFT JOIN activations a ON a.license_id = l.id
         WHERE l.owner_email = ?`
      )
      .bind(user.email)
      .all<{ id: string; key: string; plan: string; status: string; site_limit: number; expires_at: string | null; act_id: string | null; domain: string | null; site_url: string | null; act_status: string | null; last_validated_at: string | null }>();
    const legacyRows = legacy.results ?? [];
    for (const r of legacyRows) if (r.act_id) ids.push(`legacy:${r.act_id}`);
    if (ids.length) {
      const placeholders = ids.map(() => "?").join(",");
      const rows = await db.prepare(`SELECT id, key_id, status, last_validated_at, site_url FROM site_connections WHERE id IN (${placeholders})`).bind(...ids).all<{ id: string; key_id: string; status: string; last_validated_at: string | null; site_url: string }>();
      for (const r of rows.results ?? []) pairings.set(r.id, r);
    }

    const sites: MySite[] = [];
    const licenses: { id: string; key_mask: string; plan: string; status: string; max_activations: number; used: number; expires_at: string | null; source: string }[] = [];
    const now = Date.now();
    for (const l of upstream) {
      licenses.push({ id: l.id, key_mask: l.key_mask, plan: l.plan, status: l.effective_status, max_activations: l.max_activations, used: l.activations.filter((a) => a.status === "active").length, expires_at: l.expires_at, source: "wpistic" });
      for (const a of l.activations) {
        const recent = a.status === "active" || (a.deactivated_at && now - new Date(a.deactivated_at).getTime() < RECENT_MS);
        const p = pairings.get(a.id);
        if (a.status !== "active" && p) await deletePairing(db, a.id); // deactivated upstream: drop the stored key
        if (!recent) continue;
        sites.push({
          id: a.id, site_url: originOf(a.site_url ?? p?.site_url ?? "", a.domain), domain: a.domain,
          status: siteStatus(l.effective_status, a.status), license_status: l.effective_status, plan: l.plan,
          license_mask: l.key_mask, license_id: l.id, source: "wpistic",
          paired: Boolean(p) && a.status === "active", key_id: a.status === "active" ? p?.key_id ?? null : null,
          last_validated_at: p?.last_validated_at ?? a.last_seen_at, expires_at: l.expires_at,
        });
      }
    }
    const seenLegacy = new Set<string>();
    for (const r of legacyRows) {
      const expired = r.expires_at !== null && new Date(r.expires_at).getTime() < now;
      const eff = r.status === "active" ? (expired ? "expired" : "active") : r.status;
      if (!seenLegacy.has(r.id)) {
        seenLegacy.add(r.id);
        licenses.push({ id: r.id, key_mask: `${r.key.slice(0, 7)}…${r.key.slice(-4)}`, plan: r.plan, status: eff, max_activations: r.site_limit, used: legacyRows.filter((x) => x.id === r.id && x.act_status === "active").length, expires_at: r.expires_at, source: "legacy" });
      }
      if (!r.act_id) continue;
      const id = `legacy:${r.act_id}`;
      const p = pairings.get(id);
      sites.push({
        id, site_url: originOf(r.site_url ?? p?.site_url ?? "", r.domain ?? ""), domain: r.domain ?? "",
        status: siteStatus(eff, r.act_status ?? "inactive"), license_status: eff, plan: r.plan,
        license_mask: `${r.key.slice(0, 7)}…${r.key.slice(-4)}`, license_id: r.id, source: "legacy",
        paired: Boolean(p), key_id: p?.key_id ?? null, last_validated_at: p?.last_validated_at ?? r.last_validated_at, expires_at: r.expires_at,
      });
    }
    const usable = licenses.find((l) => l.status === "active" || l.status === "grace_period");
    return { sites, licenses, unlocked: Boolean(usable), plan: usable?.plan ?? null, upstream_error: upstreamError };
  }
}

/** Claim a license by raw key (Paddle email may differ from the account email). */
export async function claimLicense(env: SitesEnv, user: { id: string; email: string }, rawKey: string, fetchImpl: Fetch = fetch): Promise<{ ok: true; key_mask: string; plan: string; source: string } | { ok: false; status: number; error: string; message: string }> {
  const key = rawKey.trim();
  if (!key || key.length > 200) return { ok: false, status: 400, error: "invalid_key", message: "Enter a valid license key." };
  const hash = await sha256Hex(key);
  // Retired console issuer: BRG- keys live in D1.
  const legacy = await env.DB.prepare("SELECT id, plan, owner_email FROM licenses WHERE key = ?").bind(key).first<{ id: string; plan: string; owner_email: string }>();
  if (legacy) {
    // Holding the key is the proof; reassign ownership to the signed-in account.
    await env.DB.prepare("UPDATE licenses SET owner_email = ? WHERE id = ?").bind(user.email, legacy.id).run();
    await env.DB.prepare("INSERT OR IGNORE INTO license_claims (user_id, key_hash, key_mask) VALUES (?, ?, ?)").bind(user.id, hash, `${key.slice(0, 7)}…${key.slice(-4)}`).run();
    return { ok: true, key_mask: `${key.slice(0, 7)}…${key.slice(-4)}`, plan: legacy.plan, source: "legacy" };
  }
  let found: UpstreamLicense | undefined;
  try {
    found = (await lookupLicenses(env, [], [hash], fetchImpl))[0];
  } catch {
    return { ok: false, status: 502, error: "license_server_unreachable", message: "Could not reach the license server. Try again in a minute." };
  }
  if (!found) return { ok: false, status: 404, error: "license_not_found", message: "This license key was not found." };
  await env.DB.prepare("INSERT OR IGNORE INTO license_claims (user_id, key_hash, key_mask) VALUES (?, ?, ?)").bind(user.id, hash, found.key_mask).run();
  return { ok: true, key_mask: found.key_mask, plan: found.plan, source: "wpistic" };
}

/** Resolve a site_id the user owns to a callable connection (secret decrypted server-side only). */
export async function resolveOwnedSite(env: SitesEnv, user: { id: string; email: string }, siteId: string, fetchImpl: Fetch = fetch): Promise<{ siteUrl: string; keyId: string; secret: string } | null> {
  if (!env.SECRET_ENCRYPTION_KEY) return null;
  const { sites } = await listMySites(env, user, fetchImpl);
  const site = sites.find((s) => s.id === siteId && s.paired && s.status === "activated");
  if (!site) return null;
  const row = await env.DB.prepare("SELECT site_url, key_id, secret_enc FROM site_connections WHERE id = ?").bind(siteId).first<{ site_url: string; key_id: string; secret_enc: string }>();
  if (!row) return null;
  return { siteUrl: row.site_url, keyId: row.key_id, secret: await decryptSecret(row.secret_enc, env.SECRET_ENCRYPTION_KEY) };
}
