#!/usr/bin/env node
/**
 * End-to-end test of the deployed Bridgistic console API.
 * Usage: node scripts/e2e-test.mjs <base-url> <setup-token>
 */

const base = process.argv[2]?.replace(/\/$/, "") ?? "http://127.0.0.1:8788";
const setupToken = process.argv[3] ?? "";

let pass = 0;
let fail = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// Cookie-carrying fetch per "browser".
function makeSession() {
  let cookie = "";
  return async function call(method, path, body) {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(cookie ? { Cookie: cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) cookie = setCookie.split(";")[0];
    let json = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    return { status: res.status, json, headers: res.headers };
  };
}

// The plugin's verify(): canonical JSON minus signature/token/verification_key,
// HMAC-SHA256 hex keyed by the raw bytes of the verification key.
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  }
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  return JSON.stringify(String(value));
}

async function verifyLicenseSignature(response) {
  const { signature, verification_key: verificationKey } = response;
  if (!signature || !verificationKey) return false;
  const payload = { ...response };
  delete payload.signature;
  delete payload.activation_token;
  delete payload.verification_key;
  const key = Uint8Array.from(verificationKey.match(/../g).map((h) => parseInt(h, 16)));
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(canonicalJson(payload)));
  const expected = [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return expected === signature;
}

const stamp = Date.now().toString(36);
const owner = makeSession();
const member = makeSession();
const anon = makeSession();

console.log(`\nTesting ${base}\n`);

// ── Health + marketplace public reads ───────────────────────────────────────
{
  const health = await anon("GET", "/api/health");
  check("health returns ok", health.status === 200 && health.json?.ok === true);
  const items = await anon("GET", "/api/market/items");
  check("marketplace lists 162 skills", items.json?.items?.length === 162, `got ${items.json?.items?.length}`);
  const freeOnly = await anon("GET", "/api/market/items?tier=free");
  check("free filter returns 100", freeOnly.json?.items?.length === 100, `got ${freeOnly.json?.items?.length}`);
  const detail = await anon("GET", "/api/market/item/bridgistic-mcp");
  check("skill detail is public metadata", detail.json?.item?.slug === "bridgistic-mcp");
  const content = await anon("GET", "/api/market/content/bridgistic-mcp");
  check("anon gets no free file content", content.json?.authorized === false && content.json?.files?.length === 0);
  const paid = await anon("GET", "/api/market/item/claude-code");
  check("paid skill listed", paid.json?.item?.slug === "claude-code" && paid.json?.item?.tier === "paid");
  const download = await anon("GET", "/api/market/download/bridgistic-mcp");
  check("anon download refused with 401", download.status === 401);
}

// ── Owner signup + admin surface ────────────────────────────────────────────
{
  const signup = await owner("POST", "/api/auth/signup", { email: `owner-${stamp}@test.bridgistic.app`, password: "test-pass-123", name: "Platform Owner", setup_token: setupToken });
  check("owner signup with setup token", signup.status === 200 && signup.json?.user?.role === "owner", JSON.stringify(signup.json));
  const me = await owner("GET", "/api/me");
  check("me returns owner + org", me.json?.user?.role === "owner" && me.json?.orgs?.length === 1);
  const stats = await owner("GET", "/api/admin/stats");
  check("admin stats visible to owner", stats.status === 200 && Number(stats.json?.skills) === 162);
  const users = await owner("GET", "/api/admin/users");
  check("admin users list", users.json?.users?.length >= 1);
}

// ── Member signup + gating ──────────────────────────────────────────────────
{
  const signup = await member("POST", "/api/auth/signup", { email: `member-${stamp}@test.bridgistic.app`, password: "test-pass-123", name: "Member" });
  check("member signup", signup.status === 200 && signup.json?.user?.role === "member");
  const me = await member("GET", "/api/me");
  check("member paid_unlock false", me.json?.paid_unlock?.unlocked === false);
  const adminProbe = await member("GET", "/api/admin/stats");
  check("member refused on admin", adminProbe.status === 403);
  const freeContent = await member("GET", "/api/market/content/bridgistic-mcp");
  check("member sees free content", freeContent.json?.authorized === true && freeContent.json?.files?.length > 0);
  const paidContent = await member("GET", "/api/market/content/claude-code");
  check("member blocked from paid content", paidContent.json?.authorized === false);
  const download = await member("GET", "/api/market/download/bridgistic-mcp");
  check("member downloads free zip", download.status === 200 && download.headers.get("content-type") === "application/zip");
}

