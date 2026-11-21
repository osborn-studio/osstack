import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { testTimeout: 20_000, setupFiles: ["../../scripts/vitest-setup-scratch.ts"] },
});
