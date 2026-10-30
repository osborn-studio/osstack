# 固定版本能力采用对账

本表把原24个PS能力组映射到 [PLAN.md](PLAN.md) 的U1/U2/U3与仍保留的原义务，**不是删除原义务、重新签收原24PS/19W/48A，或宣称61个skill已适配**。U1是固定方法材料首用；U2是一个真实任务经OSStack入口完成的bugfix链；U3是选定范围的formal/statechart工具使用。单项首用通过不等于全部能力完成，正式trial/qualified仍须其真实门槛。

依据：[当前queue](../../design/2026-10-27-joint-engineering/pstack-feature-queue.md)、[stage能力对账](../pstack-stage-acceptance/CAPABILITIES.md)、[原验收逐项对账](../pstack-stage-acceptance/ORIGINAL-ACCEPTANCE.md)、[原集成规格](../../reports/2026-10-26-pstack/integration-spec.md)。stage记录有自己的历史候选和时间，本表不改写它；本批W01/W19只按[本目录证据](README.md)与现有实现的有限范围补充。旧99b609a7研究能力映射不会自动成为.36语义审计结果。

## 24PS逐项路由

“首用前”指对应U1或U2的最小任务，不是整个PS完成标准；凡该任务实际触发的权限/范围/预算/未知处理仍必须遵守。U3与后续能力只有实际启用时才消费自己的验收。

