# Firstmate 能力在 OSStack 中的命令手册

[English](firstmate-commands.en.md) · [中文 README](../../README.zh.md)

核对日期：2026-10-25（北京时间）。本手册描述 PR #244 及前序依赖分支的源码接口，不保证已进入 main、npm 或你的已安装版本。24 项是能力映射，不是 24 条独立命令，也不是完整逐行复制 Firstmate。

## 按任务选命令

| 任务 | 命令（均以 `osstack` 开头） | 能力编号 | 行为与边界 |
|---|---|---|---|
| 监督与决策 | `attention status/watch/inbox/get/answer/recovery` | 1–9 | 持续观察、等待责任与绑定版本的回答；快照不证明进程存活。 |
| 简报与低打扰 | `attention brief/cockpit/posture/seen/foreground` · `daily` · `cockpit` | 1, 10, 11 | 按用户和范围组织增量信息；away 不扩大权限。 |
| 回合与监督登记 | `attention handoff/turn-end/claude-hook/loop/ci` | 5–7 | 显式登记和已验证 hook；没有通用离线 watchdog。 |
| 调查转交付 | `scout inspect/promote` · `deliver` · `start` · `control` | 12, 23 | inspect 只读已提交文件；promote 重新绑定当前策略与 HEAD，启动 guarded-local。 |
| 验证与保全 | `graph validate/run/status/cancel/resume` · `loop enqueue/run/status` | 2–4, 13, 14, 23 | Graph 多检查交付 artifact；停止不明时保留工作树与恢复证据。 |
| 工作进程视图 | `worker list/inspect/watch/open/logs` | 16 | 观察器不控制执行；logs 需独立授权，只读持久 assistant 文本。 |
| 来源与连续性 | `sources inspect/observe/events/acknowledge` | 3, 5, 15, 18, 19 | inspect 读固定来源；observe 写观察账本；acknowledge 需精确宿主授权。 |
| 远程 home | `remote-home inspect/issue-cancel-grant/cancel/query` · `remote-export --stdio` · `remote-control --stdio` | 17 | 仅固定 SSH 读取与授权 Graph 取消；未知结果只查询，不重发。 |
| 上下文、记忆与路由 | `attention context/lesson/triage/routing-eval` · `deliver --execution-context FILE` | 7, 20, 21 | 区分离线输入评估与显式真实模型调用；lesson 是草稿，无自动晋升。 |
| 对外承诺 | `follow-up-delivery prepare/list/inspect/issue-grant/authorize/revoke/dispatch/reconcile` | 9, 19, 22 | 发布需宿主 transport、签名授权及精确目标；unknown 不自动重发。 |
| 多 home 升级 | `homes inspect/plan-upgrade/upgrade-status/prepare-managed-installation/apply-upgrade/reconcile-upgrade` | 24 | 计划不授权安装；apply/reconcile 需精确摘要授权，不回滚数据库。 |
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
