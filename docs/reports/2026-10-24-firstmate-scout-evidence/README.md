# Scout and recovery-lesson component qualification

Implementation closes the executable bounded-scout/promotion path and same-execution verified recovery-draft bridge for ledger rows 12/20. Central `bin.ts` routing is root-integration-owned and must be qualified after this component is cherry-picked; this component already exercises `handleScoutCommand` and the real guarded-delivery/Loop path.

- Full Loop suite: 29 files / **445 tests passed**.
- Final focused CLI suite: `scout-command`, `deliver-cli`, `delivery-contract-host`: **48 tests passed**.
- CLI strict typecheck passed. Biome checks passed (one harmless literal-template fixture warning); final diff whitespace check passed.
- Integration runs actual Git object reads, a newer HEAD after scout, an isolated real worktree, actual failing and succeeding `pnpm test`, source repair, independent offline review, exact candidate/verification receipts, unchanged original repository, and private create-only draft output.
- Negative runs cover no prior failure, review-only/unchanged-source failure, genuine verifier timeout followed by success (not qualified), and corrupted failed-check evidence (no successful completion emitted). Scout cases cover read bounds, unsafe/symlink/binary files, dirty source, policy drift, tampering, root path, unknown replay even a new request ID, terminal escaping, and zero exit without bound delivery proof.
- Initial `red.log` failed because workspace dependencies had not yet been built. It is retained as setup history, **not represented as an implementation regression test**.

## Claude Code CLI challenge disposition

Three completed tool-less rounds requested `claude-haiku-5-5` with isolated MCP/settings. `modelUsage` reports that identifier; stderr emits `unrecognized_model`. This is requested/reported identity, **not independent provider/weights attestation**. Static audit did not run tests. Exact prompts, results, stderr and checksums are retained.

Round 1 conditional multi-review issue was addressed by checking every reviewer at receipt construction, not only the first. Added second-artifact builder/identity/source rejection coverage. Concrete hardening addressed repository-root enforcement, atomic temp+fsync+link receipt publication, parent-digest/request-derived promotion task identity, and final live candidate re-verification. Tree identity is no longer labeled as a commit; canonical-JSON identity digests are labeled accurately.

Round 2 had no confirmed P0/P1. Its remaining hypothetical P1 (bare vs frozen contract) is disproved by the actual `deliver-command.ts` loader (`freezeDeliveryContract(JSON.parse(...))`) and actual successful promotion tests. Its confirmed storage P2 was fixed in `persistDeliveryHostRecord` with atomic publication and directory sync. Promotion completion now requires captured `local_verified` output for the exact contract; an immutable deterministic `promotion-result-<parent-digest>.json` index links the claim's parent to its terminal receipt, whose digest includes the captured delivery-output digest. `emitJson` composes one CLI response without global console interception.

Conservative behaviors retained intentionally: a started uncertain dispatch is never automatically retried; a lesson provenance/source-integrity exception refuses a success response and preserves candidate/evidence for reconciliation. All-reviewer independence is proven at host receipt construction; the existing V2 receipt stores its first reviewer and the full-artifact digest, not all identities, so it cannot independently re-prove every reviewer from that receipt alone. Live commercial model quality, same-UID OS sandboxing, atomic filesystem snapshots and power-cut recovery are not claimed. Qualified lessons are advisory review drafts, not automatically promoted knowledge.

The final targeted third audit returned **“Confirmed P0/P1: none.”** Its guesses are resolved by actual admission/tests: explicit promotion authorizes current guarded implementation within the inherited file scope; uncertain dispatch intentionally requires manual reconciliation; typecheck covers the renamed helper; artifact-only local candidates intentionally keep HEAD at the base. See [guide](../../guides/scout-and-recovery-lessons.md).
