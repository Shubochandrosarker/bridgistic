/** Shared plumbing for site-backed list screens. */

import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { api, fmtDateTime, siteCall, type SiteRow } from "../lib/api";
import { useSession, useCurrentSite } from "../lib/session";
import { Badge, Btn, Card, ErrorNote, Field, inputClass, Modal, PageHead, Spinner, Table, Td, Toast, useToast } from "./ui";

export type Row = Record<string, unknown>;
export type Rows = Row[];

export function SitePicker() {
  const { sites } = useSession();
  const [site, setSite] = useCurrentSite();
  if (sites.length === 0) return null;
  return (
    <select value={site?.id ?? ""} onChange={(e) => setSite(e.target.value)} className="rounded-lg border border-navy/15 bg-white px-3 py-1.5 text-sm">
      {sites.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name || new URL(s.url).hostname}
        </option>
      ))}
    </select>
  );
}

export function RequireSite({ children }: { children: (site: SiteRow) => ReactNode }) {
  const { sites } = useSession();
  const [site, setSite] = useCurrentSite();
  if (sites.length === 0) {
    return (
      <Card className="p-8 text-center">
        <p className="font-semibold text-navy">No site is connected to this workspace yet.</p>
        <p className="mx-auto mt-1 max-w-md text-sm text-navy/60">
          Connect a WordPress site with a scoped key from its WP Admin → Bridgistic. Every call is signed, scoped, approved and reversible.
        </p>
        <Link to="/sites">
          <Btn className="mt-4">Connect a site</Btn>
        </Link>
      </Card>
    );
  }
  if (!site) return <Spinner />;
  return (
    <>
      <div className="mb-4 flex items-center justify-end">
        <SitePicker />
      </div>
      {children(site)}
    </>
  );
}

/** A list fetched with GET route from the current site, rendered as a table. */
export function SiteList(opts: {
  route: string;
  head: string[];
  cell: (row: Row, key: string) => ReactNode;
  pick?: (payload: unknown) => Rows;
  refreshKey?: unknown;
}) {
  const [rows, setRows] = useState<Rows | null>(null);
  const [error, setError] = useState<string | null>(null);
  const siteRef = useCurrentSite();
  const load = useCallback(
    async (site: SiteRow) => {
      setError(null);
      try {
        const payload = await siteCall<unknown>(site.id, "GET", opts.route);
        let list: Rows;
        if (Array.isArray(payload)) list = payload as Rows;
        else if (payload && typeof payload === "object") {
          const firstArray = Object.values(payload).find((v) => Array.isArray(v));
          list = (firstArray as Rows | undefined) ?? [payload as Row];
        } else list = [];
        setRows(opts.pick ? opts.pick(list) : list);
      } catch (e) {
        setError(e instanceof Error ? e.message : "The site call failed.");
        setRows([]);
      }
    },
    [opts.route, opts.pick]
  );
  useEffect(() => {
    if (siteRef[0]) void load(siteRef[0]);
  }, [load, siteRef[0], opts.refreshKey]);
  if (error) return <ErrorNote error={error} />;
  if (rows === null) return <Spinner />;
  return (
    <Table head={opts.head} empty={rows.length === 0}>
      {rows.map((row, i) => (
        <tr key={i} className="hover:bg-navy/[0.02]">
          {opts.head.map((h) => (
            <Td key={h}>{opts.cell(row, h)}</Td>
          ))}
        </tr>
      ))}
    </Table>
  );
}

export { Badge, Btn, Card, ErrorNote, Field, inputClass, Modal, PageHead, Spinner, Table, Td, Toast, useToast, fmtDateTime, api, siteCall, useSession, useCurrentSite };
