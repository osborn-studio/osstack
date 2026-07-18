#!/usr/bin/env node

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = join(here, "..");
const schemasDirectory = join(packageRoot, "schemas");
const builtGenerator = join(
  packageRoot,
  "dist",
  "knowledge-hygiene",
  "generate.js",
);
const builtProbeGenerator = join(packageRoot, "dist", "probe", "generate.js");
const check = process.argv.includes("--check");

if (!existsSync(builtGenerator)) {
  console.error(
    "packages/governance/dist/knowledge-hygiene/generate.js not found — run the package build first",
  );
  process.exit(2);
}
if (!existsSync(builtProbeGenerator)) {
  console.error(
    "packages/governance/dist/probe/generate.js not found — run the package build first",
  );
  process.exit(2);
}

const { generateAllKnowledgeHygieneSchemasV1 } = await import(
  pathToFileURL(builtGenerator).href
);
const { generateAllProbeSchemasV1 } = await import(
  pathToFileURL(builtProbeGenerator).href
);
const expected = {
  ...generateAllKnowledgeHygieneSchemasV1(),
  ...generateAllProbeSchemasV1(),
};
mkdirSync(schemasDirectory, { recursive: true });

let stale = 0;
for (const [filename, content] of Object.entries(expected)) {
  const path = join(schemasDirectory, filename);
  const current = existsSync(path) ? readFileSync(path, "utf8") : undefined;
  if (current === content) {
    if (!check) console.log(`unchanged schemas/${filename}`);
    continue;
  }
  if (check) {
    console.error(`stale: schemas/${filename}`);
    stale += 1;
  } else {
    writeFileSync(path, content, "utf8");
    console.log(`wrote schemas/${filename}`);
  }
}

const unexpected = readdirSync(schemasDirectory)
  .filter(
    (filename) =>
      filename.endsWith(".schema.json") && !(filename in expected),
  )
  .sort();
for (const filename of unexpected) {
  console.error(`unexpected: schemas/${filename}`);
  stale += 1;
}

if (check && stale > 0) {
  console.error(`schema check FAILED: ${stale} stale or unexpected file(s)`);
  process.exit(1);
}
if (check) console.log("governance schemas up to date");
