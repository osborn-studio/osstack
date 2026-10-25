# Fable 5.1 挑战审计与共创报告

**结论：四轮 Fable 5.1 挑战后，最后定向复核未发现剩余 P0/P1；可进入受限的已有 Session 采纳试点实施。取消权限 P2 已在用户授权实施后按 ADR-15 定案；下表保留原审计时状态。** 完整目标派发、Loop/Graph 自动路由、24 项能力默认融合和生产部署都不在此通过结论内。

审计对象：本目录的工程 Agent 设计。运行时尚未实现。模型意见用于发现设计问题，不构成生产正确性证明。

## 执行记录

使用本机 Claude Code CLI 2.1.291。认证检查为 loggedIn=true，实际探测成功。请求模型与返回 `modelUsage/canonicalModel` 均为 `claude-fable-5-1`。这证明服务返回的型号标识，不是独立的模型权重鉴定。

调用采用工具关闭模式；禁用 slash commands、自定义配置、MCP 和会话持久化。输入经文件传入。Claude 只能审阅冻结的设计及源码摘录，不能修改文件、运行测试或自行遍历仓库。

- [调用元数据](evidence/fable-5.1/invocation.json)、[模型探测原始返回](evidence/fable-5.1/probe.json)。
- [四轮完整性索引](evidence/fable-5.1/audit-index.json)：请求/返回型号、耗时、输入与输出摘要；原文内容一致，首轮 Markdown 仅附加一个结尾换行。
- 第一轮：[完整原文](evidence/fable-5.1/round1.md)、[原始 JSON](evidence/fable-5.1/round1.json)、[冻结输入](evidence/fable-5.1/round1-input.md)、[输入摘要](evidence/fable-5.1/round1-manifest.json)。

第一轮耗时约 515 秒，返回 18 项发现：1 项 P0、10 项 P1、7 项 P2。原始结论是“不能按当前文本直接开工”。以下是宿主核对后的处置，不改写原始报告。

## 逐项处置

| ID / 原评级 | 核验与处置 | 设计变更 |
|---|---|---|
| F51-01 / P0 | 接受兼容性缺口。原稿没有要求扫描旧 approved 行，不能称为已发生越权，但未明确禁止这种实现 | ADR-02：历史审批 manual；后续 controller_once 单独绑定与消费 |
| F51-02 / P1 | 接受双 owner 歧义；不接受把 source generation 等同 daemon generation | ADR-03：复用 daemon owner，Mission 用 CAS，来源实例单独绑定 |
| F51-03 / P1 | 确认依赖缺口 | C01/C02 先于 D02；回答与 Mission 事件可在同 DB 事务落盘 |
| F51-04 / P1 | 接受试点路径过长 | adopt_session 首先交付；D08 不再依赖 R/E 或完整主控 |
| F51-05 / P1 | 接受 revision/token 语义不清 | ADR-04：mission/item/session 版本分开，正文与 token 一致，认证后才能读取幂等回执 |
| F51-06 / P1 | 接受停止通道缺口；不采纳“取消后仍无条件发送已预留回答” | ADR-05：T-answer/T-dispatch/T-cancel 明确排序，独立停止和严格未派发证明 |
| F51-07 / P1 | 接受静默证明缺口；拒绝仅凭 Worker 自持 flock 与 PID 作为充分证明 | ADR-07：可信宿主 invocation/containment 证据；不合格 profile 保持 unknown |
| F51-08 / P1 | 接受持久性必须定案；接收端查询用于区分恢复等级 | ADR-08：实际写连接 FULL；query_and_deduplicate 与 stop_and_reconcile 分开 |
| F51-09 / P1 | 接受来源自行前进的处置缺口；拒绝“任意新 turn + 人工消息就自动清除” | ADR-07：精确处置/授权重规划才 supersede；无证据进入对账 |
| F51-10 / P1 | 设计快照 const false 本来就不用于运行时认证；接受运行时资格契约不足 | 新资格 schema：精确 profile、签发者、前置证据、期限、撤销和派生启用 |
| F51-11 / P1 | 推断被完整源码否定。migration 40–43 已在 main；lineage 校验期望集合，不是拒绝所有 attention 表 | ADR-08 澄清实际谱系、feature flag、升级与旧二进制边界 |
| F51-12 / P2 | 接受身份归属和默认租户边界需明确 | answer_recorded 同事务记录 actor 因果；试点仅 NULL tenant，预检明确拒绝不支持范围 |
| F51-13 / P2 | 接受预算承诺应匹配可控范围；不把未知费用自动核销为实际费用 | ADR-10：硬限额与 observed 分开，有可证上限才保守核销 |
| F51-14 / P2 | 接受词汇映射和影子执行边界需明确 | ADR-10：引用 CapabilityKind/模板版本；影子路由不重复生产写动作 |
| F51-15 / P2 | 接受选项映射缺口；不用关键词推导授权，也不一律增加二次确认 | 明确 choice_id 或允许的 text；歧义才请求明确选择 |
| F51-16 / P2 | 接受差分需要机器可读规则 | 新 semantic-divergences.json，未知差异不能自动加入 allowlist |
| F51-17 / P2 | 明确示例中开 PR 的授权前提 | 主文和 ADR-02 一致：具体开 PR 授权不等于合并/部署授权 |
| F51-18 / P2 | 接受应提前测量价值 | V00 前置手工旅程基线，不编造现有样本或收益数字 |

