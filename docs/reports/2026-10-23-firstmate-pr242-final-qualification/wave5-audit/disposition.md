# Root Wave5 audit disposition

Round1 returned no P0 and a conditional P1 for unknown host error exit status; fixed exit2 and help, preserving reconcile nextAction. Missing-file observations were not accepted as proven exploits. Round2 found a hidden-index scope candidate: confirmed by red tests and fixed by rejecting assume-unchanged/skip-worktree flags before freeze. Durable envelope identity re-check, overlay missing-vs-content sentinel and C1/Cf output escaping were also added.

Round3 confirmed a different pre-freeze bypass through Git stat cache (core.trustctime=false plus same-size content and restored mtime). Although the immutable candidate check prevented ready, out-of-scope bytes could enter a frozen artifact. This was accepted as blocking and fixed using bounded raw bytes/mode comparisons against immutable base blobs. Original red and real Graph no-review/no-candidate regression retained. Final follow-up report accompanies the fix.

Other P2 observations: artifact orphan files are not referenced by ready evidence; unknown start/resume requires inspection and explicit supported cancellation reconciliation, not blind resubmission; local same-UID filesystem corruption is fail-closed, not a sandbox guarantee. Bounded host receipts remain create-only and may require manual recovery after a partial filesystem write; no automatic repair/reset or success inferred. Legacy scope path aliases and short-read availability gaps are not converted to stronger production guarantees. Existing Graph final CAS rechecks current durable verification transactionally.

CLI explicitly requested claude-haiku-5-5; modelUsage reports that ID but stderr unrecognized_model means provider weights are not independently attested. All reports are static challenges, not executed tests.
