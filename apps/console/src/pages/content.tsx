/** Content & site screens — all read live through the signed site proxy. */

import { useEffect, useState } from "react";
import { fmtDateTime, siteCall, type SiteRow } from "../lib/api";
import { Badge, Btn, Card, PageHead, inputClass, useToast, Toast, Table, Td } from "../components/ui";
import { RequireSite, SiteList, SitePicker, type Row } from "../components/sitelist";

export function Posts() {
  return (
    <>
      <PageHead title="Posts & pages" sub="Live from the connected site." actions={<SitePicker />} />
      <RequireSite>
        {() => (
          <SiteList
            route="posts?per_page=30"
            head={["Title", "Type", "Status", "Modified"]}
            cell={(row, key) => {
              if (key === "Status") return <Badge tone={row.status === "publish" ? "good" : "neutral"}>{String(row.status ?? "")}</Badge>;
              if (key === "Modified") return fmtDateTime(String(row.modified ?? ""));
              return <span>{String(row[key.toLowerCase()] ?? "")}</span>;
            }}
          />
        )}
      </RequireSite>
    </>
  );
}

export function Media() {
  return (
    <>
      <PageHead title="Media" sub="Attachments in the media library." actions={<SitePicker />} />
      <RequireSite>
        {() => (
          <SiteList
            route="media?per_page=30"
            head={["Title", "MIME", "Size"]}
            cell={(row, key) => {
              if (key === "Size") return `${Number(row.bytes ?? 0)} bytes`;
              return <span>{String(row[key.toLowerCase()] ?? "")}</span>;
            }}
          />
        )}
      </RequireSite>
    </>
  );
}

export function SiteUsers() {
  return (
    <>
      <PageHead title="Users" sub="WordPress accounts on the connected site." actions={<SitePicker />} />
      <RequireSite>
        {() => (
          <SiteList route="users?per_page=30" head={["Name", "Email", "Role"]} cell={(row, key) => <span>{String(row[key.toLowerCase()] ?? "")}</span>} />
        )}
      </RequireSite>
    </>
  );
}

export function Plugins() {
  const [toast, showToast] = useToast();
  return (
    <>
      <PageHead title="Plugins" sub="Toggling queues an approval — nothing changes without a person." actions={<SitePicker />} />
      <RequireSite>
        {(site) => (
          <>
            <SiteList
              route="plugins"
              head={["Plugin", "Version", "Active", ""]}
              cell={(row, key) => {
                if (key === "Active") return <Badge tone={row.active ? "good" : "neutral"}>{row.active ? "active" : "inactive"}</Badge>;
                if (key === "") {
                  return (
                    <Btn
                      small
                      variant="ghost"
                      onClick={() =>
                        void (async () => {
                          try {
                            await siteCall(site.id, "POST", "plugins/toggle", { plugin: row.file, state: row.active ? "deactivate" : "activate" });
                            showToast("Sent to the approval queue.");
                          } catch (e) {
                            showToast(e instanceof Error ? e.message : "The site refused the toggle.");
                          }
                        })()
                      }
                    >
                      {row.active ? "Deactivate" : "Activate"}
                    </Btn>
                  );
                }
                return <span>{String(row[key.toLowerCase()] ?? row.name ?? "")}</span>;
              }}
            />
            <Toast message={toast} />
          </>
        )}
      </RequireSite>
    </>
  );
}

const DEFAULT_OPTIONS = ["blogname", "blogdescription", "date_format", "time_format", "start_of_week", "posts_per_page", "show_on_front", "page_on_front", "page_for_posts", "default_comment_status", "timezone_string"];

export function Options() {
  return (
    <>
      <PageHead title="Options" sub="Reads use the plugin's allowlist; writes are approval-gated." actions={<SitePicker />} />
      <RequireSite>
        {(site) => <OptionsList siteId={site.id} />}
      </RequireSite>
    </>
  );
}

function OptionsList({ siteId }: { siteId: string }) {
  const [rows, setRows] = useState<{ option: string; value: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let live = true;
    void (async () => {
      const settled = await Promise.allSettled(
        DEFAULT_OPTIONS.map((n) => siteCall<Row>(siteId, "GET", `options?name=${encodeURIComponent(n)}`))
      );
      if (!live) return;
      const found = settled.flatMap((r) =>
        r.status === "fulfilled" && r.value && r.value.exists !== false ? [{ option: String(r.value.name ?? ""), value: String(r.value.value ?? "") }] : []
      );
      setRows(found);
      setLoaded(true);
      const firstErr = settled.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (!found.length && firstErr) setError(firstErr.reason instanceof Error ? firstErr.reason.message : "Options read failed.");
    })();
    return () => {
      live = false;
    };
  }, [siteId]);
  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (!loaded) return <p className="text-sm text-navy/50">Reading the site's options…</p>;
  if (rows.length === 0) return <p className="text-sm text-navy/50">No allow-listed options were returned.</p>;
  return (
    <Table head={["Option", "Value"]}>
      {rows.map((r) => (
        <tr key={r.option}>
          <Td className="font-mono text-xs">{r.option}</Td>
          <Td>{r.value}</Td>
        </tr>
      ))}
    </Table>
  );
}

