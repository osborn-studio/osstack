# 实施、交付与启用计划

本计划是后续开发规格。下表的“完成”均指未来验收条件，不表示已经执行。注册表和计划可读取，不意味着运行时自动调度已经上线。

2026-10-26 增补：[当前升级路线图](../2026-10-26-firstmate-upgrade/README.md)与[增量工作包](../2026-10-26-firstmate-upgrade/work-packages.json)继承本表的工作、依赖与验收。新增 X01–X08、M01–M02、DEBT01–DEBT03；其中 X 系列覆盖统一对话、项目模式、容量、子主管、支持矩阵、展示、多渠道和工具链。当前状态只对明示 scope 生效，本表仍是历史设计基线。

## 1. 实施顺序

顺序为：最小 Mission 与既有 Session 采纳试点 → 持久主控与新目标派发 → 有范围的自动路由 → 24 项默认行为接线 → 真实环境资格 → 默认启用。注册表开发并行进行，不阻塞首个决策试点。

最先交付的产品变化应是一条用户看得见的完整流程：一个入口接单，遇到问题在这个入口提问，用户回答后在这个入口看到继续和验收。不要先把 24 项各做成一个新命令。

## 2. 工作包与文件落点

路径均相对于 OSStack 根目录。新增路径是建议落点。实施前检查最新 main，若已经有同一职责则合并复用。

