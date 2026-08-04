import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const root = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

assert.equal(
  root.scripts?.["typecheck:check"],
  "pnpm -r typecheck",
  "typecheck:check must remain the build-independent CI entrypoint",
);
assert.equal(
  root.scripts?.typecheck,
  "pnpm build && pnpm typecheck:check",
  "the documented typecheck command must prepare workspace declarations first",
);
assert.equal(
  root.scripts?.["smoke:clean-typecheck"],
  "node scripts/smoke-clean-typecheck-contract.mjs",
  "the clean-typecheck contract must be runnable from the root",
);
assert.match(
  ci,
  /name: Clean typecheck contract[\s\S]*?run: pnpm smoke:clean-typecheck/,
  "CI must enforce the clean-typecheck command contract",
);
assert.match(
  ci,
  /name: Typecheck[\s\S]*?run: pnpm typecheck:check/,
  "CI must avoid rebuilding after its explicit Build step",
);

console.log(JSON.stringify({ ok: true, kind: "clean-typecheck-contract" }, null, 2));
