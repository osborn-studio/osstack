import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Real git subprocesses pass 5 s on a slow CI runner; match packages/cli.
    testTimeout: 20_000,
    hookTimeout: 20_000,
    setupFiles: ["../../scripts/vitest-setup-scratch.ts"],
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      reportsDirectory: "./coverage",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
