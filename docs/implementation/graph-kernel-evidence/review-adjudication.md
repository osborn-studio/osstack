# G05–G07 adversarial review adjudication

## G05 / Claude Fable 5.1

The reviewer saw the first G05 implementation, before the executor independently added pre-allocation rejection and uncertain-retry checks. Supervisor reviewed the final executor snapshot and applied remaining findings.

- Accepted: worker leases cannot act as control-plane principals; current trusted spec/epoch binding; error instruction consistency; response error location/state consistency; run/scope-bound revision snapshots; request/response pairing including result kind, candidate SHA and workspace lease; stable inbound parse error codes.
- JSON Schema: replaced retry/error refinements with a representable union, aligned inert JSON key restrictions, and retained an explicit registry comment for decoded-size/depth/property checks and cross-field response checks that JSON Schema does not express. Raw transport byte caps still belong before JSON.parse in future IPC. Did not claim generated schema alone authenticates, fences, or atomically deduplicates.
- No new unused interrupt/run-not-found codes were added solely for future services. References stay opaque IDs, not filesystem paths. Node states and evidence digest ownership remain later tasks as planned.
- Reproduction: 9 review cases ran, 8 failed and 1 existing safety check passed on the original implementation. After corrections all 9 passed, together with the 58 graph tests. The complete protocol suite then passed 203 tests; build, schema regeneration/freshness, and changed-file Biome passed. A temporary TypeScript narrowing error in a now-redundant retry comparison was corrected before that successful build.
- Final source commit is recorded on G05 in the task registry. OSStack G05 STATE describes the earlier 194-test executor stage; it is historical evidence, not the final supervisor acceptance snapshot.

## Saver guidance carried into G07

Account for public deleteThread, namespaces, reserved write indexes, sorted list/before/filter, version type fidelity, inherited methods, interrupt/resume, and explicit checkpoint-v4 support. v1 can exclude dynamic Send/DeltaChannel; reject unsupported use rather than reviving arbitrary classes. Test-only persistence is not production fencing or daemon RPC.

## G06 supervisor acceptance

Real OSStack execution completed one task/iteration successfully. Independent Node20.20.2/22.22.1 graph tests and entry module traces passed; parent additionally downloaded the checksum-verified Node20.6.0 binary and ran a real compiled graph successfully (node-floor-smoke.json). This supplements the earlier executor note that it had not itself tested that floor. Node22.0 was not run. pnpm11.4 development requires Node>=22.13; runtime support and development tooling are separate. Fresh root loaded only its own file; pinned graph closure has no native SQLite or control-plane runtime dependency. A finite child-process timeout was added following supervisor review.


## 第二轮 Claude Fable 5.1 与主管收口

第二轮输入是实现中的代码快照；Claude 使用禁用工具、hooks/MCP 的文本审查，未运行测试。实际模型调用见 claude-final-metadata.json；不是对最终字节签发的通过证明。

| 意见 | 裁定与处理 |
|---|---|
| failed 可携带 ACTION_OUTCOME_UNKNOWN/CANCEL_UNCONFIRMED | 接受。两项 RED 复现；failed 使用排除不确定错误的结构化 Zod union，生成 JSON Schema 同步表达拒绝。 |
| list 输入/undefined/callback 序列化 | 接受。主管已独立发现并由执行者补 RED/GREEN，投影 durable config 和 before cursor；最终再覆盖 list(undefined)、limit undefined 以及真实 graph.getStateHistory 带 callbacks。 |
| 探针硬编码版本 | 快照已过时。执行者最终已读取并断言三个实际安装版本；主管再绑定 GRAPH_KERNEL 描述符。根入口测试也将描述符与 manifest 比对。 |
| codec 缺少 exports，worker 缺少必要公开 API | 接受。新增 ./codec；worker 导出 interrupt、Command、BaseCheckpointSaver。探针按 manifest 声明的 ESM import 目标加载两个入口，独立包冒烟再检查标准裸包导入。 |
| 标识符放行 DEL/C1 | 接受。三个位置的控制字符回归由 RED 转 GREEN；保留内部普通空格的原契约。 |
| 字节 BOM 与字符串不一致 | 接受一致性修复。新增 RED/GREEN；TextDecoder ignoreBOM:true 保留 BOM 供 JSON.parse 拒绝。既有 JSON 空白仍合法，因此不宣称所有入站 wire 已 canonical，完整性比较必须在相同字节或 encode 后规范化。 |

主管另复现并修复 Uint8Array 自有 getter 校验前执行问题；测试覆盖编码/解码 getter 计数、伪造 TypedArray、共享内存。官方 MemorySaver 与测试持久 Saver 均复现 partial-abort 导致 join 缺失的问题，保留在 probe 的 faults 输出，不改私有引擎、不偷偷忽略错误。

**C2 裁定：未准入。** G07 的可行性验证任务按“最小反例＋替代评估”完成，但 M0 内核准入门仍开放。成功的完整兄弟节点跨进程恢复仅覆盖其明确前提。下一实施批先关闭该反例及跨进程故障矩阵，再进入依赖内核决策的持久图集成；不得提前开始 G18 业务模板或声称生产可恢复图完成。
