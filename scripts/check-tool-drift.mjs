#!/usr/bin/env node
/**
 * Cross-repository drift check.
 *
 * The hosted platform and the free local MCP server expose the same tools to
 * the same clients. If they stop agreeing, a customer who develops against one
 * and deploys against the other gets a failure nobody can reproduce.
 *
 * Compares the contract registry against `engine-manifest.json`, generated
 * from the commit pinned in `EXTERNAL_ENGINE.lock`. Runs offline.
 *
 * The interesting part is not detecting difference — it is knowing which
 * differences are intentional. A check that fails on every deliberate
 * divergence gets a blanket exception added to it within a week, and after
 * that it detects nothing. So intentional divergences are declared here, one
 * by one, with the reason and the finding id; anything undeclared fails.
 *
 * A declaration that no longer describes reality also fails. An exception
 * outliving the thing it excepted is how a real drift gets waved through.
 */

import { readFileSync } from "node:fs";
import { allContracts } from "../packages/contracts/src/registry.ts";

const manifest = JSON.parse(readFileSync("engine-manifest.json", "utf8"));
const lock = readFileSync("EXTERNAL_ENGINE.lock", "utf8");
const pinned = lock.match(/^commit\s*=\s*(\S+)$/m)?.[1];

/**
 * Arguments the hosted platform deliberately does not accept, or adds.
 *
 * `direction`:
 *   "engine-only"  — the engine takes it, we refuse it
 *   "hosted-only"  — we take it, the engine does not
 */
const DECLARED_ARG_DIVERGENCES = [
  {
    arg: "force",
    direction: "engine-only",
    tools: "*",
    finding: "BR-013",
    why:
      "A caller-settable bypass of the snapshot gate. Reasonable on a local server an operator runs against " +
      "their own site; not reasonable when the caller is a language model and the site belongs to somebody " +
      "else. Bypassing is an approval with a reason, granted by a person.",
  },
  {
    arg: "password",
    direction: "engine-only",
    tools: ["bridgistic_create_user"],
    finding: "BR-014",
    why:
      "A password in a tool argument passes through the model's context window, the MCP transport and the " +
      "client's logging. WordPress generates one and emails the user directly.",
  },
  {
    arg: "idempotency_key",
    direction: "hosted-only",
    tools: "*",
    finding: null,
    why:
      "The hosted platform can be retried by a queue, a redelivery or a load balancer; the local server cannot. " +
      "Without the key the executor cannot tell a retry from a second request.",
  },
  {
    arg: "approval_id",
    direction: "hosted-only",
    tools: ["bridgistic_execute_php", "bridgistic_snapshot_restore", "bridgistic_snapshot_delete"],
    finding: null,
    why:
      "A platform argument, not a plugin one: it names which approval the gate should check, and is consumed " +
      "by assertCallable rather than forwarded to WordPress. The engine's own guardParams carries it on the " +
      "tools it gates; these three are gated by the hosted platform and not by the local server, so only the " +
      "hosted contract needs it. Without it an approval-gated tool has no way to complete its own flow.",
  },
  {
    arg: "timezone",
    direction: "hosted-only",
    tools: ["bridgistic_schedule_create"],
    finding: null,
    why:
      "The hosted scheduler runs in UTC on Cloudflare and must be told the customer's zone. The local server " +
      "inherits the machine's.",
  },
];

const problems = [];
const notes = [];

if (manifest.commit !== pinned) {
  problems.push(
    `engine-manifest.json was generated from ${manifest.commit?.slice(0, 12)} but EXTERNAL_ENGINE.lock pins ` +
      `${pinned?.slice(0, 12)}. Regenerate it: node scripts/build-engine-manifest.mjs <checkout>`
  );
}

const contracts = allContracts();
const ours = new Map(contracts.map((c) => [c.name, c]));
const theirs = new Map(manifest.tools.map((t) => [t.name, t]));

// ------------------------------------------------------------ tool presence --

for (const name of theirs.keys()) {
  if (!ours.has(name)) {
    problems.push(
      `${name} exists in the engine but has no contract here. A tool a customer can call locally and not in ` +
        `the cloud is a support ticket that starts "it works on my machine".`
    );
  }
}