宿主另补 H01：完整 daemon 源码表明 applied 在整个回复回合完成后产生。ADR-06 修正状态和延迟口径；不能先要求 obligation 清除再调用承载回答的 resume，也不能在 applied 后再 resume 一次。

## 共创后最重要的变化

1. 第一试点更短。先让一个已有会话通过统一入口完成决定处理和结果观察；后续再实现初始自动派发与多执行器规划。
2. 权威更少。沿用现有 daemon owner、attention 发送账本和原始审批；新 Mission 只增加目标关联与因果事件。
3. 关键竞态有明确顺序。回答接收、dispatch commitment、取消、应用、停止证明分别记录。
4. 完成声明更精确。applied、工作开始、回合完成、工程交付分别展示和验证。
5. 证据资格按实际环境划分。Schema 通过不等于验签通过，更不等于运行时启用。

## 第二轮复审及修订

第二轮使用同一确切模型，独立新会话，耗时约 442 秒。[完整原文](evidence/fable-5.1/round2.md)、[原始 JSON](evidence/fable-5.1/round2.json)、[冻结输入](evidence/fable-5.1/round2-input.md)和[摘要](evidence/fable-5.1/round2-manifest.json)保留原状。它确认核心架构收敛，提出 5 项 P1 和 1 组 P2。

| ID | 核验与修订 | 落点 |
|---|---|---|
| R2-01 / P1 | 接受未派发 reserved 无出路的问题。严格区分“首次派发”与“未知发送重试”：仅新协议、统一门、持久 v+1、来源/授权不变、无取消且独占准入时恢复第一次派发。committed/legacy 不重发 | ADR-05/11；WD-51/52 |
| R2-02 / P1 | 确认现有 CHECK 不接受新处置；采用 action 一对一 phase 扩展表，联动 guard/reconcile/所有执行入口。源码显示旧 session.send 本来就拒绝 accepted，未发现既有绕过漏洞。保留 item 唯一约束及取消后同旧问题不能再答的试点边界 | ADR-11；WD-53/54/62 |
| R2-03 / P1 | 接受来源字段未定。固定 Session/native ID 的规范摘要与试点 generation=1，进程 invocation 另记；完成证据绑定精确 message 与新 turn/version | ADR-12；WD-55 |
| R2-04 / P1 | 接受无 action 时缺少处置入口。补 dispose_wait，但收紧建议：必须有 mission.steer；人工声明只调整观察依赖，不伪造已应用、不释放未知发送或安全审批 | ADR-13；WD-56/57 |
| R2-05 / P1 | 接受试点完成条件未定，但不接受以 Run terminal 判定。完整源码证明 Session start 在等待决定时也可 finalizeRun(completed)。改为 observed_turn + ObservationProof；退出观察不是工程成功 | ADR-14；WD-58/59/60 |
| R2-06 / P2 | 密钥角色/level/范围由信任库约束；撤销由独立运维根签发并拒绝回退；明确 Mission revision 的推进条件；修正 token 字段；旧 db.ts 注释纠正列入实施任务，不修改本次生产源码 | ADR-09/12、试点 §5；WD-61 |

宿主另补 H02：D07 原先要求全部场景，暗含 R 系列和完整主控依赖。新增 delivery_stage/owner_work_item，并让校验器检查首个试点的场景负责人和依赖闭包。后续场景仍为 not_run，不能因拆分阶段而豁免。

## 第三轮复审与最后一项衔接修订

第三轮耗时约 202 秒。[完整原文](evidence/fable-5.1/round3.md)、[原始 JSON](evidence/fable-5.1/round3.json)、[冻结输入](evidence/fable-5.1/round3-input.md)与[摘要](evidence/fable-5.1/round3-manifest.json)。其结论允许启动最小协议/存储工作，但指出 D04 前仍需补 1 项 P1，未宣称全盘通过。

- R3-01：接受旧 recover/abandon 与新 phase 的衔接缺口。CAS 同事务检查无 resolution 且 action 仍 reserved；recover 不把确知未派发的动作改成 uncertain；取消回执在所有旧入口一致返回；reserved 上的 abandon 明确拒绝并引导 cancel。纠正审计中的测试表述：拒绝 abandon 本身不是取消，必须把“已有处置阻断派发”和“随后真正取消”分别验证。
- R3-02：明确试点 mission.steer 仅归 adopt 时认证的 owner_principal_id，使用时仍需当前 scope 权限；同 scope 的其他 actor 不自动继承。
- R3-03：试点旅程改为 ObservationProof；补齐可行动错误；WD-61 能力映射修正为 FM-15/19。
- 明确 stop_intent 落在 C02 持久 Mission 事件中；原子性、宿主 lease 与跨重启准入仍须实施验证，不能因模型未找到更多问题而算通过。

