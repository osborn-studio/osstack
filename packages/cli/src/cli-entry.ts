// Lightweight CLI entrypoint. This file is the tsup entry that becomes
// dist/bin.js; the full command surface lives in bin.ts, loaded lazily.
//
// Why: bin.ts pulls the whole command surface (~12k lines plus @osstack/core,
// @osstack/agents, @osstack/loop) at module load — ~165ms before any work
// starts. `--version` is the machine-called hot path (update checks, agent
// adapters, scripts) and needs none of it, so answer it here before paying
// for anything else. Everything else falls through to bin.ts's main().
//
// This wrapper owns the direct-execution guard. bin.ts must NOT self-execute:
// under `bun build --compile` every bundled module reports the same
// import.meta.url (the $bunfs binary path), so a guard left in the bin.ts
// chunk would also fire and main() would run twice.
//
// Keep this file dependency-free apart from version.ts (which reads
// package.json and nothing else). Static imports added here are paid by
// every osstack invocation — see docs/design/2026-08-12-performance-hints-
// improvement-plan.md before adding one.

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { VERSION } from "./version.js";

function isDirectCliEntrypoint(): boolean {
  if (process.argv[1] === undefined) return false;
  let invokedPath = process.argv[1];
  try {
    invokedPath = realpathSync(process.argv[1]);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  const invoked = pathToFileURL(invokedPath).href;
  return import.meta.url === invoked;
}

if (isDirectCliEntrypoint()) {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    console.log(`osstack ${VERSION}`);
    process.exit(0);
  }

  try {
    const { main } = await import("./bin.js");
    const code = await main(args);
    process.exit(code);
  } catch (err) {
    console.error("osstack:", err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
