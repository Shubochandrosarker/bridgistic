/**
 * Actions: run one catalogued operation on a connected site.
 *
 * The catalog comes from the API (lib/actions.ts owns it), so the browser can
 * only offer what the server can actually dispatch, and every run — success,
 * site refusal or approval queue — comes back with a row in the run log.
 */

import { useCallback, useEffect, useState } from "react";
import { ApiError, api, fmtDateTime, type SiteRow } from "../lib/api";
import { Badge, Btn, Card, ErrorNote, Field, PageHead, Spinner, Table, Td, inputClass } from "../components/ui";
import { RequireSite, SitePicker } from "../components/sitelist";

interface ActionField {
  name: string;
  label: string;
  type?: "text" | "textarea" | "number" | "select";
  required?: boolean;
  options?: { value: string; label: string }[];
  placeholder?: string;
  hint?: string;
  default?: string;
}

interface ActionInfo {
  id: string;
  domain: "content" | "media" | "plugins" | "site" | "woo";
  label: string;
  description: string;
  method: "GET" | "POST" | "DELETE";
  fields: ActionField[];
  destructive?: boolean;
}

interface RunRow {
  id: string;
  site_id: string;
  action: string;
  status: "ok" | "queued" | "error";
  duration_ms: number;
  error: string;
  created_at: string;
}

const DOMAINS: { id: ActionInfo["domain"]; title: string; sub: string }[] = [
  { id: "content", title: "Content", sub: "Posts and pages on the site." },
  { id: "media", title: "Media", sub: "The media library." },
  { id: "plugins", title: "Plugins", sub: "Installed plugins and their state." },
  { id: "site", title: "Site", sub: "Site details and allow-listed options." },
  { id: "woo", title: "WooCommerce", sub: "Products and orders, when the store is active." },
];

function defaults(fields: ActionField[]): Record<string, string> {
  return Object.fromEntries(fields.map((f) => [f.name, f.default ?? ""]));
}

export function Actions() {
  return (
    <>
      <PageHead
        title="Actions"
        sub="Run one operation on a connected site. Every attempt is signed, scoped and logged."
        actions={<SitePicker />}
      />
      <RequireSite>{(site) => <ActionsBody site={site} />}</RequireSite>
    </>
  );
}

function ActionsBody({ site }: { site: SiteRow }) {
  const [actions, setActions] = useState<ActionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let live = true;
    api
      .get<{ actions: ActionInfo[] }>("/api/actions")
      .then((r) => live && setActions(r.actions))
      .catch((e) => live && setError(e instanceof Error ? e.message : "Could not load the action catalog."));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    let live = true;
    api
      .get<{ runs: RunRow[] }>(`/api/actions/runs?site_id=${encodeURIComponent(site.id)}`)
      .then((r) => live && setRuns(r.runs))
      .catch(() => live && setRuns([]));
    return () => {
      live = false;
    };
  }, [site.id, refresh]);

  if (error) return <ErrorNote error={error} />;
  if (!actions) return <Spinner label="Loading actions…" />;

  const onLogged = () => setRefresh((n) => n + 1);
  const byId = new Map(actions.map((a) => [a.id, a]));

  return (
    <div className="space-y-8">
      {actions.length === 0 && <p className="text-sm text-navy/60">No actions are available.</p>}
      {DOMAINS.map((domain) => {
        const list = actions.filter((a) => a.domain === domain.id);
        if (list.length === 0) return null;
        return (
          <section key={domain.id}>
            <h2 className="text-sm font-bold uppercase tracking-wide text-navy/70">{domain.title}</h2>
            <p className="mb-3 text-xs text-navy/50">{domain.sub}</p>
            <div className="grid gap-4 md:grid-cols-2">
              {list.map((action) => (
                <ActionCard key={action.id} action={action} site={site} onLogged={onLogged} />
              ))}
            </div>
          </section>
        );
      })}

      <section>
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-navy/70">Recent runs on this site</h2>
        {runs === null ? (
          <Spinner label="Loading runs…" />
        ) : (
          <Table head={["When", "Action", "Status", "Duration", "Detail"]} empty={runs.length === 0}>
            {runs.map((run) => (
              <tr key={run.id}>
                <Td className="whitespace-nowrap text-xs text-navy/60">{fmtDateTime(run.created_at)}</Td>
                <Td className="text-xs">{byId.get(run.action)?.label ?? run.action}</Td>
                <Td>
                  <StatusBadge status={run.status} />
                </Td>
                <Td className="text-xs text-navy/60">{run.duration_ms} ms</Td>
                <Td className="max-w-[24rem] truncate text-xs text-red-700">{run.error || "—"}</Td>
              </tr>
            ))}
          </Table>
        )}
      </section>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  if (status === "ok") return <Badge tone="good">done</Badge>;
  if (status === "queued") return <Badge tone="warn">awaiting approval</Badge>;
  return <Badge tone="bad">failed</Badge>;
}

