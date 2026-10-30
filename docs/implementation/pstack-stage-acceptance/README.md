# pstack 原范围对账与阶段验收建议

**结论：pstack 抽取与集成尚未全部结束。可以先验收已经可用的方法材料和有限工具；这不等于原规格的“首个能力已集成”，更不等于 24 组能力全部完成。建议先收口原 C0→C1→C2 的一个 bug-fix 真实闭环，再进入 Firstmate 深运行时。**

本次是应用户要求重新克隆、核对源码和追溯原设计/审计的工作，没有重跑旧宿主任务，也没有将 FAILED/LIMITED 改为通过。没有用户验收签字、范围删减决定或运行时放行。

## 固定来源与版本

- 原研究上游：[cursor/plugins](https://github.com/cursor/plugins/tree/99b609a72323b70204eab407c622f436e858e112/pstack)，commit `99b609a72323b70204eab407c622f436e858e112`，pstack tree `880564357e051d7c7802da1cb5d8df1d0b008299`。保留 Lauren Tan / poteto / MIT 来源。
- 本次新克隆：`4dd1d05818d19792e7cd6e818f1667f95f7e1dbe`，pstack tree `4719e1c4b4c43bac85d4206a8b41dd2899769c1c`；观察时间 2026-10-30 01:24:55 UTC。只读 Git 对象，没有安装或执行上游代码。
- OSStack 实际 main：`e4643324b9de1d2db51c744e59ccd7c05146b0a6`，PR307/308/309 已合并。另有有序 1–3 PR 前沿报告候选 `8e830561`，已工程验证，**此对账时尚未发布/合并**。
- 原研究 24 PS / 19 W / 48 A 与联合 32 J 分层保留。当前 4 入口、14 方法不是 14 项完整运行时能力；20 partial / 4 deferred 是原整组范围状态，不能作为可用工具数量或剩余工作量。

## 现在能单独验收什么

| 阶段交付建议 | 用户可以验收的具体结果 | 明确边界 |
| --- | --- | --- |
| S1 材料交付与读取 | 四入口与14方法的双宿主布局导出；引用完整；分页/文件摘要/EOF可核 | 导出不等于安装、原生发现、模型理解或强制消费 |
| S2 验证与维护工具 | 真实固定五案例0/1/2/1/0；持久地图漂移→修复→fresh复验；默认v1/full v2证据投影及check | 固定案例，不是任意项目地图自动生成、所有入口覆盖或自动修复；hash不认证运行真实性 |
| S3 候选观察 | 主线单PR稳定head/base观察；StatusContext/CheckRun分类；失败、等待、未知分开 | 不提供merge许可、持续watcher或旧卡自动刷新；有序栈候选发布另计 |
| S4 真实宿主效果 | 逐个查看已有实际任务的修复、失败和限制 | 部分修复闭环成立，不能称Codex/Claude全方法验收通过；本次不重跑旧任务翻绿 |

S1–S3是**待用户确认的有限阶段交付建议**；S4只归纳受限的宿主观察，尚不是可整体签收的阶段。它们不是重新定义过的 C0/C1/C2，也不注销尚未做完的 pstack 工作。阶段归档可写“已验收的工具及边界”，不能写“pstack 已全部集成”。

## 原检查点仍差什么

原 [integration-spec](../../reports/2026-10-26-pstack/integration-spec.md) 明确：只有 W08 的真实试点通过，才可称“首个能力已集成”。建议文件路径允许调整；本次按行为与证据判断，没有仅凭建议文件缺失判未实现。

| 检查点 | 当前结论 | 最小收口工作与责任 |
| --- | --- | --- |
| C0：先能可靠操作、观察、维护 | 部分具备，原组合条件未全满足 | pstack验证工具owner：用一个当前用户场景补W17调用草图/实际选择依据及A39冷读者成功与错误恢复、W18相关功能叶子检索、W19健康/归属/维护边界；复用已有driver，不重建一套工具 |
| C1：一个 bug-fix 的纯编译 | 合同/来源组件存在，完整recipe→proposal尚缺 | pstack集成owner：先收口W01→W02来源manifest默认subdir/拒绝规则、固定子树快照与变化只生成candidate（A01/A02/A04）；现有J02 inspector不替代这些接线。再完成注册定义、主检查映射、材料需求，生成无执行权proposal；未注册检查/缺材料拒绝。不得用硬编码smoke冒充 |
| C2：实际集成试点 | 未闭合，不能签发通过 | pstack集成owner与独立验证owner：沿W04/W05/W07/W08及必要J08前置，接到既有合同/宿主；缺必读材料invoke=0、候选一致、真实执行、独立产物判定、最终local_verified及清理；保留recipe关闭兼容路径，不扩大动作/路径/发布权限 |
| C3及更广能力 | 原后续范围仍保留 | 四类recipe、资格维护/撤销、恢复、经验晋升等另有实现和验证；不因为C2通过便自动完成 |

这是收口顺序建议，不是本轮已经派发或完成的新运行时实现。联合修订将首次受限试验映射到J08：SupportProfile/host admission、TrialPermit及createAndConsumeTrial的消费与预算/恢复边界，现有J09.scoped→J08.scoped，其直接前置J03.scoped/J07.scoped/J12.scoped/J08.recovery/J01.scoped；local路径限定J11规格、J12 bootstrap/scoped与本次J08 schema/recovery，以及FULL事务内单root许可消费。完整摘录见[依赖与历史计数说明](JOINT-DEPENDENCIES.md)。此处仅保留原映射，不新增另一套全量Firstmate门槛；完整主管/远端恢复不因本表被提前拉入C2。不能为了先验收而绕过原限定门槛。

## 哪些剩余属于 pstack，哪些可以后排

- **仍属于 pstack 原承诺：** 材料必需性与实际adapter接线、注册检查编译、候选产物核对、首个真实集成试点、分层地图检索及维护、后续来源依赖/资格/撤销，以及W10方法决策轨迹与恢复对账（旧pin保持、unknown不当完成、无停止证明不报cancelled、结束计划退出当前检索）。不能全部转名为 Firstmate。
- **pstack后续独立能力：** arena/swarm纯产物聚合、hillclimb/盲评、formal/statechart、经验草案、只读观察扩展，以及PS22/W16固定事件坐标、fake connector幂等/readback/补偿试点。后者是原pstack范围，不因Firstmate也有事件系统而自动转移。原有优先级与门槛保留；如要延期，是显式范围决定，不是删除欠账。
- **Firstmate深运行时：** 持久主管/远端子主管、broker租约、恢复与操作员处置、累计预算、灰度启用等；其中方法层W10对账及C2明确列出的local必要恢复仍属前述pstack集成依赖，不被这句话后移。先做pstack闭环必需的依赖，其余继续后排。
- 新上游把orch改成宿主项目/事件订阅、重写statechart，是**升级评估**，不能追加成旧验收门槛，也不能用它删掉旧集成义务。

## 源码和历史审计告诉了我们什么

[五类源码对照](SOURCE-COMPARISON.md)分别核了 orch、watch-pr、check-plan、statechart、来源/资格。原200到新573个tracked路径主要受statechart corpus影响，不能解释成能力数翻倍。watch-pr的12个成员、check-plan源码及测试逐字节不变；新上游删除orch三文件并改变宿主依赖。

[审计追溯](AUDIT-TRACE.md)覆盖作者12项修订、原Fable22条、联合Sonnet47条原编号，共81个索引，HV01单列。原“DONE_WITH_CONCERNS / PASS_WITH_CONCERNS”是对应输入的研究/设计审查结论；77文档测试、100合同正反例、24摘要向量没有证明真实数据库、Provider、并发或运行时验收。新增实际产品证据按各自候选绑定，不回填历史。

本项目偏向方法材料、验证工具和大量工程取证，确实没有按相同比例完成原集成链路。这不是只差签字。账本中PS08/09/13/17/18与J30的过时摘要已修正，旧快照和失败原件保留。

## 逐项清单与复核材料

- [24能力可用内容与剩余差距](CAPABILITIES.md) / [机器清单](capability-reconciliation.json)
- [原48验收场景与19工作包](ORIGINAL-ACCEPTANCE.md) / [机器清单](original-acceptance.json)
- [原审计逐号索引](audit-trace.json) / [源码逐文件绑定](source-comparison.json)
- [归档与审计说明](EVIDENCE.md)

W13 的 A27/A28 已有直接证据，可以按原只读分类器范围单独验收；W10计划依赖未闭合不阻止这两个组件场景的独立验收，但不能据此签发含W10连接的完整W13计划闭环。持续watcher从来不是该切片的前置。类似地，性能审查材料不必先提供通用 benchmark 服务或证明正向收益。

这些表述的“直接组件证据”只表示存在具体实现或验证记录，不等于原整项场景PASS。48项证据对账为4项有直接组件证据、31项部分、10项未实现、3项证据不足；这是对原断言的覆盖分类，不是新测试通过率。本轮未执行新的48项产品验收；用户验收仍待进行。下一步先按上述清单收口一个原始pstack集成闭环，再决定扩大能力或转入Firstmate。

本次实际Sonnet5.5先给出报告准确性PASS_WITH_CORRECTIONS，7项修订后限定闭环PASS。原文、完整输入与CLI模型元数据均保留；这只审查报告表述，不签产品/宿主/用户验收。之后仅补充W16分轴、文件全路径和历史未重跑措辞。
