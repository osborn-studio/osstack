# Session 采纳试点：剩余缺口交付记录

范围：显式启用的 `adopt_session` 试点。此记录补充原设计账本，不把计划项改写为生产资格。英文操作说明见 [English guide](../guides/engineering-session-adoption.en.md)，中文说明见[使用指南](../guides/engineering-session-adoption.md)。

## 修复的实际问题

1. **来源身份限制被错误解除。** 原回答完成、等待项已清除后，用户可能继续手工操作 Session。若来源身份被替换，再恢复原 native ID，旧实现可能自动退出对账状态。修复读取持久化的身份异常事件，保持该 Mission 的限制，重启也不能解除。原回执仍可查询，用户仍可结束观察。
2. **排空报告早于锁清理。** 原回答回执持久化后，异步清理可能仍未完成，或者物理锁释放失败。修复让 `health`、`daemon.drain` 返回 `execution_lease_holds`，仍持有执行许可时禁止返回 `drained:true`。
3. **准入失败丢失锁责任。** 后置授权失败再遇到释放失败，或锁发布成功后句柄未返回，旧实现仍会释放内存许可。修复保留许可与仓库隔离状态。只有获取函数证明本次尚未发布锁且自有元数据保护已释放，或已证明物理清理完成，才释放本次容量。损坏的外部锁、外部保护目录超时及目录准备失败，不再无依据地占用本次许可。发布开始后结果不明、或清理失败，仍保守保留。没有增加无证明的强制解锁接口。

回归测试使用实际数据库、Git 仓库和物理锁，并通过确定性屏障与故障注入制造失败窗口。保留 RED 和 GREEN 记录。另一名 subagent 用独立复现脚本验证了两个准入失败路径。

既定 ADR-14 保持不变：若后续手工回合已经推进 Session，历史回答证明不能自动把原 Mission 判为完成。可以查询原动作，再明确结束观察。

## 可重复运行的检查

新增 `pnpm smoke:engineering-decision`，并接入 CI。它运行编译后的 CLI 和独立 daemon，验证采纳、观察、延期、回答、完成证明、同键重放及回执查询。成功要求 Adapter 恰好调用一次、daemon 正常退出、临时环境已删除。

该检查使用可控 Adapter，输出 `provider_qualified: false`。失败边界自测覆盖继承环境隔离、启动失败、启动超时、忽略终止信号、命令超时和无效输出。普通 SSD 路径、超长路径及 macOS 默认临时目录均经过验证。

另执行真实 Codex 原生 Session 启动和恢复。使用空的只读仓库、独立控制面目录、真实健康检查；没有伪造 Session、native ID 或健康结果。原生启动产生等待决策后，再由 OSStack 采纳并恢复。具体候选、工具版本、调用次数和证据摘要以同目录的机器账本为准。单次调用成功不代表整个 Provider 已取得生产资格。

## 验证记录

候选代码提交：`64daf4afb55b7f11f9c700fa595d7d91e0766d18`。macOS、Node 22.22.1、pnpm 11.4.0。

- `pnpm test`：22 个包，**5,952 通过、5 条件跳过、0 失败**。另有 smoke 失败边界自测 13 条通过。
- build、typecheck、lint、inventory、changeset、release facts、version self-test、clean typecheck contract 通过。Lint 有既有警告，不把退出成功写成零警告。
- CLI 启动预算：`--version` 中位 46ms，`--help` 中位 110ms。
- 注册表验证：24 项能力、66 个计划场景、37 个计划任务、74 个固定来源哈希及 5 个无效输入夹具通过。结果仅为设计一致性。
- 五个跳过项属于环境/显式开关控制的 Graph 性能、Graph 验证、原生冷启动、在线 Provider 及 active qualification 测试。没有把它们记为通过。
- 真实 Codex 0.160.1 使用 CLI 默认模型，模型未固定。最终候选的 start/resume 各一次，原回合证明和重放通过。脚本与 377 个编译 JS 模块记录哈希，运行前后不变。

一轮真实复验曾因验证脚本把 `needs_reconciliation` 当作终态而提前中止。该轮的源状态诊断未保留，不能追溯底层原因。修正脚本后，只读查询原动作并继续等待，不重发回答；最终候选完整通过。保留提前终止和最终通过两份记录，不以重跑成功掩盖未捕获的中间状态。

首轮整仓测试与后续安全回归修改重叠，出现旧模块与新断言混用，该轮不作为验收依据。固定代码后，从构建开始重新执行完整测试，上述计数来自这一最终运行。

## Claude Code Sonnet 5.5 审计处置

实际使用 Claude Code CLI，要求 `claude-sonnet-5-5`；输出的 `modelUsage` 确认该模型，`is_error` 为 false。审计无工具、无 MCP、无文件修改权限；它是独立静态意见，不是测试执行结果。

