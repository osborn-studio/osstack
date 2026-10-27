# 组件契约与真实主机验收分层

本修订拆分验收职责，使来源、夹具和恢复规格可以消费冻结的组件契约，同时保留真实授权/完成边界。它不执行任何 gate，不开启运行时，所有机器行仍为 `specified_not_run`。当前共有 126 个阶段节点、70 个联合场景；原 114 个场景和 legacy/release 要求全部保留。

## 组件与主机各自证明什么

| Gate | 直接前置 | 联合场景 | 能证明的范围 |
|---|---|---|---|
| `J01.contracts` | 无 | JA59、JA70 | strict JSON/expected-kind、完整组件形状、身份与角色绑定、独立规范字节与摘要域；不证明主机授权或完成 |
| `J08.admission_boundary` | J01.contracts | JA02 | 真实受信主机 admission 的 repo/scope/current-authorization 边界；不发 permit、不建 run、不调用 executor、不持久消费 |
| `J01.scoped` | J01.contracts、J08.admission_boundary | JA01、JA02、JA59、JA70 | 原真实 Session/task 完成隔离及任务授权绑定，加组件验收 |
| `J08.scoped` | 原 J03/J07/J12/J08.recovery，再加 J01.scoped | 原 JA16/JA17/JA49/JA61 | 首次完整受限 trial；不得早于真实主机边界证明 |

JA01 保留原“请求 task local_verified”的行为，不能改为另一个完成级别再宣称符合原验收。Session observed_turn 不能替代 task checks/review，oracle 必须读取独立 task/session 记录。JA02 保留 proposal 仓库 A、授权仓库 B、真实 admission 拒绝、adapter 调用数零和移除 repo/scope 比对的坏变体。两条 case 的原语义字段以 `d3fa7ef681efc79a5fb2dff92172ef1be0978774` 为基线固定；验证器拒绝语义偷换。

J08 的边界子片必须使用实际受信主机入口；pure helper、parser 单测、无条件拒绝或 fake host 不能替代 JA02。独立 oracle 应包括相同 repo/scope 的正控制，并在移除比对后杀死坏变体。将来完整 trial 必须证明调用的是同一受检边界，不能另开绕行入口。初期入口无动作权限，不因它存在而获得新 permit 或启动能力。

这份阶段计划既不实现 admission，也不声明主机已有合格入口。JA01/JA02/JA59/JA70 的 oracle 均须在新候选之前冻结，独立作者/保管人/实现者/安全复核身份必须按原规则记录。多个 agent 的名称不构成身份独立性的证明。

## 仅四项组件前置替换

`work-packages.json` 保留原 J01 工作包依赖，并显式记录 `dependency_gate_overrides: {"J01":"J01.contracts"}`，仅适用于 J02、J03、J04、J11。它们对应 scoped gate 使用组件前置；J04 的 J02 前置保持。来源解析/现有 Session 夹具/纯装配/恢复规格可以独立候选推进；新的方法运行接线仍需对应真实 admission、恢复、支持组合和执行门槛。

该 override 是验证器中的闭合白名单，不能为 J08 绕过 J12、不能指向其他 owner、不能动态加入消费者。J01.scoped 仍由 J23/J26、legacy 与发布链消费。J27.scoped、J27.default_enable、J27.full_original_completion 的传递依赖必须包含 J01.scoped；原 Firstmate 发布 gate、schema 恢复 gate 和本地 broker-disabled 例外均未改变。

不能把 J01.scoped 改为等待完整 J08.scoped：完整 trial 又要求 J01.scoped，二者形成循环。这里先交付无副作用的真实 admission 边界，再做主机验收，然后才运行 trial。

## 两种 case 命名空间

- `case_requirements` 继续只引用原 Firstmate/pstack legacy case IDs，原投影和 release 消费校验不变。
- `joint_case_requirements` 显式引用 JA IDs。每个 Jxx.scoped 精确消费该工作包的全部 `acceptance_ids`；新组件 gate 只消费上表所列集合。未知、重复、缺失或未注册消费关系均拒绝。

这是规划验证，不是运行证据鉴定器。后续实际 GateEvidence 消费方必须对每个 required case 验证独立预冻结 oracle、精确 candidate/support cell、原始观测/负变体及其摘要；case 名称或 `specified_not_run` 行本身不是证据。组件通过不替代原 host 或 legacy 场景通过。

## 本次 O06 与后续并行边界

本次设计候选从 `d3fa7ef681efc79a5fb2dff92172ef1be0978774` 开始。#271 merge `ce543535be9b1ef96a8c4fb14d13ea8483444051` 的43个变更均为README/docs，8份归档Firstmate输入与本次main逐字节相同。具体路径/摘要见 [O06 preflight](evidence/gate-layers/o06-preflight.json)。这些事实支持本次设计切片的接口判断；没有永久关闭 O06。新main、消费接口或写范围改变时必须重查，历史 baseline 保持原样。

本修订只提供组件/主机分层。J11 的 JA20 仍要求真实 home/broker DDL 输入和生产者关系；尚未生产的 broker DDL 不能用 home 模板替代。JP-17a 可以先生产可审查候选规格，正式 schema/recovery gate 与编号分配仍按 state-owner 队列。JA47 字段矩阵、J02b 离线闭包和 JP-03a 隔离 driver 可在独占文件范围准备；J12 迁移合入仍受 O03 和原恢复证据规则约束。
