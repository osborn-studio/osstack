# R3 audit disposition

Three isolated Claude Code CLI static reviews requested claude-haiku-5-5 with tools/hooks/MCP disabled; rounds 2/3 explicitly --effort medium. Prompts/raw JSON/stderr retained. CLI emits unrecognized_model; requested/result-labelled model is not independently identity-attested. No runtime checks are attributed to the model.

Round 1: no P0/P1, four P2. Canonical manifest diagnostic fixed with red/green test. Invalid request throws invalid_request by documented API; parent maps it. Cross-restart wall-clock rollback is outside same-process guard and explicitly pending durable clock qualification. Atomic intermediate-directory confinement is not supplied by Node O_NOFOLLOW; before/after identity checks plus independent content pin prevent returning changed/unpinned bytes, but cannot prove a transient outside regular-file read never occurred. Qualified scope is host-controlled local directories, not adversarial shared filesystem.

Round 2: no P0/P1, one P2 registration-existence oracle through noncanonical other-repo config_invalid. Red/green fixed: canonical ownership comparison precedes owner-only alias diagnostic. Parent independently identified missing CLI response-scope fence; red/green fixed by canonicalizing input inside total deadline and checking source_id/repo/defaulttenant before output.

Round 3 scoped final production code: pass_no_p0_p1. Both scope fixes confirmed. Two P2 observations closed as documented contracts with additional tests: dangling alias cannot prove ownership and returns not_registered; early disabled/busy/cancel/config-invalid responses echo an unverified request label with no provenance/entries. CLI canonicalizes even those cases. Ready source receipts always carry verified canonical scope. The race-only config_invalid branch is retained conservatively.

Final code unchanged after round3; only docs/tests clarifying these contracts added. Remaining qualification limits explicitly documented: trusted host clock across restart; no atomic directory-handle confinement/NFS/SMB qualification; stuck filesystem can retain two slots until diagnosis, never automatic slot reset. No P0/P1 blocker remains; do not claim these broader guarantees were solved.

Evidence: final20 tests/typecheck/Biome, real local config/content reader+CLI-handler port test, native56,589B20-entry file benchmark350ready samples (50warmup+300measured). Parent owns actual daemon/bin routing, socket validation, full suite, PR.
