# Recursive Control Plane

The recursive control plane upgrades osstack from a single-workspace loop runner
into a repo-supervising system that records feedback and proposes changes to
its inputs (evals, tests, prompts, skills, docs, policies). Candidate implementation
and independently verified effectiveness are not provided by `improve apply`.
The current foundation is delivered by the `@osstack/supervisor` package plus additive
persistence in `@osstack/core` and CLI surfaces in `@osstack/cli`.

Everything here is **opt-in**. Existing CLI behavior is unchanged, read-only
reporting is always safe to run, and nothing that mutates a repo or promotes an
evaluator happens without an explicit `--yes` and the required gates.

## Safety Boundaries (non-negotiable)

These constraints are enforced by design and must never be relaxed:

- No model-weight recursive self-improvement. The loop improves its *inputs*
  (evals/tests/prompts/skills/docs/policies), never model weights.
- No auto-editing arbitrary user repos in tests; unit tests never depend on real
  repo paths and make no network calls.
- No destructive git commands; no auto-apply of medium- or high-risk changes.
- `osstack improve apply` defaults to **dry-run** unless `--yes` is passed.
  `--yes` runs current-repository gates only; it never implements a candidate
  or records a new `applied` status.
- Deterministic verification commands are first-class gates. LLM judges are
  allowed only as versioned evaluator artifacts.
- AI-generated/modified evaluators cannot become active without anchor-case
  evaluation. Evaluators are **frozen during an epoch** and promoted only at
  epoch boundaries.
- Every feedback asset preserves its `source_trace_id` provenance.

## The L0–L6 Closed-Loop Maturity Ladder

`osstack supervise scan` scores each registered repo on a contiguous ladder
(a level requires all lower levels):

| Level | Meaning |
| ----- | ------- |
| L0 | Registered in the repo registry. |
| L1 | Has a README / declared purpose. |
| L2 | Declares a deterministic verify command (`docs/LOOP.md` verification). |
| L3 | Has a Closed Loop Contract (`docs/LOOP.md`). |
| L4 | Produces feedback assets from failed runs. |
| L5 | Raises risk-rated improvement proposals from those assets. |
| L6 | Runs evaluator epochs with anchor cases (Red Queen control). |

The ladder is a *diagnosis*, not an actuator: it tells you what a repo is
missing to close its loop, not what to change automatically.

## The Self-Improvement Chain

A completed loop task flows through a deterministic, LLM-free chain:

```
CompletedTask -> RunTrace -> FeedbackAsset[] -> ImprovementProposal[] -> Gate
```

1. **RunTrace** — `traceFromCompletedTask` normalizes a task into the control
   plane's canonical record. Deterministic: the same task always yields the same
   `trace_id`.
2. **FeedbackAsset[]** — `assetizeFailure` classifies a failed run into a failure
   family and emits reusable assets (eval cases, test gaps, pitfall lessons,
   knowledge memories, runbook notes, prompt/skill gaps, governance rules). A
   passing run produces none. Every asset keeps its `source_trace_id`.
3. **ImprovementProposal[]** — `proposeImprovement` maps each asset to a change
   target and risk: eval/test/docs = **low**, prompt/skill = **medium**,
   policy = **high**. A proposal only *describes* an intended change plus the
   gates that must pass first; it never applies anything.
4. **Gate** — `decideProposalGate` decides `auto_applicable` (low-risk with
   passing gates), `needs_human` (medium/high, or low with no gate), or
   `blocked` (failing gate or missing runner).

`auto_applicable` is the gate helper's advisory result. The CLI reports it as
`gates_passed` with `applied: false` and `implementation_status: not_implemented`;
it is not candidate eligibility or evidence of an actual patch. Historical
`applied` rows remain unchanged and do not establish implementation or verification.

New feedback proposals use `prop_v2_<sha256>` identities bound to their source,
evidence, and proposed content. Identical retries preserve reviewed status and
timestamps; changed definitions produce distinct proposals. Legacy draft producers
can append recurring evidence, while reviewed definitions remain protected.

## Evaluator Epochs (Red Queen control)

Evaluators (including LLM judges) are versioned artifacts, not free-floating
code:

- **Epochs freeze evaluators.** An evaluator version is immutable inside its
  epoch, so scores within an epoch are comparable.
- **Anchor cases are ground truth.** Human-reviewed cases keep evaluators
  honest. `evaluator promote` **hard-blocks with no anchor cases**.
