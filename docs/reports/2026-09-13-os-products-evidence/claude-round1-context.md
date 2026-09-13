你是 Claude Fable 5.1，作为独立产品架构评审。禁止工具、嵌套skill和修改文件。中文1800字内，给可落地产品定义而不是迎合。
用户最新需求：osstack长期作为公司和个人内部使用的编程强化工具，核心Loop Engineering + Graph Engineering；还要部署本地服务器的自有Grok Bot式产品osbot，区别于已有ostag。用户提供开源rakazo。此前已经做图执行设计但尚未实施。
请定义三者分别为谁服务、核心场景、唯一负责的状态和动作、共享与不共享能力、调用关系；挑战三产品是否过多；给osbot fork Rakazo/薄适配/从零造的选择。不要把ostag猜成tagger或简单IM入口。不要把osstack扩大成公司所有工作流的万能平台。osbot暂按综合数字同事而非coding-only；该偏好已向用户询问但尚未回复。部署在本地服务器不等于模型也本地或数据不出网，不要混淆。
已核实：OSStack TS pnpm monorepo本地daemon/SQLite、agents invoke(signal)、Loop质量迭代。graph explain仅关系诊断；可执行图设计首选LGJS worker+受控broker+checkpoint+ledger，未生产实现。旧Loop会自动merge工作区，执行图需拆候选模式；这轮只定义产品不实施部署。
Rakazo clone SHA b286fc4a5d0f608005000ef35bee4c473c31a165，Apache2，beta。源码是persistent AI teammates，不是xAI官方Grok Bot源代码；routines是scheduled prompts不是静态graph language。Pi agentruntime，Postgres/Graphile Worker，Docker/E2B/Daytona/Box computer；Team computer共享身份与文件，Private电脑隔离；Docker supervisor拿Docker socket，不得等同sandbox完全不接触宿主。
OStag clone SHA5098f914，当前本地README、核心架构和已实现relay均在下面。已有receipt/policy/业务连接器，不可删成UI。策略文档也有愿景部分，必须分现有实现与未来职责。

OSTAG README：
# OS Tag

> OS Tag turns any work thread into a governed, auditable, multi-agent work loop.

OS Tag is an open, self-hostable control plane for human-agent collaboration.
Teams delegate work from Feishu/Lark, DingTalk, Slack group threads — or any
agent delegates via the CLI — to the right backend (mock, Codex CLI, Claude
CLI, OpenAI API), with scoped context, policy checks, action receipts,
approvals, artifacts, durable follow-ups, and a full audit ledger. It
maintains systems of record such as Feishu Base / DingTalk AI Table
requirement tables while keeping humans in control.

OS Tag is not a Claude Tag clone and not a Zilliz official product. It
competes on being open, neutral, inspectable, and system-of-record aware —
see [docs/claude_tag_strategy.md](docs/claude_tag_strategy.md) for the full
strategic direction.

## What it does

- **Source-thread work loop** — mention `@OS Tag` in a group; the adapter
  normalizes the event, the runner opens an auditable run, applies safety
  checks, retrieves allowlisted MFS context, routes to a workflow or backend,
  and replies in the thread.
- **Governed writes** — with `OSTAG_GOVERNED_WRITES=true`, table mutations
  become action receipts: propose → `approve 1` → `apply 1`. The exact
  approved payload is what executes. No apply without approval, ever.
- **Actor permissions** — `read < propose < write < admin`, global or scoped
  per channel; approving or applying requires `write`; denials are ledgered
  as security events.
- **Run ledger** — every handled event creates a run with source, actor,
  intent, context packet (hashed), status, and terminal outcome, in an
  append-only JSONL ledger with secret redaction.
- **Durable follow-ups** — proposals auto-schedule pending-approval
  reminders; `continue run_x` schedules a follow-up; continuations survive
  restarts, fire once, and cancel when resolved.
- **Ambient monitors** (opt-in) — unowned / overdue / stale / missing-status
  requirement detection with per-record suppression, rate limits, cited
  evidence, and ledger audit. Proposal-only: ambient never writes.
