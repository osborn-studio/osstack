# Firstmate 能力在 OSStack 中的命令手册

[English](firstmate-commands.en.md) · [中文 README](../../README.zh.md)

核对日期：2026-10-25（北京时间）。PR #244 及前序能力已整合到 main，并随 npm CLI 0.22.1 发布。请用 `osstack --version` 核对本机版本。24 项是能力映射，不是 24 条独立命令，也不是逐行复制 Firstmate。真实环境验证范围见[安装与升级指南](install-upgrade.md)。

## PR #244 引入的接口（已整合）

以下与 PR 的 base 分支 `codex/firstmate-extension-integration` 比较。前序 PR 已提供的命令仍在总表中，但不能重复算作 #244 新增。

| 变化 | 命令与主要参数 | 用途 |
|---|---|---|
| 新命令族 | `scout inspect --repo PATH --goal TEXT --path FILE --profile NAME --request-id ID`；`scout promote --scout DIGEST --request-id ID` | 读取已提交文件；把勘察结果转成新的受控交付。`--path` 可重复。 |
| 新子命令 | `sources observe/events/acknowledge SOURCE_ID --repo PATH --default-tenant` | 记录观察、读取事件、确认来源变更。`events` 接受 `--after SEQUENCE`；`acknowledge` 必须使用 `--grant GRANT_ID`。 |
| 新子命令 | `worker open`；`worker logs --grant-file PRIVATE_FILE [--before-ordinal N]` | 打开已配置的观察窗口；凭单独授权读取持久输出。 |
| 新远程控制入口 | `remote-home issue-cancel-grant`、`cancel`、`query`；`remote-control --stdio` | 生成精确取消凭证、请求取消、查询回执。`cancel/query` 使用 `--registry FILE --sha256 HASH --alias NAME --grant FILE`。 |
| 新授权入口 | `follow-up-delivery issue-grant ID --repo PATH --default-tenant --revision N --key KEY --output FILE` | 生成授权文件。此步骤不发布内容。 |
| 新升级入口 | `homes prepare-managed-installation`、`apply-upgrade`、`reconcile-upgrade` | 准备受管安装、执行已批准的升级、核对升级结果。需要制品、注册表及计划的精确摘要。 |
| 扩展参数 | `attention routing-eval --input FILE --mode paired_holdout` | 使用配对留出数据比较路由；与原有 `router_golden` 模式分开。 |
| 内部机制增强 | Graph 验证、来源连续性检查、Loop 隔离记录、验证器检查、升级守卫 | 通过现有命令触发。没有为每个内部机制增加一个命令。 |

`deliver --execution-context FILE` 是前序分支已有参数。它继续提供执行上下文入口，不能重复计为新增参数。

参数表是入口索引，不是完整执行配置。写操作还需要宿主登记、授权和目标状态。查看对应 `--help` 和下方依据，不能仅复制参数表就执行生产升级。

Prompt 和命令说明采用[清晰语言写作约定](prompt-language.md)。它借鉴 ASD-STE100；保留技术标识符，明确条件、操作和结果。

## 按任务选命令

| 任务 | 命令（均以 `osstack` 开头） | 能力编号 | 行为与边界 |
|---|---|---|---|
| 监督与决策 | `attention status/watch/inbox/get/answer/recovery` | 1–9 | 持续观察、等待责任与绑定版本的回答；快照不证明进程存活。 |
| 简报与低打扰 | `attention brief/cockpit/posture/seen/foreground` · `daily` · `cockpit` | 1, 10, 11 | 按用户和范围组织增量信息；Cockpit 需要运行中的 daemon，away 不扩大权限。 |
| 回合与监督登记 | `attention handoff/turn-end/claude-hook/loop/ci` | 5–7 | 显式登记和已验证 hook；没有通用离线 watchdog。 |
| 调查转交付 | `scout inspect/promote` · `deliver` · `start` · `control` | 12, 23 | inspect 只读已提交文件；promote 重新绑定当前策略与 HEAD，启动 guarded-local。 |
| 验证与保全 | `graph validate/run/status/result/cancel/reconcile/resume` · `loop enqueue/run/status` | 2–4, 13, 14, 23 | Graph 多检查交付 artifact；停止不明时保留工作树与恢复证据，使用 graph reconcile 核对未知结果；不保证自动解除。 |
| 工作进程视图 | `worker list/inspect/watch/open/logs` | 16 | 观察器不控制执行；logs 需独立授权，仅返回有界持久 assistant 输出，不是实时进程 stdout 或 tail。 |
| 来源与连续性 | `sources inspect/observe/events/acknowledge` | 3, 5, 15, 18, 19 | inspect 读固定来源；observe 写观察账本；acknowledge 需精确宿主授权。 |
| 远程 home | `remote-home inspect/issue-cancel-grant/cancel/query` · `remote-export --stdio` · `remote-control --stdio` | 17 | 仅固定 SSH 读取与授权 Graph 取消；未知结果只查询，不重发。 |
| 上下文、记忆与路由 | `attention context/lesson/triage/routing-eval` · `deliver --execution-context FILE` | 7, 20, 21 | 区分离线输入评估与显式真实模型调用；lesson 是草稿，无自动晋升。 |
| 对外承诺 | `follow-up-delivery prepare/list/inspect/issue-grant/authorize/revoke/dispatch/reconcile` | 9, 19, 22 | 发布需宿主 transport、签名授权及精确目标；unknown 不自动重发。 |
| 多 home 升级 | `homes inspect/plan-upgrade/upgrade-status/prepare-managed-installation/apply-upgrade/reconcile-upgrade` | 24 | 仅限受管 launchd 安装。计划不授权安装；apply/reconcile 需精确摘要授权，不回滚数据库。 |
| 文档与交付证据 | `neat check/fix` · `report` · `scorecard` · `proof` · `pr` | 支撑 / support | 文档卫生与已有证据整理；通过不代表真实环境资格或发布成功。 |

