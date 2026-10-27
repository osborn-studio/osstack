# 对原设计的修订与未决事项

## 1. 文档关系

保留 Firstmate 原 24 FM ID、37 基础工作包、50 项扩展路线图和 ADR-01–16；保留 pstack 24 PS ID、19 个 W 包及原始文章阅读证据。本目录不把两个计数相加称为“新增 69 个功能”，也不覆盖旧通过记录。

`legacy-work-map.json` 保存原依赖与原状态，给出对应联合里程碑。**覆盖关系不是等价完成关系**：一个 J 里程碑通过，不意味着它关联的全部 FM/W 原任务完成；反之，旧 local pilot 不等于新联合路径通过。Firstmate 原 delivery-gates 快照继续约束其发布切片。

pstack 修订 2 的 `work_packages` 曾只从文章 delta 投影，漏了 9 项。联合表对全部 24 项给出完整 W 映射，并把旧值保存为 `article_delta_work_packages`。PS10/11 的形式化、PS14/15 的性能、PS22 的外部事件延期但有负责人和验收。旧 A01–A48 保持原状态，JA01–JA69 是新的跨系统场景，两者不因编号相似互相替代。

## 2. pstack 审计处置

| 旧发现 | 本次设计修订 | 实施/验证归属 |
|---|---|---|
| D01/AU01/CH03：9 项无任务 | 完整 W 映射与文章影响映射分列；联合映射覆盖所有 FM/PS | 本轮机器验证；运行资格未升级 |
| CH10：architect 归因 | 使用反推接口归属 architect；technical-writing 保持文档用途分类 | 来源索引/旧 catalog 增量说明 |
| D02：首个场景未命名 | `session-answer-receipt`，明确调用者、起点、终点、故障和清理 | J03、JA05/06/44 |
| D03：必需材料通道不明 | 明确 v2 host method mandatory 通道，原 frozen brief 不变 | J04、JA07–09/46 |
| D03：产物声明无人消费 | host 所有证据目录、候选绑定、reviewer 读取和缺失 gate | J07、JA14/15/45 |
| D04：检查映射/primary 不确定 | 仓库角色映射、唯一 required primary，建议不暗中执行 | J05、JA10/11 |
| D05/HV01：资格自举环 | candidate 离线→精确受限试验→独立测量→qualified→active | J08/J09/J23/J10 |
| D06：故障/driver/map writer | 分类、动作幂等、资源归属和指定维护者 | J03/J06、JA13/44 |
| D07：strict/来源对象/外部依赖 | 新 v2 strict、旧 v1 保持；缺 Git 对象失败；只追踪实际采用依赖 | J02、JA03/04 |
| D08：结构与语义混淆 | 固定 transcript、隐藏 oracle、真实新增 wrapper 测试 | J04/J25/J32、JA12/45 |

完整来源对象取得：实现 J02 时由受控 fetch 将精确对象放到来源缓存，限制仓库、大小与网络预算；本轮 source verify 不下载缺失对象，只报告 missing。`ls-remote` 只确认 ref，不证明已经具有子树内容。

上次 Fable 建议直接追加 frozen brief 已被纯函数探针证伪。该结论继续有效，本轮没有重新执行或把旧探针称为新产品验收。新的通道仍待实现后验证。

## 3. Firstmate 审计未关闭项

| 项 | 本次设计决定 | 仍需什么证据 |
|---|---|---|
| R1 broker 孤儿 | J12/J17 明确包含 pending/held orphan、owner/代数/静默证明及跨 home 禁止释放 | 真实 broker 夹具、故障与停止证明；仍待实施 |
| R2 回执存储/迁移环 | 选增量 operator recovery receipt；J11 规格→J12 目标恢复→J13 迁移；SQL 编号实施时分配 | 当前 migration diff 和真实旧 hold；不以 schema 示例替代 |
| R3 receipt 字段与缺 schema-spec | 本轮 schema 有字段；JA47 明确逐字段变异，J26 检查真实交付记录 | 产品 verifier 与真实 schema gate；本轮仅结构层 |
| R4 home/broker 保守耦合 | 拆支持格：local 先 home recovery，跨 home/broker 启用前两种证据齐备 | 每个发布切片的实际 requires，不能绕过原 S2 测量 |

这些项记为 **design_addressed_implementation_pending**，不改旧 followups 的 open_planned，也不把旧 Sonnet 通过结论挪为本版签字。

## 4. 本轮没有证据可以决定的事项

| ID | 未知 | 负责角色 / 必须在何时解决 | 保守默认 |
|---|---|---|---|
| O01 | 首个真实 Provider 是否能满足目标停止/查询/隔离 profile | qualification-owner，J23/J14 前 | 只允许可信隔离试验，不认证 production |
| O02 | 新方法通道会否改变 Graph v4 编译输出或实际 host tuple | context-owner，J04 合入前 | 保持冻结程序；必要时另版本，不强行兼容 |
| O03 | operator receipt 的精确 DDL、索引及迁移号 | state-owner，J11 | 规格先行，未有恢复构建不执行迁移 |
| O04 | 用户任务集、真实费用可观测性和预算 | evaluation-owner，J25 实验前 | 合成可行性结果不外推收益；费用 unknown 单列 |
| O05 | 多租户、远端、物理断电、恶意同 UID 支持 | qualification-owner，相关启用前 | unsupported/not_run，不能继承本地证据 |
| O06 | 主干未来变更与 #271 合入结果 | integration-owner，每个 PR 起始 | 比对新基线和范围，不用旧快照替代现状 |

这些未知不会阻止设计文档完成；它们会阻止对应产品实施阶段的准入或启用。角色未分配给具体人，不伪造责任人已接受任务。

## 5. 维护与上游变化

source-owner 管理来源/许可与差异分诊，method-owner 管理方法模板与使用草图，verification-owner 管理 driver/feature map/独立判定器，state-owner 管理恢复和迁移，qualification-owner 管理测量与撤销，release-owner 管理启用范围。CODEOWNERS 可以帮助路由审查，不能推断某人已承诺运行维护。

上游变化按 instructions/skills/hooks/runtime/tests/config/presentation 分类；无法分类的变化进入未映射清单，不自动忽略。原始报告覆盖的是已识别的 48 个能力组，不是两个仓库逐行完整性证明。后续 J02/R03/R04 继续维护源码覆盖和未归类行为，不能因为本表完整就声称上游没有其他能力。

作者文章的影响保持具体：Pt.1 → J03/J06/J23 的工具、环境、地图与维护；Pt.2 → J05/J06/J25 的意图、原始证据、使用草图与小实验。作者个人使用经验不当作 OSStack ROI 或性能保证。

## 6. 本轮 Sonnet 联合审计

[审计报告](claude-audit.md) 保留原文、证据与逐项处置。恢复 bootstrap 和 local/broker gate 收窄已分别登记 JADR11/12，明确修改旧规划的适用范围；未改旧审计记录。旧 114 个验收场景新增逐项机器映射，当前仍未执行。O01–O06 同步为 unknowns.json 的阶段门槛，未伪造已解决状态。

## Sonnet联合审计后的权威入口

47条意见的接受/部分接受与理由见 claude-audit.md。JADR13固定为Graph root许可消费；恢复后态使用JADR15。JADR11/12/15明确扩展旧恢复设计的特定部分，不改写旧输入。J01/J11先冻结完整版本化合同，后续每次迁移按精确候选重新资格；O01–O06仍open。本轮只完成设计和审计，没有实现或发布产品代码。
