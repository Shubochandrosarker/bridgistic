#!/usr/bin/env node
/**
 * Stops an unfinished thing from being mistaken for a finished one.
 *
 * The rule this enforces is operating rule 9: an unimplemented route, a 501, a
 * placeholder, an intentional throw, a TODO or a REPLACE_ME must be *reported*
 * — not discovered by a customer.
 *
 * It does not ban them. A scaffold that returns 501 and says which phase will
 * implement it is more honest than a 404. What it bans is an *undeclared* one:
 * every hit has to be listed in the allowlist below, with a phase and a reason.
 * Deleting the code deletes the entry; adding new unfinished code without an
 * entry fails the build.
 *
 * That inverts the usual failure mode. The danger is never the TODO you
 * remember — it is the one nobody wrote down.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

/** Directories that are not built, tested or shipped. */
const SKIP_DIRS = new Set(["node_modules", ".git", "legacy", "dist", "build", ".wrangler", "coverage"]);

/** Only files that can end up in a deployed Worker or a migration. */
const SCANNED = /\.(ts|tsx|js|mjs|sql|toml)$/;

/**
 * Patterns that mean "not finished".
 *
 * `501` is matched as a status literal rather than anywhere the digits appear,
 * so a timeout of 5010ms is not a finding.
 */
const PATTERNS = [
  { id: "REPLACE_ME", re: /REPLACE_ME/ },
  { id: "TODO", re: /\b(TODO|FIXME|XXX|HACK)\b/ },
  { id: "501", re: /status:\s*501|statusCode\s*=\s*501|"?501"?\s*,\s*\/\/|\b501\b\s*\)/ },
  { id: "not_implemented", re: /not_implemented|NotImplemented|notImplemented/ },
  { id: "intentional-throw", re: /throw new Error\((["'`])[^"'`]*\b(lands in phase|not implemented|unimplemented)/i },
  { id: "placeholder-secret", re: /(CHANGEME|changeme|your-.*-here|xxxxxxxx)/ },
];

/**
 * Declared unfinished work. Every entry is a promise that it is tracked.
 *
 * `file` is an exact repository-relative path. `phase` must match the phase in
 * IMPLEMENTATION_PLAN.md that closes it.
 */
const ALLOWLIST = [
  {
    file: "apps/api/src/index.ts",
    ids: ["501", "not_implemented"],
    phase: "2-5",
    why: "Declared route surface. Each route returns 501 naming its phase; a 404 would read as 'wrong URL'. Tracked as BR-007.",
  },
  {
    file: "apps/mcp/src/index.ts",
    ids: ["501", "not_implemented"],
    phase: "1",
    why: "Serves /health only until cloud/src is imported. Everything else is 501 naming the phase. Tracked as BR-007.",
  },
  {
    file: "apps/scheduler/src/index.ts",
    ids: ["intentional-throw"],
    phase: "5",
    why: "Queue consumer is deliberately not wired. Throwing with a doc pointer beats silently dropping a run. Tracked as BR-008.",
  },
  {
    file: "packages/contracts/src/types.ts",
    ids: ["not_implemented"],
    phase: "1",
    why: "ERROR_CODES declares `not_implemented` as a vocabulary entry. It is the name of a response an API can legitimately give, not a marker of unfinished code — the scanner cannot tell a declaration from a usage.",
  },
  {
    file: "scripts/check-placeholders.mjs",
    ids: ["REPLACE_ME", "TODO", "501", "not_implemented", "intentional-throw", "placeholder-secret"],
    phase: "0",
    why: "This file necessarily contains the patterns it searches for.",
  },
];

const findings = [];

walk(".");

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      walk(path);
      continue;
    }
    if (!SCANNED.test(entry)) continue;
    scan(path);
  }
}

function scan(path) {
  const rel = relative(".", path);
  const lines = readFileSync(path, "utf8").split("\n");
  const allowed = ALLOWLIST.find((a) => a.file === rel);

  lines.forEach((line, i) => {
    for (const { id, re } of PATTERNS) {
      if (!re.test(line)) continue;
      if (allowed?.ids.includes(id)) continue;
      findings.push({ file: rel, line: i + 1, id, text: line.trim().slice(0, 100) });
    }
  });
}

// An allowlist entry for code that no longer has the pattern is stale, and a
// stale allowlist is how a real finding gets waved through later.
const stale = ALLOWLIST.filter((a) => {
  let text;
  try {
    text = readFileSync(a.file, "utf8");
  } catch {
    return true; // file is gone
  }
  return !a.ids.some((id) => PATTERNS.find((p) => p.id === id)?.re.test(text));
});

if (findings.length > 0 || stale.length > 0) {
  if (findings.length > 0) {
    console.error(`Placeholder check failed — ${findings.length} undeclared finding(s):\n`);
    for (const f of findings) {
      console.error(`  ✗ ${f.file}:${f.line}  [${f.id}]  ${f.text}`);
    }
    console.error(
      "\n  Either finish the code, or add it to ALLOWLIST in scripts/check-placeholders.mjs\n" +
        "  with the phase that closes it — and record it in BUILD_STATUS.md.\n"
    );
  }
  for (const s of stale) {
    console.error(`  ✗ stale allowlist entry: ${s.file} no longer matches ${s.ids.join(", ")} — remove it.`);
  }
  process.exit(1);
}

console.log(
  `Placeholder check passed — 0 undeclared, ${ALLOWLIST.length} declared and tracked ` +
    `(phases ${[...new Set(ALLOWLIST.map((a) => a.phase))].join(", ")}).`
);
