import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const workspace = await mkdtemp(join(tmpdir(), "osstack-neat-parity-offline-"));
try {
  const evaluator = resolve("packages/neat-eval/dist/cli.js");
  const cli = resolve("packages/cli/dist/bin.js");
  await exec(process.execPath, [
    evaluator,
    "corpus",
    "materialize",
    "--output",
    workspace,
  ], { maxBuffer: 8 * 1024 * 1024 });
  const resultPath = join(workspace, "c-arm.json");
  const run = await exec(process.execPath, [
    evaluator,
    "run-c",
    "--corpus-root",
    workspace,
    "--cli",
    cli,
    "--output",
    resultPath,
  ], { maxBuffer: 8 * 1024 * 1024 });
  const summary = JSON.parse(run.stdout);
  if (summary.reproducible !== true || summary.runs !== 60) {
    throw new Error(`mechanical control failed: ${run.stdout}`);
  }
  process.stdout.write(`${JSON.stringify({
    schema_version: "1",
    status: "passed",
    corpus: { cases: 30, defects: 120 },
    mechanical_control: summary,
    semantic_parity_claim: "not_assessed",
    reason: "A/B live providers and independent hidden custody are intentionally outside the offline gate.",
  }, null, 2)}\n`);
} finally {
  await rm(workspace, { recursive: true, force: true });
}
