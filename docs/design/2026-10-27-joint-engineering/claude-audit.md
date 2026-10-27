# Firstmate × pstack 联合设计：Claude CLI Sonnet 5.5 审计

日期：2026-10-27。当前完成范围为设计修订与文档校验；产品代码、运行时 DB、真实 Provider、迁移和发布均未启动。

## 实际调用与原始意见

使用本机 Claude CLI 2.1.291，模型元数据确认 `canonicalModel=claude-sonnet-5-5`。review 与 challenge 是两个独立提示词的同一模型，不是跨模型共识。CLI 无 Bash/Edit/Write/MCP 工具，所有输入经 stdin 提供；原文与JSON未修改。

- [完整审计原文](evidence/sonnet-audit-2026-10-27/review-recovered-raw.md)：18 条，原判定 **REVISE**，5 P1、12 P2、1 P3。
- [对抗性挑战原文](evidence/sonnet-audit-2026-10-27/challenge-raw.md)：16 条，包含原作者标注的 P0；这是设计审查意见，未证明现行运行时漏洞。
- [逐条处置机器表](evidence/sonnet-audit-2026-10-27/dispositions.json)：34 条意见，有重合，不能称为34个独立缺陷。
- [输入清单与hash](evidence/sonnet-audit-2026-10-27/input-manifest.json)、[完整审计调用元数据](evidence/sonnet-audit-2026-10-27/review-recovered-run.json)、[挑战调用元数据](evidence/sonnet-audit-2026-10-27/challenge-run.json)。

Fable 首次输入超过上下文限制；缩减后的两个任务在用户改用 Sonnet 时仍运行，已终止并保留[记录](evidence/fable-audit-2026-10-27/user-model-switch.json)，没有确认周限额。Sonnet 第一份 review 触及输出长度，返回残缺尾部；[残缺原文](evidence/sonnet-audit-2026-10-27/review-raw.md)仍保留。用相同输入提高输出上限后取得有 BEGIN/END 的完整报告，处置以完整报告编号为准。

## 修订后的核心决定

1. 共享身份：固定摘要域、字节规则与对象输入，补 Binding/Profile/Recipe/Proposal/ArtifactRequirements；旧合同与 Graph 版本保持原规则。
2. 试验许可：一条 root run，内部实现/评审/重试单独预算；消费与Graph root创建同事务，内部action沿用原admission；失败或未知不复活旧许可；24h TTL与精确scratch/主体约束。
3. 恢复：phase×decision×proof矩阵、旧attention/effect/broker分型；JADR11采用白名单恢复账本迁移，避免带hold的库无法记录裁决；JADR12保留local与full broker恢复范围差别。
4. 材料与证据：builder/reviewer/verifier材料分离；baseline复现与最终候选检查分相位；host-owned配置可重启重算，不污染用户仓库。
5. 计划：阶段gate与开放未知机器化；E0/E1、资格和默认启用分开；新增schema走state-owner队列和目标恢复门槛。
6. 覆盖：114个原场景保留，新验收补到69项；Firstmate差异逐项写明；200个pstack文件分类、恢复来源阅读深度。
7. 判定：独立oracle角色/冻结要求、隐藏共同验收、完整分母和小样本不确定规则；不把模型意见或文档全绿称为产品正确。

完整规范见 [audit-specifications.md](audit-specifications.md)，不是仅在本报告里提出建议。接口、任务、验收与来源机器文件已同步修改。

## 每条意见的处理

接受指确认缺口并修订设计；部分接受指确认核心问题但调整了建议、严重度或适用范围。所有运行验证仍待实施。

