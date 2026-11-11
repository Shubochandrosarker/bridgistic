import { describe, it, expect, beforeEach } from "vitest";
import { makeD1 } from "./d1.ts";
import { isRevokedToken, proxyActivate, proxyValidate, proxyDeactivate, listMySites, claimLicense, resolveOwnedSite, sha256Hex, siteStatus, type SitesEnv } from "../functions/lib/sites.ts";
import { activateLicense, deactivateLicense } from "../functions/lib/licenses.ts";

const ENC = "a".repeat(64);
const USER = { id: "u1", email: "owner@example.com" };

/** Fake api.wpistic.com: records calls, answers like the real contract. */
function fakeWpistic() {
  const calls: { url: string; body: any; headers: any }[] = [];
  const licenses: any[] = [
    { id: "lic-legacy", key_hash: "", key_mask: "WPI-…ABCD", product: "bridgistic", plan: "pro", status: "active", effective_status: "active", max_activations: 3, expires_at: "2099-01-01T00:00:00Z", owner_email: "legacy-buyer@other.com", activations: [] as any[] },
  ];
  const mode = { validate401: null as null | { code: string; message: string } };
  const fetchImpl = (async (url: string, init: any) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body, headers: init.headers });
    if (url.endsWith("/validate") && mode.validate401) return new Response(JSON.stringify({ error: { ...mode.validate401, correlation_id: "c1" } }), { status: 401 });
    if (url.endsWith("/activate")) {
      licenses[0].activations.push({ id: `act-${licenses[0].activations.length + 1}`, domain: body.domain, site_url: body.site_url, environment: "production", status: "active", last_seen_at: null, deactivated_at: null });
      const act = licenses[0].activations.at(-1);
      return new Response(JSON.stringify({ success: true, status: "active", activation_token: `tok-${act.id}`, activation: { id: act.id, domain: act.domain }, signature: "sig-upstream" }), { status: 200 });
    }
    if (url.endsWith("/validate")) {
      const act = licenses[0].activations.find((a: any) => `tok-${a.id}` === body.activation_token && a.status === "active");
      if (!act) return new Response(JSON.stringify({ success: false, error: { code: "activation_not_found" } }), { status: 404 });
      return new Response(JSON.stringify({ success: true, status: licenses[0].effective_status, activation: { id: act.id, domain: act.domain }, signature: "sig-v" }), { status: 200 });
    }
    if (url.endsWith("/deactivate")) {
      const act = licenses[0].activations.find((a: any) => `tok-${a.id}` === body.activation_token);
      if (act) { act.status = "inactive"; act.deactivated_at = new Date().toISOString(); }
      return new Response(JSON.stringify({ success: true, status: "deactivated" }), { status: 200 });
    }
    if (url.endsWith("/lookup")) {
      expect(init.headers.Authorization).toBe("Bearer svc-token");
      const out = licenses.filter((l) => body.emails.includes(l.owner_email) || body.key_hashes.includes(l.key_hash));
      return new Response(JSON.stringify({ licenses: out }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { calls, licenses, fetchImpl, mode };
}

let env: SitesEnv;
let wp: ReturnType<typeof fakeWpistic>;
beforeEach(async () => {
  env = { DB: await makeD1(), SECRET_ENCRYPTION_KEY: ENC, LICENSE_SERVICE_TOKEN: "svc-token" };
  wp = fakeWpistic();
  wp.licenses[0].key_hash = await sha256Hex("WPI-LEGACY-KEY");
});

const activateBody = (domain: string) => ({ key: "WPI-LEGACY-KEY", domain, site_url: `https://${domain}`, installation_uuid: domain, dashboard_key: { key_id: `wpk_${domain}`, secret: `secret-${domain}` } });

describe("plugin proxy to api.wpistic.com", () => {
  it("strips dashboard_key, passes the signed body through unchanged, and stores one pairing per activation", async () => {
    const res = await proxyActivate(env, activateBody("a.test"), "idem-1", wp.fetchImpl);
    const text = await res.text();
    expect(JSON.parse(text).signature).toBe("sig-upstream");
    expect(wp.calls[0].body.dashboard_key).toBeUndefined();
    expect(wp.calls[0].headers["X-Idempotency-Key"]).toBe("idem-1");
    await proxyActivate(env, activateBody("b.test"), null, wp.fetchImpl);
    const rows = await env.DB.prepare("SELECT id, site_url, key_id, secret_enc FROM site_connections ORDER BY id").all<any>();
    expect(rows.results.map((r) => r.id)).toEqual(["act-1", "act-2"]);
    expect(rows.results[0].secret_enc).not.toContain("secret-a.test");
  });

  it("validate refreshes the pairing (re-pushed key) and deactivate removes it", async () => {
    await proxyActivate(env, activateBody("a.test"), null, wp.fetchImpl);
    await proxyValidate(env, { activation_token: "tok-act-1", dashboard_key: { key_id: "wpk_rotated", secret: "s2" } }, wp.fetchImpl);
    expect((await env.DB.prepare("SELECT key_id FROM site_connections WHERE id='act-1'").first<any>()).key_id).toBe("wpk_rotated");
    await proxyDeactivate(env, { activation_token: "tok-act-1" }, wp.fetchImpl);
    expect(await env.DB.prepare("SELECT id FROM site_connections").first()).toBeNull();
  });

  it("validate 404 upstream drops a stale pairing", async () => {
    await proxyActivate(env, activateBody("a.test"), null, wp.fetchImpl);
    wp.licenses[0].activations[0].status = "inactive";
    const res = await proxyValidate(env, { activation_token: "tok-act-1" }, wp.fetchImpl);
    expect(res.status).toBe(404);
    expect(await env.DB.prepare("SELECT id FROM site_connections").first()).toBeNull();
  });
});

describe("revoked token (401) handling", () => {
  it("validate 401 'Activation token has been revoked' drops the pairing like a 404, body passed through", async () => {
    await proxyActivate(env, activateBody("a.test"), null, wp.fetchImpl);
    wp.mode.validate401 = { code: "unauthorized", message: "Activation token has been revoked" };
    const res = await proxyValidate(env, { activation_token: "tok-act-1" }, wp.fetchImpl);
    expect(res.status).toBe(401);
    expect(JSON.parse(await res.text()).error.message).toBe("Activation token has been revoked");
    expect(await env.DB.prepare("SELECT id FROM site_connections").first()).toBeNull();
  });

  it("other 401s (bad signature, invalid token) keep the pairing", async () => {
    await proxyActivate(env, activateBody("a.test"), null, wp.fetchImpl);
    for (const e of [{ code: "unauthorized", message: "Invalid signature" }, { code: "unauthorized", message: "Invalid activation token" }, { code: "invalid_signature", message: "Activation token has been revoked" }]) {
      wp.mode.validate401 = e;
      const res = await proxyValidate(env, { activation_token: "tok-act-1" }, wp.fetchImpl);
      expect(res.status).toBe(401);
      expect((await env.DB.prepare("SELECT id FROM site_connections").first<any>())?.id).toBe("act-1");
    }
  });

  it("isRevokedToken only matches 401 + unauthorized + revoked message", () => {
    const rev = { error: { code: "unauthorized", message: "Activation token has been revoked" } };
    expect(isRevokedToken(401, rev)).toBe(true);
    expect(isRevokedToken(403, rev)).toBe(false);
    expect(isRevokedToken(401, { error: { code: "unauthorized", message: "Missing signature" } })).toBe(false);
    expect(isRevokedToken(401, null)).toBe(false);
    expect(isRevokedToken(401, "revoked")).toBe(false);
  });
});

describe("/api/me/sites and claiming", () => {
  it("a buyer whose purchase email differs sees nothing until they claim the key, then every site", async () => {
    await proxyActivate(env, activateBody("a.test"), null, wp.fetchImpl);
    await proxyActivate(env, activateBody("b.test"), null, wp.fetchImpl);
    expect((await listMySites(env, USER, wp.fetchImpl)).sites).toHaveLength(0);
    const claim = await claimLicense(env, USER, "WPI-LEGACY-KEY", wp.fetchImpl);
    expect(claim.ok).toBe(true);
    const out = await listMySites(env, USER, wp.fetchImpl);
    expect(out.unlocked).toBe(true);
    expect(out.sites.map((s) => [s.domain, s.status, s.paired])).toEqual([["a.test", "activated", true], ["b.test", "activated", true]]);
    expect(JSON.stringify(out)).not.toMatch(/secret/);
    expect(out.licenses[0]).toMatchObject({ max_activations: 3, used: 2 });
  });

  it("unknown keys are rejected", async () => {
    expect(await claimLicense(env, USER, "nope", wp.fetchImpl)).toMatchObject({ ok: false, status: 404 });
  });

  it("deactivated upstream shows as deactivated and prunes the pairing", async () => {
    wp.licenses[0].owner_email = USER.email;
    await proxyActivate(env, activateBody("a.test"), null, wp.fetchImpl);
    Object.assign(wp.licenses[0].activations[0], { status: "inactive", deactivated_at: new Date().toISOString() });
    const out = await listMySites(env, USER, wp.fetchImpl);
    expect(out.sites[0]).toMatchObject({ status: "deactivated", paired: false, key_id: null });
    expect(await env.DB.prepare("SELECT id FROM site_connections").first()).toBeNull();
  });

  it("expired license shows expired; relay refuses it", async () => {
    wp.licenses[0].owner_email = USER.email;
    await proxyActivate(env, activateBody("a.test"), null, wp.fetchImpl);
    expect(await resolveOwnedSite(env, USER, "act-1", wp.fetchImpl)).toMatchObject({ keyId: "wpk_a.test", secret: "secret-a.test" });
    wp.licenses[0].effective_status = "expired";
    expect((await listMySites(env, USER, wp.fetchImpl)).sites[0].status).toBe("expired");
    expect(await resolveOwnedSite(env, USER, "act-1", wp.fetchImpl)).toBeNull();
  });

  it("relay ownership: another account cannot resolve someone else's site", async () => {
    wp.licenses[0].owner_email = USER.email;
    await proxyActivate(env, activateBody("a.test"), null, wp.fetchImpl);
    expect(await resolveOwnedSite(env, { id: "u2", email: "x@y.z" }, "act-1", wp.fetchImpl)).toBeNull();
  });

  it("siteStatus maps statuses", () => {
    expect(siteStatus("grace_period", "active")).toBe("activated");
    expect(siteStatus("suspended", "active")).toBe("suspended");
    expect(siteStatus("active", "inactive")).toBe("deactivated");
  });
});

describe("legacy console-issued BRG- keys keep working", () => {
  it("local activate writes a per-activation pairing; deactivate removes it; claim reassigns ownership", async () => {
    await env.DB.prepare("INSERT INTO licenses (id, key, plan, site_limit, owner_email) VALUES ('L1','BRG-AAAA-BBBB','lifetime',1,'legacy@else.com')").run();
    const res = await activateLicense(env as never, { key: "BRG-AAAA-BBBB", domain: "c.test", site_url: "https://c.test", installation_uuid: "i", dashboard_key: { key_id: "wpk_c", secret: "sc" } } as never);
    const body = await res.json<any>();
    expect(body.success).toBe(true);
    expect((await claimLicense(env, USER, "BRG-AAAA-BBBB")).ok).toBe(true);
    const out = await listMySites(env, USER, wp.fetchImpl);
    expect(out.sites).toHaveLength(1);
    expect(out.sites[0]).toMatchObject({ source: "legacy", paired: true, status: "activated", domain: "c.test" });
    await deactivateLicense(env.DB, { activation_token: body.activation_token });
    expect(await env.DB.prepare("SELECT id FROM site_connections").first()).toBeNull();
  });
});
