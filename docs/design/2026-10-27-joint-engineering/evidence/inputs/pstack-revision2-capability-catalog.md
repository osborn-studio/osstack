# pstack 完整能力目录

本目录覆盖固定版本的 58 个顶层技能（34 个操作技能 + 24 个原则）与 23 个 playbook。逐项映射不等于对每个文件完成同等深度审计：重点流程及工具边界精读，其他项目按职责与内容结构审阅。24 个 PS 编号表示本报告的能力分组，**不是上游 ID，也不是 OSStack 已发布命令**。

源码来源固定到 `99b609a72323b70204eab407c622f436e858e112`；可变的作者文章另见 [阅读记录](author-reading.md)。完整机器清单见 [capability-map.json](capability-map.json)，优先级与实施包见 [集成规格](integration-spec.md)。

## 1. 24 组能力抽取决策

| ID | 能力 | 优先级 | 策略 | 相对成本 | 现有主要落点 |
|---|---|---|---|---|---|
| PS01 | 单入口任务路由与渐进方法组合 | P0 | adapt | medium | `packages/skill-registry/src/index.ts` |
| PS02 | 代码机制与历史动机取证 | P0 | adapt | small | `packages/governance/src/probe/evaluation-compiler.ts` |
| PS03 | 意图校准与可纠正的问题模型 | P0 | adapt | small | `packages/governance/src/probe/evaluation-compiler.ts` |
| PS04 | 从使用草图到原型证据的架构循环 | P0 | adapt | medium | `packages/graph/src/program-resolver.ts` |
| PS05 | 覆盖式并行与预先声明的竞赛 | P1 | adapt | large | `packages/graph/src/join.ts` |
| PS06 | 独立评审与意见裁决 | P0 | adapt | medium | `packages/loop/src/reviewer-isolation.ts` |
| PS07 | 影响面与关键前提验证 | P0 | adapt | medium | `packages/governance/src/probe/evaluation-compiler.ts` |
| PS08 | 可操控的验证基础设施与功能地图 | P0 | adapt | medium | `packages/cli/src/graph-check-suite.ts` |
| PS09 | 验证基础设施的健康、归属与漂移维护 | P0 | adapt | medium | `packages/skill-registry/src/watcher.ts` |
| PS10 | 形式化验证生命周期 | P2 | adapt | large | `packages/loop/src/evaluation-spec.ts` |
| PS11 | 状态图与反例解释 | P2 | selective-port | medium | `packages/graph/src/nodes/branch.ts` |
| PS12 | 反思转结构化约束 | P1 | adapt | medium | `packages/loop/src/lesson-draft.ts` |
| PS13 | 决策轨迹与证据归因 | P0 | adapt | small | `packages/core/src/state/graph-runs.ts` |
| PS14 | 性能结论审查 | P1 | adapt | small | `packages/loop/src/evaluation-spec.ts` |
| PS15 | 有预算的 hillclimb 与盲评 | P2 | adapt | large | `packages/supervisor/src/evaluator-epoch.ts` |
| PS16 | 自包含单元与协调者边界 | P1 | adapt | medium | `packages/core/src/state/graph-runs.ts` |
| PS17 | 栈前沿与候选绑定验证 | P1 | adapt | medium | `packages/github/src/stack.ts` |
| PS18 | forge 观察器分类 | P1 | selective-port | medium | `packages/github/src/attention-ci.ts` |
| PS19 | 暂停与恢复对账 | P1 | adapt | medium | `packages/cli/src/engineering-host.ts` |
| PS20 | 跨宿主方法适配 | P0 | adapt | medium | `packages/core/src/capability.ts` |
| PS21 | 来源快照与能力资格验证 | P0 | new-glue | medium | `packages/skill-registry/src/manifest.ts` |
| PS22 | 事件 intake 与补偿模式 | P2 | adapt | large | `packages/core/src/state/attention-actions.ts` |
| PS23 | 使用方式驱动的接口与文档设计 | P0 | adapt | medium | `packages/cli/src/execution-context.ts` |
| PS24 | 历史上下文恢复与可理解的决策说明 | P0 | adapt | small | `packages/supervisor/src/attention-planning.ts` |

