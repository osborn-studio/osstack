#!/usr/bin/env node
// generate-schemas — writes packages/protocol/schemas/*.schema.json from the Zod
// source of truth (src/generate.ts). Deterministic; CI enforces freshness with
// --check (regenerate in memory and fail on any diff).
//
// Requires packages/protocol/dist/generate.js to exist (run after the package
// build). The identical generation runs in schemas.test.ts against src, so the
// committed files, the build-time script, and the test can never disagree.
//
// Usage:
//   node scripts/generate-schemas.mjs           write schemas/*
//   node scripts/generate-schemas.mjs --check   exit 1 if any file is stale/missing

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(HERE, "..");
const SCHEMAS_DIR = join(PKG_ROOT, "schemas");
const DIST_GENERATE = join(PKG_ROOT, "dist", "generate.js");

if (!existsSync(DIST_GENERATE)) {
  console.error("packages/protocol/dist/generate.js not found — run the package build first");
  process.exit(2);
}

const { generateAll } = await import(pathToFileUrl(DIST_GENERATE));
const files = generateAll();
const check = process.argv.includes("--check");

let stale = 0;
mkdirSync(SCHEMAS_DIR, { recursive: true });
for (const [name, content] of Object.entries(files)) {
  const path = join(SCHEMAS_DIR, name);
  const current = existsSync(path) ? readFileSync(path, "utf-8") : undefined;
  if (current === content) {
    if (!check) console.log(`unchanged schemas/${name}`);
    continue;
  }
  if (check) {
    console.error(`stale: schemas/${name} — re-run scripts/generate-schemas.mjs`);
    stale += 1;
  } else {
    writeFileSync(path, content, "utf-8");
    console.log(`wrote schemas/${name}`);
  }
}

if (check && stale > 0) {
  console.error(`schema check FAILED: ${stale} stale file(s)`);
  process.exit(1);
}
if (check) console.log("schemas up to date");

function pathToFileUrl(p) {
  return new URL(`file://${p}`).href;
}
