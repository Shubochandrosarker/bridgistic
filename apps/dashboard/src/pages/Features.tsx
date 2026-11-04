import { Play, Power } from "lucide-react";
import { useState } from "react";

import { Resource } from "../components/Resource.tsx";
import { Badge, Card, ComingSoonPanel, DataTable, ErrorState, PageHeader, Skeleton, Stat } from "../components/ui.tsx";
import type { ListResource } from "../lib/api/client.ts";
import { ApiError } from "../lib/api/errors.ts";
import type { Row } from "../lib/api/types.ts";
import { fmtTime } from "../lib/format.ts";
import { useStore } from "../lib/store.tsx";

function ListPage({ title, description, resource, scope, soon }: { title: string; description: string; resource: ListResource; scope: string; soon?: { title: string; body: string } }) {
  return (
    <div className="space-y-6">
      <PageHeader title={title} description={description} badge={<code className="rounded bg-white px-2 py-0.5 text-xs ring-1 ring-navy/10">{scope}</code>} />
      <Resource load={(c) => c.list(resource)} empty={{ title: `No ${title.toLowerCase()} found` }}>
        {(rows) => <Card><DataTable caption={title} rows={rows} /></Card>}
      </Resource>
      {soon && <ComingSoonPanel {...soon} />}
    </div>
  );
}

export const Posts = () => <ListPage title="Posts & pages" resource="posts" scope="posts:read" description="Content on the connected site. Edits made by an agent are snapshotted first." soon={{ title: "Visual diff before publish", body: "Side-by-side preview of agent edits against the snapshot." }} />;
export const Media = () => <ListPage title="Media" resource="media" scope="media:write" description="Media library items reachable through the bridge." />;
export const UsersPage = () => <ListPage title="Users" resource="users" scope="users:read" description="WordPress users. Role and account changes are approval-gated." />;
export const Options = () => <ListPage title="Options" resource="options" scope="options:read" description="Allow-listed site options. Updates take a snapshot first." />;
export const Memory = () => <ListPage title="Memory" resource="memory" scope="memory:read" description="Notes the agent keeps on this site between sessions." />;

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
      <ComingSoonPanel title="Plugin updates and vulnerability alerts" body="Update available, changelog and known-vulnerability flags per plugin." />
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
      <ComingSoonPanel title="Saved queries and schema browser" body="Named, shareable read-only queries with a table browser." />
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
      <ComingSoonPanel title="Playbook library" body="Curated, versioned playbooks you can install with one click." />
    </div>
  );
}

export function Schedules() {
  const { client } = useStore();
  return (
    <div className="space-y-6">
      <PageHeader title="Schedules" description="Playbooks that run on a recurrence via WP-Cron on the site." badge={<code className="rounded bg-white px-2 py-0.5 text-xs ring-1 ring-navy/10">schedule:manage</code>} />
      <Resource load={(c) => c.schedules()} empty={{ title: "No schedules" }}>
        {(rows, st) => <Card><DataTable caption="Schedules" rows={rows as unknown as Row[]} columns={["playbook_slug", "recurrence", "enabled", "next_run", "last_run", "last_status", "schedule_id"]}
          render={{ next_run: (v) => fmtTime(v as string), last_run: (v) => fmtTime(v as string), last_status: (v) => v ? <Badge>{String(v)}</Badge> : "—", enabled: (v) => <Badge tone={v ? "ok" : undefined}>{v ? "on" : "off"}</Badge>,
            schedule_id: (v, r) => <span className="flex gap-1"><button className="btn-ghost px-2 py-1 text-xs" onClick={async () => { await client?.toggleSchedule(String(v), !r.enabled); st.reload(); }}>{r.enabled ? "Pause" : "Resume"}</button><button className="btn-ghost px-2 py-1 text-xs" onClick={async () => { await client?.runScheduleNow(String(v)); st.reload(); }}>Run now</button></span> }} /></Card>}
      </Resource>
      <ComingSoonPanel title="Managed cloud scheduler" body="Runs that do not depend on site traffic, with catch-up and overlap policy, from the hosted scheduler." />
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
      <ChartsSoon />
    </div>
  );
}
function ChartsSoon() {
  return <ComingSoonPanel title="Revenue trends and cohort charts" body="Daily revenue, refunds and repeat-customer charts across stores." />;
}
