# OSStack Session adoption 试点：最终独立复审（纯静态）

我没有运行任何代码或测试。"5881 通过""新增聚焦回归通过""SIGKILL 通过"都是你提供的观察，不是我的结论。行号取自你提供的带行号文件和摘录。

## 1. 结论

**对"本地、默认关闭、有界 opt-in 的 existing awaiting_decision Session 采纳 + observed_turn"这一范围：通过，可合入。** 带限制，不是生产资格。

- **P0：无。**
- **P1：无。**
- **P2：3 项。** 其中 2 项是运维/文档缺口，1 项是小的代码加固。
- **P3：若干**，不阻塞。

我没有找到能击穿以下不变量的路径：重复派发、撤权后派发、越权代答、伪造完成证明、committed unknown 被自动重发或升级清除。

## 2. 逐项处置核验

| 处置 | 结论 | 依据 |
|---|---|---|
| P1-1 在途被降为 unknown | 成立 | `activeSessionSends` 自 admission 起连续持有同一 messageId，覆盖 CAS 到执行。`refresh` 对"committed+accepted+live"不调 `reconcile`（store:500）。`recordCompletion` 与 turn 同事务写 action/item=applied（store:467-468）。 |
| P1-2 来源失败污染 Wait | 成立 | 故障分类为 `unavailable` / `identity`。unavailable 只写去重事件。identity 吸收。非故障错误经 `attention.write` 事务回滚。 |
| P1-3 谱系 | 成立 | `tableIntroductions` 由 `MIGRATIONS[].sql` 动态提取（db.ts:103-105）。`sqlite_sequence` 不属于 experimental 前缀，不会误报。 |
| P2-1 admission 空转 | 成立 | admission 前有只读预检（host:167-168）。异步 admission 后在同步 CAS 前重读授权（:178-180）。退避 1→60 秒，每种原因一条事件。 |
| P2-2 终态与 stop | 成立 | `completed`/`failed` 吸收；首个 stop_intent 保留；stop 上限 8。daemon `stop` 要求 `activeSessionSends.get(session)` 属于该 Mission 的 message 集合（daemon:4348-4352）。 |
| P2-3 对象探测 | 成立 | 非 adopt 路径先 `readableMission`，缺失与无权统一为 `permission_denied`。adopt 先查 scope read。 |
| P2-3 全局 action_id | 契约保留 | 重复 ID 在 `reserve` 处因 payload 不同抛 `action_id_conflict`，整事务回滚，不读出他人回执。 |
| P2-4 取消回执 | 成立 | read model、`session.send`、`attention.answer` replay、`abandon` 都走 `isEngineeringCancelledBeforeDispatch`。坏证明显示 `dispatch_inconsistent`。 |
| P2-5 写放大 | 成立 | `observed_at` 至少间隔 60 秒才更新（store:533）。no-op UPDATE 带 `AND state<>?` 条件。 |
| P2-6 / P2-8 | 文档化 | 与代码一致。一个小遗漏见 P2-C。 |
| P2-7 摘要口径 | 成立 | `decide`/`defer`/`refresh`/`commitDispatch`/`reserve` 都对 parse 后内容取摘要。 |
| 升级 P2-1/2 | 成立 | allow-list 守卫；schema<47 却有 phase 表则拒绝（port:132-133）。 |
| 升级 P2-3 | 部分成立 | 守卫在 stop 前有效；错误分类与 draining 后续有缺口，见 P2-B。 |

## 3. 指定交互场景

- **旧端点 × 修复**
  - `attention.answer` 重放：in-flight 返回 `in_flight`；取消返回取消状态；committed 未知时 `reconcile` 只写 `uncertain`，不执行。
  - `session.send` 重放不会进入 execute。
  - `executeReservedSessionTurn` 的 phase 守卫不受功能开关影响。
  - 守卫失败时 `lease` 初值为 `admittedLease`（daemon:929），所以 finally 能释放。
  - 不同 action_id 的 `attention.answer` 在 `session_busy` 或 `stale_item` 处被拦。