| 原编号 | 级别 | 处理 | 确认与修订 |
|---|---|---|---|
| RV01 | P1 | 接受 | digest-catalog 和逐字节 canonical 规则、Binding 自身摘要、26 个黄金向量；旧合同/config hash 不变。 |
| RV02 | P1 | 接受 | host/core 权威存储与 state-owner 明确；方法存储 J08/J10 依赖 J12；所有新 schema 包声明迁移/谱系路径与队列。 |
| RV03 | P1 | 接受 | 24h TTL、30min wall 上限；完整 Binding/profile 绑定、单 root 原子消费与内部预算；失败后新许可。 |
| RV04 | P1 | 接受 | J01 定义 SupportProfile，operator_attested_trial 与 measured_qualified 分型；J08登记试验，J23测量并对接线候选重测。 |
| RV05 | P1 | 部分接受 | 补 actual_target_schema/DDL/fixture/candidate；J11冻结 home+method 状态，broker 在独立 J17.schema_spec 冻结，完整 gate 仍合取两者，不要求首个 local 先建 broker。 |
| RV06 | P2 | 接受 | 选定 host-owned v2 immutable config，不污染 repo；持久 registration 重启重算同 envelope，实时许可状态独立校验。 |
| RV07 | P2 | 接受 | typed subject 区分旧 attention action、effect、broker lease，旧对象不再要求伪造 effect_id；证明按裁决分型。 |
| RV08 | P2 | 接受 | primary→registry command digest→AcceptanceCommandSpec.ref 映射、16项/字节限制、路径语法、512任务ID和首期64KiB预算边界明确。 |
| RV09 | P2 | 接受 | 114旧场景保留，A16/A17/A27等有 gate 负责人；新增可信失败、blocking findings、历史反例与分类器验收。 |
| RV10 | P2 | 接受 | 负例赋稳定 ID，cases covers_negative_ids 双向校验；专门补 wait/gap/父回执/发布权限反例。 |
| RV11 | P2 | 接受 | 原10类方法材料保留在 artifact-catalog，明确 body schema 冻结/生产/消费；五类 host receipts 与材料区分。 |
| RV12 | P2 | 接受 | J25 protocol/E0/E1 分阶段，E1 依赖 J09；J10 及后继经决定门槛，避免全包依赖造成自举循环。 |
| RV13 | P2 | 部分接受 | 接受样本精度不足；40任务改为探索并要求功效分析，不为通过而降低阈值。审计“更高不一致率所需样本下降”的补充不采用；近似方差随之增大。 |
| RV14 | P2 | 部分接受 | 24项FM差异逐项重写，planner不能代答/away不转权、父回执持久发布；不采纳禁止一切非人类自动动作的过宽表达。 |
| RV15 | P2 | 接受 | 恢复原 inspection/usage，另记录本轮 hash核验；200个pstack文件逐项分类，tdd/sequence原则补pin；未采用不等于已语义阅读。 |
| RV16 | P2 | 部分接受 | R04/V01/V02/V05 的真实产出和子工作流明确归 J02/J23/J06；不采用关键词相交充当语义覆盖证明。 |
| RV17 | P2 | 部分接受 | 关键依赖、旧gate、oracle、schema关键约束、图边、PR键、来源和迁移队列增加负例。只主张已覆盖的变异，未宣称任意schema约束完整变异证明。 |
| RV18 | P3 | 接受 | 缺 pstack 当前报告明确失败；README声明完整 checkout及历史审计归档前置。 |
| CH01 | P0 | 部分接受 | 确认设计缺矩阵；补phase/decision/typed proof和真实authority读取。P0是原审计标签，本次归为实施前P1设计阻塞，未证实现行产品漏洞。 |
| CH02 | P1 | 接受 | 选择受控增量 recovery-ledger bootstrap，JADR11明确ADR16窄例外；原hold行/谱系/owner/事务均验证。 |
| CH03 | P1 | 部分接受 | 补完整Binding闭包与TrialSupportProfile、scratch真实路径和issuer验证。无需在permit重复所有已经通过Binding摘要绑定的字段。 |
| CH04 | P1 | 部分接受 | 采用持久单root消费和实际authorize挂点；不采用整条Graph“raw调用恰好1次”的错误验收，改为一个root且内部槽位有界。 |
| CH05 | P1 | 部分接受 | 接受精确字节/域/字段需求；采用受限joint-canonical-v1而非声称完整JCS，保留既有摘要算法不变。 |
| CH06 | P1 | 接受 | 66 FM +48 PS 全量保留原状态与断言、绑定J负责人和适用scope；不能以新JA通过替代旧场景。 |
| CH07 | P2 | 接受 | 新增semantic_assertions及具体状态/简报/清理/分类断言；记录仍需独立语义复核，结构覆盖不是穷尽证明。 |
| CH08 | P1 | 接受 | J03显式拆两个命名driver；J09只消费注册bug-fix场景的受信复现回执。 |
| CH09 | P1 | 部分接受 | 增加早期E0与后续决定门槛；可选pinned pack只用于探索，不替代mandatory或提供资格；不把可行性试验当收益结论。 |
| CH10 | P1 | 部分接受 | 两臂共同oracle、封存holdout、意向处理、小样本与unknown成本规则。要求在锁候选/试验前封存，不强制holdout必须早于所有recipe提交。 |
| CH11 | P2 | 部分接受 | profile标各维enforceability，许可含累计上限，unknown占整笔预留；不可强制的硬预算请求拒绝，不能以忽略该维度放行。 |
| CH12 | P2 | 部分接受 | 每case oracle_spec独立角色/冻结时点及专属证据；当前未分配人或摘要，保持未执行。语义裁决不由同一作者模型自证。 |
| CH13 | P2 | 部分接受 | 登记实际db/migrations/schema与共享资源队列、PR路径manifest；不在未来main未确定时抢占迁移号，合入候选重新分配并复验。 |
| CH14 | P2 | 部分接受 | O01–O06机器化且blocked_by双向校验；按阶段阻断，不阻止为解决未知所必需的规格/调查工作。 |
| CH15 | P2 | 接受 | Binding角色材料映射、receipt.role和受信node-role映射；reviewer不能收到builder专用指令。 |
| CH16 | P3 | 部分接受 | 补检查/Git标识约束及host verifier规则；原schema已有host_record_ref，问题是信任校验而非字段缺失。 |

