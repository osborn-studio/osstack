# 5-G verification journal setup fix

Date: 2026-11-07. Status: driver fix verified with local filesystem tests; real 5-G retry not run.

Base HEAD: `8120569883fd23c30bd99858de8f3d0c6a34aa55`.
Scope: `scripts/smoke-bridge-revision-sandbox.mjs`, its helper test file, and this report only.

The preserved failed run is `/Volumes/AIMATE_WORK/tmp/osstack/smoke/bridge-revision-revision-5g-20261107a-Y3vnTs`.
Read-only inspection of its report found the same source commit, `qualified: false`,
`failure_code: root_halted:stop_unknown`, and empty scenarios, chains, and owned PRs.
Its `home/verification` directory is absent. The original run was not changed.

The driver passed `join(home, 'verification')` without creating that directory.
In `packages/agents/src/contained-command.ts`, `directory()` calls
`realpathSync(journalRoot)`. `execute()` calls `directory()` before its daemon request.
A missing root therefore causes ENOENT before that executor's Docker calls.
The product contract requires an existing canonical root; it does not create one.

The fix extracts the existing directory setup into `initializeSandboxDirectories`.
It checks the home, exclusively creates `home/verification` with mode `0700`,
and checks that the journal is canonical, private, uid-owned, and a directory without a symlink.
An existing entry fails; setup does not follow or repair it.
The awaited setup returns the journal path before any runtime ports construction.
Both parent ports and the cold restart descriptor use that path.
Product path checks, `stop_unknown`, and `openDurableSandboxDb` FULL checks remain unchanged.

## Verification

- RED: extracted the original setup without journal creation, then ran
  `node --test --test-concurrency=1 --test-name-pattern='fresh sandbox setup' scripts/smoke-bridge-revision-sandbox.helpers.test.mjs`.
  Exit 1: 1 test, 0 passed, 1 failed with ENOENT from `realpathSync(home/verification)`.
- GREEN: after adding creation and checks, ran
  `node --test --test-concurrency=1 scripts/smoke-bridge-revision-sandbox.helpers.test.mjs`.
  Exit 0: 28 tests, 28 passed, 0 failed, 0 skipped.
- The fresh-home regression uses actual filesystem operations under
  `/Volumes/AIMATE_WORK/tmp/osstack/tests`, checks canonical path, owner, permissions,
  directory type, empty journal, and absence of a DB in the home. Fixtures are removed.
- Negative cases reject existing directories, files, symlinks, and a public home.
  The first negative-case run had 27 passes and 1 failure because the session umask
  removed the public permission bits. The fixture now explicitly uses chmod before checking rejection.
- `node --check scripts/smoke-bridge-revision-sandbox.mjs`: exit 0.
- `git diff --check`: exit 0.

No DB was opened by these checks. No real Codex, Docker, GitHub, or 5-G execution
was invoked. Full testing remains parent-owned. These checks prove journal setup,
not completion of the real sandbox acceptance run.

## Source binding

SHA-256 values for the final code and test, and unchanged product contracts:

| File | SHA-256 |
| --- | --- |
| `scripts/smoke-bridge-revision-sandbox.mjs` | `155285321f5551eadd405fcb045763b9ce8a832b26b6d7f391e552c2dfa07b15` |
| `scripts/smoke-bridge-revision-sandbox.helpers.test.mjs` | `57a8ebcd6d3d7ca8e2c61d2ee864a70fea6f36d4e9c7fbdad0a46f54afd12c71` |
| `packages/agents/src/contained-command.ts` | `2076a8ba6f8206ccd5bf3c27a6ce3e94f61017910971aade269ed8597701e2fc` |
| `packages/cli/src/contained-mission-ports.ts` | `0662256a65d494877a06b935a1559bca1f7291e6ce9e90fd348fa5e1babf8a71` |

Original driver SHA-256 at base HEAD:
`82e8564f0f5e905348b6bad9e4454a976911d45902ed7dad0999b355ee893ced`.
Original helper tests SHA-256:
`497c527728955359f32381fcf85eeb1f2818897bae324c7a12ce9a66476c5760`.