| ID / 能力 | 采用位置 | 已有 | 还差 / 保留义务 | 首用前是否必须 |
| --- | --- | --- | --- | --- |
| PS01 单入口任务路由与渐进方法组合 | U1→U2 | 四入口、14共享方法、导出/分页已有 | 按.36重核首批引用；recipe→proposal→准入→调用尚未贯通 | U1须首批路由可读；U2须实际单入口，非全部方法全覆盖 |
| PS02 代码机制与历史动机取证 | U1；U2按任务 | investigation材料与机制/来源/未知区分 | 新任务Git/issue/doc多来源证据及空结果核验；how/why/teach全链仍缺 | 真实缺陷所需机制证据必须；完整历史取证工具不挡U1 |
| PS03 意图校准与可纠正的问题模型 | U1→U2 | task-framing目标/约束/未知与授权分流材料 | 更广实际使用证据；历史宿主LIMITED不升级为收益 | 首用任务目标/观察/假设及可纠正范围必须 |
| PS04 使用草图到原型证据的架构循环 | U1；arena后续 | architecture/feature/refactoring材料与行为pin | 多结构原型、交叉评分、择基融合后重验未闭环 | 与首个bugfix相关的使用边界必须；完整arena不必 |
| PS05 覆盖式并行与预声明竞赛 | U1按需；W12后续 | parallel-work支持指南与委派包装 | 覆盖/竞争产物合同、缺lane处理、派发/取消/恢复 | 单host首用不必并行；选择并行时必须声明覆盖/竞争 |
| PS06 独立评审与意见裁决 | U1→U2 | code-review材料；本项目真实审查原意见/处置 | 统一跨模型调度/资格未闭环，真实缺陷/误报轴仍需验证 | U2最终候选独立检查必须；双模型竞赛/正式身份资格不附加 |
| PS07 影响面与关键前提验证 | U1→U2 | change-impact与调用链/前提材料 | 首个真实改动的安全前提、坏例、同表面独立复验 | 任务相关影响检查必须；不要求通用自动分析器 |
| PS08 验证基础设施与功能地图 | U1工具；U2实际验证 | 默认2/full5旅程、证据投影；W18三场景有界reader | 任意项目doctor/drive/observe/cleanup与跨入口覆盖未闭合 | 首用真实项目入口与验收驱动必须；全库功能发现不必 |
| PS09 健康、归属与漂移维护 | U1有限工具；W19后续 | 固定五图维护；本批W19配置owner/health与故意工具故障修复记录 | 自然源码/地图漂移与广义故障归类仍缺；配置owner不是身份 | 首用说明维护/恢复边界必须；广域自动发现不必 |
| PS10 形式化验证生命周期 | U3；W16 formal轴 | 原始来源/设计及本批来源读取，未做工具执行 | 模型/源码对应、固定工具、坏变体、回放与维护 | U1/U2普通bugfix不必；U3必做选定不变量闭环 |
| PS11 状态图与反例解释 | U3 | statechart子树407source+1license读取成功 | TLC执行、图转换、反例代码回放、旧不变量保留未执行 | U3必需；普通Mermaid和来源检查不替代 |
| PS12 反思转结构化约束 | U1材料；W14后续 | skill-authoring材料、基于任务证据改技能指导 | 改进draft出处、历史坏例/合法控制、晋升与检索隔离 | 首用可人工记录问题；自动学习/晋升不必且不默认启用 |
| PS13 决策轨迹与证据归因 | U1记录；U2；W10后续 | 原始失败/cleanup/有限投影、短报告可定位原件 | 权威决策supersedes、历史检索和旧计划context退出未闭合 | 首用实际记录必须；全W10不是U1门槛，U2必须绑定真实候选 |
| PS14 性能结论审查 | U1按任务；W15后续 | 性能方法与明确synthetic数例 | 有真实收益主张才需真实同工作量样本/端到端证据 | 非性能任务不必；不以通用benchmark/正向收益挡方法首用 |
| PS15 有预算hillclimb与盲评 | W15后续 | 可复用测量/证据规范 | 固定harness/evaluator、单变量keep/revert、盲化、epoch与预算停止 | U1/U2不必；启用hillclimb前必须完成自己的试点 |
| PS16 自包含单元与协调者边界 | U1按需；U2角色边界 | 自包含brief、文件/资源/验收/依赖与unknown指导 | 持久调度/租约/恢复不由指南提供 | 首任务角色/允许写边界必须；自主swarm运行时不必 |
| PS17 栈前沿与候选绑定验证 | U1现成工具；发布链按需 | 单PR稳定快照、显式1–3PR有序frontier工具 | 自动拓扑发现/修复、原子多PR快照、持续watch未提供 | local_verified首用不必forge；真实发布时用对应候选检查 |
| PS18 forge观察器分类 | U1现成工具；W13保留 | 只读blocked/waiting/unknown分类；StatusContext/CheckRun修复 | 部分既有漂移/政策边界、旧卡刷新仍限；完整W13连接W10未闭 | U1无forge任务不必；W13/A27/A28不要求持续watcher |
| PS19 暂停与恢复对账 | U1指导；U2边界；W10后续 | continuity最小交接/当前授权owner核对 | 跨崩溃重启、旧pin续用、reconcile/停止证明与副作用重发安全 | 首用不明结果不可盲重试；不要求Firstmate深恢复，正式恢复仍欠 |
| PS20 跨宿主方法适配 | U1→U2 | Codex/Claude四入口导出与分页；历史有限修复分轴保留 | 新版首次host真实使用、mandatory上下文；全方法/跨host等价未证 | 先一个真实支持host必须；第二host及全等价不挡首用 |
| PS21 来源快照与能力资格 | U1来源；U2绑定；正式资格后续 | 旧pin/export摘要；.36完整lock；W01登记与负例验证 | 采用引用闭包、consumer接线/漂移激活、admission/provider资格未闭 | 首用固定pin/必要引用必须；不得伪trial，正式资格不并入普通U1 |
| PS22 事件intake与补偿 | W16 intake轴后续 | 仅候选来源，未启用Benny入口；现有证据不足不能断言全仓无通用组件 | 固定事件坐标、幂等去重、fake connector readback/部分成功补偿 | U1/U2/U3均不必；外部写入启用前另走实际授权 |
| PS23 使用驱动接口与文档 | U1→U2；U3独立教程 | caller-first、真实checkout教程、三叶地图reader | 原冻结地图/冷用户/全部API消费者未全验收；A39时序条件保留 | 首用目标checkout/入口/终点/恢复必须；旧C0不反复重跑装通过 |
| PS24 历史上下文与可理解说明 | U1指导；W10及可选后续 | continuity/简报、unknown/下一步与原件归因 | 全局检索/context注入未证；视频/Bot/个人风格仍deferred | 首用清晰报告必须；视频/Bot/个性化不必且不默认采用 |

## 没有被三个U目标注销的义务

