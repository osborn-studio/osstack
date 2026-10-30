import { defineConfig } from "tsup";
import { readFileSync } from "node:fs";
const version = (JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8")) as { version: string }).version;

export default defineConfig({
  // cli-entry.ts is a thin wrapper that answers --version without loading
  // the command surface, then lazily imports bin.ts (emitted as a split
  // chunk) for everything else. The output keeps the dist/bin.js name that
  // package.json#bin points at.
  entry: { bin: "src/cli-entry.ts", "graph-maintenance": "src/graph-maintenance.ts", "method-context": "src/method-context.ts" },
  format: ["esm"],
  target: "node20",
  // Managed runtime identity must not be replaceable by a launch environment.
  define: { "process.env.OSSTACK_VERSION": JSON.stringify(version) },
  splitting: true,
  clean: true,
  banner: { js: "#!/usr/bin/env node" },
  sourcemap: true,
  // Resolve workspace + native runtime deps from node_modules at run time
  // rather than bundling them (yaml is bundled so the binary is self-contained
  // for that small dep; the others ship their own dist / are native).
  external: [
    "@osstack/core",
    "@osstack/agents",
    "@osstack/config",
    "@osstack/github",
    "@osstack/hermes-adapter",
    "@osstack/loop",
    "@osstack/skill-registry",
    "@osstack/skills",
    "better-sqlite3",
    "@anthropic-ai/claude-agent-sdk",
  ],
});