策略说明：`adapt` 迁移工作方法并适配主机；`selective-port` 选择性复用纯逻辑，重新校验语义；`new-glue` 是为 OSStack 新增的连接能力；`reference-only` 仅作为规则素材。成本为相对判断，不是工期估算。

## 2. 操作技能（34）

| 上游技能 | 分组 | 提取价值 | 集成边界 |
|---|---|---|---|
| [architect](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/architect/SKILL.md) | PS04 | 类型、签名、模块与调用示例先行，比较结构不同的方案。 | 优先复用现有架构约束，避免把备选数量变成形式要求。 |
| [arena](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/arena/SKILL.md) | PS04 | 同题独立产出，选基底并吸收局部优势。 | 合成后的产物必须重新验证。 |
| [automate-me](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/automate-me/SKILL.md) | PS24 | 把个人工作偏好转为可维护技能。 | 偏好包独立于授权和验收。 |
| [benchmark-checklist](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/benchmark-checklist/SKILL.md) | PS14 | 审查测量的瓶颈、公平性、噪声与真实性。 | 保留样本，避免不等价的速度比。 |
| [blast-radius](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/blast-radius/SKILL.md) | PS07 | 越过 diff 寻找影响面和关键安全前提。 | 把结论关联到实际检查。 |
| [bro](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/bro/SKILL.md) | PS24 | 把上一段话重述为直接易懂的表达。 | 作为交互辅助，不新增运行时。 |
| [correct](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/correct/SKILL.md) | PS12 | 将重复错误变成可强制的结构约束。 | 先证明能抓住历史坏例。 |
| [create-formal-verification-skill](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/create-formal-verification-skill/SKILL.md) | PS10 | 选择高风险不变量，生成与代码对应的模型检查流程。 | 要求 mutation 敏感性和边界说明。 |
| [create-verification-skill](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/create-verification-skill/SKILL.md) | PS08 | 生成可启动、驱动、观察并清理的真实表面验证。 | 实际运行后才从 draft 晋升。 |
| [figure-it-out](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/figure-it-out/SKILL.md) | PS01 | 无既有流程可用时，先定义可审计工作流。 | 动态流程先形成 proposal，不绕过闭合程序注册。 |
| [how](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/how/SKILL.md) | PS02 | 解释子系统结构、执行路径与归属。 | 用实际源码支撑关键机制。 |
| [in-your-own-words](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/in-your-own-words/SKILL.md) | PS03 | 用自己的话核对目标和待解决问题。 | 不能以重述替换用户真实要求。 |
| [interrogate](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/interrogate/SKILL.md) | PS06 | 独立质疑并分类处理评审发现。 | 不能多数投票自动关闭安全发现。 |
| [ketchup](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/ketchup/SKILL.md) | PS24 | 给出进展与需要用户决定的事项。 | 从权威状态派生，不靠记忆拼接。 |
| [ketchup-video](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/ketchup-video/SKILL.md) | PS24 | 用短视频辅助解释近期变化。 | 可选展示层，核心交付不依赖视频。 |
| [maintain-formal-verification-skill](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/maintain-formal-verification-skill/SKILL.md) | PS10 | 代码变化后维护模型与属性。 | 禁止削弱不变量来恢复绿色。 |
| [maintain-verification-skill](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/maintain-verification-skill/SKILL.md) | PS09 | 源码与真实运行双向核对验证流程。 | 区分文档漂移、harness 缺口、产品缺陷。 |
| [make-bot-ui](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/make-bot-ui/SKILL.md) | PS24 | 本地 UI 经服务端触发宿主 webhook。 | 只借鉴服务端保密和结构化事件；不复制 Cursor URL、绑定与安装步骤。 |
| [no-comments](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/no-comments/SKILL.md) | PS23 | 审查注释，优先将约束表达在代码结构中。 | 不机械删除有价值的理由或协议说明。 |
| [poteto-help](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/poteto-help/SKILL.md) | PS21 | 帮助用户发现并选择工作方法。 | 帮助文档必须区分已支持与仅建议。 |
| [poteto-mode](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/poteto-mode/SKILL.md) | PS01 | 顶层风格、流程选择、技能组合入口。 | 分解方法与个人风格；禁止整包自动生效。 |
| [recall](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/recall/SKILL.md) | PS24 | 从任务历史与实时状态恢复上下文。 | 不得横跨无关私人会话扫描。 |
| [reflect](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/reflect/SKILL.md) | PS12 | 从本次工作提炼可改进的规则。 | 进入 lesson draft，非直接自修改。 |
| [setup-pstack](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/setup-pstack/SKILL.md) | PS20 | 配置角色模型与推理预算。 | 映射可用 adapter；模型 slug 不写死。 |
| [sharpen](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/sharpen/SKILL.md) | PS03 | 提高方法深度并重写任务描述。 | 保留产品取舍，不扩展范围。 |
| [show-me-your-work](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/show-me-your-work/SKILL.md) | PS13 | 记录决策、原因、证据、结果。 | 只读导出、追加纠错、证据可解析。 |
| [statechart](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/statechart/SKILL.md) | PS11 | 从模型和反例生成状态图或反向建模骨架。 | 可视化与验证结果分别标注。 |
| [swarm](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/swarm/SKILL.md) | PS05 | 覆盖、竞赛或混合派发并聚合结果。 | 缺口显式；新拓扑单独验证。 |
| [tdd](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/tdd/SKILL.md) | PS08 | 在明确要求或廉价明显测试路径时先写失败用例。 | 吸收适度性，不为低影响可逆编辑堆实现镜像测试。 |
| [teach](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/teach/SKILL.md) | PS02 | 把机制与动机串成可理解解释。 | 保留事实/推论区分。 |
| [technical-writing](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/technical-writing/SKILL.md) | PS23 | 先以使用教程反推接口，再区分四种文档目的。 | P0 是调用体验与结构；文风规则按需本地化。 |
| [typescript-best-practices](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/typescript-best-practices/SKILL.md) | PS23 | 类型、边界和工程结构建议。 | 与本仓库严格 TS 配置整合。 |
| [unslop](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/unslop/SKILL.md) | PS23 | 删除冗余与模板化表达。 | 只作为风格优化，不是交付验证。 |
| [why](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/why/SKILL.md) | PS02 | 从历史和不同证据类别解释动机。 | 按任务范围查询；无证据要明确说未知。 |

