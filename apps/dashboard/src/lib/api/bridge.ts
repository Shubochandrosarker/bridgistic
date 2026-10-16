import { callBridge, BridgeRequestError, type BridgeMethod } from "@bridgistic/wp-client";
import { firstArray, type BridgisticClient, type ListResource } from "./client.ts";
import { ApiError, classify } from "./errors.ts";
import type { AuditEntry, Approval, LicenseStatus, Playbook, Row, Schedule, SiteConnection, SiteInfo, Snapshot, UsageInfo } from "./types.ts";

/** Real client: HMAC-signed requests straight to the site's bridgistic/v1 REST API. */
export class BridgeClient implements BridgisticClient {
  readonly mode = "live" as const;
  constructor(private conn: SiteConnection, private fetchImpl: typeof fetch = (...a) => fetch(...a)) {}

  private async call<T>(method: BridgeMethod, route: string, body?: Record<string, unknown>): Promise<T> {
    try {
      const res = await callBridge<unknown>(
        { alias: this.conn.alias, siteUrl: this.conn.siteUrl, keyId: this.conn.keyId, secret: this.conn.secret },
        method, route, body, { fetchImpl: this.fetchImpl },
      );
      const env = res as { ok?: boolean; data?: unknown };
      return (env && typeof env === "object" && "data" in env ? env.data : res) as T;
    } catch (e) {
      if (e instanceof BridgeRequestError) {
        throw new ApiError(e.message, classify(e.status, e.code), e.status);
      }
      throw new ApiError(e instanceof Error ? e.message : "Request failed", "network");
    }
  }

  siteInfo() { return this.call<SiteInfo>("GET", "site-info"); }
  usage() { return this.call<UsageInfo>("GET", "usage"); }
  async snapshots() { return firstArray(await this.call("GET", "snapshot")) as unknown as Snapshot[]; }
  createSnapshot(input: { type: string; target: string; label?: string }) { return this.call<Row>("POST", "snapshot", input); }
  restoreSnapshot(id: string) { return this.call<Row>("POST", "snapshot/restore", { snapshot_id: id }); }
  deleteSnapshot(id: string) { return this.call<Row>("POST", "snapshot/delete", { snapshot_id: id }); }
  approvalStatus(id: string) { return this.call<Approval>("GET", `approvals/status?approval_id=${encodeURIComponent(id)}`); }
  async approvals() { return firstArray(await this.call("GET", "approvals")) as unknown as Approval[]; }
  async audit(filter = "all") { return firstArray(await this.call("GET", `audit?filter=${encodeURIComponent(filter)}`)) as unknown as AuditEntry[]; }
  async list(resource: ListResource, query: Record<string, string> = {}) {
    const qs = new URLSearchParams(query).toString();
    return firstArray(await this.call("GET", qs ? `${resource}?${qs}` : resource));
  }
  async playbooks() { return firstArray(await this.call("GET", "playbooks")) as unknown as Playbook[]; }
  async schedules() { return firstArray(await this.call("GET", "schedules")) as unknown as Schedule[]; }
  toggleSchedule(id: string, enabled: boolean) { return this.call<Row>("POST", "schedules/toggle", { schedule_id: id, enabled }); }
  runScheduleNow(id: string) { return this.call<Row>("POST", "schedules/run-now", { schedule_id: id }); }
  togglePlugin(file: string, active: boolean) { return this.call<Row>("POST", "plugins/toggle", { plugin: file, state: active ? "activate" : "deactivate" }); }
  async fsList(path: string) { return firstArray(await this.call("POST", "fs/list", { path })); }
  async dbQuery(sql: string) { return firstArray(await this.call("POST", "db/query", { sql })); }
  wooSalesSummary() { return this.call<Row>("GET", "woo/sales-summary"); }
  license() { return this.call<LicenseStatus>("GET", "license"); }
  activateLicense(key: string) { return this.call<LicenseStatus>("POST", "license/activate", { key }); }
  deactivateLicense() { return this.call<LicenseStatus>("POST", "license/deactivate", {}); }
  validateLicense() { return this.call<LicenseStatus>("POST", "license/validate", {}); }
}
