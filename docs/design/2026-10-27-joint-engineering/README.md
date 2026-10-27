# Firstmate × pstack → OSStack 联合工程能力设计

日期：2026-10-27。设计基线：修订 3。当前已进入分批实施；运行时能力没有因设计或单元测试通过而启用。

**实施入口：本会话统一负责 Firstmate × pstack 能力吸收。当前进度、实际 PR 和证据见 [联合执行账本](execution-ledger.json) 与 [交接及推进规则](execution.md)。下文“事实边界”及机器规划表保留设计冻结时的历史事实，不代表当前实施状态。**

决策：统一共享契约，保留来源档案，分域并行，按依赖验证合并。Firstmate 提供持续负责、监督与恢复的行为来源；pstack 提供调查、设计、工具化验证与工程方法的来源。代码按 OSStack 职责组织，不能增加两个互相竞争的主控。

联合设计修订 3；新增 [审计规格](audit-specifications.md)、[阶段门槛](execution-gates.json)、[原验收继承](legacy-case-map.json) 与 [开放未知](unknowns.json)。

## 阅读与交付

| 文件 | 内容 |
|---|---|
| [architecture.md](architecture.md) | 四种推进策略、三种架构候选、职责、不变量和决策记录 |
| [contracts.md](contracts.md) | 身份、材料、检查、产物、资格、恢复和错误合同；使用样例 |
| [implementation-plan.md](implementation-plan.md) | 第一条价值路径、联合旅程、并行规则、PR 顺序和发布边界 |
| [verification-spec.md](verification-spec.md) | 可重放验收、故障/变异、四组对照、独立验证和停止规则 |
| [reconciliation.md](reconciliation.md) | 对两套旧设计及审计意见的逐项修订；未决问题与维护责任 |
| [capability-map.json](capability-map.json) | 24 个 FM + 24 个 PS 来源能力，统一职责、来源、任务和验收 |
| [capability-index.md](capability-index.md) / [work-package-index.md](work-package-index.md) | 能力和 PR 计划的可读表格 |
| [work-packages.json](work-packages.json) | 联合工作包、输入输出、依赖、写范围、回退、状态和未来 PR |
| [legacy-work-map.json](legacy-work-map.json) | Firstmate 50 项、pstack 19 项原任务逐项保留；映射不等于完成 |
| [acceptance-cases.json](acceptance-cases.json) | Given/When/Then、坏变体、观察对象、证据及测试层级 |
| [contract.schema.json](contract.schema.json) / [fixtures](fixtures) | 拟议运行时边界的严格 schema 与固定正负例；未被产品加载 |
| [baseline.json](baseline.json) / [sources.json](sources.json) | 固定版本、观察状态、来源 hash 和检查范围 |
| [claude-audit.md](claude-audit.md) / [closeout-specifications.md](closeout-specifications.md) | Claude审计原文索引、47条处置、复审修订与未来实施条件 |
| [execution-gates.json](execution-gates.json) / [legacy-case-map.json](legacy-case-map.json) | 124个阶段节点、114原场景、发布与逐迁移证据要求 |
| [digest-catalog.json](digest-catalog.json) / [artifact-catalog.json](artifact-catalog.json) | 摘要输入/域与方法材料分类 |
| [validation.md](validation.md) | 本轮真正执行的验证及明确未执行的产品验收 |

## 事实边界

- OSStack 远端 main：`daad404e00c000247fdfb2adda13127c4c1c8e26`，联合设计初稿时以 `git ls-remote` 观察；本次模型审计未重新 fetch 或刷新 PR 状态。
- Firstmate 路线图：`4199d9aadf776042d924a0a307c62aef1a729088`；GitHub #271 在观察时 open/draft；#270 已在 main。
- Firstmate 上游：`af1c6817fc47589b162cbc361671c43cdb150933`；pstack 上游：`99b609a72323b70204eab407c622f436e858e112`。没有把它们称为上游最新版本。
- 当前工作区 HEAD 为旧的 `0a61d278…` 且有大量其他修改。研究从固定 Git 对象读取，未切换、覆盖或清理该工作区。
- 主干相对 pstack 研究使用的 `c1cfccf…`，`packages/`、`scripts/`、根 package/lock 文件没有差异。该检查只支持这些路径的等价，不是所有环境资格的继承。
- Firstmate 已交付的是显式开启的 Session 采纳路径，完成上限是 `observed_turn`。完整 `goal_dispatch`、自动主控、全宿主资格仍待实施。
- Firstmate 路线图的 38 planned / 8 local_pilot_complete / 4 partial_blocked 是冻结规划记录，本轮没有读取或修改运行时看板。
- pstack 尚无本轮方法接入实现。旧的 48 个验收场景与本目录的新场景均不得因文档校验通过而标为产品通过。

## 最小交付方向

首先交付一个可驱动、可观察的 `session-answer-receipt` 隔离夹具，再在现有受控 Graph 本地交付路径上验证一个 bug-fix 方法。此路径不依赖完整 Firstmate 主控。随后由 Firstmate 主控把同一方法接入端到端目标派发；Session 回合与工程任务分别验收。

用户看到的是：输入目标，必要时回答明确问题，查看有证据的进展和交付。用户无需理解来源项目、资格表、receipt 或方法编译器。

## 文档优先级与历史保留

本目录是本轮联合设计的规范入口。它对重叠事项给出增量决策；Firstmate 原 ADR-01–16、#271 安全约束继续有效，只有 JADR11、JADR12、JADR15 明列的未来恢复增量可在独立验收后扩展。pstack 修订 2 的研究与来源仍有效；执行顺序、材料通道、完整任务映射、首次资格与联合职责按本目录收敛。具体取代关系见 reconciliation.md。

原始 Firstmate 文件、历史审计原文与 pstack 修订 2 输入快照均保留。来源能力表不是可执行插件目录；联合任务表不是运行时调度计划；schema 正例不是有效授权或生产资格。

## 复现文档检查

需要完整仓库 checkout（含 docs/reports/2026-10-26-pstack 的历史审计归档与冻结输入）、Python 3 和 `jsonschema >= 4`；不运行 OSStack CLI、不打开控制面 DB：

```sh
python3 docs/design/2026-10-27-joint-engineering/validate-design.py
python3 docs/design/2026-10-27-joint-engineering/validate-design.py --verify-sources \
  --firstmate-repo /path/to/firstmate --pstack-repo /path/to/cursor-plugins
python3 docs/design/2026-10-27-joint-engineering/test_validate_design.py
```

校验器检查映射、依赖、所有权、来源、正负例和“规划不能冒充交付”。本版已实际调用 Claude CLI Sonnet 5.5；审计原文、修订与复审状态见 [claude-audit.md](claude-audit.md)。同一模型的两种提示词不是跨模型独立共识。

修订 3：[复审精确规格](closeout-specifications.md) 明确恢复后态、Graph 消费事务、原 gate/case 消费边及 oracle 生命周期；与旧表述冲突时以此增量及同步机器文件为准。

完整审计与47条原始意见处理见 [Claude审计报告](claude-audit.md)；[复审精确规格](closeout-specifications.md) 是共享契约和PR执行时必须读取的规范增量。

当前实现：J02a [Draft PR #281](https://github.com/osborn-studio/osstack/pull/281)，固定 Git 来源检查与证据绑定。本地全仓库 6161 通过 / 5 跳过，Sonnet 5.5 静态审计 PASS。J02b 依赖闭包、方法采用及运行恢复仍待后续批次；详见 [执行记录](execution.md) 和 [交付账本](execution-ledger.json)。
