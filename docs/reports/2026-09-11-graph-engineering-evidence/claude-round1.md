## 结论

**建议：不要新增独立的"图引擎"包，也不要引入 LangGraph 类运行时。** osstack 已经在四个互不相通的位置各自实现了图的局部（PR 依赖 DAG、跨仓依赖边、状态机、事件日志），真正的缺口不是"没有图"，而是**任务层没有依赖边、事件层没有因果指针、两份拓扑排序代码重复**。推荐首个 pilot 是在 `@osstack/loop` 的 Task 上加可选 `depends_on`，并让循环引擎按拓扑序执行，其余能力按 go/no-go 指标再决定。

以下"事实"均为本次读源码核实；"提案"为我的建议，未经实现验证。

## 一、现状盘点：osstack 里已经有哪些图

**1. 任务组织：任务是扁平列表，执行严格串行。**
事实：`packages/loop/src/types.ts:27-40` 的 `Task` 只有 task_id、capability、prompt、priority、source、context、evaluation，没有任何依赖字段；跨进程契约 `packages/protocol/src/task.ts:24-44` 同样如此且为 `.strict()`。发现阶段只按 priority 降序排序（`packages/loop/src/discover.ts:77,194`）。循环引擎 `packages/loop/src/loop-engine.ts:486-506` 用一个 `for (const task of tasks)` 顺序 `await this.runTask(...)`，没有并发也没有依赖判断。`planner.ts:11-20` 只是把 Task 包成 ExecutionPlan，没有分解。
含义：README 中"Task Organization"那一族（LLMCompiler、Plan-over-Graph、DynTaskMAS）所解决的"并行/依赖调度"问题，在 osstack 的 loop 层完全不存在对应结构。

**2. 已经存在两份独立的 DAG 实现。**
事实一：`packages/core/src/kanban/repository.ts:298-387` 在 `kanban_card_links` 表（`packages/core/src/state/migrations.ts:196-202`）之上实现了 `link/unlink/linksForBoard/topoOrder`，后者是带确定性 tie-break 的 Kahn 算法，环检测抛 `CardCycleError`。
事实二：`packages/github/src/stack.ts:141-200` 从 PR 的 base/head 重建边，再用另一份 `topoOrderBottomUp` 做 Kahn 排序。
消费者：`packages/cli/src/stack-cli.ts:198` 把 PR 边写入 kanban links，`:464` 与 `:575` 用 `topoOrder` 生成 runbook 和 retro。`docs/superpowers/plans/2026-07-11-osstack-r0-r1.md:23` 已把"PR DAG"标记为 implemented。
含义：图能力已存在，但被绑死在"PR 合并栈"这个单一业务上，且 loop 层的 Task 与 kanban 的 Card 之间只有一个可空的 `task_id` 外键（`migrations.ts:177`），没有把 card 之间的依赖反向投影到任务调度。

**3. 状态管理：三套显式状态机，事件日志有序但无因果。**
事实：自治运行有 `LEGAL_TRANSITIONS` 表和终态集合（`packages/autonomy/src/state-machine.ts:20-91`）；kanban 有 `isLegalCardTransition` 加并发评估、失败即关闭的 guard 机制（`packages/core/src/kanban/transition-guard.ts:42-78`）；依赖义务有 candidate→advisory→promoted 的 FSM，并带 `if_revision` 乐观锁（`packages/governance/src/knowledge-hygiene/dependency.ts:228-262`）。
事件层：`events` 表以 `(run_id, seq)` 唯一（`migrations.ts:52-64`），`EventEnvelope` 字段只有 event_id/seq/run_id/session_id/created_at/terminal/type/payload（`packages/protocol/src/event.ts:13-29`），**没有 parent_event_id 或 caused_by**。`kanban_card_events` 亦然。只有依赖义务事件带 `from_state/to_state/snapshot_json`（`packages/core/src/state/dependency-obligation-store.ts:25-75`），是仓内最接近"可回放状态图"的结构。
含义：README "State Management" 里 The Log is the Agent、AgentGit 那类"可分叉、可归因"的能力，前提是事件间有因果边。osstack 目前只能按 seq 回放，不能回答"这个失败由哪个决策导致"。

