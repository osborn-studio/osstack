我没看到 generate.ts 与 graph.schema.json 的实际内容，JSON Schema 相关判断基于 graph.ts 与常规 zod-to-json-schema 行为，请对照生成物核实。总体上纯边界设计是合理的（认证先于解析、生成号只做围栏不进 effect 身份、摘要域分隔无歧义、原型/访问器防护到位），下面是我能构造出复现输入的具体漏洞。

## 具体缺陷（按严重度）

1. **[中·安全契约] `parseInboundGraphRequest` 接受 worker 绑定的上下文。** 输入：`parseInboundGraphRequest(start, authenticated)`（测试中 `authenticated` 带 `worker`），只要 scope 匹配即通过。影响：持有某个 run 租约的 worker 连接可以 start 新 run、cancel/resume 同 scope 下任意 run，边界没有把"worker 租约"和"控制面主体"区分开，G10 也无法从上下文得知角色。最小修正：在该函数开头 `if (context.worker) throw new GraphContractError("UNAUTHENTICATED")`，并在注释声明控制面请求只接受无 worker 绑定的上下文。

2. **[中·围栏缺口] `parseInboundWorkerActionRequest` 不校验 `specHash`/`epoch`。** 输入：`{ ...worker, specHash: "c".repeat(64), epoch: 2 }` 与 `authenticated` 一起调用，通过。影响：这两个字段进入 `actionIdentityShape`，若 daemon 从请求体构造 `Effect` 再算 `computeGraphEffectKey`，worker 可自选 effect key，绕过同 slot 去重或制造与其他 epoch 的碰撞。最小修正：`TransportContext.worker` 增加 `specHash: Digest`（run 内静态，租约签发时已知）并比较，不等抛 `RUN_MISMATCH`；`epoch` 是动态状态，在 `Effect` 类型注释中明确写出"epoch/logicalAttempt 必须由 ledger 覆盖，不得从请求复制"。

3. **[中·状态矛盾] `ErrorObject` 允许 `code`/`retryable`/`nextAction` 互相矛盾。** 输入：`{ schemaVersion:1, code:"ACTION_OUTCOME_UNKNOWN", message:"x", retryable:false, nextAction:"retry" }` 通过；`{ code:"INTERNAL_ERROR", retryable:true, nextAction:"stop" }` 也通过。影响：消费方按 `nextAction` 行动会对结果未知的副作用重跑。最小修正：把 `retryable` 做成判别联合（`retryable:true` 分支的 `code` 只允许 `OUTPUT_CONTRACT_INVALID|INTERNAL_ERROR` 且 `nextAction:"retry"`；`retryable:false` 分支禁止 `nextAction:"retry"`），并绑定 `ACTION_OUTCOME_UNKNOWN`/`CANCEL_UNCONFIRMED` 只能配 `reconcile`。用联合而非 superRefine 的好处是能进 JSON Schema（见第 5 条）。

4. **[中·状态矛盾] `WorkerActionResponse.outcome.state` 与 `error.code`、`effect` 无耦合。** 输入：`outcome: { state:"unknown", error:{ code:"POLICY_DENIED", retryable:false, nextAction:"stop", nodeId:"other", epoch:1 }, reconciliationRef:"r" }` 配 `effect.nodeId:"implement", epoch:0`，通过。影响：worker 端无法从 state 推出正确处置，error 内的 nodeId/epoch 与 effect 指向不同动作。最小修正：在响应对象上 superRefine：`unknown|reconciliation_required → code ∈ {ACTION_OUTCOME_UNKNOWN, CANCEL_UNCONFIRMED}`，`cancel_pending → CANCEL_UNCONFIRMED`；`error.nodeId/epoch` 若存在必须等于 `effect.nodeId/epoch`。

5. **[中·Schema 保真] Zod 拒绝而 JSON Schema 接受的三类数据。** 复现：按 graph.schema.json 生成外部校验器，`retryable:true + code:"POLICY_DENIED"`、深度 17 层 / 4097 个值 / 65 KB 以上的 `resume.input.value`、键名为 `"constructor"` 的业务对象，都会被外部实现放行而被本包拒绝。影响：跨语言 counterpart 与 daemon 对"合法输入"的定义不一致，重放/摘要判断随之分叉。最小修正：第 3 条的联合改写解决第一类；`GRAPH_JSON_LIMITS` 作为 `description` 或自定义关键字写入每个根 schema；`isBoundedJson` 中 `constructor`/`prototype` 的拒绝改为只针对 `__proto__`（后两者对 null/Object 原型的普通数据对象无污染风险），或在 `JsonValue` 的 record 键上同样用正则排除，使两边一致。

6. **[中·快照身份缺口] `MutationContext` 不携带 run 身份。** 输入：`validateGraphMutation(resume /* graphRunId:"run" */, { currentRevision: 4 })` 而快照实际来自另一个 run，返回 `"apply"`；`validateGraphMutation(start, { currentRevision: 9 })` 也静默返回 `"apply"`。影响：纯函数无法察觉调用方查错了 run，CAS 对错误对象通过；start 带修订号是调用方逻辑错误却不报错。最小修正：`MutationContext` 改为 `{ run?: { graphRunId: Id, currentRevision: Count }, prior?: ... }`，非 start 要求 `run.graphRunId === request.graphRunId` 否则 `RUN_MISMATCH`，start 若带 `run` 抛 `INTERNAL_ERROR`。