- **Promotion happens only at epoch boundaries** and only when a challenger
  beats the incumbent on anchor accuracy by the minimum delta. On promotion the
  challenger is frozen, the incumbent retired, and the displaced incumbent's
  scores are **quarantined**.
- **Adversarial cases** — where an evaluator disagreed with a human verdict —
  feed the next anchor set.

`evaluator challenge` is advisory (read-only); `evaluator promote` is dry-run by
default and requires `--yes`.

The current CLI accepts caller-supplied accuracy counts. These records cannot
authorize future autonomous promotion without binding actual evaluation artifacts,
candidate versions, and independently controlled tests.

## The Self-Improvement Hook (loop integration)

`@osstack/loop` exposes an **opt-in, injected** self-improvement hook. When
enabled, each finalized `CompletedTask` is handed to a caller-provided
`assetize` callback that runs the chain above and folds the result back onto the
task (`trace_id`, `feedback_asset_ids`, `proposal_ids`, `assetization_summary`,
`self_improvement_level`).

Key properties:

- **Dependency inversion.** `@osstack/loop` never imports `@osstack/supervisor`
  or touches SQLite; the injected callback owns assetization and persistence.
- **Never fails a task.** Any callback error is swallowed and surfaced as a
  `loop.self_improvement.failed` event; success emits
  `loop.self_improvement.done`.
- **Byte-identical when disabled.** With no `selfImprovement` config the loop
  behaves exactly as before.

## CLI Surface

All commands are additive. Read-only commands (`scan`, `report`, `feedback
assets`, `evaluator list/challenge`, `meta eval`) are always safe.

```bash
# Register + diagnose a portfolio of repos (read-only)
osstack supervise register <path> --role business_product --priority 90 --verify "pnpm test"
osstack supervise scan --json                 # L0-L6 ladder per repo
osstack supervise report --json               # portfolio health
osstack supervise init-loop-doc --repo <id>   # write docs/LOOP.md (no overwrite)

# Feedback assets distilled from failed runs (read-only listing)
osstack feedback assets --repo <id> --json

# Improvement proposals (dry-run by default; --yes runs gates)
osstack improve propose --repo <id> --json
osstack improve apply --proposal <id>         # DRY RUN — changes nothing
osstack improve apply --proposal <id> --yes   # check gates only; no implementation

# Evaluator epochs / Red Queen (advisory + gated promotion)
osstack evaluator list --repo <id> --json
osstack evaluator challenge --repo <id> --incumbent A --challenger B ...   # advisory
osstack evaluator promote  --repo <id> ... --yes   # blocked without anchor cases

# Advisory meta view + adversarial pool
osstack meta eval --repo <id> --json
osstack adversarial ...

# Loop self-improvement (opt-in, local-only)
osstack loop run --workspace . --self-improvement --repo-id <id> --verify "pnpm test"
osstack loop run --workspace . --self-improvement --repo-id <id> --propose-improvements
```

`--self-improvement` records traces/feedback assets (and, with
`--propose-improvements`, draft proposals) from each completed task into the
local control-plane state DB. It requires `--repo-id`, is **local-only**
(rejects `--daemon`), and never fails a task.

## Persistence

`@osstack/core` migration 6 adds six additive, forward-only tables:
`feedback_assets`, `improvement_proposals`, `evaluator_versions`,
`evaluator_epochs`, `anchor_cases`, and `score_quarantine`. No existing table is
altered. All writes go through repository helpers that upsert by id and preserve
`created_at`.

Migration 23 adds explicit pitfall observation provenance. `observation_count`
counts distinct source IDs explicitly recorded after this migration. The current
CLI derives observations from failed/escalated tasks and uses `loop_id` as their
`source_run_id`, so multiple observations of one lesson within a loop count once. Old
`verified_count` values are frozen and exposed as `legacy_verified_count` for
compatibility; neither counter measures effectiveness. Old source histories are
preserved without inferring whether a lesson was used. A later successful task
no longer increments lesson verification merely because it shares a technology stack.

## What This Is Not

- Not autonomous self-modification: medium/high-risk changes always need a human.
- Not a replacement for the existing loop, evidence, governance, or knowledge
  layers — it sits alongside them and consumes their outputs.
- Not a model trainer: it curates the *inputs* to agents and evaluators, never
  their weights.

See also: [12_RUNBOOK.md](12_RUNBOOK.md), [13_DECISIONS.md](13_DECISIONS.md),
and the loop-engineering CLI reference in
`loop-engineering/references/cli-options.md`.
