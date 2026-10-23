#!/usr/bin/env node
/**
 * E2E for the 1.5.7 auto-pairing loop, as the plugin and dashboard perform it:
 *   owner issues a license -> the plugin activates pushing its dashboard_key
 *   -> the license owner's dashboard reads /api/me/site-connections (decrypted)
 *   -> "Check now" (validate) re-pushes a rotated key -> strangers get nothing.
 * Usage: node scripts/pairing-e2e.mjs [base-url] [setup-token-file]
 */

import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

const base = (process.argv[2] ?? "https://admin.bridgistic.app").replace(/\/$/, "");
const setupToken = process.argv[3] ? readFileSync(process.argv[3], "utf8").match(/SETUP_TOKEN=(\S+)/)?.[1] ?? "" : "";

let pass = 0;
let fail = 0;
const check = (n, ok, d = "") => {
  if (ok) { pass += 1; console.log(`  ✓ ${n}`); }
  else { fail += 1; console.log(`  ✗ ${n}${d ? ` — ${d}` : ""}`); }
};

function sess() {
  let cookie = "";
  return async function call(method, path, body) {
    // One retry when the edge answers with non-JSON HTML.
    for (let a = 0; a < 2; a++) {
      const res = await fetch(`${base}${path}`, { method, headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
      const sc = res.headers.get("set-cookie");
      if (sc) cookie = sc.split(";")[0];
      let json = null;
      try { json = await res.json(); } catch { json = null; }
      if (json !== null || a === 1) return { status: res.status, json };
      await new Promise((r) => setTimeout(r, 1200));
    }
  };
}

const stamp = Date.now().toString(36);
const owner = sess();
const buyer = sess();
const stranger = sess();

// 1. Owner signs in, creates the buyer account, issues the license.
await owner("POST", "/api/auth/signup", { email: `owner-${stamp}@test.bridgistic.app`, password: "test-pass-123", setup_token: setupToken });
const buyerEmail = `buyer-${stamp}@test.bridgistic.app`;
await buyer("POST", "/api/auth/signup", { email: buyerEmail, password: "test-pass-123", name: "Buyer" });
const issued = await owner("POST", "/api/admin/licenses", { plan: "lifetime", owner_email: buyerEmail, site_limit: 1, notes: "pairing-e2e" });
const key = issued.json?.key;
check("license issued to the buyer account", Boolean(key));

// 2. The plugin (1.5.7) activates and pushes its dashboard key.
const dk = { key_id: `wpk_${stamp}pair`, secret: `wps_${stamp}pairsecret` };
const domain = `pair-${stamp}.example.com`;
const activate = await buyer("POST", "/api/v1/licenses/activate", {
  key,
  domain,
  installation_uuid: crypto.randomUUID(),
  site_url: `https://${domain}`,
  home_url: `https://${domain}`,
  environment: "production",
  product_version: "1.5.7",
  wp_version: "6.7",
  php_version: "8.2",
  dashboard_key: dk,
});
check("plugin-style activation with dashboard_key succeeds", activate.status === 200 && activate.json?.status === "active", JSON.stringify(activate.json).slice(0, 140));
const member = String(activate.json?.member ?? "");
check("response carries masked member email", member.startsWith("bu") && member.includes("@") && member.includes("•"), member);

// Signature verify with the plugin's canonical-JSON HMAC algorithm.
const payload = { ...activate.json };
delete payload.signature;
delete payload.activation_token;
delete payload.verification_key;
const kb = Uint8Array.from(activate.json.verification_key.match(/../g).map((h) => parseInt(h, 16)));
const canon = (v) => Array.isArray(v) ? `[${v.map(canon).join(",")}]` : v !== null && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}` : v === null ? "null" : typeof v === "boolean" ? String(v) : typeof v === "number" ? String(v) : JSON.stringify(String(v));
check("activation signature verifies (plugin algorithm)", createHmac("sha256", kb).update(canon(payload)).digest("hex") === activate.json.signature);

// 3. The buyer's dashboard: auto-connect data present, Pro unlocked.
const meBefore = await buyer("GET", "/api/me");
check("buyer paid_unlock after license assignment", meBefore.json?.paid_unlock?.unlocked === true);
const conns = await buyer("GET", "/api/me/site-connections");
const c = conns.json?.connections?.[0];
check("site-connections returns the paired site", c?.site_url === `https://${domain}` && c?.key_id === dk.key_id, JSON.stringify(conns.json).slice(0, 140));
check("dashboard_key secret round-trips decrypted", c?.secret === dk.secret);

// 4. "Check now" (validate) re-pushes a rotated key — self-healing.
const dk2 = { key_id: dk.key_id, secret: `wps_rotated_${stamp}` };
const validate = await buyer("POST", "/api/v1/licenses/validate", { activation_token: activate.json.activation_token, domain, installation_uuid: "11111111-2222-3333-4444-555555555555", plugin_version: "1.5.7", dashboard_key: dk2 });
check("validate returns signed active + member mask", validate.json?.status === "active" && String(validate.json?.member ?? "").startsWith("bu"));
const conns2 = await buyer("GET", "/api/me/site-connections");
check("rotated dashboard key propagated", conns2.json?.connections?.[0]?.secret === dk2.secret);

// 5. Strangers and anonymous callers get nothing.
await stranger("POST", "/api/auth/signup", { email: `stranger-${stamp}@test.bridgistic.app`, password: "test-pass-123" });
const strangerConns = await stranger("GET", "/api/me/site-connections");
check("non-owner gets no connections", (strangerConns.json?.connections ?? []).length === 0);
check("anonymous refused", (await fetch(`${base}/api/me/site-connections`)).status === 401);

// 6. Cleanup.
const licenses = await owner("GET", "/api/admin/licenses");
const row = (licenses.json?.licenses ?? []).find((l) => l.key === key);
if (row) await owner("PATCH", `/api/admin/licenses/${row.id}`, { status: "revoked" });
const sql = `DELETE FROM licenses WHERE owner_email LIKE '%@test.bridgistic.app';
DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@test.bridgistic.app');
DELETE FROM memberships WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@test.bridgistic.app');
DELETE FROM orgs WHERE owner_user_id IN (SELECT id FROM users WHERE email LIKE '%@test.bridgistic.app');
DELETE FROM users WHERE email LIKE '%@test.bridgistic.app';
SELECT (SELECT COUNT(*) FROM users) users, (SELECT COUNT(*) FROM licenses) licenses;`;
const clean = await fetch(`https://api.cloudflare.com/client/v4/accounts/f06e4bb31e777bc6491dd3d880fa1501/d1/database/ee54b1a5-944f-4130-962a-a737898819a9/query`, {
  method: "POST",
  headers: { Authorization: "Bearer cfat_sHxpHjWV6h9tXqExuyVoepC6dplTMAxCeR9Echpt30d8b258", "Content-Type": "application/json" },
  body: JSON.stringify({ sql }),
});
const cj = await clean.json();
console.log("DB after cleanup:", JSON.stringify(cj.result?.at(-1)?.results?.[0] ?? cj.errors));
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
