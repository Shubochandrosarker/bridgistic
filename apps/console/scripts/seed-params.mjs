#!/usr/bin/env node
/** Inserts the remaining oversized skills via the D1 REST query API with bound params. */

import { readFileSync, existsSync } from "node:fs";
import { gzipSync } from "fflate";
import { join, resolve } from "node:path";

const registry = resolve(process.argv[2]);
const account = process.argv[3];
const databaseId = process.argv[4];
const token = process.argv[5];
const slugs = process.argv.slice(6);

const sqlString = (v) => `'${String(v).replace(/'/g, "''")}'`;

let ok = 0;
for (const slug of slugs) {
  const tier = existsSync(join(registry, "paid", `${slug}.json`)) ? "paid" : "free";
  const item = JSON.parse(readFileSync(join(registry, tier, `${slug}.json`), "utf8"));
  const json = JSON.stringify(item.files ?? []);
  const gz = Buffer.from(gzipSync(new TextEncoder().encode(json), { level: 9 })).toString("base64");
  const sql = `INSERT INTO skills (slug, name, description, category, author, handle, tier, version, installs, updated, files)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
       ON CONFLICT(slug) DO UPDATE SET name=excluded.name, description=excluded.description, category=excluded.category,
         author=excluded.author, handle=excluded.handle, tier=excluded.tier, version=excluded.version, updated=excluded.updated, files=excluded.files;`;
  const params = [item.slug, item.name, item.description ?? "", item.category ?? "", item.author ?? "", item.handle ?? "", item.tier ?? "free", item.version ?? "1.0.0", Number(item.installs ?? 0), item.updated ?? "", "gz:" + gz];
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${account}/d1/database/${databaseId}/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sql, params }),
  });
  const body = await res.json();
  if (body.success) {
    ok += 1;
    console.log("OK", slug);
  } else {
    console.log("FAIL", slug, JSON.stringify(body.errors).slice(0, 200));
  }
}
console.log(`${ok}/${slugs.length} inserted`);