| ID | 工作及文件落点 | 依赖 | 验收 |
|---|---|---|---|
| R01 | 将本设计注册表升级为运行时协议；`packages/protocol/src/behavior-capability.ts` | 无 | 严格 schema；稳定 ID；独立版本；无任意命令字段 |
| R02 | 受信 registry loader；`packages/core/src/behavior-registry.ts` | R01 | SHA、依赖、资格证据、版本校验；非法或未认证条目禁用 |
| R03 | 原始材料快照与差异索引；`scripts/capabilities/source-manifest.mjs` | R01 | 固定 commit、许可、路径、hash；移动分支不能改变重放输入 |
| R04 | 行为场景与来源映射；`packages/protocol/fixtures/behavior/*` | R03 | 每个原始行为有证据和语义差异说明；未映射项阻断完成 |
| R05 | registry 一致性与资格检查 CI；`scripts/capabilities/validate.mjs` | R02、R04 | 孤立条目、循环依赖、失效证据、虚假完成状态均失败 |
| D01 | typed DecisionAuthorityRef / WaitObligation；`packages/protocol/src/engineering-decision.ts` | C01 | session/approval/clarify/contract 明确区分；无通用文本审批 |
| D02 | additive migration、唯一约束与 store；`packages/core/src/state/engineering-waits.ts` | D01、C02 | 重复观察不新建问题；旧源不清除；schema 升级可恢复 |
| D03 | 提取可组合回答事务；`packages/core/src/state/attention-actions.ts` | D02 | 原有 stale/hash/grant/unknown 保护不退化；单事务绑定 Mission |
| D04 | daemon 内 Session resolver、dispatch phase、停止与 FULL 写连接；`packages/cli/src/engineering-decision-host.ts` | D03 | ADR-03–08 生效；不创建第二发送账本；取消先提交则无新 dispatch；已承诺或未知发送重启不重发；未派发的 qualified reserved 按 ADR-11 恢复首次执行 |
| D05 | 对话问题和回答绑定；`packages/cli/src/engineering-command.ts` | D04、C02 | 多问题“继续”不猜测；已有授权内动作不重复索要批准 |
| D06 | 现有 daemon 内的 obligation reducer；`packages/supervisor/src/engineering/decision-resume.ts` | D04 | 采纳模式只观察原 Session 的回复回合；按 ADR-06/07/12–14 清除、处置与完成，不派发新 Worker |
| D07 | 等待场景、属性与竞态测试；上述模块 `*.test.ts` | D02–D06 | pilot-scenarios 中 adopt_session 场景全覆盖；真实 API 通过；失败样本可重放 |
| D08 | 实际本地 Session 采纳试点；`scripts/smoke-engineering-decision.mjs` | D07、V00 | 单入口回答并观察真实回复回合；重启不重复执行；不加载 registry 或新 Loop adapter |
| C01 | 最小 Mission/Binding 协议；`packages/protocol/src/engineering-mission.ts` | 无 | adopt_session 与后续 goal_dispatch 分开；固定 task/run/session 和 scope；不引入第二审批权威 |
| C02 | 最小 Mission、事件和关联存储；`packages/core/src/state/engineering-missions.ts` | C01 | 先于 wait 表迁移；身份归属与投递权威分开；CAS、幂等、bounded log、可导出 |
| C03 | 主控纯状态机；`packages/supervisor/src/engineering/controller.ts` | C02、D03 | 事件输入可重放；模型结果作为记录输入；无内置副作用 |
| C04 | 复用 daemon owner 并扩展跨执行器 fencing；现有 owner 与新 host 接口 | C02、D04 | 不新增 per-mission lease；source 与 daemon 代数不同；旧控制者拒绝；静默证明另行验证 |
| C05 | 宿主服务生命周期；现有 daemon 安装与运行入口 | C03、C04 | 前台/后台能力明确；无二次 watcher；stop 和恢复可用 |
| C06 | 模型结构化 action provider；`packages/supervisor/src/engineering/planner.ts` | C03 | 严格输出校验；越权、过期、循环建议被拒绝 |
| C07 | 上下文和长期记忆边界；现有 attention lesson/context 服务 | C06 | 预算、来源、过期、跨项目隔离；无隐式策略升级 |
| E01 | ExecutorEnvelope + admission；`packages/protocol/src/engineering-executor.ts` | C01、R02 | 产物、模板、宿主、Provider、停止语义均可检查 |
| E02 | Loop adapter 服务化与 controller_once 派发授权；提取 `deliver-command.ts` 业务接口 | E01、C03、C04 | 旧 approved 行不自动执行；新授权精确绑定并单次消费；旧 CLI 回归通过 |
| E03 | 固定 Graph adapter；现有 graph host/registry | E01、C03 | 仅支持已认证范围；unsupported 明确拒绝；停止/恢复有回执 |
| E04 | Scout / bounded direct adapter | E01、C03 | 读与写权限分开；提升为实施必须重绑当前对象 |
| E05 | 路由、预算与评分；`packages/supervisor/src/engineering/router.ts` | E02–E04 | 先资格后评分；同一任务切换引擎不重置预算 |
| E06 | 并行写集合与候选集成；现有 worktree 与 graph/loop 集成服务 | E05 | 不冲突的任务可并行；集成后同候选重测 |
| I01 | 事件、回合终止、quiet/away、增量简报接线 | C05、D08 | FM-02/03/05/06/07/10/11 走默认路径 |
| I02 | Worker、source、remote 统一观察接线 | E05、I01 | FM-16/17/18 按实际宿主资格启用，断线保持 unknown |
| I03 | 完成证明、对外承诺、清理与发布接线 | E06、I01 | FM-13/14/19/22/23 绑定同候选与精确授权 |
| I04 | 主控版本与多 home 升级兼容 | C05、I03 | FM-24；旧任务可恢复，新旧版本不竞争写入 |
| V00 | 现有手工旅程基线与测量协议；仅使用授权脱敏样本 | 无 | 干预数、重复命令、恢复步骤、采样期与分母；无样本明确待测，不伪造收益 |
| V01 | 独立状态模型与攻击语料 | D01、C01 | 模型不复制实现；候选实现不可修改隐藏测试 |
| V02 | 变异与故障注入 CI | D07、C04、V01 | 删除关键保护会导致测试失败；崩溃点覆盖有报告 |
| V03 | 宿主/Provider/隔离实测 | D08、I01–I04 | 支持矩阵逐格产出证据；同 UID 无隔离不得认证为安全生产写模式 |
| V04 | 单入口用户旅程与对照实验 | V03 | 不要求用户管理 Agent；比较干预数、费用、完成率 |
| V05 | 中文/英文 README、帮助与 STE-inspired prompt | V04 | 同一行为事实；示例逐条验证；neat 检查；不虚构子命令 |
| V06 | 灰度、回退与默认启用 | R05、V02–V05 | 冻结证据包、回退演练、独立审查、版本发布说明 |

场景的 `delivery_stage` 和 `owner_work_item` 指定验收阶段。D07/D08 必须覆盖全部 adopt_session 场景。runtime_registry、integrated_controller、production_qualification 场景由后续相应工作包验收，仍保持 not_run，不能因为暂不属于试点就删除或标为通过。试点属于受限、显式开启的开发验证，不签发不可信 Worker 的生产隔离资格。

## 3. 并行开发的边界

契约冻结后可并行推进：来源与注册表（R 系列）、决策持久化（D02–D04）、对话体验（D05）、主控（C 系列）、独立验证（V01）。它们共用协议但不共享未提交文件。

后续可并行开发 Loop、Graph 和 Scout adapter。先通过同一个 contract suite，再接路由。不要让每个开发者自己定义“暂停”“应用”“完成”。

