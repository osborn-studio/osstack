# Firstmate 借鉴设计：Claude Fable 5.1 挑战审计

日期：2026-10-23。对象是研究与设计，不是已实现功能或生产验收。

## 执行与证据边界

使用本机Claude Code CLI 2.1.291，指定`claude-fable-5-1`；probe及三轮返回的modelUsage均包含同名模型。工具、MCP、slash commands、hooks和会话持久化均关闭，工作目录为独立scratch，输入是本次保存的源码摘录与设计。模型没有自行遍历完整仓库，也没有运行测试。原始JSON、原文和输入均保留，不能把此审计称为独立全仓代码审计。

本地路径与源码片段进入了用户授权的Claude审计输入；没有读取凭据或环境密钥。审计只用于发现设计问题，最终取舍由本报告逐项说明。

## 第一轮：不通过，修订后复审

[完整原文](2026-10-23-firstmate-evidence/claude-round1.md)、[原始返回](2026-10-23-firstmate-evidence/claude-round1.json)、[完整输入](2026-10-23-firstmate-evidence/claude-round1-context.md)。模型耗时约218秒；不是人工工时或实现耗时。

| 编号 | 模型意见 | 处置 | 修订定位与理由 |
| --- | --- | --- | --- |
| P0-01 | daemon恢复会清理未知worktree，与保留原则冲突 | 接受问题，采用更严格方案 | 设计§2/13、计划D1–D3：S0不启动daemon；S1前修正全局恢复入口，不能仅跳过已登记Loop |
| P0-02 | session.version进identity导致重复item，回执无decision_id | 接受问题，修正建议中的不足 | §6/9/18：identity含origin_turn避免同decision ID复用；独立CAS；按message_id核对session/turn/kind/payload，不能凭不存在的decision字段查询 |
| P1-03 | collaborator负责的决策被误分给人 | 接受 | §5.3/9：核对grant/attempt/turn/digest，active但无调度证明是coverage_unknown；共享持久reservation在S2验收 |
| P1-04 | 持久idle/终态被freshness错误衰减 | 接受 | §5.2：业务事实独立，只有活跃观测和覆盖过期 |
| P1-05 | 新observer锁未修复daemon并发启动 | 接受 | §7/13：原子进程admission与DB generation同一owner，先拿所有权再执行启动副作用 |
| P1-06 | CI真实绑定把网络拉进首期 | 接受 | §5.3：S0/S1零CI网络，自报unclassified；验证延后S3 |
| P1-07 | session ID没有可判断死亡的进程语义 | 接受 | §5.2：S0 live unknown，S1 dead仅限实际拥有并见exit的run子进程 |
| P2-08 | 重复保存run事件 | 接受并补保留条件 | §6：原生events只存引用，未决证据pin或最小快照；新来源才新建事件表 |
| P2-09 | 新增supervisor包过重 | 部分接受，驳回事实前提 | O16证明该包已经存在；保留它，只有公开协议进protocol，内部归约类型留包内 |
| P2-10 | brief表与分期冲突、优先级未定义 | 接受 | §6/10：brief及cursor同在S2；确定性优先序把投递不确定/证据故障放最前 |
| P2-11 | 标脏不能代替正确分页补扫 | 接受 | §7/18：补扫是正确性来源；session无全局日志，按每cycle固定集合重读，披露瞬态gap |
| P2-12 | OSStack没有primary actor身份 | 接受 | §8/18：S2显式注册foreground client，真实harness验证前禁用hook |

首个切片进一步收紧为一条零迁移只读CLI，不完全采用模型建议的三张表后台循环。原因是可以在修复daemon宿主前独立验证用户价值；它明确不宣称后台监督。

## 第二轮

[完整原文](2026-10-23-firstmate-evidence/claude-round2.md)、[原始返回](2026-10-23-firstmate-evidence/claude-round2.json)、[输入](2026-10-23-firstmate-evidence/claude-round2-context.md)。实际耗时约228秒，is_error=false，modelUsage为claude-fable-5-1。

结论：S0可作为实现起点，无剩余P0；S1/S2有4项P1及4项P2需收口。处理后发第三轮定向复核。

