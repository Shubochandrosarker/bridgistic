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
    expect(ACTIONS.map((a) => a.id)).toContain("cache.flush");
    expect(ACTIONS.map((a) => a.id)).toContain("permalinks.update");
    expect(ACTIONS.map((a) => a.id)).toContain("woo.list-orders");
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

  it("maps the cache and permalink actions to the plugin routes", () => {
    const flush = prepareAction("cache.flush", {});
    expect(flush.ok).toBe(true);
    if (!flush.ok) return;
    expect(flush.prepared.def.method).toBe("POST");
    expect(flush.prepared.route).toBe("cache/flush");
    expect(flush.prepared.body).toEqual({});

    const read = prepareAction("permalinks.get", {});
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.prepared.def.method).toBe("GET");
    expect(read.prepared.route).toBe("permalinks");
    expect(read.prepared.body).toBeUndefined();
  });

  it("lets the custom permalink structure override the preset", () => {
    const preset = prepareAction("permalinks.update", { structure: "/%postname%/", category_base: "topics" });
    expect(preset.ok).toBe(true);
    if (!preset.ok) return;
    expect(preset.prepared.route).toBe("permalinks");
    expect(preset.prepared.body).toEqual({ structure: "/%postname%/", category_base: "topics" });

    const custom = prepareAction("permalinks.update", {
      structure: "/%postname%/",
      custom: "/%category%/%postname%/",
      tag_base: "tagged",
    });
    expect(custom.ok).toBe(true);
    if (!custom.ok) return;
    expect(custom.prepared.body).toEqual({ structure: "/%category%/%postname%/", tag_base: "tagged" });

    expect(prepareAction("permalinks.update", { structure: "/not-a-preset/" })).toMatchObject({
      ok: false,
      error: "invalid_param",
    });
  });

  it("maps every WooCommerce read action to its controller route", () => {
    const cases: Array<{ id: string; params: Record<string, string>; route: string; method: "GET" | "POST" }> = [
      { id: "woo.list-products", params: {}, route: "woo/products", method: "GET" },
      {
        id: "woo.list-products",
        params: { search: "hoodie", status: "publish", stock_status: "instock", category: "clothing" },
        route: "woo/products?search=hoodie&status=publish&stock_status=instock&category=clothing",
        method: "GET",
      },
      { id: "woo.get-product", params: { id: "9" }, route: "woo/products/9", method: "GET" },
      { id: "woo.list-orders", params: {}, route: "woo/orders", method: "GET" },
      {
        id: "woo.list-orders",
        params: { page: "2", per_page: "10", status: "processing,completed", customer_id: "5", after: "2026-01-01" },
        route: "woo/orders?page=2&per_page=10&status=processing%2Ccompleted&customer_id=5&after=2026-01-01",
        method: "GET",
      },
      { id: "woo.get-order", params: { id: "42" }, route: "woo/orders/42", method: "GET" },
      { id: "woo.list-customers", params: { search: "jane doe" }, route: "woo/customers?search=jane%20doe", method: "GET" },
      { id: "woo.get-customer", params: { id: "3" }, route: "woo/customers/3", method: "GET" },
      { id: "woo.inventory", params: { limit: "25" }, route: "woo/inventory?limit=25", method: "GET" },
      { id: "woo.sales-summary", params: { days: "7" }, route: "woo/sales-summary?days=7", method: "GET" },
    ];

    for (const { id, params, route, method } of cases) {
      const prepared = prepareAction(id, params);
      expect(prepared.ok, `${id} with ${JSON.stringify(params)}`).toBe(true);
      if (!prepared.ok) continue;
      expect(prepared.prepared.def.method).toBe(method);
      expect(prepared.prepared.route).toBe(route);
      expect(prepared.prepared.body).toBeUndefined();
      // A GET carries every field in the URL, so none may fall through to a body.
      expect(prepared.prepared.def.routeParams).toEqual(prepared.prepared.def.fields.map((f) => f.name));
    }
  });

  it("refuses malformed filters on the WooCommerce read actions", () => {
    expect(prepareAction("woo.get-order", {})).toMatchObject({ ok: false, error: "missing_param" });
    expect(prepareAction("woo.list-orders", { page: "0" })).toMatchObject({ ok: false, error: "invalid_param" });
    expect(prepareAction("woo.list-orders", { customer_id: "jane" })).toMatchObject({ ok: false, error: "invalid_param" });
    expect(prepareAction("woo.list-products", { stock_status: "gone" })).toMatchObject({ ok: false, error: "invalid_param" });
    expect(prepareAction("woo.sales-summary", { days: "0" })).toMatchObject({ ok: false, error: "invalid_param" });
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

  it("keeps a destructive permalink change behind the approval queue", async () => {
    const { calls, fetchImpl } = siteFetch({ ok: true, data: { status: "pending_approval", approval_id: "ap_9" } });
    const outcome = await runAction(
      { DB: db, SECRET_ENCRYPTION_KEY: SECRET_KEY },
      USER,
      { site_id: SITE.id, action: "permalinks.update", params: { structure: "/%postname%/" } },
      fetchImpl
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.status).toBe("queued");
    expect(calls[0].url).toBe("https://shop.example.com/wp-json/bridgistic/v1/permalinks");
    expect(calls[0].method).toBe("POST");
    expect(JSON.parse(String(calls[0].body))).toEqual({ structure: "/%postname%/" });
  });

  it("sends a WooCommerce read's filters in the URL, with no body", async () => {
    const { calls, fetchImpl } = siteFetch({ ok: true, data: { items: [], total: 0 } });
    const outcome = await runAction(
      { DB: db, SECRET_ENCRYPTION_KEY: SECRET_KEY },
      USER,
      { site_id: SITE.id, action: "woo.list-orders", params: { status: "processing", per_page: "5" } },
      fetchImpl
    );

    expect(outcome.ok).toBe(true);
    expect(calls[0].url).toBe("https://shop.example.com/wp-json/bridgistic/v1/woo/orders?per_page=5&status=processing");
    expect(calls[0].method).toBe("GET");
    expect(calls[0].body).toBeNull();
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
