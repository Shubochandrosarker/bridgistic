/**
 * The agent registry: what the Automations tab can run, and the server-side
 * runner behind POST /api/agents/{slug}/run.
 *
 * Identity, copy and prompt live in D1 (`agents`, seeded by migration 0009) so
 * an operator can change wording or disable an agent without a deploy. What
 * stays in code is the parameter form — that is behaviour, and a form that
 * drifts from the prompt is how an agent quietly stops being useful.
 *
 * The runner is real: it calls the site's bridge for context, sends the agent's
 * system prompt plus that context to the AI client in lib/ai.ts, and stores the
 * outcome in `agent_runs`. When no AI provider is configured it answers 503
 * `ai_not_configured` and stores nothing — no run happened.
 */

import { audit, requireOrgMember } from "./auth.ts";
import { decryptSecret } from "./crypto.ts";
import { callSite } from "./wp.ts";
import { chat, type AiEnv, type ChatMessage } from "./ai.ts";
import { collectFields, type FormField } from "./actions.ts";

type Fetch = typeof fetch;

export interface AgentRunRow {
  id: string;
  agent_slug: string;
  site_id: string;
  status: "ok" | "error";
  output_excerpt: string;
  duration_ms: number;
  error: string;
  created_at: string;
}

export interface AgentCard {
  slug: string;
  name: string;
  description: string;
  category: string;
  enabled: boolean;
  last_status: string | null;
  last_run_at: string | null;
  params: FormField[];
}

const TONE_OPTIONS = [
  { value: "practical", label: "Practical" },
  { value: "authoritative", label: "Authoritative" },
  { value: "friendly", label: "Friendly" },
];

/**
 * The form each agent accepts. content-refresher and internal-linker are
 * seeded disabled; their forms exist so enabling them later is a flag, not a
 * code change.
 */
const AGENT_PARAMS: Record<string, FormField[]> = {
  "articles-writer": [
    { name: "topic", label: "Topic", required: true, placeholder: "What the article is about" },
    { name: "keywords", label: "Keywords", placeholder: "comma-separated" },
    { name: "tone", label: "Tone", type: "select", options: TONE_OPTIONS, default: "practical" },
    { name: "word_count", label: "Target words", type: "number", default: "900" },
  ],
  "seo-auditor": [
    { name: "page_url", label: "Page", required: true, default: "/", placeholder: "/pricing or a full URL on this site" },
    { name: "focus_keyword", label: "Focus keyword", required: true },
  ],
  "schema-builder": [
    { name: "page_url", label: "Page", required: true, default: "/" },
    {
      name: "schema_type",
      label: "Schema type",
      type: "select",
      default: "Article",
      options: [
        { value: "Article", label: "Article" },
        { value: "Product", label: "Product" },
        { value: "FAQPage", label: "FAQ" },
        { value: "LocalBusiness", label: "Local business" },
        { value: "Organization", label: "Organization" },
      ],
    },
  ],
  "growth-analyzer": [{ name: "period_days", label: "Look-back (days)", type: "number", default: "30" }],
  "content-refresher": [{ name: "post_id", label: "Post ID", type: "number", required: true }],
  "internal-linker": [{ name: "post_id", label: "Post ID", type: "number", required: true }],
};

export function agentParams(slug: string): FormField[] {
  return (AGENT_PARAMS[slug] ?? []).map((f) => ({ ...f }));
}

/** Registry for the UI, with this person's most recent run per agent. */
export async function listAgents(db: D1Database, userId: string): Promise<AgentCard[]> {
  const { results } = await db
    .prepare(
      `SELECT a.slug, a.name, a.description, a.category, a.enabled,
              (SELECT r.status FROM agent_runs r WHERE r.agent_slug = a.slug AND r.user_id = ?
                ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1) AS last_status,
              (SELECT r.created_at FROM agent_runs r WHERE r.agent_slug = a.slug AND r.user_id = ?
                ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1) AS last_run_at
       FROM agents a
       ORDER BY a.enabled DESC, a.category, a.name`
    )
    .bind(userId, userId)
    .all<{ slug: string; name: string; description: string; category: string; enabled: number; last_status: string | null; last_run_at: string | null }>();
  return (results ?? []).map((row) => ({
    slug: row.slug,
    name: row.name,
    description: row.description,
    category: row.category,
    enabled: row.enabled === 1,
    last_status: row.last_status,
    last_run_at: row.last_run_at,
    params: agentParams(row.slug),
  }));
}

export async function listAgentRuns(
  db: D1Database,
  userId: string,
  opts: { slug?: string; limit?: number } = {}
): Promise<AgentRunRow[]> {
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100);
  const slug = (opts.slug ?? "").trim();
  const sql = slug
    ? "SELECT id, agent_slug, site_id, status, output_excerpt, duration_ms, error, created_at FROM agent_runs WHERE user_id = ? AND agent_slug = ? ORDER BY created_at DESC, rowid DESC LIMIT ?"
    : "SELECT id, agent_slug, site_id, status, output_excerpt, duration_ms, error, created_at FROM agent_runs WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?";
  const stmt = db.prepare(sql);
  const bound = slug ? stmt.bind(userId, slug, limit) : stmt.bind(userId, limit);
  const { results } = await bound.all<AgentRunRow>();
  return results ?? [];
}

export type AgentOutcome =
  | { ok: true; run_id: string; output: string; model: string; provider: string; duration_ms: number }
  | { ok: false; status: number; error: string; message: string; run_id: string | null; duration_ms: number };

export interface AgentEnv extends AiEnv {
  SECRET_ENCRYPTION_KEY?: string;
}

