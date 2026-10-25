# R8 scoped closure

F1: The public report states the exact 16,000,000-byte boundary limit.
F2: Unknown-stop messages now state that preflight refusal is possible and that retention is not proof of a live process.
F3: The initial base-review artifact listing checks the combined tracked and untracked output budget before accepting paths. A real regression has each list below 1 MiB and their sum above 1 MiB. It must refuse, not accept a partial list.
F4: See F3-r8-arm-disposition.md and the real partial-arm fsync regression. A persisted or unreadable marker retains the lease.
F5: GIT_HOOKS_DISABLED_ARGS existed on main and is exported by index.ts through export *. Removing it would break the public API. It is restored and reused by the production REVIEWER_GIT_ARGS array. The duplicate helper-only hook test stays removed. Real production worktree hook tests stay and pass. Full index.ts and the original constant are included. The compatibility completion branch comment is shorter.
F6: The supplied compat validation binds the final source before and after each set of checks. Earlier final-validation logs before compatibility restoration are not current evidence. The arm validation binds the unchanged engine and containment files. The unified manifest records the exact files and logs supplied here. Historical A PASS is explicitly historical scoped evidence, not a current all-source checksum assertion. Parent full native QA and CI remain independent gates.
N1: Root pnpm workspace includes packages/*. Root test runs pnpm -r test. All 22 package Vitest configurations use shared scratch setup. Daemon lives in packages/cli/src/daemon.ts and scheduler modules, not a separate package. The supplied daemon excerpt includes finally release.
N2: Git environment isolation applies to host-owned helpers. DeepSeek command adapter Git inherits process environment and is a separate trusted adapter boundary. The public report says this explicitly.

All prior owner-accepted boundaries in the supplied final report remain unchanged. This is finite before/after observation with trusted adapter completion, not a sandbox or continuous monitoring. Native Windows is not qualified. No model-driven relaxation of unknown-stop retention is permitted. Do not treat pending independent full QA/CI as proof of a code defect or claim they already passed.
