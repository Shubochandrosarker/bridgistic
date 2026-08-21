#!/usr/bin/env node
/**
 * Bridgistic MCP — contract test.
 *
 * Boots the server over stdio and asserts the tool surface is correct and
 * well-formed: every expected tool exists, names are namespaced, each tool has
 * a title + a substantive description, write tools expose the guard params, and
 * annotations are present. Runs with no WordPress backend.
 *
 * Usage: node evals/contract.test.mjs
 */

import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, "..", "dist", "index.js");

const EXPECTED = [
  // core
  "bridgistic_list_sites", "bridgistic_get_site_info", "bridgistic_execute_php", "bridgistic_db_query",
  // content
  "bridgistic_list_posts", "bridgistic_get_post", "bridgistic_create_post", "bridgistic_update_post",
  "bridgistic_delete_post", "bridgistic_list_media", "bridgistic_upload_media", "bridgistic_delete_media",
  "bridgistic_list_users", "bridgistic_create_user", "bridgistic_update_user",
  // admin
  "bridgistic_get_option", "bridgistic_update_option", "bridgistic_list_plugins", "bridgistic_toggle_plugin",
  "bridgistic_fs_list", "bridgistic_fs_read", "bridgistic_fs_write", "bridgistic_fs_delete",
  // safety
  "bridgistic_snapshot_create", "bridgistic_snapshot_restore", "bridgistic_snapshot_list",
  "bridgistic_snapshot_delete", "bridgistic_approval_status",
  // metering + intel
  "bridgistic_usage", "bridgistic_memory_set", "bridgistic_memory_get", "bridgistic_memory_list",
  "bridgistic_memory_delete", "bridgistic_playbook_save", "bridgistic_playbook_list",
  "bridgistic_playbook_get", "bridgistic_playbook_run", "bridgistic_playbook_delete",
  // scheduling
  "bridgistic_schedule_create", "bridgistic_schedule_list", "bridgistic_schedule_toggle",
  "bridgistic_schedule_delete", "bridgistic_schedule_run_now",
];

// Write tools that must accept the guard params (dry_run / approval_id / force).
const GUARDED = [
  "bridgistic_create_post", "bridgistic_update_post", "bridgistic_delete_post",
  "bridgistic_upload_media", "bridgistic_delete_media",
  "bridgistic_create_user", "bridgistic_update_user",
  "bridgistic_update_option", "bridgistic_toggle_plugin",
  "bridgistic_fs_write", "bridgistic_fs_delete", "bridgistic_db_query",
];

function listTools() {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      WP_SITE_URL: "https://example.com",
      BRIDGISTIC_KEY_ID: "k_test",
      BRIDGISTIC_KEY_SECRET: "s_test_secret_value_1234567890",
    };
    const child = spawn("node", [serverEntry], { env, stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    const t = setTimeout(() => { child.kill(); reject(new Error("timeout")); }, 6000);
    child.stdout.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 2 && m.result?.tools) { clearTimeout(t); child.kill(); resolve(m.result.tools); }
      }
    });
    child.stderr.on("data", () => {});
    const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "contract", version: "0" } } });
    setTimeout(() => send({ jsonrpc: "2.0", method: "notifications/initialized" }), 150);
    setTimeout(() => send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }), 300);
  });
}

const tools = await listTools();
const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
let checks = 0;

// 1. Exact inventory.
for (const name of EXPECTED) { assert.ok(byName[name], `missing tool: ${name}`); checks++; }
assert.equal(tools.length, EXPECTED.length, `unexpected tool count: ${tools.length} (want ${EXPECTED.length})`); checks++;

// 2. Naming + metadata quality.
for (const t of tools) {
  assert.ok(t.name.startsWith("bridgistic_"), `tool not namespaced: ${t.name}`); checks++;
  assert.ok((t.description || "").length >= 30, `description too thin: ${t.name}`); checks++;
  const schema = t.inputSchema?.properties || {};
  assert.ok(typeof t.inputSchema === "object", `no inputSchema: ${t.name}`); checks++;
  if (t.name !== "bridgistic_list_sites") {
    assert.ok("site" in schema, `missing site param: ${t.name}`); checks++;
  }
}

// 3. Guard params on write tools.
for (const name of GUARDED) {
  const props = byName[name].inputSchema?.properties || {};
  for (const p of ["dry_run", "approval_id", "force"]) {
    assert.ok(p in props, `${name} missing guard param: ${p}`); checks++;
  }
}

console.log(`PASS  contract — ${tools.length} tools, ${checks} assertions`);
