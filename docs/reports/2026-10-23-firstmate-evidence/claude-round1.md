## 结论

**Verdict：方向可取，当前稿不能作为实施基线。** 须先修 P0-01、P0-02 并把首期切片砍到“只读投影 + 一条状态 RPC”再复审。设计在授权边界、unknown 优先、回执绑定上比 firstmate 的 Bash sidecar 更严，这些不需要改。真正阻断集中在三处：宿主 daemon 的启动副作用与 INV-10 冲突、未决项的身份键绑错了版本、首期切片把三个产品面塞进一个“仅观察”标签。以下只基于给定摘录，未验证完整仓库，未运行测试。

## 问题清单（按严重度排序，编号稳定）

**P0-01 宿主 daemon 启动路径与 INV-10 / F17 直接冲突。**
- 触发：观察者随 daemon 启动。O07 `restoreLoopSessions` 对 `useWorktree` 的 Loop 调用 `cleanupOrphanedWorktrees`；O08 按分支前缀加路径筛选后 `worktree remove --force` 并 `branch -D`，无所有权或停止证明。
- 后果：用户收益 4“重启后不凭记忆重复执行”和 F17“不重启、不清理”在当前宿主上不成立。§13 承认后只改为“隔离 home 试点”，等于把不变量降级为测试条件。一个被监督的 Loop 正是最可能被清掉的对象。
- 修订：首期把 Loop 排除出 subject 种类，并在 RPC 输出里显式标 `loop: unsupported_in_slice_1`；或在 restore 前查 `supervision_subjects` 绑定，命中的 worktree 跳过清理并记 anomaly。二选一写进设计，不留给试点环境。
- 依据：O07:2349-2357，O08:109-145，设计 §4 INV-10、§15 F17。

**P0-02 未决项身份键绑错了版本，回执查询未定义。**
- 触发：`attention_items` UNIQUE 含 `source_revision`。O03 显示 `agent_sessions.version` 在每条 `applyInbound` 后加一，与某个决策是否变化无关。
- 后果：同一个开放决策在每次入站消息后被当作新 item，通知 episode 随之翻倍，与 §10“源未变化不生成新 episode”矛盾。此外 §9 要求“匹配源 revision 的 resolution receipt”，但摘录里 `session_messages` 只有 `kind` 与 `payload_json`，没有 `decision_id` 列，回执按什么键查没有定义。
- 修订：item 身份用 `(scope, session_id, decision_id)`，`source_revision` 用决策自身内容哈希；session `version` 仅作 CAS 的 `expected_version`。回执定义为 `session_messages` 中携带相同 `decision_id` 的已 `applied` 行，若现有 payload 不含该字段，首期该源只读不答。
- 依据：O01:63-80，O03:162-212，设计 §6 表、§9。

**P1-03 等待责任人分类没有查询续跑 grant 状态。**
- 触发：`decision.requested` 带 `continuation`，且仓库中存在 active grant。O04 的 `SessionCollaborator` 会自行 `beginCheck`、`finishCheck`、`send`。
- 后果：收件箱把 collaborator 正在处理的 phase_continue 显示为“需你决定”；用户作答与 collaborator 的 send 竞争，CAS 冲突虽能挡住重复，但产品面是错的。
- 修订：§5.3 的 `owner` 判定加一条：continuation 对应 grant 处于 active/checking/reserved 时 kind 为 `authorization`、owner 为 system（grant_id）；grant blocked/expired/absent 才转 owner_decision。O02 已有 `grant_id` 字段，沿用。
- 依据：O02:11-19，O04:91-130，设计 §5.3、§9 第 4 条。

**P1-04 时间 freshness 让持久的 idle 和终态衰减成 unknown。**
- 触发：每条 Observation 带 `freshness_deadline_ms`，且 unknown 排序在“过期”项。一个等用户指令的持久 session 没有心跳来源可刷新 idle。
- 后果：所有闲置超过期限的 session 都显示 unknown，`awaiting_instruction` 这类最常见等待被淹没；“等用户与卡住分开显示”的收益 2 失效。firstmate 用 gen 绑定处理陈旧，不用时间衰减（F01）。
- 修订：区分两类事实。来自权威存储的 turn-ended、terminal、决策开放不衰减；只有 `busy` 的活跃声明和覆盖受期限约束。`idle` 展示为“自 X 起闲置，进程活性 unknown”两个字段，不合成一个值。
- 依据：F01:310-314，O01:82-92，设计 §5.2 排序。

**P1-05 fencing 做成两套，却没堵住根因。**
- 触发：O09 `acquireDaemonLock` 是 exists→read→write，无 O_EXCL 或 flock。设计另加 `supervision_owners` 行做 CAS generation。
- 后果：两个 daemon 并发启动时，观察者租约只保护投影不被旧 owner 污染，两个进程仍各自 restore Loop、各自跑 executor、各自绑 socket。租约没解决的事恰是最贵的事。
- 修订：先把 daemon 锁改为原子（`wx` 打开或 SQLite `BEGIN IMMEDIATE` 下的单行 owner），把观察者 generation 放在同一行，一处机制。不要在设计里保留“pidfile 不能做 fencing 但我们另加一层”的叙述。
- 依据：O09:32-49，设计 §7 实例与租约、§13 表末行。

