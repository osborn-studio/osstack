**第三轮定向复核结论**

事实前提：本轮仅基于给定摘录，未访问完整仓库、未运行测试。结论是设计层复核，不是代码或发布批准。

**Verdict**：第二轮4个P1、4个P2及S0三项前提均已在设计§18/§19与计划D1、S1、S2条目中闭环。无剩余P0，无剩余P1。S0可进入实现。D1–D3、S1、S2仍是门禁，本轮通过不改变其状态。新发现4项P2，均不阻断S0。

**逐项闭环表**

| 项 | 状态 | 证据与判断 |
| --- | --- | --- |
| P1-A stale grant | 闭环 | 事实：O21第285行inspect校验turn与version并拒cursor_changed，O20第147行beginCheck将其持久block。O22第182–188行reserved使版本前进而grant.expected_version保持source_version，第208–212行completeAttempt再核游标。设计§19.1改为先匹配在途attempt再判stale，接管须无checking/reserved/accepted并同事务block旧grant。推断：resumePending是否先经beginCheck不在摘录，只要经过，旧grant就不会无条件续跑。 |
| P1-B 锁恢复 | 闭环 | §13第1项与D1改为内核退出自动释放的独占advisory lock，固定文件不unlink，不按TTL偷锁。原建议的unlock命令被更强方案替代，进程存活时只能kill，取舍正确。 |
| P1-C 准入来源 | 闭环 | §19.3与S1-D用session_id/run_id keyset发现扫描，不复用O14第368–373行updated_at DESC LIMIT 200。满容量时新项标uncovered并输出excess/discovered计数，不驱逐已接管。 |
| P1-D 外部答复 | 闭环 | §19.2只认同scope/session/origin_turn、inbound instruction.send且applied的消息。O15第1272行turn_id列与O13第790行turn校验使该绑定成为结构事实。authorization/risk_approval不被普通消息清除。 |
| P2-A accepted语义 | 闭环 | §18.1纯DB输出accepted_in_flight_or_uncertain。 |
| P2-B FK | 闭环 | §6无级联FK、最小快照、source_missing。O15第1233行证实agent_sessions对tasks级联，隔离必要。 |
| P2-C generation | 闭环 | D1仅内核锁，S1-B含daemon_owner迁移。 |
| P2-D 包归属 | 闭环 | §19.4明确包已存在、两模块拟新增。设计称agents用Zod 4，摘录仅证实supervisor用Zod 3，该断言未核实但不影响裁决。 |
| S0 tenant | 闭环 | O19第143–147行证实tasks/runs有tenant_id且NULL为默认租户。第二轮降级建议被驳回成立，缺列报unsupported正确。 |
| S0 schema | 闭环 | §18.1固定24，后续版本须加法兼容fixture。 |
| S0只读边界 | 闭环 | O17第87–95行提供readonly加fileMustExist加单事务模式，设计沿用并禁止openDb与immutable。 |
| 历史事件gap | 闭环 | O18第62行events有(run_id,seq)唯一索引可作cursor。session无全局序号，§18.2按固定集合重读并披露snapshot_only。 |
| Loop cycle清理 | 闭环 | O23证实cleanupLoopWorktrees受useWorktree控制并按前缀筛选，D2第二批覆盖。其他调用点仍待实施核对。 |
| Codex resume | 闭环 | O24第377–388行实现存在。真实二进制资格仍是试点门禁。 |

**真实剩余P0/P1**：无。

**新P2**

- **P2-E 在途attempt匹配条件未精确。** §19.1说先识别checking/reserved attempt，但attempt本身会过期。checking态的source_version可能已落后于session.version，reserved态的消息可能已failed。O22第186–188行只在reserved时写message_id与reservation_version。应明确：checking仅在source_turn_id与source_version等于当前快照时算在途，reserved仅在消息为accepted且reservation_version等于当前version时算在途，否则显示stale_attempt转人工核对。归S1-A真值表。
- **P2-F requested_by不能当身份。** O13第703–717行requested_by是调用方任意字符串，O22第184行collaborator也只是填文本。§19.2排除自身action应按attempts.message_id与attention_actions.message_id匹配，不按requested_by前缀识别。写入S1-C与S2-A。
- **P2-G 锁的fd继承与文件系统资格。** 推断：若采用flock语义，锁跟随open file description，被子进程继承的fd会让SIGKILL后锁残留。D1须确认binding以CLOEXEC打开，adapter与git子进程不持有该fd。支持矩阵应包含文件系统类型，不只OS。D3 runbook写明进程存活但无响应时kill PID后重启。
- **P2-H uncovered subject最小信息未定义。** §19.3只说标uncovered。S1-F应至少输出session_id、state、是否awaiting_decision与发现时间，否则用户无法判断该结束哪项接管以释放槽位。

**实现门禁**

S0可开始，验收时核实：schema版本来源表名与PRAGMA列存在性检查；WAL有-shm、无-shm、并发writer三种只读打开用例须明确失败而非改模式；tenant IS NULL谓词同时作用于tasks与runs，agent_sessions无tenant列须经join。

S1前：D1–D3全部通过；P2-E纳入S1-A，P2-G纳入D1，P2-H纳入S1-F；F04–F07、F13、F14用两个真实进程与真实SQLite。

S2前：共用reservation入口须覆盖两个并发用例，即人工刷新版本后在reserved窗口直接send，以及checking窗口人工send。须验证旧attempt被block而非永久busy。O22第182行applyInbound冲突未见catch，第160–178行缺失，此处只能列为待验证，不能当事实缺陷。requested_by不参与任何权限判断。Codex试点资格单独记录。
