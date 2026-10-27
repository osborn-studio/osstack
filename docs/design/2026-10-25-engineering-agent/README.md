# OSStack Engineering Agent：Firstmate 能力深度融合设计

状态：V2 设计提案与可校验注册表，已完成 Fable 5.1 四轮挑战与修订；最后定向复核无剩余 P0/P1，权限 P2 已按 ADR-15 定案。日期：2026-10-25。**这份交付没有启用新的生产主 Agent，也不表示 24 项能力已完成端到端融合。**

目标：用户向 OSStack 描述工程结果。OSStack 负责拆解、选择执行方式、调度工作者、处理等待、验证结果，并向用户交付。用户不需要管理工作者，也不需要先选择 Loop 或 Graph。

2026-10-26 增补：[完整能力升级路线图](../2026-10-26-firstmate-upgrade/README.md)保留本设计和全部 24 项能力，补充八项明确的功能工作包、管理缺口、技术债与当前范围。它将 50 个工作包映射到来源、默认旅程及验收；原 37 项冻结计划不改写成运行时完成记录。

## 阅读顺序

1. [V2 实施契约](runtime-contract-v2.md)与[架构设计](design.md)：当前差距、目标体验、系统边界、数据与授权、调度、融合标准。
2. [等待决策试点](waiting-decision-pilot.md)：状态机、接口、事务、异常、自动移植流程和验收场景。
3. [24 项能力注册表](capabilities.json) 与 [JSON Schema](capability-registry.schema.json)：可被工具读取的能力清单。记录来源、归属、现状、缺口和验收。
4. [实施计划](implementation-plan.md) 与 [37 项工作包](work-items.json)：分阶段工作、依赖、文件落点、发布与回退。37 项完整清单仍是分阶段计划；本次选定工作及审计整改由独立 OSStack home 的 17 张 kanban 卡管理。
5. [原始材料与独立验证](evidence-and-methods.md)：源码证据、研究方法、工具和不能由模型意见替代的验证。
6. [改写后的题目与任务说明](task-prompt.md)：可直接交给实施团队的任务。
7. [Fable 5.1 挑战审计报告](audit-report.md)：原始意见、逐项核验、设计修订及复审结论。
8. [采纳试点交付报告](../../reports/2026-10-25-session-adoption-pilot.md)与[Sonnet 5.5 实现审计](evidence/sonnet-5.5/disposition.md)：当前源码、命令、本地验证、实际任务账本和未通过的真实环境资格。
9. [设计阶段验证记录](validation.md)：保留设计交付时的执行结果；当前实现的验证见采纳试点交付报告。

另有 [运行时资格契约草案](qualification-contract.schema.json) 和 [允许的语义差异](semantic-divergences.json)。前者仅定义证据结构，后者约束后续差分验收；二者均不代表运行时已经通过认证。

注册表是**设计阶段的行为能力注册表**。它不是可执行插件目录，不包含任意 shell 命令。它不能直接生成权限。本次已实现现有等待 Session 的运行时接线、宿主认证和 migration 47；注册表驱动的自动接线、其他能力和真实环境资格仍属后续阶段。

使用 Python 3 和 `jsonschema >= 4` 校验设计。在仓库根目录执行：

```sh
python3 docs/design/2026-10-25-engineering-agent/validate-design.py --verify-sources
```

默认从当前 OSStack 仓库及相邻的 Firstmate 克隆读取固定 Git 对象。可用 `--osstack-repo` 和 `--firstmate-repo` 指定路径。该脚本只读 Git 对象，不调用 OSStack，不打开控制平面数据库。不具备两个克隆时，省略 `--verify-sources` 只检查结构和关联。

## 固定基线

| 对象 | 固定版本 | 用途 |
|---|---|---|
| OSStack | `14e7433b70f103499059c15fb9bf2ed87b0b0279` | 本次读取的远端 main |
| Firstmate | `af1c6817fc47589b162cbc361671c43cdb150933` | 已克隆的上游参考版本；不声称是上游最新版本 |
| 能力编号 | 历史账本第 1–24 项 → `FM-01`–`FM-24` | 保持来源可追溯；不重新编号掩盖缺口 |

原工作区有未提交修改。设计依据上述 Git 对象读取，不把工作区修改当作 main 已交付的能力。

## English overview

This proposal makes OSStack the user's single engineering agent. A durable controller owns each mission. Models propose plans. Policy checks and host services authorize effects. Loop and Graph remain execution strategies behind the same interface.

The implemented opt-in pilot adopts an existing waiting Session. It preserves each open question, binds the answer to the exact subject, retains unknown delivery states, and observes the resumed turn. Initial task dispatch and automatic Loop/Graph selection follow in a separate milestone. The answer-bearing resume is authorized before execution; dependent work remains blocked until the required result evidence is available. See the delivery report for local test evidence and the live qualification gaps.

The 24-entry registry describes behavior contracts and evidence. It is a design artifact, not an enabled runtime feature. See the validation report for checks performed in this delivery.