- **Agent-facing CLI** — every command supports compact `--json`; errors
  carry `code`, `message`, `recovery_hint`.
- **Remote work monitor** — signed OStag/osstack event streams feed a persistent
  mobile Feishu/Telegram board; pause/resume/retry/cancel stay receipt-governed.
- **Governed PR release** (opt-in) — an allowlisted group PR mention freezes the
  GitHub head SHA and checks into a high-risk receipt; after `approve` + `apply`,
  OStag submits a SHA-bound GitHub review and waits for that SHA to reach a
  Vercel Production `READY` deployment with an assigned alias.

## Architecture

```text
Feishu/Lark/Slack/DingTalk thread @OS Tag ──┐            ┌── ostag run (CLI/agents)
                                            ▼            ▼
                         Adapter → NormalizedEvent → OSTagRunner
                                                        │  run ledger (JSONL, redacted)
                        safety checks → receipt commands → channel brain
                                                        │  context packet (hashed)
                              AutoBase workflow ────────┤
                              (governed writes → receipts → approve/apply
                               via connector executors)  │
                              Backend (mock/Codex/Claude/OpenAI) 
                                                        ▼
                                        reply in source thread + audit
```

Boundaries: adapters own transport/rendering; core owns events, runs,
receipts, ledger, policy; connectors own system-of-record operations;
executors/backends own agent invocation; workflows coordinate domain
operations; the CLI exposes stable human/agent operations. Details:
[docs/ostag/architecture.md](docs/ostag/architecture.md).

## Quick start

```bash
cp .env.example .env
uv sync --extra dev
python -m ostag.main --platform feishu --dry-run --event examples/feishu_event.json
uv run pytest                 # 217 tests
scripts/release_check.sh      # full release gate
```

Submit work through the full pipeline from the CLI (nothing is posted to any
platform; the reply returns to you):

```bash
ostag run --platform feishu --chat oc_demo --text "请总结项目下一步" --json
```

## CLI surface

```bash
ostag run --chat <id> --text "..." --json      # submit a task
ostag status --run run_x --json                # run snapshot
ostag runs list --json                         # recent runs
ostag ledger export --run run_x --json         # full audit trail
ostag context export --run run_x --json        # what the run was given (hashed)
ostag artifacts list --run run_x --json

ostag receipts list --pending --json           # pending approvals
ostag approve|reject|apply|continue <ref> --json
ostag followups list --json                    # scheduled continuations
ostag followups run-once --json

ostag connector list --json                    # platform capability declarations
ostag channel policy show|set --platform p --chat c ...
ostag ambient run-once [--send] --json
ostag memory show|remember|sync ...
```

Full reference: [docs/cli_reference.md](docs/cli_reference.md).

Work-monitor architecture, deterministic smoke, production deployment, backup,
rollback, and the explicitly incomplete external evidence checklist are in
[docs/ostag/work_monitor.md](docs/ostag/work_monitor.md) and
[docs/ostag/deployment.md](docs/ostag/deployment.md).

## Governance model

| Layer | Mechanism |
|---|---|
| Receipts | state machine: `apply` only from approved state; stale receipts refuse all verbs ([docs/action_receipt_protocol.md](docs/action_receipt_protocol.md)) |
| Permissions | `OSTAG_ACTOR_PERMISSIONS` + per-channel grants ([docs/channel_policy.md](docs/channel_policy.md)) |
| Governed writes | opt-in per deployment or per channel; frozen `apply_payload`; connector executors; no delete path ([docs/governed_writes.md](docs/governed_writes.md)) |
| Audit | run ledger + audit log, secrets redacted ([docs/run_ledger.md](docs/run_ledger.md)) |
| Reporting | identity-scoped JSON/HTML operations report with derived Agent Presence, disabled by default ([docs/ostag/operational_report.md](docs/ostag/operational_report.md)) |
| Async | durable continuations ([docs/async_runs.md](docs/async_runs.md)) |
| Ambient | opt-in, cited, suppressed, proposal-only ([docs/ambient_v2.md](docs/ambient_v2.md)) |
| Security | defaults and hardening roadmap ([docs/security_governance.md](docs/security_governance.md)) |

