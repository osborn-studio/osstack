# Design — OSStack Skill Auto-Publish to OSBORN Studio Skill Hub

- **Status:** Design v1.1 — amended 2026-07-03 for the completed data/code decoupling (deploys are now GitHub-Actions-exclusive via the `osborn-skill-catalog` data repo; local deploys are refused). Approved anchors unchanged.
- **Date:** 2026-07-01
- **Owner:** Osborn
- **Related:** `osborn-studio-skill-hub/tooling/promote.mjs`, `packages/loop/*`, `api.osbornhub.com`
- **Companion docs:** [benchmark](2026-07-01-skill-autopublish-benchmark.md) · [TDD](2026-07-01-skill-autopublish-tdd.md)

## 1. Problem & goal

OSStack is the "监工" that drives a skill from design → dev → test → **verify** → deploy → launch.
Today, promoting a finished skill into the **OSBORN Studio Skill Hub** is a manual step
(`node tooling/promote.mjs <id> --deploy-api`). Goal: **when a skill's dev passes verification in an
OSStack loop, automatically publish it to the Hub and confirm it is live** — no human step.

## 2. Decided anchors (locked)

| Decision | Choice | Why |
|---|---|---|
| Integration transport | **Local pipeline + API verify** | The osbornhub.com API is a read-only edge function (baked catalog, no DB, no write path). The Hub is GitOps/file-based. OSStack and the Hub repo are on the same machine, so OSStack runs the local `promote`+deploy and uses the API only to *confirm* the skill went live. |
| Trigger | **verify-green → auto-publish** | Publish is the **finalizer** stage after `Verdict.pass`. It never gates dev iteration. |
| Source location | **In-hub** | Skills are developed in `osborn-studio-skill-hub/skills/<domain>/<name>/`; publish = in-place promote (no import). |
| Hook shape | **Post-verify publish hook** (Approach A) | Cleanly separates *verify* (dev pass/fail) from *publish* (integration). Alternatives rejected: publish-as-verifier (conflates the two), standalone watcher (extra always-on moving part). |

## 3. Architecture

Two components, decoupled by **one JSON contract**. OSStack never imports Hub code — it shells out to a
command whose path is configured, and depends only on that command's JSON output.

```
┌─────────────────────────── OSStack (packages/loop) ───────────────────────────┐
│  Discover → Plan → Execute → Verify ──(Verdict.pass && isSkillTask)──┐          │
│                                                                       ▼          │
│                                                          publisher.ts (Hook B)   │
│                                                          run publishCommand(id)  │
│                                                          parse JSON → record     │
└───────────────────────────────────────────────────────────┬───────────────────┘
                                          exec (local, same machine) │  JSON contract
                                                                     ▼
┌───────────────── osborn-studio-skill-hub (tooling/osstack_publish.mjs — Cmd A) ─┐
│  lock → promote(gate) → push data repo(→GHA deploys) → API-verify(GET api.osbornhub.com) →  │
│  emit JSON {status, id, score, gate, pushed, apiVerified, url, …}             │
└─────────────────────────────────────────────────────────────────────────────── ┘
```

### 3.1 Component A — Hub publish command

`osborn-studio-skill-hub/tooling/osstack_publish.mjs <skill-id> [flags]` — the single, idempotent
"publish a skill to osbornhub" command. Zero deps (Node ESM), reuses existing tooling.

Flags: `--gate team|client|commercial` (default `team`), `--no-push` (promote only),
`--dry-run` (alias of `--no-push`), `--json` (default on). (v1.0 的 `--surfaces` 已废弃 — 部署面由数据仓库 CI 统一持有。)

Steps:
1. **Resolve** `<skill-id>` in the hub. Not found → `status:"error", reason:"not_found"`, exit 1.
2. **Lock** `.publish.lock` (advisory, single-writer). Held → `status:"busy"`, exit 1 (caller retries).
3. **Promote** (reuse `promote.mjs`): todo-guard → validate → score → gate → catalog → `git commit`.
   - promote exit **2** ⇒ `status:"blocked"` with parsed `reasons[]` (score<gate / TODO_FILL / invalid).
     **No deploy.** exit 2.
   - promote exit **0** (committed or nothing-to-commit) ⇒ continue.
4. **Push the data repo** (skipped on `--dry-run` / `--no-push`): promote has committed the skill
   into `CATALOG_ROOT` (the `osborn-skill-catalog` repo); `git push` there triggers the repo's
   GitHub Actions pipeline (merge → 双层护栏 → build → deploy → baseline ratchet), which is the
   **sole deploy owner**. The publish command never deploys locally (that path is hard-refused).
5. **API-verify**: poll `GET https://api.osbornhub.com/api/skills/<id>` with `Authorization: Bearer
   <key>` (key from `$SKILL_HUB_KEY`, else `~/.osborn/secrets/skill_hub_key`) until HTTP 200 **and**
   returned `version` == the skill's manifest version, timeout `apiVerifyTimeoutMs` (default 420000 —
   the GHA pipeline takes ~2–4 min). Miss → `apiVerified:false` (pushed work is still safe; CI will
   land it, re-run re-verifies).
6. **Release lock**, print JSON, exit `0` published / `2` blocked / `1` error|busy.

**JSON contract** (the seam — versioned as `contract:"1.0"`):
```jsonc
{ "contract":"1.1", "status":"published"|"blocked"|"error"|"busy",
  "id":"signals.group-effect-ledger", "score":100, "gate":"team",
  "committed":true, "pushed":true, "pipeline":"github-actions", "apiVerified":true,
  "apiVersion":"0.1.0", "url":"https://api.osbornhub.com/api/skills/…",
  "durationMs":48213, "reasons":[], "message":"published" }
```

