# Read-only scouting, explicit promotion, and verified recovery lessons

## Scout is an executable bounded investigation

`osstack scout inspect --repo /absolute/repository --goal 'Investigate greeting' --path src/greeting.ts --profile mac-mini --request-id greeting-1 --json`

The host reads the requested regular files from the exact committed HEAD using fixed Git object reads. It does not invoke an agent, shell, project check, filter, external diff, hook, checkout, or write to the repository. Dirty working files are deliberately not investigation sources. Symlink blobs, directories, binary/invalid UTF-8 content, unsafe paths, more than 16 files, a file over 64 KiB, or aggregate source over 256 KiB are rejected. Host policy and HEAD are rechecked before the receipt is accepted.

This first executable scout backend is deterministic source evidence gathering. It is not an LLM-generated explanation or a general interactive explorer. Its receipt includes source text, exact object IDs, content hashes, frozen scout contract, bounded tool declaration and an explicit investigation-only qualification. Source text is untrusted data. No source fact becomes a tool command or approval. The selected host check registry is recorded but no check executes in scout mode.

Receipts live in the explicitly configured private `OSSTACK_HOME/scout`, outside the repository. Home and state directories must be owned by the process UID and inaccessible to group/other users; final symlink directories are refused. Receipt/request files publish through synced temporary files and an exclusive link, then sync their directory. Repeating an identical request at the identical HEAD/policy is idempotent; reusing an ID with changed source, goal, paths or policy fails with a conflict. A new investigation requires a new request ID.

## Promotion starts ordinary guarded execution

`osstack scout promote --scout RECEIPT_SHA256 --request-id greeting-implement-1 --json`

This is an explicit execution request. The host reloads its own digest-bound receipt, resolves the repository's **current** HEAD and policy, selects the current registered checks, creates a fresh implement contract with a parent reference, and passes it to the existing guarded-local delivery entry. It preserves the explicit profile and source-path scope. The normal profile independence, current policy/risk admission, source fencing, isolated worktree, governance, real checks and review are all still required. A newer HEAD between investigation and promotion is supported; the new verification receipt must bind that newer base.

Promotion grants no publication/commit/merge/deploy authority and never treats scout investigation as code-delivery proof. Builder tools exist only after explicit promotion and normal host admission. The scout's facts are not silently injected as instructions. Promotion creates and syncs a claim keyed to the parent receipt before dispatch. An existing claim blocks replay even under a different promotion request ID. Task/contract identity derives from the parent digest plus request ID. A terminal `promotion-result-<parent-digest>.json` index links to the immutable completion/failure receipt; the receipt includes the captured delivery-output digest. Zero exit alone is insufficient: successful promotion requires `local_verified` for the exact new contract. If execution throws or the process crashes, inspect retained claim/delivery evidence; this interface does not automatically replay or reconcile an uncertain attempt. A completed dispatch with a nonzero guarded-delivery exit remains a failure, not a successful delivery.

## Lessons come from the running verifier

Guarded-local V2 delivery now installs a narrow trusted `LoopRunOptions.observeVerification` hook after the real verifier and unchanged-source fence. No CLI flag, JSON import, adapter completion message or ordinary run outcome can insert an observation. Each attempt records exact loop/task/run/contract/policy identity, iteration, source-state digest and registered-command digest/exit. Raw model output and command stdout are excluded.

A recovery draft is generated only after the normal final delivery receipt is independently reviewed and accepted and all final completion gates succeed. The live collector reloads every host record and checks:

1. Sequential attempts within one execution/workspace/task/contract.
2. At least one genuinely failed required check on a different bounded source snapshot.
3. Confirmed normal process-group exit. Timeout, cancelled, unconfirmed, unsupported and signal/error outcomes do not qualify as a repaired check failure.
4. The same registered check passes on the final changed source.
5. The final run/source/checks match the actual digest-bound final delivery receipt, and the source still matches the verification fence.

Review-only failure, unchanged source, a first-attempt success, ordinary adapter outcomes and supplied JSON are not evidence of recovery. They produce no qualified success-after-repair draft. A required check can be flaky; observed source change plus check recovery does not prove causal root cause, so a human must review the proposed rule.

An evidence/source-integrity exception refuses the success response and retains evidence/candidate for manual reconciliation; it is never downgraded into a trusted lesson.

The draft is create-only under the **private delivery state directory's** `loop-lessons/drafts`, and the CLI summary returns `recovered_lesson.path` and the evidence references. The original repository stays unchanged. Existing `loop lessons` review/promote/discard flow can inspect that workspace explicitly; the bridge never automatically edits a skill, publishes knowledge, or promotes a draft. An edited/reviewed draft is preserved by the existing draft lifecycle.

## Qualification and limits

Automated local integration uses a real Git repository, a newer committed base after scout, a real isolated candidate, a genuine failing `pnpm test`, a source repair, and a succeeding real check. Offline builder/reviewer adapters make deterministic edits/reports; they are not live commercial-model qualification. Another test times out a real verifier process then succeeds, proving that timeout cannot qualify as a recovered test failure. Full Loop regression and focused CLI validation are recorded with the implementation report.

No real model credentials, SSH service, public message, deployment or production OSStack home is needed for these paths. Live commercial-model quality and external-provider attestation remain environmental qualifications. The module does not claim a same-UID hostile-process filesystem sandbox, atomic filesystem snapshots, arbitrary remote repository isolation, crash-resume of the lesson collector, or power-cut verification. A source fence detects sampled change; it is not an OS sandbox.
