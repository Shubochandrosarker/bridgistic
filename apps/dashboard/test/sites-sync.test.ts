import { describe, it, expect, vi } from "vitest";
import { fetchPairedSites } from "../src/lib/sites-sync.ts";
import { mergePairedSites } from "../src/lib/store.tsx";
import { BridgeClient } from "../src/lib/api/bridge.ts";

const site = (id: string, status = "activated", paired = true) => ({ id, site_url: `https://${id}.test`, domain: `${id}.test`, status, plan: "pro", license_mask: "WPI-…ABCD", paired, key_id: paired ? `wpk_${id}` : null, last_validated_at: null });

describe("paired site sync", () => {
  it("maps /api/me/sites to connections without secrets", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ sites: [site("a"), site("b", "expired")] }), { status: 200 }));
    const list = await fetchPairedSites(f as unknown as typeof fetch);
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe("https://admin.bridgistic.app/api/me/sites");
    expect(list?.map((s) => [s.pairedSiteId, s.status, s.secret])).toEqual([["a", "activated", ""], ["b", "expired", ""]]);
  });

  it("returns null when signed out", async () => {
    expect(await fetchPairedSites((async () => new Response("{}", { status: 401 })) as unknown as typeof fetch)).toBeNull();
  });

  it("merge: adds new, drops removed paired sites, keeps manual ones, supersedes manual duplicates", () => {
    const manual = { id: "m1", alias: "manual", siteUrl: "https://m.test", keyId: "wpk_m", secret: "s" };
    const dupe = { id: "m2", alias: "dupe", siteUrl: "https://a.test", keyId: "wpk_x", secret: "s" };
    const stale = { id: "paired:gone", alias: "gone", siteUrl: "https://gone.test", keyId: "", secret: "", pairedSiteId: "gone" };
    const next = mergePairedSites([manual, dupe, stale], [{ alias: "a.test", siteUrl: "https://a.test", keyId: "wpk_a", secret: "", pairedSiteId: "a", status: "activated" }]);
    expect(next.map((s) => s.id)).toEqual(["paired:a", "m1"]);
  });
});

describe("relay by site id", () => {
  it("sends site_id and never a secret; no direct fallback", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ ok: true, data: { site: { name: "A" } } }), { status: 200 }));
    const c = new BridgeClient({ id: "paired:a", alias: "a", siteUrl: "https://a.test", keyId: "wpk_a", secret: "", pairedSiteId: "a" }, f as unknown as typeof fetch);
    await c.siteInfo();
    const body = JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toMatchObject({ site_id: "a", method: "GET", path: "site-info" });
    expect(body.secret).toBeUndefined();
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("surfaces relay errors for paired sites", async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ error: "site_not_available", message: "nope" }), { status: 404 }));
    const c = new BridgeClient({ id: "paired:a", alias: "a", siteUrl: "https://a.test", keyId: "", secret: "", pairedSiteId: "a" }, f as unknown as typeof fetch);
    await expect(c.siteInfo()).rejects.toThrow("nope");
    expect(f).toHaveBeenCalledTimes(1);
  });
});
