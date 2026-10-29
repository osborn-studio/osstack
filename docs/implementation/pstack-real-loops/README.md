# pstack actual maintenance and repair loops

PR302 is Ready at head `72ab99e70ef54db924d775d3d3552ecde8780af0`, based on main `1bf1f6caa0ac0ae7b05c3caa9bb44d7ce6517dd0`. CI40819652448 checked merge ref `dca209453ab3cdd6e97bf83931730b3cabc1baf3`: five applicable checks passed, paid smoke skipped. The 22 package summaries contain 7,142 passed, 7 skipped and 0 failed; export tests contain 94 total, 93 passed and 1 skipped. Existing Sonnet5.5 source audit remains bound to its original candidate. Only gilberthello approves and merges.

This next slice exercised existing pstack methods. It added no method and changed no production source. The repair used a historical defect already fixed in production; it is evidence of bounded task execution, not another production fix.

## Verification maintenance: coordinator task

A coordinator injected one stale expected exit code in an owned verification map, ran the real verification driver against local file Git fixtures, inspected source and raw failure evidence, corrected the map, and repeated the driver and comparison entry points. A separate worker checked the records.

Product behavior did not change: healthy returned0 and missing-reference returned1 in both runs. The comparison was RED because the map incorrectly expected0 for missing-reference. Source inspection in archived `maintenance/diagnosis.json` confirmed that the absent branch must return1; the observed `no_matching_ref` agreed. Only that map cell changed to1. A fresh driver run and comparison returned GREEN. This is source-justified documentation-drift repair, not a product bug-fix GREEN or a model-host action.

The commands used the same comparator path. No per-run comparator hash was captured, so byte-identical comparator execution is not separately attested. Independent checks covered six manifests, four product invocations, 1,061 source and 2,336 build file hashes, and owned fixture cleanup. Dependency installation used the package registry; the subsequent Git fixtures were local. This injected exercise does not establish spontaneous drift detection or general effectiveness.

## Codex: one historical repair demonstrated

Each host received the same historical checker and six incident/control files. Host settings, exports and permission surfaces differed. Inputs and acceptance criteria were frozen before outputs. An incorrect H06 fixture-format expectation was corrected in a versioned pre-output supplement; the original error and results remain preserved. Root dispatched one user turn per host, at most600seconds, with zero retries.

Codex personally executed eight helper commands: three baseline checks, regression RED, three candidate checks and regression GREEN. Between RED and the candidate checks it edited one checker condition. The same test bytes produced 2passed/1failed against the original and 3passed/0failed after repair. The incident changed from incorrectly accepted0 to rejected1; both legal controls stayed accepted0. Recorded before/after inventory supports changes only to the authorized checker, new test and results; helpers, methods and six inputs retained their bytes.

Codex also used non-helper shell commands to read/write authorized files and analyze task records. Product/test execution stayed within the helper in the observed trace. This is observed adherence, not an enforced general shell fence.

Evidence tiers are distinct:

1. **Host-run regression:** same-test RED→source fix→GREEN, with unchanged incident input.
2. **Host-run legal controls:** both supplied controls were accepted before and after.
3. **Coordinator candidate checks:** separate copies ran the original/candidate tests and nine visible/hidden checks, eleven commands total. H06b relocates the visible incident bytes; it is a path-independence control, not new input data. The generic rejection error does not identify which predicate fired.
4. **Earlier baseline discrimination:** separate pre-output old/known-fixed runs are retained in `independent/baseline-check/`; the feasibility report and H06 supplement describe that preparation. Those are coordinator observations, not model-run holdout RED→GREEN or broad generalization proof.

## Claude: repair not completed

Claude invoked native `osstack-mode`, then submitted a compound Bash command containing several helper calls. That command was denied; no product invocation, new test or source edit occurred. The atomic form was not attempted, so its native permission outcome remains untested. The settings declare the helper prefix, but configuration alone does not prove a native call would execute.

The request listed separate commands without expressly forbidding combination or inserting test creation between its examples. Task-interface ambiguity contributed to the attempted form. Claude's final request for an additional helper permission was unsupported by the already-present declaration; the actual denial does not establish a missing general permission. This report does not isolate `for`, `echo` or another token as the permission engine's cause. Launcher exit0 means a response completed, not a repair succeeded.

## Reading, identity and boundary limits

Codex shell event8 contains the exact bytes of the three method files. That proves the recorded tool read, not independently attested model-visible delivery or complete consumption. No native invocation was observed; its statement that a native tool was unavailable is unsupported. All three assistant messages were reviewed; selecting the last message is a convenience, not an attested native final channel. Requested model was `gpt-6.1-sol`; resolved identity remains unknown. Earlier default-catalog metadata does not settle native availability under the execution flags.

Claude's reference-reading raw stdout contains the full reference-file bytes, while the model-facing message contains a roughly2KiB persisted-output preview. No subsequent full read was observed. Its claim to have read both references exceeds the demonstrated model-visible delivery. Requested `claude-sonnet-5-5` matches the CLI's self-reported modelUsage, not independent provider attestation.

The harness declares that it does not read, copy or record credentials and points each CLI at existing authentication configuration. We did not independently attest the CLI's authentication internals. No credential inspection appeared in the supplied task traces. Neither OS read/network isolation nor complete descendant cleanup is claimed. Different host permission surfaces, one task and explicit method prompts prevent model rankings or causal effectiveness claims. Formal J01/J11 and other joint gates remain unpassed.

## Next bounded improvement

Use a **different defect**, selected and frozen before the next execution, and explicitly label it historical or newly discovered. No new task has been selected or dispatched here. Test a staged atomic-command interface with unchanged permission boundaries: separate baseline calls, create a behavioral regression, test RED, make a bounded fix, and repeat unchanged tests/controls. The first actual atomic call doubles as the native permission feasibility check; denial ends that turn. No automatic fallback/reissue or inherited budget is planned. This would be a feasibility observation, not an efficacy benchmark. Current failures and criteria remain unchanged.

See the [original independent assessment](assessment/graded-results.md), [reporting amendment](assessment/reporting-amendment.md), and [minimal remediation proposal](claude-loop-remediation.md). Original event indices are zero-based; remediation raw-line references are one-based.

## Preserved originals

- Host archive SHA256 `0750403f4ab8b8ea71a1b5d5af02c0679a9c35db0f2ba25a979aa9ee0a385e01`:521members,411files/110directories,3,051,290payload bytes. Independent verification checked all hashes, bytes, modes and final workspace inventories.
- Independent archive `35d02182740943a7d378e3de7f2e988595ef97c638b7a9f410efc966cacb8abf`:176files/656,625bytes, including the175-file frozen payload and manifest, original preparation errors and failed assertions.
- Maintenance author archive `2351b9625f9bcdcd07fe5e52aafa41179e05a0868787fc48ad86054a798e59fa`:193files; separate independent review and cleanup receipts remain.

Archives and manifests are under evidence/ and maintenance/. CI logs are losslessly compressed under ci302/. Root guards record authorization for these calls; they are not independent identity attestations. After archive verification only the two owned host workspaces were removed, with a separate receipt; state and raw originals remain.