## 独立核验与限制

宿主额外在内存中构造坏规划，确认旧校验器会接受删除任务验收项、删除pstack原依赖、清空fixture等变异，见 [原始探针](evidence/sonnet-audit-2026-10-27/host-pre-revision-probes.json)。修订后有专门负例测试防回归。另从固定 Graph v4 编译器核实一次运行含多个执行/评审槽位，拒绝把一次root误解释为一次raw调用。

本轮模型输入含94个完整文件，重点覆盖联合交付、继承规划、固定OSStack关键源码及选定上游材料；大体积上游文件的省略清单保留。X文章仅提供早先阅读记录，没有让Sonnet独立读取原文。源码hash证明身份，不能证明每行语义或作者意图。

首轮和第一次复审均为REVISE，原结论保持不变。

## 修订后复审

第一次复审实际模型仍为 Sonnet 5.5，完整 CLOSEOUT_BEGIN/END，结论 **REVISE**。新增 CO01–CO10（4 P1、5 P2、1 P3），8条接受、2条部分接受。与首轮合计44条意见，26条接受、18条部分接受，存在重合，不是44个独立缺陷。

原文见 [第一次复审](evidence/sonnet-audit-2026-10-27/closeout-raw.md)，逐条处理见 [CO处置表](evidence/sonnet-audit-2026-10-27/closeout-dispositions.json)，具体修订见 [修订3规格](closeout-specifications.md)。

