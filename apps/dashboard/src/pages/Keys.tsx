import { ExternalLink } from "lucide-react";
import { Resource } from "../components/Resource.tsx";
import { Badge, Card, PageHeader } from "../components/ui.tsx";
import { SCOPES } from "../lib/scopes.ts";
import { useStore } from "../lib/store.tsx";

export function Keys() {
  const { sites, activeId } = useStore();
  const site = sites.find((s) => s.id === activeId);
  return (
    <div className="space-y-6">
      <PageHeader title="Keys & scopes" description="What the connected key may do. Keys are minted, rotated and revoked in WP Admin, so a key can never widen its own access." actions={site && <a className="btn-ghost" href={`${site.siteUrl}/wp-admin/admin.php?page=bridgistic-keys`} target="_blank" rel="noreferrer">Manage keys in WP Admin <ExternalLink className="h-4 w-4" aria-hidden /></a>} />
      <Resource load={(c) => c.siteInfo()}>
        {(info) => {
          const granted = new Set(info.bridge.scopes);
          return (
            <Card>
              <p className="mb-4 text-sm text-navy/65">{granted.size} of {SCOPES.length} scopes granted to this key. Secrets are never displayed after creation.</p>
              <ul className="grid gap-2 md:grid-cols-2">
                {SCOPES.map((s) => (
                  <li key={s.id} className={`flex items-start gap-3 rounded-xl p-3 ring-1 ${granted.has(s.id) ? "bg-teal-soft/40 ring-teal/25" : "ring-navy/10"}`}>
                    <code className="mt-0.5 shrink-0 rounded bg-white px-1.5 text-xs">{s.id}</code>
                    <span className="flex-1 text-sm text-navy/75">{s.desc}{s.risk && <span className="ml-1 text-xs text-[#7a5f2b]">({s.risk})</span>}</span>
                    <Badge tone={granted.has(s.id) ? "ok" : undefined}>{granted.has(s.id) ? "granted" : "not granted"}</Badge>
                  </li>))}
              </ul>
            </Card>);
        }}
      </Resource>
    </div>
  );
}
