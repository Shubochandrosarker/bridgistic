/** Website agents: propose changes with the configured AI, queue writes as approvals. */

import { useState } from "react";
import { api, siteCall } from "../lib/api";
import { Badge, Btn, Card, ErrorNote, Field, PageHead, Spinner, inputClass, useToast, Toast } from "../components/ui";
import { RequireSite, type Row } from "../components/sitelist";

interface AgentSpec {
  id: string;
  name: string;
  blurb: string;
  system: string;
  taskLabel: string;
  placeholder: string;
}

const AGENTS: Record<string, AgentSpec> = {
  seo: {
    id: "seo",
    name: "SEO agent",
    blurb: "Audits titles, meta and structure; proposes SEO patches as approvals.",
    system: "You are the Bridgistic SEO agent for a WordPress site. Produce a concise, prioritized list of concrete fixes. For each fix give: target (post ID or option), the exact new title/meta text, and a one-line reason. Never invent post IDs.",
    taskLabel: "What should the SEO agent look at?",
    placeholder: "Audit the site's homepage title and meta description; suggest better copy for the 5 most recent posts.",
  },
  manage: {
    id: "manage",
    name: "Management agent",
    blurb: "Options, settings hygiene and configuration drift, proposal-only.",
    system: "You are the Bridgistic site-management agent. Propose option/configuration changes with exact option names and new values. Mark anything destructive as approval-required.",
    taskLabel: "What should be managed?",
    placeholder: "Review site tagline and timezone settings; propose cleaner values.",
  },
  updates: {
    id: "updates",
    name: "Updates agent",
    blurb: "Plans plugin and core updates with snapshot-first sequencing.",
    system: "You are the Bridgistic updates agent. Given a plugin list, propose a safe update order with snapshots before each risky step. Never run anything; output a plan.",
    taskLabel: "What should be updated?",
    placeholder: "Plan updates for all plugins with available versions, snapshot first.",
  },
  audit: {
    id: "audit",
    name: "Audit agent",
    blurb: "Reads the audit log and flags anomalies worth a human look.",
    system: "You are the Bridgistic audit agent. Given audit entries, summarize what happened, flag anomalies (denied writes, unknown IPs, bursts of failures) and recommend next steps.",
    taskLabel: "What should be audited?",
    placeholder: "Review the last 50 audit entries and flag anything suspicious.",
  },
  content: {
    id: "content",
    name: "Content writer",
    blurb: "Drafts posts and pages; publishing always queues an approval.",
    system: "You are the Bridgistic content writer. Draft WordPress-ready content (title, excerpt, body in markdown-free HTML paragraphs). Keep the site's tone. Output a draft ready to queue as a pending post.",
    taskLabel: "What should be drafted?",
    placeholder: "Draft a 600-word post announcing our new LTD offer, friendly expert tone.",
  },
  social: {
    id: "social",
    name: "Social agent",
    blurb: "Drafts social copy. Publishing stays a draft unless you flip the switch.",
    system: "You are the Bridgistic social agent. Draft short social posts (X/LinkedIn/Facebook variants) from the given source material. Output drafts only.",
    taskLabel: "What should be drafted for social?",
    placeholder: "3 post variants announcing the v1.5.4 release for X and LinkedIn.",
  },
  ops: {
    id: "ops",
    name: "Operations agent",
    blurb: "Health, uptime and store ops checks with suggested remediations.",
    system: "You are the Bridgistic operations agent. Given site health data, summarize status and propose remediation steps with risk labels. Output a prioritized checklist.",
    taskLabel: "What should be checked?",
    placeholder: "Check site health and the WooCommerce stock state; propose fixes.",
  },
};