| 编号 | 处理与落点 |
|---|---|
| CO01 | 后态四列表、legacy只保留未知、resolution独立读取、JADR15受控hold/fence处置，不能合成applied |
| CO02 | J12专用openRecoveryDb与普通pre-migration guard；每个实际迁移独立schema_spec/recovery，重编号重验 |
| CO03 | legacy显式null、subject/target/home约束、broker相位与证明身份；补正反fixture |
| CO04 | 根ID签发前确定；GraphRunStore创建事务消费；复用graph_actions且permit只能收窄policy；finance cap可缺省并交叉核验 |
| CO05 | role摘要改名并定义输入；完整domain目录、原始JSON解析、转义向量、Profile v2自动start字段、J01明确产出 |
| CO06 | 64KiB配置总上限与角色分配；原子私有registration文件；未终态保留；恢复授权不走过期执行许可 |
| CO07 | 原gate独立full wrapper保留依赖闭包；114case有真实消费边；local明确12项延期；旧scope不被早期组件通过覆盖 |
| CO08 | local opt-in/default分开、E1仅可行性与保护指标、J32输出价值决定；merge_after条件排序 |
| CO09 | oracle生命周期、实际主体独立、冻结早于候选及关键第二复核；不用任意作者占比上限，改为披露集中度 |
| CO10 | 补P0-B恢复依赖和图边、最终统计与复审记录；统计指旧输入，首次closeout冻结后validation已更新，保留其当时原文 |

第二次复审候选已修订到上表范围；后续结果单独归档，不覆盖第一次 REVISE。


第二次完整复审结论为 **PASS_WITH_CONCERNS**，原文见 [第二次复审](evidence/sonnet-audit-2026-10-27/closeout2-raw.md)。新增 CF01–CF03 均接受，修订见 [最终处置](evidence/sonnet-audit-2026-10-27/closeout2-dispositions.json)。累计47条原始意见（29接受、18部分接受，含重合）；审计和复审都使用同一Sonnet模型，不能据此宣称独立跨模型共识。

CF01在第二次复审进行时也被宿主独立核对发现并修复，故该复审输入仍是120 gate版本，最终为124 gate；CF02/03在结果后修订。原结论只适用于各自归档候选，最终修订另做针对性验证。未来实施条件已写回规格：Graph连接FULL持久性、旧schema缺hold表、recovery目标版本断言、oracle真实人员与harness作者身份。这些尚未执行。

## 最终收口与交接

[第三次针对性复审](evidence/sonnet-audit-2026-10-27/closeout3-raw.md) 判定 **PASS_WITH_CONCERNS**，明确 CF01、CF02、CF03 均关闭，未发现需 REVISE 的具体矛盾。它只审查最后三项改动，不能冒充再次全面重读所有原始资料。

其三条非阻塞意见已核对：revision3和final日志都存在；增加default-enable删除R05/V03/V06资格的三个回归子例；核对JA51/52与Firstmate增量说明的最终ADR引用。历史CO处置保留当时JADR13名称，最新恢复决定统一为JADR15，历史原文与输入hash不变。记录见 [最终核对](evidence/sonnet-audit-2026-10-27/closeout3-followup.json)。

实际最终验证：**77项文档测试、100个schema正反例（18/82）、24个正摘要向量、5个非法JSON输入、227个来源锚点核对均通过**；48来源能力、69原任务、32工作包、114继承场景、69新场景、124阶段节点均保持可追溯。未执行的产品场景数量为全部69项，运行验收通过数为0。

当前可交接去做合同与恢复规格实施，但O01–O06依各自阶段继续阻断；不能直接发布或默认启用。重点未来证据：原hold恢复/迁移崩溃、Graph原子消费与FULL持久性、真实Provider与停止域、角色材料/摘要TS互操作、实际独立oracle身份、E1/E2价值实验。S3/S5/broker启用前必须补对应发布绑定与完整I04。

本轮未改产品代码、未打开服务数据库、未创建或合并产品PR。原脏工作区保留。联合目录以外只同步pstack capability-map和Firstmate joint-design-addendum。最终范围与文件hash见 [归档完整性](evidence/sonnet-audit-2026-10-27/audit-integrity-check.json) 和 [最终文件清单](evidence/final-deliverable-manifest.json)。
