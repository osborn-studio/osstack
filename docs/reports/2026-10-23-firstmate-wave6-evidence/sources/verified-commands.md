# R3 local source validation

Node22.22.1, explicit scratch OSSTACK_HOME and OSSTACK_SCRATCH_ROOT. No default DB or production configuration used.

Initial red: new module missing. Audit red: noncanonical manifest repo mislabeled not_registered. Parent-review red: substituted same-ID ready response for another repo incorrectly printed. All retained in red.log / audit-red.log / scope-red.log.

Final targeted Vitest: local-data-source-registry 16 + local-source-command 4 = 20 pass. Includes actual private config+source files, real CLI handler→service call, canonical alias, cross-repo/tenant/unknown actions, malformed/private/ownership/symlink checks, digest/schema/output budgets, same-service clock/expiry, live revoke while reading, hung reads retain both real slots until settlement, RPC timeout signal, substituted-scope no-output. tests-final.log.

CLI typecheck and Biome four new files pass (typecheck-final.log, biome-final.log). Knowledge dependency dist rebuilt explicitly to avoid tracked stale export artifacts; generated changes excluded/restored.

Native compiled service performance: warmup50+300 sequential samples, 56589-byte local JSON with20 entries; 350/350 ready. Final p95 0.762292ms/max2.050875ms. Real local filesystem, no mocked I/O. native-read-bench-final.json records Node/platform/FS type and bundle hash. Only warm-cache local service measurement; not daemon/socket/mixed-load or remote filesystem qualification. Earlier sample retained.

No migration, action grant, source-ledger write, automatic context injection, shell/network provider, dynamic code loader, publish, push or PR. Parent owns real daemon/CLI routing and complete-suite tests.

Additional audit red/green: alias-oracle-red.log reproduces other-repository config_invalid existence signal; fixed ownership ordering. Final tests also pin dangling alias and early unqualified scope-label behavior.
