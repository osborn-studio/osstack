**审计目标**：在给定摘录范围内复审修订稿，核对第二轮指定六项。未访问完整仓库，未运行测试。

## 1. 分期结论

**S0 可作为实现起点**，无阻断缺陷，但两项前提须在S0-A前核实，否则查询会在运行时失败：
- tasks/runs 是否有 tenant 列。O18 迁移1两表均无该列，O10 的 tenant 谓词只出现在 kanban cards 上。设计§18.1 把"两表一致的 NULL tenant"写成硬约束，这是以未证实的列为前提。设计须写出两个分支：列存在则按 IS NULL 过滤，列不存在则 `--default-tenant` 表示该维度不存在并在输出披露。
- 最低 schema。S0 要读 repo_path（22）和 grants/attempts（24），实际最低就是当前最高的 24。设计只说"不支持就报 unsupported"，没有前向规则，下一次迁移就会让 S0 失效。应改为"版本≥24 且所读表列存在性检查通过"。

**S1 仅条件可行**：D1–D3 通过，且下文 P1-B、P1-C、P1-D 补齐定义。
**S2 仅条件可行**：P1-A 的 grant 处置写入回答流程，受理入口统一后再开放。

## 2. 未解决 P0/P1

无剩余 P0。以下 P1 均为设计缺陷，不是实施条件。

**P1-A 人工答复后 active grant 的归属未定义（S1 分类，S2 回答）。**
- 触发：grant active，人工经 inbox 或直接 session send 应答，CAS 胜出，版本前进。O04 第108行 `beginCheck` 非 checking 即 return，循环退出，grant 仍 active 但不再被调度；重启 `resumePending` 又会重新调度它。
- 后果：§5.3 规则只覆盖 checking/reserved、active 无调度、blocked/expired/absent，缺"active 但 expected_version 已落后"一类。收件箱会把人已答复的决策长期显示为 system-owned/coverage_unknown；重启后 collaborator 是否对新 turn 发送取决于 beginCheck 是否校验版本，摘录无法证明。
- 修订：增加 `stale_grant` 分类，条件为 grant.expected_version < session.version 或 expected_turn_id ≠ 当前 turn，owner 转人并记 anomaly。S2 `attention.answer` 成功应用后在同一事务把该 grant 置 blocked(reason=superseded_by_human)。beginCheck 的版本校验列入 S2-B 门禁。

**P1-B D1 的旧锁处理没有自动恢复路径。**
- 触发：daemon 被 SIGKILL 或断电，锁文件残留死 PID 与 nonce。
- 后果：§13 要求"不凭 PID 不存在偷锁，无法确认时拒绝启动"。现有 O09 至少会替换死 PID 锁；新规则下任何崩溃后 daemon 都无法自启，这是比并发窗口更常见的故障。
- 修订：改用内核在进程退出时自动释放的建议锁，或在打开主 DB 前对一个无迁移的独立 owner 文件执行 `BEGIN IMMEDIATE` 持有连接。若坚持文件锁，须定义身份核验具体内容和一条显式 `daemon unlock` 操作员命令，并写进 D3 runbook。

**P1-C S1 补扫的准入来源未定义，100 上限会造成永久漏项。**
- 触发：§18.2 每 cycle 读"已准入 subject 固定集合≤100"，但谁来准入、按什么顺序没有定义。O14 `listSessions` 上限 200，按 updated_at DESC 排序，无 cursor。
- 后果：若准入沿用该查询，长期 awaiting_decision 且无更新的 session 恰好最先掉出窗口，正是最需要人答复的一类，与"无永久漏项"验收矛盾。
- 修订：准入用新增 keyset 分页按 session_id 遍历 agent_sessions，过滤非终态，统计总数；超过上限时优先 awaiting_decision，其余标 degraded 并给出 omitted 数。终态 session 读一次后退出集合。该 helper 应明确归入 S1-D。

