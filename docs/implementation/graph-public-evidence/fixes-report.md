Findings 1 and 3 fixed; edits stopped.

Owned source changes:
- graph-delivery.ts: binds trusted repositoryPath as policyRoot independently of physical workspacePath; connects async policy callback to broker and final reviewer invocation; connects cancellation settlement authority to verification; adds parent-requested drainDatabaseUsers delegate.
- graph-action-broker.ts: checks repository policy in G04 authorization and after awaited availability/workspace verification immediately before invocation; retains synchronous current host capability and generation checks. Passes trusted abort signal to evidence persistence; accepts independently stopped cancellation only as nonretryable failure. Command confirmation awaits actual shell termination receipt within existing G04 grace instead of reading an as-yet-unset command result. Late worker abort does not invalidate quality already completed and persisted.
- graph-verification.ts: independently stopped cancelled review/tests persist durable verificationFailure under current cancel settlement authority, with no passing result/report; proof/fence/identity checks remain. Unproven stop remains unknown with admission held. Current async policy checked after final reviewer identity await as well.
- daemon.ts: ONLY graph service policy assembly changed by fixer: source policy required, physical candidate policy can restrict additionally but missing clone policy cannot replace current source authority. Parent's shutdown edits preserved.
- new graph-review-findings.test.ts: 6 focused real SQLite/GraphDelivery/G04/G10/GraphRpc regressions. Source-policy revocation after confirmed e0.workspace and before writer availability release prevents invocation. Untracked/current-newer source policy works even absent at base revision. Review and actual shell command cancellation with execute revoked settle failed/nonretryable with durable evidence, zero held admissions and run cancelled. Unproven reviewer stop remains unknown, cancel_pending and held.

Coordination:
GraphDeliveryOptions.authorizePolicy?: (input: { policyRoot: string; workspacePath: string }) => Promise<void>.
Parent GraphRpcOptions forwarding observed present. Parent loadLocalGraphRegistration verifyReviewer uses read identity authority (required for cancel after execute revoke); parent owns and tested this correction. No graph-rpc.ts, graph-runtime.ts, graph-execution-command*, protocol/docs, graph-delegation.integration.test.ts, or other parent test edits by fixer.

Exact final validation (all commands from repository root):
OSSTACK_HOME=/Volumes/AIMATE_WORK/tmp/gc7/fix-home TMPDIR=/Volumes/AIMATE_WORK/tmp/gc7 pnpm --filter @osstack/cli exec vitest run src/graph-review-findings.test.ts src/graph-verification.test.ts src/graph-delivery.integration.test.ts src/graph-delivery-adversarial.test.ts src/graph-action-broker.test.ts src/graph-action-broker-boundary.test.ts
PASS: 6 files, 98/98 tests, 83.63 seconds. Breakdown: new findings6, G19 verification29, G21 integration6 + adversarial9, broker31 + boundary17. Log: /Volumes/AIMATE_WORK/tmp/gc7/fix-focused-final2.txt.

OSSTACK_HOME=/Volumes/AIMATE_WORK/tmp/gc7/fix-home TMPDIR=/Volumes/AIMATE_WORK/tmp/gc7 pnpm --filter @osstack/cli typecheck
PASS, exit0. Log: /Volumes/AIMATE_WORK/tmp/gc7/fix-typecheck-final.txt.

git diff --check
PASS, exit0.

Reproduction history: fix-red.txt records 5 failed/1 passed before implementation. fix-green2.txt first all6 new tests passed. Initial combined batch fix-focused-final.txt was97/98; its G21 preparation-admission regression reproduced independently (fix-g21-retry.txt), then passed after removing overly broad late-abort completed-outcome invalidation (fix-g21-retry2.txt). Final combined batch above is98/98 on final source.

No full-suite, build-all, commits, or subagents. Parent acceptance2/re-review remains parent-owned. All source edits STOPPED.