export function FilesScreen() {
  const [path, setPath] = useState("");
  const [submitted, setSubmitted] = useState(".");
  return (
    <>
      <PageHead title="Files" sub="Browse inside ABSPATH. Writes require fs:write and an approval." actions={<SitePicker />} />
      <RequireSite>
        {(site) => (
          <>
            <div className="mb-3 flex gap-2">
              <input
                className={inputClass}
                value={path}
                onChange={(e) => setPath(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && setSubmitted(path || ".")}
                placeholder="wp-content/plugins"
              />
              <Btn variant="ghost" onClick={() => setSubmitted(path || ".")}>Browse</Btn>
            </div>
            <FileList siteId={site.id} path={submitted} />
          </>
        )}
      </RequireSite>
    </>
  );
}

function FileList({ siteId, path }: { siteId: string; path: string }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const list = await siteCall<unknown>(siteId, "POST", "fs/list", { path });
        if (live) {
          setRows(Array.isArray(list) ? (list as Row[]) : []);
          setError(null);
        }
      } catch (e) {
        if (live) setError(e instanceof Error ? e.message : "Listing failed.");
      }
    })();
    return () => {
      live = false;
    };
  }, [siteId, path]);
  if (error) return <p className="text-sm text-red-600">{error}</p>;
  if (rows === null) return <p className="text-sm text-navy/50">Listing…</p>;
  if (rows.length === 0) return <p className="text-sm text-navy/50">The directory is empty or unreadable with this key.</p>;
  return (
    <Table head={["Name", "Type"]}>
      {rows.map((r, i) => (
        <tr key={i}>
          <Td className="font-mono text-xs">{String(r.name ?? r.path ?? r.file ?? "")}</Td>
          <Td>{r.type === "d" || r.isdir === true || r.is_dir === true ? "directory" : "file"}</Td>
        </tr>
      ))}
    </Table>
  );
}

export function DatabaseScreen() {
  const [sql, setSql] = useState("SELECT ID, post_title, post_status FROM wp_posts ORDER BY post_date DESC LIMIT 20");
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <>
      <PageHead title="Database" sub="Read-only SELECT through db:read. Writes are approval-gated." actions={<SitePicker />} />
      <RequireSite>
        {(site: SiteRow) => (
          <>
            <Card className="mb-4 p-4">
              <textarea className={`${inputClass} font-mono text-xs`} rows={4} value={sql} onChange={(e) => setSql(e.target.value)} />
              <div className="mt-3">
                <Btn
                  disabled={busy || !sql.trim()}
                  onClick={() =>
                    void (async () => {
                      setBusy(true);
                      setError(null);
                      try {
                        const result = await siteCall<unknown>(site.id, "POST", "db/query", { sql });
                        setRows((Array.isArray(result) ? result : [result]) as Row[]);
                      } catch (e) {
                        setError(e instanceof Error ? e.message : "Query failed.");
                        setRows(null);
                      } finally {
                        setBusy(false);
                      }
                    })()
                  }
                >
                  {busy ? "Running…" : "Run query"}
                </Btn>
              </div>
              {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
            </Card>
            {rows && rows.length > 0 && (
              <div className="overflow-x-auto rounded-xl border border-navy/10 bg-white">
                <table className="w-full text-left text-sm">
                  <thead>
                    <tr className="border-b border-navy/10 bg-navy/[0.03]">
                      {Object.keys(rows[0]).map((h) => (
                        <th key={h} className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-navy/50">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-navy/5">
                    {rows.slice(0, 50).map((row, i) => (
                      <tr key={i}>
                        {Object.keys(rows[0]).map((h) => (
                          <Td key={h} className="max-w-[280px] truncate font-mono text-xs">{String(row[h] ?? "")}</Td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {rows && rows.length === 0 && <p className="text-sm text-navy/50">The query returned no rows.</p>}
          </>
        )}
      </RequireSite>
    </>
  );
}
