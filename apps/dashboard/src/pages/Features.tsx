import { Brain, Link2, Play, Power, RefreshCw, Upload } from "lucide-react";
import { useEffect, useState } from "react";

import { Resource } from "../components/Resource.tsx";
import { Badge, Card, DataTable, EmptyState, ErrorState, PageHeader, Skeleton, Stat } from "../components/ui.tsx";
import type { ListResource } from "../lib/api/client.ts";
import { ApiError } from "../lib/api/errors.ts";
import type { Playbook, Row } from "../lib/api/types.ts";
import { fmtTime } from "../lib/format.ts";
import { useStore } from "../lib/store.tsx";
import { useAsync } from "../lib/useAsync.ts";

function ListPage({ title, description, resource, scope }: { title: string; description: string; resource: ListResource; scope: string }) {
  return (
    <div className="space-y-6">
      <PageHeader title={title} description={description} badge={<code className="rounded bg-white px-2 py-0.5 text-xs ring-1 ring-navy/10">{scope}</code>} />
      <Resource load={(c) => c.list(resource)} empty={{ title: `No ${title.toLowerCase()} found` }}>
        {(rows) => <Card><DataTable caption={title} rows={rows} /></Card>}
      </Resource>
    </div>
  );
}

export const Posts = () => <ListPage title="Posts & pages" resource="posts" scope="posts:read" description="Content on the connected site. Edits made by an agent are snapshotted first." />;
export const Media = () => <ListPage title="Media" resource="media" scope="media:write" description="Media library items reachable through the bridge." />;
export const UsersPage = () => <ListPage title="Users" resource="users" scope="users:read" description="WordPress users. Role and account changes are approval-gated." />;
export const Options = () => <ListPage title="Options" resource="options" scope="options:read" description="Allow-listed site options. Updates take a snapshot first." />;
export function Memory() {
  const { client } = useStore();
  const st = useAsync(client ? () => client.list("memory") : null, [client]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [url, setUrl] = useState("");

  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true); setMessage(null);
    try { await action(); setMessage(success); st.reload(); }
    catch (e) { setMessage(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };

  const importFile = async (file: File) => {
    const text = await file.text();
    const key = file.name.replace(/\.(md|markdown|txt)$/i, "").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "uploaded-context";
    if (!client || !text.trim()) return;
    void run(() => client.memoryWrite("custom", key, { filename: file.name, content: text }), `Saved ${file.name} to site memory.`);
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Memory" description="Build a durable context layer for your AI agents from the connected site's public context and your own notes." badge={<code className="rounded bg-white px-2 py-0.5 text-xs ring-1 ring-navy/10">memory:read / write</code>} />
      {message && <p role="status" className="rounded-xl bg-gold/15 p-3 text-sm text-navy/80">{message}</p>}
      {!client ? <Card><EmptyState title="No site connected" body="Connect a site from the Sites screen to scan its context." /></Card> : (
        <Card>
          <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
            <div className="flex items-start gap-3">
              <div className="rounded-2xl bg-teal-soft p-3 text-teal"><Brain className="h-5 w-5" aria-hidden /></div>
              <div><h2 className="font-semibold">Refresh site context</h2><p className="mt-1 max-w-2xl text-sm text-navy/65">Scans llms.txt, llms-full.txt, sitemap.xml, WordPress, theme and plugin context, then stores the result on this site. Run it again after major content changes.</p></div>
            </div>
            <button className="btn-primary shrink-0" disabled={busy} onClick={() => void run(() => client.memoryScan(), "Site context scan complete.")}><RefreshCw className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} aria-hidden />{busy ? "Scanning…" : "Run memory scan"}</button>
          </div>
          <div className="mt-5 grid gap-3 border-t border-navy/8 pt-5 md:grid-cols-2">
            <label className="flex items-center gap-2 rounded-xl border border-navy/10 bg-ivory/50 p-3"><Link2 className="h-4 w-4 text-teal" aria-hidden /><span className="sr-only">Public context URL</span><input className="min-w-0 flex-1 bg-transparent text-sm outline-none" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Public URL or direct Google Drive export URL" /><button type="button" className="btn-ghost px-2 py-1 text-xs" disabled={busy || !url.trim()} onClick={() => void run(() => client.memoryImportUrl(url.trim()), "Public URL imported into memory.")}>Import</button></label>
            <label className="flex cursor-pointer items-center gap-2 rounded-xl border border-dashed border-navy/15 bg-ivory/50 p-3 text-sm text-navy/70 hover:border-teal"><Upload className="h-4 w-4 text-teal" aria-hidden /><span className="flex-1"><strong className="text-navy">Add .md or .txt</strong><span className="ml-1">from your computer</span></span><input className="sr-only" type="file" accept=".md,.markdown,.txt,text/markdown,text/plain" disabled={busy} onChange={(e) => { const file = e.target.files?.[0]; if (file) void importFile(file); e.currentTarget.value = ""; }} /></label>
          </div>
        </Card>
      )}
      {client && st.loading && !st.data ? <Card><Skeleton /></Card> : st.error ? <Card><ErrorState error={st.error} onRetry={st.reload} /></Card> : st.data && st.data.length > 0 ? <Card><DataTable caption="Memory" rows={st.data} /></Card> : client ? <Card><EmptyState title="No memory saved yet" body="Run the site context scan or add a public URL, Markdown file or text file above." /></Card> : null}
    </div>
  );
}

