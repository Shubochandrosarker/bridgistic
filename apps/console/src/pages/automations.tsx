/**
 * Automations: the AI agent registry.
 *
 * Cards come from GET /api/agents (D1 `agents` plus this person's last run).
 * A run opens a modal for site + parameters, POSTs to /api/agents/{slug}/run and
 * shows the answer it got back — or the exact reason there wasn't one.
 */

import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { ApiError, api, fmtDateTime } from "../lib/api";
import { Badge, Btn, Card, ErrorNote, Field, Modal, PageHead, Spinner, Table, Td, inputClass } from "../components/ui";
import { useCurrentSite, useSession } from "../lib/session";

interface AgentField {
  name: string;
  label: string;
  type?: "text" | "textarea" | "number" | "select";
  required?: boolean;
  options?: { value: string; label: string }[];
  placeholder?: string;
  hint?: string;
  default?: string;
}

interface AgentInfo {
  slug: string;
  name: string;
  description: string;
  category: string;
  enabled: boolean;
  last_status: string | null;
  last_run_at: string | null;
  params: AgentField[];
}

interface RunRow {
  id: string;
  agent_slug: string;
  site_id: string;
  status: "ok" | "error";
  output_excerpt: string;
  duration_ms: number;
  error: string;
  created_at: string;
}

function defaults(fields: AgentField[]): Record<string, string> {
  return Object.fromEntries(fields.map((f) => [f.name, f.default ?? ""]));
}

export function Automations() {
  const [agents, setAgents] = useState<AgentInfo[] | null>(null);
  const [runs, setRuns] = useState<RunRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [active, setActive] = useState<AgentInfo | null>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let live = true;
    void Promise.all([api.get<{ agents: AgentInfo[] }>("/api/agents"), api.get<{ runs: RunRow[] }>("/api/agents/runs")])
      .then(([a, r]) => {
        if (!live) return;
        setAgents(a.agents);
        setRuns(r.runs);
      })
      .catch((e) => live && setError(e instanceof Error ? e.message : "Could not load the agent registry."));
    return () => {
      live = false;
    };
  }, [refresh]);

  const reload = useCallback(() => setRefresh((n) => n + 1), []);
  const nameOf = (slug: string) => agents?.find((a) => a.slug === slug)?.name ?? slug;

  if (error) return <ErrorNote error={error} />;
  if (!agents) return <Spinner label="Loading agents…" />;

  return (
    <>
      <PageHead
        title="Automations"
        sub="Specialized agents that read a connected site and return a plan, a draft or a fix — saved to your run history."
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {agents.map((agent) => (
          <Card key={agent.slug} className="flex flex-col p-4">
            <div className="flex items-start justify-between gap-2">
              <h3 className="text-sm font-bold text-navy">{agent.name}</h3>
              {agent.enabled ? <Badge tone="gold">{agent.category}</Badge> : <Badge>planned</Badge>}
            </div>
            <p className="mt-1 flex-1 text-xs text-navy/60">{agent.description}</p>
            <div className="mt-3 flex items-center gap-2 text-[11px] text-navy/50">
              {agent.last_status ? (
                <>
                  <Badge tone={agent.last_status === "ok" ? "good" : "bad"}>last run {agent.last_status}</Badge>
                  <span>{fmtDateTime(agent.last_run_at)}</span>
                </>
              ) : (
                <span>Never run.</span>
              )}
            </div>
            <div className="mt-3">
              <Btn small onClick={() => setActive(agent)} disabled={!agent.enabled}>
                {agent.enabled ? "Run agent" : "Not available yet"}
              </Btn>
            </div>
          </Card>
        ))}
      </div>

      <section className="mt-8">
        <h2 className="mb-3 text-sm font-bold uppercase tracking-wide text-navy/70">Run history</h2>
        {runs === null ? (
          <Spinner label="Loading runs…" />
        ) : (
          <Table head={["When", "Agent", "Status", "Duration", "Result"]} empty={runs.length === 0}>
            {runs.map((run) => (
              <tr key={run.id}>
                <Td className="whitespace-nowrap text-xs text-navy/60">{fmtDateTime(run.created_at)}</Td>
                <Td className="text-xs">{nameOf(run.agent_slug)}</Td>
                <Td>
                  <Badge tone={run.status === "ok" ? "good" : "bad"}>{run.status === "ok" ? "done" : "failed"}</Badge>
                </Td>
                <Td className="text-xs text-navy/60">{run.duration_ms} ms</Td>
                <Td className="max-w-[28rem] text-xs">
                  {run.status === "ok" ? (
                    <span className="line-clamp-2 text-navy/70">{run.output_excerpt.slice(0, 160)}</span>
                  ) : (
                    <span className="text-red-700">{run.error}</span>
                  )}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </section>

      {active && <RunModal agent={active} onClose={() => setActive(null)} onDone={reload} />}
    </>
  );
}

function RunModal({ agent, onClose, onDone }: { agent: AgentInfo; onClose: () => void; onDone: () => void }) {
  const { sites } = useSession();
  const [current, setCurrent] = useCurrentSite();
  const [values, setValues] = useState<Record<string, string>>(() => defaults(agent.params));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [answer, setAnswer] = useState<{ output: string; model: string; duration_ms: number } | null>(null);

  const run = async () => {
    if (!current) return;
    setBusy(true);
    setError(null);
    setAnswer(null);
    try {
      const result = await api.post<{ output: string; model: string; duration_ms: number }>(`/api/agents/${agent.slug}/run`, {
        site_id: current.id,
        params: values,
      });
      setAnswer(result);
      onDone();
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : "The agent run failed.");
      onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal open onClose={onClose} title={agent.name}>
      <p className="mb-4 text-xs text-navy/60">{agent.description}</p>

      {sites.length === 0 ? (
        <div className="rounded-lg border border-dashed border-navy/20 p-4 text-sm text-navy/60">
          No site is connected to this workspace yet.{" "}
          <Link to="/sites" className="font-semibold text-navy underline">
            Connect one
          </Link>{" "}
          first — an agent answers about a real site, not a hypothetical one.
        </div>
      ) : (
        <div className="space-y-2.5">
          <Field label="Site">
            <select className={inputClass} value={current?.id ?? ""} onChange={(e) => setCurrent(e.target.value)}>
              {sites.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.name || new URL(site.url).hostname}
                </option>
              ))}
            </select>
          </Field>

          {agent.params.map((field) => (
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

          <div className="flex items-center gap-2 pt-1">
            <Btn onClick={() => void run()} disabled={busy || !current}>
              {busy ? "Running…" : "Run agent"}
            </Btn>
            <span className="text-[11px] text-navy/40">Reads the site through the bridge, then calls the configured AI provider.</span>
          </div>
        </div>
      )}

      {error && <p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>}

      {answer && (
        <div className="mt-4">
          <div className="mb-1.5 flex items-center gap-2 text-xs text-navy/50">
            <Badge tone="good">done</Badge>
            <span className="font-mono">{answer.model}</span>
            <span>{answer.duration_ms} ms</span>
          </div>
          <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-navy/10 bg-navy/[0.02] p-3 font-mono text-[11px] text-navy/80">
            {answer.output}
          </pre>
          <p className="mt-1 text-[11px] text-navy/40">Run history keeps the first 2000 characters; this answer is the full response.</p>
        </div>
      )}
    </Modal>
  );
}
