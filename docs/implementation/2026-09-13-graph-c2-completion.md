# C2 验收与下一步：Functional 可执行图内核

2026-09-13。**C2 限定准入通过，M0 完成；任务进度仍为 8/30。** 下一批为 G08→G09→G10。生产图运行时尚未实现，G08–G29 保持未开始。

本次继续使用真实 OSStack `LoopEngine → CodexCliAdapter` 执行编码，并联合 Claude Fable 5.1 进行了两轮独立挑战。选择在现有 OSStack 内集成 **LangGraph 公开 Functional API（entrypoint/task）+ durability:sync**，不新增 OSGraph 产品，也不另建一套节点调度器。

## 1. 交付与代码位置

工作区：`/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation`；分支：`codex/graph-runtime-foundation`。

- `8e1c810`：通过独立 worker 入口公开 entrypoint/task；新增恢复和程序身份反例测试。根入口仍保持轻量。
- `b230eb5b51d3dd1e81dfe789f46f22d12b50f2cc`：可复现 C2 故障探针、测试用持久 journal/效果账本与七个 helper 测试。该 commit 是本批验收代码。
- [Functional 内核决定](../design/2026-09-13-graph-functional-runtime.md)、[任务计划](2026-09-13-osstack-graph-upgrade.md)与[机器清单](2026-09-13-osstack-graph-upgrade.tasks.json)已同步约束和下一步。

本批源码只改变 `packages/graph/src/worker-entry.ts`、新增 graph 测试及测试探针；尚未增加生产 daemon RPC、数据库表、worker manager 或编译器。测试 JournalSaver 和效果存储不能直接冒充 M1 实现。

## 2. 为什么 C2 可以关闭

原 G07 发现的 StateGraph 缺陷仍存在：并行节点已写结果，失败却可能中断后续边通知；默认恢复跳过已完成节点，AND join 不执行。原探针和公开 MemorySaver 对照仍保留，`--red-control` 仍退出 1。这里没有宣称修复 StateGraph，也没有修改其私有实现。

Functional API 通过确定性重放编排、复用 task 的持久 RETURN，完成同类并行失败后的结果汇合。未来声明式 GraphSpec 将编译成固定调用次序的注册 task，仍支持明确输入输出、并行汇合、条件路由、有限修复 epoch 与停止规则。编排函数不能直接执行外部效果。

[准入记录](graph-c2-evidence/admission.json)只允许 `langgraph-functional-v1` + `sync` 继续 M1 集成；`productionReady:false`。探针的 `admitted:false` 保持原义：实验断言通过本身不授权生产部署，最终限定决策由本报告和准入记录给出。

固定版本仍为 LangGraph **1.4.15**、checkpoint **1.1.5**、core **1.2.11**。本次核对 registry 与 upstream main，没有可直接采用的新版本修复；未升级 lock，也未通过过滤 ERROR 或合成内部边通知绕过反例。

## 3. 关键验证结果

最终每个运行时各通过 **42 个子进程场景、96 个子进程、26 次实际 SIGKILL、56 组断言**。这些场景包括 StateGraph 失败/修复对照与 Functional 正例，并非 42 个生产能力证明。所有自有工作夹具在子进程退出后清理，独立证据保留。

| 故障或反例 | 实测结果与边界 |
|---|---|
| 并行分支异常、completed RETURN 已持久 | 新进程恢复完整结果；completed 函数不重进，逻辑 join 效果一次。 |
| 外部效果已确认，RETURN 尚未持久 | 函数可以重入查询可信账本；已确认效果只执行一次。不能称函数物理恰好一次。 |
| RETURN 前/后、join 确认前后、最终 checkpoint 前/后强杀 | 恢复完整结果；完成后再次 null resume 不增加效果。 |
| 恢复途中再强杀 | 三个不同进程完成恢复。gated/ungated 切面分别覆盖 join 尚未执行及效果已确认但 RETURN 尚未持久；后者 join wrapper=2、effect=1。 |
| 取消请求、超时、不响应取消 | 保留 invoke 已拒绝而函数仍产生效果的反例；另一场景由父进程 SIGKILL 并等待 close、确认没有晚到输出后才恢复。 |
| 外部效果已开始、确认之前崩溃 | 保持 unknown，拒绝重发并阻断其他新效果；不把这个场景声称为恢复成功。 |
| interrupt 的 false 输入 | 跨进程按 interrupt ID 恢复，false 保持 false；两分支结果复用。 |
| 改参数/改调用顺序 | 绕过身份门时会取旧结果或重进函数；已加入长期回归反例，要求恢复前独立校验程序与 input。 |