- **W10 / PS13、PS19、PS24：**真实状态派生报告、追加supersedes而不删历史；重启/过期材料不可冒充完成；旧任务使用旧pin，不中途替换材料；reconcile与停止/清理unknown需保留；completed/superseded战术计划退出当前检索/context而历史仍可查；TSV公式前缀处理。A21/A22/A46原断言继续有效。U1可以先人工管理这些任务局部事实，不能因此宣称权威检索/恢复服务完成。
- **W12 / PS04、PS05、PS16：**arena择基/融合与swarm覆盖不同；缺lane不能完成，合成候选需要新身份与重新验证。先做artifact/纯聚合；若做运行fan-out，另补授权、容量、取消和恢复，不能改冻结程序偷接动态调度。完整arena不是单个bugfix前置。
- **W14/W15 / PS12、PS14、PS15：**结构教训须有来源/坏例/正常控制及受控晋升；hillclimb固定harness/evaluator与盲化标签，保留交错原样本、失败、keep/revert和预算停止。首次可用不要求预设正向收益；有性能收益主张必须给实测。既有deferred状态不因本表自动变成implemented。
- **W16双轴：**formal只需先选一个高后果不变量，源码映射、坏变体和代码回放；U3可以扩成独立可用能力包，但不把全量上游移植强加给原A31。intake是另一个小项目：固定事件坐标、幂等去重、fake connector、readback与部分成功补偿（A32）；不默认接Slack或通知，不因formal进展声称intake完成。
- **W13 / PS18：**A27/A28是一次性只读分类与缺页/超时unknown，原义务不要求持续watcher；与W10的计划连接仍另列，不能把组件通过当整个计划完成。
- **W08/W11及正式资格：**source pin、导出hash、配置owner、matches_configured都不是受信身份或激活许可。U1普通授权使用不伪造MethodBinding/TrialPermit；若进入正式trial路径，必须处理真实admission/调用预算等缺口，不能删除失败门槛。
- **既有可选/deferred边界：**ketchup-video、make-bot-ui、automate-me及个人说话风格/宿主专有hook仍是候选/可选，不默认安装、调用模型、连接服务或成为核心依赖。bro/no-comments等路径在下方仅作完整清单，不能按名字推断已审计内容或自动注入个人风格。保留既有视频/Bot/个人风格暂缓范围，不把“未首批采用”写成永久删除原能力。
- **C0/C1/C2及A39：**原冻结前使用证据、真实工具/地图和后续执行检查点保留；新接口要有自己的前置观察，不重标旧失败、旧pin成绩或后验教程。完整Firstmate/远端恢复、全部宿主等价、生产率基准与自动merge不追加为U1首用条件。

## 固定版本的完整SKILL路径清单

以下清单**仅从[source-lock.json](source-lock.json)中路径以 `/SKILL.md` 结尾的条目机械提取**，共61项（顶层skills下58项，automations/benny下3项）。固定commit为 `c742dd61706fbacc1b95f1a20b7b988cf096ce6c`，版本0.15.36；每项原字节摘要在source-lock及已核对的源tar中。

统一状态：**candidate / 内容采用与运行未验证**。仅表示文件存在且字节已固定，不表示全文语义阅读、引用闭包、可安装、宿主可执行或已完成OSStack改写。上表PS路由来自已有研究/对账，不是对这61项按关键词重新审计。阶段P2/P3须逐一记录实际采用文件、读取深度、引用闭包、许可、改写与执行证据；未采用项保留列表，不会因发布一个方法包而批量晋升。statechart来源探针成功也只改变“来源读取”轴，不改变此运行状态。