Safe defaults: dry-run on, mock backend, MFS off, shell off, applies off,
governed writes off (fully backward compatible), unsafe CLI flags require
explicit env vars, audit and ledger redact secrets.

## Platforms and backends

- Platform setup: [Feishu](docs/ostag/feishu_setup.md) ·
  [Lark](docs/ostag/lark_setup.md) · [Slack](docs/ostag/slack_setup.md) ·
  [DingTalk](docs/ostag/dingtalk_setup.md) ·
  [deployment](docs/ostag/deployment.md) (launchd, Docker Compose)
- Backends: `OSTAG_BACKEND=mock|codex_cli|claude_cli|kimi_cli|openai_api`
  (`uv sync --extra openai` for the API backend; unsafe CLI modes require
  explicit `OSTAG_*_UNSAFE_MODE` flags; Kimi stays disabled until both executor
  feature flags are enabled after `ostag executor test kimi_cli` passes)
- Executor conformance: `ostag executor list --json` and
  `ostag executor test kimi_cli --json`; OSStack registration is declared
  separately and is never inferred from a locally installed command.
- Operational report: `ostag monitor report --platform feishu --actor <id>
  --scope personal --format json`; the monitor server exposes the same scoped
  schema-v2 projection and six-state Agent Presence summary at `/v1/report` and
  `/v1/report.html` when explicitly enabled.
- Capability declarations per connector: `ostag connector list --json`
  ([docs/connector_capabilities.md](docs/connector_capabilities.md))

## Platform operating model

Feishu and DingTalk should present the same OS Tag operating model to users:

- **Feishu** — Feishu Base requirement pools, Feishu multidimensional-table
  tasks, internal approval flows, and customer/business group ambient
  monitoring with status follow-through.
- **DingTalk** — DingTalk AI Table requirement management, AI Table task
  objects, internal approval flows, and customer/business group ambient
  monitoring with status follow-through.

The platform-specific connector owns the system-of-record details, while the
governance layer stays consistent: receipts, actor permissions, approval
quorum, four-eyes rules, budgets, follow-ups, and ledger audit.

## Requirement table operations

With a default Feishu Base / DingTalk AI Table configured
(`OSTAG_AUTO_BASE_DEFAULT_BASE_TOKEN` / `..._TABLE_ID`):

```text
@OS Tag 请把 交易-001 分配给 @张三，状态改为 开发交付中
@OS Tag 请将 市场周报 优先级改为 高
@OS Tag 请为 交易盯盘 创建飞书任务并分配给 @李四
```

The workflow updates only existing fields, locates exactly one matching
record (refuses ambiguity), respects channel policy (writable fields, task
confirmation, daily budgets), and — with governed writes on — proposes a
receipt instead of writing:

```text
OS Tag: 已生成待审批操作：[1] 更新需求「交易-001」… 回复：approve 1 / reject 1
你:     @OS Tag approve 1
你:     @OS Tag apply 1
```

Docx bulk import into the requirement pool works the same way (`自动入表`).

## Context: MFS and channel memory

MFS retrieval is disabled by default and scope-allowlisted
(`MFS_ALLOWED_SCOPES`). Channel memory is local markdown plus a per-channel
brain (facts, preferences, policy) — scoped, inspectable, editable:

```bash
python -m ostag.main memory remember --platform feishu --chat-id oc_demo --text "Use mock backend for pilot."
ostag channel policy show --platform feishu --chat oc_demo --json
```

Every run that reaches the workflow/backend records a hashed context packet
(`ostag context export --run run_x --json`).

## Provenance

Forked from and inspired by `zilliztech/mfs` (Apache-2.0) open-tag-skill;
adapted and renamed as OS Tag with multi-platform adapters and the governance
layer. See [FORK_ORIGIN.md](FORK_ORIGIN.md) and upstream research notes in
[docs/research/](docs/research/).

