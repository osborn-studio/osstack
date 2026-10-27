from pathlib import Path
import json
ROOT=Path(__file__).resolve().parent.parent
UP=Path('/Volumes/AIMATE_WORK/Developer/CodeX/cursor-plugins')
SHA='99b609a72323b70204eab407c622f436e858e112'
BASE='c1cfccf18df97fa4b8bc2ed1752071feda9c3670'
# Authored research metadata; this script generates documentation only.
rows=[
('PS01','任务路由与可验证 recipe','P0','adapt','medium',['poteto-mode','figure-it-out'],['feature','bug-fix','investigation','refactoring'],['packages/skill-registry/src/index.ts','packages/cli/src/graph-delivery-contract.ts'],['PS21'], '把任务类型、完成条件和所需材料变成稳定的编译输入。','不能把 playbook 文本作为 shell 或任意 Graph 程序执行。','同一来源与输入生成同一 proposal digest；缺必需验收则拒绝。'),
('PS02','代码机制与历史动机取证','P0','adapt','small',['how','why','teach'],[],['packages/governance/src/probe/evaluation-compiler.ts'],['PS21'],'分离事实、推论、未知，并给出可核实的源码与历史证据。','连接器可用不等于所有私人资料都应搜索；限制在任务范围。','每个关键结论有来源；找不到来源的假设保留 unknown。'),
('PS03','目标澄清与范围收敛','P0','adapt','small',['sharpen','in-your-own-words','figure-it-out'],[],['packages/governance/src/probe/evaluation-compiler.ts','packages/protocol/src/delivery-contract.ts'],['PS02'],'提高问题深度，明确可证伪目标，保留真正需要用户决定的取舍。','改写目标不得扩大授权或隐式增加工作范围。','生成目标材料可追溯到原目标；权限与完成级别不发生升级。'),
('PS04','架构备选与竞争合成','P1','adapt','large',['architect','arena'],['prototype'],['packages/graph/src/program-resolver.ts','packages/loop/src/reviewer-isolation.ts'],['PS01','PS06'],'先比较结构不同的候选，再选基底并对合成结果重新验证。','当前固定 Graph 不支持任意动态竞争拓扑；新运行程序需另行资格验证。','候选互不读取彼此；合成后旧证据失效；不支持拓扑明确拒绝。'),
('PS05','覆盖式并行与预先声明的竞赛','P1','adapt','large',['swarm'],[],['packages/graph/src/join.ts','packages/graph/src/program-resolver.ts'],['PS01','PS16'],'区分覆盖、竞赛、混合模式，记录缺失 lane 与选胜规则。','不能用模型自述或返回数量当完成证明。','缺任一必需覆盖单元不得通过；竞赛规则固定后不能事后切换。'),
('PS06','独立评审与意见裁决','P0','adapt','medium',['interrogate'],[],['packages/loop/src/reviewer-isolation.ts','packages/protocol/src/delivery-contract.ts'],['PS21'],'每项 finding 保留定位、证据与四类 disposition；让异议可检查。','多模型一致不是事实证明，reported identity 不等于独立性认证。','未处理的 blocking finding 阻止完成；dismissal 必须有依据。'),
('PS07','影响面与关键前提验证','P0','adapt','medium',['blast-radius'],['refactoring'],['packages/governance/src/probe/evaluation-compiler.ts','packages/loop/src/evaluation-spec.ts'],['PS02'],'从调用方、格式、生命周期和配置寻找真正的失效面。','静态引用列表不能替代实际调用链和副作用验证。','关键前提映射到检查/证据；未验证项不会标记 verified。'),
('PS08','真实表面验证 harness','P0','adapt','medium',['create-verification-skill'],[],['packages/cli/src/graph-check-suite.ts','packages/cli/src/graph-verification.ts'],['PS01'],'建立 launch/drive/observe/isolate/cleanup 与 feature map。','生成的脚本未实际运行只能是 draft；禁止默认控制面 DB。','空隔离环境跑通真实 CLI/RPC 行为，清理自有资源，证据可复查。'),
('PS09','验证方法漂移维护','P0','adapt','medium',['maintain-verification-skill'],[],['packages/skill-registry/src/watcher.ts','packages/supervisor/src/evaluator-epoch.ts'],['PS08'],'随源码演进维护 feature map，区分 doc drift、harness gap、product bug。','不能删除失败 feature 或降低验收来伪造修复。','产品缺陷保留失败；harness 修改触发重新资格验证。'),
('PS10','形式化验证生命周期','P2','adapt','large',['create-formal-verification-skill','maintain-formal-verification-skill'],[],['packages/loop/src/evaluation-spec.ts'],['PS08','PS09'],'对高风险不变量建模，维护代码映射并通过 mutation 证明敏感性。','property 模式标签不是形式化证明；有界模型结果不能外推所有执行。','记录模型/代码/工具/上界；坏变体失败；反例可解释。'),
('PS11','状态图与反例解释','P2','selective-port','medium',['statechart'],[],['packages/graph/src/nodes/branch.ts'],['PS10'],'把模型状态与反例映射成人可读路径并尝试在代码复现。','渲染与 TLC 依赖隔离；不能把好看的图当验证完成。','图对应模型哈希；轨迹定位有效；超时不等于无反例。'),
('PS12','反思转结构化约束','P1','adapt','medium',['correct','reflect'],[],['packages/loop/src/lesson-draft.ts','packages/supervisor/src/evaluator-epoch.ts'],['PS06','PS13'],'将重复失败变成架构、类型、lint 或行为检查。','不自动修改全局规则、权限或评测门槛。','新规则能抓到历史错误且通过无关正常用例；保持 draft 直至晋升。'),
('PS13','决策轨迹与证据归因','P0','adapt','small',['show-me-your-work'],[],['packages/core/src/state/graph-runs.ts','packages/cli/src/proof-pack.ts'],['PS21'],'记录选择、原因、证据和结果，纠错用 superseding record。','TSV 为可读导出，不成为第二个权威状态源。','导出只读；记录绑定 run/artifact；更正保留旧历史。'),
('PS14','性能结论审查','P1','adapt','small',['benchmark-checklist','principle-explain-the-number'],['perf-issue'],['packages/loop/src/evaluation-spec.ts'],['PS08'],'检查测量是否做了真实工作，交错基线并解释瓶颈与噪声。','样本数建议不保证统计可靠；不比较不同场景的比例。','保留原始样本/失败/环境；基线不等价时拒绝相对提升。'),
('PS15','有预算的 hillclimb 与盲评','P2','adapt','large',[],['hillclimb','eval'],['packages/supervisor/src/evaluator-epoch.ts','packages/supervisor/src/adversarial-pool.ts'],['PS14','PS12'],'固定 harness、单变量实验、保留或回退并记录评价版本。','不能无限追分、泄漏答案或悄悄调整 gate。','预算耗尽停止；judge 标签盲化；评测变更产生新 epoch。'),
('PS16','自包含单元与协调者边界','P1','adapt','medium',[],['orchestrate','autopilot-full','autopilot-stack'],['packages/core/src/state/graph-runs.ts','packages/graph/src/program-resolver.ts'],['PS01','PS13'],'brief 可独立执行、单写者和有界重试、任务完成即外化。','orch 是文件管理器，不是执行器；不替换 core 数据库。','brief 缺范围/验收拒绝派发；重启只恢复主机确认的工作。'),
('PS17','栈前沿与候选绑定验证','P1','adapt','medium',[],['shipping','autopilot-stack'],['packages/github/src/stack.ts','packages/graph/src/join.ts'],['PS06','PS16'],'连续已验证前缀、一个拓扑拥有者、每次 head 变化明确重判。','不因 patch-id 相同自动继承证据；当前 Graph host 无发布权限。','head/base/env/acceptance 任一变化使旧验证不可用于新候选。'),
('PS18','forge 观察器分类','P1','selective-port','medium',[],['babysit'],['packages/github/src/attention-ci.ts','packages/github/src/delivery.ts'],['PS17'],'纯读取与纯分类分离，输出阻塞项、未知项和数据新鲜度。','上游 ready 不是合并许可；watcher 不拥有发布权限。','BLOCKED/UNKNOWN 不产出 permit；失败读回明确标 unknown。'),
('PS19','暂停与恢复对账','P1','adapt','medium',[],['pause-safely','session-pickup','worktree-cleanup','autonomous-run'],['packages/cli/src/engineering-host.ts','packages/core/src/state/engineering-store.ts'],['PS13','PS16'],'暂停时保存当前事实，恢复时核对分支、head、会话与副作用。','笔记不优先于当前事实；observed_turn 不是 delivered。','未知终止状态不作完成；对账幂等；只清理拥有的工作区。'),
('PS20','跨宿主方法适配','P0','adapt','medium',['setup-pstack'],[],['packages/core/src/capability.ts','packages/cli/src/graph-execution-context.ts'],['PS21'],'分离通用方法与宿主工具/模型实现，声明兼容性和降级。','文本替换不证明等价；缺必需工具不能静默跳过验收。','required 能力缺失拒绝；可选降级在报告可见；保存 prompt boundary。'),
('PS21','来源快照与能力资格验证','P0','new-glue','medium',['poteto-help'],['authoring-a-skill'],['packages/skill-registry/src/manifest.ts','packages/skill-registry/src/watcher.ts'],[],'固定子目录/commit/digest/许可和转换身份，对上游升级分阶段验证。','现有 registry 没有完整 ingest；此项是 OSStack 适配建设，不是上游已有控制平面。','目录越界拒绝；变更只生成 candidate；旧 run 仍绑定原快照。'),
('PS22','事件 intake 与补偿模式','P2','adapt','large',[],[],['packages/core/src/state/attention-actions.ts','packages/cli/src/engineering-host.ts'],['PS18','PS19'],'借鉴 Benny 的来源定位、去重、复现证据与外部写入补偿。','Benny 为独立 dormant automation；不默认开放 Slack、发消息或发布。','重复事件不重复副作用；部分成功有 readback/补偿；失败不瞎修。'),
('PS23','编码与写作原则','P2','reference-only','small',['typescript-best-practices','technical-writing','unslop','no-comments'],[],['packages/core/src/capability.ts'],[],'按需吸收领域建模、边界验证、行为测试与可读性规则。','个人写作偏好不是产品质量 gate；不硬迁英文标点规则。','不与既有 AGENTS 冲突；只通过明确可检查的规则晋升。'),
('PS24','上下文恢复与面向人的说明','P1','adapt','small',['recall','ketchup','ketchup-video','bro','automate-me','make-bot-ui'],[],['packages/supervisor/src/attention-planning.ts','packages/cli/src/engineering-command.ts'],['PS13'],'用真实状态解释进展与待决问题，按需呈现简图或示例。','视频/个性化和 Cursor webhook 属可选界面，不进入核心执行依赖。','报告可追溯到真实状态；只读取授权范围历史；不混淆状态等级。'),
]
caps=[]
for id,title,priority,strategy,cost,skills,plays,targets,deps,value,limit,accept in rows:
 paths=[f'pstack/skills/{s}/SKILL.md' for s in skills]+[f'pstack/skills/poteto-mode/playbooks/{s}.md' for s in plays]
 if id=='PS20':paths+=['scripts/generate-pstack-harness-trees.mjs']
 if id=='PS22':paths+=['pstack/automations/benny/skills/'+s+'/SKILL.md' for s in ['triage-issue-reports','reproduce-and-fix-issues','setup-benny']]
 if id=='PS16':paths+=['pstack/skills/poteto-mode/scripts/orch/store.ts']
 if id=='PS18':paths+=['pstack/skills/poteto-mode/scripts/watch-pr/policy.ts']
 for p in paths:assert (UP/p).is_file(),p
 caps.append(dict(id=id,title=title,status='proposed',enabled=False,priority=priority,extraction_strategy=strategy,relative_cost=cost,depends_on=deps,value=value,limitation=limit,acceptance=[accept],sources=[{'path':p,'commit':SHA,'url':f'https://github.com/cursor/plugins/blob/{SHA}/{p}'} for p in paths],existing_integration_points=[{'path':p,'commit':BASE,'url':f'https://github.com/osborn-studio/osstack/blob/{BASE}/{p}'} for p in targets]))
