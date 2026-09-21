# Graph Engineering 只读试点

`graph explain` 把同一任务的控制库记录、看板卡片、直接关联卡片和一个指定 Loop 文件放进一份带来源的报告。它适合检查：“任务显示 done，但看板为什么还 blocked，Loop 文件又记录了什么？”

这是实验性 CLI 诊断功能。实现来自 [研究报告](reports/2026-09-11-graph-engineering-research.md) 的 G1，契约见 [实施前冻结规格](design/2026-09-11-graph-readonly-pilot.md)。没有新数据库、迁移、依赖包或调度路径。

## 试跑

在仓库根目录构建并运行完全独立的合成案例：

```sh
pnpm --filter @osstack/cli build
node scripts/verify-graph-pilot.mjs
```

脚本需要 workspace 依赖已安装、`@osstack/core` 已构建。它创建自己的临时控制库和 Loop 文件，验证命令结果与独立 SQL/JSON 基线一致、源文件字节不变，然后清理该临时目录。脚本输出完整 JSON 示例；这是技术验收，不是生产业务效果测试。

对开发工作区自己的数据：

```sh
OSSTACK_HOME=/absolute/private-osstack-home \
node packages/cli/dist/bin.js graph explain \
  --task TASK_ID \
  --db /absolute/private-osstack-home/state.db \
  --board default \
  --state /absolute/workspace/.osstack/LOOP-STATE.json \
  --default-tenant \
  --json
```

所有路径需替换为真实绝对路径；Loop 文件位置由调用方明确选择，不自动猜测。多租户数据使用 `--tenant TENANT_ID` 替代 `--default-tenant`。后者只匹配 SQL NULL，不表示所有租户。省略 `--json` 查看文本；`graph --help` 查看用法。

开发 checkout 不得访问默认或 reserved 控制库；命令保留现有 control-plane guard。生产分析应通过既有受控部署流程，或分析一致的离线备份。活动 WAL 数据库不能只复制主 `.db` 文件当作完整备份。

| 运行环境 | 可分析位置 |
|---|---|
| 未声明角色的开发 checkout | 独立私人目录中的开发数据或一致备份；不能放在 default/reserved home 及其子目录 |
| 已声明角色的安装态 CLI | 角色 allowlist 明确允许的 home；任意临时副本目录不会自动获准 |

路径限制不因只读而解除。`--db` 会解析符号链接并检查受保护祖先；不把复制或硬链接当作可验证的数据身份。

## 如何解释结果

| 字段 | 含义 |
|---|---|
| `task` / `runs` | 当前显式租户中的已存储任务事实及最近运行 |
| `cards` | 当前租户、看板内绑定该 task_id 的卡片 |
| `relations` | 两端均在上述范围内，且至少一端绑定任务的直接有向链接 |
| `loop.matches` | 指定文件里 task_id 相同的完成、进行中、待执行或延迟记录；保留数组位置 |
| `loop.sha256` | 实际读取字节的 SHA-256，便于复查来源 |
| `loop.binding` | 始终 `caller_supplied_unverified`，不认证文件身份 |
| `loop.locations` | 每个 Loop 数组匹配总量、返回量和截断情况；即使该类别没有展示记录，仍能看到它存在 |
| `run_match` | `scoped_run` 仅表示 ID 出现在返回的运行记录；`not_in_returned_runs` 不表示运行不存在 |
| `coverage` / `notices` | 搜索范围、截断、Loop task 缺失或多个 Loop 记录 |

例如 DB task=done、卡片=blocked、Loop=in_progress 可以同时出现。报告保留这三条观察和时间线索，使用者需要核实来源时效性。普通链接不会把 todo 邻居标为 blocked；已有卡片的 `blocked_reason` 才是已记录的阻塞原因。

每个集合最多 100 条，超出即 `truncated: true`；Loop 文件上限 4 MiB。成功返回 0 可以带截断，自动消费者必须检查 `coverage` 和 `limitations`。参数、源文件或 schema 错误返回 1，不创建缺失数据库、不运行迁移。

## 适用边界

1. **需要控制库已登记的任务。** 当前独立 Loop executor 直接调用 adapter 并返回 AgentRun，不能假设会同步插入控制库 tasks/runs；CLI LoopEngine 构造也不提供这种数据库写入连接。因此未登记的 Loop task 会明确报 scoped task 缺失。试点不补建记录、不自动映射相似名称。依据：`packages/loop/src/executor.ts` 的 `executeAdapterPlan`、`packages/cli/src/bin.ts` 的 LoopEngine 构造、`packages/core/src/state/run-store.ts` 的独立 insertTask/insertRun。
2. Loop 文件没有 tenant/repo 身份字段。传入同名任务文件、甚至同 run_id，仍然只是调用者声明的关联；不能用输出作为权限依据。
3. 控制库采用一个只读事务；文件和数据库没有共同快照。数据库事实未携带全量历史，不能反推因果或自动消解状态差异。
4. 只显示当前范围的一跳关系；不覆盖跨看板、跨租户、传递依赖或未记录的影响。空结果不是“没有影响”。
5. readonly SQLite 不修改数据库内容，但可能涉及 WAL/SHM 协调。文件字节和 schema 不变已经过 fixture 验证，不承诺活动文件系统完全没有访问或协调副作用。

## 下一阶段的门槛

先收集真实已登记任务的使用案例，测量人工定位时间、漏看关系和误判率，并与现有查询对照。若主要任务来自独立 Loop，先定义可靠的 task/run 身份与来源绑定，而不是扩大图遍历。只有这些证据支持继续时，才考虑版本化数据血缘或调度依赖；本试点没有证明自动调度的收益。