| 编号 | 处置 | 依据和变更 |
| --- | --- | --- |
| S0-tenant | 驳回降级建议，补证据 | O19迁移3已向tasks/runs加tenant_id；缺列必须unsupported，不能为了可用性去掉scope过滤 |
| S0-schema | 部分接受 | §18.1初始支持24，未来版本须验证加法兼容；不直接接受任意version≥24 |
| P1-A stale grant | 接受分类缺口，纠正现有行为推断 | O20/O21证明beginCheck已block cursor_changed；O22证明reserved合法增长版本，不能用小于比较一刀切。§19.1补先匹配attempt再判stale，人工显式接管与统一入口 |
| P1-B 锁恢复 | 接受 | §13/19、D1改为内核退出自动释放的advisory lock；明确Node需binding、固定inode与OS资格门禁，不以wx冒充 |
| P1-C 准入来源 | 接受，修正驱逐风险 | §19.3新增keyset发现；已接管subject不因高优新项静默被驱逐，超额项显示uncovered；S1-D验收 |
| P1-D 外部答复 | 部分接受 | §19.2精确消息绑定continued_externally，独立计数保留；普通续轮不能清除授权义务或被称已正确回答 |
| P2-A accepted语义 | 接受 | §18.1纯DB只能in_flight_or_uncertain，S1可用本地精确绑定精化 |
| P2-B FK删除 | 接受 | §6对业务源无cascade FK，保留最小快照与source_missing |
| P2-C generation归属 | 接受 | D1只内核锁，S1-B含daemon_owner迁移和generation |
| P2-D 包与文件 | 接受 | 已有的是包，两个归约模块是拟新增；lazy import预算与Zod版本边界写入§19.4 |

补查还发现loop-engine.ts在cycle前/后也调用orphan清理（O23），D2已分两批覆盖；O24确认Codex适配器已有resume实现，真实二进制资格仍待试点。模型未见这些摘录之前的疑问不能当作源码缺陷结论。

## 第三轮

[完整原文](2026-10-23-firstmate-evidence/claude-round3.md)、[原始返回](2026-10-23-firstmate-evidence/claude-round3.json)、[冻结输入](2026-10-23-firstmate-evidence/claude-round3-context.md)。耗时约152秒，is_error=false，modelUsage为claude-fable-5-1。

模型结论：第二轮4个P1、4个P2及S0前提已闭环；**无剩余P0/P1，S0可进入实现**。D1–D3、S1、S2仍为未完成的实施门禁，设计审计不改变其状态。

| 新编号 | 作者处置 | 最终定位 |
| --- | --- | --- |
| P2-E attempt精确匹配 | 接受并收紧 | 设计§20.1/S1-A/S2-B：checking/reserved核对源/消息/版本；stale/expired/failed不能当未执行，仍阻止盲目接管 |
| P2-F requested_by不可信 | 接受 | §20.2/S2-A：只通过actions/attempts中的精确message ID与完整绑定识别，不依赖字符串前缀 |
| P2-G fd继承及文件系统 | 接受 | §20.3/D1/D3：CLOEXEC、无子进程继承、OS及本地文件系统资格；故障诊断不自动杀未知worker |
| P2-H uncovered信息 | 接受 | §20.4/S1-F：最少输出scope、ID、state、待决定标记、发现时间、原因、未决回执 |

这四项已写入最终设计和任务验收，属于第三轮后作者落实，未运行第四轮。源码的Zod 4/3差异也可由O01的现有注释核对；模型第三轮未拿到O01，不应把“本轮未核实”写成事实错误。

## 最终裁决与残余条件

- 研究与设计交付完成；可以把S0-A至S0-D作为下一次实现任务范围。
- 不直接开启S1/S2。内核锁binding、所有恢复/清理调用点、源保留、实际消息竞争和真实harness资格要通过计划中的测试。
- 首轮拒绝、第二轮条件可行、第三轮无P0/P1的完整过程保留；没有把模型意见改写成无条件批准，也没有把被驳回的建议悄悄删除。
- 审计覆盖的是给定源码摘录和设计。模型未访问完整仓库、未运行产品；主任务的来源核对和上游测试证据另存。

## 不属于审计放行范围的事项

- 所有性能数值是待测目标；模型没有验证p95、成本下降或真实恢复。
- 新API、数据库表、hook、原子锁及恢复修复均未实现。
- 三组firstmate行为测试与216个Shell语法检查由主任务实际运行；不能算Claude完成的测试，也不能算OSStack新功能验收。
- 后续实施必须重新核对当前代码基线，完成每期fault tests和真实隔离pilot。设计审计通过也不授权发布或自动执行。
