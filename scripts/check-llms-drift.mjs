#!/usr/bin/env node
// check-llms-drift.mjs
// Fails the build if llms.txt / llms-full.txt drift from known source-of-truth values.
// Run in CI after site/build-seo.mjs

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.cwd(), 'site');
const LLMS = path.join(ROOT, 'llms.txt');
const LLMS_FULL = path.join(ROOT, 'llms-full.txt');

const EXPECTED = {
  prices: ['$0', '$69', '$12', '$99'],
  publisher: 'WordPressistic LLC',
  address: '1209 Mountain Road PL NE, STE N',
  license: 'GPL-2.0-or-later',
  refund: '7-day',
};

function fail(msg) {
  console.error(`llms-drift: ${msg}`);
  process.exit(1);
}

function checkFile(file, label) {
  if (!fs.existsSync(file)) fail(`${label} missing`);
  const text = fs.readFileSync(file, 'utf8');
  for (const p of EXPECTED.prices) {
    if (!text.includes(p)) fail(`${label} missing price ${p}`);
  }
  if (!text.includes(EXPECTED.publisher)) fail(`${label} missing publisher`);
  if (!text.includes(EXPECTED.license)) fail(`${label} missing license`);
  console.log(`${label} OK`);
}

checkFile(LLMS, 'llms.txt');
checkFile(LLMS_FULL, 'llms-full.txt');
console.log('llms-drift check passed');
