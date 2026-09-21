执行性挑战结论：计划整体成立，依赖方向正确，未见需要推倒的结构问题。以下 5 项会在实施中造成返工，建议先改再开工。

1. **G13/G16 缺 migrations 归属，且 G11 与 G13 可并行。** §4.1 把 checkpoints/pending writes 表归 G13、artifacts/workspace leases 表归 G16，但两卡文件清单都没有 `packages/core/src/state/migrations.ts`。G13 只依赖 G07/G08，与 G11 同时改 migrations 并争抢编号，正是 §8 明令禁止的情况。最小修订：G13、G16 增列 migrations.ts；G13 增加依赖 G11，三张卡的 DDL 由同一负责人串行落编号。

2. **worker 侧动作客户端无人负责，G19 漏依赖。** G12 的 broker 全在 cli，graph 不得 import cli，但 G19 的 review/tests 节点必须发起受控动作。目前没有任何卡定义 graph 包内的 action client 或其接口。最小修订：G05 在 protocol 定义动作请求/响应契约，G14 在 worker-entry 实现 IPC 客户端并明确列出；G19 依赖改为 G12、G14、G16、G18，单测可用 fake client。

3. **G04 的 candidate_ready 会把旧 autoCommit 带回来。** 设计决定 6 要求候选是独立 commit 且先持久化再发 receipt，这属于 G16。G04 早于 G16 却已返回 candidate_ready，实现者很自然复用 loop-engine 现有自动 commit，旧行为就此混入。最小修订：G04 输出改为 implementation_complete 加执行证据与工作区引用，明确“不 commit”；candidate_ready 只由 G16 发出。

4. **G02 的取消链在 G23 之前没有集成消费者。** daemon 侧取消（标记 cancel_pending、向 worker 转发、经 broker 传到 executor signal、超时后进入对账）没有落在 G14/G15/G17 任何验收里，只在 G23 的命令层出现。G17 会做出一条只能恢复不能取消的链，G25 的 F11 到时才暴露，返工范围覆盖 M1。最小修订：daemon 侧取消语义移入 G14（转发与超时）和 G17（贯穿验证）；G23 只暴露 RPC/CLI 与授权请求。

5. **多处验证命令引用未核实存在的测试与脚本。** G10 引用 `daemon-policy-gate.test.ts`、G26 引用 `session-rpc.test.ts`、G27 引用 `scripts/build-single-binary.mjs`、G05 引用 generate:schemas 与 check:schemas，G28 的 daemon-rpc-latency 测试身份不明，都以既有文件写法出现。最小修订：G00 验收增加一条“逐卡核对验证命令引用的既有文件与 pnpm script，不存在者改标为该卡新增”。

关于起点与交接的两点判断：

- **G00→G04 起点正确**，Loop 终态与取消语义在任何内核方案下都需要。但 G07 的公开 Saver 可行性是唯一可能改写 G08/G13/G14 结构的门，G05 只依赖 G00 且与 G01–G04 无共享文件，建议 G00 后立即并行推进 G05–G07，不要等 G04 完成。
- **OSBot handoff 不应依赖 OSStack Graph 完成。** G24 只用模拟 caller 验证契约，真实委托接口在本计划内不会稳定。handoff 须写明 OSBot v1 不集成 OSStack 委托，需要的话以本地 stub 占位，待 G24 冻结后另开集成任务。

其余（迁移编号取实施时最新、G17 用测试内嵌图而非 G18 编译规格、Zod 3 边界、Node 20/22 验证）都属于已有明确验证门的未知项，不计为漏洞。完成上述 5 项修订后，我接受此文件作为实施计划；这不代表任何任务的实现验收。