function failed(status: number, error: string, message: string): AgentOutcome {
  return { ok: false, status, error, message, run_id: null, duration_ms: 0 };
}

/** Keep the prompt bounded: a site-info payload is small, but this is untrusted input. */
function siteContext(data: unknown, siteUrl: string): string {
  const text = JSON.stringify(data ?? {});
  return text.length > 4000 ? `${text.slice(0, 4000)}…` : text || JSON.stringify({ url: siteUrl });
}

export async function runAgent(
  env: AgentEnv,
  user: { id: string; email: string },
  slugRaw: string,
  input: { site_id?: unknown; params?: unknown },
  fetchImpl: Fetch = fetch
): Promise<AgentOutcome> {
  const slug = slugRaw.trim();
  if (!/^[a-z0-9][a-z0-9-]{1,63}$/.test(slug)) return failed(404, "agent_not_found", "Unknown agent.");

  const agent = await env.DB.prepare("SELECT slug, name, system_prompt, enabled FROM agents WHERE slug = ?")
    .bind(slug)
    .first<{ slug: string; name: string; system_prompt: string; enabled: number }>();
  if (!agent) return failed(404, "agent_not_found", "Unknown agent.");
  if (agent.enabled !== 1) {
    return failed(409, "agent_disabled", `${agent.name} is registered but not runnable yet. An operator can enable it once its approval path ships.`);
  }

  const collected = collectFields(agentParams(slug), input.params);
  if (!collected.ok) return failed(collected.status, collected.error, collected.message);

  const siteId = String(input.site_id ?? "").trim();
  if (!siteId) return failed(400, "missing_site", "Choose a site.");
  const site = await env.DB.prepare("SELECT id, org_id, url, key_id, secret_enc FROM sites WHERE id = ?")
    .bind(siteId)
    .first<{ id: string; org_id: string; url: string; key_id: string; secret_enc: string }>();
  if (!site) return failed(404, "site_not_found", "Site not found.");
  await requireOrgMember(env.DB, user.id, site.org_id);
  if (!env.SECRET_ENCRYPTION_KEY) return failed(503, "not_configured", "SECRET_ENCRYPTION_KEY is not set on this deployment.");

  let secret: string;
  try {
    secret = await decryptSecret(site.secret_enc, env.SECRET_ENCRYPTION_KEY);
  } catch {
    return failed(503, "site_key_unreadable", "The stored site key could not be decrypted. Reconnect the site.");
  }

  const inputJson = JSON.stringify({ site_id: site.id, ...collected.values });
  const started = Date.now();

  // The agent answers about THIS site, so a site that will not describe itself
  // is a failed run rather than an invitation to invent one.
  let context: unknown;
  try {
    const info = await callSite(site.url, site.key_id, secret, "GET", "site-info", undefined, fetchImpl);
    if (!info.ok) {
      const message = info.error?.message ?? "The site did not answer with its details.";
      return await recordFailure(env, user, slug, site.id, inputJson, message, started);
    }
    context = info.data;
  } catch (e) {
    return await recordFailure(env, user, slug, site.id, inputJson, e instanceof Error ? e.message : "The site call failed.", started);
  }

  const brief = Object.entries(collected.values)
    .map(([name, value]) => `- ${name}: ${value}`)
    .join("\n");
  const messages: ChatMessage[] = [
    { role: "system", content: agent.system_prompt },
    {
      role: "user",
      content: `Site context, read from the site's own bridge (JSON):\n${siteContext(context, site.url)}\n\nRequest:\n${brief}\n\nAnswer for that site only. If the context does not support a claim, leave it out.`,
    },
  ];

  const answer = await chat(env, messages, { maxTokens: 1600, timeoutMs: 90_000 }, fetchImpl);
  const durationMs = Date.now() - started;
  if (!answer.ok) {
    // No provider configured is a deployment state, not a run: nothing was sent,
    // so nothing is logged and the UI says so plainly.
    if (answer.error === "ai_not_configured") return failed(answer.status, answer.error, answer.message);
    return await recordFailure(env, user, slug, site.id, inputJson, answer.message, started);
  }

  const runId = crypto.randomUUID();
  const output = answer.text;
  await env.DB.prepare(
    "INSERT INTO agent_runs (id, user_id, agent_slug, site_id, status, input_json, output_excerpt, duration_ms, error) VALUES (?, ?, ?, ?, 'ok', ?, ?, ?, '')"
  )
    .bind(runId, user.id, slug, site.id, inputJson, answer.text.slice(0, 2000), durationMs)
    .run();
  await audit(env.DB, user.email, `agent.${slug}`, new URL(site.url).hostname, `${durationMs}ms`);
  return { ok: true, run_id: runId, output, model: answer.model, provider: answer.provider, duration_ms: durationMs };
}

async function recordFailure(
  env: AgentEnv,
  user: { id: string; email: string },
  slug: string,
  siteId: string,
  inputJson: string,
  message: string,
  started: number
): Promise<AgentOutcome> {
  const durationMs = Date.now() - started;
  const runId = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO agent_runs (id, user_id, agent_slug, site_id, status, input_json, output_excerpt, duration_ms, error) VALUES (?, ?, ?, ?, 'error', ?, '', ?, ?)"
  )
    .bind(runId, user.id, slug, siteId, inputJson, durationMs, message)
    .run();
  await audit(env.DB, user.email, `agent.${slug}`, siteId, `error: ${message.slice(0, 200)}`);
  return { ok: false, status: 502, error: "agent_failed", message, run_id: runId, duration_ms: durationMs };
}
