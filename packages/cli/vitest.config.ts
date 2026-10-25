import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Some suites call process.chdir(), which throws under the worker_threads
    // pool. Vitest's historical default here is the forks pool; pin it
    // explicitly so introducing this config file cannot silently change the
    // pool/isolation behavior those tests depend on.
    pool: "forks",
    sequence: { setupFiles: "list" },
    // Graph/session suites spawn their own workers and repeatedly hash native
    // runtimes. Bound nested process contention without relaxing deadlines.
    maxWorkers: 2,
    // R2.1 hermeticity guard: point OSSTACK_HOME at a per-test-file tmp dir before any
    // test module loads so no suite can touch the real ~/.osstack.
    setupFiles: ["../../scripts/vitest-setup-scratch.ts", "./src/test-setup-hermetic-home.ts"],
  },
});
