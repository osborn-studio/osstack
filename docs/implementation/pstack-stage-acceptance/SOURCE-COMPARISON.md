# pstack 原始/新上游与 OSStack 代码对照

原范围 `99b609a7`，新clone `4dd1d058`；OSStack main `e4643324`，待发布候选 `8e830561`。本轮只读源码，没有安装或执行上游工具。

**关键结论：已有方法材料和有限工程工具可验收；原规格的正式recipe/admission/local_verified/资格链仍不能称完成。最新上游变化另列升级评估，既不追加旧验收范围，也不删除旧欠账。**

## orch / coordination

- **上游原件：** 旧orch是可执行文件资料库：units增改查、ledger按PR/SHA记裁决、inbox push/drain、gates、standing、status；atomicWrite+目录锁串行写。frontier从当前branch/forge沿base向下和open-child向上发现线性栈，拒循环/分叉，并可核显式PR列表。它不spawn/wait/wake代理。
- **OSStack实际：** parallel-work指导自包含brief与单写者，沿既有OSStack看板/版本化账本；候选inspectPrStackCandidate及report-pr-stack-candidate对用户显式1–3 PR列表一次读取、区分merged前缀/frontier/upstack。
- **未做/刻意不做：** 刻意不复制第二个TSV权威控制平面；未提供上游orch等价inbox/gates状态机及自动栈发现。候选工具不是调度器或完整栈发现器。
- **新上游变化：** 新4dd1删除orch三个文件，orchestrate改为宿主Task、Project tracker/store与事件订阅，明确不运行脚本或轮询。这是宿主依赖转变，不是旧工具被OSStack完整移植。
- **范围判断：** 原capability-catalog第140行明确不作为第二权威状态；这些没有移植并非全是遗漏。新宿主事件订阅不能倒推为旧验收必需。
- **关键锚点：** old:pstack/skills/poteto-mode/scripts/orch/store.ts:184；old:pstack/skills/poteto-mode/scripts/orch/store.ts:337；candidate:packages/github/src/pr-stack-candidate.ts:5；candidate:packages/github/src/pr-stack-candidate.ts:88

## watch-pr / forge observation

- **上游原件：** watch-pr CLI接单PR/stack/queued-stack，默认60s轮询/300s全栈sweep、timeout0无截止、错误预算5，status-only单次；policy读取checks/threads/merge facts并分类READY/BLOCKER/WAITING/ADVANCE/COMPLETE。它观察并发出裁决，不是合并执行器。
- **OSStack实际：** main inspectPrCandidate/report-pr-candidate是8请求/90s、head/base前后绑定、失败/等待/未知分轴及原始查询输出的一次报告，merge_authorized恒false；308/309修复导入StatusContext/CheckRun分类。候选stack报告复用同collector，限制3 PR/24请求/270s。
- **未做/刻意不做：** 没有polling/rearm/自动修CI/自动retarget/merge；不发现全部rulesets、merge queue与approval身份。故意不照抄上游assessGitHubMerge的宽松allowed分类。stack导入NEUTRAL/SKIPPED与snapshot严格政策仍不同，报告不等于Ready。
- **新上游变化：** watch-pr目录全部12个成员逐字节相同；babysit说明有变化（如Origin分支和drive到merge-ready），不能推断工具已支持Origin。
- **范围判断：** 原W13要求只读classifier并约束ready不是许可；A27/A28已有直接组件证据，可以按原门槛单独验收。持续watcher是PS18较广扩展，绝非W13/A27/A28验收前置；W10依赖另列。
- **关键锚点：** old:pstack/skills/poteto-mode/scripts/watch-pr/cli.ts:82；old:pstack/skills/poteto-mode/scripts/watch-pr/cli.ts:110；main:packages/github/src/pr-candidate-snapshot.ts:1；main:scripts/report-pr-candidate.mjs:1

## check-plan / plan semantics