7. **[低·缺配对校验] 没有请求/响应配对函数。** 输入：请求 `action.kind:"workspace_create"`，响应 `outcome:{ state:"confirmed", result:{ kind:"tests", ... } }` 且 `effect.effectSlot:"other"`，各自单独解析都通过。影响：worker 无法用本包判断响应是否属于自己的请求、结果类型是否匹配动作。最小修正：导出 `validateWorkerActionResponse(request, response)`，校验 `requestId`、`generation`、scope、`graphRunId`、`specHash`、`epoch`、`nodeId`、`effectSlot` 相等，并用一张 `action.kind → result.kind` 映射表约束 `confirmed` 分支（implement→implementation_complete，freeze→candidate_ready，review→review，tests→tests，workspace_create/release→workspace）。

8. **[低·错误面不一致] `parseInbound*` 与 `validateGraphMutation` 对非法输入抛 `ZodError`，其余路径抛 `GraphContractError`。** 复现：`parseInboundGraphRequest({ ...start, spec: { ...spec, publication:"merge" } }, resolver)` 抛 ZodError。影响：调用方必须同时处理两种异常，且 `SPEC_INVALID`/`INPUT_CONTRACT_INVALID` 码从未被本包产生；另外 resume 的 `interruptId` 不匹配时没有对应错误码。最小修正：包内 catch ZodError 映射为 `INPUT_CONTRACT_INVALID`（路径以 `spec` 开头时为 `SPEC_INVALID`），并增加 `INTERRUPT_MISMATCH`、`RUN_NOT_FOUND` 枚举值供 G08 使用。

## 可选的后续加固（不算 G05 缺陷）

- **`Id` 字符集过宽。** 允许零宽字符、双向控制符、未规范化 Unicode、`/` 与 `..`。若 daemon 把 `repositoryRef`/`workspaceLeaseRef` 当路径或展示名，会有遍历与混淆风险。建议在文档中声明所有 ref 为不透明键，或对 scope 三元组收窄为 `[A-Za-z0-9._:-]`。
- **原始字节上限是 counterpart 义务。** `isBoundedJson` 只在 JSON.parse 之后生效，注释里"enforced before Zod traverses"易被误读为已限制传输字节。建议注释改为"传输层必须在 JSON.parse 前将原始 payload 限制在 maxBytes 内"。
- **`-0` 与 `0` 摘要碰撞** （`JSON.parse("-0")` 产生 -0，canonical 输出均为 `0`）。语义上等价，属于文档说明项而非缺陷。
- **`evidenceDigest`/`artifactDigest` 没有计算规范。** 本包只定义了 input/effect 两个摘要域，G16/G19 验证证据时需要 `osstack.graph.evidence.v1` 之类的域与被摘要对象定义，建议现在就在注释中占位。
- **`GraphNodeState` 缺 `reconciliation_required`。** action 层有该状态而 node 层只能落到 `waiting_input`，跨层可能出现无法互相推导的组合，建议 G08 决定映射并写进枚举注释。
- **`ResolveAuthenticatedGraphTransport` 为同步签名。** 这迫使 daemon 在调用前完成异步租约查询，可接受，但应在类型注释中明说。

## G06/G07：Saver 公共接口的具体风险（仅依据提供的声明）

- **`deleteThread` 必须同时删除 checkpoint 与 pending writes。** 只删 checkpoint 会让同 thread_id 重建后的 `getTuple` 把旧 writes 拼进新 checkpoint。
- **`checkpoint_ns` 必须进入所有主键。** `getTuple/put/putWrites/list` 若只按 `thread_id`+`checkpoint_id` 存储，子图与并行超步会互相覆盖，"失败超步恢复后兄弟节点调用数不变"的验收会假通过。
- **`putWrites` 的去重键是 `(thread_id, ns, checkpoint_id, task_id, idx)`，`idx = WRITES_IDX_MAP[channel] ?? i`。** 负 idx 必须 upsert，非负 idx 必须 insert-or-ignore；`config` 缺 `checkpoint_id` 时应抛错而不是写到"最新"。
- **`list` 的 `before` 要按 `checkpoint_id`（uuid6，时间序）排序而非 `ts` 字符串**；`filter` 键需白名单加参数化，避免拼接；`limit` 缺省应有上限；`thread_id` 缺失时基类语义是跨线程列举，在多租户场景下应显式拒绝。
- **`getNextVersion` 类型必须往返稳定。** 版本以 number 存入 SQLite/JSON 再读出若变成 string，`compareChannelVersions` 会做混型比较，`versions_seen` 判断失效。
- **`getDeltaChannelHistory` 默认实现依赖 `getTuple` 返回准确的 `parentConfig` 与 `pendingWrites`。** 若 v1 声明不支持 DeltaChannel，要么保证这两项保真，要么显式 override 抛"不支持"，不能让默认实现静默返回空 seed。
- **限制 serde 类复活会影响 interrupt/resume。** 需要单独验证 `INTERRUPT`/`RESUME`/`TASKS` 通道中的 Interrupt、Send、Command 值经受限 serde 往返后仍可被运行时识别，否则中断恢复会在反序列化处断裂；`loadsTyped` 为异步，saver 内不能同步调用。
- **`checkpoint.v !== 4` 显式拒绝**，并在 `put` 中校验 `newVersions` 与 `checkpoint.channel_versions` 一致，避免存入自相矛盾的元组。
