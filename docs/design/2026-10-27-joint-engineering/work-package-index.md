# 工作包与 PR 可读索引

机器 JSON 的设计基线投影。冻结时全部为设计/未执行；当前执行状态见 [联合执行账本](execution-ledger.json)。还须满足 execution-gates.json、unknowns.json 和 legacy-case-map.json。

| 工作包 / PR | 结果 | 功能前置 / 额外合并顺序 | 负责人角色 | 验收 |
|---|---|---|---|---|
| J01 / JP-01 | 共享身份、完成与资格契约 | 无 / 无 | contract-owner | JA01, JA02, JA59, JA70 |
| J02 / JP-02 | 共用来源快照与分型注册 | J01 / 无 | source-owner | JA03, JA04 |
| J03 / JP-03 | session-answer-receipt 驱动夹具 | J01 / 无 | verification-owner | JA05, JA06, JA44 |
| J04 / JP-04 | 必需方法材料与 v2 调用回执 | J01, J02 / 无 | context-owner | JA07, JA08, JA09, JA46, JA53 |
| J05 / JP-05 | 检查映射与单方法纯编译 | J02, J06 / 无 | method-owner | JA10, JA11 |
| J06 / JP-06 | 使用草图与三条功能地图 | J03 / 无 | method-owner | JA12, JA13 |
| J07 / JP-07 | 产物消费与同候选评审 | J04, J05 / 无 | verification-owner | JA14, JA15, JA45, JA50, JA68 |
| J08 / JP-08 | 首次受限试验准入 | J03, J07, J12 / 无 | qualification-owner | JA16, JA17, JA49, JA61, JA71, JA72 |
| J09 / JP-09 | 首个本地 bug-fix 方法旅程 | J08 / 无 | integration-owner | JA18 |
| J10 / JP-10 | 方法资格与激活漂移管理 | J09, J23, J12 / 无 | qualification-owner | JA19 |
| J11 / JP-11 | 恢复回执目标 schema 规格 | J01 / 无 | state-owner | JA20, JA47 |
| J12 / JP-12 | 目标 schema 恢复与操作员处置 | J11 / 无 | state-owner | JA21, JA51, JA52 |
| J13 / JP-13 | 主控事件模型与累计预算 | J12 / 无 | controller-owner | JA22, JA23 |
| J14 / JP-14 | Loop/Graph 准入与单次启动 | J13, J02, J23 / J04 | executor-owner | JA24 |
| J15 / JP-15 | 统一入口、范围纠正与路由 | J14, J06 / 无 | controller-owner | JA25, JA63, JA67 |
| J16 / JP-16 | 跨方法与监督的联合旅程 | J15, J10, J07 / 无 | integration-owner | JA26, JA27 |
| J17 / JP-17 | 容量、写集合与集成候选 | J14, J12 / J15 | controller-owner | JA28 |
| J18 / JP-18 | 竞争与覆盖模式的多候选扩展 | J17, J10, J16 / 无 | executor-owner | JA29 |
| J19 / JP-19 | 上下文恢复与受控经验 | J04, J15 / J10 | context-owner | JA30, JA69 |
| J20 / JP-20 | 事件监督、低打扰与增量简报 | J15 / 无 | controller-owner | JA31, JA54, JA55, JA64 |
| J21 / JP-21 | 远端子主管与父子回执 | J17, J20 / 无 | executor-owner | JA32, JA65 |
| J22 / JP-22 | 外部事件与授权公开承诺 | J30, J20 / 无 | controller-owner | JA33, JA48 |
| J23 / JP-23 | 宿主与执行器资格测量 | J01, J03 / 无 | qualification-owner | JA34 |
| J24 / JP-24 | 有效版本、升级与恢复演练 | J12, J20 / 无 | state-owner | JA35 |
| J25 / JP-25 | 早期方法价值实验 | J03 / 无 | evaluation-owner | JA36, JA58, JA62 |
| J26 / JP-26 | 来源能力与当前交付投影 | J01, J02 / 无 | source-owner | JA37, JA60 |
| J27 / JP-27 | 灰度与支持范围内启用 | J16, J23, J24, J26, J31 / 无 | release-owner | JA38, JA66 |
| J28 / JP-28 | 高后果状态不变量形式化试点 | J11 / 无 | verification-owner | JA39 |
| J29 / JP-29 | 性能与有预算的改进循环 | J25 / 无 | evaluation-owner | JA40 |
| J30 / JP-30 | Forge 观察与栈前沿验证 | J07, J16 / 无 | verification-owner | JA41, JA57 |
| J31 / JP-31 | 清理前保全与应用回执修复 | J12, J07 / 无 | state-owner | JA42, JA56 |
| J32 / JP-32 | 联合四组对照与冷用户验收 | J16, J25 / 无 | evaluation-owner | JA43 |

J27 scoped只表示local opt-in；default-enable另要求J32。126个阶段节点包含原full gate wrapper和逐迁移门槛，不能把32个工作包直接视作32个一次性PR。

## 组件依赖层

[组件/主机分层](gate-layers.md) 为 J02/J03/J04/J11 显式选择 J01.contracts；表中工作包 J01 依赖保留。J01.scoped 仍要求原 JA01/JA02 真实主机行为，J08完整trial新增该前置；两个新gate不代表已执行。J01新增JA70组件负例，J08拆出无副作用的真实host admission边界。
