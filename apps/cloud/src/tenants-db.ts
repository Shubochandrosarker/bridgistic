import { decryptSecret, encryptSecret } from "./crypto.js";

export interface TenantRow {
  id: string;
  siteUrl: string;
  keyId: string;
  keySecret: string;
  scopes: string[];
}

interface D1TenantRecord {
  id: string;
  site_url: string;
  key_id: string;
  key_secret_enc: string;
  scopes: string;
}

/**
 * One row per connected WordPress site. `id` doubles as the OAuth grant's
 * userId, so it's what BridgisticMcpAgent looks up via the token's props.
 */
export async function upsertTenant(
  db: D1Database,
  encKey: string,
  siteUrl: string,
  keyId: string,
  keySecret: string,
  scopes: string[]
): Promise<string> {
  const existing = await db
    .prepare("SELECT id FROM tenants WHERE site_url = ?")
    .bind(siteUrl)
    .first<{ id: string }>();

  const keySecretEnc = await encryptSecret(keySecret, encKey);

  // site_url carries the UNIQUE constraint, so re-connecting the same site
  // must UPDATE the existing row. The previous INSERT ... ON CONFLICT(id)
  // never fired for a new UUID and crashed on the site_url UNIQUE index
  // whenever a site re-connected (uncaught -> Cloudflare 1101).
  if (existing?.id) {
    await db
      .prepare(
        `UPDATE tenants
           SET key_id = ?, key_secret_enc = ?, scopes = ?, last_used_at = unixepoch()
         WHERE id = ?`
      )
      .bind(keyId, keySecretEnc, JSON.stringify(scopes), existing.id)
      .run();
    return existing.id;
  }

  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO tenants (id, site_url, key_id, key_secret_enc, scopes, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, unixepoch(), unixepoch())`
    )
    .bind(id, siteUrl, keyId, keySecretEnc, JSON.stringify(scopes))
    .run();

  return id;
}

export async function getTenant(db: D1Database, encKey: string, id: string): Promise<TenantRow | null> {
  const row = await db
    .prepare("SELECT id, site_url, key_id, key_secret_enc, scopes FROM tenants WHERE id = ?")
    .bind(id)
    .first<D1TenantRecord>();

  if (!row) return null;

  await db.prepare("UPDATE tenants SET last_used_at = unixepoch() WHERE id = ?").bind(id).run();

  return {
    id: row.id,
    siteUrl: row.site_url,
    keyId: row.key_id,
    keySecret: await decryptSecret(row.key_secret_enc, encKey),
    scopes: JSON.parse(row.scopes),
  };
}