| # | 固定来源SKILL路径 | 当前采用状态 |
| --- | --- | --- |
| 1 | `pstack/automations/benny/skills/reproduce-and-fix-issues/SKILL.md` | candidate / 未验证 |
| 2 | `pstack/automations/benny/skills/setup-benny/SKILL.md` | candidate / 未验证 |
| 3 | `pstack/automations/benny/skills/triage-issue-reports/SKILL.md` | candidate / 未验证 |
| 4 | `pstack/skills/architect/SKILL.md` | candidate / 未验证 |
| 5 | `pstack/skills/arena/SKILL.md` | candidate / 未验证 |
| 6 | `pstack/skills/automate-me/SKILL.md` | candidate / 未验证 |
| 7 | `pstack/skills/benchmark-checklist/SKILL.md` | candidate / 未验证 |
| 8 | `pstack/skills/blast-radius/SKILL.md` | candidate / 未验证 |
| 9 | `pstack/skills/bro/SKILL.md` | candidate / 未验证 |
| 10 | `pstack/skills/correct/SKILL.md` | candidate / 未验证 |
| 11 | `pstack/skills/create-formal-verification-skill/SKILL.md` | candidate / 未验证 |
| 12 | `pstack/skills/create-verification-skill/SKILL.md` | candidate / 未验证 |
| 13 | `pstack/skills/figure-it-out/SKILL.md` | candidate / 未验证 |
| 14 | `pstack/skills/how/SKILL.md` | candidate / 未验证 |
| 15 | `pstack/skills/in-your-own-words/SKILL.md` | candidate / 未验证 |
| 16 | `pstack/skills/interrogate/SKILL.md` | candidate / 未验证 |
| 17 | `pstack/skills/ketchup-video/SKILL.md` | candidate / 未验证 |
| 18 | `pstack/skills/ketchup/SKILL.md` | candidate / 未验证 |
| 19 | `pstack/skills/maintain-formal-verification-skill/SKILL.md` | candidate / 未验证 |
| 20 | `pstack/skills/maintain-verification-skill/SKILL.md` | candidate / 未验证 |
| 21 | `pstack/skills/make-bot-ui/SKILL.md` | candidate / 未验证 |
| 22 | `pstack/skills/no-comments/SKILL.md` | candidate / 未验证 |
| 23 | `pstack/skills/poteto-help/SKILL.md` | candidate / 未验证 |
| 24 | `pstack/skills/poteto-mode/SKILL.md` | candidate / 未验证 |
| 25 | `pstack/skills/principle-attack-the-premise/SKILL.md` | candidate / 未验证 |
| 26 | `pstack/skills/principle-boundary-discipline/SKILL.md` | candidate / 未验证 |
| 27 | `pstack/skills/principle-build-the-lever/SKILL.md` | candidate / 未验证 |
| 28 | `pstack/skills/principle-encode-lessons-in-structure/SKILL.md` | candidate / 未验证 |
| 29 | `pstack/skills/principle-exhaust-the-design-space/SKILL.md` | candidate / 未验证 |
| 30 | `pstack/skills/principle-experience-first/SKILL.md` | candidate / 未验证 |
| 31 | `pstack/skills/principle-explain-the-number/SKILL.md` | candidate / 未验证 |
| 32 | `pstack/skills/principle-fix-root-causes/SKILL.md` | candidate / 未验证 |
| 33 | `pstack/skills/principle-foundational-thinking/SKILL.md` | candidate / 未验证 |
| 34 | `pstack/skills/principle-guard-the-context-window/SKILL.md` | candidate / 未验证 |
| 35 | `pstack/skills/principle-laziness-protocol/SKILL.md` | candidate / 未验证 |
| 36 | `pstack/skills/principle-make-operations-idempotent/SKILL.md` | candidate / 未验证 |
| 37 | `pstack/skills/principle-migrate-callers-then-delete-legacy-apis/SKILL.md` | candidate / 未验证 |
| 38 | `pstack/skills/principle-minimize-reader-load/SKILL.md` | candidate / 未验证 |
| 39 | `pstack/skills/principle-model-the-domain/SKILL.md` | candidate / 未验证 |
| 40 | `pstack/skills/principle-never-block-on-the-human/SKILL.md` | candidate / 未验证 |
| 41 | `pstack/skills/principle-outcome-oriented-execution/SKILL.md` | candidate / 未验证 |
| 42 | `pstack/skills/principle-prove-it-works/SKILL.md` | candidate / 未验证 |
| 43 | `pstack/skills/principle-redesign-from-first-principles/SKILL.md` | candidate / 未验证 |
| 44 | `pstack/skills/principle-separate-before-serializing-shared-state/SKILL.md` | candidate / 未验证 |
| 45 | `pstack/skills/principle-sequence-verifiable-units/SKILL.md` | candidate / 未验证 |
| 46 | `pstack/skills/principle-subtract-before-you-add/SKILL.md` | candidate / 未验证 |
| 47 | `pstack/skills/principle-test-behavior-not-implementation/SKILL.md` | candidate / 未验证 |
| 48 | `pstack/skills/principle-type-system-discipline/SKILL.md` | candidate / 未验证 |
| 49 | `pstack/skills/recall/SKILL.md` | candidate / 未验证 |
| 50 | `pstack/skills/reflect/SKILL.md` | candidate / 未验证 |
| 51 | `pstack/skills/setup-pstack/SKILL.md` | candidate / 未验证 |
| 52 | `pstack/skills/sharpen/SKILL.md` | candidate / 未验证 |
| 53 | `pstack/skills/show-me-your-work/SKILL.md` | candidate / 未验证 |
| 54 | `pstack/skills/statechart/SKILL.md` | candidate / 未验证 |
| 55 | `pstack/skills/swarm/SKILL.md` | candidate / 未验证 |
| 56 | `pstack/skills/tdd/SKILL.md` | candidate / 未验证 |
| 57 | `pstack/skills/teach/SKILL.md` | candidate / 未验证 |
| 58 | `pstack/skills/technical-writing/SKILL.md` | candidate / 未验证 |
| 59 | `pstack/skills/typescript-best-practices/SKILL.md` | candidate / 未验证 |
| 60 | `pstack/skills/unslop/SKILL.md` | candidate / 未验证 |
| 61 | `pstack/skills/why/SKILL.md` | candidate / 未验证 |

清单不是方法数量或功能完成率：playbook、principle、agent、工具脚本与其他573文件仍由完整source-lock追踪，61个SKILL入口也可能共享依赖或包含宿主专有行为。本次只读本地既有资料并写本表，没有抓取上游、执行源工具或修改任何采用pin。
