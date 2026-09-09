#!/usr/bin/env node
// Explicit live-provider diagnostic; GitHub transport stays local and simulated.
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const home = await mkdtemp(join(tmpdir(), "osstack-provider-launcher-"));
console.log("Live provider smoke: one Codex Builder and one Kimi Evaluator; provider charges may apply. GitHub is simulated. No automatic retries.");
try {
  const env = { ...process.env, OSSTACK_HOME: home, OSSTACK_PROVIDER_LIVE_SMOKE: "1" };
  delete env.OSSTACK_SOCKET;
  const child = spawn("pnpm", ["--filter", "@osstack/cli", "test", "src/improvement-provider-live.test.ts"], {
    cwd: root, stdio: "inherit",
    env,
  });
  process.exitCode = await new Promise((accept) => {
    child.on("error", (error) => { console.error(error.message); accept(1); });
    child.on("close", (code) => accept(code ?? 1));
  });
} finally {
  // The smoke keeps its own distinct artifact directory, including failures.
  await rm(home, { recursive: true, force: true });
}
