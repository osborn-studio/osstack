# Benchmark — OSStack Skill Auto-Publish

- **Status:** Benchmark spec (paired with the [design](2026-07-01-skill-autopublish-design.md))
- **Date:** 2026-07-01
- **Purpose:** define measurable success — what "done and good" means, the metrics, the scenarios that
  produce them, the thresholds to pass, and how to measure. Acceptance references these thresholds.

## 1. What we measure and why

The feature's value = **a verified skill becomes live on the Hub, automatically, correctly, and
observably** — without ever publishing a skill that should have been blocked. So we optimize for
**correctness first** (never false-publish, never false-block), then **latency**, then **reliability**.

## 2. Metrics

| # | Metric | Definition | Target (must-hit) | Stretch |
|---|---|---|---|---|
| M1 | **False-publish rate** | fraction of below-gate/invalid skills that got deployed | **0%** (hard) | 0% |
| M2 | **False-block rate** | fraction of gate-clearing skills wrongly `blocked` | **0%** (hard) | 0% |
| M3 | **Publish success rate** | `published` ÷ (eligible verify-green skill tasks) | **≥ 99%** | 100% |
| M4 | **Verify→live latency** | wall-clock from `Verdict.pass` to `apiVerified:true` | **≤ 120 s** (p95) | ≤ 75 s |
| M5 | **Promote-gate latency** | promote (validate+score+catalog+commit) alone | ≤ 15 s (p95) | ≤ 8 s |
| M6 | **API-verify propagation** | deploy done → API returns new version | ≤ 60 s (p95) | ≤ 20 s |
| M7 | **Idempotency** | re-publishing an unchanged skill mutates nothing new | commit=noop, exit 0 | — |
| M8 | **Concurrency safety** | two publishes racing → serialized, no catalog corruption | 100% | — |
| M9 | **Recoverability** | after a deploy failure, a re-run reaches `published` | 100% | — |
| M10 | **Observability completeness** | every run emits event + decision + (if card) comment | 100% | — |
| M11 | **Overhead when disabled/non-skill** | added latency to a normal loop task | ≤ 5 ms | ~0 |

Hard metrics (M1, M2) are release-blocking: any single false-publish or false-block fails the benchmark.

## 3. Benchmark scenarios

Each scenario has a fixture, an action, and pass criteria. Scenarios B1–B4 are deterministic (mocked
deploy/API) and run in CI; B5–B7 are live (throwaway skill) and run on demand.

| ID | Scenario | Fixture | Pass criteria |
|---|---|---|---|
| **B1** | Happy path | valid skill, score ≥ team | `status:"published"`, `deployed:["api","vercel"]`, `apiVerified:true`, exit 0, event `loop.skill.published`, M4 ≤ 120s |
| **B2** | Gate block (low score) | skill scoring < gate | `status:"blocked"`, **no deploy**, `reasons` includes score, exit 2, event `loop.skill.publish_blocked`, task not-published (M1=0) |
| **B3** | Gate block (TODO_FILL) | scaffolded, unfilled | `status:"blocked"`, reasons list TODO files, no deploy, exit 2 |
| **B4** | Non-skill / disabled | ordinary `code.fix` task, or `publish.enabled=false` | hook no-op, no publish command spawned, M11 ≤ 5ms |
| **B5** | Idempotent re-publish (live) | already-published skill, unchanged | commit = "nothing to commit", still `published`, `apiVerified:true`, no new git sha (M7) |
| **B6** | Deploy failure + recovery (live) | inject a deploy error, then re-run | first run `status:"error"` (commit stands), re-run `published` (M9) |
| **B7** | Concurrency (live) | fire two publishes ~simultaneously | one runs, the other `busy` then succeeds on retry; catalog valid; both end `published` (M8) |
| **B8** | Edge-propagation lag (live) | deploy then immediate verify | poll succeeds within timeout, or `apiVerified:false` flagged (never a false `published` claim) |

## 4. Measurement method

- **Deterministic (B1–B4):** the TDD unit/integration suites double as the benchmark harness — the hub
  command is invoked with mocked `promote`/`deploy`/`fetch`; assertions capture status, `deployed`,
  `durationMs`, exit code, and emitted events. M1/M2/M5/M11 are computed here.
- **Live (B5–B8):** an e2e script `scripts/bench/skill-autopublish-e2e.mjs` scaffolds a throwaway skill
  (`bench.autopublish-probe`), drives one OSStack loop cycle to verify-green, lets the hook publish,
  then `GET`s `api.osbornhub.com/api/skills/bench.autopublish-probe` to confirm, records M3/M4/M6/M8/M9,
  and **cleans up** (removes the skill dir, rebuilds catalog, redeploys). Timestamps: `Verdict.pass` ts
  (from LOOP-STATE) → command `durationMs` → API-200 ts.
- **Reporting:** each run appends a JSONL row `{scenario, metric, value, pass}` to
  `docs/design/bench-results/skill-autopublish-<date>.jsonl`; a summary table is printed. p95 over ≥ 10
  runs for latency metrics.

## 5. Baseline (what we're improving on)

- **Today (manual):** `promote.mjs --deploy-api` + hand-run `vercel deploy` + eyeball the API ≈ **2–4
  min of human attention** per skill, and no enforced API-verify (skills sometimes "promoted" but never
  confirmed live). Baseline false-publish risk is human (forgetting the gate). The feature must reduce
  human attention to **0** while making M1/M2 provably 0 via the gate.

## 6. Pass/fail for acceptance

The benchmark **passes** iff: M1 = 0 and M2 = 0 (hard), M3 ≥ 99%, M4 p95 ≤ 120s, M7/M8/M9/M10 = 100%,
M11 ≤ 5ms — measured over the B1–B4 CI suite plus one clean B5–B8 live pass. Any hard-metric violation
is release-blocking regardless of the others.
