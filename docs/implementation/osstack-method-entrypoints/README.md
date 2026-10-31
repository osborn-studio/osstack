# Named OSStack methods and host export

Candidate work follows merged PR290/main `f92914e0a98bd3e5f82765fddc5a275a93637f30`. [Specification](spec.md) defines the D2a scope and export usage (removed) describes the four named entries. Four named entries and both host export layouts are implemented in this candidate. Native discovery and runtime qualification remain unverified.

PR291 was independently combined with this main at `c85de1a96109c0efccdf9e1e1d5fc52a2a927e92`, tree `3e2f587932ee9ab47fd2613587b3a738ed1fb6cf`. Fresh install/build, skills 25 tests plus five actual CLI cases, engineering 27 tests plus actual workflow, and 241 document checks passed after the preserved verification-harness and incremental-build corrections. This is not a new combined full-repository run. The [composition report](composition-report.md) describes the exact sequence; the archive includes raw failures and successful rechecks.

Composition archive SHA-256: `2d583cbba5246aed03f4f9ecd6fb44f065fb1267c6c3ed11fee94e2fd7d14c51`.

Read [audit dispositions](audit.md) and [actual host-use observations](host-use.md) for the distinction between executed tests, supplied-material interpretation and unobserved capabilities. Final standalone parser candidate `8e0c06348d664999c4539a754041651fa52c143f` has 63 focused tests; the full package run belongs to earlier `4b0f2267` (7,138 passed, 5 skipped, 0 failed). Later changes affect standalone exporter scripts, material/reference documentation and script-key ordering, not package source. Final published-head CI remains required.

## Composition with repaired PR291

[Independent fresh composition](new-composition.md) `d327e32155a28bda8538dc9966a8bf9650341470` combines PR291 `6df338e8` with methods candidate `a1cb1779`: fresh install/build, 62 export tests, 25 skills driver tests plus five real cases, 27 engineering tests plus real workflow, and 241 docs passed. Archive SHA-256 `2a00f970e1e2215edcc7f56cdc01f175616831a96cf237682dba9660318f6746`.

[Limited prefix-fix follow-up](composition-prefix-followup.md) produced `6493ee56f837d60e7e038ac8344338810003ead4`, tree `215d508447410d1ae289b676d07f494773bbdbe9`, by merging `8e0c0634`. Only two standalone files changed. Export tests were rerun: 63/63 passed. Earlier build, real smoke and document observations remain pinned to d327; this is not a combined full-repository run or a final published-tree certificate. Follow-up archive SHA-256 `8975b340e07631434d494e1ae0dbf30cf3982f9acd502402aa95887999c5752d`.

Full method evidence archive SHA-256 `509d1a70695e8db10210a045d0922eb2fc56799a75060f438036776bbdd6a909`; 474 files checked after compression. It retains all three REVISE reports and the final limited PASS, RED/GREEN traces, old and final code bindings, and both raw host responses.