## Roadmap

Done: run ledger · action receipts · actor permissions · governed writes with
connector executors · CLI-submittable runs · context packets · durable
continuations · per-channel policy · ambient monitors V2.

Also done since: governed task creation · environment scrub for agent
subprocesses · high-risk approval quorum · four-eyes rule · GitHub and GitLab
issues connectors (governed create/comment via gh/glab CLI) · SHA-bound GitHub
PR review plus Vercel Production release · per-channel daily cost budgets.

Next: MFS-deepened context packets · sandbox hardening for code-writing
executors · Slack Block Kit / Feishu card renderers · GitHub/GitLab thread
reading · web admin console.

## Acceptance

Scoring standard: [docs/ostag/acceptance_criteria.md](docs/ostag/acceptance_criteria.md)
and the benchmark scorecard in
[docs/claude_tag_strategy.md](docs/claude_tag_strategy.md) §16. Release
requires `uv run pytest` green and `scripts/release_check.sh` exit 0.

RAKAZO VISION（愿景，不自动等于全已实现）：
# Vision

Rakazo exists so that people can own AI teammates that persist, use computers, and finish work beyond a single chat.
It serves people who want capable agents without surrendering their choice of models, infrastructure, or where their data lives.
It owns exactly one thing: the durable home in which each AI teammate's identity, conversation, memory, routines, and computer remain available over time.

## Persistent teammates, not disposable chats

A bot is a continuing identity with one visible conversation and durable working state.
A bot works in the background, returns with a result, and asks for help only when it needs information, judgment, authorization, or protected input.
Useful work lands in the destination where it belongs instead of ending as an unsupported claim in chat.
Changes that reduce bots to prompt presets or isolated one-off tasks work against the product.

## Ownership includes choice

The complete core product runs on infrastructure controlled by its operator under an open-source license.
No hosted vendor is required for models, computers, memory, voice, integrations, or another core workflow.
External services remain optional choices behind provider-neutral contracts, and new providers reuse shared contracts and deterministic offline conformance tests.
Bot state remains inspectable, exportable, recoverable, and portable across provider failure or replacement.
A managed Rakazo service may improve convenience, but it does not become a hidden dependency of the self-hosted core.

## One product across every surface

Web, Electron, mobile, and messaging surfaces expose the same bots and durable state through shared product contracts.
Core workflows work on every applicable surface or degrade safely for an explicit reason.
Shared behavior, orchestration, and reusable interface logic live in shared packages.
Platform-specific code is reserved for native navigation, storage, permissions, and interactions that genuinely differ.

## Computers are durable places

A computer is persistent working state even when its underlying process, container, or virtual machine is suspended or replaced.
A Team Computer shares files, installed tools, and a canonical browser identity among bots inside the same trust boundary.
Rakazo gives each concurrently active Team bot a separate live desktop and browser process when the provider supports it, and unsupported providers expose the limitation instead of silently coupling control.
Browser sign-ins are checkpointed into the shared identity and become available to desktops opened or restarted after that checkpoint.
Concurrent Chromium processes do not write directly to one profile directory, and generation fencing prevents older desktops from overwriting newer shared state.
A Private Computer remains the explicit choice when files, browser identity, or working state must not be shared with other bots.
Computer resources start lazily and are released when inactive so configured capacity does not become permanently reserved memory.
User takeover grants exclusive control of one bot's screen without unnecessarily blocking other bots on their own screens.

## Calm on the surface, rigorous underneath

Chat shows the bot's response, useful progress, results, and genuine requests for help rather than its internal tool lifecycle.
The interface removes explanatory copy and persistent chrome unless they change a decision, and advanced capability appears progressively when relevant.
Frontends express intent and render state while the backend owns orchestration, authorization, validation, retries, recovery, and provider translation.
Routines remain scheduled prompts rather than becoming a visual workflow language.
Implementation complexity is acceptable only when it protects a real boundary or makes the user experience simpler and more reliable.

## Trust is explicit and verified