function ActionCard({ action, site, onLogged }: { action: ActionInfo; site: SiteRow; onLogged: () => void }) {
  const [values, setValues] = useState<Record<string, string>>(() => defaults(action.fields));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ status: string; data: unknown; duration_ms: number } | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const response = await api.post<{ status: string; data: unknown; duration_ms: number }>("/api/actions/run", {
        site_id: site.id,
        action: action.id,
        params: values,
      });
      setResult(response);
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : "The action failed.");
    } finally {
      setBusy(false);
      onLogged();
    }
  };

  const rendered = result ? JSON.stringify(result.data, null, 2) : "";
  return (
    <Card className="flex flex-col p-4">
      <div className="flex items-start justify-between gap-2">
        <div>
          <h3 className="text-sm font-bold text-navy">{action.label}</h3>
          <p className="mt-0.5 text-xs text-navy/60">{action.description}</p>
        </div>
        <span className="shrink-0 rounded bg-navy/5 px-1.5 py-0.5 font-mono text-[10px] uppercase text-navy/50">{action.method}</span>
      </div>

      {action.fields.length > 0 && (
        <div className="mt-3 space-y-2.5">
          {action.fields.map((field) => (
            <Field key={field.name} label={field.required ? `${field.label} *` : field.label} hint={field.hint}>
              {field.type === "textarea" ? (
                <textarea
                  rows={3}
                  className={inputClass}
                  value={values[field.name] ?? ""}
                  placeholder={field.placeholder}
                  onChange={(e) => setValues({ ...values, [field.name]: e.target.value })}
                />
              ) : field.type === "select" ? (
                <select
                  className={inputClass}
                  value={values[field.name] ?? ""}
                  onChange={(e) => setValues({ ...values, [field.name]: e.target.value })}
                >
                  {!field.required && <option value="">Leave unchanged</option>}
                  {(field.options ?? []).map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  type={field.type === "number" ? "number" : "text"}
                  min={field.type === "number" ? 1 : undefined}
                  className={inputClass}
                  value={values[field.name] ?? ""}
                  placeholder={field.placeholder}
                  onChange={(e) => setValues({ ...values, [field.name]: e.target.value })}
                />
              )}
            </Field>
          ))}
        </div>
      )}

      {action.destructive && (
        <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Changes live state. Sites with an approval requirement hold the call until an administrator confirms it.
        </p>
      )}

      <div className="mt-3 flex items-center gap-2">
        <Btn small onClick={() => void run()} disabled={busy}>
          {busy ? "Running…" : "Execute"}
        </Btn>
        <span className="truncate text-[11px] text-navy/40">
          {action.method} {new URL(site.url).hostname}
        </span>
      </div>

      {error && <p className="mt-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{error}</p>}

      {result && (
        <div className="mt-3 rounded-lg border border-navy/10 bg-navy/[0.02] p-3">
          <div className="mb-1.5 flex items-center gap-2 text-xs text-navy/60">
            <StatusBadge status={result.status} />
            <span>{result.duration_ms} ms</span>
          </div>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-navy/80">
            {rendered.length > 4000 ? `${rendered.slice(0, 4000)}\n…` : rendered}
          </pre>
        </div>
      )}
    </Card>
  );
}
