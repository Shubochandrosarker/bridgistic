#!/usr/bin/env node
/**
 * BR-001 regression guard.
 *
 * The deploy workflow took an `environment` input, printed it in the job name,
 * bound the GitHub environment to it — and then ran `wrangler deploy` without
 * `--env`. Wrangler fell back to the top-level config, which carried the
 * production routes. Choosing "staging" deployed to production, and every
 * signal in the UI said staging.
 *
 * Nothing failed, because nothing was checking. This is that check.
 *
 * Two halves, and both matter:
 *   1. Every `wrangler deploy` in a workflow passes `--env`.
 *   2. No wrangler.toml has a deployable top-level environment to fall back to,
 *      and every app declares both `staging` and `production`.
 *
 * Half 2 is the one that holds: if there is no unnamed environment worth
 * deploying, a future missing `--env` fails loudly instead of quietly.
 */

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const APPS = ["mcp", "api", "scheduler"];
const REQUIRED_ENVS = ["staging", "production"];

/** Top-level keys that make an unnamed environment deployable, and dangerous. */
const FORBIDDEN_TOP_LEVEL = [
  { key: "routes", why: "a top-level route is a live customer-facing hostname" },
  { key: "d1_databases", why: "a top-level D1 binding points at a real database" },
  { key: "kv_namespaces", why: "a top-level KV binding points at a real namespace" },
  { key: "queues", why: "a top-level queue binding attaches to a real queue" },
  { key: "triggers", why: "a top-level cron trigger starts firing on deploy" },
  { key: "durable_objects", why: "a top-level Durable Object binding is live state" },
];

const problems = [];

// ---------------------------------------------------------------- workflows --
const workflowDir = ".github/workflows";
for (const file of readdirSync(workflowDir).filter((f) => /\.ya?ml$/.test(f))) {
  const path = join(workflowDir, file);
  const text = readFileSync(path, "utf8");

  // Normalise YAML block scalars and line continuations so a command split
  // across lines is examined as one command.
  const flat = text.replace(/>-?\s*\n/g, " ").replace(/\n\s+/g, " ");

  for (const match of flat.matchAll(/npx wrangler deploy([^\n]*)/g)) {
    const args = match[1];
    if (!/--env\s+\S/.test(args)) {
      problems.push(
        `${path}: \`wrangler deploy\` without --env.\n` +
          `    ${match[0].trim().slice(0, 120)}\n` +
          `    Without --env, Wrangler uses the top-level config. Pass --env explicitly.`
      );
    }
  }
}

// ------------------------------------------------------------ wrangler.toml --
for (const app of APPS) {
  const path = `apps/${app}/wrangler.toml`;
  const text = readFileSync(path, "utf8");

  // Strip comments before looking for section headers, so a commented-out
  // binding — which is how a not-yet-migrated Durable Object is parked — does
  // not read as a live one.
  const live = text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

  // A bare `routes = [...]` means different things depending on which table it
  // sits in, so the file has to be walked with the current table tracked. A
  // line-oriented regex reads `routes` under [env.staging] as top-level and
  // reports a problem that is not there.
  for (const { key, why } of topLevelKeys(live)) {
    problems.push(
      `${path}: top-level \`${key}\` — ${why}.\n` +
        `    Move it under [env.staging] and [env.production] so a deploy ` +
        `without --env has nothing to reach.`
    );
  }

  for (const env of REQUIRED_ENVS) {
    if (!new RegExp(`^\\[env\\.${env}\\]`, "m").test(live)) {
      problems.push(`${path}: no [env.${env}] section. Every app must declare both environments.`);
    }
  }

  // Staging and production must not share a database or a queue. Sharing one
  // means a staging test writes to production data.
  const stagingBlock = section(live, "staging");
  const productionBlock = section(live, "production");
  for (const key of ["database_name", "queue"]) {
    const inStaging = new Set([...stagingBlock.matchAll(new RegExp(`${key}\\s*=\\s*"([^"]+)"`, "g"))].map((m) => m[1]));
    for (const [, value] of productionBlock.matchAll(new RegExp(`${key}\\s*=\\s*"([^"]+)"`, "g"))) {
      if (inStaging.has(value)) {
        problems.push(`${path}: staging and production share ${key} "${value}". They must be separate.`);
      }
    }
  }
}

/**
 * Forbidden keys that live in the root table — outside any `[env.*]`.
 *
 * TOML scopes a bare assignment to the most recent table header, so the walk
 * tracks that header. `routes = [...]` after `[env.staging]` belongs to
 * staging; the same line before any header belongs to the root table and is
 * what makes a `--env`-less deploy dangerous.
 */
function topLevelKeys(text) {
  const found = [];
  let table = ""; // "" is the root table

  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;

    const header = line.match(/^\[\[?([^\]]+)\]\]?$/);
    if (header) {
      table = header[1].trim();
      const entry = FORBIDDEN_TOP_LEVEL.find(
        ({ key }) => table === key || table.startsWith(`${key}.`)
      );
      if (entry) found.push(entry);
      continue;
    }

    if (table !== "") continue; // an assignment inside some table, not the root
    const assignment = line.match(/^([A-Za-z_][\w-]*)\s*=/);
    if (!assignment) continue;
    const entry = FORBIDDEN_TOP_LEVEL.find(({ key }) => key === assignment[1]);
    if (entry) found.push(entry);
  }

  // Deduplicate: three `[[d1_databases]]` blocks are one problem, not three.
  return [...new Map(found.map((e) => [e.key, e])).values()];
}

/** The text belonging to `[env.<name>]`, up to the next environment header. */
function section(text, name) {
  const start = text.search(new RegExp(`^\\[env\\.${name}\\]`, "m"));
  if (start === -1) return "";
  const rest = text.slice(start + 1);
  const end = rest.search(/^\[env\.(?!\s*$)[a-z]+\]/m);
  return end === -1 ? rest : rest.slice(0, end);
}

if (problems.length > 0) {
  console.error("Deploy environment check failed:\n");
  for (const p of problems) console.error(`  ✗ ${p}\n`);
  process.exit(1);
}

console.log(`Deploy environment check passed — ${APPS.length} apps, both environments, no top-level fallback.`);
