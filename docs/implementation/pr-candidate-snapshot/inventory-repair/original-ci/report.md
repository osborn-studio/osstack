# PR307 repaired-head CI: inventory failure

Run **40928407347**, head **24bed464c321c5396f59adecaf72c116569ca768**, completed **failure** within the15-minute tracking bound. Four platform matrix jobs succeeded; paid DeepSeek skipped.

**Lint (Biome) and Build both actually succeeded.** Main check then failed at **Inventory freshness**:

`stale: docs/inventory/PUBLIC_EXPORTS.md — re-run scripts/generate-inventory.mjs`

Command `node scripts/generate-inventory.mjs --check` exited1 at18:14:54Z. Typecheck, full22-package tests, requested GitHub/CLI counts, and later actual smoke steps were skipped. They are not_run, not inherited passes. Original lint-failed run remains separately preserved and is not regraded.

Exact synthetic checkout and run/API base are retained in report.json. Complete original log is729829bytes, SHA256 `7788ebe508cc4c1a2a70552d9a0b4cc3066dd68560844e79669c00107761c995`; compressed copy was checked for lossless equality. No artifact downloaded, test rerun, model call, source/PR modification or cancellation.
