#!/usr/bin/env node
/**
 * Proves the full license loop a 1.5.5 plugin performs:
 *   console issues a key (owner) -> plugin-shaped activation against the
 *   console endpoint -> signature verified with the plugin's algorithm ->
 *   validate -> deactivate.
 * Usage: node scripts/license-loop-test.mjs <console-base> <owner-email> <owner-password>
 */

import { createHmac } from "node:crypto";

const base = process.argv[2] ?? "https://admin.bridgistic.app";
const email = process.argv[3];
const password = process.argv[4];

let cookie = "";
async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";")[0];
  return { status: res.status, json: await res.json().catch(() => null) };
}

// 1. Owner signs in and issues a real license.
const signin = await call("POST", "/api/auth/signin", { email, password });
if (signin.status !== 200) throw new Error("owner signin failed: " + signin.status);
const issued = await call("POST", "/api/admin/licenses", { plan: "lifetime", owner_email: "site-activation-test@example.com", site_limit: 1, notes: "1.5.5 loop test" });
if (!issued.json?.key) throw new Error("issue failed: " + JSON.stringify(issued.json));
const key = issued.json.key;
console.log("issued:", key);

// 2. The plugin (LicenseLink::activate) posts exactly this shape.
const stamp = Date.now().toString(36);
const domain = `license-${stamp}.example.com`;
const installationUuid = crypto.randomUUID();
const activate = await call("POST", "/api/v1/licenses/activate", {
  key,
  domain,
  installation_uuid: installationUuid,
  site_url: `https://${domain}`,
  home_url: `https://${domain}`,
  environment: "production",
  product_version: "1.5.5",
  wp_version: "6.7",
  php_version: "8.2",
});
console.log("activate:", activate.status, activate.json?.status, activate.json?.plan);
if (activate.status !== 200 || activate.json?.status !== "active") throw new Error("activation failed");

// 3. The plugin's verify(): canonical JSON minus signature/token/verification_key,
//    HMAC-SHA256 hex keyed by the raw bytes of the hex verification key.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  return JSON.stringify(String(value));
}
const payload = { ...activate.json };
delete payload.signature;
delete payload.activation_token;
delete payload.verification_key;
const keyBytes = Uint8Array.from(activate.json.verification_key.match(/../g).map((h) => parseInt(h, 16)));
const expected = createHmac("sha256", keyBytes).update(canonicalJson(payload)).digest("hex");
if (expected !== activate.json.signature) throw Error("signature mismatch — the plugin would discard this response");
console.log("signature verified with the plugin algorithm ✓");
console.log("entitlements:", JSON.stringify(activate.json.entitlements));

// 4. Scheduled validate (what Check now does).
const validate = await call("POST", "/api/v1/licenses/validate", { activation_token: activate.json.activation_token, domain, environment: "production", installation_uuid: installationUuid, plugin_version: "1.5.5" });
console.log("validate:", validate.status, validate.json?.status);

// 5. Cleanup: deactivate (releases the seat) and revoke the test license so the ledger stays clean.
await call("POST", "/api/v1/licenses/deactivate", { activation_token: activate.json.activation_token, installation_uuid: installationUuid });
const licenses = await call("GET", "/api/admin/licenses");
const row = (licenses.json?.licenses ?? []).find((l) => l.key === key);
if (row) await call("PATCH", `/api/admin/licenses/${row.id}`, { status: "revoked" });
console.log("cleaned up. LOOP OK");
