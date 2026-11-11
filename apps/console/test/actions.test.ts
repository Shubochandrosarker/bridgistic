import { describe, it, expect, beforeEach } from "vitest";
import { makeD1 } from "./d1.ts";
import { encryptSecret } from "../functions/lib/crypto.ts";
import { HttpError } from "../functions/lib/auth.ts";
import { ACTIONS, catalogForClient, listActionRuns, prepareAction, runAction } from "../functions/lib/actions.ts";

const SECRET_KEY = "11".repeat(32);
const USER = { id: "u1", email: "ops@example.com" };
const OTHER = { id: "u2", email: "other@example.com" };
const SITE = { id: "s1", org: "o1", url: "https://shop.example.com" };

async function seedSite(): Promise<D1Database> {
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

interface Call {
  url: string;
  method: string;
  body: string | null;
  headers: Record<string, string>;
}

function siteFetch(payload: unknown, status = 200) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: unknown, init: RequestInit) => {
    calls.push({ url: String(input), method: String(init.method), body: (init.body as string) ?? null, headers: init.headers as Record<string, string> });
    return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("actions catalog", () => {
  it("covers every domain the plugin actually exposes", () => {
    const domains = new Set(ACTIONS.map((a) => a.domain));
    expect([...domains].sort()).toEqual(["content", "media", "plugins", "site", "woo"]);
    expect(ACTIONS.map((a) => a.id)).toContain("content.create-post");
    expect(ACTIONS.map((a) => a.id)).toContain("plugins.toggle");
    // Cache and permalinks have no plugin route, so they must not appear here.
    expect(ACTIONS.some((a) => /cache|permalink/i.test(a.id))).toBe(false);
  });

  it("ships no handlers to the browser", () => {
    for (const action of catalogForClient()) {
      expect(action).not.toHaveProperty("route");
      expect(action).not.toHaveProperty("routeParams");
      expect(Array.isArray(action.fields)).toBe(true);
    }
  });

  it("rejects unknown actions, missing required values and bad numbers", () => {
    expect(prepareAction("nope.nothing", {})).toMatchObject({ ok: false, error: "unknown_action" });
    expect(prepareAction("content.create-post", {})).toMatchObject({ ok: false, error: "missing_param" });
    expect(prepareAction("content.update-post", { id: "abc" })).toMatchObject({ ok: false, error: "invalid_param" });
    expect(prepareAction("content.update-post", { id: "0" })).toMatchObject({ ok: false, error: "invalid_param" });
    expect(prepareAction("plugins.toggle", { plugin: "akismet/akismet.php", state: "nope" })).toMatchObject({
      ok: false,
      error: "invalid_param",
    });
  });

  it("takes only declared fields and keeps the route id out of the body", () => {
    const prepared = prepareAction("content.update-post", { id: "42", title: "New title", admin: "1" });
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    expect(prepared.prepared.route).toBe("posts/42");
    expect(prepared.prepared.body).toEqual({ title: "New title" });
  });
});

describe("POST /api/actions/run backend", () => {
  let db: D1Database;
  beforeEach(async () => {
    db = await seedSite();
  });

  it("signs one call to the catalogued route and logs the run", async () => {
    const { calls, fetchImpl } = siteFetch({ ok: true, data: { id: 7, link: "https://shop.example.com/?p=7" } });
    const outcome = await runAction(
      { DB: db, SECRET_ENCRYPTION_KEY: SECRET_KEY },
      USER,
      { site_id: SITE.id, action: "content.create-post", params: { title: "Hello", status: "draft" } },
      fetchImpl
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.status).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://shop.example.com/wp-json/bridgistic/v1/posts");
    expect(calls[0].method).toBe("POST");
    expect(JSON.parse(String(calls[0].body))).toEqual({ title: "Hello", status: "draft" });
    expect(calls[0].headers["X-Bridgistic-Signature"]).toMatch(/^[0-9a-f]{64}$/);

    const row = await db.prepare("SELECT * FROM action_runs WHERE id = ?").bind(outcome.run_id).first<Record<string, unknown>>();
    expect(row).toMatchObject({ user_id: USER.id, site_id: SITE.id, action: "content.create-post", status: "ok", error: "" });
    expect(Number(row?.duration_ms)).toBeGreaterThanOrEqual(0);
  });

  it("records a site refusal as an error run and returns the site's message", async () => {
    const { fetchImpl } = siteFetch({ ok: false, code: "bridgistic_forbidden", message: "The key lacks posts:write." }, 403);
    const outcome = await runAction(
      { DB: db, SECRET_ENCRYPTION_KEY: SECRET_KEY },
      USER,
      { site_id: SITE.id, action: "content.create-post", params: { title: "Hello" } },
      fetchImpl
    );

    expect(outcome).toMatchObject({ ok: false, status: 403, message: "The key lacks posts:write." });
    const { results } = await db.prepare("SELECT status, error FROM action_runs").all<{ status: string; error: string }>();
    expect(results).toEqual([{ status: "error", error: "The key lacks posts:write." }]);
  });

  it("marks an approval-queued call as queued, not done", async () => {
    const { fetchImpl } = siteFetch({ ok: true, data: { status: "pending_approval", approval_id: "ap_1" } });
    const outcome = await runAction(
      { DB: db, SECRET_ENCRYPTION_KEY: SECRET_KEY },
      USER,
      { site_id: SITE.id, action: "plugins.toggle", params: { plugin: "akismet/akismet.php", state: "deactivate" } },
      fetchImpl
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.status).toBe("queued");
    const row = await db.prepare("SELECT status FROM action_runs").first<{ status: string }>();
    expect(row?.status).toBe("queued");
  });

  it("does not log a run that never left the server", async () => {
    const { calls, fetchImpl } = siteFetch({ ok: true, data: {} });
    const outcome = await runAction(
      { DB: db, SECRET_ENCRYPTION_KEY: SECRET_KEY },
      USER,
      { site_id: SITE.id, action: "content.create-post", params: {} },
      fetchImpl
    );
    expect(outcome).toMatchObject({ ok: false, error: "missing_param", run_id: null });
    expect(calls).toHaveLength(0);
    const row = await db.prepare("SELECT COUNT(*) AS n FROM action_runs").first<{ n: number }>();
    expect(Number(row?.n)).toBe(0);
  });

  it("refuses a site the caller's org does not own", async () => {
    const { calls, fetchImpl } = siteFetch({ ok: true, data: {} });
    await expect(
      runAction(
        { DB: db, SECRET_ENCRYPTION_KEY: SECRET_KEY },
        OTHER,
        { site_id: SITE.id, action: "site.info", params: {} },
        fetchImpl
      )
    ).rejects.toBeInstanceOf(HttpError);
    expect(calls).toHaveLength(0);
  });

  it("scopes run history to the caller", async () => {
    const { fetchImpl } = siteFetch({ ok: true, data: { site: {} } });
    await runAction({ DB: db, SECRET_ENCRYPTION_KEY: SECRET_KEY }, USER, { site_id: SITE.id, action: "site.info" }, fetchImpl);
    expect(await listActionRuns(db, USER.id)).toHaveLength(1);
    expect(await listActionRuns(db, OTHER.id)).toHaveLength(0);
  });
});
