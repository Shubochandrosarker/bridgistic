#!/usr/bin/env node
/**
 * Bridgistic MCP — tool-selection eval.
 *
 * For each task in evals/tool-selection.jsonl, give Claude the real tool list
 * (from the running server) and the task, and check it calls the expected tool.
 * This catches description drift that makes the model pick the wrong tool.
 *
 * Requires ANTHROPIC_API_KEY. Without it, the script explains how to run and
 * exits 0 (so CI without a key doesn't fail).
 *
 * Usage: ANTHROPIC_API_KEY=sk-... node evals/run-tool-selection.mjs
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverEntry = path.join(here, "..", "dist", "index.js");
const MODEL = process.env.BRIDGISTIC_EVAL_MODEL || "claude-sonnet-4-6";

if (!process.env.ANTHROPIC_API_KEY) {
  console.log("SKIP  tool-selection — set ANTHROPIC_API_KEY to run this eval.");
  console.log("      ANTHROPIC_API_KEY=sk-... node evals/run-tool-selection.mjs");
  process.exit(0);
}

function listTools() {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, WP_SITE_URL: "https://example.com", BRIDGISTIC_KEY_ID: "k", BRIDGISTIC_KEY_SECRET: "s_secret_value_1234567890" };
    const child = spawn("node", [serverEntry], { env, stdio: ["pipe", "pipe", "pipe"] });
    let buf = "";
    const t = setTimeout(() => { child.kill(); reject(new Error("timeout")); }, 6000);
    child.stdout.on("data", (d) => {
      buf += d.toString(); let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 2 && m.result?.tools) { clearTimeout(t); child.kill(); resolve(m.result.tools); }
      }
    });
    const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "e", version: "0" } } });
    setTimeout(() => send({ jsonrpc: "2.0", method: "notifications/initialized" }), 150);
    setTimeout(() => send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }), 300);
  });
}

const tools = (await listTools()).map((t) => ({
  name: t.name,
  description: t.description,
  input_schema: t.inputSchema || { type: "object", properties: {} },
}));

const cases = fs.readFileSync(path.join(here, "tool-selection.jsonl"), "utf8")
  .split("\n").filter(Boolean).map((l) => JSON.parse(l));

let pass = 0;
const fails = [];
for (const c of cases) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 512,
      tools,
      tool_choice: { type: "any" },
      messages: [{ role: "user", content: c.task }],
    }),
  });
  const data = await res.json();
  const used = (data.content || []).find((b) => b.type === "tool_use");
  if (used && used.name === c.expect) { pass++; }
  else { fails.push({ task: c.task, expected: c.expect, got: used?.name || "(none)" }); }
}

console.log(`tool-selection — ${pass}/${cases.length} correct`);
for (const f of fails) console.log(`  MISS  "${f.task}" → expected ${f.expected}, got ${f.got}`);
process.exit(fails.length === 0 ? 0 : 1);
