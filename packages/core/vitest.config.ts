import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Real git subprocesses and SQLite loops pass 5 s on a slow CI runner; match packages/cli.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    setupFiles: ["../../scripts/vitest-setup-scratch.ts"],
  },
});
