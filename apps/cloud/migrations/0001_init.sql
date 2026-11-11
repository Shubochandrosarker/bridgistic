-- One row per connected WordPress site. `id` is also the OAuth grant's
-- userId (see src/default-handler.ts), so BridgisticMcpAgent can look up
-- the tenant straight from the access token's props.
CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  site_url TEXT NOT NULL UNIQUE,
  key_id TEXT NOT NULL,
  key_secret_enc TEXT NOT NULL, -- AES-256-GCM, see src/crypto.ts. Never store plaintext here.
  scopes TEXT NOT NULL, -- JSON array of Bridgistic scope strings
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);

CREATE INDEX idx_tenants_site_url ON tenants(site_url);
