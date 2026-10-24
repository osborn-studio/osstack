# Independent source fix verification and actual CLI main evidence

This report records independent Codex review by the delivery component agent of the source component, plus execution of the new main-entrypoint tests. It is not a Claude audit or a complete-repository qualification. No real SSH connection, public message, production credential change or external mutation occurred.

## Source review: two reproduced P1 findings now closed

Original reviewed source: eae27b87453d434f445f9309be661f49ed464f2a. The reviewer created a standalone scratch reproduction without editing the source component worktree. The original raw output proves both defects:

1. A mode0600 acknowledgement under a home inside the repository could change a quarantined gap to ready. Repository write authority was therefore sufficient to manufacture the purported host approval.
2. With two injected sources, removing alpha from the source registry while beta was being checked allowed actual adapter invocation containing alpha. The registry already reported alpha not_registered at dispatch.

Corrective source reviewed:3a56983dbb7e09be9f487486f8af5446a77bf984. The reviewer read the host-scope/private-authority checks, full-registry and policy binding, final synchronous source/ledger fence, and the host composition supplying validateContextSync. The final fence is immediately before adapter.invoke, after all asynchronous validation. The reviewer then rebuilt and ran the scratch reproduction against that correction. Raw results show:

- Repository-owned home refused with source_host_inside_repository.
- An outside-repository host remains a valid positive control: exact gap acknowledgement succeeds.
- Alpha revocation during beta validation now fails with source_context_authority_changed.
- adapter_invoked:false and revoked_alpha_in_prompt:false.

Both reportedP1 findings are closed in this independent reproduction; no additional reproducibleP0/P1 was identified in the reviewed source ledger/approval/context-budget/dispatch scope. This is bounded review evidence, not proof that every possible race or deployment configuration is correct. Original and corrective source scripts/results are preserved under source-reproduction/. The fixed multi-source script supplies validateContextSync exactly as the production host composition now does. It deliberately uses an outside-repository host so the second issue is tested independently of the first refusal.

Reproduction compilation used Node22 and esbuild, bundling each scratch TypeScript script with packages external, ESM/node platform and the knowledge source index alias to avoid stale tracked package output. Only generated scratch bundles were executed. Source-review scripts contain explicit worktree paths from that run; use the matching checkout and dependency symlink if reproducing elsewhere. All created test directories were removed.

## Main entrypoint integration validation

The implementation agent was authorized to edit only bin.ts and new remote-cancel-main.test.ts in the root integration worktree. The parent subsequently committed these exact verified file bytes as c8dc83fa. The reviewer checked both SHA256 values against that commit; manifest.json records the full source commit, file digests, capture HEAD and path status. Parent integration owns the complete suite.

The new test bundles the actual main() from bin.ts and invokes it in real local child processes with explicit isolated OSSTACK_HOME. Five tests passed:

- English and Chinese top-level help expose remote cancellation, source observations, native upgrade actions, scout inspect/promote, separately authorized worker logs and paired holdout evaluation.
- Aggregate remote-home help and natural inspect/cancel/query/issue-cancel-grant and remote-control help work without host setup.
- Invalid cancellation/query/signing requests reach their intended fail-closed handlers, and an unconfigured or argument-injected remote-control exporter produces no protocol pollution or DB creation.
- sources inspect retains its help, while observe/events/acknowledge and aggregate source help are discoverable without daemon access.
- The actual main remote-control route completes a framed hello/query exchange using a valid historical signed grant, returns not_found with physical_stop:not_attested, and opens no database or daemon socket.

Strict CLI typecheck, formatting/lint of the new test and git diff whitespace checks passed. main-tests.log, main-typecheck.log and main-lint.log are raw outputs. No test claims a live SSH deployment, production adapter stop or installed binary qualification. Existing component tests cover the fuller cancellation execution path; parent tests cover source daemon/RPC integration.

## Independent audit limitation

The requested Claude Code CLI Haiku5.5 audit remains pending authentication recovery, as documented separately in the delivery and remote-cancel evidence. This independent Codex review and these executed tests are explicitly separate and must not be called a Claude pass.
