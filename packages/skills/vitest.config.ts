import { defineConfig } from "vitest/config";
export default defineConfig({ test: { setupFiles: ["../../scripts/vitest-setup-scratch.ts"] } });
