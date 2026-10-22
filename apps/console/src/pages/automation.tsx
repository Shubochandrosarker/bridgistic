/** Automation screens: playbooks, schedules, memory, WooCommerce. */

import { useEffect, useState } from "react";
import { siteCall } from "../lib/api";
import { Badge, Btn, PageHead, Stat, Toast, useToast } from "../components/ui";
import { RequireSite, SiteList, SitePicker, type Row } from "../components/sitelist";

export function Playbooks() {
  return (
    <>
      <PageHead title="Playbooks" sub="Reusable step lists the bridge runs on the site." actions={<SitePicker />} />
      <RequireSite>
        {() => (
          <SiteList
            route="playbooks"
            head={["Name", "Slug", "Steps", ""]}
            cell={(row, key) => {
              if (key === "Name") return <span className="font-semibold">{String(row.name ?? row.title ?? "—")}</span>;
              if (key === "Slug") return <span className="font-mono text-xs">{String(row.slug ?? "")}</span>;
              if (key === "Steps") return String(Array.isArray(row.steps) ? row.steps.length : row.steps ?? "—");
              return null;
            }}
          />
        )}
      </RequireSite>
    </>
  );
}

export function Schedules() {
  const [toast, showToast] = useToast();
  return (
    <>
      <PageHead title="Schedules" sub="A live license opens unlimited schedules on the site." actions={<SitePicker />} />
      <RequireSite>
        {(site) => (
          <>
            <SiteList
              route="schedules"
              head={["Name", "Recurrence", "Enabled", ""]}
              cell={(row, key) => {
                if (key === "Enabled") return <Badge tone={row.enabled ? "good" : "neutral"}>{row.enabled ? "on" : "paused"}</Badge>;
                if (key === "") {
                  return (
                    <div className="flex gap-1.5">
                      <Btn small variant="ghost" onClick={() => void (async () => {
                        try {
                          await siteCall(site.id, "POST", "schedules/toggle", { schedule_id: row.id, enabled: !row.enabled });
                          showToast(row.enabled ? "Paused." : "Resumed.");
                        } catch (e) {
                          showToast(e instanceof Error ? e.message : "Toggle failed.");
                        }
                      })()}>{row.enabled ? "Pause" : "Resume"}</Btn>
                      <Btn small variant="ghost" onClick={() => void (async () => {
                        try {
                          await siteCall(site.id, "POST", "schedules/run-now", { schedule_id: row.id });
                          showToast("Run started on the site.");
                        } catch (e) {
                          showToast(e instanceof Error ? e.message : "Run failed.");
                        }
                      })()}>Run now</Btn>
                    </div>
                  );
                }
                return <span>{String(row[key.toLowerCase()] ?? row.name ?? "")}</span>;
              }}
            />
            <Toast message={toast} />
          </>
        )}
      </RequireSite>
    </>
  );
}

export function Memory() {
  return (
    <>
      <PageHead title="Memory" sub="Facts the agents remember about this site." actions={<SitePicker />} />
      <RequireSite>
        {() => (
          <SiteList
            route="memory"
            head={["Key", "Value", "Updated"]}
            cell={(row, key) => {
              if (key === "Updated") return String(row.updated_at ?? row.created_at ?? "—");
              return <span className={key === "Key" ? "font-mono text-xs" : ""}>{String(row[key.toLowerCase()] ?? "")}</span>;
            }}
          />
        )}
      </RequireSite>
    </>
  );
}

export function WooCommerce() {
  const [summary, setSummary] = useState<Row | null>(null);
  return (
    <>
      <PageHead title="WooCommerce" sub="Orders, products, customers and stock on the connected store." actions={<SitePicker />} />
      <RequireSite>
        {(site) => (
          <WooBody
            siteId={site.id}
            onSummary={(s) => setSummary(s)}
          />
        )}
      </RequireSite>
      {summary && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="Period" value={String(summary.period ?? "—")} />
          <Stat label="Orders" value={String(summary.orders ?? "—")} />
          <Stat label="Revenue" value={String(summary.gross_revenue ?? "—")} />
          <Stat label="Avg order" value={String(summary.average_order_value ?? "—")} />
        </div>
      )}
    </>
  );
}

function WooBody({ siteId, onSummary }: { siteId: string; onSummary: (s: Row) => void }) {
  const [tab, setTab] = useState<"orders" | "products" | "customers" | "inventory">("orders");
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    if (loaded) return;
    void (async () => {
      try {
        const s = await siteCall<Row>(siteId, "GET", "woo/sales-summary");
        const cur = String(s.currency ?? "");
        onSummary({
          period: `Last ${String(s.period_days ?? 30)} days`,
          orders: Number(s.order_count ?? 0),
          gross_revenue: `${Number(s.gross_revenue ?? 0).toFixed(2)} ${cur}`,
          average_order_value: `${Number(s.average_order_value ?? 0).toFixed(2)} ${cur}`,
        });
      } catch {
        onSummary({});
      } finally {
        setLoaded(true);
      }
    })();
  }, [siteId, loaded, onSummary]);
  const tabs = ["orders", "products", "customers", "inventory"] as const;
  return (
    <>
      <div className="mb-3 flex gap-1">
        {tabs.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded-lg px-3 py-1.5 text-sm capitalize ${tab === t ? "bg-navy font-semibold text-white" : "text-navy/60 hover:bg-navy/5"}`}
          >
            {t}
          </button>
        ))}
      </div>
      {tab === "inventory" ? (
        <SiteList
          route="woo/inventory"
          head={["Product", "Stock", "State"]}
          cell={(row, key) => {
            if (key === "State") return <Badge tone={row.stock_state === "out of stock" ? "bad" : "warn"}>{String(row.stock_state ?? "")}</Badge>;
            return <span>{String(row[key.toLowerCase()] ?? "")}</span>;
          }}
          pick={(payload) => {
            const data = payload as { out_of_stock?: Row[]; low_stock?: Row[] };
            const list = payload as Row[];
            if (Array.isArray(list) && list.length && (list[0].stock_state !== undefined || list[0].out_of_stock === undefined)) return list;
            return [
              ...(data.out_of_stock ?? []).map((r) => ({ ...r, stock_state: "out of stock" })),
              ...(data.low_stock ?? []).map((r) => ({ ...r, stock_state: "low stock" })),
            ];
          }}
        />
      ) : (
        <SiteList
          route={`woo/${tab}?per_page=20`}
          head={headFor(tab)}
          cell={(row, key) => {
            if (key === "Total") return String(row.total ?? "");
            if (key === "Status") return <Badge tone={row.status === "completed" || row.status === "publish" ? "good" : "neutral"}>{String(row.status ?? "")}</Badge>;
            if (key === "Stock") return String(row.stock_quantity ?? row.stock ?? "—");
            return <span>{String(row[key.toLowerCase()] ?? row.name ?? "")}</span>;
          }}
        />
      )}
    </>
  );
}

function headFor(tab: "orders" | "products" | "customers" | "inventory"): string[] {
  if (tab === "orders") return ["Number", "Name", "Status", "Total"];
  if (tab === "products") return ["Name", "SKU", "Price", "Stock"];
  return ["Name", "Email", "Spent"];
}