**4. 代理协调：能力路由 + 角色证据，而非通信拓扑。**
事实：`packages/core/src/orchestrator/router.ts:8-12,70-120` 是按 capability_id、cost_tier 逐条匹配的规则路由，agent_id 覆盖时 fail-closed。角色关系（builder/evaluator/designer 及独立性判定）只作为证据记录在 `LoopProfileRoutingEvidence`（`packages/loop/src/types.ts:452-475`）。并发由 `FifoSemaphore` 按机器与按仓库两级限制（`packages/autonomy/src/semaphore.ts:22-60`；`packages/cli/src/daemon.ts:208-212`）。
含义：这是一个"星型、单跳"的协调模型。README 中 G-Designer、AgentPrune 那类"通信拓扑优化"在 osstack 当前的产品形态（人类拥有 policy、少量 CLI 代理）下没有对应问题域，不应作为集成方向。

**5. 知识与记忆：来源可追溯，但"替代关系"没有边。**
事实：`memory_facts` 有 `status IN (active, superseded, archived)`（`migrations.ts:106-123`），`supersedeFact` 只改状态，不记录被谁取代（`packages/core/src/state/memory.ts:108-120`）。`pitfall_lessons.source_run_ids_json` 以 JSON 数组存来源（`migrations.ts:243-257`）。supervisor 的 trace_id 由 repo/task/run/outcome 哈希得出，assetizer 注释明确"provenance is non-negotiable"（`packages/supervisor/src/trace-normalizer.ts:62-76`；`assetizer.ts:1-3`）。知识包在 official/external 场景强制 `source_provenance`（`packages/knowledge/src/pack.ts:146-149`）。`EvidenceRef` 是统一的证据引用契约（`packages/protocol/src/evidence.ts:10-32`）。
KG 本身被有意外包：`packages/core/src/kg/gbrain.ts:1-10` 说明 osstack "delegates KG duties to gbrain"，仅在 `daemon.ts:3386` 以 best-effort 写一页 markdown。
含义：osstack 已经有大量"节点级 provenance"，缺的是"边"：事实间的 supersedes、教训与运行的引用、证据与结论的支撑关系，目前都以 JSON 数组或状态字段扁平存放，无法做图遍历。

**6. 已经存在一个真正的"类型化、带证据、有生命周期的边"体系。**
事实：跨仓依赖候选边 `khc_`→义务 `kho_`→声明边 `khe_`，边类型闭集 api/sdk/env_name/url/symbol/path，每条边必须携带 `evidence_refs`，方向固定为 depends_on，并在 YAML 中人工确认且有 `review_after`（`dependency.ts:27-34,264-279`；`packages/governance/src/knowledge-hygiene/config-v2.ts:117-155`）。
含义：这是 osstack 自己长出来的"图工程"样板：边不是 LLM 猜的，是扫描出来、证据绑定、状态机治理、人类签核的。任何新图能力都应复用这套纪律，而不是另起一套。

## 二、集成点、风险与反对意见

**高价值集成点（提案，按价值/成本排序）**

1. **loop Task 可选 `depends_on: string[]`，引擎按拓扑序执行。** 归属 `@osstack/loop`（types.ts、loop-engine.ts）。复用 kanban 的 Kahn 实现思路，但不能直接依赖 `@osstack/core` 的 KanbanRepository，因为它绑定 SQLite。应把纯函数拓扑排序抽到无副作用模块。
2. **抽出一个纯函数 `topoOrder(nodes, edges, tieBreak)`，替换 `repository.ts:345-387` 与 `stack.ts:166-200` 两份实现。** 归属建议放 `@osstack/protocol` 之上、`@osstack/core` 之下的无依赖位置；若不想新建包，放 `@osstack/core` 并让 `@osstack/github` 复用。这是零功能变更的去重，可独立于任何图决策先做。
3. **事件因果指针。** 在 `EventEnvelope` 加可选 `caused_by?: string`。风险：protocol 是 `.strict()` 且明言"until a second consumer exists"不扩（`event.ts:3-6`），且 `EvidenceRefLenient` 的深度宽松策略只对 evidence 做了（`evidence.ts:34-40`）。需要先走 protocol 版本流程，不是随手加字段。
4. **memory_facts 加 `superseded_by` 列。** 归属 `@osstack/core/state`，一次迁移即可，把"替代"从状态变成边。

