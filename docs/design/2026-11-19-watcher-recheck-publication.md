# U4b B8: Watcher recheck publication

Date: 2026-11-19. Status: proposed, waiting for the owner's decisions in §8. Design only: no code, test, migration, GitHub write or App setting is part of this change.

Baseline: `origin/main` at `0546cc36`. Every `file:line` below refers to that commit. Three pieces of related work are not on main and were not read as code: B7c (merge interlock, PR #482), D2 (run journal, migration 63) and D4 (collector). Statements about them come from their hand-over notes and are marked **[note]**.

Parent contracts: [verify-failure intake](2026-11-16-verify-failure-intake.md) ("the intake design") and [host recheck run](2026-11-19-host-recheck-run.md) ("the B7d design"). This document changes neither. Where they already answer a point, they are quoted.

## 0. The gap

The recheck ledger passes a row only with three inputs: a new accepted verification result on the repaired head, a green latest Actions attempt, and a host recheck proof (`packages/core/src/bridge/recheck.ts:88-147`). The B7d design produces the third. The first is the Watcher's own result, by decision 8 of the B7d design ("Reading A for input (a): the Watcher's new result, never the host run").

Nothing defines how that result comes to exist. The B7d design says so: "How the Watcher learns that it must verify the new head, and when. That belongs to B8, which is not built. Until then input (a) cannot arrive in production and `recheck_passed` stays unreachable even with B7d complete" (`docs/design/2026-11-19-host-recheck-run.md:259`).

B8 defines the producing side: what triggers the cloud verification of the repaired head, which identity writes the result, how the host proves that identity, and what the result must contain for the merged reader, source ledger and recheck classifier to accept it.

## 1. What exists today

### 1.1 The reading side exists as libraries without a caller

| Fact | Evidence |
|---|---|
| The strict result contract and its parser exist. | `packages/core/src/bridge/verification-result.ts:38-56`, `:116-135` |
| The producer policy parser and matcher exist. No policy means closed intake. | `packages/core/src/bridge/verification-producer-policy.ts:22-29`, `:40-52` |
| The bounded two-pass check-run reader exists. It takes the producer's App id from the check run returned by GitHub and the installation id from a separate dependency. | `packages/cli/src/contained-mission-verification-reader.ts:41`, `:86-88`, `:112-208` |
| The append-only source ledger exists. | `packages/core/src/state/engineering-verification-source-store.ts:28-58`, `packages/core/src/bridge/verification-source-ledger.ts:28-58` |
| The recheck classifier and ledger exist (migration 62). | `packages/core/src/bridge/recheck.ts:88`, `packages/core/src/state/engineering-local-failure-recheck-store.ts:74`, `:195` |
| `readVerificationResults` has no caller outside tests. | Its only non-test occurrence is its definition, `contained-mission-verification-reader.ts:112` |
| The reader's two dependencies, `rest` and `installationFor`, have no production implementation. | Declared at `contained-mission-verification-reader.ts:16-22`; no non-test file supplies them |
| No loader reads a producer policy from a host file. The parser is called once, in `registerDiagnosis`, which only tests call. | `packages/cli/src/contained-mission-diagnosis.ts:62` |

### 1.2 The producing side does not exist in this repository

- No code writes a check run named `osstack/verify-intake/<skill_id>`. The name appears only in the reader (`contained-mission-verification-reader.ts:47`, `:93`).
- No code serialises a `VerificationResultV1` for publication. The only builders are test fixtures (`packages/core/src/bridge/verification-result-fixtures.ts:5`, `:27`, `:31`).
- The one production check-run writer is a different thing: the host writes `osstack/verify` as evidence App B, with free text and not a contract (`packages/cli/src/contained-mission-bridge.ts:50`, `:272-281`). It cannot stand in for the Watcher's result, because the reader requires the registered verification App id (`contained-mission-verification-reader.ts:86`).
- `hermes-skill/`, `loop-engineering/`, `scripts/` and `.github/` contain no producer. `scripts/bridge-probe-github.mjs:199` posts check runs as App C for an impostor test only.

### 1.3 The Watcher lives outside this repository

The Watcher is not code here. It is a Grok Bot routine on a shared cloud computer:

- "现有 Grok Bots 共用云电脑，`gh` 登录为 `Rubebun-Jadeem`" (`docs/runbooks/bridge-grok-bots-handoff.md:11`).
- Its stated trigger rule: "监听 `osstack`、`OS-ERP`、`vox-agent` 的 PR 新开、新推送、合并事件；工作日 09:00–18:30 每半小时巡检。排除 draft 和作者为 `Rubebun-Jadeem` 的 PR。已有 `verified` 标记但 head 改变时，先撤标再验证" (`docs/runbooks/bridge-grok-bots-handoff.md:28`). The same row lists the live routine configuration as evidence still to be read back.
- It publishes no check runs today: "The Watcher publishes no check runs; its conclusions are reviews" (`docs/decisions/ADR-005-bridge-identity-registry.md:66`). Its failures exist only in chat: "结果现在只在 Grok 聊天里" (`docs/plans/2026-11-16-osstack-self-loop-upgrade.md:148`).
- The live configuration cannot be checked from this host: "Grok 各 Routine 的实际启用状态和触发器（只能在 Grok 端读回）" (`docs/plans/2026-11-16-osstack-self-loop-upgrade.md:253`).

The verify skill it runs, `.cursor/skills/verify-osstack/`, writes evidence files and prose verdicts. It takes no PR head as input, emits no result JSON and does not mention check runs or the verification App. Its own scope note lists the bridge code as not covered (`.cursor/skills/verify-osstack/SKILL.md:14`).

### 1.4 The identity exists; its use does not

The owner created the verification App on 2026-11-17 with Checks read/write and Metadata read-only, separate from the merge App; its numeric id is recorded only in host-private configuration (`docs/plans/2026-11-16-osstack-self-loop-upgrade.md:267`). Still open by the same document: "验证 App 安装到了哪些仓库（首发只需要沙箱仓库）；用它写一次真实 check run 的身份探针（属于 B8）" (`:269`).

The host already has the building blocks for App authentication: an App JWT (`packages/cli/src/contained-mission-github-app.ts:130-135`), a JWT-only installation read that mints no token (`:137-152`), and an installation token source (`:155-180`). None is connected to the verification App.

## 2. How the Watcher learns that a repaired head needs verification

### 2.1 The unit of work

The Watcher does not need to know that a head is a repair. Its unit of work is one triple: PR, head commit, skill. The intake design already requires a result for every new head of a chain that uses route B: "创建/发布新 head 时先置 `verification_pending`；未读到当前 head/base、登记技能的可信 passed 结果及相应主机复验就不能进入合并" (intake design §4.1). A recheck is therefore the ordinary verification of the next head. The link to the original failure is made by the host from its own ledger (§4.2), not by the Watcher.

This removes any need to tell the Watcher which result it is rechecking. The only question left is who calls "verify PR N" for the new head.

### 2.2 Options

| Option | What it needs | Path into the host |
|---|---|---|
| **1. The Watcher observes the PR head on its own.** Its existing new-push listener and half-hour patrol notice the head change and verify the new head. | Nothing on the host. On the cloud side: the routine must call the publisher of §3.3 after a verification, and Mission PRs must not fall under its exclusion rule. A variant uses GitHub's own delivery: an App with Checks write receives the `check_suite` event with action `requested` when code is pushed. That variant needs a webhook URL and secret in the App settings and a receiving endpoint in the cloud. | None. GitHub talks to the cloud; the host is not addressed. |
| **2. The host signals the Watcher.** After the confirmed push the host sends an outbound message: a webhook to a cloud endpoint, or a GitHub write such as a PR comment, a label, a `repository_dispatch` or a check-suite rerequest. | A new outbound sender or a new GitHub write on the host, a cloud endpoint and a shared secret. A rerequest needs Checks write on the host, which is a publishing-capable token (ruled out in §6). A comment or label makes PR text a trigger, which the intake design forbids as an instruction source (§5.1). | None if strictly outbound. It adds a host-originated message that the cloud side must treat as data. |
| **3. An operator triggers it.** The owner tells the Watcher, in the cloud, to verify PR N. | Nothing new anywhere. One manual step per repaired PR. | None. |

All three can be built without giving a remote party a path into the host, as long as option 2 stays outbound. They differ in what they add.

### 2.3 Recommendation

**Option 1, using the Watcher's existing listener and patrol, with option 3 as the fallback that always works.**

- It matches the Watcher's stated rule: a changed head is verified again (`docs/runbooks/bridge-grok-bots-handoff.md:28`).
- The host sends nothing and exposes nothing. The host's role is to wait and to read.
- The cloud verification stays independent of the host. The B7d design gives that as the reason for requiring both: "the host recheck and the cloud recheck stay independent, which is the point of requiring both" (§3.1 there).
- The GitHub webhook variant is not recommended for the first release. It needs an App settings change and a new public endpoint, and the existing listener already covers the case.

Option 2 is not recommended. It couples the cloud recheck to the host, and its GitHub-write forms either need a token the host must not hold or turn PR text into a trigger.

Whatever the trigger, three rules hold on the cloud side:

1. The trigger carries only the repository id and the PR number. The verifying service reads head, base, branch and author from the GitHub API itself. Text in a chat message, a notice or a PR is never the source of a head or a command.
2. One automatic verification per PR, head and skill. A second verification of the same head happens only by operator command in the cloud (§5).
3. Only repositories and skills on the cloud-side allowlist are published. First release: the sandbox repository and one skill.

### 2.4 What the host does while it waits

The ledger row is `reverify_pending / verify_recheck_missing` with `result` in its missing list (`recheck.ts:86`, `:99-100`). B8 adds two things on the host, both read-only towards the outside:

- The close-out view shows the missing list and "waiting for the Watcher's result since `<time>`".
- One notice to the owner per ledger row when the result is still missing after a host-configured wait. Suggested default: 60 minutes. The notice goes through the existing sender (`packages/cli/src/attention-webhook-delivery.ts:118-123`). It names the PR, the head and the ledger row. It is a notice, not a retry and not a command to anyone.

The patrol runs on weekdays 09:00–18:30, so a repair pushed in the evening waits until the next morning unless the push event triggers the Watcher. That is expected and visible, not an error.

## 3. Identity and minimal permission

### 3.1 What the intake design already fixes

From intake design §3.2, not redesigned here:

- A dedicated verification App writes the result. It is not App A, B or E and is not a reviewer.
- "最小权限：验证发布端 checks write、metadata read，取源按需要单独授予 contents read；无 contents write、无审批/合并能力。"
- "PR checkout、浏览器页面及模型执行器拿不到发布 token；可信外置发布服务只接收已完成的验证数据。"
- The host registers the exact `repository_id + app_id + installation_id + skill/profile digest` in host-private configuration, and "未填写且核验这些值时，B 入口关闭".
- "check run 的 `app.id` 不能证明具体使用了哪一枚 token，也不直接提供 writer 的 installation ID。安装范围须由该 App 的认证安装查询与仓库列表独立核验；若读端无此能力，保持 `verify_producer_untrusted`，不能用 payload 补证。"

### 3.2 Which App, which permissions, which repositories

- **App:** the existing verification App `osstack-verifier`. No new App.
- **Permissions, exactly:** Checks read and write, Metadata read-only. Nothing else. Both repositories are public (read from the GitHub API on 2026-11-19), so the publisher can fetch the PR and the code without Contents or Pull requests permission. If that proves wrong in B9, the fallback is Pull requests read-only, never a write permission.
- **Events and webhook:** none subscribed, webhook inactive, as long as option 1 uses the existing listener.
- **Repositories:** installed on selected repositories only. First release: `osborn-studio/osstack-bridge-sandbox` only. `osborn-studio/osstack` is added by the owner at production admission, as a separate approval.

### 3.3 The publisher in the cloud

The publisher is a small service on the cloud side. It is the only place that holds a credential able to write as the verification App.

Two readings of "可信外置发布服务只接收已完成的验证数据" are possible.

- **Reading P1:** the model-driven Watcher bot produces the verification data (check ids, exit codes) and hands it to the publisher. The token is isolated, but the bot can submit a record it invented.
- **Reading P2 (recommended):** a fixed harness, not the model, produces the data. The publisher service takes only repository id and PR number, checks out the head it read from GitHub, runs the pinned profile's commands, records the exit codes itself and publishes. The bot can ask for a verification but cannot author its outcome.

P2 follows the intake design's rule for route A, "用仓库维护的固定 harness 执行，保存真实退出码、输入版本与证据" (§2.1 there), and its §8.1 step 2, "Watcher 在真实云验证环境运行固定技能，实际断言失败。独立可信发布端写 B check run". P2 costs a harness that maps the installed profile's checks (`packages/cli/src/contained-mission-verification-profile.ts:20`, `:27`) to result checks. P1 needs no harness but leaves the outcome in the model's hands.

Under either reading the publisher:

- holds the key or token in a location the bot's OS user, the PR checkout and the browser cannot read;
- reads the PR from GitHub immediately before publishing and publishes nothing if the head moved, the PR is from a fork, or the repository or skill is not on its allowlist;
- validates the result with the same parser the host uses before writing;
- writes one check run in one request, already `completed`, and never edits a completed check run. The source ledger rejects an object whose content changed as `verify_attempt_ambiguous` (`verification-source-ledger.ts:29-32`);
- keeps a durable attempt ledger and reads back its own check run after writing.

### 3.4 How the reader proves producer identity

Already implemented and unchanged:

- The App id is taken from the check run object that GitHub returns, `app.id` (`contained-mission-verification-reader.ts:41`), and must be a registered producer (`:86`).
- The installation id comes from the separate dependency `installationFor`, described as "Independent authenticated proof from the App's own installation context, never the payload" (`:19-20`), and must equal the registered one (`:87-88`).
- The payload's `producer` object is only compared against those two observed values; a mismatch rejects the result (`:94`). It never establishes identity.
- The policy match then checks repository, skill, profile and failure code (`verification-producer-policy.ts:40-52`).

To be built in B8 (node B8-3):

1. **`installationFor`.** A request signed with the App's JWT to `GET /repos/{owner}/{repo}/installation`, the pattern of `assertBridgeAppInstallation` (`contained-mission-github-app.ts:137-152`). It returns an installation id only when GitHub's answer shows this App id, not suspended, `repository_selection` equal to `selected`, and permissions equal to exactly Checks write and Metadata read. Any further permission makes the producer untrusted. This turns a later widening of the App's permissions into a visible rejection.
2. **`rest`.** A GET-only transport with byte and time limits. It must not use a token of the verification App. It uses a read identity the host already holds for that Mission's PR.
3. **The policy loader.** A strict loader for a host-private file. A missing file means closed intake (`verification-producer-policy.ts:24-26`); an invalid file is an error and never a fallback.

**One correction to merged behaviour is needed.** Today a failed installation proof is swallowed and the producer is rejected (`contained-mission-verification-reader.ts:188-194`). The rejection is stored for that check run, and a later read of the same unchanged check run returns the stored row and stores nothing new (`verification-source-ledger.ts:29-31`). A short GitHub outage during the proof would therefore reject a genuine result permanently. The intake design places "身份/attempt 无法证明" under `waiting_source / verify_read_incomplete`, "保持关门；仅重读事实" (§3.3 there). B8-3 changes the dependency to a three-way answer: installed, not installed, or unavailable. Unavailable makes the whole read incomplete and records nothing. An absent dependency still means `verify_producer_untrusted`, as §3.2 of the intake design says.

### 3.5 Where the private key lives

The proof in §3.4 needs a JWT, and a JWT needs the App's private key. Today the only key is on this host. The publisher in the cloud needs a credential too. Three arrangements are possible.

- **K1 (recommended): two keys.** The owner generates a second private key for the same App and places it in the cloud publisher's secret location. The host keeps its key and uses it for the JWT installation read only. Each key can be revoked separately.
- **K2: the key moves to the cloud and the host keeps none.** The host can then not prove the installation, and every result stays `verify_producer_untrusted`. Not workable with the merged reader.
- **K3: the host mints short-lived write tokens and sends them to the cloud.** This is a host-side publishing token and a host-to-cloud credential channel. Ruled out (§6).

K1 has a limit that must be stated plainly: a private key can mint a write token, so a host that holds the key is technically able to write a check run as the verification App. Under K1 the independence of the cloud result from the host rests on code discipline, not on a missing capability. B8-3 enforces the discipline with a static test: the verification App's key path is read by one module only, that module sends GET requests only, and no source file requests an installation token for that App. GitHub offers no read-only key and no way for one App to prove another App's installation, so I see no arrangement that removes the limit while keeping the installation proof.

### 3.6 What the owner must do by hand

The implementation session cannot do any of these. Each is listed separately.

1. **Confirm the installation scope.** In the App's settings, set installation to selected repositories and select `osborn-studio/osstack-bridge-sandbox` only. Read back the installation id.
2. **Confirm the permission set.** Exactly Checks read and write, Metadata read-only; no event subscription; webhook inactive.
3. **Generate the second private key** (under K1) and place it in the cloud publisher's secret location yourself. It must not pass through this repository, a chat, a model or this host.
4. **Fill the host-private producer policy file.** App id, installation id, sandbox repository id, skill id and manifest digest, profile id and digest, allowed failure codes, TTL. B8-3 defines the file's path and schema; the values are yours and stay out of the repository.
5. **Prepare the cloud side.** A location for the publisher that the bots' OS user cannot read (a separate OS user on the cloud computer, or a separate small service), its allowlist, a durable attempt ledger and an evidence store with 30 days' retention (intake design §9.1).
6. **Read back the Watcher routine on the Grok side.** Confirm the new-push listener and the patrol are enabled, confirm the platform time zone, and confirm that Mission PRs are not excluded by the author rule.
7. **Connect the routine to the publisher.** After a verification the routine calls the publisher with repository id and PR number, and nothing else.
8. **Approve one real sandbox run** when B9 is ready. Until then nothing writes to GitHub.

Not part of B8 but needed before `recheck_passed` can be seen end to end: the required-check rule for the verification App on the sandbox (intake design §4.1, approved and read back separately) and a running Docker daemon for the host recheck (B7d design §9).

## 4. The result contract for a recheck

### 4.1 Fields the new result must carry

The contract is `VerificationResultV1`; B8 adds no field. For the recheck of a repaired head C on base B, with the original failed result R0:

| Field | Required value | Enforced at |
|---|---|---|
| Check run name, `external_id` | `osstack/verify-intake/<skill_id>`; `external_id` equals `result_id` | `contained-mission-verification-reader.ts:47`, `:93` |
| Check run `head_sha`, `head_sha` | C, the same value in both | `:105` |
| `result_id` | a new UUID, not R0's | `recheck.ts:98` |
| `attempt` | 1 for the first result on C for this skill. Attempts are counted per PR, head and skill. | `verification-source-ledger.ts:43-46` |
| `repository`, `repository_id`, `pr`, `branch`, `base_ref` | equal to the registered Mission PR | `contained-mission-verification-reader.ts:96-97` |
| `base_sha` | B, the base pinned in the ledger row | `:106`, `recheck.ts:96` |
| `skill_id`, `skill_version`, `skill_blob`, `skill_manifest_digest`, `profile_id`, `profile_digest`, `trusted_source` | identical to R0, including the display version | `recheck.ts:102-113`; trusted source compared as a digest, `:70` |
| `checks` | every check id of R0, including the failed one; more are allowed | `recheck.ts:111-116` |
| For `passed`: every check | `failure_code` null and `exit` exactly 0. A null exit counts as a failure. | `recheck.ts:118-122` |
| `outcome` and check run conclusion | `passed` with `success`; `failed` with `failure`; `blocked` or `cancelled` with a non-success terminal conclusion | `verification-result.ts:143-149` |
| `producer` | the App id and installation id that the API shows | `contained-mission-verification-reader.ts:94` |
| `dedup_key` | recomputed from repository, PR, head, base, skill manifest and profile; it differs from R0's because the head differs | `verification-result.ts:62-65`, `:128` |
| `generated_at` | no older than the policy TTL (at most 24 hours) when the host reads it, and at most 5 minutes in the future | `verification-result.ts:137-141`, `contained-mission-verification-reader.ts:107` |
| `withdraws_result_id` | null | `verification-result.ts:129-130` |
| Size and text | at most 16 KiB; summary at most 4 KiB; no URLs, paths, shell words or credential-like strings in any field | `verification-result.ts:55`, `:102-108`, `:118` |

Two consequences for the publisher:

- **The skill binding must not move between R0 and the recheck.** A changed binding, or a missing original check, gives `verify_recheck_binding_changed` and seals the ledger row (`recheck.ts:117`). The check happens before the outcome is looked at, so a `blocked` result with a different binding seals the row too. The publisher pins the binding it used for the first result on a PR. If it can no longer verify with that binding, it publishes nothing and reports to the operator in the cloud (decision 6).
- **Every check in a passed result needs exit 0.** A skipped check with a null exit turns `passed` into `verify_recheck_failed`.

### 4.2 How the new result is linked to the original

The intake design asks for a new passed object "并关联原结果" (§8.1 step 5) and also says "通过也是新 attempt，不改写旧失败" (§3.1). Two readings are possible.

- **Reading L1: the payload names the original** with `supersedes_result_id` equal to R0's id.
- **Reading L2 (recommended): the host makes the link; `supersedes_result_id` is null.** The ledger row pinned R0's id, skill, profile, trusted source and check set from the digest-checked original contract when it was opened (`engineering-local-failure-recheck-store.ts:74-170`). `evaluate` accepts a result only if it matches those pins, then records its id and source sequence (`:221-222`) and links the new source row to the original intake (`:230-231`).

L1 would do harm in the merged code. A result that supersedes R0 makes R0 count as revoked: `sourceRevoked` is true when any accepted row supersedes the original (`packages/core/src/state/engineering-local-failure-dispatch-store.ts:94-100`), and that check is consulted by the publication fence (`:119`) and again at `:161`. A recheck result on a new head also does not replace the failure on the old head; both stay true. L2 keeps the link under the host's control and derives it from the ledger, not from a claim in the payload.

`supersedes_result_id` stays in use for its own purpose: a later result on the same head replaces an earlier one, for example a `passed` attempt 2 after a `blocked` attempt 1. The ledger requires the target to be an accepted result of the same PR and the same App (`verification-source-ledger.ts:47`, `:56`).

### 4.3 Other heads, duplicates, late and withdrawn results

| Case | What happens | Evidence |
|---|---|---|
| Result on a different commit | Never read. The reader lists the check suites of the target head only. | `contained-mission-verification-reader.ts:161` |
| Payload head differs from its check run or from the target | Rejected, `verify_stale_head`. | `:105` |
| Result on C, but the chain head has moved on | The source ledger records it. `evaluate` leaves the row untouched because the chain head differs. The gate holds. No run and no result is sought for the other head by B8. | `engineering-local-failure-recheck-store.ts:198-204` |
| Same check run read again, unchanged | Nothing is written. | `verification-source-ledger.ts:29-31` |
| Same `result_id` in a second check run, same bytes | `duplicate`; no second registration. | `:40-42` |
| Same `result_id`, different bytes; or a completed check run edited afterwards | Rejected, `verify_attempt_ambiguous`. | `:32`, `:40-42` |
| Second `failed` result with the same dedup key | `duplicate` of the first. | `:54-55` |
| Second `passed` result on C with attempt 2 | Accepted as its own row. Which accepted result the collector presents is D4's rule and is not on main (§9). | `:57` |
| `blocked` or `cancelled` on C | Accepted in the source ledger; the recheck row stays pending with `result` missing. A later attempt may pass. | `recheck.ts:123` |
| Late: older than the TTL when read | Rejected, `verify_result_expired`, permanently for that check run. A new verification with the next attempt number is needed. | `contained-mission-verification-reader.ts:107` |
| Late: arrives after the row is sealed or passed | Recorded in the source ledger. The row does not move; `evaluate` only moves a pending row. | `engineering-local-failure-recheck-store.ts:198` |
| Late: arrives after the merge | Recorded only. | intake design §3.1 |
| Recheck result withdrawn while the row is pending | The result counts as missing again. A withdrawal is a new object by the same App with outcome `cancelled`, conclusion `cancelled`, the next attempt number, on the same head. | `engineering-local-failure-recheck-store.ts:178-179`; `verification-source-ledger.ts:48-52`; `verification-result.ts:129`, `:145` |
| Recheck result withdrawn after the row passed | The ledger does not re-check a passed row. The merge gate re-checks that the recorded result is still current and holds. **[note]** B7c | B7b and B7c hand-over notes |
| Original result R0 withdrawn after the push | B7d design §4: `closed / verify_withdrawn`, no proof issued, remote not rolled back. | `docs/design/2026-11-19-host-recheck-run.md:175-176` |

## 5. Failure states and what the owner sees

The host shows state in three places: the close-out view (ledger state, reason and missing list), the source ledger (one row per observed check run with its decision and reason) and notices. The cloud publisher reports its own errors to the operator in the cloud. Codes below exist today; B8 adds none.

| Case | Host state | What the owner sees | Next step |
|---|---|---|---|
| The Watcher never verifies C: routine off, outside patrol hours, PR excluded, cloud down | Row pending, `result` missing | "Waiting for the Watcher's result since …", then one notice | Operator triggers the verification in the cloud |
| The publisher cannot write: no key, App not installed on the repository, refused | As above; nothing reaches GitHub | The same waiting state; the publisher's error in the cloud | Owner fixes installation or key |
| A different App wrote the check, or the installation or permission set differs | Source row rejected, `verify_producer_untrusted`; row pending | The rejected source row with its reason; the waiting state | Owner checks the App's settings and the policy file |
| Installation proof unavailable | Read incomplete, `waiting_source / verify_read_incomplete`; nothing recorded (after the correction in §3.4) | "Source read incomplete" | The next scheduled read |
| GitHub unreachable or a read limit exceeded | The same | The same | The next scheduled read |
| Contract invalid, skill not registered, scope not registered | Source row rejected with that reason; row pending | The rejected source row | Fix on the cloud side, then a new verification by operator command |
| Result older than the TTL | Source row rejected, `verify_result_expired` | The rejected source row | New verification by operator command |
| Attempt number does not follow the ledger, or a completed check run changed | Source row rejected, `verify_attempt_ambiguous` | The rejected source row | Operator republishes in the cloud at the stated attempt number. Never guessed by the host. |
| Recheck `blocked` or `cancelled` | Result accepted; row pending | The blocked result and the waiting state | Operator decides whether to verify again |
| Binding changed or an original check is missing | Row sealed, `awaiting_decision / verify_recheck_binding_changed` | A decision notice | Owner decision. No automatic path. |
| The Watcher's recheck failed | Row sealed, `awaiting_decision / verify_recheck_failed` | A decision notice | Owner decision. No second repair (intake design: "零第二次自动修复"). |
| Result present, Actions or host proof missing | Row pending with those in the missing list | The missing list | B7d design §4 for the host run |
| Recheck result withdrawn | Pending again, or the gate holds | The withdrawal row | New verification by operator command |
| Head moved after a pass | Row untouched; the gate holds **[note]** B7c | Stale head in the gate view | Owner decision |

**What happens automatically, and why.**

- The Watcher verifies each new head once. That is its normal work for a head, not a retry.
- The host reads GitHub again on its schedule after an incomplete read. A read is a bounded set of GET requests, changes nothing and spends no budget. The intake design allows exactly this: "仅重读事实，不重跑已完成诊断" (§3.3).
- The host sends one notice per ledger row.

**What never happens automatically.** A second verification of the same head; a second write after an unknown write outcome (the publisher reads back, and if the check run is absent it stops and reports); a republication after a rejection; anything after a sealed row.

## 6. What stays out

- **No host-side publishing token.** The host never requests an installation token for the verification App and never writes a check run named `osstack/verify-intake/*`. The limit of this under arrangement K1 is stated in §3.5.
- **No second repair.** A failed or blocked recheck creates no dispatch and no Mission.
- **No automatic merge.** B8 only makes input (a) obtainable. The gate still ends at a counted human approval.
- No signal from the host to the Watcher, and no remote, RPC or bot path that makes the host read, evaluate or accept anything.
- No change to the contract, the reader's acceptance rules, the source ledger's decisions, the classifier or the ledger's columns and states. The one behavioural change is the incomplete-read correction of §3.4.
- No change to the Watcher's reviews, approvals or `verified` label. The verification App is not a reviewer and its result is not a vote.
- No status or review carrier, no User producer.
- No installation on `osborn-studio/osstack` and no production switch.
- No GitHub write and no sandbox run in any B8 node. Those are B9.

## 7. Node split

Each node is one PR against `main`. **No node needs a migration; 64 stays free.** If B8-4 finds that the notice cannot be recorded with the existing chain events and attention records, it must stop and ask before taking 64.

| Node | Content | Main files | Migration | Acceptance tests |
|---|---|---|---|---|
| B8-0 | This document and the owner's decisions | `docs/design/2026-11-19-watcher-recheck-publication.md` | no | Link check, governance tests |
| B8-1 | Producer contract kit, pure. A builder that turns a harness record and a pinned binding into a `VerificationResultV1` for `passed`, `failed`, `blocked` and a withdrawal. | new `packages/core/src/bridge/verification-result-builder.ts` and test; a new export subpath so the host entry points do not load it | no | Every built result passes `parseVerificationResultV1`. For a fixture original R0 and a recheck built for a new head: the source ledger accepts it with attempt 1, and `classifyRecheck` reports neither `result` missing nor a sealed verdict. The builder refuses a passed result with a null or non-zero exit, a binding that differs from the pin in any of the seven keys, a missing original check and `supersedes_result_id` equal to the original. Dedup key and conclusion mapping equal the host's functions. |
| B8-2 | Publisher library and command with an injected transport. No real GitHub. | new package `packages/verify-publisher` (`src/publish.ts`, `src/attempt-ledger.ts`, `src/cli.ts`, `vitest.config.ts` with the scratch setup file) | no | One request, already completed, with the right name, head, `external_id` and conclusion. Fault points before the write, after the write and before the ledger entry: a rerun never writes twice and never edits a completed check run. Refuses when the PR head read just before the write differs, for a fork, and for a repository or skill off the allowlist. The attempt number equals what `decideVerificationSources` expects, including after an expired attempt. Input is repository id, PR number and a harness record; no free text from a PR is accepted. The credential appears in no argument list, log or output. Static guard: no host package imports the publisher, and no non-test source outside it writes to `check-runs` except the existing evidence writer (`contained-mission-bridge.ts:272-281`). |
| B8-3 | Host identity proof, read transport and policy loader, as libraries without a caller; the incomplete-read correction | `packages/cli/src/contained-mission-verification-reader.ts`, new `contained-mission-verification-producer-config.ts` and `contained-mission-verification-installation.ts`, guard test | no | Missing policy file: closed. Invalid file: error, no fallback. Proof is given only for the registered App id, not suspended, selected repositories, and exactly Checks write and Metadata read; an extra permission, another installation id or selection `all` gives no proof and `verify_producer_untrusted`. An unavailable proof makes the read incomplete and records nothing; a later read accepts the same check run. The transport refuses any method other than GET. Static guard: the verification App's key path is read by the proof module only, and no source requests an installation token for that App. |
| B8-4 | Waiting state and one notice | close-out reader, `packages/cli/src/decisions/notices.ts`, the D4 collector | none expected | The view shows the missing list and the waiting time. One notice per ledger row after the configured wait; a restart sends no second one; a failed delivery leaves the state unchanged and visible. The notice carries identifiers only. Needs D4, D5 and B7c merged. |
| B8-5 | Cloud runbook | new `docs/runbooks/bridge-verification-publisher.md` | no | Covers key placement, the allowlist, the attempt ledger, the routine's call to the publisher, the operator's manual trigger and republish commands, and a read-back checklist. Link check. |

Order: B8-1 first. B8-2 needs B8-1. B8-3 is independent of both. B8-4 needs B8-3 and the B7d wiring. B8-5 needs B8-2.

**Pieces that need the sandbox repository and therefore belong to B9.** The intake design lists the real identity probe under B8 ("真实云端写入 App ID 与安装范围读回"). Under the rule that anything touching the sandbox belongs to the end-to-end node, these move to B9:

- one real check run written from the cloud as the verification App, read back with its App id;
- the real installation proof and the permission read-back;
- an impostor check with the same name from another App, rejected (the pattern of `scripts/bridge-probe-github.mjs:199`);
- evidence that the PR checkout and the bot cannot read the credential;
- failed, passed and withdrawal objects each read by the real reader;
- a completed check run edited afterwards, rejected;
- the trigger itself: a push to a sandbox PR leading to a published result without a host signal, with the measured delay;
- the whole recheck chain of intake design §8.1 step 5.

## 8. Decisions for the owner

| # | Decision | Recommendation | Blocks |
|---|---|---|---|
| 1 | How the Watcher learns of the new head | Option 1: its existing new-push listener and patrol. Operator trigger as fallback. No host signal. | Cloud setup; no repository node |
| 2 | Where the private key lives | K1: a second key for the cloud publisher; the host key is used for the JWT installation read only, enforced by a static test | B8-3, cloud setup |
| 3 | Who produces the verification data | P2: a fixed harness run by the publisher service; the bot only requests a verification | B8-2 |
| 4 | Where the publisher's code lives | In this repository as its own package that no host package imports, run in the cloud from a pinned commit. The alternative, outside the repository, loses the shared parser and tests. | B8-2 |
| 5 | How the recheck result is linked to the original | L2: the host links from its ledger; `supersedes_result_id` is null and the builder refuses to name the original | **B8-1, the first implementation node** |
| 6 | What the publisher does when the skill binding has moved since the original result | Publish nothing and report to the operator in the cloud. Publishing would seal the row as `verify_recheck_binding_changed`. | B8-2 |
| 7 | Notice while waiting | One notice per ledger row after 60 minutes; no retry | B8-4 |
| 8 | Permissions | Keep Checks read/write and Metadata read-only. Add Pull requests read-only only if B9 shows it is needed. | nothing |
| 9 | Repositories | Sandbox only in the first release | Owner action 1 |
| 10 | The incomplete-read correction in the merged reader (§3.4) | Accept: an unavailable installation proof makes the read incomplete; it is not a permanent rejection | B8-3 |
| 11 | Which identity the host uses to read check runs and the PR | An existing host read identity for that Mission; never a token of the verification App | B8-3 |

Decision 5 is the only one that blocks the first implementation node. Decisions 2, 10 and 11 block B8-3, which can start in parallel.

## 9. What could not be verified

- Nothing was built or run for this document. Every statement about behaviour comes from reading source at `0546cc36`.
- The Watcher's live routine: whether the listener and the patrol are enabled, its time zone, and whether Mission PRs are excluded by its author rule. This can only be read on the Grok side.
- Whether the shared cloud computer can keep a key away from the bots' OS user. If it cannot, the publisher needs a separate service.
- The App's current settings and installations. I did not query them. The permission set and the creation date come from the plan (`docs/plans/2026-11-16-osstack-self-loop-upgrade.md:267`) and from the owner's inputs to this task.
- GitHub platform behaviour was taken from GitHub's documentation on 2026-11-19 and not probed: that a check run written with an installation token shows the App's id; that the installation read needs a JWT ("You must use a JWT to access this endpoint"); that an App with Checks write receives `check_suite` `requested` on a push. Whether an installation token limited to Checks and Metadata can read a pull request on a public repository was not checked at all.
- B7c, D2 and D4 are not on main. How the collector chooses among several accepted results on one head, how often it reads, and whether a read normally falls inside the 24-hour TTL are not defined in code I could read.
- Which existing host identity can read check runs and the PR on the sandbox for the reader's transport (decision 11).
- Evidence handling. The contract carries `evidence_refs` and `evidence_digest`, and the policy names an `evidence_store`. I found no host reader that downloads and hashes evidence, and I did not search for one thoroughly. Where the publisher stores evidence and how the host reads it remains open for B9.
- Attempt numbers after a rejection. The ledger leaves rows rejected as `verify_attempt_ambiguous` or `verify_contract_invalid` out of the attempt count (`verification-source-ledger.ts:43-45`), and the publisher gets no answer from the host. After such a rejection the publisher's next number can differ from the number the host expects. B8-2 reduces this by running the host's own parser and ledger decision before writing; the remaining case ends at `verify_attempt_ambiguous` and an operator command in the cloud. I did not find a way to close it without a channel from the host to the cloud.
- Whether GitHub returns `output.text` byte for byte as written. The contract digest is computed from the returned text on every read, so the host is consistent with itself, but the publisher's local digest may differ.
