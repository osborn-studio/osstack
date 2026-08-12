#!/usr/bin/env node
// CLI startup latency gate (Performance Hints plan, P1).
//
// Guards the two startup budgets so the module-load tax cannot silently
// creep back (a single new top-level import in bin.ts or a heavy static
// dependency in an @osstack package is enough to regress it):
//
//   1. `osstack --version` — the machine-called fast path served by
//      cli-entry.ts without loading the command surface.
//   2. `osstack --help`    — end-to-end proxy for loading the full command
//      surface (bin.ts chunk + @osstack/core/agents/loop externals).
//
// Budgets are wall-clock medians of N spawns of the built dist/bin.js and
// intentionally generous (CI runners are slower than dev machines). Override
// via env when a runner class needs it:
//   OSSTACK_BENCH_VERSION_BUDGET_MS (default 150)
//   OSSTACK_BENCH_HELP_BUDGET_MS    (default 500)
//
// Usage: node scripts/bench-cli-startup.mjs   (expects packages/cli built)

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = process.cwd();
const binPath = join(root, "packages", "cli", "dist", "bin.js");
const SAMPLES = 5;

const budgets = [
  {
    label: "osstack --version (fast path)",
    args: ["--version"],
    budgetMs: readBudget("OSSTACK_BENCH_VERSION_BUDGET_MS", 150),
    expectStdout: /^osstack \d+\.\d+\.\d+/,
  },
  {
    label: "osstack --help (full command surface)",
    args: ["--help"],
    budgetMs: readBudget("OSSTACK_BENCH_HELP_BUDGET_MS", 500),
    expectStdout: /Usage:/,
  },
];

if (!existsSync(binPath)) {
  console.error(`bench-cli-startup: ${binPath} not found — run \`pnpm --filter @osstack/cli build\` first`);
  process.exit(1);
}

let failed = false;
for (const { label, args, budgetMs, expectStdout } of budgets) {
  const times = [];
  for (let i = 0; i < SAMPLES; i++) {
    const t0 = performance.now();
    const res = spawnSync(process.execPath, [binPath, ...args], { encoding: "utf8" });
    const elapsed = performance.now() - t0;
    if (res.status !== 0) {
      console.error(`FAIL ${label}: exit ${res.status}\n${res.stderr}`);
      failed = true;
      break;
    }
    if (!expectStdout.test(res.stdout)) {
      console.error(`FAIL ${label}: unexpected stdout (${JSON.stringify(res.stdout.slice(0, 120))})`);
      failed = true;
      break;
    }
    times.push(elapsed);
  }
  if (times.length < SAMPLES) continue;

  times.sort((a, b) => a - b);
  const median = times[Math.floor(SAMPLES / 2)];
  const line = `${label}: median ${median.toFixed(0)}ms over ${SAMPLES} runs (budget ${budgetMs}ms; min ${times[0].toFixed(0)}, max ${times[SAMPLES - 1].toFixed(0)})`;
  if (median > budgetMs) {
    console.error(`FAIL ${line}`);
    failed = true;
  } else {
    console.log(`ok   ${line}`);
  }
}

process.exit(failed ? 1 : 0);

function readBudget(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.error(`bench-cli-startup: invalid ${name}=${raw}`);
    process.exit(1);
  }
  return parsed;
}