## 3. 原则技能（24）

| 上游技能 | 分组 | 提取价值 | 集成边界 |
|---|---|---|---|
| [principle-attack-the-premise](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/principle-attack-the-premise/SKILL.md) | PS12 | 同一前提下反复失败后，直接检验该前提。 | 接入停滞检测，避免无界换补丁。 |
| [principle-boundary-discipline](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/principle-boundary-discipline/SKILL.md) | PS23 | 外部入口校验，内部领域逻辑保持清楚。 | 与已有 schema/host authority 边界一致。 |
| [principle-build-the-lever](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/principle-build-the-lever/SKILL.md) | PS08 | 把重复操作或证明方法做成可复跑工具。 | 工具需复跑证据，而非只产出脚本。 |
| [principle-encode-lessons-in-structure](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/principle-encode-lessons-in-structure/SKILL.md) | PS12 | 重复教训固化为结构约束。 | 通过历史坏例与正常例双向验证。 |
| [principle-exhaust-the-design-space](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/principle-exhaust-the-design-space/SKILL.md) | PS04 | 新颖且重要的设计比较少量结构不同的候选。 | 风险低或形态已定时不重复竞赛。 |
| [principle-experience-first](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/principle-experience-first/SKILL.md) | PS03 | 以用户体验而非实现便利定义质量。 | 转化为可观察场景。 |
| [principle-explain-the-number](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/principle-explain-the-number/SKILL.md) | PS14 | 解释数字的瓶颈与测量对象。 | 数字必须附样本和环境。 |
| [principle-fix-root-causes](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/principle-fix-root-causes/SKILL.md) | PS12 | 追到第一处错误而非不断加 guard。 | 合法异常状态仍需要明确处理。 |
| [principle-foundational-thinking](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/principle-foundational-thinking/SKILL.md) | PS04 | 先明确数据结构和共享状态。 | 结合现有模型而非重造领域。 |
| [principle-guard-the-context-window](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/principle-guard-the-context-window/SKILL.md) | PS20 | 控制主上下文载荷，按需取证。 | 是否委派由宿主能力和授权决定。 |
| [principle-laziness-protocol](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/principle-laziness-protocol/SKILL.md) | PS23 | 删冗余、减少抽象和改动。 | 不能借精简跳过必须的边界检查。 |
| [principle-make-operations-idempotent](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/principle-make-operations-idempotent/SKILL.md) | PS19 | 重试和恢复后收敛到同一结果。 | 复用 effect key 和持久状态。 |
| [principle-migrate-callers-then-delete-legacy-apis](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/principle-migrate-callers-then-delete-legacy-apis/SKILL.md) | PS23 | 同一轮迁移内部调用方并清理遗留接口。 | 不能删除已冻结程序身份或破坏恢复兼容性。 |
| [principle-minimize-reader-load](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/principle-minimize-reader-load/SKILL.md) | PS23 | 减少隐藏状态和不必要间接层。 | 不把边界隔离当无用包装。 |
| [principle-model-the-domain](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/principle-model-the-domain/SKILL.md) | PS23 | 用领域状态表达规则。 | 让非法组合在 schema/类型中失败。 |
| [principle-never-block-on-the-human](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/principle-never-block-on-the-human/SKILL.md) | PS03 | 已授权的可逆工作自主推进。 | 不能从不询问推导出发布/合并权限。 |
| [principle-outcome-oriented-execution](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/principle-outcome-oriented-execution/SKILL.md) | PS01 | 迁移围绕最终目标组织可验证阶段。 | 避免与版本恢复和线上兼容性冲突。 |
| [principle-prove-it-works](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/principle-prove-it-works/SKILL.md) | PS08 | 检查真实产物与真实行为。 | 自述和编译成功不能替代验收。 |
| [principle-redesign-from-first-principles](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/principle-redesign-from-first-principles/SKILL.md) | PS04 | 新需求到来时重审原设计假设。 | 以证据触发，避免习惯性重写。 |
| [principle-separate-before-serializing-shared-state](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/principle-separate-before-serializing-shared-state/SKILL.md) | PS16 | 先消除共享写入，再考虑串行化。 | 剩余共享状态仍需主机锁/事务。 |
| [principle-sequence-verifiable-units](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/principle-sequence-verifiable-units/SKILL.md) | PS16 | 每个单元结束时有可验证状态。 | 不能把局部通过叠加为未经验证的整体通过。 |
| [principle-subtract-before-you-add](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/principle-subtract-before-you-add/SKILL.md) | PS23 | 先清除死代码再加入新能力。 | 独立可审查，不混入无关大清理。 |
| [principle-test-behavior-not-implementation](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/principle-test-behavior-not-implementation/SKILL.md) | PS08 | 测试用户可观察行为。 | 保留边界/状态机测试的必要性。 |
| [principle-type-system-discipline](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/principle-type-system-discipline/SKILL.md) | PS23 | 语义类型、判别联合、权威 schema。 | 保持本项目命名与兼容规范。 |