Spaces are authorization boundaries across which private chats, files, memory, computers, and integrations do not mix implicitly.
Sharing a bot transfers an intentional configuration, not its computer, credentials, files, private memory, or history.
Consequential actions respect explicit approval policy, and uncertain automated review fails toward asking rather than silently acting.
Authentication, secret handling, sandbox boundaries, host commands, and integrations are treated as security-sensitive product behavior.
Important effects are verified independently, recovery preserves known-good user state, and core tests remain deterministic and offline by default.

## Current decisions

This file records current product truth rather than an append-only decision log, and Git history preserves decisions that are later replaced.
One bot has one continuous visible thread because continuity is part of its identity, while internal runs and attempts remain implementation detail.
Team Computers share a persisted browser identity and isolate simultaneous live desktops when supported because shared login state and safe concurrency are both required.
Private Computers isolate the entire working home because some trust boundaries must be stronger than collaboration convenience.
Connections belong to the user or space rather than requiring repetitive per-bot setup because bots differ through role and state, not account plumbing.

## Scope

Rakazo is not a model provider, a hosted-only service, a general virtual-machine manager, a visual workflow builder, or a CI system.
Rakazo does not promise that a trusted host computer or third-party destination is isolated from data deliberately sent to it.
Implementation plans and technical documentation explain mechanics, but this file is authoritative when product direction conflicts with an older plan.
A change aligns when it strengthens persistent useful work, user ownership, safe autonomy, shared product behavior, or calm interaction without weakening an explicit boundary.
A change should be resisted when it creates mandatory lock-in, fragments the product by surface, exposes internal machinery as user burden, weakens ownership or isolation, or adds capability without a durable place in a bot's work.

RAKAZO SELF HOST（节选）：
# Self-hosting Rakazo

The signed-in product is a long-running API, a Graphile Worker, Postgres, and a computer provider (Docker supervisor, E2B, Daytona, or Box). It is not a static site. The marketing site in `apps/www` can be hosted separately.

## Local (source checkout)

