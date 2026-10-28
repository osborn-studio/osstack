# Codex and Claude: observed method reading

Two bounded CLI calls read copies under `inputs/` of PR288 method files at `10629495aafe7b3aca0de4c920bcaec40b083d7b` and supplied historical skills-check RED/GREEN evidence. They produced reports about an already-fixed defect; neither reran product tests nor drove a live provider. This measures comprehension of supplied evidence, not fresh defect discovery. The prompts also directed evidence discipline, and their evidence subsets and method entries differ. There is no controlled head-to-head comparison or no-material control.

| Host | Actual observation | Limit or correction |
| --- | --- | --- |
| Codex CLI 0.160.1 | One call, exit 0, five shell **tool invocations**, all observed commands read-only; the last invocation ran multiple utilities. Identified discarded failure entries and correctly explained why exit 0→1 fixes the CLI while the ref remains missing | Default model not overridden; resolved model not attested. Reading 2,335 build bindings produced 198,949 input tokens including 163,072 cached tokens. C5 is bounded, C7 has a scope limit; this is not an efficiency success |
| Claude CLI, actual modelUsage `claude-sonnet-5-5` | One call, exit 0, 28 Read calls and one Glob; identified the bug and proposed failure/drift/healthy exit criteria | Incorrectly called the supplied but unread **input inventory** `input-manifest.json` missing. It also overstated two recorded source hashes as proof that only one file changed across the entire run |

Codex's “actual manifests” limitation refers to the **fixture's `skills.config.yaml` files**, absent from its supplied inputs. Its separate `input-manifest.json` inventory was supplied but unread. Thus the fixture-content gap is valid, while independent provenance verification through the supplied inventory remains undone. Claude's inventory was also supplied but unread; its absence claim is incorrect. Raw responses and evaluations are preserved unchanged, with these distinctions recorded here.

## Binding and observed boundaries

The authoring team froze expectations and evaluated its own experiments; neither host nor evaluator is an authenticated independent oracle. For Codex, `expectations.freeze.json` records `2026-10-28T07:18:14.991370Z`; `result.json` binds SHA-256 `46e0b3d75b392242dcf2ed77462c0f733b30e5eb1661f80e681940c5f857ad54` and invocation start `07:18:15.073569Z`. Claude's evaluation binds its own frozen expectations hash. These are recorded ordering and integrity evidence, not trusted external timestamp attestations.

Codex's recorded argv includes `--sandbox read-only`; its five observed tool invocations only inspected input files. Its stderr nevertheless contains CLI rollout state database discrepancy / `falling_back` warnings. The sandbox setting and observed commands do not prove that the CLI's internal state was untouched. Claude was restricted to Glob/Grep/Read and actually used Glob/Read. Neither record is a whole-process side-effect audit.

| Axis | Codex | Claude |
| --- | --- | --- |
| Execution | Ran once, CLI exit 0 | Ran once, CLI exit 0 |
| Behavior | Report met diagnosis criteria; provenance criterion bounded | Report met diagnosis criteria; two factual overclaims retained and corrected above |
| Harness | Completed with internal state warnings; no whole-harness health claim | No recorded tool errors; no whole-harness health claim |
| Cleanup | Invoked CLI process exit observed; scratch retained intentionally; descendants/internal state not audited | Invoked CLI process exit observed; scratch retained intentionally; descendants/internal state not audited |
| Coverage | One investigation entry over historical evidence | Investigation plus bug-fix entries over historical evidence |

Both consumed the **pre-change** evidence guidance, copied into inputs rather than invoked through the documented checkout request template. Neither tested the new reading-status guidance. No automatic discovery, installation, implementation journey, provider equivalence, MethodBinding, runtime activation or formal J gate pass is established.

## Preserved evidence and redaction

[The archive](evidence.tar.gz) and [publication manifest](evidence-manifest.json) are tracked deliverables. They contain prompts, input copies/manifests, tool transcripts, CLI versions, frozen expectations and explicit evaluations. Only the local Hermes executable-directory token in `claude/response.stream.jsonl` and `claude/inputs/evidence/{red,green}.json` was redacted for publication. This removes a local PATH detail, not the reported command, exit, source hash or behavior. Historical inner hashes bind originals, so they must not be treated as hashes of those three redacted files; the outer publication manifest binds published bytes. Originals remain in external scratch. Codex archive files are byte-unchanged, including the outputs whose hashes its transcript checked.

## Changes and next step

The common instructions now require index/manifest/summary-first reading, targeted fields with original file pointers/hashes, and explicit not-provided / supplied-but-unread / read-but-unverified / verified-for-a-predicate status. A projection does not verify omitted data. These changes have not yet been tested in another host call; no causal improvement is claimed.

The next experiment is **only a queued outline, not an executable or validated specification**. A future dispatch would first freeze its exact inputs, common prompt/action scope, isolation and scoring. To test this wording change, possible controls are old/new guidance and genuinely absent versus supplied-but-unread artifacts; a no-material control would also be needed for claims about the method itself. Model identity, repetitions and token budgets would need explicit decisions before any comparative claim. No such run or benchmark is scheduled by this document.
