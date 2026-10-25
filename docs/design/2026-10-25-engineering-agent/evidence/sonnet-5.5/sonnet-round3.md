# OSStack Session adoption 试点：最终收尾审计（纯静态）

我没有运行任何代码。"5922 通过""88 / 61 / 33 项聚焦测试""lint 已修"都是你提供的观察，不是我的结论。最终全量套件仍在重跑，本报告不依赖它。

## 1. 结论

**对"本地、默认关闭、opt-in、existing Session 采纳 + observed_turn"这一有界试点：通过，可合入。**

- **P0：无。**
- **P1：无。**
- **代码层 P2：无。** 上轮 P2-A、P2-B 经源码和测试核对已关闭。
- **P2：1 项，条件性，文档/运维层（P2-D）。** 它涉及 P2-C 的后果，下面给出反例和最小修复。若你方确认存在受支持的 fence 清理路径（见第 3 节），可降为 P3。
- **P3：若干**，不阻塞。

我没有找到能击穿以下不变量的路径：重复派发、撤权后派发、伪造完成证明、committed unknown 被自动重发或被升级清除。

## 2. 上轮项与回归核验

| 项 | 结论 | 依据 |
|---|---|---|
| **P2-A** 完成事务不依赖仓库路径 | 关闭 | `recordCompletion` 只调 `databaseSource`（store:464），不碰文件系统。`databaseSource` 校验 session/scope 存在、task/run/scope.task、native 身份、`scope.repo_path`、tasks⋈runs（含 `r.agent_id`、默认租户）（store:139-148）。文件系统检查只在 `source()`（:149-159），由 `refresh`、`decide`、`preflightDispatch` 使用。 |
| 真实 turn 在仓库不可用时落库 | 成立 | 测试 :190-212 先 `rename` 目录再 `finish`。它断言 turn、applied、completion 行、action/item 状态均已写入，且无 `source_observation_error`，Mission 仍是 `answer_recorded`。 |
| 身份变化时回滚 | 成立 | 测试 :213-226 覆盖 native、`runs.agent_id`、`scope.repo_path` 三种变化。它断言 `source_changed`，message 仍 `accepted`，turn 与 completion 均无。daemon 侧异常会进外层 catch，把 message 标为 failed 并返回 `delivery_uncertain`（daemon:1076-1081）。committed 且未 applied，仍是升级 hold，方向是 fail-closed。 |
| Mission completed 是后续观察 | 成立 | `recordCompletion` 不改 Mission 状态。只有 `refresh`（:529-533）在 `!uncertain && !unclosed && !stop_intent_id && completion匹配最新snapshot` 时才 `bump(completed)`。测试 :209-211 显示恢复后才 completed。`refresh` 里"completion 且 applied → cleared"排在 live 判断之前（:505），顺序正确。 |
| **P2-B** drain 分类 | 关闭 | 端口 schema 改为 `drained: z.boolean()`（port:94）。v47 先判 `attention_dispatch_holds !== 0`（:97），`undefined` 也拒绝，再判 graph、active、drained。这在 `backend.stop` 之前。fake daemon 现在返回真实组合 `drained:false, holds:1`（native.test:25、:66-70）。 |
| 拒绝后 draining 与 resume | 成立，已文档化 | `daemon.drain` 置 `draining=true` 后不复位（daemon:1381）。daemon 测试 :291-305 证明拒绝后 reserved 不派发，显式 `daemon.resume` 后恢复，`drained:true` 后 holds 为 0。中英文指南 §"Upgrade, rollback…" 写明并给出 RPC 脚本。 |
| drain 与派发竞态 | 未发现 | `dispatch` 在 `await acquire` 之后、同步 CAS 之前检查 draining，中间无 await（host:181-185）。`activeRuns` 自 acquire 起持续持有同一 controller，覆盖 CAS 到执行。`decide` 非重放在 draining 时被拒（host:63）。 |
| **P2-C** 未知 committed 不自动清除 | 成立 | 守卫只放行 `committed && applied` 与严格有效的取消证明（guard:14-18）。receipt resolution 不参与判断。中英文指南明写：不支持降级，v47 库旧 binary 打不开，hold 可能无限期保留，禁止改账本。 |
| 纯未派发取消的措辞 | 部分成立 | 见 P3-A：条件判断不完整。 |
| 取消回执、`dispatch_inconsistent` 错误码 | 成立 | daemon:869 已加入白名单，测试 :307-316 覆盖。 |

## 3. 剩余问题

### P2-D（条件性，文档/运维）被拒绝的托管升级留下的持久 fence，与永久 hold 叠加

- **事实依据**
  - `resolveAuthority` 在任何停服动作之前发布 `upgrade-operation.json`（port:74）。
  - 协调器失败路径不清除它。`close()` 的注释和测试 :194 都表明 fence 在任何失败后保留。
  - 存在 operation 而无匹配 permit 时，托管启动抛 `upgrade_start_blocked`（native.test:107-108）。
- **反例**
  1. v47 home 有 committed-unknown hold，操作员发起托管升级。
  2. `doDrain` 在 stop 前以 `upgrade_unknown_actions` 拒绝。journal 进入 `recovery_required`，fence 保留，daemon 仍运行。
  3. 操作员按指南用 `daemon.resume` 恢复，一切看似正常。
  4. 之后该 daemon 崩溃或主机重启。launchd 拉起时被 fence 阻断。
  5. 唯一的受支持恢复是 `reconcileForward`。服务为 absent 时它走 `holdStoppedHome → lockHomeDatabase`，hold 仍在，再次抛 `upgrade_unknown_actions`。
  6. 结果：该 home 在托管路径下无法启动，也无法被 reconcile。