建议人员/Agent 分工：架构与契约负责人、决策与存储开发者、执行器开发者、用户入口开发者、独立验证者、发布负责人。数量受 CPU、IO、worktree 写冲突和审查能力约束。增加 Agent 数量不是验收目标。

每个工作包使用独立 `codex/` 分支。worktree 位于 `~/Developer/CodeX/.worktrees/osstack/<task>`。Scratch 位于 `$OSSTACK_SCRATCH_ROOT`。所有开发命令使用显式隔离的 `OSSTACK_HOME`。PR 创建后按仓库约定清理 worktree，不清理未交付的工作。

## 4. 用 OSStack 管理实施

用现有项目/任务账本承载上表 ID；导入前读取当前 CLI help，不虚构 import 参数。每项任务记录输入基线、工作范围、依赖、验收场景、PR、候选 SHA 和证据摘要。

任务层级：一个“工程主控融合”目标，六个里程碑（R/D/C/E/I/V），每个表项一张工作卡。任务卡是进度投影；授权继续来自原始合同与审批存储。移动卡片不能授予发布权。

执行工作流：`intake → specification → implementation → verification → independent_review → ready → delivered`。对应现有状态时保存原工作包 ID，不为匹配看板名称丢掉审批或未知状态。

blocked 必须有责任人和解除条件；unknown 必须有缺少的证据与精确查询动作；complete 必须引用可复查的候选证据。不得因为代码提交了就将整项能力标为 default_enabled。

## 5. 验证命令与执行环境

实施 PR 至少运行仓库要求的：

```sh
pnpm build
pnpm typecheck
pnpm test
```

还需运行协议 fixture/schema 校验、CLI 启动预算、修改模块的契约套件和新单入口旅程。现有 root lint 不代表存在可用的包 lint 脚本，不能只写“lint passed”。

对 DB、进程和 socket 的测试必须使用 scratch 下的隔离 home。不要从开发 checkout 打开默认 `~/.osstack`。生成目录与 `.tsbuildinfo` 不一致时先修复构建状态，不把陈旧 dist 的行为当作当前源码行为。

首批 PR 顺序：

1. C01、C02、D01、D02：先创建最小 Mission，再创建引用它的等待表。
2. D03、D04：既有 daemon 内的回答事务、dispatch phase、独立停止、FULL 持久性。
3. D05–D08：采纳现有 Session 的单入口真实试点；V00 同时提供基线。该依赖闭包不含 R/E 系列或完整主控。
4. R01–R05 可与以上并行；试点证据形成后再做资格签发，避免自举循环。
5. C03–C07、E01–E06：完整规划、从目标派发、受约束多执行器路由；历史批准不自动执行。
6. I 系列：其余能力默认接线。
7. V 系列：生产资格、文档、灰度与默认启用。

分支间合并以固定依赖 SHA 为输入。前置 PR 更新后，后续 PR 必须重新验证合并候选，不能复用旧分支的通过结论。

## 6. 发布与回退门槛

| 阶段 | 用户范围 | 允许动作 | 升级条件 |
|---|---|---|---|
| A 影子模式 | 开发环境 | 观察并建议，不启动执行器 | 注册表、路由与现有事实一致 |
| B 决策试点 | 单仓库、默认租户、已有合格 Session | 采纳既有会话，在原权限内回答与观察继续 | D08、负例和重启恢复通过 |
| C 本地工程交付 | 合格隔离宿主 | 受控修改、检查、本地产物 | 同候选检查、隔离、取消与清理测试通过 |
| D 授权 Git 交付 | 显式授权的仓库 | 具体 PR 操作 | GitHub sandbox 与权限撤销测试通过 |
| E 远端与升级 | 支持矩阵内的 home | 逐项授权的远端动作与升级 | 真实远端、服务管理器、断连恢复验证通过 |

回退触发：重复副作用、未授权动作、丢失未决事项、错误完成声明、状态不收敛、资源预算失控。先阻止新的自动执行。保留查询、停止、回答和对账。不要自动杀未知进程或删除数据库。

## 7. 目前不能宣称已经验证的事项

本设计没有实施新的 EngineeringMission 运行时，因此以下均待验证：真正单入口闭环、Loop/Graph 自动选择、真实 Claude/Codex 会话恢复、跨 UID 隔离、macOS/Linux 服务重启、远程断连、发布 sandbox、物理断电、长时间稳定性和独立用户体验。

这些不是默认免除项。它们分别阻断相应能力的资格升级。实现测试能执行的先执行；只有确实依赖宿主、凭据或外部账号的条目进入“等待环境”清单，并写明责任和操作步骤。
