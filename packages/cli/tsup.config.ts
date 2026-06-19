import { defineConfig } from "tsup";

export default defineConfig({
  entry: { bin: "src/bin.ts" },
  format: ["esm"],
  target: "node20",
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
    "@osstack/hermes-adapter",
    "@osstack/loop",
    "@osstack/skill-registry",
    "@osstack/skills",
    "better-sqlite3",
    "@anthropic-ai/claude-agent-sdk",
  ],
});