- **上游原件：** 一个读取Markdown的确定性校验脚本：固定H2/H3顺序、9类PR子块、十条live lanes、截图/Pass when、perf四项及英文标点禁则；通过只说明模板匹配，不执行所列验证。
- **OSStack实际：** 架构/task-framing/parallel方法保留使用者与验收约束；联合validate-design.py/validate-execution.py校验本项目设计/账本及集合关系，协议MethodMaterial包含verification_plan等严格结构。
- **未做/刻意不做：** 不存在同名通用check-plan替代入口，也没有所有用户计划的自动语义真实性判定。未照搬固定十lane、截图要求和英文标点是刻意适配。联合文档检查不能冒充通用语义计划验证。
- **新上游变化：** check-plan源码及其test均不变；multi-phase-plan方法文案已变，未执行兼容性测试，不能仅凭脚本不变认新文案自动相容。
- **范围判断：** 原catalog第142行写改为结构化语义检查；目前有项目专用结构校验及材料shape。这里记录catalog层面的广义目标差异，不把通用语义工具另加成48A/19W或当前方法材料验收门槛。
- **关键锚点：** old:pstack/skills/poteto-mode/scripts/check-plan.mjs:5；old:pstack/skills/poteto-mode/scripts/check-plan.mjs:91；main:docs/design/2026-10-27-joint-engineering/validate-design.py:1；main:docs/design/2026-10-27-joint-engineering/validate-execution.py:1

## statechart / formal verification

- **上游原件：** 旧statechart.mjs提供from-spec、from-chart、render：调用TLC/辅助脚本，把模型、反例与图互转、对照fix/against、渲染PNG，要求模型bug路径回放真实代码；需要TLC/Java/renderer，不是仅Markdown。
- **OSStack实际：** 目前方法有状态/所有权/反例推理，恢复规范有SQL/协议负例；不是该TLA/TLC/图形工具链。检查main及candidate的packages/scripts未找到statechart或check-plan移植入口。
- **未做/刻意不做：** 完整形式化建模工具链、坏变体TLC证明与代码回放资格均未实施；现有SQL/spec测试不等于形式化验证。此专门工具原为独立可行性试点，需另验。
- **新上游变化：** 旧mjs工具群删除，新增TypeScript frontend/IR/pass/backend、worker、statechart入口与大量静态corpus。新入口SPEC.tla --config --view --out，>500 states限制图形，保留TLC自身结果和未检查规则；不再是原from-chart接口。
- **范围判断：** 原W16只选一个高后果不变量做独立可行性试点；不能将最新重写的全工具链追加为原先完成门槛。
- **关键锚点：** old:pstack/skills/statechart/scripts/statechart.mjs:35；old:pstack/skills/statechart/SKILL.md:1；main:osstack-methods-skill/references/architecture-design.md:1；main:packages/protocol/src/method-materials.ts:1

## qualification / source and host adoption

- **上游原件：** 上游setup-pstack检测模型并写Cursor规则；create/maintain verification指导实际驱动/观察/清理与覆盖维护。指定代码目录中没有对应OSStack candidate→qualified→active recipe服务；资格状态及admission是我们的集成设计，不是上游现成可复制工具。
- **OSStack实际：** inspectGitSource是实际Git单源检查subpath API，固定对象/许可/hash/限额，明确dependency_resolution=not_performed；协议MethodBinding/TrialPermit/SupportProfile/ContextReceipt实现纯结构及digest联结，trialBudgetIssues始终含adapter_invocations_unattested。普通export/journey/map/projection已是可用有限入口。
- **未做/刻意不做：** 没有完成采用依赖闭包、正式recipe注册/编译到运行admission、首次trial实际生产授权及后续qualification激活；纯协议存在不等于host消费。不能把旧W08 local_verified或J08/J10承诺转记为全完成。
- **新上游变化：** setup模型偏好和formal-verification文稿有变；不是新增一个可直接替代OSStack资格系统的上游服务。
- **范围判断：** 原审计D03–D05要求真实材料通道、检查绑定和无active状态首次资格；D02先验证命名工具价值，D08结构/语义/收益分开。有限D2a工具可先验收，但这不注销正式集成欠账。
- **关键锚点：** old:pstack/skills/setup-pstack/SKILL.md:9；old:pstack/skills/create-verification-skill/SKILL.md:1；main:packages/skill-registry/src/source-snapshot.ts:1；main:packages/skill-registry/src/source-snapshot.ts:41

## 本次版本差异的限界

pstack tracked路径 200→573，无rename识别的diff计数 {'M': 25, 'D': 33, 'A': 406}；大量增量属于statechart测试corpus，不能当新增用户能力数量。watch-pr完整12成员同字节，check-plan源码同字节。

原审计D03–D05的材料消费、首次资格和实际host链没有被“导出14方法”自动解决；相反，实际驱动、维护、证据保存和宿主修复试验回应了D02/D06的先证明价值方向。原失败/LIMITED继续保留。完整原文件hash、现有入口hash及每项缺口见JSON。