export function Plugins() {
  const { client } = useStore();
  const [note, setNote] = useState<string | null>(null);
  return (
    <div className="space-y-6">
      <PageHeader title="Plugins" description="Installed plugins. Activating or deactivating goes through the approval queue." badge={<code className="rounded bg-white px-2 py-0.5 text-xs ring-1 ring-navy/10">plugins:manage</code>} />
      {note && <p role="status" className="rounded-xl bg-gold/15 p-3 text-sm">{note}</p>}
      <Resource load={(c) => c.siteInfo()}>
        {(info) => (
          <Card><ul className="divide-y divide-navy/5">
            {info.plugins.map((p) => (
              <li key={p.file} className="flex items-center gap-3 py-3">
                <div className="min-w-0 flex-1"><p className="font-medium">{p.name} <span className="text-xs text-navy/50">{p.version}</span></p><p className="truncate text-xs text-navy/50">{p.file}</p></div>
                <Badge tone={p.active ? "ok" : undefined}>{p.active ? "active" : "inactive"}</Badge>
                {p.file !== "bridgistic/bridgistic.php" && <button className="btn-ghost" onClick={async () => { if (!client) return; try { await client.togglePlugin(p.file, !p.active); setNote(`Request sent for ${p.name}. If approval is required it now waits in Approvals.`); } catch (e) { setNote(e instanceof Error ? e.message : String(e)); } }}><Power className="h-4 w-4" aria-hidden />{p.active ? "Deactivate" : "Activate"}</button>}
              </li>))}
          </ul></Card>)}
      </Resource>
    </div>
  );
}

export function Files() {
  const { client } = useStore();
  const [path, setPath] = useState("wp-content");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const go = async () => { if (!client) return; setLoading(true); setErr(null); try { setRows(await client.fsList(path)); } catch (e) { setErr(e as ApiError); } finally { setLoading(false); } };
  return (
    <div className="space-y-6">
      <PageHeader title="Files" description="Browse files inside the plugin's sandbox. wp-config.php and paths outside the allowed roots are refused by the plugin." badge={<code className="rounded bg-white px-2 py-0.5 text-xs ring-1 ring-navy/10">fs:read</code>} />
      <Card>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void go(); }}><input className="input font-mono" value={path} onChange={(e) => setPath(e.target.value)} aria-label="Path" /><button className="btn-primary">List</button></form>
        <div className="mt-4">{loading ? <Skeleton /> : err ? <ErrorState error={err} /> : rows && <DataTable caption="Files" rows={rows} />}</div>
      </Card>
    </div>
  );
}

export function Database() {
  const { client } = useStore();
  const [sql, setSql] = useState("SELECT option_name, option_value FROM wp_options WHERE option_name = 'blogname'");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  return (
    <div className="space-y-6">
      <PageHeader title="Database" description="Read-only queries need db:read. Anything that writes is classified by the plugin and sent to the approval queue." badge={<code className="rounded bg-white px-2 py-0.5 text-xs ring-1 ring-navy/10">db:read</code>} />
      <Card>
        <label><span className="label">SQL</span><textarea className="input min-h-28 font-mono" value={sql} onChange={(e) => setSql(e.target.value)} /></label>
        <button className="btn-primary mt-3" onClick={async () => { if (!client) return; setErr(null); try { setRows(await client.dbQuery(sql)); } catch (e) { setErr(e as ApiError); } }}><Play className="h-4 w-4" aria-hidden />Run</button>
        <div className="mt-4">{err ? <ErrorState error={err} /> : rows && <DataTable caption="Result" rows={rows} />}</div>
      </Card>
    </div>
  );
}

export function Playbooks() {
  return (
    <div className="space-y-6">
      <PageHeader title="Playbooks" description="Reusable multi-step routines an agent can run on this site." badge={<code className="rounded bg-white px-2 py-0.5 text-xs ring-1 ring-navy/10">playbook:manage</code>} />
      <Resource load={(c) => c.playbooks()} empty={{ title: "No playbooks", body: "Create one from your AI client or in WP Admin → Bridgistic → Playbooks." }}>
        {(rows) => <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{rows.map((p, i) => (
          <Card key={p.slug} delay={i * 0.04}><p className="font-medium">{p.name ?? p.slug}</p><code className="text-xs text-navy/50">{p.slug}</code><p className="mt-2 text-sm text-navy/65">{p.description}</p>{Array.isArray(p.steps) && <p className="mt-3 text-xs text-navy/55">{p.steps.length} steps</p>}</Card>))}</div>}
      </Resource>
    </div>
  );
}