## 安全开始

先检查本机版本和命令帮助。开发 checkout 必须使用专用 `OSSTACK_HOME`，不能让开发版 CLI 自动迁移日常服务数据库。下面仅查看帮助，不发消息、不取消任务、不升级服务。

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

`sources acknowledge` 和 source-context 执行还要求 `OSSTACK_HOME` 使用无符号链接组件的真实绝对路径（用 realpath 解析），专用目录本身不代表满足这一条件。worker 视图和游标在 15 分钟或 daemon 重启后过期；远端 `stop_requested` 只表示请求已记录，不是进程已经停止的证明。

Loop 的执行隔离记录保存在工作区外的持久宿主目录：优先使用绝对路径 `OSSTACK_LOOP_CONTAINMENT_ROOT`，否则使用 `$OSSTACK_HOME/loop-containment`，再否则为 `~/.osstack/loop-containment`。若开发 home 位于项目内，必须另配工作区外的 containment root。此目录不打开数据库；改变目录或手动删除记录不等于完成未知执行的核对。

## 常用流程

将占位值替换为真实的已登记范围、仓库和授权。需要 daemon 的命令不会自动启动 daemon。持续 attention 监督需显式启用 `OSSTACK_ATTENTION=1 osstack serve`，并完成范围登记。

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

写操作需分别审阅：`scout promote` 会启动交付；`sources observe` 会写观察账本；`attention answer` 必须携带当前 revision/content hash；`dispatch` 会对外发布；`remote-home cancel` 会请求远端取消；`homes apply-upgrade` 会修改安装。不要把这些当成只读状态命令。授权文件不能由不可信来源文本替代。

## 用 neat 维护这份文档

```sh
osstack neat check --repo /absolute/repo --all --json --fail-on error > neat-report.json
osstack neat check --repo /absolute/repo --base HEAD --schema-version 1 --json > neat-fix-input.json
osstack neat fix --from neat-fix-input.json --json
```

第一条检查文档、指令、链接和配置合同；后两条为仍使用 V1 报告合同的 fix 生成带 diff_id 的兼容输入并预览支持的安全补丁；默认 V2 报告不能直接传给当前 fix。`neat` 不是 README 翻译或任意内容生成器。本次中英文内容根据实际 CLI/源码编写，并用 neat 做前后检查；没有把自动检查冒充功能验收，也没有擅自启用付费语义模型。

## 尚未完成的真实环境资格

真实 GitHub sandbox 投递/正文归一化、跨机 SSH 与断网恢复、tmux/cmux 窗口、launchd 多 home 升级及物理断电、真实模型 holdout/计费/终止行为需独立验证。本地测试和静态审计不替代这些资格；`unknown` 不等于失败后可以安全重试。Graph 仍为 artifact-only，无新增自动 merge/deploy。

## 依据

- [24 capability delivery ledger](../reports/2026-10-24-firstmate-capability-completion-ledger.md)
- [Attention guide](attention.md)
- [Graph operating envelope](../design/2026-10-24-graph-verification-operating-envelope.md)
- [CLI inventory](../inventory/CLI_COMMANDS.md)
- [CLI dispatch and help](../../packages/cli/src/bin.ts)
