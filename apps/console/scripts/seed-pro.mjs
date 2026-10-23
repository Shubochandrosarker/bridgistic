#!/usr/bin/env node
/**
 * Imports the curated Pro-30 collection from the Bridgistic skills pack into
 * D1 as tier='pro'. Text files only (SKILL.md, references, scripts); binaries
 * (agent zips, model weights) are skipped. Oversized payloads are stored
 * gzip+base64 with a `gz:` prefix, matching parseFiles() in the router.
 *
 * Usage: node scripts/seed-pro.mjs <pack-dir> <account-id> <database-id> <api-token>
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { gzipSync } from "fflate";

const pack = process.argv[2];
const account = process.argv[3];
const databaseId = process.argv[4];
const token = process.argv[5];

/** The curated Pro-30, ordered for the Skills Hub (flagships first). */
const PRO30 = [
  "knowledge/wpistic-maps",
  "knowledge/wpistic-market-intel",
  "software-development/agentic-runtime",
  "software-development/aios-memory-os",
  "knowledge/ragflow-brain",
  "autonomous-ai-agents/hermes-agent",
  "autonomous-ai-agents/delegated-agents",
  "autonomous-ai-agents/cron-watchdog-patterns",
  "data-science/agentive-analytics-os",
  "data-science/jupyter-live-kernel",
  "devops/cloudflare-workers-deploy",
  "devops/sdlc-review",
  "github/github-issue-to-pr",
  "software-development/plan",
  "software-development/third-party-skill-vetting",
  "email/email-inbox-triage",
  "productivity/document-to-action-items",
  "productivity/meeting-action-items",
  "productivity/weekly-review-planning",
  "productivity/session-librarian",
  "productivity/product-price-monitor",
  "productivity/docx",
  "productivity/xlsx",
  "productivity/pdf",
  "productivity/google-workspace",
  "research/website-intelligence",
  "research/competitor-news-monitor",
  "research/grounded-citations",
  "research/blocked-page-recovery",
  "long-task-context-gpt/long-task-context-gpt",
];

const TEXT_EXT = new Set([".md", ".txt", ".json", ".js", ".mjs", ".py", ".sh", ".yaml", ".yml", ".toml"]);
const SKIP_DIRS = new Set(["node_modules", "__pycache__", ".git"]);

function collectFiles(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(entry)) continue;
      collectFiles(full, base, out);
    } else if (TEXT_EXT.has(extname(entry).toLowerCase())) {
      out.push(full);
    }
  }
  return out;
}

function frontmatterDescription(text, fallback) {
  const match = text.match(/^---\r?\ndescription:\s*"?(.+?)"?\r?\n/m);
  if (match) return match[1].replace(/\s+/g, " ").slice(0, 500);
  return fallback;
}

async function upsert(item) {
  const files = item.files;
  const json = JSON.stringify(files);
  const needsGz = json.length > 90_000;
  const payload = needsGz ? "gz:" + Buffer.from(gzipSync(new TextEncoder().encode(json), { level: 9 })).toString("base64") : json;
  const sql = `INSERT INTO skills (slug, name, description, category, author, handle, tier, version, installs, updated, files)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pro', ?7, ?8, ?9, ?10)
       ON CONFLICT(slug) DO UPDATE SET name=excluded.name, description=excluded.description, category=excluded.category,
         author=excluded.author, handle=excluded.handle, tier='pro', version=excluded.version, updated=excluded.updated, files=excluded.files;`;
  const params = [item.slug, item.name, item.description, item.category, "WordPressistic", "wordpressistic", item.version, item.installs, item.updated, payload];
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${databaseId}/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sql, params }),
  });
  const body = await res.json();
  if (!body.success) {
    console.log("FAIL", item.slug, JSON.stringify(body.errors).slice(0, 160));
    return false;
  }
  console.log("OK  ", item.slug, `${Math.round(payload.length / 1024)}K${needsGz ? " (gz)" : ""}`);
  return true;
}

let ok = 0;
let failed = 0;
for (const rel of PRO30) {
  let dir = join(pack, "skills", rel);
  if (!existsSync(dir)) {
    // Some entries live one level up (category == parent dir name only).
    const alt = join(pack, "skills", rel.split("/").slice(-1)[0]);
    if (existsSync(alt)) dir = alt;
    else {
      console.log("MISS", rel);
      failed += 1;
      continue;
    }
  }
  const slug = rel.split("/").slice(-1)[0];
  const skillMdPath = join(dir, "SKILL.md");
  const skillMd = existsSync(skillMdPath) ? readFileSync(skillMdPath, "utf8") : "";
  const files = collectFiles(dir).map((f) => ({
    path: relative(dir, f).replace(/\\/g, "/"),
    size: statSync(f).size,
    text: readFileSync(f, "utf8"),
  }));
  const nameOverride = {
    "wpistic-maps": "WPistic MAPS",
    "wpistic-market-intel": "WPistic Market Intel",
    "ragflow-brain": "RAGFlow Brain",
    "agentic-runtime": "Agentic Runtime",
    "aios-memory-os": "AIOS Memory OS",
    "hermes-agent": "Hermes Agent",
  }[slug];
  const item = {
    slug,
    name: nameOverride ?? slug,
    description: frontmatterDescription(skillMd, `${nameOverride ?? slug} — a battle-tested production skill from the WPistic pack.`),
    category: rel.includes("/") ? rel.split("/")[0].replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()) : "Pro",
    version: "1.0.0",
    installs: 0,
    updated: "Oct 2026",
    files,
  };
  if (await upsert(item)) ok += 1;
  else failed += 1;
}
console.log(`\nPro collection: ${ok}/30 imported, ${failed} failed`);
