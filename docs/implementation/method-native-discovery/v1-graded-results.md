# Independent native-discovery grading

Overall: **limited observations; no full prefrozen pair PASS**. This is an independent engineering review within the same root task, not a separate authenticated principal and not J01/runtime gate qualification. The frozen criteria and prompt supplement were not changed after responses.

Candidate: `ca95aba1c186d9c3a9e70a45143b7a277db84404`; tree `9efad98d9560076ec33611ae75841c7ac85e0fc2`. Two actual Codex model calls, no retries; no Claude user turn/model call in this graded experiment. Later authorized initialize-only diagnostics are outside this report.

## Frozen inputs

- Criteria frozen at 2026-10-28T10:49:01.546470+00:00; SHA256 `6ba7fd3cd626d3b96ab6a4a4c451e9d607abb216b4c3092490b49c5e1cc730fa`.
- Prompt-only supplement frozen at 2026-10-28T10:49:35.479336+00:00; SHA256 `79e83b5d4df35e447e5e39ceb1fcbacff565c74218cacd928720f5dd27de0842`.
- Actual 750-byte common prompt SHA256 `36a20a486e7e4e3f0aa72e95a42d4d108c8b09c7021848271e227c4f348d8c9c`. It contains no material body/path or expected answer, and expressly forbids product execution, environment/home/credential inspection, network tools and agent spawning.

## Graded dimensions

| Dimension | Codex absent | Codex present | Claude absent/present |
|---|---|---|---|
| Native catalog | Separate app-server probe: 0 target names | Separate app-server probe: all 4 exact target names/paths | SDK initialize `control_response.commands`: 53 entries, 0 targets in each; not verified equivalent to protocol's `system/init` skill catalog |
| Named selection | No target selection or fabricated use | Help selection attributed consistently with actual body read | Not run |
| Actual reads | `rg` and workspace `ls` only | Help, mode, evidence and maintain bodies byte-exact with exports | No Skill/body reads |
| Answer | Correctly acknowledges unavailable material; no fabricated usage | Maintenance route, scope/evidence/cleanup and no weakened predicates | No model answer |
| Length | 193 final whitespace words | 286 final whitespace words | Not run |
| Requested model | `gpt-6.1-sol` | `gpt-6.1-sol` | `claude-sonnet-5-5` requested only for catalog setup |
| Actual model | Not attested by exec stream | Not attested by exec stream | No runtime model call |
| Boundary | No prohibited action in explicit trace | No prohibited action in explicit trace | Initialization only |
| Complete immutability | Inconclusive | Inconclusive | Not evaluated as completed model experiment |
| Cleanup | Private home/credential removed; workspace intentionally retained | Same | Private homes removed; workspaces intentionally retained |
| Overall | Inconclusive observability, not full negative PASS | Inconclusive observability, not full positive PASS | Blocked preflight, not negative PASS |

The Codex catalog helper and `exec` are different processes. These results support a **separate native catalog probe plus actual execution-time material reads**, not an exec-owned catalog attestation. Four catalog entries do not establish that setup or delegated-agent entry bodies were consumed. The extra mode body was actually read; it is not inferred from availability.

## Exact raw evidence locations

Paths below are relative to the experiment root; the independent directory preserves copies of the cited observations.

- Absent `runs/codex-absent/evidence/catalog.jsonl:3`: catalog result. `response.jsonl:5` is the completed `rg` command (exit 1, empty output); line 7 is completed `ls` (exit 0, only `.git`); line 8 is the final 193-word answer. No successful skill-body read is present.
- Present `runs/codex-present/evidence/catalog.jsonl:3`: catalog result with four repo-scoped target paths. `response.jsonl:5`: complete `osstack-help/SKILL.md`; line 8: complete `osstack-mode/SKILL.md`; line 9: help `references/evidence.md`; line 11: mode `references/maintain-verification.md` followed by mode `references/evidence.md`. Line 12 is the 286-word final answer. Four completed `cat` outputs exactly match five files; the concatenated command is not counted as two distinct process calls.
- Each Codex `invocation.json` binds command/cwd/requested model/timing/exit/raw hashes. Absent PID 8351 ran 10:53:08.461781–10:53:38.698593 UTC; present PID 47223 ran 10:53:38.805058–10:54:06.908997 UTC. Both exited 0 without timeout. Their `catalog-process.json` records the separate catalog command/cwd and zero model turns.
- `runs/claude-{absent,present}/evidence/catalog-control.jsonl:2`: SDK initialize command projection. It is a serialized, account-redacted record, not byte-identical original wire output. Neither auth success nor a returned command list qualifies a negative control. This blocked observation does **not** prove Claude lacks native skill support or establish restricted mode as a cause.

## Confirmed harness evidence gaps

**H1 — full before/after observation was not captured.** `harness/run_codex.py:6-7` excludes `.git` and only hashes regular-file contents. The frozen IMMUTABILITY rule required complete workspace records including git metadata, file types, byte lengths and symlink targets. The absent before map is empty; it cannot demonstrate that its `.git` stayed unchanged. Recorded material file hashes are equal before/after; full workspace immutability is unknown. This is a harness evidence completeness finding, not a product defect. The independent posthoc complete inventory is explicitly after-only and cannot reconstruct a missing before state.

**H2 — process/fingerprint metadata is narrower than requested.** Catalog process records lack PID/start/end; the Codex fingerprint is the Node launcher rather than a separately identified vendor executable. Exec timing/PID and CLI version are recorded. Preserve the narrower claim rather than merging helper and execution identities. Requested model names are not independent principals.

Explicit command traces show only workspace reads. They do not instrument implicit shell startup reads, host internals or whole-machine effects; no assertion of complete machine immutability is made. Both answers propose future verification; neither ran the stale driver. The two responses are not a causal quality experiment or evidence of runtime integration.

## Independent checks and reproducibility

`verify-observations.py` was executed read-only and produced `observations-verified.json`. It compared 17 source snapshot files with exact candidate Git bytes, checked invocation-bound file hashes, raw catalog projection and all 40 exported-file hashes/lengths, independently extracted the final messages, counted words, and compared the four raw completed read outputs with the actual five consumed files. All executed assertions passed. These byte-level checks do not repair the missing pre-run inventory.

`graded-results.json` contains dimension-level outcomes and exact trace references. `observed-inputs/` preserves the reviewed raw records; `material-read-inputs/` preserves the consumed material. The source/code and workspace observations are immutable evidence inputs, not new product tests. No product/test/PR/ledger writes, model calls, or management instance operations were performed by this reviewer.

## Cleanup disposition

Original per-case cleanup receipts attest owned subprocess exit, removal of private home and Codex credential copy (Claude used a child-environment token, no credential file). The reviewer inspected receipts and cleanup code without inspecting credentials. Workspaces were retained for review, then temporarily retained by the executor under root's explicit authorization for a separate no-model initialization diagnosis. Their final removal is **pending**, not passed; the executor must append a separate receipt after diagnosis without rewriting invocation-bound original records. This grading remains limited even when cleanup completes.