- **性质**
  - 这是可用性问题，不是安全问题。没有重发，也没有伪造证据。
  - fence 持久化是既有协调器行为，graph hold 同样适用。区别是 graph hold 会自行消失，而 committed-unknown hold 可能永久存在。
  - 指南的"放弃升级"恢复步骤没有提到 fence 和 `recovery_required`。
- **最小修复（文档即可）**
  - 在中英文指南 §"Upgrade, rollback…" 增加一段，说明：
    - 被拒绝或中止的托管升级会遗留 operation fence 和 `recovery_required` journal。
    - 在 fence 清除前，该 home 的托管重启可能被阻断。
    - 对存在永久 hold 的 home，不要发起托管升级。
    - 写明实际可用的 fence 处置方式，若没有就明说没有。
- **可选加固（不要求）**：在发布 fence 之前，用只读连接预检 `engineeringUpgradeHolds`，让这类拒绝不留下 fence。
- **降级条件**：若 `complete()` 或等价命令是受支持的操作员入口，且 `publishPrivate` 允许后续计划覆盖旧 fence，则降为 P3（仅补文档）。这两点不在我看到的文件里。

### P3（不阻塞）

- **A. `stop_unknown` 措辞仍有误导（host:83-90）**
  - `provenUnstarted` 要求 `cancelledMessages.length > 0` 且等于 `action_ids.length`。
  - 反例 1：Mission 从未产生任何 action 就被取消。`action_ids=[]`，`provenUnstarted=false`，写入 `stop_unknown`，文案为 "prior worker exit is unknown"，但根本没有 Worker。
  - 反例 2：唯一的 action 已 applied、Mission 尚未被 refresh 投影为 completed 时取消。同样写出该文案。
  - 两者都是保守方向，没有控制决策依赖它。
  - 建议：当 `committed_message_ids` 为空且不存在未 applied 的 committed phase 时，不写 `stop_unknown`。
- **B. 完成后 Session 前进导致 Mission 永久 `observing`**
  - `refresh` 的 completion 查找键是最新 snapshot 的 `(turn_id, version)`。
  - 若在下一次 `refresh` 之前出现了更新的人工 turn，completion 匹配不上，Mission 不会 completed。
  - 这符合"绝不伪造"。但它仍占着活跃 source 唯一索引，直到 `end-observation`。可在指南补一句。
- **C. 测试缺口**
  - 完成事务回滚只测了三种变化。`session.task_id`、`session.run_id`、租户变化只靠代码，没有测试。
  - 没有 daemon 级测试：回滚后 message=failed、hold 保留、Mission 经 refresh 进入 `needs_reconciliation`。
  - 守卫测试没有 "committed + failed + 已 abandon 的 resolution 仍计 hold"。代码上显然成立（只有 applied 放行），但未被锁定。
- **D. DB-only 身份检查不绑定 `session.repo_path`**
  - 它无法与规范化后的 `mission.repo_path` 直接比较。后续 `refresh` 的 realpath 检查会捕获，不会伪造完成，因此不构成缺陷。
- **E. 指南错误表缺少 `draining`、`dispatch_gate_required`、`dispatch_inconsistent`。**
- **F. P3-4（scope reader 可见资格信息）**：按你的说明视为有意设计，我不再追究。

## 4. 证据局限

- **全部为静态阅读。** 5922 / 88 / 61 / 33 等数字和 lint 修复是你提供的观察。最终全量套件尚在运行，未获得最终结果。`disposition.md` 的第三轮结果仍是占位，追加时应保留"静态复审、未执行测试"的限定。
- **未覆盖的环境**：真实 Provider 回合；物理断电与文件系统持久性；同 UID 恶意 Worker 与子进程域包含；多租户；远程宿主。fixture adapter 在进程内，不证明进程组被控制。
- **升级端口测试**用脚本化 fake daemon 模拟真实返回组合，不是真实 `startDaemon` 经由端口的端到端。真实 daemon 的 `drained:false, holds:1` 由 daemon 测试单独证明。
- **SIGKILL 窗口**：只覆盖两个已知窗口。以下窗口未覆盖：
  - "CAS 提交 → adapter 调用"之间
  - `completeInboundTurn` 事务中
  - "cancel 提交 → abort"之间
  - "已取 writer lock、CAS 之前"被杀（取决于未提供的 `acquireRepoWriteLock(recover_stale:false)` 语义）
- **未提供的代码**：`SessionRepository.markMessageApplied` 的调用方（该方法不经 `recordCompletion` 即可置 applied，守卫会将其视为已完成）；`publishPrivate` 覆盖语义；launchd 启动入口是否必经 `managedStartupIdentity`；`AttentionObserver` / `AttentionExperience` 是否在 in-flight 时调用 `reconcile`；协调器之外的 `upgrade` CLI 入口；`daemon.ts` 其余部分。以上均未被我假定为正确。
- **受信边界**：已存在的受信进程端点、全局 action_id、一次性采纳、1000 个累计 Mission、8 次 stop 上限、无降级和无离线放行机制，均按你的约定作为试点约束，不计缺陷。
