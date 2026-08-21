#!/usr/bin/env node
/**
 * The external engine import has to be reproducible.
 *
 * `bridgistic-claude-marketplace` is a live repository under active
 * development. Importing "the latest cloud/src" means the import cannot be
 * reviewed, because what was reviewed is not what will be imported next time.
 * EXTERNAL_ENGINE.lock pins the exact commit; this check keeps the pin
 * well-formed and honest.
 *
 * It deliberately does NOT reach the network. A CI check that fails when
 * GitHub is slow is a check people learn to re-run without reading.
 * Verification against the real remote happens at import time, in Phase 1,
 * where a human is already looking.
 */

import { readFileSync } from "node:fs";

const LOCK = "EXTERNAL_ENGINE.lock";
const text = readFileSync(LOCK, "utf8");

const problems = [];

function value(key) {
  const match = text.match(new RegExp(`^${key}\\s*=\\s*(.+)$`, "m"));
  return match ? match[1].trim().replace(/^["']|["']$/g, "") : undefined;
}

const commit = value("commit");
const repository = value("repository");
const version = value("version");
const testsAtPin = value("tests_at_pin");

if (!commit) {
  problems.push("no `commit` — the pin is the point of this file");
} else if (!/^[0-9a-f]{40}$/.test(commit)) {
  problems.push(
    `commit "${commit}" is not a full 40-character SHA. ` +
      "An abbreviated SHA can become ambiguous as the repository grows, and a " +
      "branch or tag name is not a pin at all — both can move under the import."
  );
}

if (!repository) {
  problems.push("no `repository`");
} else if (!repository.startsWith("https://github.com/")) {
  problems.push(`repository "${repository}" is not an https GitHub URL`);
}

if (!version) problems.push("no `version` — record which release the pin corresponds to");

if (!testsAtPin) {
  problems.push("no `tests_at_pin`");
} else if (!/^\d+$/.test(testsAtPin) || Number(testsAtPin) === 0) {
  problems.push(
    `tests_at_pin "${testsAtPin}" is not a positive count. ` +
      "Pinning a commit whose test suite was never run is pinning an unknown."
  );
}

// The lock declares what is imported and what is excluded. Both lists must be
// present: silence about the excluded half is how proprietary code drifts into
// a public repository.
if (!/^\[import\]/m.test(text)) problems.push("no [import] section — say what is being imported");
if (!/^\[excluded\]/m.test(text)) {
  problems.push(
    "no [excluded] section — say explicitly what stays in the free public repository. " +
      "See docs/LICENSING-DECISION.md."
  );
}

if (problems.length > 0) {
  console.error(`Engine pin check failed — ${LOCK}:\n`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error("");
  process.exit(1);
}

console.log(`Engine pin check passed — ${repository.split("/").pop()} @ ${commit.slice(0, 12)} (v${version}, ${testsAtPin} tests at pin).`);
