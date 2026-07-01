# TDD Plan — OSStack Skill Auto-Publish

- **Status:** TDD plan (paired with the [design](2026-07-01-skill-autopublish-design.md) & [benchmark](2026-07-01-skill-autopublish-benchmark.md))
- **Date:** 2026-07-01
- **Principle:** write the failing test first, implement the minimum to pass, refactor. No production
  line lands without a red test that it turns green.

## 1. Strategy & runners

| Layer | Component | Runner | Style |
|---|---|---|---|
| Unit | Hub `tooling/osstack_publish.mjs` | **`node:test`** (zero-dep, matches Hub's no-deps rule) | pure functions + injected side-effects |
| Unit | OSStack `packages/loop/src/publisher.ts` | **vitest** (existing loop convention, `*.test.ts`) | injected command-runner |
| Integration | hook ↔ command | vitest | hook drives a **fake command** honoring the JSON contract |
| Contract | JSON seam | both runners | one shared schema; both sides assert against it |
| E2E | live throwaway skill | node script (`node:test` optional) | real promote + deploy + API, then cleanup |

**Testability by design (do this first):** make side-effects **injectable** so unit tests need no
network/git/deploy.
- Hub command exports a pure `publish(id, cfg, io)` where `io = { promote, deploy, verifyApi, now,
  lock }` — the CLI wraps it with the real `io`; tests pass fakes.
- OSStack `publisher.ts` exports `runPublish(skillId, cfg, { runCommand })` — `runCommand` is the only
  seam to the outside; tests inject a fake returning canned JSON/exit codes.

## 2. The JSON contract (shared, tested on both sides)

Define once (design §3.1). A single `PublishResult` zod schema lives in OSStack (`publisher.ts`); the
Hub command emits JSON matching it. **Contract test C0** (both repos): a fixture set of canonical JSON
blobs (`published`, `blocked`, `error`, `busy`) must (a) parse under the OSStack schema and (b) be
emittable by the command's serializer. If the shape drifts, C0 goes red before anything else breaks.

## 3. Hub command — `osstack_publish.mjs` (unit, `node:test`)

Red-first list (each is a failing test before the step exists):

| ID | Test | Arrange | Assert |
|---|---|---|---|
| A1 | happy path publishes | `io.promote→0`, `io.deploy→ok`, `io.verifyApi→{200,ver match}` | result `status:"published"`, `deployed:["api","vercel"]`, `apiVerified:true`, exit 0 |
| A2 | gate block ⇒ no deploy | `io.promote→2` (reasons) | `status:"blocked"`, `io.deploy` **not called**, `reasons` non-empty, exit 2 |
| A3 | TODO_FILL block | promote→2 with todo reasons | reasons list the files; no deploy |
| A4 | not found | id not in hub | `status:"error", reason:"not_found"`, exit 1 |
| A5 | deploy failure | promote→0, `io.deploy` throws on `vercel` | `status:"error"`, `deployed` lists only what succeeded, exit 1 |
| A6 | api-verify timeout | deploy ok, `io.verifyApi` never 200 within timeout | `apiVerified:false`, `status:"published"` (deploy ok) — never claims verified falsely (M8/B8) |
| A7 | api version mismatch | verifyApi returns 200 but old version | keeps polling; on timeout `apiVerified:false` |
| A8 | lock busy | `io.lock` already held | `status:"busy"`, promote **not** run, exit 1 |
| A9 | idempotent | promote→0 "nothing to commit" | `committed:false`, still `published` (M7) |
| A10 | `--dry-run` | any | promote runs; `io.deploy`/`io.verifyApi` **not** called; `deployed:[]` |
| A11 | `--surfaces` respected | `--surfaces api` | deploy called with `["api"]` only |
| A12 | secrets never in output | inject env | serialized JSON + logs contain no `SKILL_HUB_KEY`/`HUB_PASSWORD` substring |
| A13 | exit-code mapping | table-driven over statuses | published→0, blocked→2, error/busy→1 |

Integration A-INT (real `promote.mjs`, mocked deploy/api): scaffold a temp skill in a temp hub clone;
assert a valid one reaches the deploy step and an unfilled one is `blocked` — proves the promote wiring
(not just the fake).

## 4. OSStack hook — `publisher.ts` (unit, vitest)

| ID | Test | Arrange | Assert |
|---|---|---|---|
| P1 | fires on skill task + pass | `Verdict.pass=true`, `capability:"skill.publish"`, cfg.enabled | `runCommand` called with `<id> --gate team --surfaces api,vercel --json` |
| P2 | skillId from context | `context.publish.skillId` | that id is used |
| P3 | non-skill task ⇒ no-op | `capability:"code.fix"` | `runCommand` **not** called (M11) |
| P4 | disabled ⇒ no-op | `cfg.enabled=false` | `runCommand` not called |
| P5 | verify-fail ⇒ no publish | `Verdict.pass=false` | `runCommand` not called (publish only after green) |
| P6 | published → records | fake `runCommand→published JSON` | emits `loop.skill.published`, adds decision, (if card) posts comment |
| P7 | blocked → surfaces, non-gating | fake→`blocked` | emits `loop.skill.publish_blocked`, task **not** marked published, Verdict unchanged, decision has reasons |
| P8 | onFailure="block" keeps task open | blocked + `onFailure:block` | task stays iterable/open (not completed-published) |
| P9 | onFailure="warn" | blocked + `onFailure:warn` | recorded only, loop continues |
| P10 | busy → retry | fake→`busy` once then `published` | retried with backoff, ends published |
| P11 | malformed JSON → error | fake→garbage stdout | zod parse fails → `error` recorded, raw stderr captured, no crash |
| P12 | precedence | task `context.publish.gate` vs cfg | task value wins |

Engine integration P-INT (vitest, in `loop-engine.test.ts` style): a stub loop cycle where a skill task
verifies green calls the publisher exactly once with the resolved id; a failing verify never does.

## 5. Red → green → refactor order

1. **C0** contract fixtures (red) → define `PublishResult` schema (green).
2. **A1–A13** hub command units (red) → implement `publish(id,cfg,io)` + serializer + CLI wrapper.
3. **A-INT** with real promote (red) → wire `io.promote` to `promote.mjs`, `io.deploy` to build/deploy.
4. **P1–P12** hook units (red) → implement `publisher.ts` with injected `runCommand`.
5. **P-INT** engine wiring (red) → call `publisher` at the verify-pass site in `loop-engine.ts` behind
   the `publish` config; add `loop.skill.published`/`_blocked` events.
6. Refactor: dedup promote-reason parsing, extract poll/backoff util, tighten types. Keep all green.

## 6. Fixtures & mocks

- **Hub:** `tests/fixtures/skills/valid/` (score ≥ team), `.../unfilled/` (TODO_FILL),
  `.../lowscore/`. `io` fakes are plain objects; `now` injected for deterministic `durationMs`;
  `verifyApi` fake models "N polls then 200".
- **OSStack:** canned `PublishResult` JSON fixtures; `runCommand` fake = `(argv)=>({stdout,exitCode})`;
  event bus spy; kanban-comment spy.
- No test touches the network, real git, EdgeOne, or Vercel except the opt-in E2E.

## 7. E2E (live, opt-in — mirrors benchmark B5–B8)

`scripts/bench/skill-autopublish-e2e.mjs`: scaffold `bench.autopublish-probe` → one loop cycle to
verify-green → hook publishes → `GET api.osbornhub.com/api/skills/bench.autopublish-probe` asserts 200 +
version → assert idempotent re-run → **cleanup** (rm skill, rebuild catalog, redeploy). Gated behind
`RUN_LIVE_E2E=1` + `SKILL_HUB_KEY` present; never in default CI.

## 8. Coverage & CI

- Targets: hub command **≥ 90%** line/branch (it's the risk surface); `publisher.ts` **≥ 90%**;
  the loop-engine call site covered by P-INT.
- CI: `node --test tooling/*.test.mjs` (hub) + `vitest run packages/loop` (osstack) on every PR. The
  hard benchmark metrics **M1 (false-publish) and M2 (false-block) are encoded as A2/A3/A5 and
  P5/P7** — if any regress, CI is red. Live E2E runs nightly/on-demand, not on PR.

## 9. Definition of done

All of §3–§4 suites green, C0 passing in both repos, coverage targets met, one clean live E2E, and the
benchmark's hard metrics (M1=M2=0) proven by the A2/A3/A5/P5/P7 tests. Then → `writing-plans` for the
implementation sequence.