export function Schedules() {
  const { client } = useStore();
  const [playbooks, setPlaybooks] = useState<Playbook[]>([]);
  const [selected, setSelected] = useState("");
  const [recurrence, setRecurrence] = useState("daily");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let live = true;
    if (!client) { setPlaybooks([]); return () => { live = false; }; }
    void client.playbooks().then((items) => { if (live) { setPlaybooks(items); setSelected((current) => current || items[0]?.slug || ""); } }).catch(() => { if (live) setPlaybooks([]); });
    return () => { live = false; };
  }, [client]);
  const create = async () => {
    if (!client || !selected) return;
    setBusy(true); setMessage(null);
    try { await client.createSchedule({ playbook: selected, recurrence }); setMessage("Schedule created and registered with WP-Cron."); setRefresh((value) => value + 1); }
    catch (e) { setMessage(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  return (
    <div className="space-y-6">
      <PageHeader title="Schedules" description="Playbooks that run on a recurrence via WP-Cron on the site." badge={<code className="rounded bg-white px-2 py-0.5 text-xs ring-1 ring-navy/10">schedule:manage</code>} />
      {client && <Card>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <label className="flex-1"><span className="label">Playbook</span><select className="input" value={selected} onChange={(e) => setSelected(e.target.value)} disabled={!playbooks.length}><option value="">{playbooks.length ? "Choose a playbook" : "Load playbooks first"}</option>{playbooks.map((p) => <option key={p.slug} value={p.slug}>{p.name ?? p.slug}</option>)}</select></label>
          <label><span className="label">Recurrence</span><select className="input" value={recurrence} onChange={(e) => setRecurrence(e.target.value)}><option value="bridgistic_5min">Every 5 minutes</option><option value="bridgistic_15min">Every 15 minutes</option><option value="bridgistic_30min">Every 30 minutes</option><option value="hourly">Hourly</option><option value="daily">Daily</option><option value="weekly">Weekly</option></select></label>
          <button className="btn-primary" disabled={busy || !selected} onClick={() => void create()}><Play className="h-4 w-4" aria-hidden />{busy ? "Creating…" : "Create schedule"}</button>
        </div>
        {message && <p role="status" className="mt-3 text-sm text-navy/70">{message}</p>}
      </Card>}
      <Resource load={(c) => c.schedules()} deps={[refresh]} empty={{ title: "No schedules" }}>
        {(rows, st) => <Card><DataTable caption="Schedules" rows={rows as unknown as Row[]} columns={["playbook_slug", "recurrence", "enabled", "next_run", "last_run", "last_status", "schedule_id"]}
          render={{ next_run: (v) => fmtTime(v as string), last_run: (v) => fmtTime(v as string), last_status: (v) => v ? <Badge>{String(v)}</Badge> : "—", enabled: (v) => <Badge tone={v ? "ok" : undefined}>{v ? "on" : "off"}</Badge>,
            schedule_id: (v, r) => <span className="flex gap-1"><button className="btn-ghost px-2 py-1 text-xs" onClick={async () => { await client?.toggleSchedule(String(v), !r.enabled); st.reload(); }}>{r.enabled ? "Pause" : "Resume"}</button><button className="btn-ghost px-2 py-1 text-xs" onClick={async () => { await client?.runScheduleNow(String(v)); st.reload(); }}>Run now</button></span> }} /></Card>}
      </Resource>
    </div>
  );
}

export function WooCommerce() {
  const [tab, setTab] = useState<ListResource>("woo/orders");
  return (
    <div className="space-y-6">
      <PageHeader title="WooCommerce" description="Store data through the structured WooCommerce tools. Shown only when WooCommerce is active." />
      <Resource load={(c) => c.wooSalesSummary()} isEmpty={() => false}>
        {(s) => <div className="grid gap-4 sm:grid-cols-3">{Object.entries(s).filter(([, v]) => typeof v !== "object").slice(0, 3).map(([k, v], i) => <Stat key={k} label={k.replace(/_/g, " ")} value={String(v)} delay={i * 0.05} />)}</div>}
      </Resource>
      <div role="tablist" className="flex w-fit gap-1 rounded-xl bg-white p-1 ring-1 ring-navy/10">
        {(["woo/orders", "woo/products", "woo/customers", "woo/inventory"] as const).map((t) => <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`rounded-lg px-3 py-1.5 text-sm capitalize ${tab === t ? "bg-navy text-ivory" : "text-navy/70"}`}>{t.slice(4)}</button>)}
      </div>
      <Resource load={(c) => c.list(tab)} deps={[tab]}>{(rows) => <Card><DataTable caption={tab} rows={rows} /></Card>}</Resource>
    </div>
  );
}