- **回滚**
  - 关功能不抹 reserved，会继续拦手工指令，guide 已写明。
  - 二进制回退：v47 库会被旧构建拒绝（db.ts:123-127），升级端口也不还原数据库。
  - guide 没有说明二进制回退不受支持，见 P2-C。
- **精确 message 取消**
  - 取消、结束观察、后续手工指令三种情况下都只按 Mission 自己的 message 集合 abort。
  - 提交与取消都是同步事务，不会交错。
  - 取消回执的措辞问题见 P3-1。
- **来源错误**
  - 瞬时失败不污染 Wait；identity 吸收，原 native id 回来也不恢复。
  - 但完成事务内的来源错误会回滚真实回合，见 P2-A。
- **派发恢复**
  - CAS 是 `UPDATE … WHERE phase='reserved'` 加 `changes===1` 加一次性 WeakSet 许可。
  - 重启只列 reserved；committed 永不再列；撤权在 CAS 前重读。
- **完成证明**
  - 与 `completeInboundTurn` 同事务。
  - 版本为 `reservation_version+1`，action/message/turn 全绑定。
  - 取消或终态后仍会写账本，但 Mission 不会被改成 completed。
- **授权**
  - 每个 Mission RPC 先要求 scope read。
  - cancel 要求 stop，且是 owner 或 operator。
  - endObservation 允许只读 owner。
  - 轮换凭据不撤销 grant；撤销 principal 行才阻断派发。
  - 追踪只记录 method。
- **迁移与 drain**
  - 46→47 的 DDL 在同事务内；未来 48 被拒。
  - 停机后在独占锁内再检；committed 且 applied、或取消证明严格成立，才清除 hold。

## 4. 未解决问题

### P2-A 完成事务内的 `source()` 可回滚已完成的真实回复

- **位置**：`engineering-store.ts:457`（`recordCompletion` 调 `this.source(mission)`）；`daemon.ts:1068`、`:1076-1081`。
- **触发**：Worker 刚完成回复，仓库路径此刻 `realpathSync` 失败或身份变化。例如 Worker 清理了 worktree，或挂载瞬断。
- **影响**：
  - `EngineeringSourceFault` 使 `completeInboundTurn` 一并回滚。
  - 外层 catch 把 message 标为 failed，返回 `delivery_uncertain`。
  - 回复文本和 turn 丢失，Mission 进入 `needs_reconciliation`。
  - 该 committed 行成为永久升级 hold（见 P2-C）。
  - 安全方向仍是 fail-closed，没有重发。
- **修复**：`recordCompletion` 只用 `SessionRepository.latestSnapshot` 加任务/运行/native 绑定校验，不碰文件系统；仓库可用性留给 `refresh` 处理。
- **回归**：在完成事务中注入 `realpath` 失败。断言 turn 与 applied 仍落库、proof 写入，之后 `refresh` 报 unavailable，Mission 不进 `needs_reconciliation`。

### P2-B drain 的错误分类与"拒绝后 draining 残留"未验证

- **位置**：`upgrade-native-port.ts:94-97`；`daemon.ts:1381-1393`；`upgrade-native.test.ts:25`、`:66-70`。
- **触发**：真实 schema47 daemon 有 holds>0 时返回 `drained:false`，端口先做 `drained: z.literal(true)` 解析，抛 ZodError。`attention_dispatch_holds !== 0` 的专门检查因此对真实 daemon 基本不可达。
- **影响**：
  1. 仍然 fail-closed，且在 stop 前；但错误原因不是 `upgrade_unknown_actions`。fake daemon 返回"drained:true 且 holds=1"，是真实 daemon 不会产生的组合，所以测试没覆盖真实组合。
  2. `daemon.drain` 把 `ctx.draining` 置 true 后拒绝升级，daemon 保持 draining：reserved 不再派发，`decide` 返回 draining。是否有人调用 `daemon.resume` 取决于升级协调器，我没看到该代码。
