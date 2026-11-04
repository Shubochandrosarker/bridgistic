import type { BridgisticClient, ListResource } from "./client.ts";
import type { Approval, AuditEntry, LicenseStatus, Row, Schedule, SiteInfo, Snapshot, UsageInfo } from "./types.ts";

/**
 * DEMO MODE ONLY. Every value below is invented sample data for previews and
 * screenshots. The UI shows a persistent "Demo data" banner whenever this client
 * is active, and nothing here is ever shown as a real measurement.
 */
const day = (n: number, h = 9) => new Date(Date.UTC(2026, 9, 16 - n, h, 12)).toISOString().replace("T", " ").slice(0, 19);
const wait = <T,>(v: T, ms = 350) => new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), ms));

const ACTIONS = ["site-info", "posts:list", "posts:update", "media:upload", "options:update", "snapshot:create", "plugins:toggle", "db:query", "fs:read", "woo:orders:list"];
const STATUSES = ["ok", "ok", "ok", "ok", "pending_approval", "ok", "denied", "ok", "ok", "error"];

export const demoAudit: AuditEntry[] = Array.from({ length: 48 }, (_, i) => ({
  id: 1000 - i,
  created_at: day(Math.floor(Math.sqrt(i * 5)), 8 + (i % 9)),
  key_id: i % 3 === 0 ? "bk_demo_agent" : "bk_demo_editor",
  action: ACTIONS[i % ACTIONS.length]!,
  status: STATUSES[i % STATUSES.length]!,
  ip: "203.0.113." + (10 + (i % 5)),
  params_hash: (i * 2654435761 >>> 0).toString(16).padStart(8, "0").repeat(8),
  summary: `Sample ${ACTIONS[i % ACTIONS.length]} event`,
}));

const site: SiteInfo = {
  site: { name: "Demo Store (sample)", url: "https://demo.example", wp_version: "6.8.3", php_version: "8.3.12", is_multisite: false, language: "en_US" },
  theme: { name: "Twenty Twenty-Five", version: "1.3", template: "twentytwentyfive" },
  plugins: [
    { file: "bridgistic/bridgistic.php", name: "Bridgistic", version: "1.5.3", active: true },
    { file: "woocommerce/woocommerce.php", name: "WooCommerce", version: "10.2.1", active: true },
    { file: "akismet/akismet.php", name: "Akismet Anti-spam", version: "5.5", active: false },
    { file: "wordpress-seo/wp-seo.php", name: "Yoast SEO", version: "26.1", active: true },
  ],
  detected: { woocommerce: true, woocommerce_version: "10.2.1", woocommerce_tools: true, elementor: false, acf: true },
  bridge: { version: "1.5.3", scopes: ["site:read", "posts:read", "posts:write", "media:write", "options:read", "snapshot:manage", "playbook:manage", "schedule:manage", "woo:orders:read", "woo:products:read"] },
};
const usage: UsageInfo = { tier: "custom", rate_limit: 120, monthly_quota: 5000, usage: { this_minute: 2, today: 64, this_month: 1312, top_actions: { "posts:list": 402, "site-info": 288, "posts:update": 190, "woo:orders:list": 151, "media:upload": 97, "snapshot:create": 61 } }, quota_remaining: 3688 };
const snaps: Snapshot[] = [
  { snapshot_id: "snp_demo_01", label: "Before homepage title change", type: "option", target: "blogname", byte_size: 312, key_id: "bk_demo_agent", created_at: day(0, 10), restored_at: null },
  { snapshot_id: "snp_demo_02", label: "Before post 42 update", type: "post", target: "42", byte_size: 18432, key_id: "bk_demo_editor", created_at: day(1, 14), restored_at: day(1, 15) },
  { snapshot_id: "snp_demo_03", label: "Before permalink change", type: "option", target: "permalink_structure", byte_size: 96, key_id: "bk_demo_agent", created_at: day(3, 9), restored_at: null },
];
const approvals: Approval[] = [
  { approval_id: "apr_demo_01", key_id: "bk_demo_agent", action: "plugins:toggle", request_hash: "9f2c".repeat(16), summary: "Deactivate akismet/akismet.php", status: "pending", created_at: day(0, 11), decided_at: null },
  { approval_id: "apr_demo_02", key_id: "bk_demo_agent", action: "db:write", request_hash: "1ab3".repeat(16), summary: "UPDATE wp_options SET … (1 row)", status: "pending", created_at: day(0, 9), decided_at: null },
  { approval_id: "apr_demo_03", key_id: "bk_demo_editor", action: "users:write", request_hash: "77de".repeat(16), summary: "Change role of user 7 to editor", status: "approved", created_at: day(2, 13), decided_at: day(2, 13) },
  { approval_id: "apr_demo_04", key_id: "bk_demo_agent", action: "php:execute", request_hash: "0c0c".repeat(16), summary: "Run 4-line PHP snippet", status: "denied", created_at: day(4, 16), decided_at: day(4, 17) },
];
const schedules: Schedule[] = [
  { schedule_id: "sch_demo_01", playbook_slug: "weekly-seo-audit", recurrence: "weekly", enabled: true, next_run: day(-3, 2), last_run: day(4, 2), last_status: "ok" },
  { schedule_id: "sch_demo_02", playbook_slug: "daily-order-digest", recurrence: "daily", enabled: false, next_run: null, last_run: day(6, 1), last_status: "error" },
];
const lists: Record<ListResource, Row[]> = {
  posts: [1, 2, 3, 4, 5].map((i) => ({ id: 40 + i, title: `Sample post ${i}`, status: i === 4 ? "draft" : "publish", type: "post", modified: day(i) })),
  media: [1, 2, 3].map((i) => ({ id: 90 + i, title: `sample-image-${i}.jpg`, mime_type: "image/jpeg", date: day(i * 2) })),
  users: [{ id: 1, login: "owner", role: "administrator" }, { id: 7, login: "editor-demo", role: "editor" }],
  plugins: site.plugins.map((p) => ({ ...p })),
  options: [{ option: "blogname", value: "Demo Store (sample)" }, { option: "blogdescription", value: "Sample tagline" }],
  memory: [{ key: "brand-voice", value: "Calm, precise, no exclamation marks" }],
  "woo/products": [1, 2, 3].map((i) => ({ id: 200 + i, name: `Sample product ${i}`, price: (i * 10 + 0.99).toFixed(2), stock_status: i === 3 ? "outofstock" : "instock" })),
  "woo/orders": [1, 2, 3, 4].map((i) => ({ id: 5000 + i, status: i === 2 ? "processing" : "completed", total: (i * 17.5).toFixed(2), date_created: day(i) })),
  "woo/customers": [{ id: 11, email: "customer@example.com", orders_count: 3 }],
  "woo/inventory": [{ id: 203, name: "Sample product 3", stock_quantity: 0 }],
};
let license: LicenseStatus = { connected: false, status: "free", plan: "free", key_mask: null, expires_at: null, validated_at: null, domain: null, entitlements: {} };

