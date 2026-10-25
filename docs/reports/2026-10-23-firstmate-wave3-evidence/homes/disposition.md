# Local home inventory challenge disposition

Three Claude Code CLI static rounds requested `claude-haiku-5-5`; raw responses and warnings retained. Final round reports no confirmed P0/P1. Reviews do not execute tests or attest underlying model weights.

Fixed false complete for all-disabled manifests, torn persistent identity publication, canonical home aliases, short reads, empty-response classification, duplicate endpoint recheck, safe manifest errors and unexpected startup error handling. Identity now publishes via complete file sync, create-only hardlink, directory sync; concurrent starts converge without replacing an existing pin. Explicit `matched_requested` means only requested field comparisons, never application health or provenance.

Final delta narrows errno matching so Node `ERR_*` programming failures propagate; the new injected regression passes. Tests include both file-sync and directory-sync failure, concurrent initialization, malformed/empty pin, symlink refusal, oversized/trailing responses, real daemon restart and command entrypoint. Socket deadline does not preempt filesystem calls. The inventory never opens a database; daemon migration happens only in independently authorized startup before snapshot creation.

Accepted limitations: same-UID local trust, no peer attestation, copied identity is not clone detection, hardlink/fsync-capable local filesystem required, abrupt termination may leave an unused temporary file. Endpoint/manifest invalid inputs fail conservatively with stable codes; these errors do not establish process health. Full multi-home upgrade, process-drain coordination and build provenance remain unqualified.
