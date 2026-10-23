**结论：无阻塞矛盾。作为待实施计划可接受，不代表运行实现已验收。**

接受更正：checkpoint 权威调度与图数据，ledger 权威动作与权限，status 为投影，二者不竞争同一状态。SIGKILL 复现的重复动作正是 ledger 存在的理由，两条证据与设计一致。

按你要求逐项核查，只列需要最小修订的遗漏：

**1. logicalAttempt 的分配权归属未写明。** effectKey 含 attempt，但 worker 若从 checkpoint 计数推算 attempt，在“intent 已登记、checkpoint 未写”窗口会与 ledger 不一致。最小修订：attempt 只能由 daemon ledger 分配；worker 对同一 (run, epoch, node, slot) 调用“登记或返回现有记录”，ledger 返回现有记录状态而非报错，worker 据此走 §6 恢复表。

**2. 分支预算计数自相矛盾。** §4 说 schema 错误有“单独的”尝试预算，§6 说格式纠正与基础设施重试都“增加 branch attempt”，而 limits 只有 maxBranchAttempts。最小修订：选一个计数器，建议二者共用 maxBranchAttempts，否则补一个 limit 字段并写入 ledger 预留。

**3. reconciliation_required 没有出口转换。** §9 状态机进入该态后，谁来解除、进哪个状态未定义；resume 需要 interruptId，而对账不是 waiting_input。最小修订：对账作为一种带 interruptId 的 interrupt 暴露，resume 输入为结构化裁定（已生效/未生效 + 证据引用），先更新 ledger 该动作状态，再由 checkpoint 继续或转 failed。同时明确 cancelled 是终态，不可 resume。

**4. fencing 原子性跨两个库不可事务化。** checkpoint 可独立 DB 文件，lease 在控制面 DB，“同一受控操作”无法用一个事务实现。最小修订：改述为 daemon 是两者唯一写入者、按 graphRunId 串行，在同一临界区内校验 generation 后写入；saver RPC 幂等缓存必须以 generation 为键，避免旧代 put/putWrites 的重试命中旧成功响应而被当作已写入。

**5. per-repo 写者租约只在图内计数。** maxConcurrentWritersPerRepo 是图规格数值，旧 Loop、daemon 直接执行仍可对同一仓库启动 writer；仓库写锁只覆盖 git 元数据，不覆盖两个 agent 同时改同一任务。最小修订：写者租约由 P0-3 的共享执行服务统一签发，对所有模式生效；并写明图 v1 是否推动任务 status FSM（建议 v1 不推动，ready 后由发布节点走既有治理）。

其余：取消链、worktree 保留与 GC 分离、join 业务失败与基础设施失败区分、不承诺物理恰好一次，均一致；未发现承诺了不可能的保证。“已完成分支不无故重做”依赖 putWrites 受控成功，失败时节点重跑但 ledger 返回 confirmed，逻辑上仍成立。

以上五项均为措辞级补充，可在 P0 落地时一并写入，不改变架构。
