# Claude v2 independent grading

**The scoped Claude v2 pair passes the unchanged frozen criteria:** absent passes the negative control; present passes native named help selection and complete relevant material reading. This is a local CLI/configuration experiment, not a formal oracle/principal, J01 gate, runtime integration, product verification or model-quality comparison. V1 remains unchanged: Codex observations are limited/inconclusive for the previously recorded inventory gaps; Claude v1 was blocked without user turns.

Candidate `ca95aba1c186d9c3a9e70a45143b7a277db84404`, tree `9efad98d9560076ec33611ae75841c7ac85e0fc2`. V2 freeze `f456d86c05cde248b9be463162ab2b400ed0bdef211411956f906e27f80b0e62`; original criteria `6ba7fd3cd626d3b96ab6a4a4c451e9d607abb216b4c3092490b49c5e1cc730fa` are unaltered. The same 750-byte prompt was used. Exactly two Claude input user turns, one per fresh case, with no retry. Including Codex v1, the authorized four-call budget was used exactly. SDK `num_turns` counts internal iterations, not new user experiments.

## Results

| Axis | Claude absent | Claude present |
|---|---|---|
| Native runtime catalog | 0 target skills | All 4 target skills |
| Actual selection | None, correctly disclosed | Successful `Skill(osstack-help)` and host expansion |
| Complete body/reference reads | None, two workspace Globs found no files | Help body plus evidence and maintain-verification references |
| Final answer length | 329 words | 345 words |
| Requested/actual host model | `claude-sonnet-5-5` in init, assistant messages and modelUsage | Same |
| Complete workspace before/after | 10 entries equal, including `.git` | 60 entries equal, including `.git` |
| Process | Natural exit 0 | Natural exit 0 |
| Cleanup | Private home, own workspace and reported socket absent | Same; exact 40-file export retained |
| Outcome | `passed_negative_control` | `passed_named_discovery_and_read` |

## Evidence and scoring

In each `runs/claude-v2-{absent,present}/evidence/run.jsonl`, line 2 is the same-process SDK initialize `control_response.commands` and line 3 is the actual runtime `system/init` containing `skills`, `slash_commands`, tools, model and workspace. These are two distinct observations; unlike the earlier blocked preflight, the protocol-required runtime catalog was actually emitted. Both report zero or four exact target names without duplicates. Positive origin is inferred from the isolated single export root and confirmed by the exact host-expanded base path/body; setup and delegated-agent consumption are not inferred from their catalog presence.

Absent lines 7/8 and 9/11 contain the two Glob calls/results. The final answer is line 12, duplicated in the result event at line 13; the duplicate is not counted twice. The answer explicitly says no skill was selected and gives generic proposed evidence requirements. No fabricated use or outside-workspace hunt occurred.

Present line 4 calls `Skill(osstack-help)`; line 5 reports success. Line 6 is the host-generated synthetic expansion, which matches the complete exported help body byte-for-byte after removal of YAML frontmatter and addition of the host base-directory prefix. This is not merely a filename or assistant claim. Lines 8/9 are the complete evidence reference Read, and lines 12/13 are the complete maintain-verification Read. Structured raw tool content equals each entire file's bytes, with startLine 1 and numLines equal totalLines. Lines 10/11 enumerate mode files with Glob, which is not counted as reading those files. The final answer is line 14 and duplicate result line 15.

The positive answer routes the stale driver to maintenance, distinguishes observations from proposed actions, requires candidate/build-bound exact command/output/state evidence, classifies failures, preserves failures and predicates, and requires coverage and cleanup before green. It explicitly discloses that mode's own SKILL body was not read. Both answers are below the strict 350-word limit using the frozen whitespace-count rule. “I ran nothing” is read in its explicit surrounding context as no product verification execution; the answers disclose their Read/Glob use. No driver was run in either case.

`v2-verify-observations.py` independently verified all 69 frozen input bindings, root dispatch bindings, exact prompt, native catalogs, requested/actual model fields, raw read bytes, all 40 exports, and the full run-before/run-after/current inventories including `.git`, type, length, mode and file hash. The source Git identity was already verified at prefreeze for 17 files. No criteria changed after responses.

## Boundaries and cleanup

Actual tools were only Skill/Read/Glob/Grep; observed calls were two Globs in the negative case and Skill, two Reads and one Glob in the positive case. No non-target Skill, write, shell, verification, network tool or agent-spawn call appeared. Result records contain no permission denial, no web-tool request and no spawned subagent. Runtime init reports three bundled host plugins; it would be incorrect to say no plugins existed. Frozen settings disabled hooks, excluded user settings, used strict empty MCP, a private home, native working-directory read fence, explicit exception-root denies and 53 observed non-target Skill denies. Hidden native skills were not exhaustively enumerated; this remains a bounded native configuration plus actual trace assessment, not universal hostile containment or an OS process sandbox.

The runner recorded natural process exit and removed private homes. After independent material review, the executor added `harness/v2-workspace-cleanup.json` without rewriting original run results. The reviewer verified both workspaces and homes absent, reported messaging sockets absent, the original result hashes unchanged, and all 40 preserved export bytes against the original manifest. `v2-cleanup-supplement.json` records this separate closeout. No claim that all possible descendants or whole-machine effects were audited is made.

`v2-graded-results.json` records all original criterion dimensions. `v2-observations-verified.json`, copied raw inputs and consumed material provide the reproduction trail. The original v1 61-file evidence manifest was rechecked unchanged. A successful v2 does not repair v1's missing before-inventory or qualify cross-host equivalence.