export class DemoClient implements BridgisticClient {
  readonly mode = "demo" as const;
  siteInfo() { return wait(site); }
  usage() { return wait(usage); }
  snapshots() { return wait(snaps); }
  createSnapshot(i: { target: string }) { return wait({ snapshot_id: "snp_demo_new", target: i.target }); }
  restoreSnapshot(id: string) { return wait({ restored: id }); }
  deleteSnapshot(id: string) { return wait({ deleted: id }); }
  approvalStatus(id: string) { return wait(approvals.find((a) => a.approval_id === id) ?? approvals[0]!); }
  approvals() { return wait(approvals); }
  audit() { return wait(demoAudit); }
  list(r: ListResource) { return wait(lists[r]); }
  playbooks() { return wait([{ slug: "weekly-seo-audit", name: "Weekly SEO audit", description: "Sample playbook", steps: [1, 2, 3] }, { slug: "daily-order-digest", name: "Daily order digest", description: "Sample playbook", steps: [1, 2] }]); }
  schedules() { return wait(schedules); }
  createSchedule(input: { playbook: string; recurrence: string }) { return wait({ schedule_id: "sch_demo_new", playbook_slug: input.playbook, recurrence: input.recurrence, enabled: true }); }
  memoryScan() { return wait({ category: "site_context", key: "context", saved: true }); }
  memoryImportUrl(url: string, key?: string) { return wait({ category: "custom", key: key || url, saved: true }); }
  memoryWrite(category: string, key: string) { return wait({ category, key, saved: true }); }
  toggleSchedule(id: string, enabled: boolean) { return wait({ schedule_id: id, enabled }); }
  runScheduleNow(id: string) { return wait({ schedule_id: id, queued: true }); }
  togglePlugin(file: string, active: boolean) { return wait({ plugin: file, approval_required: !active }); }
  fsList() { return wait([{ path: "wp-content/themes", type: "dir" }, { path: "wp-content/plugins", type: "dir" }, { path: "wp-config.php", type: "file (blocked)" }]); }
  dbQuery() { return wait([{ option_name: "blogname", option_value: "Demo Store (sample)" }]); }
  wooSalesSummary() { return wait({ period: "last 30 days (sample)", orders: 42, net_sales: "1,284.50", currency: "USD" }); }
  license() { return wait(license); }
  activateLicense(key: string) {
    license = { connected: true, status: "active", plan: "lifetime", key_mask: key.slice(0, 6) + "…" + key.slice(-4), expires_at: null, validated_at: new Date().toISOString(), domain: "demo.example", entitlements: { "bridgistic.plan": "lifetime" } };
    return wait(license, 700);
  }
  deactivateLicense() { license = { ...license, connected: false, status: "free", plan: "free", key_mask: null }; return wait(license); }
  validateLicense() { return wait({ ...license, validated_at: new Date().toISOString() }); }
}
