# Firstmate 路线图的联合设计增补（2026-10-27）

当前跨项目接口与实施协调见 [Firstmate × pstack 联合设计](../2026-10-27-joint-engineering/README.md)。本文件不改写原冻结设计、审计或任务状态，不启用运行时功能。

本次把 Firstmate 24 项能力和 50 个原任务全部保留，与 pstack 的 24 项能力、19 项任务建立交叉映射。共享职责按 OSStack 模块划分，原 ADR-01–16 和 #271 安全约束保持。原文件在本 checkout 缺失时，使用 [固定 Firstmate 路线图](https://github.com/osborn-studio/osstack/tree/4199d9aadf776042d924a0a307c62aef1a729088/docs/design/2026-10-26-firstmate-upgrade)；不能把旧 checkout 当作最新主干。

具体增补：

- R01–R05 与 pstack 来源/方法登记共用身份和证据引用，behavior/method/host/executor 资格仍分型。
- C07 与 pstack 方法材料共用 execution-context 接入；必需方法单独通道，保持冻结合同。
- C03/C04/E 系列继续是主控/执行器权威，方法编译器不自行调度或派发。
- DEBT02/I04 先冻结恢复 schema 规格，再交付目标恢复构建，最后落主控迁移；broker 孤儿与旧 attention hold 均纳入验收。
- D 系列 observed_turn 与 I03 工程任务 local_verified 分开；联合旅程需要两层证据。
- 原 50 任务状态保留，新联合里程碑只是更细的跨路线实施与验收安排。

见 [原任务交叉映射](../2026-10-27-joint-engineering/legacy-work-map.json)、[审计处置与未知](../2026-10-27-joint-engineering/reconciliation.md)、[PR 计划](../2026-10-27-joint-engineering/implementation-plan.md)。本轮未更新运行时看板，也未向 Firstmate 会话发送消息。

## Sonnet 5.5 联合审计增量（2026-10-27）

联合规范新增 JADR11：带 hold 的旧库只允许精确白名单 recovery-ledger bootstrap，普通升级/业务迁移继续阻断；JADR12：local_without_broker 的 home-only 恢复切片与原全量 I04.compat_recovery 分开。两项改变由联合设计明确承担，不改写原 #271 输入或旧通过记录。66 个 WD 场景保留为当前候选的继承 gate。完整边界、验收与原审计见 [联合审计规格](../2026-10-27-joint-engineering/audit-specifications.md) 和 [审计报告](../2026-10-27-joint-engineering/claude-audit.md)。

复审修订3进一步明确 JADR15：精确已停止证明与独立恢复账本才能支持未来 hold/fence 处置，不能伪造 applied 或释放未知费用；legacy_unknown 仅保留未知。J12负责专用数据库打开与迁移前守卫，每个后续迁移独立资格。原gate使用完整依赖wrapper、66个WD有case级消费边，组件通过不等于原能力完成。详见 [复审精确规格](../2026-10-27-joint-engineering/closeout-specifications.md)。当前产品行为未修改。


## 并行实施与统一收口

当前执行状态以 [联合账本](../2026-10-27-joint-engineering/execution-ledger.json) 为准。#276 R02 和 #278 cleanup 已进入最新 main 重定向验证，#279 预检测试已提前完成但仍待前置合并后重验。原任务范围与验收门槛保留，用户只处理已准备好的审批合并批次。具体分工、OSStack 卡片、证据规则和下一批门槛见 [项目推进规则](../2026-10-27-joint-engineering/project-operations.md)。
