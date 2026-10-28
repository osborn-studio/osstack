# Reusable skills-check verification — bounded D2a slice

Base: main `64b203c32d245d5ad9a76914253ca18cbb54a073`, after PR288 and PR289. OSStack card `card_25794a87`. User explicitly requested continued development and actual Codex/Claude method use. This extracts a repeatable verification workflow from the already-merged bug fix; it does not add a runtime, registry, schema, permission surface or MethodBinding.

## Public script surface

`node scripts/smoke-skills-check.mjs [--doctor | --dry-run] [--case all|healthy|missing-ref|drift|mixed|empty] [--evidence-dir NEW_DIRECTORY]`

Default is run/all. Doctor and dry-run inspect availability without starting child processes or creating state/evidence. Missing prerequisites are blocked, not a successful behavior run. Unknown/conflicting arguments fail usage. The optional evidence destination must be new and its parent already exist; existing files/directories must never be overwritten. The default destination and disposable fixture live under OSStack scratch but separately, so fixture cleanup cannot delete evidence.

| Case | Fixed actual CLI outcome | Verification meaning |
| --- | --- | --- |
| healthy | exit 0, checked ref equals blessed SHA | Positive control passes |
| missing-ref | exit 1, unavailable ref and one failed check | Expected failure is correctly propagated; source has not recovered |
| drift | exit 2, real ref differs from blessed SHA | Drift is reported distinctly |
| mixed | exit 1, one failure and one drift | Failure takes precedence and both counts survive |
| empty | exit 0, no configured source | Empty input remains valid |

Each case uses the actual compiled CLI and real local Git repository/manifest, never mocked successful observations. Only `file://` origins and a controlled minimal child environment are used. Global/system Git config, hooks, templates and inherited Git routing are isolated. No network, default OSStack home, live provider or user repository mutation is required. No auto-install/build or opportunistic configuration repair occurs inside the driver.

Driver exit 0 means all selected verification predicates, input-byte preservation and owned cleanup succeeded. It does not mean every inner source check returned 0. Blocked/failed execution exits nonzero; usage is separately identifiable. Case results keep expected/actual exits, behavior, harness and cleanup distinct. Time/output are bounded. A timeout does not prove descendants exited: preserve uncertainty and owned fixture when safe cleanup cannot be proven.

## Evidence and acceptance

Retain actual argv/cwd, non-secret environment choices, raw stdout/stderr/exits, actual input manifests, Git fixture identities, source/build/script hashes before/after, per-case predicates and cleanup observation. A small summary/receipt points to separate large binding lists and raw evidence; it cannot imply those entire lists have been verified by a model. Source SHA alone does not attest generated binaries. Evidence must survive fixture teardown and have a verifiable file-hash manifest. Never reuse another invocation's evidence directory.

The author owns the new script/helper/unit test files. A separate worker froze eight black-box checks before reading the candidate, including read-only preflight, complete case outcomes, evidence preservation, no-overwrite, invalid input, missing build and a controlled legacy-zero mutant. These are engineering checks, not authenticated oracle qualification. Root owns the full-regression queue, source-bound actual Sonnet5.5 review, documentation and PR publication.

## Host-assisted usage slice

After the driver is frozen, Codex and Claude can read the same bounded method/plan inputs and select fixed case IDs. A trusted parent runner validates IDs against a closed mapping and executes only the declared script and case; it never runs model-generated command strings. Give each host a separate evidence destination and return the actual receipt for interpretation. Use healthy plus missing-ref as a positive/negative pair. Retain complete model output, actual version/model evidence where available, input hashes and physical execution records.

Claude review/consult stays tool-less or read-only; the parent performs the physical commands. This establishes at most a host-assisted workflow, not native autonomous execution, causal method benefit, cross-provider equivalence, installation/discovery, qualified principals or any J gate pass. No host run is marked complete until it actually occurs. Ordinary source/test gates and user GitHub approval remain separate.
