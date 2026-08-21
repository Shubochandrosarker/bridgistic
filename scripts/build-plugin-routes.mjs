#!/usr/bin/env node
/**
 * Generate `plugin-routes.json` from the pinned engine's WordPress plugin.
 *
 *   node scripts/build-plugin-routes.mjs /path/to/bridgistic-claude-marketplace
 *
 * The plugin's `register_rest_route` calls are the only authority on what a
 * site will answer. The tool catalogue carries a route and a method for every
 * tool, and nothing compared the two — `check-tool-drift.mjs` compares tool
 * NAMES and ARGUMENTS against the engine manifest, which is why a table of
 * routes that had drifted from the plugin passed every check in the repository
 * (BR-019).
 *
 * Committed so `check-plugin-routes.mjs` runs offline, for the same reason the
 * engine manifest is: a check that clones a repository fails when GitHub is
 * slow, and a check that fails for unrelated reasons is one people learn to
 * re-run without reading.
 */

import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

const checkout = process.argv[2];
if (!checkout) {
  console.error("usage: node scripts/build-plugin-routes.mjs <path-to-engine-checkout>");
  process.exit(2);
}

const pinned = readFileSync("EXTERNAL_ENGINE.lock", "utf8").match(/^commit\s*=\s*(\S+)$/m)?.[1];
if (!pinned) {
  console.error("EXTERNAL_ENGINE.lock has no commit.");
  process.exit(2);
}

const head = execFileSync("git", ["-C", checkout, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (head !== pinned) {
  console.error(`Checkout is at ${head}, EXTERNAL_ENGINE.lock pins ${pinned}.`);
  process.exit(2);
}

const restDir = join(checkout, "wordpress-plugin", "bridgistic", "includes", "rest");
const routes = new Set();

/**
 * Turn a WordPress route pattern into the catalogue's shape.
 *
 * `posts/(?P<id>\d+)` becomes `posts/{id}`. The catalogue needs a form it can
 * substitute an argument into; the plugin needs a regular expression. This is
 * the one translation between them, and it lives here rather than being done
 * twice by eye.
 */
function normalise(route) {
  return route
    .replace(/^\/+/, "")
    .replace(/\(\?P<(\w+)>[^)]*\)/g, "{$1}");
}

/** Loop templates the plain pass saw, so each can be checked for substitution. */
const templates = new Set();

function record(route, methods) {
  for (const method of methods.length > 0 ? methods : ["?"]) {
    for (const one of method.split(",")) routes.add(`${one.trim()} ${normalise(route)}`);
  }
}

for (const file of readdirSync(restDir).filter((f) => f.endsWith(".php"))) {
  const src = readFileSync(join(restDir, file), "utf8");

  // Arrays assigned to a variable and then iterated, which is how the woo
  // controller registers its five read-only routes. Resolved first so the
  // loop below can look them up.
  const arrays = new Map();
  for (const assign of src.matchAll(/\$(\w+)\s*=\s*array\(([\s\S]*?)\n\t\t\);/g)) {
    const [, name, body] = assign;
    const pairs = [...body.matchAll(/'([^']+)'\s*=>\s*'([^']+)'/g)].map((m) => m[1]);
    const plain = [...body.matchAll(/'([^']+)'\s*,/g)].map((m) => m[1]);
    arrays.set(name, pairs.length > 0 ? pairs : plain);
  }

  // Routes registered inside a `foreach`, which is how the fs, schedule and
  // woo controllers register most of theirs. Missing these is how a
  // hand-written route list ends up incomplete.
  for (const loop of src.matchAll(
    /foreach\s*\(\s*(?:array\(([\s\S]*?)\)|\$(\w+))\s+as\s+(?:\$(\w+)\s*=>\s*)?\$(\w+)\s*\)\s*\{([\s\S]*?)\n\t\t\}/g)
  ) {
    const [, literal, sourceVar, keyVar, valueVar, body] = loop;
    const methods = [...body.matchAll(/'methods'\s*=>\s*'([A-Z,]+)'/g)].map((m) => m[1]);

    const items = literal
      ? [...literal.matchAll(/'([^']+)'/g)].map((m) => m[1])
      : (arrays.get(sourceVar) ?? []);
    if (items.length === 0) continue;

    // Two shapes appear: an interpolated template ("/fs/{$op}") and a
    // concatenation ("/" . $route). The variable that carries the route is the
    // key in the woo controller and the value in the others.
    const template = body.match(/["'](\/[^"']*\{\$\w+\}[^"']*)["']/)?.[1] ?? null;
    const concatVar = body.match(/['"]\/['"]\s*\.\s*\$(\w+)/)?.[1] ?? null;

    for (const item of items) {
      if (concatVar && (concatVar === keyVar || concatVar === valueVar)) {
        record(`/${item}`, methods);
      } else if (template) {
        record(template.replace(/\{\$\w+\}/, item), methods);
      }
    }
  }

  // The loops are blanked before the plain pass runs. A `register_rest_route`
  // inside a foreach is indented one level deeper, so a non-greedy scan for
  // the closing `\n\t\t);` starting inside a loop runs past the loop's own
  // closer and swallows the NEXT registration whole — which silently cost this
  // fixture `woo/products/{id}` until the loop-template check caught it.
  const outer = src.replace(
    /foreach\s*\([\s\S]*?\n\t\t\}/g,
    (match) => match.replace(/[^\n]/g, " ")
  );

  // Plain registrations, including the array-of-arrays form where one route
  // carries several methods.
  for (const call of outer.matchAll(/register_rest_route\s*\(([\s\S]*?)\n\t\t\);/g)) {
    const body = call[1];
    const route = body.match(/['"](\/[^'"]*)['"]/)?.[1];
    if (!route) continue;
    if (route.includes("{$")) {
      // A registration inside a foreach. The loop pass above substitutes it;
      // recorded here only so the check below can confirm that happened.
      templates.add(normalise(route));
      continue;
    }
    record(route, [...body.matchAll(/'methods'\s*=>\s*'([A-Z,]+)'/g)].map((m) => m[1]));
  }
}

const sorted = [...routes].filter((r) => !r.endsWith(" ")).sort();

const unresolved = sorted.filter((r) => r.includes("$") || r.includes("?P<"));
if (unresolved.length > 0) {
  // A route still carrying a PHP variable means the parser matched a loop it
  // could not substitute. Writing it would put a route in the fixture that no
  // site will ever answer, and the checker would then happily confirm a
  // contract against it.
  console.error(`Unresolved route templates — the parser missed a loop:\n  ${unresolved.join("\n  ")}`);
  process.exit(1);
}

// Every loop template must have produced at least one concrete route. Without
// this, a loop the parser fails to read costs us a whole controller's routes
// silently, and the fixture looks complete.
const empty = [...templates].filter((t) => {
  const prefix = t.slice(0, t.indexOf("{$"));
  return !sorted.some((r) => r.slice(r.indexOf(" ") + 1).startsWith(prefix));
});
if (empty.length > 0) {
  console.error(`Loop templates that produced no routes:\n  ${empty.join("\n  ")}`);
  process.exit(1);
}
writeFileSync(
  "plugin-routes.json",
  `${JSON.stringify({ engineCommit: pinned, generatedFrom: "wordpress-plugin/bridgistic/includes/rest", routes: sorted }, null, 2)}\n`
);
console.log(`plugin-routes.json: ${sorted.length} routes from the plugin at ${pinned.slice(0, 12)}`);