export function AgentHub() {
  return (
    <>
      <PageHead title="Agent hub" sub="Agents propose; people approve; the plugin guard always runs." />
      <div className="grid gap-3 md:grid-cols-2">
        {Object.values(AGENTS).map((agent) => (
          <Card key={agent.id} className="p-4">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-navy">{agent.name}</h2>
              <Badge tone="neutral">proposal-only</Badge>
            </div>
            <p className="mt-1 text-sm text-navy/60">{agent.blurb}</p>
            <a href={`/${agent.id === "manage" ? "manage-agents" : agent.id === "updates" ? "update-agents" : agent.id === "content" ? "content-agents" : agent.id === "social" ? "social-agents" : agent.id === "ops" ? "ops-agents" : agent.id === "audit" ? "audit-agents" : "seo"}`} className="mt-3 inline-block text-xs font-semibold text-navy underline">
              Open agent
            </a>
          </Card>
        ))}
      </div>
      <Card className="mt-4 p-4">
        <h2 className="text-sm font-bold text-navy">AI routing</h2>
        <p className="mt-1 text-sm text-navy/60">
          Agents use the provider configured in Platform admin → AI configuration: an OpenAI-compatible endpoint first, OpenRouter second, a local RAGBrain third, and a fixed safety rule if nothing else is configured. Provider keys are never stored in the browser.
        </p>
      </Card>
    </>
  );
}

export function AgentPage({ kind }: { kind: keyof typeof AGENTS | string }) {
  const spec = AGENTS[kind] ?? AGENTS.seo;
  const [task, setTask] = useState("");
  const [output, setOutput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [context, setContext] = useState<string>("");
  const [toast, showToast] = useToast();

  const run = async () => {
    setBusy(true);
    setError(null);
    setOutput("");
    try {
      const result = await api.post<{ text: string; model: string }>("/api/ai/generate", {
        prompt: `${task}\n\nSite context:\n${context || "(none fetched)"}`,
        system: spec.system,
      });
      setOutput(result.text);
    } catch (e) {
      setError(e instanceof Error ? e.message : "The agent run failed.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHead title={spec.name} sub={spec.blurb} />
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <Card className="p-5">
          <ErrorNote error={error} />
          <Field label={spec.taskLabel}>
            <textarea className={`${inputClass} min-h-[90px]`} value={task} onChange={(e) => setTask(e.target.value)} placeholder={spec.placeholder} />
          </Field>
          <div className="mt-3 flex items-center gap-2">
            <Btn onClick={run} disabled={busy || !task.trim()}>{busy ? "Thinking…" : "Run agent"}</Btn>
            {output && <Btn variant="ghost" onClick={() => void navigator.clipboard.writeText(output)}>Copy output</Btn>}
          </div>
          {busy && <Spinner label="The agent is working…" />}
          {output && (
            <div className="mt-4 rounded-lg bg-navy/[0.03] p-4 text-sm whitespace-pre-wrap">{output}</div>
          )}
        </Card>
        <div className="space-y-4">
          <Card className="p-4">
            <h3 className="mb-2 text-sm font-bold text-navy">Site context</h3>
            <p className="mb-2 text-xs text-navy/50">Optional: paste post lists, audit entries or health data for the agent to reason over.</p>
            <textarea className={`${inputClass} min-h-[80px] text-xs`} value={context} onChange={(e) => setContext(e.target.value)} />
            <RequireSite>
              {(site) => (
                <Btn
                  small
                  variant="ghost"
                  className="mt-2"
                  onClick={() =>
                    void (async () => {
                      try {
                        const health = await siteCall<Row>(site.id, "GET", "site-info");
                        setContext(JSON.stringify(health, null, 1).slice(0, 4000));
                        showToast("Loaded live site-info as context.");
                      } catch (e) {
                        showToast(e instanceof Error ? e.message : "Could not read site info.");
                      }
                    })()
                  }
                >
                  Load live site-info
                </Btn>
              )}
            </RequireSite>
          </Card>
          <Card className="p-4">
            <h3 className="mb-2 text-sm font-bold text-navy">Guardrails</h3>
            <ul className="list-inside list-disc space-y-1 text-xs text-navy/60">
              <li>WordPress writes still pass Plugin Guard and the approval queue.</li>
              <li>Executed SQL comments, unsigned parameters and sandbox lock-drops are blocked server-side.</li>
              <li>Social stays a draft; publishing a post queues an approval.</li>
            </ul>
          </Card>
        </div>
      </div>
      <Toast message={toast} />
    </>
  );
}