Same as the README quick start: `.env` from `.env.example`, Postgres via Compose, `pnpm sandbox:build`, `pnpm dev`, then [http://127.0.0.1:5173](http://127.0.0.1:5173) (or `http://localhost:5173` — both loopback hosts are trusted). Electron: `pnpm --filter @rakazo/desktop dev` while that stack is up, choosing **Existing instance** with that address. The desktop app's **This computer** option instead installs and runs the published images itself with Docker Compose (see [Published images](#published-images-no-checkout)), using port 45173 by default so it can run alongside `pnpm dev`. If that port is occupied, the app selects and remembers another loopback port. The managed API gets a Docker-assigned loopback port; all desktop traffic uses the web origin.

For source development in WSL, keep the checkout and `data` directory in the Linux filesystem (for example, `~/rakazo`), and run `pnpm dev` as your normal user. The host-run supervisor matches bot container UID/GID to that user. If Docker Desktop container IPs are unreachable, set `SANDBOX_CONTROL_VIA_LOOPBACK=true` in `.env`; this publishes the token-protected control service on a random loopback port. Leave this unset for the Compose-hosted supervisor.

Compose bot homes mount only their own subdirectory of the application volume using Docker volume semantics. Docker's internal volume paths are never used as host bind mounts.

## Published images (no checkout)

Pull Postgres and `ghcr.io/elie222/rakazo/app` into any empty folder. No clone or image build.
Requires Docker Engine 26+ (API 1.45+ for bot home volume subpaths), the Compose plugin, curl, and OpenSSL.

```bash
mkdir -p rakazo && cd rakazo &&
curl -fsSLO https://raw.githubusercontent.com/elie222/rakazo/main/infra/compose/install-images.sh &&
bash install-images.sh
```

The installer downloads `docker-compose.images.yml` and `.env.images.example`, creates `.env` with
random secrets, then pulls and starts the images. It preserves an existing `.env` when rerun. For
the installer secret list, non-reuse rules, and recovery, see
[Self-host secrets checklist](./self-host-secrets.md). To customize the public URL, image tag, or
optional providers before startup, run `bash install-images.sh --prepare-only`, edit `.env`, then
run `bash install-images.sh`. Flags may be combined in either order: `--prepare-only`, `--local`.

`SANDBOX_PROVIDER` defaults to `docker`. The images Compose file runs a sandbox supervisor
(from the app image, on the internal network only) and pulls `ghcr.io/elie222/rakazo/computer`.
Signup and local Docker computers work without an E2B account. Optional remote providers: set
`SANDBOX_PROVIDER` to `e2b`, `daytona`, or `box` and add the matching API key. The published-images
Compose stack requires `SANDBOX_SUPERVISOR_TOKEN` for every provider; leave it empty and `compose up` fails closed.

Optional: set `OPENROUTER_API_KEY` or connect a model in the UI after signup.

The example defaults to `edge` (main builds). Every publish is multi-arch (`amd64` + `arm64`), so
arm64 hosts need no special tag. Do not assume `latest` is present until a stable release exists.

Open [http://127.0.0.1:5173](http://127.0.0.1:5173). The first registered user becomes the
deployment owner. Put TLS in front of `:5173` for a public host and set the three public origins to
that HTTPS URL.

Images Compose binds web to loopback (`127.0.0.1:5173`). Terminate TLS on the host and proxy
there. Vite preview same-origin-proxies `/api` and `/rpc`, so do not expose `:3100`. Set
`BETTER_AUTH_URL`, `WEB_ORIGIN`, and `API_URL` to that same HTTPS origin, and set
`RAKAZO_HOST` to its hostname (for example, `app.example.com`).

```Caddyfile
app.example.com {
	reverse_proxy 127.0.0.1:5173
}
```

Open **Agent computer** on a bot, or send a message that uses the desktop, to see
the local Docker computer. For in-stack Caddy plus remote E2B computers, use the
[production Compose](#public-single-vm-deployment) path and `infra/compose/Caddyfile.prod`
instead of this host proxy.

### Restricted networks / mirror downloads

If the installer, Compose downloads, or image pulls are blocked, use the
[restricted-network guide](./self-host-restricted-network.md) for mirror settings and local files.

### Bot computer resource ceilings

Each Docker computer runs Xvfb, a window manager and a full Chromium driven by an agent that
decides for itself what to open, so it is capped. These defaults provide a starting point for the
Docker computer topology:

| Variable | Default | Accepts |
| --- | --- | --- |
| `RAKAZO_COMPUTER_MEMORY` | `2g` | `2g`, `1536m`, a byte count. Minimum `6m`, Docker's own floor. Also caps swap, so the ceiling holds. |
| `RAKAZO_COMPUTER_CPUS` | `2` | Whole or fractional cores, e.g. `1.5` |
| `RAKAZO_COMPUTER_PIDS_LIMIT` | `2048` | A positive integer |

Set any of them to `0`, `none` or `unlimited` to remove that ceiling. A malformed value fails the
supervisor at startup naming the variable, rather than surfacing later as a failed bot.

## Docker Compose (single machine)

1. Copy `.env.example` to `.env` and set `POSTGRES_PASSWORD` (`openssl rand -hex 16`), plus `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`, and `SCREEN_PROXY_SECRET` to independent l
OSStack当前图方案摘要：
# OSStack Graph 后续工作的更新上下文

日期：2026-09-13。用途：给下一次实现任务或跨模型评审提供准确起点。

## 用户目标

需要 Google 式真实可执行图编排：显式节点 I/O、并行汇合、条件路由、失败处理、停止规则，并复用 OSStack agent、Loop 与权限。不是继续扩大关系检索，也不是先建知识图谱。用户希望与 Claude Fable 5.1 互相挑战，并评估 OSStack 升级与独立 osgraph 产品。

## 当前事实

- OSStack 检查基线 `b476bcc`，工作分支 `codex/graph-readonly-pilot`；现有 `graph explain` 只读。此前 pilot 测试不证明任何执行图语义。
- Awesome 已克隆至 `/Volumes/AIMATE_WORK/Developer/CodeX/Awesome-Graph-Engineering`，是资源索引；playbook 的 Python 示例是知识处理；GraphGen 是图驱动数据生产。
- Google ADK **JS 2.0.0 已真实发布并可运行 Workflow**；不可再称此能力 Python-only。该类此次运行仍提示 experimental。
- LangGraph.js 1.4.15 被选为首个待实施内核；不是已完成 OSStack 集成。无需绑定 LangSmith 或替换现有模型客户端。
- 独立探针 10+2 项通过各自断言；包括风险复现：ADK 缺输出仍汇合；LangGraph 恢复重执行中断前代码；外部动作后 SIGKILL 导致重复动作。
- 实验环境 Node 26.5.0；Node 20、真实 adapter、取消、受控 saver、fencing、租户与性能集成尚未验证。

## 收敛方案

先做 OSStack 内 `@osstack/graph` 模块与 `osstack graph` 命令；不启动独立控制面产品。首条代码交付图：一次实现 → 冻结 commit/导出产物 → 并行独立评审+隔离测试 → 同 run/epoch/revision 汇合 → ready、有限 repair、分支重试或停止。最多三轮静态展开；初版单 writer；ready 不自动发布。

graph worker 独立进程，避免模块加载阻塞 daemon。复用一个受控 broker。checkpoint 权威负责图调度和数据；ledger 权威负责动作、权限、结果与资源；展示状态才是投影。不能把两种状态混写，也不能说 checkpoint 全可从动作 ledger 重建。

动作 intent 先落账本再执行。重放复用稳定 effectKey，key 不含 generation；unknown/cancel_pending 阻止盲目重发。新真实尝试须前次状态可判定且有授权预算。禁止承诺非幂等 provider 物理恰好一次。

fencing 同时约束 saver `put` 和 `putWrites`，以及 broker 新动作。它不阻止已启动的旧进程写文件，因此各代/各写动作隔离 worktree；旧进程未确认退出不能复用其目录。每动作启动重验 grant/policy/expiry。

## 必须先补的 OSStack 接缝

1. `AgentAdapter` 实际只有 `invoke(task, signal)`；注释里的 cancel 方法不存在。Loop executor 没外部 signal。
2. executor 默认 completed；无 done 的流可能被当作成功，必须修终态契约。
3. Loop cycle 顺序任务，末尾写 LOOP-STATE.json，不可充当图检查点。
4. private runTask 自动 commit/ff-only merge/cleanup，不能直接包成图节点。提炼一次候选执行，成果落稳后再回收；图评审模式不重复内置评审，也不绕过治理。
5. daemon 门控和写锁需提炼共享服务；图路径可信解析 repo scope，不接受模型填写的 repo_id 决定锁范围。

## 下一步执行依据

以 [实施计划](../design/2026-09-13-executable-graph-plan.md) 的 P0 → P1 → P2 顺序推进，先把受控执行与故障窗口跑通，再开放真实写入 beta。具体测试矩阵已经列出。当前任务交付研究与方案，没有实现生产图运行时。

现有未提交的 `AGENTS.md` 修改属于用户，不覆盖或混入提交。开发 CLI / DB 检查必须显式使用临时 `OSSTACK_HOME`，禁止打开默认或保留 serving home。不要把研究用 npm 依赖或临时数据库拷入产品依赖树。

完整证据：[研究报告](2026-09-13-executable-graph-research.md)、[三轮评审纪要](2026-09-13-executable-graph-claude-review.md)、[证据说明](2026-09-13-executable-graph-evidence/README.md)。Claude 原始各轮上下文和答复在证据目录，最终决策不能只根据第一轮答复。

请额外回答：1)编码任务如果三个系统都有agent和scheduler，如何单一执行所有权？2)个人与公司账号/记忆/浏览器凭据如何分开？3)一条飞书业务需求如何经过三个产品，哪些流程不需要三者全部经过？4)仅研究方案的首期明确交付边界与成功指标。