每个阶段先保存公开 checkpoint tuple、实际 RETURN、效果账本和调用次数，再启动下一进程。取消进程验证只证明该 worker 退出；daemon 单独启动的命令/agent 仍需后续 broker/Loop 取消与对账。

## 4. 验证与复现

| 验证 | 结果 |
|---|---|
| OSStack 最终验收循环 | 一次执行成功，八条 verifier 全通过；见 [STATE](graph-c2-evidence/acceptance-STATE.md)。 |
| 全仓 Vitest | **2,664 passed**；其中 graph **26 passed**。 |
| 测试夹具 node:test | **7 passed**，覆盖可信结果、未决 run 门、journal 校验与持久失败不复活。 |
| Node 20.6.0 / 20.20.2 / 22.22.1 | 各自完整 C2 矩阵、graph 26 测试和 helper 7 测试通过，执行前后源码摘要一致。仅覆盖本次内核/codec，不代表全产品在每个版本完成原生 DB/发行验证。 |
| Node 26.5.0 | 最终 C2 矩阵及全仓验收通过。 |
| build / typecheck / schema | 全部通过；原 G07 八进程回归通过，失败对照保持。 |
| CLI 启动 | version 中位数 **30ms / 150ms**，help **81ms / 500ms**；各五次。 |
| 代码风格 | graph TypeScript Biome 通过；MJS 被现有 Biome 配置忽略，以实际测试和语法检查验证，未伪称 MJS lint 通过。 |

在已安装依赖、完成 build 的实施 worktree 中运行：

```sh
node scripts/graph-test-env.mjs -- node scripts/probe-graph-c2.mjs
node --test scripts/fixtures/graph-c2-*.test.mjs
pnpm --filter @osstack/graph test
```

探针自行分配独立工作目录和证据目录；若设置 `GRAPH_C2_EVIDENCE`，应指向新的实验目录。完整验收命令记录于 [acceptance.mjs 快照](graph-c2-evidence/acceptance.mjs.txt)，使用显式隔离 OSSTACK_HOME。未打开默认或保留的控制面 DB。

早期跨版本验证时源文件仍变化，未计入最终准入。一次 harness 的 Vitest 路径错误修正后重跑，原日志保留。最终证据见 [runtime-final.json](graph-c2-evidence/runtime-final.json)、[源码摘要](graph-c2-evidence/source-sha256.json)和[证据索引](graph-c2-evidence/README.md)。

## 5. Claude 的挑战如何改变实现

Claude 第一轮认为只能固定 checkpoint 重放整个步骤；主执行者用 Functional API 正例反驳其遗漏，第二轮 Claude 修正判断，并提出缓存证据、恢复二次崩溃、取消退出及程序身份等缺口。最终补齐了可执行验证。

Claude 关于 ERROR 必须恢复为 Error 类的建议不采纳：固定版本实际写入普通 name/message 对象，当前 codec 应继续拒绝任意类恢复。关于 async 文件夹具不足以证明延迟 RPC 的意见采纳，所以只准入 sync。两轮真实模型记录、原审查与逐项处理见 [审查归档](graph-c2-evidence/review-adjudication.md)。审查不是对最终字节的模型签名，主执行者对最终代码和验收负责。

## 6. 下一批 G08–G10

1. **G08：图身份与 worker 代际。** 持久不可变 executionModel、engine/checkpoint/registry/compiler/schema 版本、input/spec/compiledProgramDigest；恢复不匹配拒绝，不能让旧 checkpoint 随新代码重解释。
2. **G09：共享仓库锁。** 同一可信仓库跨 worktree 归一，复用既有 writer 租约，避免 Loop/Graph 各有独立锁。
3. **G10：共享准入。** 将 daemon 的既有策略、资源和授权接到可复用边界；不从 checkpoint/receipt/模型输出推导权限。

随后 G11–G17 交付真正的账本、持久 Saver、worker/broker 和可恢复执行链；G18 编译有界工程图。G13 必须等待 daemon 持久 ack，G14 固定 sync 并确认退出，G17/G25 使用真实接口重跑本次故障位置。这些义务已写入任务验收标准，尚未标完成。
