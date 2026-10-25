# V2 viewer validation

Baseline: cb2a37875a093b40493e94ad7367fdac2ff41765. Node 22.22.1; explicit scratch OSSTACK_HOME and OSSTACK_SCRATCH_ROOT. No default control-plane DB opened.

- Audit regression red: worker-presentation.test.ts 9 passed / 2 failed (local hung-read timeout and callback-only error-listener leak), exit 1. audit-red.log retained.
- Final targeted Vitest: worker-presentation (13), worker-viewer-command (4), existing worker-view-command (14), existing worker-view-service (32): 63/63 pass, exit 0, worker-tests-final.log.
- CLI typecheck: pnpm --filter @osstack/cli typecheck, exit 0, typecheck-final.log. Rebuilt protocol/core/knowledge dependencies (knowledge needed tsc -b --force after restoring tracked generated dist because incremental cache otherwise skipped export emission) to remove stale dist-export mismatch; generated tracked knowledge dist restored before commit.
- Biome check four new TS files, exit 0, biome-final.log.
- Native smoke compiled exact viewer into scratch bundle using esbuild. Only unused core version export stubbed as 44. Valid fixture inspect replies; actual Node subprocess stdout pipes and SIGINT. SIGINT exits 130 after one read, EPIPE exits 1 after two reads, no unhandled errors. native-smoke-final.json. This is not full production CLI/socket qualification.
- Real WorkerViewService integration test reads bound session/run from scratch SQLite, observes unchanged total_changes and session running after local close. No model call involved.
- Parent owns production bin routing and full-suite integration; no tmux backend claimed.

Second audit red: interrupt during final diagnostic returned output_closed; 1 failed / 12 passed. Fixed and final 63-test run green. audit-red-2.log retained.
