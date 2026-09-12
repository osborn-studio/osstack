# Graph Engineering G1 试点验收

日期：2026-09-11。分支：`codex/graph-readonly-pilot`。实施提交：`b3ee430`；研究与原始证据提交：`4b4f596`。

## 结论

首个只读试点已实现：`osstack graph explain` 联查显式任务的控制库状态、运行记录、看板卡片/直接关系，以及指定 Loop 文件中的同 ID 记录。信息带来源、租户/看板范围与覆盖限制，文本和 JSON 均可使用。

这验证了“将已有关系整合成可解释诊断视图”的工程可行性。尚未证明实际定位耗时、成功率或自动调度收益；没有新增图引擎、数据库迁移或自动执行路径。普通卡片链接不能推导阻塞。

当前独立 Loop executor 不保证同步写入控制库，Loop 文件也没有 repo/tenant 身份。第一版只服务控制库已登记的任务，文件绑定始终标为 `caller_supplied_unverified`。解决任务身份与来源贯通，比扩大图遍历更优先。

## 实现与复现

- [使用说明](../graph-pilot.md)：真实输入、部署/离线副本允许范围、JSON 解释和限制。
- [冻结规格及审查补充](../design/2026-09-11-graph-readonly-pilot.md)：先验案例、控制范围和停止条件。
- `packages/cli/src/graph-command.ts`：按需加载的适配器，现有 control-plane guard，SQLite readonly/fileMustExist，LoopState schema 验证。
- `packages/cli/src/graph-command.test.ts`：12 个测试，使用独立临时控制库与固定案例。
- `scripts/verify-graph-pilot.mjs`：构建后真实 CLI 端到端验收，自动创建/清理私人临时数据。

在仓库根目录运行：

```sh
OSSTACK_HOME=/tmp/osstack-graph-pilot-dev pnpm --filter @osstack/cli test
pnpm --filter @osstack/cli typecheck
pnpm exec biome check packages/cli/src/graph-command.ts packages/cli/src/graph-command.test.ts
pnpm --filter @osstack/cli build
node scripts/verify-graph-pilot.mjs
OSSTACK_HOME=/tmp/osstack-graph-pilot-dev LANG=en_US.UTF-8 node scripts/bench-cli-startup.mjs
```

未运行开发 checkout 对真实默认/保留控制库的命令。fixture 的实际数据库路径来自各自 mkdtemp；上面的 OSSTACK_HOME 只是额外隔离环境设置。

## 验收结果

| 检查 | 结果 |
|---|---|
| CLI 完整回归 | 98 个文件，850 个测试通过，其中新试点 12 个 |
| 严格 TypeScript / 新代码 Biome | 通过 |
| CLI 构建 | 通过；主命令只增加 lazy import 与中英文帮助 |
| 端到端对照 | 与独立 SQL/Loop JSON 一致；源 DB 与状态文件 SHA-256 不变 |
| 活动 WAL | 写连接保持打开，读取已提交 WAL 行；主 DB/WAL 字节及 schema version 不变 |
| 范围隔离 | 显式 tenant/NULL、看板、链接两端过滤；SQL 参数绑定；缺失 scoped task 失败 |
| 路径保护 | DB 符号链接与受保护祖先目录均检查；不自动创建缺失数据库 |
| 不完整数据 | 4 MiB 文件界限、每集合 100 条、101 哨兵；Loop 每个类别独立列 total/returned/truncated |
| 状态差异与循环 | 原样保留各来源状态；一跳关系无需拓扑排序，成环不会无限遍历 |
| CLI 启动预算 | version 中位数 30ms / 150ms；help 84ms / 500ms；各 5 次 |

端到端示例单次 155ms，包含 Node/CLI 启动；不是吞吐量或生产延迟承诺。启动预算测量基于本机预热环境，不能外推到所有机器。集合上限不等于数据库查询 CPU 时间上限。

原始摘要与 JSON 示例：[validation.txt](2026-09-11-graph-pilot-evidence/validation.txt)、[startup.txt](2026-09-11-graph-pilot-evidence/startup.txt)、[e2e-example.json](2026-09-11-graph-pilot-evidence/e2e-example.json)。

## Claude Fable 5.1 独立审查处理

使用本地 Claude CLI，明确模型 `claude-fable-5-1`，禁用工具、slash commands、MCP 配置与 hooks；审查仅收到实现/测试/规格文本。不是让审查模型修改代码。模型计量有少量 CLI 辅助 Haiku 调用；主要审查实际计量模型为 Fable 5.1，详见 metadata。

第一轮 [原文](2026-09-11-graph-pilot-evidence/claude-review.md)、[模型与耗时](2026-09-11-graph-pilot-evidence/claude-review-metadata.json)。收到的初版只有 7 个测试；审查期间已补至 11 个，修复后为 12 个。因此原文“未测试”的部分判断应结合最终测试理解。

第二轮 [原文](2026-09-11-graph-pilot-evidence/claude-final-review.md)、[模型与耗时](2026-09-11-graph-pilot-evidence/claude-final-review-metadata.json)：未发现剩余阻塞，要求补充最终新增用例实际运行结果；已由最终 98 个文件/850 个测试（含 graph 的 12 个）通过记录满足。复核未拿到 bin.ts，按需注册方式由本地 diff 检查、构建后的命令和启动预算验证。用户原有 AGENTS.md 修改没有进入本次提交。

| 审查意见 | 处理 |
|---|---|
| dirname(dbPath) 可能绕过受保护 home 子目录 | 默认布局确认为 `<home>/state.db`；由于新命令接受任意路径，仍补上 default/reserved 祖先检查及嵌套备份测试 |
| WAL 副作用与并发写者未测 | 已补持有 writer 的 WAL 测试；文档保留 SQLite 协调副作用说明，不宣称零文件系统副作用 |
| 安装态 allowlist 与离线副本的使用张力 | 补充运行环境矩阵；不放松 guard、不自动允许临时目录 |
| 无效 Loop 仍先打开 DB | 修正顺序；用损坏 DB + 无效 Loop 验证先返回 Loop 错误，无新增 sidecar |
| run_match 基于有限返回集 | 保留 `not_in_returned_runs` 的精确含义和限制，不增加逐记录查询；已测试未匹配 ID |
| 完成记录占满额度会遮蔽其他类别 | 增加每个位置 total/returned/truncated，即使返回 0 条也显示其存在 |
| 101 哨兵条件难读 | 用统一 addMatch helper 收敛计数 |
| 原始 schema 错误缺上下文 | 增加 graph source tables/columns 错误上下文，不要求完全相同 schema version；只检查实际读取所需列 |
| OR 链接查询可能全表扫描 | 改为 scoped task_cards 的父/子两个方向 UNION，复用现有 task/parent/child 索引 |
| tsup 安装路径依赖 | 构建后真实 CLI 已运行；模块输出同层，角色仍来自现有部署流程；安装态授权未用真实生产库演练 |

## 决策

保留为显式、只读、实验性的诊断入口。下一步应收集真实已登记任务的对照案例，并确定独立 Loop 与控制库的身份关联契约。当前结果不构成引入通用图数据库、GraphRAG 或自动 DAG 调度的理由。