# Revision 2 incorporates the author articles without changing upstream Git identity.
refinements=json.loads((ROOT/'evidence/capability-refinements-v2.json').read_text())
deltas=json.loads((ROOT/'evidence/article-design-deltas.json').read_text())['deltas']
for c in caps:
 c.update(refinements.get(c['id'],{}))
 related=[d for d in deltas if c['id'] in d['capability_ids']]
 if c['id']=='PS23':
  c['existing_integration_points']=[{'path':p,'commit':BASE,'url':f'https://github.com/osborn-studio/osstack/blob/{BASE}/{p}'} for p in ['packages/cli/src/execution-context.ts','packages/protocol/src/delivery-contract.ts']]
 c['article_ids']=sorted({a for d in related for a in d['article_ids']})
 c['design_delta_ids']=[d['id'] for d in related]
 c['work_packages']=sorted({w for d in related for w in d['work_packages']})
(ROOT/'capability-map.json').write_text(json.dumps({'schema_version':1,'report_revision':2,'document_kind':'research_capability_proposal','executable':False,'status':'proposed_not_installed','source_commit':SHA,'integration_baseline':BASE,'capabilities':caps},ensure_ascii=False,indent=2)+'\n')
# All 58 skills, descriptions are research summaries rather than copied source text.
sm={
'architect':('PS04','类型、签名、模块与调用示例先行，比较结构不同的方案。','优先复用现有架构约束，避免把备选数量变成形式要求。'),
'arena':('PS04','同题独立产出，选基底并吸收局部优势。','合成后的产物必须重新验证。'),
'automate-me':('PS24','把个人工作偏好转为可维护技能。','偏好包独立于授权和验收。'),
'benchmark-checklist':('PS14','审查测量的瓶颈、公平性、噪声与真实性。','保留样本，避免不等价的速度比。'),
'blast-radius':('PS07','越过 diff 寻找影响面和关键安全前提。','把结论关联到实际检查。'),
'bro':('PS24','把上一段话重述为直接易懂的表达。','作为交互辅助，不新增运行时。'),
'correct':('PS12','将重复错误变成可强制的结构约束。','先证明能抓住历史坏例。'),
'create-formal-verification-skill':('PS10','选择高风险不变量，生成与代码对应的模型检查流程。','要求 mutation 敏感性和边界说明。'),
'create-verification-skill':('PS08','生成可启动、驱动、观察并清理的真实表面验证。','实际运行后才从 draft 晋升。'),
'figure-it-out':('PS01','无既有流程可用时，先定义可审计工作流。','动态流程先形成 proposal，不绕过闭合程序注册。'),
'how':('PS02','解释子系统结构、执行路径与归属。','用实际源码支撑关键机制。'),
'in-your-own-words':('PS03','用自己的话核对目标和待解决问题。','不能以重述替换用户真实要求。'),
'interrogate':('PS06','独立质疑并分类处理评审发现。','不能多数投票自动关闭安全发现。'),
'ketchup':('PS24','给出进展与需要用户决定的事项。','从权威状态派生，不靠记忆拼接。'),
'ketchup-video':('PS24','用短视频辅助解释近期变化。','可选展示层，核心交付不依赖视频。'),
'maintain-formal-verification-skill':('PS10','代码变化后维护模型与属性。','禁止削弱不变量来恢复绿色。'),
'maintain-verification-skill':('PS09','源码与真实运行双向核对验证流程。','区分文档漂移、harness 缺口、产品缺陷。'),
'make-bot-ui':('PS24','本地 UI 经服务端触发宿主 webhook。','只借鉴服务端保密和结构化事件；不复制 Cursor URL、绑定与安装步骤。'),
'no-comments':('PS23','审查注释，优先将约束表达在代码结构中。','不机械删除有价值的理由或协议说明。'),
'poteto-help':('PS21','帮助用户发现并选择工作方法。','帮助文档必须区分已支持与仅建议。'),
'poteto-mode':('PS01','顶层风格、流程选择、技能组合入口。','分解方法与个人风格；禁止整包自动生效。'),
'recall':('PS24','从任务历史与实时状态恢复上下文。','不得横跨无关私人会话扫描。'),
'reflect':('PS12','从本次工作提炼可改进的规则。','进入 lesson draft，非直接自修改。'),
'setup-pstack':('PS20','配置角色模型与推理预算。','映射可用 adapter；模型 slug 不写死。'),
'sharpen':('PS03','提高方法深度并重写任务描述。','保留产品取舍，不扩展范围。'),
'show-me-your-work':('PS13','记录决策、原因、证据、结果。','只读导出、追加纠错、证据可解析。'),
'statechart':('PS11','从模型和反例生成状态图或反向建模骨架。','可视化与验证结果分别标注。'),
'swarm':('PS05','覆盖、竞赛或混合派发并聚合结果。','缺口显式；新拓扑单独验证。'),
'tdd':('PS08','在明确要求或廉价明显测试路径时先写失败用例。','吸收适度性，不为低影响可逆编辑堆实现镜像测试。'),
'teach':('PS02','把机制与动机串成可理解解释。','保留事实/推论区分。'),
 'technical-writing':('PS23','先以使用教程反推接口，再区分四种文档目的。','P0 是调用体验与结构；文风规则按需本地化。'),
'typescript-best-practices':('PS23','类型、边界和工程结构建议。','与本仓库严格 TS 配置整合。'),
'unslop':('PS23','删除冗余与模板化表达。','只作为风格优化，不是交付验证。'),
'why':('PS02','从历史和不同证据类别解释动机。','按任务范围查询；无证据要明确说未知。')}
pm={
'attack-the-premise':('PS12','同一前提下反复失败后，直接检验该前提。','接入停滞检测，避免无界换补丁。'),
'boundary-discipline':('PS23','外部入口校验，内部领域逻辑保持清楚。','与已有 schema/host authority 边界一致。'),
'build-the-lever':('PS08','把重复操作或证明方法做成可复跑工具。','工具需复跑证据，而非只产出脚本。'),
'encode-lessons-in-structure':('PS12','重复教训固化为结构约束。','通过历史坏例与正常例双向验证。'),
'exhaust-the-design-space':('PS04','新颖且重要的设计比较少量结构不同的候选。','风险低或形态已定时不重复竞赛。'),
'experience-first':('PS03','以用户体验而非实现便利定义质量。','转化为可观察场景。'),
'explain-the-number':('PS14','解释数字的瓶颈与测量对象。','数字必须附样本和环境。'),
'fix-root-causes':('PS12','追到第一处错误而非不断加 guard。','合法异常状态仍需要明确处理。'),
'foundational-thinking':('PS04','先明确数据结构和共享状态。','结合现有模型而非重造领域。'),
'guard-the-context-window':('PS20','控制主上下文载荷，按需取证。','是否委派由宿主能力和授权决定。'),
'laziness-protocol':('PS23','删冗余、减少抽象和改动。','不能借精简跳过必须的边界检查。'),
'make-operations-idempotent':('PS19','重试和恢复后收敛到同一结果。','复用 effect key 和持久状态。'),
'migrate-callers-then-delete-legacy-apis':('PS23','同一轮迁移内部调用方并清理遗留接口。','不能删除已冻结程序身份或破坏恢复兼容性。'),
'minimize-reader-load':('PS23','减少隐藏状态和不必要间接层。','不把边界隔离当无用包装。'),
'model-the-domain':('PS23','用领域状态表达规则。','让非法组合在 schema/类型中失败。'),
'never-block-on-the-human':('PS03','已授权的可逆工作自主推进。','不能从不询问推导出发布/合并权限。'),
'outcome-oriented-execution':('PS01','迁移围绕最终目标组织可验证阶段。','避免与版本恢复和线上兼容性冲突。'),
'prove-it-works':('PS08','检查真实产物与真实行为。','自述和编译成功不能替代验收。'),
'redesign-from-first-principles':('PS04','新需求到来时重审原设计假设。','以证据触发，避免习惯性重写。'),
'separate-before-serializing-shared-state':('PS16','先消除共享写入，再考虑串行化。','剩余共享状态仍需主机锁/事务。'),
'sequence-verifiable-units':('PS16','每个单元结束时有可验证状态。','不能把局部通过叠加为未经验证的整体通过。'),
'subtract-before-you-add':('PS23','先清除死代码再加入新能力。','独立可审查，不混入无关大清理。'),
'test-behavior-not-implementation':('PS08','测试用户可观察行为。','保留边界/状态机测试的必要性。'),
'type-system-discipline':('PS23','语义类型、判别联合、权威 schema。','保持本项目命名与兼容规范。')}
for k,v in pm.items():sm['principle-'+k]=v
assert len(sm)==58
actual={p.parent.name for p in (UP/'pstack/skills').glob('*/SKILL.md')}
assert set(sm)==actual,(set(sm)-actual,actual-set(sm))
play={
'authoring-a-skill':('PS21','选择明确触发点、输入输出和验证方式。','生成后实际运行并保留来源。'),
'autonomous-run':('PS19','无人持续交互时维持目标、证据与运行纪律。','受预算/权限控制，不派生无期限授权。'),
'autopilot-full':('PS16','独立 PR 由各自 owner 推进。','owner 完成不是合并权限。'),
'autopilot-stack':('PS17','依赖栈共享一个拓扑写者。','防止 worker 各自 restack 冲突。'),
'babysit':('PS18','按模式观察冲突、review、CI。','观察、修复与发布权限分开。'),
'bug-fix':('PS01','先复现并定位根因，再改动并按原表面复验。','廉价明显路径可先写回归测试。'),
'eval':('PS15','建立盲化、独立 judge 和实际执行证据。','不以模型自评替代真实结果。'),
'feature':('PS01','对齐目标与验证表面，识别吞吐阻塞和可拆共享状态。','先形成验收，再实现。'),
'hillclimb':('PS15','固定评测、单变量试验、接受或回退。','有限预算与版本化门槛。'),
'investigation':('PS02','围绕假设收集和反驳证据。','调查不自动升级为代码写入。'),
'multi-phase-plan':('PS01','明确阶段、依赖、验证和回报方式。','替换固定十 lane 与英文格式 gate。'),
'opening-a-pr':('PS17','准备可审查的变更、验证说明与 PR。','发布走既有授权路径，不由 recipe 直接执行。'),
'orchestrate':('PS16','长期单元调度、brief、inbox、frontier、ledger。','抽取方法；不移植第二个控制平面。'),
'pause-safely':('PS19','停止新增动作、保存状态、留下可恢复说明。','未证明 quiescence 的执行仍为 unknown。'),
'perf-issue':('PS14','定位性能机制并验证等价负载下改善。','不能为数字省略实际工作。'),
'prototype':('PS04','在接口收敛前，用最小实验解决改变实现的未知项。','原型只产出选择证据，不冒充正式交付验收。'),
'refactoring':('PS07','明确行为保持目标并逐步迁移。','检查调用方、格式与生命周期。'),
'runtime-forensics':('PS02','依据运行时症状与证据定位问题。','收集范围和隐私由任务边界决定。'),
'trace-forensics':('PS02','用 trace 分析调用路径与时间因果。','缺 trace 就标缺证，不猜因果。'),
'session-pickup':('PS19','读记录并核对当前真实状态后继续。','旧记录不能覆盖当前 head/receipt。'),
'shipping':('PS17','独立验证、连续前缀、底部逐项交付并 readback。','不直接照搬 patch-id 复用规则。'),
'visual-parity':('PS08','在实际表面比较视觉与行为一致性。','图像证据不能覆盖不可见副作用。'),
'worktree-cleanup':('PS19','核实所有权和状态再清理工作区。','遵守本地隐藏 worktree 根与 scratch 纪律。')}
assert len(play)==23
assert set(play)=={p.stem for p in (UP/'pstack/skills/poteto-mode/playbooks').glob('*.md')}
lines=['# pstack 完整能力目录','', '本目录覆盖固定版本的 58 个顶层技能（34 个操作技能 + 24 个原则）与 23 个 playbook。逐项映射不等于对每个文件完成同等深度审计：重点流程及工具边界精读，其他项目按职责与内容结构审阅。24 个 PS 编号表示本报告的能力分组，**不是上游 ID，也不是 OSStack 已发布命令**。','', '源码来源固定到 `'+SHA+'`；可变的作者文章另见 [阅读记录](author-reading.md)。完整机器清单见 [capability-map.json](capability-map.json)，优先级与实施包见 [集成规格](integration-spec.md)。','', '## 1. 24 组能力抽取决策','', '| ID | 能力 | 优先级 | 策略 | 相对成本 | 现有主要落点 |','|---|---|---|---|---|---|']
for c in caps:lines.append(f"| {c['id']} | {c['title']} | {c['priority']} | {c['extraction_strategy']} | {c['relative_cost']} | `{c['existing_integration_points'][0]['path']}` |")
lines+=['','策略说明：`adapt` 迁移工作方法并适配主机；`selective-port` 选择性复用纯逻辑，重新校验语义；`new-glue` 是为 OSStack 新增的连接能力；`reference-only` 仅作为规则素材。成本为相对判断，不是工期估算。']
for title,subset in [('2. 操作技能（34）',[k for k in sorted(sm) if not k.startswith('principle-')]),('3. 原则技能（24）',[k for k in sorted(sm) if k.startswith('principle-')])]:
 lines+=['','## '+title,'','| 上游技能 | 分组 | 提取价值 | 集成边界 |','|---|---|---|---|']
 for k in subset:
  id,v,b=sm[k];lines.append(f'| [{k}](https://github.com/cursor/plugins/blob/{SHA}/pstack/skills/{k}/SKILL.md) | {id} | {v} | {b} |')
