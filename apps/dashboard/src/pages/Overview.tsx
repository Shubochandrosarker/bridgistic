import { Bar, BarChart, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis, Area, AreaChart, CartesianGrid } from "recharts";
import { Link } from "react-router-dom";
import { Resource } from "../components/Resource.tsx";
import { Badge, Card, ErrorState, PageHeader, Skeleton, Stat } from "../components/ui.tsx";
import { fmtNum } from "../lib/format.ts";
import { useStore } from "../lib/store.tsx";
import { useAsync } from "../lib/useAsync.ts";
import type { AuditEntry } from "../lib/api/types.ts";

const COLORS = ["#0B1F3A", "#1F8A70", "#C6A15B", "#2A4D7E", "#7FA9C9", "#B9B2A3"];

export function byDay(entries: AuditEntry[]) {
  const m = new Map<string, number>();
  for (const e of entries) { const d = e.created_at.slice(0, 10); m.set(d, (m.get(d) ?? 0) + 1); }
  return [...m.entries()].sort().map(([day, count]) => ({ day: day.slice(5), count }));
}
export function byStatus(entries: AuditEntry[]) {
  const m = new Map<string, number>();
  for (const e of entries) m.set(e.status, (m.get(e.status) ?? 0) + 1);
  return [...m.entries()].map(([name, value]) => ({ name, value }));
}

function ActivityCharts() {
  const { client } = useStore();
  const a = useAsync(client ? () => client.audit() : null, [client]);
  if (a.loading) return <Card className="lg:col-span-2"><Skeleton rows={5} /></Card>;
  if (a.error) return <Card className="lg:col-span-2"><ErrorState error={a.error} onRetry={a.reload} /></Card>;
  const entries = a.data ?? [];
  return (<>
    <Card className="lg:col-span-2" delay={0.1}>
      <h2 className="text-sm font-semibold text-navy">Actions per day</h2>
      <p className="text-xs text-navy/55">From the site audit log ({entries.length} most recent entries)</p>
      <div className="mt-4 h-56">
        <ResponsiveContainer><AreaChart data={byDay(entries)}>
          <defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor="#1F8A70" stopOpacity={0.35} /><stop offset="100%" stopColor="#1F8A70" stopOpacity={0} /></linearGradient></defs>
          <CartesianGrid stroke="#0B1F3A10" vertical={false} /><XAxis dataKey="day" tick={{ fontSize: 11 }} /><YAxis allowDecimals={false} tick={{ fontSize: 11 }} width={28} /><Tooltip />
          <Area type="monotone" dataKey="count" stroke="#1F8A70" strokeWidth={2} fill="url(#g)" animationDuration={900} />
        </AreaChart></ResponsiveContainer>
      </div>
    </Card>
    <Card delay={0.15}>
      <h2 className="text-sm font-semibold text-navy">Outcomes</h2>
      <p className="text-xs text-navy/55">Audit entries by status</p>
      <div className="mt-2 h-56"><ResponsiveContainer><PieChart>
        <Pie data={byStatus(entries)} dataKey="value" nameKey="name" innerRadius={50} outerRadius={80} paddingAngle={2} animationDuration={900}>
          {byStatus(entries).map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
        </Pie><Tooltip /></PieChart></ResponsiveContainer></div>
      <ul className="flex flex-wrap gap-2">{byStatus(entries).map((s, i) => <li key={s.name} className="flex items-center gap-1 text-xs"><span className="h-2 w-2 rounded-full" style={{ background: COLORS[i % COLORS.length] }} />{s.name} {s.value}</li>)}</ul>
    </Card>
  </>);
}

export function Overview() {
  return (
    <div>
      <PageHeader title="Overview" description="Health, usage and recent activity for the connected site." />
      <Resource load={(c) => Promise.all([c.siteInfo(), c.usage()])}>
        {([site, usage]) => {
          const top = Object.entries(usage.usage.top_actions).map(([action, count]) => ({ action, count }));
          const pct = usage.monthly_quota > 0 ? Math.round((usage.usage.this_month / usage.monthly_quota) * 100) : null;
          return (
            <div className="space-y-6">
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                <Stat label="Requests today" value={fmtNum(usage.usage.today)} hint="This key, UTC day" />
                <Stat label="Requests this month" value={fmtNum(usage.usage.this_month)} hint={usage.monthly_quota > 0 ? `of ${fmtNum(usage.monthly_quota)} quota` : "No monthly quota set"} delay={0.05} />
                <Stat label="Rate limit" value={`${usage.rate_limit}/min`} hint={`Tier: ${usage.tier}`} delay={0.1} />
                <Stat label="Bridge version" value={site.bridge.version} hint={`WordPress ${site.site.wp_version} · PHP ${site.site.php_version}`} delay={0.15} />
              </div>
              {pct !== null && (
                <Card><div className="flex items-center justify-between text-sm"><span className="font-medium">Monthly quota</span><span className="tabular-nums text-navy/60">{pct}%</span></div>
                  <div className="mt-2 h-2 overflow-hidden rounded-full bg-navy/10" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
                    <div className={`h-full rounded-full transition-all duration-700 ${pct >= 80 ? "bg-gold" : "bg-teal"}`} style={{ width: `${Math.min(pct, 100)}%` }} />
                  </div></Card>
              )}
              <div className="grid gap-4 lg:grid-cols-3"><ActivityCharts /></div>
              <div className="grid gap-4 lg:grid-cols-3">
                <Card className="lg:col-span-2">
                  <h2 className="text-sm font-semibold">Top actions this month</h2>
                  <div className="mt-4 h-60">{top.length ? <ResponsiveContainer><BarChart data={top} layout="vertical" margin={{ left: 40 }}>
                    <XAxis type="number" allowDecimals={false} tick={{ fontSize: 11 }} /><YAxis type="category" dataKey="action" tick={{ fontSize: 11 }} width={110} interval={0} /><Tooltip />
                    <Bar dataKey="count" fill="#0B1F3A" radius={[0, 6, 6, 0]} animationDuration={900} /></BarChart></ResponsiveContainer>
                    : <p className="text-sm text-navy/55">No actions recorded this month.</p>}</div>
                </Card>
                <Card>
                  <h2 className="text-sm font-semibold">Site</h2>
                  <dl className="mt-3 space-y-2 text-sm">
                    {[["Name", site.site.name], ["URL", site.site.url], ["Theme", `${site.theme.name} ${site.theme.version}`], ["Plugins", `${site.plugins.filter((p) => p.active).length} active of ${site.plugins.length}`], ["Language", site.site.language]].map(([k, v]) => (
                      <div key={k} className="flex justify-between gap-3"><dt className="text-navy/55">{k}</dt><dd className="truncate text-right">{v}</dd></div>))}
                  </dl>
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {Object.entries(site.detected).filter(([k, v]) => v === true && k !== "woocommerce_tools").map(([k]) => <Badge key={k} tone="ok">{k}</Badge>)}
                  </div>
                  <Link to="/keys" className="mt-4 inline-block text-sm text-teal underline-offset-2 hover:underline">{site.bridge.scopes.length} scopes on this key</Link>
                </Card>
              </div>
            </div>
          );
        }}
      </Resource>
    </div>
  );
}
