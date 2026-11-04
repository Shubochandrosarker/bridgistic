import { callBridge, BridgeRequestError, type BridgeMethod } from "@bridgistic/wp-client";
import { firstArray, type BridgisticClient, type ListResource } from "./client.ts";
import { ApiError, classify } from "./errors.ts";
import { RELAY_URL } from "../config.ts";
import type { AuditEntry, Approval, LicenseStatus, Playbook, Row, Schedule, SiteConnection, SiteInfo, Snapshot, UsageInfo } from "./types.ts";

/** The plugin's default options allowlist (rest/class-options-controller.php). */
const DEFAULT_OPTIONS = ["blogname", "blogdescription", "date_format", "time_format", "start_of_week", "posts_per_page", "show_on_front", "page_on_front", "page_for_posts", "default_comment_status", "timezone_string"];

/** Real client: HMAC-signed requests straight to the site's bridgistic/v1 REST API. */
export class BridgeClient implements BridgisticClient {
  readonly mode = "live" as const;
  constructor(private conn: SiteConnection, private fetchImpl: typeof fetch = (...a) => fetch(...a)) {}

  private async call<T>(method: BridgeMethod, route: string, body?: Record<string, unknown>): Promise<T> {
    // Preferred path: the console relay. Some hosts answer browser preflights
    // for the plugin namespace without CORS headers, which blocks every direct
    // call at the network layer; the relay performs the same signed call
    // server-side. Falls back to the direct browser call when the relay is
    // unreachable. The key stays in this browser either way — the relay does
    // not store it.
    // Paired sites (from license activations) are called by id: the relay
    // checks the session owns the site and uses the stored key server-side.
    // There is no direct fallback for them — the browser never holds the key.
    if (this.conn.pairedSiteId) {
      let res: Response;
      try {
        res = await this.fetchImpl(RELAY_URL, {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ site_id: this.conn.pairedSiteId, method, path: route, body }),
        });
      } catch (e) {
        throw new ApiError(e instanceof Error ? e.message : "Request failed", "network");
      }
      const relayed = (await res.json().catch(() => null)) as { ok?: boolean; data?: unknown; error?: { code?: string; message?: string } | string; message?: string } | null;
      if (relayed?.ok) return relayed.data as T;
      const err = typeof relayed?.error === "object" ? relayed.error : { code: relayed?.error, message: relayed?.message };
      throw new ApiError(err?.message ?? "The site refused the call.", classify(res.status, err?.code), res.status);
    }
    try {
      const res = await this.fetchImpl(RELAY_URL, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ site_url: this.conn.siteUrl, key_id: this.conn.keyId, secret: this.conn.secret, method, path: route, body }),
      });
      const relayed = (await res.json().catch(() => null)) as { ok?: boolean; data?: unknown; error?: { code?: string; message?: string } } | null;
      if (relayed && typeof relayed === "object" && "ok" in relayed) {
        if (relayed.ok) return relayed.data as T;
        throw new ApiError(relayed.error?.message ?? "The site refused the call.", classify(res.status, relayed.error?.code), res.status);
      }
    } catch (e) {
      if (e instanceof ApiError) throw e;
      // Relay unreachable — fall through to the direct call.
    }
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
  /** The plugin expects target as an object: option → { name }, post → { id }. */
  createSnapshot(input: { type: string; target: string; label?: string }) {
    const t = input.target.trim();
    const target = input.type === "option" ? { name: t } : { id: Number(t) };
    return this.call<Row>("POST", "snapshot", { type: input.type, target, label: input.label ?? "" });
  }
  restoreSnapshot(id: string) { return this.call<Row>("POST", "snapshot/restore", { snapshot_id: id }); }
  deleteSnapshot(id: string) { return this.call<Row>("POST", "snapshot/delete", { snapshot_id: id }); }
  /**
   * Plugin 1.5.3+ refuses approval_id in the (unsigned) query string, and GET
   * cannot carry a signed body, so look the ID up in this key's own approvals
   * list. Older plugins have no list route; they still accept the query form.
   */
  async approvalStatus(id: string) {
    try {
      const hit = (await this.approvals()).find((a) => a.approval_id === id);
      if (!hit) throw new ApiError("Approval not found for this key.", "not_found", 404);
      return hit;
    } catch (e) {
      if (e instanceof ApiError && e.kind === "needs_plugin_update") {
        return this.call<Approval>("GET", `approvals/status?approval_id=${encodeURIComponent(id)}`);
      }
      throw e;
    }
  }
  async approvals() { return firstArray(await this.call("GET", "approvals")) as unknown as Approval[]; }
  async audit(filter = "all") { return firstArray(await this.call("GET", `audit?filter=${encodeURIComponent(filter)}`)) as unknown as AuditEntry[]; }
  async list(resource: ListResource, query: Record<string, string> = {}) {
    if (resource === "options") return this.options();
    if (resource === "woo/inventory") return this.inventory();
    const qs = new URLSearchParams(query).toString();
    return firstArray(await this.call("GET", qs ? `${resource}?${qs}` : resource));
  }
  async playbooks() { return firstArray(await this.call("GET", "playbooks")) as unknown as Playbook[]; }
  async schedules() { return firstArray(await this.call("GET", "schedules")) as unknown as Schedule[]; }
  createSchedule(input: { playbook: string; recurrence: string }) { return this.call<Row>("POST", "schedules", { playbook: input.playbook, recurrence: input.recurrence, dry_run: false, force: false }); }
  memoryScan() { return this.call<Row>("POST", "memory/scan", {}); }
  memoryImportUrl(url: string, key?: string) { return this.call<Row>("POST", "memory/import-url", { url, key: key ?? "" }); }
  memoryWrite(category: string, key: string, value: unknown) { return this.call<Row>("POST", "memory", { category, key, value }); }
  toggleSchedule(id: string, enabled: boolean) { return this.call<Row>("POST", "schedules/toggle", { schedule_id: id, enabled }); }
  runScheduleNow(id: string) { return this.call<Row>("POST", "schedules/run-now", { schedule_id: id }); }
  togglePlugin(file: string, active: boolean) { return this.call<Row>("POST", "plugins/toggle", { plugin: file, state: active ? "activate" : "deactivate" }); }
  async fsList(path: string) { return firstArray(await this.call("POST", "fs/list", { path })); }
  async dbQuery(sql: string) { return firstArray(await this.call("POST", "db/query", { sql })); }
  /** Normalised to the same headline fields the demo uses: period, orders, revenue. */
  async wooSalesSummary() {
    const s = await this.call<Row>("GET", "woo/sales-summary");
    const cur = String(s.currency ?? "");
    const money = (v: unknown) => (typeof v === "number" ? v.toFixed(2) : String(v ?? "0")) + (cur ? ` ${cur}` : "");
    return {
      period: `Last ${String(s.period_days ?? 30)} days`,
      orders: Number(s.order_count ?? 0),
      gross_revenue: money(s.gross_revenue),
      average_order_value: money(s.average_order_value),
    } as Row;
  }
  /**
   * GET options needs a name (there is no list route), and only allow-listed
   * names are readable. Read the plugin's default allowlist one by one and skip
   * names the site has removed from its allowlist.
   */
  private async options(): Promise<Row[]> {
    const settled = await Promise.allSettled(DEFAULT_OPTIONS.map((n) => this.call<Row>("GET", `options?name=${encodeURIComponent(n)}`)));
    const rows = settled.flatMap((r) => (r.status === "fulfilled" && r.value.exists !== false ? [{ option: r.value.name, value: r.value.value }] : []));
    const firstErr = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
    if (!rows.length && firstErr) throw firstErr.reason;
    return rows;
  }
  /** woo/inventory returns { out_of_stock: [...], low_stock: [...] }; show both. */
  private async inventory(): Promise<Row[]> {
    const d = await this.call<{ out_of_stock?: Row[]; low_stock?: Row[] }>("GET", "woo/inventory");
    return [
      ...(d.out_of_stock ?? []).map((r) => ({ ...r, stock_state: "out of stock" })),
      ...(d.low_stock ?? []).map((r) => ({ ...r, stock_state: "low stock" })),
    ];
  }
  license() { return this.call<LicenseStatus>("GET", "license"); }
  activateLicense(key: string) { return this.call<LicenseStatus>("POST", "license/activate", { key }); }
  deactivateLicense() { return this.call<LicenseStatus>("POST", "license/deactivate", {}); }
  validateLicense() { return this.call<LicenseStatus>("POST", "license/validate", {}); }
}
