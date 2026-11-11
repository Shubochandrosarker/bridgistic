#!/usr/bin/env node
/**
 * Generates chunked SQL that upserts the marketplace registry (free + paid
 * skills) into D1. Source: the control-plane reference export's registry
 * folder. Run with the source dir as argv[2]; writes SQL chunks to argv[3].
 */

import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const source = process.argv[2] ?? "../../_audit/grok-workspace/src/lib/bridgistic/registry";
const outDir = process.argv[3] ?? "seed-sql";
mkdirSync(outDir, { recursive: true });

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

const tiers = ["free", "paid"];
let all = [];
for (const tier of tiers) {
  const dir = join(source, tier);
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  for (const file of files) {
    const item = JSON.parse(readFileSync(join(dir, file), "utf8"));
    all.push(item);
  }
}

all.sort((a, b) => (a.tier === b.tier ? a.slug.localeCompare(b.slug) : a.tier < b.tier ? -1 : 1));

const CHUNK = 12;
let chunkIndex = 0;
for (let i = 0; i < all.length; i += CHUNK) {
  const slice = all.slice(i, i + CHUNK);
  const statements = slice.map(
    (item) =>
      `INSERT INTO skills (slug, name, description, category, author, handle, tier, version, installs, updated, files)
       VALUES (${sqlString(item.slug)}, ${sqlString(item.name)}, ${sqlString(item.description ?? "")}, ${sqlString(item.category ?? "")},
               ${sqlString(item.author ?? "")}, ${sqlString(item.handle ?? "")}, ${sqlString(item.tier ?? "free")}, ${sqlString(item.version ?? "1.0.0")},
               ${Number(item.installs ?? 0)}, ${sqlString(item.updated ?? "")}, ${sqlString(JSON.stringify(item.files ?? []))})
       ON CONFLICT(slug) DO UPDATE SET name=excluded.name, description=excluded.description, category=excluded.category,
         author=excluded.author, handle=excluded.handle, tier=excluded.tier, version=excluded.version, updated=excluded.updated, files=excluded.files;`
  );
  writeFileSync(join(outDir, `skills-${String(chunkIndex).padStart(2, "0")}.sql`), statements.join("\n"));
  chunkIndex += 1;
}

// Pricing as sold today: Free, or Pro at $12/month or $99/year (apps/pay).
// The $69 Lifetime Deal was retired on 2026-11-11 and is no longer seeded.
const plans = [
  ["free", "Free", 0, 0, 0, 1, 1, "active"],
  ["monthly", "Monthly", 12, 0, 0, 5, 3, "active"],
  ["yearly", "Yearly", 0, 99, 0, 5, 3, "active"],
];
const planSql = plans
  .map(
    ([slug, name, monthly, yearly, onetime, sitesMax, seats, status]) =>
      `INSERT INTO plans (slug, name, price_monthly, price_yearly, price_onetime, sites_max, seats, status)
       VALUES (${sqlString(slug)}, ${sqlString(name)}, ${monthly}, ${yearly}, ${onetime}, ${sitesMax}, ${seats}, ${sqlString(status)})
       ON CONFLICT(slug) DO UPDATE SET name=excluded.name, price_monthly=excluded.price_monthly, price_yearly=excluded.price_yearly,
         price_onetime=excluded.price_onetime, sites_max=excluded.sites_max, seats=excluded.seats, status=excluded.status;`
  )
  .join("\n");
writeFileSync(join(outDir, "plans.sql"), planSql);

console.log(`Registry: ${all.length} skills (${all.filter((s) => s.tier === "free").length} free, ${all.filter((s) => s.tier === "paid").length} paid) → ${chunkIndex} chunks + plans.sql in ${outDir}`);