lines+=['','## 4. 任务 playbook（23）','','| playbook | 分组 | 核心方法 | 集成处理 |','|---|---|---|---|']
for k,(id,v,b) in sorted(play.items()):lines.append(f'| [{k}](https://github.com/cursor/plugins/blob/{SHA}/pstack/skills/poteto-mode/playbooks/{k}.md) | {id} | {v} | {b} |')
lines+=['','## 5. 工具、agent 与 dormant automation','', '| 组成 | 实际职责 | 抽取决定 |','|---|---|---|','| orch | 本地文件工作资料库、frontier、ledger、inbox 与状态视图 | 借鉴数据视图与 brief；不作为第二权威状态 |','| watch-pr | forge 读取、PR/栈状态分类、观察循环 | 选择性移植纯分类；改变 ready 语义并保留 unknown |','| check-plan | 固定计划模板校验 | 改为结构化计划语义检查 |','| statechart 工具 | TLA/TLC 结果处理、轨迹/图与渲染 | 可分离包或按需工具；先做独立资格测试 |','| show-me-your-work/log.sh | TSV 决策日志辅助写入 | 只读导出可借鉴公式字符转义，权威记录留主机 |','| worktree-audit.sh | 工作区审计辅助 | 不替换本项目 placement/scratch 规则 |','| poteto-agent | 使用方法与原则的执行角色定义 | 转为可选 role profile，不自带额外权限 |','| comment-sicko | 对注释及其声称约束的审查 | 作为定向 review 维度，非独立常驻服务 |','| harness generator | 生成宿主适配的技能树 | 吸收单源内容、显式差异、生成一致性测试 |','', 'Benny 的三个技能分别是 `setup-benny`、`triage-issue-reports`、`reproduce-and-fix-issues`。它们不属于顶层技能目录。最值得提取的是固定事件坐标、去重、信任标记、协调者专属发信、worker 无消息凭据、真实复现证据，以及外部部分成功后的补偿。不要把 dormant 模板视为已经部署的可靠事件服务；第一期不接 Slack、不创建自动发信或合并通道。','', '## 6. 不直接搬运的内容','', '- 固定模型名、推理档位、云 VM 假设与 Cursor store/Task/routine 命令。改为 adapter 能力发现与显式兼容性。','- 每个 PR 十条 live lane、普遍视频材料与英文标点格式 gate。改为风险和表面驱动的验收。','- plain TSV 中的 verifier 身份和 verdict 优先级。改为现有 host receipt 与候选身份绑定。','- patch-id 直接继承通过结果。候选、基线、环境、规则任一改变，默认重新验证。','- 自动发消息、创建外部事项或发布的泛化自主权。仍遵循用户实际授权和主机策略。','- 永久累积完整风格提示词。按任务选必要叶子内容，记录所选版本。','', '上述拒绝并不否定上游在其原宿主中的实用性；它们针对 OSStack 的控制面与恢复语义。']
lines+=['','## 7. 作者文章后的优先级修订（修订 2）','','原文阅读记录与设计差异见 [author-reading.md](author-reading.md)。PS 编号保持稳定，P0 表示第一轮价值路径，不表示每组所有可选功能都同时实施。','', '| 组 | 本轮具体前移 | 仍后置的部分 |','|---|---|---|','| PS08 / PS09 | 稳定验证接口、功能地图、健康与维护归属 | 大规模全表面覆盖、未经配置的自动定时 |','| PS02 / PS03 / PS24 | 意图校准、机制/历史证据、可纠正解释 | 视频与个人风格、无关历史扫描 |','| PS04 / PS23 | 使用教程、调用草图、最小原型与接口选择 | 动态跨模型 fan-out 和附加文风规则 |','| PS01 / PS20 | 一个目标入口、按需加载与透明路由 | 58 个独立产品命令、所有方法全量注入 |','','产品依赖以修订后的 capability-map.json 为准。顺序实验可以先在既有主机限制下验证方案；它不授予运行权限，也不改变 frozen Graph。']
(ROOT/'capability-catalog.md').write_text('\n'.join(lines)+'\n')
print(json.dumps({'capabilities':len(caps),'skills':len(sm),'playbooks':len(play)}))