**重复与冲突风险**
- 若在 loop 层引入独立的任务依赖存储，会与 `kanban_card_links` 形成第二份真相，而 `stack-cli` 已在 links 上运行 runbook/retro。任何 Task 依赖必须要么投影到 kanban links，要么明确声明"loop 依赖是进程内瞬态、kanban 依赖是持久业务"，二者不能同名同义。
- protocol Task 与 loop Task 目前字段镜像（`protocol/task.ts:2-9` 明言"mirror"）。loop 加 `depends_on` 后 protocol 若不同步，`protocol-mappers` 会静默丢字段。
- gbrain 已被定为 KG 归属方（`gbrain.ts:4`）。若 osstack 内建知识图，等于推翻 v0.6 D20 决策，需要显式 ADR。
- 依赖义务体系已使用 `edge_id` 命名空间 `khe_`。新图的边 ID 需避开该前缀空间。

**失败模式（提案）**
- 环：Kahn 在 loop 中遇环应 fail-closed 并把整批任务转为 deferred，而不是退化为优先级顺序。
- 半完成的依赖链：父任务 escalated 后子任务永远 pending，需要定义"父任务终态非 success 时子任务如何标记"，现有 `LoopState.pending`（`types.ts:390-391`）没有这种语义。
- 跨 cycle 依赖：任务队列是文件目录（`task-queue.ts:45-56`），依赖目标可能已归档，需要引用消解。
- 性能预算：AGENTS.md 要求 loop tick 开销低于 1%，图算法在每 tick 重算要有规模上限，可参照 `dependency.ts:332-334` 的显式 MAX 常量做法。

**反对新增图系统的强论点**
- 现有运行时的核心价值在 fail-closed 治理（policy gate、transition guard、scoped approval、evidence-bound obligation），不在调度智能。图系统增加的是表达力，而表达力是治理面的敌人：每多一种边就多一种绕过路径。Kimi 自治审计已发现多条状态机旁路链，图会放大这个面。
- 真实任务源是 git_diff、gh_issue、ci_log 和文件队列（`types.ts:16-23`），这些来源天然扁平。没有证据表明当前工作负载存在足以受益于并行 DAG 调度的宽度。
- gbrain 外包决策、依赖义务的"人工确认边"设计都表明项目方向是"少建图、多验证边"。README 的 Ontology Engineering 一节所推崇的共享语义层，osstack 已经用 zod 闭集枚举实现了一个轻量版本。
- 两份 Kahn 实现总计不到 100 行且各有测试。重复的绝对成本很低，去重的动机应是准备复用，而非纯洁癖。

## 三、最小增量架构、评估门与首个 pilot

**最小增量架构（提案）**
不新建包。第一步只在 `@osstack/loop` 内：`types.ts` 的 Task 加 `depends_on: z.array(z.string()).optional()`；新增纯函数模块负责拓扑排序与环检测；`loop-engine.ts` 的执行循环改为按排序后顺序执行，遇父任务 outcome 非 success 则子任务写入 deferred 并 emit 一个新事件类型。protocol 侧同步加可选字段并走版本号。kanban links 暂不改动。gbrain、memory_facts、事件因果全部推后。

**可测量的 go/no-go（提案）**
- Go 条件一：抽样最近若干个 loop 周期的 task_queue 文件，若存在被人工按顺序排队、且注释或 prompt 中出现"after/depends/先做"类文字的任务对，占比达到可感知水平，说明隐式依赖真实存在。
- Go 条件二：pilot 落地后，因为顺序错误导致的 verify 失败或 escalate 数量下降，可通过 `CompletedTask.outcome` 与 `iteration_feedback` 统计。
- No-go 条件一：pilot 之后被使用的 `depends_on` 字段在一个评估周期内为零。
- No-go 条件二：loop tick 开销超出 AGENTS.md 的 1% 预算，或 CLI 启动预算被新导入拖慢。
- 独立于 pilot 的去重工作：两份 Kahn 合并后现有测试全绿，即为完成。

**首个 pilot**
"loop 任务显式依赖 + 拓扑执行"，范围限定在 `task_queue` 来源的任务，git_diff 等扫描来源不生成依赖。理由：它落在已存在的顺序执行路径上，改动局限于一个包，与 kanban 的持久 DAG 不冲突，且 go/no-go 可以只靠现有 LoopState 统计得出，不需要新建观测面。若 pilot 证明依赖真实存在，再评估是否把它投影为 kanban links，以及是否给事件加因果指针；若 pilot 证明依赖稀少，则应把结论记录为 ADR，明确拒绝图运行时，避免这个问题反复被提起。