// ── License contract (as the WordPress plugin calls it) ─────────────────────
{
  const issue = await owner("POST", "/api/admin/licenses", { plan: "lifetime", owner_email: `buyer-${stamp}@example.com`, site_limit: 1, notes: "e2e" });
  check("license issued", issue.status === 200 && /^BRG-LTD-/.test(issue.json?.key ?? ""), JSON.stringify(issue.json).slice(0, 120));
  const key = issue.json?.key;

  const domain = `e2e-${stamp}.example.com`;
  const activate = await anon("POST", "/api/v1/licenses/activate", {
    key,
    domain,
    installation_uuid: "11111111-2222-3333-4444-555555555555",
    site_url: `https://${domain}`,
    home_url: `https://${domain}`,
    environment: "production",
    product_version: "1.5.4",
    wp_version: "6.7",
    php_version: "8.2",
  });
  check("plugin-style activation succeeds", activate.status === 200 && activate.json?.activation_token && activate.json?.product === "bridgistic");
  const signatureValid = await verifyLicenseSignature(activate.json ?? {});
  check("activation response signature verifies (plugin algorithm)", signatureValid === true);

  const second = await anon("POST", "/api/v1/licenses/activate", {
    key,
    domain: `two-${stamp}.example.com`,
    installation_uuid: "11111111-2222-3333-4444-555555555556",
    environment: "production",
  });
  check("site limit enforced (409)", second.status === 409, `got ${second.status}`);

  const validate = await anon("POST", "/api/v1/licenses/validate", { activation_token: activate.json.activation_token, domain, installation_uuid: "11111111-2222-3333-4444-555555555555", plugin_version: "1.5.4" });
  check(
    "validate returns signed active",
    validate.json?.status === "active" && (await verifyLicenseSignature({ ...validate.json, verification_key: activate.json.verification_key })),
    JSON.stringify(validate.json).slice(0, 120)
  );

  const badKey = await anon("POST", "/api/v1/licenses/activate", { key: "BRG-LTD-NOPE-NOPE-NOPE", domain: "x.example.com", installation_uuid: "11111111-2222-3333-4444-555555555557", environment: "production" });
  check("unknown key refused 404", badKey.status === 404);

  const deactivate = await anon("POST", "/api/v1/licenses/deactivate", { activation_token: activate.json.activation_token, installation_uuid: "11111111-2222-3333-4444-555555555555" });
  check("deactivate releases the seat", deactivate.json?.status === "deactivated");
  const reactivate = await anon("POST", "/api/v1/licenses/activate", { key, domain, installation_uuid: "11111111-2222-3333-4444-555555555555", environment: "production" });
  check("reactivation works after release", reactivate.status === 200);

  // Assigning the license to the member's email unlocks the paid marketplace.
  const licenses = await owner("GET", "/api/admin/licenses");
  const row = (licenses.json?.licenses ?? []).find((l) => l.owner_email === `buyer-${stamp}@example.com`);
  const patch = await owner("PATCH", `/api/admin/licenses/${row.id}`, { owner_email: `member-${stamp}@test.bridgistic.app` });
  check("license reassigned to buyer email", patch.status === 200);
  const meAfter = await member("GET", "/api/me");
  check("member now paid_unlocked", meAfter.json?.paid_unlock?.unlocked === true, JSON.stringify(meAfter.json?.paid_unlock));
  const paidContent = await member("GET", "/api/market/content/claude-code");
  check("member now reads paid content", paidContent.json?.authorized === true && paidContent.json?.files?.length > 0);

  const suspend = await owner("PATCH", `/api/admin/licenses/${row.id}`, { status: "suspended" });
  check("license suspended", suspend.status === 200);
  const validateSuspended = await anon("POST", "/api/v1/licenses/validate", { activation_token: reactivate.json.activation_token });
  check(
    "validate reports suspension (signed)",
    validateSuspended.json?.status === "suspended" && (await verifyLicenseSignature({ ...validateSuspended.json, verification_key: reactivate.json.verification_key })),
    JSON.stringify(validateSuspended.json).slice(0, 120)
  );
}

// ── Site connect guards ─────────────────────────────────────────────────────
{
  const orgs = await member("GET", "/api/me");
  const orgId = orgs.json?.orgs?.[0]?.id;
  const localhost = await member("POST", `/api/orgs/${orgId}/sites`, { url: "http://localhost:8080", key_id: "k", secret: "s" });
  check("localhost connect refused", localhost.status === 400, JSON.stringify(localhost.json));
  const bad = await member("POST", `/api/orgs/${orgId}/sites`, { url: `https://e2e-missing-${stamp}.example.com`, key_id: "k", secret: "s" });
  check("unreachable site fails gracefully", [400, 401, 502].includes(bad.status), `got ${bad.status}`);
}

// ── Signin / signout ────────────────────────────────────────────────────────
{
  const fresh = makeSession();
  const signin = await fresh("POST", "/api/auth/signin", { email: `member-${stamp}@test.bridgistic.app`, password: "test-pass-123" });
  check("signin works", signin.status === 200);
  const bad = await fresh("POST", "/api/auth/signin", { email: `member-${stamp}@test.bridgistic.app`, password: "wrong" });
  check("wrong password refused", bad.status === 401);
  const out = await fresh("POST", "/api/auth/signout");
  check("signout ok", out.status === 200);
  const afterOut = await fresh("GET", "/api/me");
  check("session dead after signout", afterOut.status === 401);
}

// ── Sync logs recorded ──────────────────────────────────────────────────────
{
  const logs = await owner("GET", "/api/admin/synclogs");
  const actions = new Set((logs.json?.logs ?? []).map((l) => l.action));
  check("sync log has activate+validate+deactivate", actions.has("activate") && actions.has("validate") && actions.has("deactivate"), [...actions].join(","));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (failures.length) {
  console.log("Failures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
