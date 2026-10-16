/** Shapes returned by the Bridgistic plugin (bridgistic/v1), v1.5.3. */
export interface SiteInfo {
  site: { name: string; url: string; wp_version: string; php_version: string; is_multisite: boolean; language: string };
  theme: { name: string; version: string; template: string };
  plugins: { file: string; name: string; version: string; active: boolean }[];
  detected: { woocommerce: boolean; woocommerce_version: string | null; woocommerce_tools: boolean; elementor: boolean; acf: boolean };
  bridge: { version: string; scopes: string[] };
}
export interface UsageInfo {
  tier: string;
  rate_limit: number;
  monthly_quota: number;
  usage: { this_minute: number; today: number; this_month: number; top_actions: Record<string, number> };
  quota_remaining: number | null;
}
export interface Snapshot {
  snapshot_id: string; label: string; type: string; target?: string | null;
  byte_size: number; key_id: string; created_at: string; restored_at: string | null;
}
export interface AuditEntry { id: number; created_at: string; key_id: string; action: string; status: string; ip: string; params_hash: string; summary: string | null }
export interface Approval { approval_id: string; key_id: string; action: string; request_hash: string; summary: string | null; status: string; created_at: string; decided_at: string | null }
export interface Schedule { schedule_id: string; playbook_slug: string; recurrence: string; enabled: boolean | number; next_run: string | null; last_run: string | null; last_status: string | null }
export interface Playbook { slug: string; name?: string; description?: string; steps?: unknown[] }
export interface LicenseStatus {
  connected: boolean;
  status: string; // active | suspended | expired | revoked | cancelled | grace_period | activation_suspended | free
  plan: string;
  key_mask: string | null;
  expires_at: string | null;
  validated_at: string | null;
  domain: string | null;
  entitlements: Record<string, unknown>;
}
/** A connected site as the dashboard stores it. The secret never leaves this browser session. */
export interface SiteConnection { id: string; alias: string; siteUrl: string; keyId: string; secret: string }

export type Row = Record<string, unknown>;
