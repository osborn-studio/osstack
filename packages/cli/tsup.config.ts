import { defineConfig } from "tsup";

export default defineConfig({
  // cli-entry.ts is a thin wrapper that answers --version without loading
  // the command surface, then lazily imports bin.ts (emitted as a split
  // chunk) for everything else. The output keeps the dist/bin.js name that
  // package.json#bin points at.
  entry: { bin: "src/cli-entry.ts" },
  format: ["esm"],
  target: "node20",
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
