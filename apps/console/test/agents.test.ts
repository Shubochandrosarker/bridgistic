import { describe, it, expect, beforeEach } from "vitest";
import { makeD1 } from "./d1.ts";
import { encryptSecret } from "../functions/lib/crypto.ts";
import { listAgents, listAgentRuns, runAgent, type AgentEnv } from "../functions/lib/agents.ts";

const SECRET_KEY = "22".repeat(32);
const USER = { id: "u1", email: "ops@example.com" };
const OTHER = { id: "u2", email: "other@example.com" };
const SITE = { id: "s1", org: "o1", url: "https://shop.example.com" };
const GATEWAY = "https://ai.example.net/v1";

async function seed(): Promise<D1Database> {
  const db = await makeD1();
  await db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, 'x')").bind(USER.id, USER.email, "Ops").run();
  await db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, ?, 'x')").bind(OTHER.id, OTHER.email, "Other").run();
  await db.prepare("INSERT INTO orgs (id, name, plan, owner_user_id) VALUES (?, ?, 'free', ?)").bind(SITE.org, "Acme", USER.id).run();
  await db.prepare("INSERT INTO memberships (org_id, user_id, role) VALUES (?, ?, 'owner')").bind(SITE.org, USER.id).run();
  await db
    .prepare("INSERT INTO sites (id, org_id, url, name, key_id, key_mask, secret_enc, status) VALUES (?, ?, ?, ?, ?, ?, ?, 'connected')")
    .bind(SITE.id, SITE.org, SITE.url, "Shop", "kid_1234", "kid_…1234", await encryptSecret("site-secret", SECRET_KEY))
    .run();
  return db;
}

function configured(db: D1Database): AgentEnv {
  return { DB: db, SECRET_ENCRYPTION_KEY: SECRET_KEY, AI_GATEWAY_URL: GATEWAY, AI_GATEWAY_TOKEN: "gw-token" };
}

