# Firstmate capabilities in OSStack: command guide

[中文](firstmate-commands.md) · [English README](../../README.md)

Checked on 2026-10-25 (Asia/Shanghai). This guide describes the source interfaces in PR #244 and its prerequisite branches. It does not assert availability on main, npm or your installed version. The 24 items are capability mappings, not 24 individual commands or a line-for-line Firstmate transplant.

## Choose commands by task

| Task | Commands (prefix each with `osstack`) | Capability IDs | Behavior and boundary |
|---|---|---|---|
| Supervision and decisions | `attention status/watch/inbox/get/answer/recovery` | 1–9 | Observation, waiting responsibility and revision-bound answers; snapshots do not prove a live process. |
| Briefs and quiet operation | `attention brief/cockpit/posture/seen/foreground` · `daily` · `cockpit` | 1, 10, 11 | Incremental views scoped to an actor; away mode grants no extra authority. |
| Turn and supervision registration | `attention handoff/turn-end/claude-hook/loop/ci` | 5–7 | Explicit registration and verified hooks; no general offline watchdog. |
| Investigation to delivery | `scout inspect/promote` · `deliver` · `start` · `control` | 12, 23 | Inspect reads committed files; promotion rebinds current policy and HEAD before guarded-local delivery. |
| Verification and retention | `graph validate/run/status/cancel/resume` · `loop enqueue/run/status` | 2–4, 13, 14, 23 | Graph multi-check delivery is artifact-only; uncertain stop retains workspaces and recovery evidence. |
| Worker views | `worker list/inspect/watch/open/logs` | 16 | Observers do not control execution; logs require a separate grant and show persisted assistant text. |
| Sources and continuity | `sources inspect/observe/events/acknowledge` | 3, 5, 15, 18, 19 | Inspect reads pinned sources; observe persists evidence; acknowledge requires an exact host grant. |
| Remote homes | `remote-home inspect/issue-cancel-grant/cancel/query` · `remote-export --stdio` · `remote-control --stdio` | 17 | Pinned SSH reads and authorized Graph cancellation only; unknown effects are queried, never resent. |
| Context, memory and routing | `attention context/lesson/triage/routing-eval` · `deliver --execution-context FILE` | 7, 20, 21 | Distinguish offline input evaluation from explicit live model calls; lessons remain drafts without automatic promotion. |
| External commitments | `follow-up-delivery prepare/list/inspect/issue-grant/authorize/revoke/dispatch/reconcile` | 9, 19, 22 | Publishing needs a host transport, signed authorization and exact target; unknown never triggers automatic resend. |
| Multi-home upgrades | `homes inspect/plan-upgrade/upgrade-status/prepare-managed-installation/apply-upgrade/reconcile-upgrade` | 24 | Planning does not authorize installation; apply/reconcile require exact digests and never roll back databases. |
| Documentation and delivery evidence | `neat check/fix` · `report` · `scorecard` · `proof` · `pr` | 支撑 / support | Knowledge hygiene and existing evidence presentation; passing does not establish live qualification or publication. |

## Start safely

Check your installed version and command help first. A development checkout must use a dedicated `OSSTACK_HOME`; do not allow a development CLI to auto-migrate the serving database. These examples only display help; they send no messages, cancel no tasks and upgrade no services.

```sh
osstack --version
osstack attention --help
osstack scout --help
osstack sources --help
osstack worker --help
osstack remote-home --help
osstack follow-up-delivery --help
osstack homes --help
```

## Common workflows

Replace placeholders with registered scopes, repositories and grants. Commands that require a daemon do not start one automatically. Continuous attention supervision requires explicit `OSSTACK_ATTENTION=1 osstack serve` and scope registration.

```sh
# Read scoped decisions / 读取范围内决策
osstack attention inbox --scope SCOPE_ID --json
osstack attention brief --scope SCOPE_ID --actor OWNER

# Read-only committed-file investigation / 只读已提交文件调查
osstack scout inspect --repo /absolute/repo --goal "Inspect recovery" \
  --path README.md --profile PROFILE --request-id UNIQUE_ID

# Registered source / 已登记来源
osstack sources inspect SOURCE_ID --repo /absolute/repo --default-tenant --json
osstack sources events SOURCE_ID --repo /absolute/repo --default-tenant --after 0 --json

# Bound worker state / 已绑定工作进程状态
osstack worker list --repo /absolute/repo --default-tenant --json
osstack worker inspect VIEW_ID --repo /absolute/repo --default-tenant --json
```

Review writes separately: `scout promote` starts delivery; `sources observe` writes the observation ledger; `attention answer` requires current revision/content hash; `dispatch` publishes externally; `remote-home cancel` requests remote cancellation; `homes apply-upgrade` changes an installation. These are not read-only status commands. Untrusted source text cannot substitute for authorization.

## Maintain these documents with neat

```sh
osstack neat check --repo /absolute/repo --all --json --fail-on error > neat-report.json
osstack neat check --repo /absolute/repo --base HEAD --schema-version 1 --json > neat-fix-input.json
osstack neat fix --from neat-fix-input.json --json
```

The first command checks documents, instructions, links and configured contracts; the last two commands produce a compatible V1 diff report and preview supported safe patches. The current fix command cannot consume the default V2 report directly. `neat` is not a README translator or general content generator. These bilingual documents are authored from actual CLI/source behavior and checked before and after with neat. This is not functional acceptance, and no paid semantic model is implicitly enabled.

## Outstanding live-environment qualification

Real GitHub sandbox delivery/body normalization, two-host SSH/disconnection recovery, tmux/cmux windows, launchd multi-home upgrades and physical power loss, and live-model holdout/billing/termination require separate qualification. Local tests and static review do not replace it; `unknown` does not mean safe to retry. Graph remains artifact-only, with no new automatic merge/deploy behavior.

## References

- [24 capability delivery ledger](../reports/2026-10-24-firstmate-capability-completion-ledger.md)
- [Attention guide](attention.md)
- [Graph operating envelope](../design/2026-10-24-graph-verification-operating-envelope.md)
- [CLI inventory](../inventory/CLI_COMMANDS.md)
- [CLI dispatch and help](../../packages/cli/src/bin.ts)
