import type { AuditEntry, Approval, LicenseStatus, Playbook, Row, Schedule, SiteInfo, Snapshot, UsageInfo } from "./types.ts";

/**
 * Everything a screen may read or change. Two implementations:
 *  - BridgeClient: real, signed calls to the plugin REST API (bridgistic/v1).
 *  - DemoClient:   bundled sample data, always labelled "Demo data" in the UI.
 * Routes marked (plugin PR) need the companion plugin change; on older plugins
 * they answer rest_no_route and the screen shows "Needs plugin update".
 */
export interface BridgisticClient {
  readonly mode: "live" | "demo";
  siteInfo(): Promise<SiteInfo>;
  usage(): Promise<UsageInfo>;
  snapshots(): Promise<Snapshot[]>;
  createSnapshot(input: { type: "option" | "post"; target: string; label?: string }): Promise<Row>;
  restoreSnapshot(id: string): Promise<Row>;
  deleteSnapshot(id: string): Promise<Row>;
  approvalStatus(id: string): Promise<Approval>;
  approvals(): Promise<Approval[]>; // plugin PR
  audit(filter?: string): Promise<AuditEntry[]>; // plugin PR
  list(resource: ListResource, query?: Record<string, string>): Promise<Row[]>;
  playbooks(): Promise<Playbook[]>;
  schedules(): Promise<Schedule[]>;
  toggleSchedule(id: string, enabled: boolean): Promise<Row>;
  runScheduleNow(id: string): Promise<Row>;
  togglePlugin(file: string, active: boolean): Promise<Row>;
  fsList(path: string): Promise<Row[]>;
  dbQuery(sql: string): Promise<Row[]>;
  wooSalesSummary(): Promise<Row>;
  license(): Promise<LicenseStatus>; // plugin PR
  activateLicense(key: string): Promise<LicenseStatus>; // plugin PR
  deactivateLicense(): Promise<LicenseStatus>; // plugin PR
  validateLicense(): Promise<LicenseStatus>; // plugin PR
}

export type ListResource =
  | "posts" | "media" | "users" | "plugins" | "options" | "memory"
  | "woo/products" | "woo/orders" | "woo/customers" | "woo/inventory";

/** Pull the first array out of a plugin `data` envelope, e.g. {posts:[...]} → [...]. */
export function firstArray(data: unknown): Row[] {
  if (Array.isArray(data)) return data as Row[];
  if (data && typeof data === "object") {
    for (const v of Object.values(data)) if (Array.isArray(v)) return v as Row[];
  }
  return [];
}
