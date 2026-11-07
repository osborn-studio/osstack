# Production factory review dispositions

Scope: GLM-5.3's review of `production-review.diff` at `85f85119`: the new production factory and the changed host-port sections. The invariant 6 follow-up (`bcd20732`) was outside that review. These are implementation-owner dispositions, not independent approval of the implementation.

| Finding | Disposition and evidence |
|---|---|
| P1-1: absent revision check authority | Rejected. The first PR's existing App B check works without live revision mode. The production revision factory requires and installs the runtime callback before service construction. The network boundary checks owner plus that installed callback (`contained-mission-ports.ts:252`, production factory lines 41–42). Requiring it for all root checks would change the established mode matrix. |
| P2-1: missing publisher fence and arbitrary cwd | The claimed missing fence is rejected: `fencedDeliveryRunner` constructs the W13 gate; `assertRevisionPublishable` rechecks owner, grant, runtime switch, child and intent synchronously inside release. The cwd concern is addressed: credentialed revision execution now reads the stored Mission spec and checks its worktree before execution (`contained-mission-ports.ts:279`). |
| P2-2: destination/config change during token refresh | Accepted. A regression changes the remote push URL while token minting is pending. The original code released the write. Revision execution now repeats the recorded config, candidate head, exact HTTPS repository and transport checks after the token await and before invoking the W13 launcher. No asynchronous check was moved into or after the release fence. This closes the tested await window; same-UID concurrent host edits are not claimed to be locked by this check. |
| P2-3: verification cap and optional Codex options | Rejected. `ContainedMissionPortsOptions.codex` is required. The verification executor allows at most 120,000 ms and defaults to that value (`packages/agents/src/contained-command.ts:66`, `:204`). This ports factory passes no override. Codex defaults to 600,000 ms (`packages/agents/src/adapters/codex-proxy.ts:63`); the port derives the charged cap from its configured timeout. |
| P2-4: cancellation and blocking reads | Accepted. Production read effects now share an owned abort controller; stopping either scanner or aborting startup recovery cancels those effects. `GhExec` forwards the signal to `execFile`; cumulative compare checks it between pages. Revision preflight bounds remote URL output and propagates cancellation. A real child-process regression proves an active read exits on abort. |
| P2-5: rev-list truncation | Rejected. `runHardenedGit` fails with `HARDENED_GIT_OUTPUT_LIMIT` when output exceeds its cap (`packages/agents/src/contained-workspace/hardened-git.ts:165`). It does not return truncated successful output. Publication also checks full SHA syntax and the 64-commit bound. |
| P2-6: dot repository segments | Below P2 for this change: a host-configured read-only endpoint can fail with 404. The review supplies no write or credential-scope bypass. Repository validation remains a possible general hardening change; it is not represented as fixed here. |
| P2-7: authority callback setter | Rejected as a security boundary claim. This is an in-process factory capability, not an RPC method or untrusted input. Code that owns the ports object already owns the writer dependencies. The actual network boundary still asserts the daemon owner. |

## Validation

- The token-refresh destination regression failed before the correction and passes after it. No credentialed command or release callback runs after the injected change.
- Targeted production/ports/reader/ledger/wiring suite: 125 tests passed. The real process cancellation regression is an additional check.
- CLI typecheck passed. Runtime remains inactive: the daemon still rejects live startup until phase 5-F and 5-G acceptance evidence is reviewed and the code gate changes.

The corrections are in the commit containing this report. They do not approve deployment or replace the independent acceptance review.
