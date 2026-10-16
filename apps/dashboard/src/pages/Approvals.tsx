import { ExternalLink, Search } from "lucide-react";
import { useState } from "react";
import { Resource } from "../components/Resource.tsx";
import { Badge, Card, DataTable, PageHeader } from "../components/ui.tsx";
import { fmtTime, shortHash } from "../lib/format.ts";
import { useStore } from "../lib/store.tsx";
import type { Approval } from "../lib/api/types.ts";

const TABS = ["pending", "approved", "denied", "all"] as const;

export function Approvals() {
  const { sites, activeId, client } = useStore();
  const site = sites.find((s) => s.id === activeId);
  const [tab, setTab] = useState<(typeof TABS)[number]>("pending");
  const [lookup, setLookup] = useState("");
  const [found, setFound] = useState<Approval | null | "err">(null);
  return (
    <div className="space-y-6">
      <PageHeader title="Approvals" description="Destructive actions wait here until a WordPress administrator approves them. Decisions are made in WP Admin, so an AI key can never approve its own request."
        actions={site && <a className="btn-primary" href={`${site.siteUrl}/wp-admin/admin.php?page=bridgistic-approvals`} target="_blank" rel="noreferrer">Review in WP Admin <ExternalLink className="h-4 w-4" aria-hidden /></a>} />
      <div role="tablist" aria-label="Filter approvals" className="flex gap-1 rounded-xl bg-white p-1 ring-1 ring-navy/10 w-fit">
        {TABS.map((t) => <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`rounded-lg px-3 py-1.5 text-sm capitalize ${tab === t ? "bg-navy text-ivory" : "text-navy/70 hover:bg-navy/5"}`}>{t}</button>)}
      </div>
      <Resource load={(c) => c.approvals()} empty={{ title: "No approvals", body: "Nothing is waiting for a decision." }}>
        {(rows) => {
          const list = tab === "all" ? rows : rows.filter((r) => r.status === tab);
          return (
            <Card>
              {list.length === 0 ? <p className="py-8 text-center text-sm text-navy/55">No {tab} approvals.</p> :
                <DataTable caption="Approvals" rows={list as unknown as Record<string, unknown>[]} columns={["summary", "action", "key_id", "status", "created_at", "request_hash"]}
                  render={{ status: (v) => <Badge>{String(v)}</Badge>, created_at: (v) => fmtTime(String(v)), request_hash: (v) => <code className="text-xs">{shortHash(String(v))}</code>, action: (v) => <code className="text-xs">{String(v)}</code> }} />}
            </Card>);
        }}
      </Resource>
      <Card>
        <h2 className="text-sm font-semibold">Check one approval</h2>
        <p className="text-xs text-navy/55">Uses GET approvals/status, available on every plugin version.</p>
        <form className="mt-3 flex gap-2" onSubmit={async (e) => { e.preventDefault(); if (!client) return; try { setFound(await client.approvalStatus(lookup.trim())); } catch { setFound("err"); } }}>
          <input className="input" value={lookup} onChange={(e) => setLookup(e.target.value)} placeholder="Approval ID" aria-label="Approval ID" />
          <button className="btn-ghost"><Search className="h-4 w-4" aria-hidden />Check</button>
        </form>
        {found === "err" && <p className="mt-2 text-sm text-red-800">Not found, or it belongs to another key.</p>}
        {found && found !== "err" && <p className="mt-2 text-sm">Status: <Badge>{found.status}</Badge> {found.summary}</p>}
      </Card>
    </div>
  );
}