## 4. 任务 playbook（23）

| playbook | 分组 | 核心方法 | 集成处理 |
|---|---|---|---|
| [authoring-a-skill](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/poteto-mode/playbooks/authoring-a-skill.md) | PS21 | 选择明确触发点、输入输出和验证方式。 | 生成后实际运行并保留来源。 |
| [autonomous-run](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/poteto-mode/playbooks/autonomous-run.md) | PS19 | 无人持续交互时维持目标、证据与运行纪律。 | 受预算/权限控制，不派生无期限授权。 |
| [autopilot-full](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/poteto-mode/playbooks/autopilot-full.md) | PS16 | 独立 PR 由各自 owner 推进。 | owner 完成不是合并权限。 |
| [autopilot-stack](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/poteto-mode/playbooks/autopilot-stack.md) | PS17 | 依赖栈共享一个拓扑写者。 | 防止 worker 各自 restack 冲突。 |
| [babysit](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/poteto-mode/playbooks/babysit.md) | PS18 | 按模式观察冲突、review、CI。 | 观察、修复与发布权限分开。 |
| [bug-fix](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/poteto-mode/playbooks/bug-fix.md) | PS01 | 先复现并定位根因，再改动并按原表面复验。 | 廉价明显路径可先写回归测试。 |
| [eval](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/poteto-mode/playbooks/eval.md) | PS15 | 建立盲化、独立 judge 和实际执行证据。 | 不以模型自评替代真实结果。 |
| [feature](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/poteto-mode/playbooks/feature.md) | PS01 | 对齐目标与验证表面，识别吞吐阻塞和可拆共享状态。 | 先形成验收，再实现。 |
| [hillclimb](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/poteto-mode/playbooks/hillclimb.md) | PS15 | 固定评测、单变量试验、接受或回退。 | 有限预算与版本化门槛。 |
| [investigation](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/poteto-mode/playbooks/investigation.md) | PS02 | 围绕假设收集和反驳证据。 | 调查不自动升级为代码写入。 |
| [multi-phase-plan](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/poteto-mode/playbooks/multi-phase-plan.md) | PS01 | 明确阶段、依赖、验证和回报方式。 | 替换固定十 lane 与英文格式 gate。 |
| [opening-a-pr](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/poteto-mode/playbooks/opening-a-pr.md) | PS17 | 准备可审查的变更、验证说明与 PR。 | 发布走既有授权路径，不由 recipe 直接执行。 |
| [orchestrate](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/poteto-mode/playbooks/orchestrate.md) | PS16 | 长期单元调度、brief、inbox、frontier、ledger。 | 抽取方法；不移植第二个控制平面。 |
| [pause-safely](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/poteto-mode/playbooks/pause-safely.md) | PS19 | 停止新增动作、保存状态、留下可恢复说明。 | 未证明 quiescence 的执行仍为 unknown。 |
| [perf-issue](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/poteto-mode/playbooks/perf-issue.md) | PS14 | 定位性能机制并验证等价负载下改善。 | 不能为数字省略实际工作。 |
| [prototype](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/poteto-mode/playbooks/prototype.md) | PS04 | 在接口收敛前，用最小实验解决改变实现的未知项。 | 原型只产出选择证据，不冒充正式交付验收。 |
| [refactoring](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/poteto-mode/playbooks/refactoring.md) | PS07 | 明确行为保持目标并逐步迁移。 | 检查调用方、格式与生命周期。 |
| [runtime-forensics](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/poteto-mode/playbooks/runtime-forensics.md) | PS02 | 依据运行时症状与证据定位问题。 | 收集范围和隐私由任务边界决定。 |
| [session-pickup](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/poteto-mode/playbooks/session-pickup.md) | PS19 | 读记录并核对当前真实状态后继续。 | 旧记录不能覆盖当前 head/receipt。 |
| [shipping](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/poteto-mode/playbooks/shipping.md) | PS17 | 独立验证、连续前缀、底部逐项交付并 readback。 | 不直接照搬 patch-id 复用规则。 |
| [trace-forensics](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/poteto-mode/playbooks/trace-forensics.md) | PS02 | 用 trace 分析调用路径与时间因果。 | 缺 trace 就标缺证，不猜因果。 |
| [visual-parity](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/poteto-mode/playbooks/visual-parity.md) | PS08 | 在实际表面比较视觉与行为一致性。 | 图像证据不能覆盖不可见副作用。 |
| [worktree-cleanup](https://github.com/cursor/plugins/blob/99b609a72323b70204eab407c622f436e858e112/pstack/skills/poteto-mode/playbooks/worktree-cleanup.md) | PS19 | 核实所有权和状态再清理工作区。 | 遵守本地隐藏 worktree 根与 scratch 纪律。 |

## 5. 工具、agent 与 dormant automation

| 组成 | 实际职责 | 抽取决定 |
|---|---|---|
| orch | 本地文件工作资料库、frontier、ledger、inbox 与状态视图 | 借鉴数据视图与 brief；不作为第二权威状态 |
| watch-pr | forge 读取、PR/栈状态分类、观察循环 | 选择性移植纯分类；改变 ready 语义并保留 unknown |
| check-plan | 固定计划模板校验 | 改为结构化计划语义检查 |
| statechart 工具 | TLA/TLC 结果处理、轨迹/图与渲染 | 可分离包或按需工具；先做独立资格测试 |
| show-me-your-work/log.sh | TSV 决策日志辅助写入 | 只读导出可借鉴公式字符转义，权威记录留主机 |
| worktree-audit.sh | 工作区审计辅助 | 不替换本项目 placement/scratch 规则 |
| poteto-agent | 使用方法与原则的执行角色定义 | 转为可选 role profile，不自带额外权限 |
| comment-sicko | 对注释及其声称约束的审查 | 作为定向 review 维度，非独立常驻服务 |
| harness generator | 生成宿主适配的技能树 | 吸收单源内容、显式差异、生成一致性测试 |

Benny 的三个技能分别是 `setup-benny`、`triage-issue-reports`、`reproduce-and-fix-issues`。它们不属于顶层技能目录。最值得提取的是固定事件坐标、去重、信任标记、协调者专属发信、worker 无消息凭据、真实复现证据，以及外部部分成功后的补偿。不要把 dormant 模板视为已经部署的可靠事件服务；第一期不接 Slack、不创建自动发信或合并通道。

## 6. 不直接搬运的内容

- 固定模型名、推理档位、云 VM 假设与 Cursor store/Task/routine 命令。改为 adapter 能力发现与显式兼容性。
- 每个 PR 十条 live lane、普遍视频材料与英文标点格式 gate。改为风险和表面驱动的验收。
- plain TSV 中的 verifier 身份和 verdict 优先级。改为现有 host receipt 与候选身份绑定。
- patch-id 直接继承通过结果。候选、基线、环境、规则任一改变，默认重新验证。
- 自动发消息、创建外部事项或发布的泛化自主权。仍遵循用户实际授权和主机策略。
- 永久累积完整风格提示词。按任务选必要叶子内容，记录所选版本。

上述拒绝并不否定上游在其原宿主中的实用性；它们针对 OSStack 的控制面与恢复语义。

## 7. 作者文章后的优先级修订（修订 2）

原文阅读记录与设计差异见 [author-reading.md](author-reading.md)。PS 编号保持稳定，P0 表示第一轮价值路径，不表示每组所有可选功能都同时实施。

| 组 | 本轮具体前移 | 仍后置的部分 |
|---|---|---|
| PS08 / PS09 | 稳定验证接口、功能地图、健康与维护归属 | 大规模全表面覆盖、未经配置的自动定时 |
| PS02 / PS03 / PS24 | 意图校准、机制/历史证据、可纠正解释 | 视频与个人风格、无关历史扫描 |
| PS04 / PS23 | 使用教程、调用草图、最小原型与接口选择 | 动态跨模型 fan-out 和附加文风规则 |
| PS01 / PS20 | 一个目标入口、按需加载与透明路由 | 58 个独立产品命令、所有方法全量注入 |

产品依赖以修订后的 capability-map.json 为准。顺序实验可以先在既有主机限制下验证方案；它不授予运行权限，也不改变 frozen Graph。
