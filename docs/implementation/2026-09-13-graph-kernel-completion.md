# OSStack G05–G07 实施验收与接续

> 后续进展：C2 已在 [Functional + sync 验收报告](2026-09-13-graph-c2-completion.md)中限定通过。本报告保留 G05–G07 当时的失败结论及证据。

日期：2026-09-13（America/Los_Angeles；部分日志 UTC 日期为 09-14）。

**本批 G05–G07 已实现并完成卡片验收，总计 8/30；C2 内核准入未通过，M0 尚未整体闭门。** 本批不是生产图运行时交付。G07 按计划允许用“最小反例和替代评估”完成可行性验证，我们确实发现了不能忽略的恢复缺陷。

实施工作区：`/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation`。分支：`codex/graph-runtime-foundation`。已验收代码：`c1f461992a5967bbb9055f78f8e2cb648599d5c9`。原 `osstack` 检出仅同步规划/验收文档；继续编码必须切到上述工作区。没有 merge、push、部署或使用默认控制面 DB；原检出的用户 `AGENTS.md` 改动保留。

## 1. 已交付能力

| 任务 | 实际交付 | 边界 |
|---|---|---|
| G05 | 版本化严格 GraphSpec/状态/预算/结果/错误/请求与 worker action 契约；JSON 边界；稳定摘要/effect identity；可信传输上下文、scope/run/generation/spec/epoch 检查；请求响应配对及幂等/revision 纯判断 | 不是认证服务、原子账本或生产 CAS。可信身份须由未来 daemon 的真实连接/租约解析。 |
| G06 | 新 `@osstack/graph`，根入口只含描述符和擦除的类型导出；显式 `./worker` SDK 入口；固定依赖与包边界、加载成本、打包检查 | worker 生命周期、IPC、broker、DB 未实现。daemon 不加载重内核；core 不依赖 graph。 |
| G07 | 无私有类恢复的受限 checkpoint codec，显式 `./codec`；公开 Saver 的完整方法/字段实验；八个独立进程验证持久数据、pending writes、interrupt/resume 与历史读取 | 文件 Saver 是单写者测试门面；任意故障恢复未获准入。保留 partial-abort 反例。 |

代码提交：`4da954c`（G05 首版）、`8f94aa9`（首轮协议审查修正）、`864c031`（G06 包边界）、`c1f4619`（G07 与最终审查修正）。原 G00–G04 验收见 [历史报告](2026-09-13-graph-foundation-completion.md)。

### G05 的关键约束

- 不可信输入严格解析为 JSON 数据；拒绝访问器、代理、任意类、原型污染字段、非有限数与超界值。入站传输仍须在 JSON.parse 前限制实际报文字节。
- 业务摘要保留数组顺序和嵌套业务字段，只排除指定根 metadata/幂等键。effect identity 不含 worker generation，logicalAttempt 由未来账本分配。
- Worker 不能发起 start/resume/cancel；动作请求绑定可信 run/generation/spec/epoch。相应纯辅助函数不能代替真实身份认证与原子状态变更。
- 未知执行与取消未确认要求 reconcile，不得标确定 failed 或自动 retry。声明结果仍须由未来 broker/产物存储验证，模型不能自行证明候选 SHA/测试通过。
- 生成 JSON Schema 保持 Zod3；相关结构约束和错误联合同步生成。字节/深度与跨字段/身份检查仍有额外运行时责任。

### G06 的固定边界

固定 `@langchain/langgraph 1.4.15`、`@langchain/langgraph-checkpoint 1.1.5`、`@langchain/core 1.2.11`，并保存 registry 元数据与 pnpm lock。Graph 的生产依赖闭包为 35 个包实例，包含一个 LangGraph，没有 better-sqlite3、loop/core/cli/agents。optional peer 缺失不伪装为必需依赖失败。

根入口新进程只加载自身一个文件。G06 五次非插桩测量：Node20.20.2 根入口中位 2.71ms / worker 111.81ms；Node22.22.1 为 2.36ms / 156.37ms。这是 G06 阶段采样，不冒充最终 worker 字节的精确延迟；最终根隔离回归与 CLI 预算再次通过。最终 worker 另导出 interrupt、Command、BaseCheckpointSaver；codec 独立入口只需 node:util。

包运行时地板明确为 Node ≥20.6.0；开发工具 pnpm 11.4.0 自身要求 Node ≥22.13。Node20/22 运行时测试直接用对应 Node 启动 Vitest/探针。没有顺手升级全库 Node 声明。打包清单确认三个入口、声明文件及 License，排除测试文件；实际工作区裸包导入通过。未发布 registry，也未把工作区导入冒充独立安装 tarball 的集成验证。当前打包会解析 protocol 为尚待版本发布的 0.15.0，正式发行须执行 changeset 和 G27 的兼容/发行门。

## 2. C2 未准入的原因和下一步

正向实验中，`completed` 的整个写入批次（含 AND barrier 通知）持久化后，再让 `flaky` 失败。新进程恢复得到调用计数 **completed=1、flaky=2、join=1**，结果包含全部三项；完整成功兄弟节点没有重复执行。

**反例：** 同一并行图让 flaky 立即失败，另一节点可能先写入结果，随后在写入 join 通知之前被 abort。checkpoint 中留下该节点结果与 AbortError。恢复时该节点被当作缓存结果，缺失通知未重建，最终 **join=0**。未修改的官方 MemorySaver 也能复现，不能把原因推给 JSON 文件转换。保留的反例目前是在同进程 faults 子例中触发；正向恢复是独立进程。没有泛化为所有崩溃排序均已测试。

这意味着“已有输出”不足以证明“节点完整结束”。Probe 的 `passed: true` 表示实验断言全部符合观察，包含对缺陷的确认；**`productionReady: false` 始终保留**。测试全部通过和生产内核准入是两个结论。

