import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Resource } from "../components/Resource.tsx";
import { Card, ComingSoonPanel, PageHeader, Stat } from "../components/ui.tsx";
import { fmtNum } from "../lib/format.ts";

export function Usage() {
  return (
    <div className="space-y-6">
      <PageHeader title="Usage" description="Request counts for the connected key, as metered by the plugin." />
      <Resource load={(c) => c.usage()}>
        {(u) => (<>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <Stat label="This minute" value={fmtNum(u.usage.this_minute)} hint={`limit ${u.rate_limit}/min`} />
            <Stat label="Today (UTC)" value={fmtNum(u.usage.today)} delay={0.05} />
            <Stat label="This month" value={fmtNum(u.usage.this_month)} delay={0.1} />
            <Stat label="Quota remaining" value={u.quota_remaining === null ? "No quota" : fmtNum(u.quota_remaining)} delay={0.15} />
          </div>
          <Card><h2 className="text-sm font-semibold">Top actions this month</h2>
            <div className="mt-4 h-72"><ResponsiveContainer><BarChart data={Object.entries(u.usage.top_actions).map(([action, count]) => ({ action, count }))}>
              <XAxis dataKey="action" tick={{ fontSize: 11 }} /><YAxis allowDecimals={false} tick={{ fontSize: 11 }} width={36} /><Tooltip /><Bar dataKey="count" fill="#1F8A70" radius={[6, 6, 0, 0]} animationDuration={900} />
            </BarChart></ResponsiveContainer></div></Card>
        </>)}
      </Resource>
      <ComingSoonPanel title="Usage across all sites and team members" body="Aggregated metering, alerts at 80% of quota, and invoices." />
    </div>
  );
}
