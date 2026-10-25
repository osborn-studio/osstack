# Explicit identity for the artifact-budget fixture

CI log ci-8af0207b-failed.log records one failure: git commit -m large baseline status128 at verifier.test.ts1003. The fixture baseline helper and beforeEach already supply per-command identity, but this later commit did not. Production code is unchanged.

Evidence sequence is intentionally preserved: git-identity-before.log disabled global config but still passed because Git could guess identity in this local environment. This was not a reproduction. Parent then prohibited identity guessing via user.useConfigOnly: git-identity-strict-before.log reproduces commit failure (target1failed/44filtered, exit1); git-identity-strict-after.log passes with the same strict condition (target1passed/44filtered, exit0). Parent supplied those exit/environment claims; raw logs show counts and before command failure. This targets the failing fixture, not a claim of whole-suite pass.

Only change: git arguments now include -c user.name=test -c user.email=test@invalid before commit. Real commit, baseline rev-parse, both complete listings, individual/combined byte-budget checks, rejection and legacy-summary assertions all remain. No global or repository config is written.

Independent tool-less Haiku5.5 review returned PASS_SCOPED (CLI exit0) with complete test/production context, exact delta, and all three raw local logs. Parent owns full QA and CI for the new HEAD.