| 首轮意见 | 处置 |
|---|---|
| P2：普通获取失败被当作未知发布，永久占用许可 | 由锁原语报告明确的本次未获取证明，不按错误名称猜测。增加实际损坏文件、保护目录超时、所有权错误、目录错误与发布后错误类型伪装回归。 |
| P2：fixture 继承产品 socket 变量 | 使用专用 fixture 变量，保留真实进程环境污染的 RED/GREEN 回归。 |
| P2：真实验证来源不清、提前停止原因未解释 | 校正候选与编译来源；保留失败和后续独立成功。改正验证脚本并保存诊断。未捕获的底层原因仍为 unresolved，不宣称根因已修复或已经取得 Provider 资格。 |
| P3：扫描断言缺阳性对照、清理计数未检查、busy 回调未验证 | 补阳性对照、许可归零、实际回调及明确未知获取测试。 |
| P3：smoke 退出、诊断、预算和升级说明 | 验证健康与排空、正常退出码；保留私有脱敏失败证据；设置命令预算；补充历史身份事件与全局排空语义。 |

第二轮审计覆盖修复后的 `64daf4af`：**PASS，无 P0/P1/P2**。审计时整仓测试尚在运行；随后测试正常退出，最终计数见上文。两类证据分别记录，不把模型意见当作实测。

非阻断技术债继续登记：发布暂存阶段的失败仍保守保留许可（DEBT01）；未知责任的可信人工恢复流程尚缺（DEBT02）；既有手工 `session.send` 可能在回执已应用后返回清理错误（DEBT03）。当前 GovernedExecution 不使用锁原语的 `on_audit`，其审计回调失败后的保守保留仅为潜在接口限制。未提供强制清理或默认启用功能来回避这些边界。

## 任务管理与 main 集成

任务在实际 OSStack 看板 `session-pilot-debt` 中管理。卡片编号、状态及验证记录导出到 [机器交付账本](2026-10-26-session-pilot-delivery.json)。专用管理 home 使用已安装版本，不与开发版测试数据库混用。

检查发现 #253–#258 合入了前置功能分支，未进入 main。#252 的协议层已在 main。六个推广 PR 保留原来已经审阅的源码树：

| 顺序 | PR | 内容 |
|---|---|---|
| 1 | [#259](https://github.com/osborn-studio/osstack/pull/259) | 状态持久化、派发证明、升级保护 |
| 2 | [#260](https://github.com/osborn-studio/osstack/pull/260) | 授权与 daemon 调度 |
| 3 | [#261](https://github.com/osborn-studio/osstack/pull/261) | 七组 CLI 操作 |
| 4 | [#262](https://github.com/osborn-studio/osstack/pull/262) | 能力与场景注册表契约 |
| 5 | [#263](https://github.com/osborn-studio/osstack/pull/263) | 架构设计与实施契约 |
| 6 | [#264](https://github.com/osborn-studio/osstack/pull/264) | 双语指南与历史证据索引 |

本次安全修复见 [#265](https://github.com/osborn-studio/osstack/pull/265)；验证脚本与本报告位于 `codex/session-pilot-verification` 后续独立 PR。六个推广 PR 的全部启用 CI 已通过；付费 DeepSeek 手动检查未运行。每个下游 PR 在前置项进入 main 前保持 Draft；之后必须切换目标为 main，重新检查差异和 CI，再合并。中间层不应单独启用试点。是否已集成，须核对 main 的提交祖先和源码，不能只看 PR 的 `merged` 标签。

## 仍未验证的边界

| 项目 | 现有证据 | 尚缺的证明 |
|---|---|---|
| 真实恢复，WD-19 / WD-33 | 本机 Codex 只读原生 start/resume、原回合证明、同键重放 | 固定模型及完整目标部署配置下的资格矩阵；不能据此宣布全部场景通过 |
| 停止与残留子进程，WD-28 / WD-43 | 本地故障注入保留 `stop_unknown`，未确认锁责任阻止排空 | 受支持进程域、恶意或存活子进程、重启后的退出证明 |
| 人工介入，WD-32 | 数据库与协议回归保持保守对账 | 真实交互 Provider 的外部介入旅程 |
| 在途完成，WD-41 | 可控 Adapter 的时序和原回合事务证明 | 真实 Provider 的受控延迟、取消与传输故障矩阵 |
| Claude controlled adapter | Claude Code CLI 已登录，可作静态审计 | controlled adapter 所需的显式 API 凭据；CLI OAuth 不替代它 |
| 持久性与隔离 | SQLite FULL、本地进程崩溃测试、来源和授权限制 | 物理断电、目标文件系统、恶意同 UID Worker 隔离 |
| 运维与产品闭环 | 单机默认租户、独立租约保留、观察回执 | 非默认租户、多宿主、长期成本、人工介入基线、可信的残留许可恢复接口 |

未知锁责任不会自动重试或强制清除；`daemon.resume` 只恢复接收工作，不清除这些责任。自动选择 Loop/Graph、完整 Mission 控制器和运行时资格注册表仍属于后续阶段。24 项能力并未因此全部成为默认生产能力。

## English summary

This change fixes source identity reconciliation and unsafe drain reports after failed lock cleanup. It adds a bounded CLI-to-daemon smoke in CI and records a separate live Codex native Session journey. Tasks are managed in OSStack. Six promotion PRs repair the missing path to main; downstream PRs must be retargeted to main before merge. Local test success and a live reply do not certify process containment, physical durability, provider qualification or the complete engineering controller.
