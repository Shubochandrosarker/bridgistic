#!/usr/bin/env node
/** Writes gzip-compressed INSERT SQL (files = "gz:<base64>") for the given skill slugs. */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { gzipSync } from "fflate";
import { join, resolve } from "node:path";

const registry = resolve(process.argv[2]);
const slugs = process.argv.slice(3);
const outDir = "seed-gz";
mkdirSync(outDir, { recursive: true });

const sqlString = (v) => `'${String(v).replace(/'/g, "''")}'`;

let wrote = 0;
for (const slug of slugs) {
  const tier = existsSync(join(registry, "paid", `${slug}.json`)) ? "paid" : "free";
  const item = JSON.parse(readFileSync(join(registry, tier, `${slug}.json`), "utf8"));
  const json = JSON.stringify(item.files ?? []);
  const gz = Buffer.from(gzipSync(new TextEncoder().encode(json))).toString("base64");
  const sql = `INSERT INTO skills (slug, name, description, category, author, handle, tier, version, installs, updated, files)
       VALUES (${sqlString(item.slug)}, ${sqlString(item.name)}, ${sqlString(item.description ?? "")}, ${sqlString(item.category ?? "")},
               ${sqlString(item.author ?? "")}, ${sqlString(item.handle ?? "")}, ${sqlString(item.tier ?? "free")}, ${sqlString(item.version ?? "1.0.0")},
               ${Number(item.installs ?? 0)}, ${sqlString(item.updated ?? "")}, ${sqlString("gz:" + gz)})
       ON CONFLICT(slug) DO UPDATE SET name=excluded.name, description=excluded.description, category=excluded.category,
         author=excluded.author, handle=excluded.handle, tier=excluded.tier, version=excluded.version, updated=excluded.updated, files=excluded.files;`;
  writeFileSync(join(outDir, `${slug}.sql`), sql);
  wrote += 1;
  console.log(slug, `${Math.round(sql.length / 1024)}K compressed`);
}
console.log("wrote", wrote);