**P1-06 外部等待要求绑定真实 CI check ID，把网络轮询拉进了首期观察循环。**
- 触发：§5.3 规定 awaiting CI 必须绑定实际 check/run ID。摘录里唯一的 GitHub 读取是 O11 daily 的只读 adapter，在命令级而非循环级。
- 后果：首期观察者需要凭证、限流处理、网络失败分支，INV-11 仍可满足但成本与故障面明显扩大，和“无变化零调用”的成本目标脱节。
- 修订：首期 `external` 只记录 agent 自报文本并归 `unclassified`，不做验证；CI 绑定放到简报或 P2，复用 daily 已有 adapter 按需拉取。
- 依据：O11:1-20，设计 §5.3 等待分类规则。

**P1-07 `dead` 判定在首期只有一个可证来源，设计未声明。**
- 触发：O12 codex-cli 为每次 exec 起子进程，Abort 后 SIGTERM、2 秒 SIGKILL；`turn.completed` 不证明后代退出。持久 session 的 endpoint 是存储的 `native_session_id`，无进程可“死”。
- 后果：若实现方把 session.state=failed 或 iterable 结束当 dead，就违反 INV-04。
- 修订：§5.2 明确首期 `dead` 仅由 adapter 子进程 exit 事件产生，且仅对 run 类 subject；session 类永不输出 dead。SIGKILL 后代残留列为测试门禁，不是首期能力。
- 依据：O12:20-24，O01:87-92，设计 §5.2 Codex 段。

**P2-08 `supervision_events` 复制了已持久的 run 事件。**
- 触发：O06 显示 run 事件已有 `seq`、`event_id`、`terminal` 且可按 `afterSeq` 读取。
- 后果：双份存储、双份保留策略、两处 schema 演进。
- 修订：run 源只存 `source_cursor` 和投影；`supervision_events` 只收没有自带持久序号的源（例如 snapshot_only 的 Loop）。
- 依据：O06:3443-3458，设计 §6 表。

**P2-09 新包 `@osstack/supervisor` 加 protocol JSON Schema 与 conformance fixtures 对首期过重。**
- 触发：首期 Observation、WaitRecord 均为 daemon 内部类型，不跨进程。
- 后果：多一个工作区包、构建与 lazy import 检查项、fixtures 维护，换不到边界收益。
- 修订：纯归约放 `packages/core/src/supervision/`；只有 RPC 返回体进 protocol。包拆分留到出现第二个消费者。
- 依据：设计 §3 依赖方向、§14 启动时延要求。

**P2-10 首期表清单与简报需求自相矛盾，优先级无定义。**
- 触发：§10 增量简报要 mark-seen 与 since-cursor，依赖 `brief_cursors`；§6 首期表排除它。“最多显示 3 个高优先决策”没有优先级规则。
- 修订：简报移出首期，或把 `brief_cursors` 列入首期并定义优先级为 wait kind 的固定序（authorization > owner_decision > delivery_uncertain > 其他）。
- 依据：设计 §6、§10。

**P2-11 标脏只能是优化，补扫才是正确性来源，设计未说明。**
- 触发：标脏需要改 daemon.ts 中每个写点；O06 注释表明 live bus 尚不存在。
- 后果：漏一个写点就漏一个 subject，直到 30 秒补扫。若补扫用现有 list 的 limit 不翻页，大 home 会永久漏扫。
- 修订：写明“遗漏标脏仅影响延迟不影响正确性”，补扫按源 cursor 翻页到尾，并把 `source_gap_count` 对任何截断计数。
- 依据：O06:3440-3442，设计 §7、§13 sessions 行。

**P2-12 turn-end hook 的“前台主会话”在 OSStack 没有对应实体。**
- 触发：§8 照搬 firstmate 的 primary/worker 区分（F05）。OSStack 的前台是任意调用 CLI 的进程，没有 home 级 primary 概念。
- 修订：P2 之前先定义前台 actor 的身份来源（socket peer、显式 session 注册或别的），再谈 hook；当前稿把该节标为“待定义”。
- 依据：F05:1-33，设计 §8。

## 首期切片是否过大

过大。“仅观察的监督状态 + 只读决策收件箱 + 增量简报”是三个产品面，涉及 5 张表、新包、扫描循环的公平配额、覆盖四态、等待六类、简报分页。建议砍成：

- **范围：** run 与 session 两类 subject，Loop 标 unsupported。
- **存储：** `supervision_subjects`、`supervision_projection`、`supervision_owners`（与 daemon 锁合并），共三张。
- **输出：** 一条 `supervise status --json`，字段为活跃状态、闲置起点、开放决策（直接从 `decision_json` 读，不落 `attention_items`）、覆盖采样时间与截止。
- **循环：** 30 秒补扫加可选标脏，单并发，不做配额，超过 100 subject 直接 degraded。
- **延后：** 简报、通知、收件箱表、外部等待验证、语义分诊全部出首期。

## 实施时测试门禁（不是当前设计缺陷）

- F01 到 F20 矩阵，尤其 F04、F06、F13 需两个隔离进程和真实 SQLite。
- codex-cli 取消后 2 秒 SIGKILL 的后代残留与事件丢失。
- 时钟跳变与休眠恢复下的覆盖重验。
- §14 的 p95、启动时延、零模型调用计数。
- 合成通过不等于真实 CLI 生命周期验收，设计 §15 已正确声明。