- **修复**：先检查 holds 再 parse `drained`，或在 schema 中去掉 `drained` 字面量约束；确认协调器在拒绝后会 resume 或明示需要手动 resume。
- **回归**：用真实 `startDaemon` 加 reserved 行跑 drain。断言原因为 `upgrade_unknown_actions`，daemon 未被 stop，resume 后 reserved 恢复派发。

### P2-C 运维契约缺口：未知 committed 永久阻断升级，二进制回退未声明

- **位置**：`engineering-upgrade-guard.ts:14-20`；`daemon.ts:1387-1391`；`upgrade-native-port.ts:133`；`engineering-session-adoption.en.md` 的 "Disable and recover"。
- **触发**：
  - 存在 committed 但未 applied 的行，例如 failed、重启后 unknown、或已被 `abandon-receipt` 处置。守卫忽略 receipt resolution，所以永远计为 hold。
  - 或在迁移后希望回退二进制。
- **影响**：
  - 该 home 的所有后续托管升级都被拒，试点内没有受支持的出口，只能手改数据库。
  - guide 没有写这一点，也没有写 v47 库无法被旧构建打开。
  - 这与"未知 committed 不被升级清除"一致，但缺少运维说明。
- **修复**（二选一）：
  - 在 guide 和 runtime-contract 中明写"在试点内这是预期的 fail-closed 终态，需要人工、带证据的离线处置"，并说明二进制回退的限制。
  - 或设计"带操作员证据的显式放行"，需要独立评审，不建议塞进本 PR。
- **回归**：目前至少要有文档检查。若实现放行，需覆盖"resolution 存在但 message 未 applied 仍保持 hold"和"不得自动放行"。

### P3（不阻塞）

1. `engineering-host.ts:80-85`：纯"取消未派发"且无 live 调用时，也写 `stop_unknown`（文案"prior worker exit is unknown"）。实际没有 Worker 被派发，应区分，避免误导操作员。
2. `daemon.ts:869`：错误码白名单缺 `dispatch_inconsistent`，会落入通用失败路径。功能安全，只是错误码不清晰。
3. CLI：值以 `--` 开头的答案文本（`engineering-command.ts:105`）会被拒，需要改用 `--input`。
4. `adopt` 中 `executor_not_qualified` 先于写权检查（host:45），只对该 scope 的读者可见，影响很小。

## 5. 证据局限

- **一律是静态阅读。** 没有任何执行证据，包括你给出的全量测试结果、聚焦回归、两个 SIGKILL 场景。fixture adapter 在进程内，不证明 Worker 进程组被包含。
- **SIGKILL 窗口。**
  - 只覆盖 admission 阶段和 adapter 已调用后。
  - 未覆盖"CAS 提交 → adapter 调用"之间、`completeInboundTurn` 事务中、cancel 提交 → abort 之间。
  - 未覆盖"已取得仓库 writer lock、CAS 之前"被杀。重启后能否恢复，取决于未提供的 `acquireRepoWriteLock(recover_stale:false)` 对遗留 lock 的语义。
  - SIGKILL 不等于断电，FULL 与文件系统行为未验证。
- **未提供的上下文**，我没有假定其正确：
  - 升级协调器（拒绝后是否 resume）。
  - `AttentionObserver` / `AttentionExperience`（是否在 in-flight 时调用 `AttentionActions.reconcile`，P1-1 的修复依赖它们不这样做）。
  - `SessionRepository.retryFailedMessage` 的调用方（permit 守卫应当兜底，但未验证）。
  - 中文 guide、生成的 JSON schema、`local-ledgers-daemon.test.ts`。
  - `daemon.ts` 其余部分，只依据摘录和补丁推断。
- **环境。** 真实 Provider 回合因 API key 缺失未覆盖。未验证：同 UID 恶意 Worker、多租户、远程宿主、物理断电。费用上限未声明，用量缺失记为 unknown，与代码一致。
- `disposition.md` 的"最终复审"一节仍是占位符，本报告可作为其输入追加。追加时应保留"静态复审、未执行测试"的限定。