下一轮先完成 **C2 复核**：

1. 保留现有失败图、持久 Saver 与官方 MemorySaver 对照，验证可用的公开修复或显式完成凭据方案。不得改私有引擎或伪造缺失 barrier。
2. 目标断言改为真正恢复完整图：join 恰好一次、完整结果、完整成功节点不重跑；部分输出不被误认完成。
3. 加入输出已写/完成通知未写、超时、异常、worker 退出的独立进程窗口。外部动作仍须服从后续 ledger 去重/unknown 对账，不能用盲目重跑规避。
4. 公开接口不能满足时，用相同矩阵评估有限静态调度器；ADK 是待实验的候选，不假定天然解决持久恢复。
5. 更新 [Saver 决策](graph-saver-decision.md)、计划和机器清单，关闭 C2 后进入 **G08→G09→G10**。C2 之前不直接做 G18 业务模板，也不启用生产图执行。

预期业务失败由公开节点包装成结构化数据值得继续，但单独这一点不能证明取消、异常或进程死亡的安全恢复。C2 是实现发现导致的明确计划修订，不是需要用户批准的破坏性操作。

## 3. 实际使用 OSStack 和 Claude 的证据

本批确实通过已有 **LoopEngine + CodexCliAdapter** 下发 G05、G06、G07；三次均为 sources: []、仅一个指定 inputTask、一次迭代，最终 outcome=success。使用精确工作区 policy gate、workspace-write 编码沙箱和独立临时 OSSTACK_HOME。

控制器的 Loop 基线为 `360e226`；每卡加载前面卡片编译出的协议/依赖，所以该字段不是“所有依赖始终同一字节”的声明。Loop 自动记录的 changed_files 是共享工作区快照，含主管文档变更；也不能据此把所有列出的文件归因于编码执行者。其 commit_hash 是运行时 HEAD，执行者不提交代码。最终已验收字节由 [SHA256 清单](graph-kernel-evidence/accepted-source-sha256.json) 绑定到 `c1f461992a5967bbb9055f78f8e2cb648599d5c9`。

最后再用真实 LoopEngine 执行一次验收任务：一个 inputTask、一次执行，运行恢复探针及六个验证命令，成功完成。见 [验收状态](graph-kernel-evidence/acceptance-STATE.md)、[结果 JSON](graph-kernel-evidence/acceptance-result.json) 和 [控制器快照](graph-kernel-evidence/acceptance-controller.mjs.txt)。这证明 OSStack 被用于本次开发，不代表新 Graph 自举生产链已经实现。

**Claude Fable 5.1 两轮文本对抗审查**有实际调用和模型元数据。第一轮提出八项边界问题；第二轮提出六项可行动意见，部分已经在输入快照之后修复。主管逐项复现、裁定和收口，没有将文本审查当成模型亲自跑测试。见 [处理记录](graph-kernel-evidence/review-adjudication.md)、[第一轮](graph-kernel-evidence/claude-g05-review.md)、[第二轮](graph-kernel-evidence/claude-final-review.md)。模型调用元数据保留其 CLI 辅助分类调用记录，主要审查模型确认为 claude-fable-5-1。

主管独立发现并修复字节数组 getter 和 list 运行时配置投影问题。第一轮协议 RED 为 8 项失败＋1 项已安全对照；第二轮新增 3 项协议失败与 1 项 BOM 失败，再转 GREEN。还保留 schema 未重新生成时的真实 freshness 失败，随后生成并通过，避免把所有中间尝试描述为成功。

## 4. 最终验证

| 验证 | 实际结果 |
|---|---|
| 全工作区测试（串行包、每包至多两个 worker） | **22 个包，2,661 项测试通过**；含 protocol 206、graph 23 |
| 全工作区 build | exit 0 |
| 全工作区 typecheck:check（build 后） | exit 0 |
| protocol check:schemas | exit 0；独立 JSON Schema 验证器另验证 11 个正/负场景 |
| 公共 Saver 探针 | **8 个独立子进程、26 项断言**，owned fixture 清理成功；包含已知反例，productionReady=false |
| Node20.20.2 / Node22.22.1 | 各自 protocol 206 / graph 23 项测试及 26 项探针断言通过 |
| Node20.6.0 最低版本 | 实际图 smoke 与完整 8 进程探针通过；没有宣称整个 OSStack 全套在此版本通过 |
| SQLite 12.10.0 Node20/22 | 各自临时安装原生绑定，独立内存库写读通过；非完整 DB 迁移矩阵，Graph 无 SQLite 依赖 |
| CLI 启动预算 | --version 中位 **28ms**（预算150）；--help **76ms**（预算500），各5次 |
| 受改文件 Biome / git diff --check | exit 0 |
| 锁文件/包表面 | frozen offline lock 检查通过；tarball 入口和类型清单与工作区裸包导入通过 |

最终全量测试前源代码已完成审查修正；之后仅提交和更新文档。早一次验收属于修改前快照，留在临时证据中，没有用作最终源验收。最终日志见 [证据索引](graph-kernel-evidence/README.md)。文本归档仅去除尾随空白/补末尾换行，归档记录说明哪些文件经过格式规范化；不把归档后的文本哈希冒充原始日志哈希。

## 5. 未交付内容

G08–G29 仍待实施：生产图身份/worker lease、账本、可信准入、DB checkpoint、RPC、worker 管理、外部动作对账、产物冻结、完整静态图、并行验证与汇合、CLI 执行入口、故障矩阵与内部试点。OSBot、OStag 的功能/部署没有改动。

本批既推进了可执行图的真实接缝，也提供了停止错误路线的实验依据。接续必须优先关闭 C2，而不能因为任务卡勾选完毕就跳过这个发现。
