import { AnimatePresence, motion } from "framer-motion";
import { Plus, RotateCcw, Trash2 } from "lucide-react";
import { useState } from "react";
import { Resource } from "../components/Resource.tsx";
import { Badge, Card, PageHeader } from "../components/ui.tsx";
import { fmtBytes, fmtTime } from "../lib/format.ts";
import { useStore } from "../lib/store.tsx";

export function Snapshots() {
  const { client } = useStore();
  const [confirm, setConfirm] = useState<{ id: string; kind: "restore" | "delete" } | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [form, setForm] = useState({ type: "option" as "option" | "post", target: "", label: "" });
  const [tick, setTick] = useState(0);
  return (
    <div className="space-y-6">
      <PageHeader title="Snapshots" description="Point-in-time copies taken before changes. Restore rolls the target back; nothing else is touched." />
      <Card>
        <form className="flex flex-wrap items-end gap-2" onSubmit={async (e) => { e.preventDefault(); if (!client) return; if (form.type === "post" && !/^\d+$/.test(form.target.trim())) { setMsg("Enter a numeric post ID."); return; } try { await client.createSnapshot(form); setMsg("Snapshot created."); setForm({ ...form, target: "", label: "" }); setTick((t) => t + 1); } catch (x) { setMsg(x instanceof Error ? x.message : String(x)); } }}>
          <label><span className="label">Type</span><select className="input" value={form.type} onChange={(e) => setForm({ ...form, type: e.target.value as "option" | "post" })}><option value="option">option</option><option value="post">post</option></select></label>
          <label className="flex-1"><span className="label">Target</span><input required className="input" value={form.target} onChange={(e) => setForm({ ...form, target: e.target.value })} placeholder="Option name or post ID" /></label>
          <label className="flex-1"><span className="label">Label</span><input className="input" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} /></label>
          <button className="btn-primary"><Plus className="h-4 w-4" aria-hidden />Take snapshot</button>
        </form>
        {msg && <p className="mt-3 text-sm text-teal" role="status">{msg}</p>}
      </Card>
      <Resource load={(c) => c.snapshots()} deps={[tick]} empty={{ title: "No snapshots", body: "Snapshots are taken automatically before supported changes, or manually above." }}>
        {(rows, st) => (
          <ol className="relative space-y-3 border-l-2 border-navy/10 pl-6">
            {rows.map((s, i) => (
              <motion.li key={s.snapshot_id} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.05 }} className="card relative p-4">
                <span className={`absolute -left-[33px] top-5 h-3 w-3 rounded-full ring-4 ring-ivory ${s.restored_at ? "bg-gold" : "bg-teal"}`} aria-hidden />
                <div className="flex flex-wrap items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{s.label || s.snapshot_id}</p>
                    <p className="text-xs text-navy/55">{fmtTime(s.created_at)} · {s.type} {s.target ? `· ${fmtTarget(s.target)}` : ""} · {fmtBytes(s.byte_size)} · key {s.key_id}</p>
                  </div>
                  {s.restored_at && <Badge tone="pending">restored {fmtTime(s.restored_at)}</Badge>}
                  <button className="btn-ghost" onClick={() => setConfirm({ id: s.snapshot_id, kind: "restore" })}><RotateCcw className="h-4 w-4" aria-hidden />Restore</button>
                  <button className="btn-danger" aria-label="Delete snapshot" onClick={() => setConfirm({ id: s.snapshot_id, kind: "delete" })}><Trash2 className="h-4 w-4" aria-hidden /></button>
                </div>
                <AnimatePresence>{confirm?.id === s.snapshot_id && (
                  <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="mt-3 flex items-center gap-2 overflow-hidden rounded-xl bg-ivory p-3 text-sm" role="alertdialog" aria-label="Confirm">
                    <span className="flex-1">{confirm.kind === "restore" ? "Restore this snapshot over the current value?" : "Delete this snapshot permanently?"}</span>
                    <button className="btn-ghost" onClick={() => setConfirm(null)}>Cancel</button>
                    <button className={confirm.kind === "delete" ? "btn-danger" : "btn-primary"} onClick={async () => { if (!client) return; await (confirm.kind === "restore" ? client.restoreSnapshot(s.snapshot_id) : client.deleteSnapshot(s.snapshot_id)); setConfirm(null); st.reload(); }}>Confirm</button>
                  </motion.div>)}</AnimatePresence>
              </motion.li>))}
          </ol>)}
      </Resource>
    </div>
  );
}

/** The plugin stores target as JSON, e.g. {"name":"blogname"} or {"id":12}. */
export function fmtTarget(t: unknown): string {
  try {
    const o = typeof t === "string" ? JSON.parse(t) : t;
    if (o && typeof o === "object") return Object.values(o as Record<string, unknown>).map(String).join(", ");
  } catch { /* plain string */ }
  return String(t);
}
