#!/usr/bin/env node
/**
 * Bridgistic MCP — integration test (no WordPress required).
 *
 * Stands up a mock "bridge" HTTP server that re-verifies the HMAC signature
 * exactly like the PHP plugin, records the method/route/body it received, and
 * returns a canned envelope. The real MCP server is pointed at it and driven
 * through genuine `tools/call` requests. This proves end-to-end that tools sign
 * correctly, hit the right route + method, forward guard params, and that
 * DELETE carries a signed body.
 *
 * Usage: node evals/integration.test.mjs
 */

import { spawn } from "node:child_process";
import http from "node:http";
import crypto from "node:crypto";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, "..", "dist", "index.js");
const KEY_ID = "k_test";
const SECRET = "s_test_secret_value_1234567890";

// ---- mock bridge (verifies HMAC like the PHP plugin) ----------------------
const received = [];
function verify(method, urlPath, headers, body) {
  const ts = headers["x-bridgistic-timestamp"];
  const nonce = headers["x-bridgistic-nonce"];
  const given = headers["x-bridgistic-signature"];
  const key = headers["x-bridgistic-key"];
  if (key !== KEY_ID || !ts || !nonce || !given) return false;
  const bodyHash = crypto.createHash("sha256").update(body, "utf8").digest("hex");
  const canonical = [method, urlPath, ts, nonce, bodyHash].join("\n");
  const expect = crypto.createHmac("sha256", SECRET).update(canonical, "utf8").digest("hex");
  return expect.length === given.length && crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(given));
}

const mock = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const u = new URL(req.url, "http://localhost");
    const routePath = u.pathname; // e.g. /wp-json/bridgistic/v1/posts
    const signedPath = routePath.replace("/wp-json", ""); // /bridgistic/v1/posts
    const headers = req.headers;
    const ok = verify(req.method, signedPath, headers, body);
    received.push({
      method: req.method,
      route: signedPath.replace("/bridgistic/v1/", ""),
      query: Object.fromEntries(u.searchParams),
      body: body ? JSON.parse(body) : null,
      signed: ok,
    });
    res.setHeader("Content-Type", "application/json");
    if (!ok) {
      res.statusCode = 401;
      res.end(JSON.stringify({ code: "auth", message: "bad signature" }));
      return;
    }
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: true, data: { echo: signedPath, method: req.method } }));
  });
});

const port = await new Promise((r) => mock.listen(0, () => r(mock.address().port)));

// ---- MCP server over stdio ------------------------------------------------
const env = {
  ...process.env,
  WP_SITE_URL: `http://127.0.0.1:${port}`,
  BRIDGISTIC_KEY_ID: KEY_ID,
  BRIDGISTIC_KEY_SECRET: SECRET,
};
const child = spawn("node", [serverEntry], { env, stdio: ["pipe", "pipe", "pipe"] });
const pending = new Map();
let buf = "";
child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  }
});
child.stderr.on("data", () => {});

let id = 1;
const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
const rpc = (method, params) =>
  new Promise((resolve, reject) => {
    const myId = ++id;
    pending.set(myId, resolve);
    send({ jsonrpc: "2.0", id: myId, method, params });
    setTimeout(() => reject(new Error(`rpc timeout: ${method}`)), 5000);
  });

send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "it", version: "0" } } });
await new Promise((r) => setTimeout(r, 250));
send({ jsonrpc: "2.0", method: "notifications/initialized" });
await new Promise((r) => setTimeout(r, 150));

const call = (name, args) => rpc("tools/call", { name, arguments: args });

let checks = 0;
function expectCall(idx, { method, route }) {
  const got = received[idx];
  assert.ok(got, `no request recorded at #${idx}`);
  assert.ok(got.signed, `request #${idx} (${got.route}) failed HMAC verification`);
  assert.equal(got.method, method, `#${idx} method ${got.method} != ${method}`);
  assert.equal(got.route.split("?")[0], route, `#${idx} route ${got.route} != ${route}`);
  checks += 3;
}

// 1. GET read → correct route + method, signed.
await call("bridgistic_get_site_info", {});
expectCall(0, { method: "GET", route: "site-info" });

// 2. POST create → body forwarded, guard param forwarded.
await call("bridgistic_create_post", { title: "Hello", status: "draft", dry_run: true });
expectCall(1, { method: "POST", route: "posts" });
assert.equal(received[1].body.title, "Hello", "create_post title not forwarded"); checks++;
assert.equal(received[1].body.dry_run, true, "dry_run guard param not forwarded"); checks++;

// 3. POST update with id in route.
await call("bridgistic_update_post", { id: 42, content: "x" });
expectCall(2, { method: "POST", route: "posts/42" });

// 4. DELETE carries a signed body (the hard case).
await call("bridgistic_delete_post", { id: 7, permanent: true });
expectCall(3, { method: "DELETE", route: "posts/7" });
assert.equal(received[3].body.permanent, true, "DELETE body not forwarded/signed"); checks++;

// 5. GET option with query string.
await call("bridgistic_get_option", { name: "blogname" });
expectCall(4, { method: "GET", route: "options" });
assert.equal(received[4].query.name, "blogname", "option name query not forwarded"); checks++;

// 6. Playbook run routes to playbooks/run.
await call("bridgistic_playbook_run", { slug: "demo", vars: { title: "Z" } });
expectCall(5, { method: "POST", route: "playbooks/run" });

// 7. Schedule create routes to schedules.
await call("bridgistic_schedule_create", { playbook: "demo", recurrence: "daily" });
expectCall(6, { method: "POST", route: "schedules" });

child.kill();
mock.close();
console.log(`PASS  integration — ${received.length} signed calls, ${checks} assertions`);