/** Site bridge answers site-info; everything else is the AI gateway. */
function fetchRouter(aiAnswer: { content?: string; status?: number; error?: string } = {}) {
  const aiCalls: { url: string; body: Record<string, unknown>; auth: string }[] = [];
  const fetchImpl = (async (input: unknown, init: RequestInit) => {
    const url = String(input);
    if (url.includes("/wp-json/bridgistic/v1/site-info")) {
      return new Response(JSON.stringify({ ok: true, data: { site: { name: "Shop", url: SITE.url }, wordpress: { version: "6.8" } } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    aiCalls.push({ url, body: JSON.parse(String(init.body)), auth: String((init.headers as Record<string, string>).Authorization) });
    if (aiAnswer.status && aiAnswer.status >= 400) {
      return new Response(JSON.stringify({ error: { message: aiAnswer.error ?? "upstream refused" } }), { status: aiAnswer.status });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content: aiAnswer.content ?? "An answer." } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { aiCalls, fetchImpl };
}

describe("agent registry", () => {
  let db: D1Database;
  beforeEach(async () => {
    db = await seed();
  });

  it("seeds the six agents, with the two v2 placeholders disabled", async () => {
    const agents = await listAgents(db, USER.id);
    expect(agents.map((a) => a.slug).sort()).toEqual([
      "articles-writer",
      "content-refresher",
      "growth-analyzer",
      "internal-linker",
      "schema-builder",
      "seo-auditor",
    ]);
    expect(agents.find((a) => a.slug === "content-refresher")?.enabled).toBe(false);
    expect(agents.find((a) => a.slug === "internal-linker")?.enabled).toBe(false);
    // Every runnable agent has a system prompt and a parameter form.
    for (const agent of agents) {
      expect(agent.params.length).toBeGreaterThan(0);
      expect(agent.last_status).toBeNull();
    }
    const prompt = await db.prepare("SELECT system_prompt FROM agents WHERE slug = 'articles-writer'").first<{ system_prompt: string }>();
    expect(prompt?.system_prompt.length).toBeGreaterThan(100);
  });

  it("runs through the AI gateway with the agent's own system prompt and the site context", async () => {
    const { aiCalls, fetchImpl } = fetchRouter({ content: "A 900-word draft." });
    const outcome = await runAgent(configured(db), USER, "articles-writer", { site_id: SITE.id, params: { topic: "Cache plugins" } }, fetchImpl);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.output).toBe("A 900-word draft.");
    expect(aiCalls).toHaveLength(1);
    expect(aiCalls[0].url).toBe(`${GATEWAY}/chat/completions`);
    expect(aiCalls[0].auth).toContain("gw-token");
    const messages = aiCalls[0].body.messages as { role: string; content: string }[];
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("article writer inside Bridgistic");
    expect(messages[1].content).toContain("Cache plugins");
    expect(messages[1].content).toContain("6.8");

    const row = await db.prepare("SELECT * FROM agent_runs WHERE id = ?").bind(outcome.run_id).first<Record<string, unknown>>();
    expect(row).toMatchObject({ agent_slug: "articles-writer", site_id: SITE.id, status: "ok", error: "" });
    expect(String(row?.input_json)).toContain("Cache plugins");
    expect((await listAgents(db, USER.id)).find((a) => a.slug === "articles-writer")?.last_status).toBe("ok");
  });

  it("truncates the stored excerpt but returns the whole answer", async () => {
    const long = "x".repeat(5000);
    const { fetchImpl } = fetchRouter({ content: long });
    const outcome = await runAgent(configured(db), USER, "growth-analyzer", { site_id: SITE.id, params: {} }, fetchImpl);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.output).toHaveLength(5000);
    const row = await db.prepare("SELECT output_excerpt FROM agent_runs WHERE id = ?").bind(outcome.run_id).first<{ output_excerpt: string }>();
    expect(row?.output_excerpt).toHaveLength(2000);
  });

  it("says AI is not configured instead of pretending, and stores no run", async () => {
    const { aiCalls, fetchImpl } = fetchRouter();
    const outcome = await runAgent({ DB: db, SECRET_ENCRYPTION_KEY: SECRET_KEY }, USER, "seo-auditor", {
      site_id: SITE.id,
      params: { page_url: "/", focus_keyword: "cache" },
    }, fetchImpl);

    expect(outcome).toMatchObject({ ok: false, status: 503, error: "ai_not_configured" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toMatch(/AI is not configured/);
    expect(aiCalls).toHaveLength(0);
    const row = await db.prepare("SELECT COUNT(*) AS n FROM agent_runs").first<{ n: number }>();
    expect(Number(row?.n)).toBe(0);
  });

  it("refuses a disabled placeholder and an unknown slug", async () => {
    const { aiCalls, fetchImpl } = fetchRouter();
    expect(await runAgent(configured(db), USER, "content-refresher", { site_id: SITE.id, params: { post_id: "1" } }, fetchImpl)).toMatchObject({
      ok: false,
      status: 409,
      error: "agent_disabled",
    });
    expect(await runAgent(configured(db), USER, "not-an-agent", {}, fetchImpl)).toMatchObject({ ok: false, status: 404, error: "agent_not_found" });
    expect(aiCalls).toHaveLength(0);
  });

  it("validates parameters before spending a call", async () => {
    const { fetchImpl } = fetchRouter();
    const outcome = await runAgent(configured(db), USER, "seo-auditor", { site_id: SITE.id, params: {} }, fetchImpl);
    expect(outcome).toMatchObject({ ok: false, error: "missing_param" });
  });

  it("records an upstream failure as an error run", async () => {
    const { fetchImpl } = fetchRouter({ status: 500, error: "gateway exploded" });
    const outcome = await runAgent(configured(db), USER, "schema-builder", { site_id: SITE.id, params: { page_url: "/pricing" } }, fetchImpl);
    expect(outcome).toMatchObject({ ok: false, status: 502, error: "agent_failed" });
    if (!outcome.ok) expect(outcome.message).toBe("gateway exploded");
    const row = await db.prepare("SELECT status, error FROM agent_runs").first<{ status: string; error: string }>();
    expect(row).toEqual({ status: "error", error: "gateway exploded" });
  });

  it("keeps run history per user", async () => {
    const { fetchImpl } = fetchRouter();
    await runAgent(configured(db), USER, "growth-analyzer", { site_id: SITE.id, params: {} }, fetchImpl);
    expect(await listAgentRuns(db, USER.id)).toHaveLength(1);
    expect(await listAgentRuns(db, OTHER.id)).toHaveLength(0);
    expect(await listAgentRuns(db, USER.id, { slug: "articles-writer" })).toHaveLength(0);
  });
});
