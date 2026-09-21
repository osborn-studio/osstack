# OSStack：按任务选命令

[返回 README](../../README.zh.md) · [Graph 完整参数](graph-quickstart.md) · [生成的顶层命令清单](../inventory/CLI_COMMANDS.md)

本页是常用参数导航，完整选项以当前安装的 `osstack --help`、`osstack <command> --help` 为准。main、npm、内部安装和单文件渠道可能不同；源码 CLI 一律设置独立 OSSTACK_HOME。

| 你要做什么 | 入口 | 关键参数 / 后续 |
|---|---|---|
| 检查工作区 | `osstack doctor --workspace .` | `osstack examples` 查看示例 |
| 一次编码交付 | `osstack deliver "任务" --verify "pnpm test" --auto-agent --worktree --json` | 会执行 agent 和验证；检查交付证据 |
| 循环处理任务 | `osstack loop enqueue "任务" --workspace . --capability code.test` | 入队后使用 loop run；enqueue 本身不完成任务 |
| 运行队列 | `osstack loop run --workspace . --source task_queue --verify "pnpm test" --report --scorecard --proof --json` | agent 用 `--agent ID` 或 `--auto-agent` 选择 |
| 固定工程图 | `osstack graph run --request FILE --json` | 先配置 host、scope、spec；见 Graph 手册 |
| 知识/文档整理 | `osstack neat check --repo . --all --fail-on none --json` | 只读审计，不自动重写 README 或代码 |
| 审计变更合同 | `osstack neat check --base origin/main --fail-on warning --json` | CI 严格门禁；与全仓检查范围不同 |
| 查看 neat 修复计划 | `osstack neat fix --help` | fix 默认预览；显式 apply 仍受策略/审批限制 |
| 需求澄清 | `osstack probe --help` | 显式 session 生命周期，不后台自动开始 |
| agent 与配置 | `osstack agent list`、`osstack config doctor` | 查看安装/登录/可用性；不要将 API key 写进配置库 |
| 权限与合同 | `osstack policy check`、`osstack start "目标" --repo-id ID --json` | control inspect/approve/revise/stop 管合同；批准不等于自动执行 |
| 运行证据 | `osstack report --help`、`scorecard --help`、`proof --help`、`pr --help` | 报告、评分、证据包、PR 草稿/操作 |
| 常驻服务 | `osstack serve`、`osstack health --json` | `autonomy health --json` 另查写入准入 |
| 会话接续 | `osstack session --help` | start/snapshot/send；重复发送受幂等与版本约束 |
| 看板与面板 | `osstack cockpit`、`osstack dashboard`、`osstack kanban --help` | bot transport 需外部接入，不是内置完整 OSBot |
| 多仓库运营 | `osstack supervise --help`、`osstack daily --json` | repo registry、成熟度、每日简报 |
| 知识检索 | `osstack knowledge --help` | 本地/云知识包、搜索、审阅与同步 |
| 发布检查 | `osstack release --help` | doctor/status/plan/handoff；readiness 不能替代实际发布核验 |

## Loop 常用参数

| 参数 | 含义 |
|---|---|
| `--workspace P` | 工作目录，默认 cwd |
| `--source S` | 可重复；task_queue、git_diff、github_branch |
| `--agent ID` / `--auto-agent` | 指定 adapter / 按路由策略选择 |
| `--profile P`、`--role R=ID` | 配置 profile；角色覆盖 coder/evaluator/designer，可重复 |
| `--execute CMD` | 每个任务运行的 shell 命令 |
| `--verify CMD` | 可重复；非零退出表示验证失败 |
| `--reviewer ID` / `--checker ID` | 可重复的 adapter 验证器；checker 为别名 |
| `--max-iter N` | 升级处理前的迭代上限，默认 1 |
| `--max-runtime-ms N` | 总运行时间预算，单位毫秒 |
| `--max-tokens N` / `--max-cost-usd X` | 按 adapter 上报 token/费用限制 |
| `--command-timeout-ms N` | execute、verify、goal 的命令超时 |
| `--no-progress-limit N` | 连续执行任务却无成功时停止，显式启用 |
| `--goal CMD` | 命令退出 0 则达到全局目标 |
| `--cycles N`、`--stop-when-idle` | 有限循环 / 首次无可执行任务停止 |
| `--worktree` | 每任务独立 Git worktree，成功后合并回去；与 Graph artifact_only 不同 |
| `--report --scorecard --proof` | 生成报告、评分卡、证据包 |
| `--govern strict --govern-scope changed` | 对变更范围执行严格治理 |
| `--neat-finalize` | 成功后附加不阻断的 neat 证据 |
| `--json` | 机器可读汇总 |

daemon 轮询使用 `loop start`，`--interval-ms` 默认 5000；`--once` 等价于 start 的 `--cycles 1 --stop-when-idle`。`loop list` 查看会话，`loop stop ID` 停止，`loop status --workspace .` 查状态。

## neat 应该怎么用

`osstack neat` 默认是 `neat check`，检查规则、文档引用、预算与知识合同；它不是无条件删除旧文件或自动格式化整个仓库的命令。全仓检查用 `--all`，默认 worktree 只覆盖变更相关范围。退出码是否阻断由 `--fail-on none|error|warning` 决定，退出 0 不代表没有 warning。

先阅读 finding 和 coverage，再决定修正。语义审计使用显式 `neat semantic` 并需要隔离 judge provider；修复事务有计划、审批与应用边界。完整流程见 [neat 指南](neat.md)。
