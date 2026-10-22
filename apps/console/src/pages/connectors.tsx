/** Connectors: MCP servers, social drafts, the WordPress bridge. */

import { useSession } from "../lib/session";
import { Badge, Btn, Card, PageHead } from "../components/ui";

export function Connectors() {
  const { sites } = useSession();
  const site = sites[0];
  return (
    <>
      <PageHead title="MCP servers" sub="Point any MCP client at your site — Claude, Codex, Gemini, ChatGPT." />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-5">
          <h2 className="mb-2 text-sm font-bold text-navy">Hosted endpoint (beta)</h2>
          <p className="text-sm text-navy/60">The managed cloud relay for ChatGPT and other hosted clients.</p>
          <code className="mt-2 block rounded-lg bg-navy/[0.05] px-3 py-2 font-mono text-xs">https://mcp.bridgistic.app/mcp</code>
          <Badge tone="warn">needs a cloud token</Badge>
        </Card>
        <Card className="p-5">
          <h2 className="mb-2 text-sm font-bold text-navy">Local bridge (free)</h2>
          <p className="text-sm text-navy/60">
            Install the free plugin, mint a scoped key in WP Admin, and connect Claude Desktop with the one-click <code className="font-mono text-xs">.mcpb</code> from bridgistic.app.
          </p>
          <a href="https://bridgistic.app/" target="_blank" rel="noreferrer">
            <Btn small variant="ghost" className="mt-2">Get the plugin</Btn>
          </a>
        </Card>
        {site && (
          <Card className="p-5 lg:col-span-2">
            <h2 className="mb-2 text-sm font-bold text-navy">This site's bridge</h2>
            <code className="block rounded-lg bg-navy/[0.05] px-3 py-2 font-mono text-xs">{site.url}/wp-json/bridgistic/v1/</code>
            <p className="mt-2 text-xs text-navy/50">Signed with key {site.key_mask} · scopes: {(Array.isArray(site.scopes) ? site.scopes : []).join(", ") || "unknown"}</p>
          </Card>
        )}
      </div>
    </>
  );
}

export function Social() {
  return (
    <>
      <PageHead title="Social drafts" sub="The social agent drafts; publishing stays a draft unless you flip the switch." />
      <Card className="p-6 text-center text-sm text-navy/50">
        Social publishing is a coming-soon line. Drafts you generate in the Social agent stay here as text until the publisher ships.
      </Card>
    </>
  );
}

export function Bridge() {
  const { sites } = useSession();
  return (
    <>
      <PageHead title="WordPress bridge" sub="The signed path between this console and your sites." />
      <div className="space-y-3">
        {sites.length === 0 && <Card className="p-6 text-center text-sm text-navy/50">No sites yet — connect one under Sites.</Card>}
        {sites.map((s) => (
          <Card key={s.id} className="flex items-center justify-between p-4">
            <div>
              <div className="text-sm font-bold text-navy">{s.name}</div>
              <div className="text-xs text-navy/50">{s.url}</div>
            </div>
            <div className="flex items-center gap-2">
              <Badge tone="good">HMAC-SHA256</Badge>
              <Badge tone="neutral">{(Array.isArray(s.scopes) ? s.scopes : []).length} scopes</Badge>
            </div>
          </Card>
        ))}
      </div>
    </>
  );
}
