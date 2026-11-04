import { Download } from "lucide-react";
import { useMemo, useState } from "react";
import { Resource } from "../components/Resource.tsx";
import { Badge, Card, DataTable, PageHeader } from "../components/ui.tsx";
import { fmtTime, shortHash } from "../lib/format.ts";
import type { AuditEntry } from "../lib/api/types.ts";

export function toCsv(rows: AuditEntry[]): string {
  const cols = ["id", "created_at", "key_id", "action", "status", "params_hash", "summary"] as const;
  const esc = (v: unknown) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  return [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n");
}

function AuditTable({ rows }: { rows: AuditEntry[] }) {
  const [q, setQ] = useState(""); const [status, setStatus] = useState("all");
  const statuses = useMemo(() => ["all", ...new Set(rows.map((r) => r.status))], [rows]);
  const list = rows.filter((r) => (status === "all" || r.status === status) && (q === "" || `${r.action} ${r.key_id} ${r.summary ?? ""}`.toLowerCase().includes(q.toLowerCase())));
  const download = () => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([toCsv(list)], { type: "text/csv" })); a.download = "bridgistic-audit.csv"; a.click(); };
  return (
    <Card>
      <div className="mb-4 flex flex-wrap gap-2">
        <input className="input max-w-xs" placeholder="Search action, key, summary" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search audit log" />
        <select className="input w-40" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status filter">{statuses.map((s) => <option key={s}>{s}</option>)}</select>
        <button className="btn-ghost ml-auto" onClick={download}><Download className="h-4 w-4" aria-hidden />CSV ({list.length})</button>
      </div>
      <DataTable caption="Audit log" rows={list as unknown as Record<string, unknown>[]} columns={["created_at", "action", "status", "key_id", "summary", "params_hash"]}
        render={{ created_at: (v) => <span className="whitespace-nowrap">{fmtTime(String(v))}</span>, status: (v) => <Badge>{String(v)}</Badge>, action: (v) => <code className="text-xs">{String(v)}</code>, params_hash: (v) => <code className="text-xs text-navy/50" title="SHA-256 of the request parameters. Arguments are never stored.">{shortHash(String(v))}</code> }} />
    </Card>);
}

export function Audit() {
  return (
    <div className="space-y-6">
      <PageHeader title="Audit log" description="Every bridge action with its key, outcome and a digest of its parameters. Arguments themselves are never stored, so they cannot be shown." />
      <Resource load={(c) => c.audit()} empty={{ title: "No audit entries yet" }}>{(rows) => <AuditTable rows={rows} />}</Resource>
    </div>
  );
}
