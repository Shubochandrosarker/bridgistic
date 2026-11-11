import { describe, it, expect, beforeEach } from "vitest";
import { makeD1 } from "./d1.ts";
import {
  codeHint,
  handleAppsumoRedeem,
  handleAppsumoWebhook,
  hashRedemptionCode,
  parseAppsumoEvent,
  seedMarketplaceCode,
  siteLimitForTier,
  webhookSecretMatches,
} from "../functions/lib/appsumo.ts";

const USER = { id: "u1", email: "buyer@example.com" };
const SECRET = "appsumo-test-secret";

async function seedUser(db: D1Database) {
  await db.prepare("INSERT INTO users (id, email, name, password_hash) VALUES (?, ?, '', 'x')").bind(USER.id, USER.email).run();
  await db.prepare("INSERT INTO orgs (id, name, plan, owner_user_id) VALUES ('org1', 'Buyer workspace', 'free', ?)").bind(USER.id).run();
  await db.prepare("INSERT INTO memberships (org_id, user_id, role) VALUES ('org1', ?, 'owner')").bind(USER.id).run();
}

describe("AppSumo helpers", () => {
  it("maps tiers to site limits", () => {
    expect(siteLimitForTier(1)).toBe(1);
    expect(siteLimitForTier(2)).toBe(3);
    expect(siteLimitForTier(3)).toBe(5);
    expect(siteLimitForTier(99)).toBe(1);
  });

  it("hashes codes without keeping the raw value", async () => {
    const hash = await hashRedemptionCode("  BRG-APP-TESTCODE  ");
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).toBe(await hashRedemptionCode("BRG-APP-TESTCODE"));
    expect(codeHint("BRG-APP-TESTCODE")).toBe("CODE");
  });

  it("parses AppSumo webhook payloads", () => {
    const parsed = parseAppsumoEvent({ event: "purchase", license_key: "SUMO-123456", tier: 2 });
    expect(parsed).toEqual({ event: "purchase", licenseKey: "SUMO-123456", prevLicenseKey: "", tier: 2 });
    expect(parseAppsumoEvent({ event: "purchase" })).toBeNull();
  });

  it("accepts bearer or named webhook secrets", () => {
    const req = new Request("https://admin.bridgistic.app/api/webhooks/appsumo", {
      method: "POST",
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    expect(webhookSecretMatches(req, SECRET)).toBe(true);
    expect(webhookSecretMatches(req, "wrong")).toBe(false);
    expect(webhookSecretMatches(req, undefined)).toBe(false);
  });
});

describe("AppSumo webhook and redeem", () => {
  let db: D1Database;
  beforeEach(async () => {
    db = await makeD1();
    await seedUser(db);
  });

  it("rejects a webhook without the shared secret", async () => {
    const res = await handleAppsumoWebhook(
      new Request("https://admin.bridgistic.app/api/webhooks/appsumo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "purchase", license_key: "SUMO-123456", tier: 1 }),
      }),
      { DB: db, APPSUMO_WEBHOOK_SECRET: SECRET }
    );
    expect(res.status).toBe(401);
  });

  it("stores a purchase then issues a lifetime license on redeem", async () => {
    const hook = await handleAppsumoWebhook(
      new Request("https://admin.bridgistic.app/api/webhooks/appsumo", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${SECRET}` },
        body: JSON.stringify({ event: "purchase", license_key: "SUMO-TIER2-ABCDEF", tier: 2 }),
      }),
      { DB: db, APPSUMO_WEBHOOK_SECRET: SECRET }
    );
    expect(hook.status).toBe(200);

    const res = await handleAppsumoRedeem(
      new Request("https://admin.bridgistic.app/api/appsumo/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "SUMO-TIER2-ABCDEF" }),
      }),
      { DB: db },
      USER
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { license: { key: string; site_limit: number; plan: string }; repeated: boolean };
    expect(body.repeated).toBe(false);
    expect(body.license.plan).toBe("lifetime");
    expect(body.license.site_limit).toBe(3);
    expect(body.license.key).toMatch(/^BRG-LTD-/);

    const again = await handleAppsumoRedeem(
      new Request("https://admin.bridgistic.app/api/appsumo/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "SUMO-TIER2-ABCDEF" }),
      }),
      { DB: db },
      USER
    );
    const replay = await again.json() as { repeated: boolean; license: { key: string } };
    expect(replay.repeated).toBe(true);
    expect(replay.license.key).toBe(body.license.key);

    const other = await handleAppsumoRedeem(
      new Request("https://admin.bridgistic.app/api/appsumo/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "SUMO-TIER2-ABCDEF" }),
      }),
      { DB: db },
      { id: "u2", email: "other@example.com" }
    );
    expect(other.status).toBe(409);
  });

  it("rejects unknown codes and lets an owner seed one for support", async () => {
    const missing = await handleAppsumoRedeem(
      new Request("https://admin.bridgistic.app/api/appsumo/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "DOES-NOT-EXIST" }),
      }),
      { DB: db },
      USER
    );
    expect(missing.status).toBe(400);
    const seeded = await seedMarketplaceCode(db, { code: "SUPPORT-SEED-CODE", tier: 1 }, "owner@bridgistic.app");
    expect(seeded.code_hint).toBe("CODE");
    const redeemed = await handleAppsumoRedeem(
      new Request("https://admin.bridgistic.app/api/appsumo/redeem", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: "SUPPORT-SEED-CODE" }),
      }),
      { DB: db },
      USER
    );
    expect(redeemed.status).toBe(200);
  });
});
