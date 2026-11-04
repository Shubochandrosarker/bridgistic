export interface RoadmapItem { title: string; body: string; area: "Addons" | "Advanced tools" | "Specialised agent" | "Platform"; stage: "Planned" | "Exploring" }
/** Future work only. Nothing here is functional. No dates are promised. */
export const ROADMAP: RoadmapItem[] = [
  { area: "Addons", stage: "Planned", title: "SEO addon", body: "Structured SEO audits and fixes across posts, with snapshots." },
  { area: "Addons", stage: "Planned", title: "Forms and leads addon", body: "Read form entries from popular form plugins through scoped tools." },
  { area: "Addons", stage: "Exploring", title: "Page builder addon", body: "Safe, structured edits for Elementor and block layouts." },
  { area: "Advanced tools", stage: "Planned", title: "Bulk operations", body: "Run one change across many sites with per-site approval." },
  { area: "Advanced tools", stage: "Planned", title: "Visual diff and staged publish", body: "Preview agent edits against the last snapshot before they go live." },
  { area: "Advanced tools", stage: "Exploring", title: "Uptime and health monitoring", body: "Scheduled checks with alerts by email." },
  { area: "Specialised agent", stage: "Planned", title: "WordPress maintenance agent", body: "A purpose-built agent for updates, backups and routine fixes, working inside your scopes and approvals." },
  { area: "Specialised agent", stage: "Exploring", title: "Store operations agent", body: "Order follow-up, stock alerts and product hygiene for WooCommerce." },
  { area: "Platform", stage: "Planned", title: "Hosted accounts and teams", body: "Sign in, invite teammates, roles, and saved site connections." },
  { area: "Platform", stage: "Planned", title: "Managed cloud scheduler", body: "Schedules that run independently of site traffic." },
];
