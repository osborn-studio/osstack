# G07 executor evidence

2026-09-13. G07 only. No task-status edits, nested agents/loops, commits, publication, production DB or default home access. Tests inherited explicit controller OSSTACK_HOME; the saver probe allocates an additional owned temporary home.

Implemented bounded deterministic checkpoint codec + tests, test-only persistent public Saver probe, and [capability decision](../graph-saver-decision.md). Parent owns full validation, independent review and task status. The package root remains unchanged; published codec subentry/worker export is left to the parent because it is outside the executor's explicit file list.

**Supervisor gate:** positive cross-process recovery passed, but arbitrary failure recovery is not admitted. Immediate sibling failure can leave an aborted task's output persisted without its generated join write. Resume then caches that partial task and never joins. The probe retains this counterexample and reproduces it with unmodified public MemorySaver as a baseline. `passed: true` means all experimental assertions passed, including the known counterexample; `productionReady: false` is explicit. See the decision for the minimum case and alternatives; no engine patch applied.

Raw logs under the requested controller evidence directory:

`/var/folders/97/wmwg4qzx02j74c3n73nh438w0000gn/T/osstack-graph-kernel-z3zisd4r/evidence`

| File | Evidence |
|---|---|
| `G07-codec-red.txt` | First codec run: missing implementation module, Vitest exit 1. |
| `G07-saver-red.json` | Executable assertions against unimplemented facade: child exit 1, failed assertion and owned cleanup recorded. |
| `G07-config-projection-red.json` | RED: list attempted to serialize a live runnable callback; fixed by projecting durable config identity and before cursor. |
| `G07-byte-accessor-red.txt` | Focused RED: getter executed before byte properties were rejected; 1 failed / 19 passed. |
| `G07-codec-green.txt` | Graph package build and 22 tests (20 codec + 2 existing boundary tests) pass. |
| `G07-saver-investigate.json` | Initial partial-abort discovery: persisted output/error, missing barrier notification, resume did not join. |
| `G07-saver-green.json` | Eight separate child processes, complete method/field/index coverage, completed sibling count 1 across recovery, flaky 2, join 1, interrupt/resume false, error propagation, negative storage control, retained partial-abort and public MemorySaver baseline. |

Runtime in executor logs: Node 26.5.0/macOS arm64; pins asserted from installed public package manifests: LangGraph 1.4.15, checkpoint 1.1.5, core 1.2.11. No claim for Node20/22 or whole repository validation from these results.

Read supervisor `review-followup.md` before final validation. Its byte accessor guidance is covered by captured intrinsic getters, forged-byte rejection, shared-buffer rejection and zero-hook encode/raw-decode tests across buffer/byteLength/byteOffset/length. All required checkpoint fields, metadata and extra JSON fields are retained. Arbitrary classes/undefined/unsafe prototypes are rejected; no reserved engine channel is filtered.

Final scoped validation: graph package build/test **22 passed**, graph typecheck **exit 0**, probe **25 assertions across 8 separate child processes**, Biome **2 files clean**, and `git diff --check` **exit 0**. Probe cleanup succeeded; `productionReady` remains false. Final summary and source hashes are `G07-validation-summary.json` and `G07-source-hashes.json` in the raw evidence directory. The executor evidence MD is also copied there.