for (const name of ours.keys()) {
  if (!theirs.has(name)) {
    problems.push(
      `${name} has a contract here but does not exist in the engine at ${pinned?.slice(0, 12)}. ` +
        `Either the engine pin is stale, or a tool was invented on the hosted side without a handler.`
    );
  }
}

// ------------------------------------------------------------------- scopes --

for (const [name, contract] of ours) {
  const engineTool = theirs.get(name);
  if (!engineTool || engineTool.scopes.length === 0) continue;

  // The engine documents the scope in prose; we hold it as data. They must
  // agree, because the plugin enforces one of them and we bill against ours.
  const declared = new Set(contract.requiredScopes.concat(contract.minScope ? [contract.minScope] : []));
  for (const scope of engineTool.scopes) {
    if (!declared.has(scope)) {
      problems.push(
        `${name}: the engine documents scope "${scope}", the contract requires ` +
          `${[...declared].join(", ") || "(none)"}. The plugin enforces the plugin's answer, so ours would ` +
          `authorise and meter against a scope the site does not check.`
      );
    }
  }
}

// ---------------------------------------------------------------- arguments --

for (const [name, contract] of ours) {
  const engineTool = theirs.get(name);
  if (!engineTool) continue;

  const oursArgs = new Set(Object.keys(contract.inputSchema.properties ?? {}));
  const theirsArgs = new Set(engineTool.args);

  for (const arg of theirsArgs) {
    if (oursArgs.has(arg)) continue;
    const declared = declaredFor(arg, name, "engine-only");
    if (declared) {
      notes.push(`${name}: does not accept "${arg}" — ${declared.finding ?? "by design"}`);
      continue;
    }
    problems.push(
      `${name}: the engine accepts "${arg}" and the contract does not. A caller who works locally will get ` +
        `an invalid_request in the cloud. Add it, or declare the divergence in DECLARED_ARG_DIVERGENCES.`
    );
  }

  for (const arg of oursArgs) {
    if (theirsArgs.has(arg)) continue;
    const declared = declaredFor(arg, name, "hosted-only");
    if (declared) continue;
    problems.push(
      `${name}: the contract accepts "${arg}" and the engine does not. Either the plugin ignores it — in which ` +
        `case we are advertising an argument that does nothing — or the pin is stale.`
    );
  }
}

// --------------------------------------------------- stale declarations ------

for (const divergence of DECLARED_ARG_DIVERGENCES) {
  const applies = divergence.tools === "*" ? [...ours.keys()] : divergence.tools;
  const stillTrue = applies.some((name) => {
    const contract = ours.get(name);
    const engineTool = theirs.get(name);
    if (!contract || !engineTool) return false;
    const inOurs = Object.hasOwn(contract.inputSchema.properties ?? {}, divergence.arg);
    const inTheirs = engineTool.args.includes(divergence.arg);
    return divergence.direction === "engine-only" ? inTheirs && !inOurs : inOurs && !inTheirs;
  });

  if (!stillTrue) {
    problems.push(
      `DECLARED_ARG_DIVERGENCES has a stale entry for "${divergence.arg}" (${divergence.direction}): ` +
        `nothing diverges that way any more. Remove it — an exception that outlives its cause is how the ` +
        `next real drift gets waved through.`
    );
  }
}

function declaredFor(arg, toolName, direction) {
  return DECLARED_ARG_DIVERGENCES.find(
    (d) => d.arg === arg && d.direction === direction && (d.tools === "*" || d.tools.includes(toolName))
  );
}

// ------------------------------------------------------------------ report --

if (problems.length > 0) {
  console.error(`Tool drift check failed — ${problems.length} problem(s):\n`);
  for (const problem of problems) console.error(`  ✗ ${problem}\n`);
  process.exit(1);
}

console.log(
  `Tool drift check passed — ${ours.size} contracts against ${theirs.size} engine tools at ` +
    `${pinned?.slice(0, 12)}, ${DECLARED_ARG_DIVERGENCES.length} declared divergences.`
);
for (const note of [...new Set(notes)].slice(0, 5)) console.log(`    · ${note}`);