**Env** (never in code, never logged): `SKILL_HUB_KEY`, `HUB_PASSWORD` (store/vercel), `VERCEL` token.

### 3.2 Component B — OSStack post-verify publish hook

New module `packages/loop/src/publisher.ts` + a call site in `loop-engine.ts` on the per-task
verify-pass path (where `Verdict.pass === true` and the goal is met).

- **isSkillTask(task):** true when `task.capability` matches `skill.publish` **or**
  `task.context.publish?.skillId` is present. `skillId` is resolved from `context.publish.skillId`.
- **Action:** `runPublish(skillId, cfg)` → spawn `cfg.command` (default: the hub's
  `osstack_publish.mjs` path) with `<skillId> --gate <cfg.gate> --json` (+`--no-push` when cfg.push=false);
  parse stdout as the JSON contract (validate with a zod schema; malformed → treated as error).
- **Record (non-gating):**
  - `published` → emit `loop.skill.published`, append decision, kanban comment "✅ published to Hub
    (score N, gate G, apiVerified)".
  - `blocked`/`error`/`busy` → emit `loop.skill.publish_blocked`, append decision, kanban comment with
    `reasons[]`. The task stays **verified-but-not-published**; `onFailure:"block"` keeps the loop task
    open (so the next iteration can fix + re-verify), `onFailure:"warn"` just records.
- **Publish never changes `Verdict`** — verify remains the dev gate; publish is a side-effecting
  finalizer whose outcome is observable but does not fail the loop by default.

## 4. Config

Loop config gains an optional `publish` block (zod-validated in `@osstack/config`):
```ts
publish?: {
  enabled: boolean;                 // default false (opt-in)
  command: string;                  // default: "<HUB>/tooling/osstack_publish.mjs" (resolved abs path)
  gate: "team"|"client"|"commercial"; // default "team"
  push: boolean;                    // default true（false = promote-only，不触发 CI 部署）
  onFailure: "block"|"warn";        // default "block"
  apiVerifyTimeoutMs: number;       // default 420000（GHA 流水线 ~2–4 分钟）
}
```
Precedence: task `context.publish` overrides > loop config > defaults. Disabled or non-skill task ⇒ hook
is a no-op.

## 5. Data flow (happy path)

develop skill (in hub) → loop `Execute` → `Verify` returns `Verdict.pass=true` → **publisher hook** →
`osstack_publish <id> --gate team` → promote(gate ok) → push data repo → GHA(merge→护栏→build→deploy) →
API-verify 200 → JSON `status:"published"` → emit `loop.skill.published` + kanban comment + decision →
loop task done.

## 6. Failure handling

| Failure | Detected by | Result |
|---|---|---|
| Gate not cleared (score<gate / TODO_FILL / invalid) | promote exit 2 | `blocked`, **no deploy**, reasons surfaced, task not-published |
| Deploy error (EdgeOne/Vercel) | non-zero deploy exit | `error`, commit already local (re-run republishes), surfaced |
| API-verify timeout (edge lag) | poll timeout | `apiVerified:false` but `status:"published"` if deploy ok — flagged, recommend re-check |
| Concurrent publish | `.publish.lock` held | `busy`, caller (loop) retries after backoff |
| Malformed JSON from command | zod parse fail | `error` on the OSStack side, raw stderr captured |

## 7. Security

- Secrets (`SKILL_HUB_KEY`, `HUB_PASSWORD`, `VERCEL`) only via env; never printed, never in the JSON.
- The command runs **locally** on the same host as the Hub repo (git + deploy creds already present).
- Advisory lock serializes git commits + deploys (no interleaved catalog corruption).
- The read-only osbornhub.com API is used **only for verification** (GET), consistent with its
  fail-closed Bearer gate.

## 8. Observability

- Loop events: `loop.skill.published`, `loop.skill.publish_blocked` (subscribable via Hermes/kanban).
- `LOOP-STATE.json` `decisions[]` gain a publish line per task.
- Kanban comment on the linked card (if any) with score/gate/apiVerified or the block reasons.
- The command's JSON is the audit record (durationMs, deployed surfaces, apiVersion).

## 9. Out of scope (YAGNI)

- **No** remote HTTP write/ingest endpoint on osbornhub.com (would require a persistent backing store;
  rejected — Hub is GitOps and OSStack is co-located). Revisit only if OSStack must publish from a
  different machine.
- **No** database, no multi-tenant, no auto-retry loop (surface + next-iteration/manual), no rollback
  (promote is additive; a bad skill is a new commit reversible via git).
- Store surface is optional (default off from the two-surface default) to keep publish fast.

## 10. Open questions

1. Kanban linkage: does the loop task already carry the card id (`context.card_id`), or does publisher
   look it up? (Assumed `context.card_id` when present; otherwise skip the comment.)
2. `command` path resolution across machines/CI — absolute path in config vs a `HUB_ROOT` env. (Default:
   config abs path; fall back to `$HUB_ROOT/tooling/osstack_publish.mjs`.)

## 11. Testing & acceptance

See the [TDD doc](2026-07-01-skill-autopublish-tdd.md) for the red-first test plan and the
[benchmark doc](2026-07-01-skill-autopublish-benchmark.md) for success metrics/thresholds. Acceptance =
all TDD suites green + the benchmark's "must-hit" thresholds met on the e2e throwaway-skill scenario.