**P1-D 在收件箱之外完成的答复会堆成 superseded-unresolved。**
- 触发：用户直接用现有 session send 回答，而非 S2 inbox。
- 后果：§6 规定旧 episode 只有显式处置才标 answered，否则 superseded-unresolved 保留。常规使用下未决项持续增长，收益3失效。
- 修订：session_messages 有 turn_id 列（O15）。inbound、kind=instruction.send、state=applied 且 turn_id=origin_turn_id 是结构事实，不是文本相似度。为此增加 `continued_externally` 生命周期态，和 answered 区分，默认不计入待办计数，但保留可查。

## 3. 新出现 P2

**P2-A accepted 消息在无内存上下文时无法区分在途与不确定。** O02 `describeSessionWait` 需要 `applying`，该值来自内存 `activeSessionSends`；S0 没有 daemon，S1 投影要求可重建。应定义：仅凭 DB 看到 accepted 时输出 `accepted_in_flight_or_uncertain` 并附 age；S1 可用本进程内存精化，重启后一律按不确定。不能直接复用 delivery_uncertain 字样。

**P2-B attention_items 对 session 的引用方式未定。** agent_sessions 对 tasks/runs 级联删除（O15）。若 items 带 FK 级联，§18.2 的 source_missing 永不出现；若带 FK 不级联，删除任务会被阻塞。应明确无 FK、保存最小快照，并在 S1-C 加任务删除测试。

**P2-C daemon_owner 迁移无归属任务。** D1 文件清单只有 daemon-lock.ts 与 daemon.ts，但§13 要求取锁后登记 SQLite generation。要么 D1 显式含迁移，要么 D1 仅做文件锁而 generation 归 S1-B，F06 的验收任务随之调整。

**P2-D supervisor 包的归属与前提。** O16 证实包存在，描述是"portfolio maturity control plane"，并依赖 loop 与 governance。把 session 活跃归约放入该包需确认 daemon 路径 lazy import 不拉入 loop；S1-A 写明"已有 activity.ts、wait-classifier.ts"，摘录无法证实，应改为"新建或复用"。

## 4. 第一轮逐项闭环

| 编号 | 状态 | 说明 |
| --- | --- | --- |
| P0-01 | 闭环 | S0 不启动 daemon，D2 撤销 force cleanup，F17 恢复为硬门禁 |
| P0-02 | 闭环 | identity 含 origin_turn，回执按 message_id 核对；外部答复见 P1-D |
| P1-03 | 部分 | grant 分类补了 checking/reserved，缺 stale active 分支，见 P1-A |
| P1-04 | 闭环 | 持久事实与 freshness 分离 |
| P1-05 | 部分 | 原子 admission 方向正确，旧锁恢复缺失，见 P1-B |
| P1-06 | 闭环 | S0/S1 零 CI |
| P1-07 | 闭环 | dead 仅限实际持有的 run 子进程 |
| P2-08 | 闭环 | 引用加 pin；FK 细节见 P2-B |
| P2-09 | 前提纠正 | 第一轮"新增包过重"前提错误，O16 证实包已存在。保留包正确；残留只有 P2-D 的内聚与 lazy import |
| P2-10 | 闭环 | brief 与 cursor 同入 S2，优先序已定 |
| P2-11 | 部分 | 补扫为正确性来源已写明，准入来源未定，见 P1-C |
| P2-12 | 闭环 | S2 显式 foreground 注册 |

## 5. 实施门禁

设计缺陷须在相应阶段开始前改稿：P1-A 在 S1-A 与 S2-B 前，P1-B 在 D1 前，P1-C 在 S1-D 前，P1-D 在 S1-C 前。

需实施时验证的条件：
- tenant 列存在性与 migrations 2–20 的实际内容；S0 最低版本 24 与列检查。
- 只读打开已有 WAL 文件在无 daemon 时的行为，失败须明确报错而非改模式。
- `beginCheck` 是否校验 expected_version/expected_turn_id，决定 P1-A 修订范围。
- cleanupOrphanedWorktrees 除 restoreLoopSessions 外的其他调用点。
- supervisor 包内目标文件是否存在，daemon 启动路径 lazy import 预算。
- codex-cli 是否实现 SessionCapableAdapter 的 resume，否则 pilot harness 需换。
- F04–F07、F13、F14 用两个真实进程与真实 SQLite；P1-D 的 continued_externally 需覆盖"同一 turn 多条 inbound"用例。