## 第四轮定向复核与最终设计结论

第四轮耗时约 83 秒。[完整原文](evidence/fable-5.1/round4.md)、[原始 JSON](evidence/fable-5.1/round4.json)、[冻结输入](evidence/fable-5.1/round4-input.md)与[摘要](evidence/fable-5.1/round4-manifest.json)。本轮只复核 R3 修订，不是一次新的全仓审计。模型确认 R3-01/02/03 均关闭，在该设计范围内无剩余 P0/P1，支持开始有界试点实施。

保留的非阻断事项：

| 项目 | 当前处置 | 责任与门槛 |
|---|---|---|
| P2-A：cancel/endObservation 的具体 principal 授权 | 尚未冻结。停止通道可用不等于任何人均可停止；不直接采纳“scope 写权自动拥有全部取消权”。须明确 owner 权限撤销后由哪一个仍有合法停止权的宿主/操作员负责。endObservation 也必须有具体权限，不能解除未知执行守卫 | C01/C02 协议 PR 明确定义主体、作用域、撤权和接管规则；D04 实现/发布前有对应负例，不能留成实现者自行猜测 |
| P2-B：旧二进制拒绝新库 | 第四轮片段缺失，不能说模型验证过该点。宿主重读固定源码确认 assertSupportedVersion 已在迁移前拒绝更高版本。真实旧二进制兼容测试仍未执行 | D02/D07 用隔离 home 验证旧程序打开新 schema 拒绝且不改变库；不改 user_version 回退 |

[宿主源码复核补充](evidence/fable-5.1/host-source-addendum.md)还确认 recover 的真实启动调用和已有事务包装；文件锁/lease 跨重启的实际停止效果仍需宿主测试。这里明确保留输入遗漏和不同证据强度，不修改历史审计原文来制造全盘通过。

实际设计校验通过：24 项能力、74/74 固定来源摘要、37 项工作包、66 项待实现场景（58 项采纳试点、8 项后续阶段）、5 个非法注册表样本。所有场景仍为 not_run，生产 runtime_verified=false。

下一步是按本规范实施和验证。模型审计没有执行生产测试；新主控、真实 Session 路径、隔离、性能、断电和用户实验尚未完成。

## 实施顺序与待取得的独立证据

先实现 C01/D01 的最小协议，再完成 C02/D02 的存储和递增迁移；D03/D04 接入同一个回答事务与派发门；D05/D06 做单入口和观察归约；D07/D08 交付受限试点。R 系列可并行。完整目标调度、Loop/Graph 路由和 24 项默认行为接线继续属于后续里程碑，不能以试点完成替代。

| 尚缺的事实 | 责任工作包与具体方法 | 阻断范围 |
|---|---|---|
| 真实 Session 回复、重启和取消 | D07/D08：隔离 OSSTACK_HOME，真实 Adapter 回执，事务边界 SIGKILL、双入口竞争、取消先后交错 | 首个试点验收 |
| 不可信 Worker 无法改控制平面与残留子进程无法继续写 | V03：实际宿主权限边界、进程 containment、跨重启 invocation 查询、旧写者攻击测试 | 相应宿主的生产写入资格 |
| FULL 在目标文件系统/硬件上的实际持久性 | V02/V03：进程崩溃与物理断电分开记录，独立核查数据库和外部操作 | 相应恢复承诺；SIGKILL 不能替代断电证据 |
| Provider/远端操作的去重、查询和停止能力 | E/I/V03：真实 API、断网代理、原 message/invocation 查询，不用本地模拟推定远端停止 | query_and_deduplicate 等高级恢复等级 |
| 延迟、成本和用户管理负担是否改善 | V00/V04：先记录手工基线；同任务对照、分母、失败与未知费用单列 | 性能与产品收益声明 |
| 有限状态安全及测试敏感性 | V01/V02：TLC、属性序列和删除关键保护的变异测试，由独立检查器复核 | 安全关键实现与默认启用 |

这些项目目前均未因 Claude 的意见变成通过。设计包中的场景状态保持 not_run，工作包保持 planned，24 项能力保持 runtime_enabled=false。


## 实施前定案补充

2026-10-25：P2-A 已由 [ADR-15](runtime-contract-v2.md) 和 [实施交接](implementation-handoff.md) 冻结。原四轮意见不改写。后续 Sonnet 5.5 将审查实际实现，包括写权撤销但停止权仍有效、普通 writer 不能取消别人的 Mission、凭据完全撤销、operator 作用域、结束观察保留未知回执等负例。
