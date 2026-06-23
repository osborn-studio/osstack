#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createKnowledgePublishCatalog } from "../packages/knowledge/dist/index.js";

const args = process.argv.slice(2);
const outputArg = valueAfter("--output");
const indexPath = resolve(valueAfter("--index") ?? "knowledge-packs/official/index.json");
const evalFixturePath = resolve(valueAfter("--eval") ?? "knowledge-evals/retrieval/osstack-core.json");
const outputPath = resolve(outputArg ?? "dist/knowledge-cloud/catalog.json");

const catalog = await createKnowledgePublishCatalog({
  indexPath,
  evalFixturePath,
});

const failingPacks = catalog.packs.filter((pack) => !pack.publish_gate.ok);
if (failingPacks.length > 0) {
  throw new Error(`knowledge publish catalog has failing packs: ${failingPacks.map((pack) => pack.id).join(", ")}`);
}
if (catalog.retrieval_eval === undefined || catalog.retrieval_eval.failed > 0) {
  throw new Error("knowledge publish catalog retrieval eval must pass before cloud publication");
}

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(catalog, null, 2)}\n`, "utf-8");
console.log(JSON.stringify({
  ok: true,
  output: outputPath,
  packs: catalog.packs.length,
  retrieval_eval: catalog.retrieval_eval,
}, null, 2));

function valueAfter(flag) {
  const index = args.indexOf(flag);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}
