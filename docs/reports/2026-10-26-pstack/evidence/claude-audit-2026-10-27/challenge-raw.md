# 一、总体判定

**结论先行。** 研究部分站得住：对 `watch-pr ready`、orch 账本、固定 v4 拓扑、Graph host 只接 `local_verified` 这四条源码结论，我按所附 `policy.ts`、`fakes.test-helper.ts`、`store.ts`、`code-delivery-v4.ts`、`graph-delivery-contract.ts` 逐条复核，均成立。R1 与 R2 的 `ready` 结果可以从 `policy.ts:12-31`、`policy.ts:141-147`、`policy.ts:183-217` 直接推出；R3 的后写覆盖对应 `store.ts:1419-1427`。

**但"验证先行"并未缩小控制面，只是调换了顺序。** 修订 2 把 W06 排到最前，却保留了 W01 到 W11 全部 14 个 P0 工作包和 13 个 P0 能力组。规格在 `integration-spec.md:491` 自己承认，要到检查点 C3 之后"才可评估 P0 的实际价值"。这意味着价值验证被放在 14 个包之后，与报告反复声明的"接口由使用校准"相矛盾。

**可执行性判定：不具备。** 标题称"可执行集成规格"，而 `integration-spec.md:592-602` 列出六项实施时必须再确认的未知。我另外找到三个会改变实现的决定没有定下来：方法材料在上下文里的落点、主检查的指定、驱动动作注册表与现有验收注册表的关系。这三个决定任意一个改变，W03 到 W06 的形状都会变。

# 二、发现

**CH01 ｜ P1 ｜ 置信度高 ｜ 欠定合同与过度设计**
- 位置：`integration-spec.md:19`、`integration-spec.md:24`、`integration-spec.md:443-447`、`integration-spec.md:627-658`；`acceptance-cases.json:427-455`；`README.md:291`。
- 被违反的声明：规格第 0.2 节说"第一条路径成功之后再将 smoke 固化为可维护控制工具"；ADR-10 说接口由调用样例推导。
- 证据链：W06 的范围写的是"先一个命名场景"，但全文没有命名这个场景。同一个 W06 的验收却要求 doctor、setup、drive、observe、wait-settle、trace、cleanup 七个操作，外加渐进 help、机器输出、dry-run 语义和 trace 采样预算。附带的上游 `principle-subtract-before-you-add/SKILL.md:16-17` 明确写"按观察到的用法设计，不为推测的边缘情况建校验"，报告把这条原则抽取为 PS23，却在 W06 上没有应用。P0-A 的退出条件"冷启动能观察真实终点"没有可判定的谓词。
- 失败场景：实施者为满足 A33、A34 先做完七个操作的骨架和错误码，第一条真实路径只驱动了一个 `--version` 级的命令。C0 被宣布达成，但没有任何产品行为被观察过。
- 最小修正：把 W06 改为"一个命名场景加四个操作"。场景可直接取 `author-reading.md:43` 的"任务取消后仍产生输出"；操作只保留 doctor、drive、observe、cleanup。setup、wait-settle、trace 移到 C0 之后，等第二个场景需要时再加。
- 证伪测试：写出该场景的行为谓词，证明它不能被退出码或 help 文本满足。做不到，说明场景没选对；做得到，说明七操作表面没有必要先于它存在。

**CH02 ｜ P1 ｜ 置信度高 ｜ 兼容缺口与确定性矛盾**
- 位置：`integration-spec.md:241`、`integration-spec.md:276-285`；`execution-context.ts:55`、`execution-context.ts:76-78`、`execution-context.ts:104`、`execution-context.ts:169-170`、`execution-context.ts:211`；`delivery-contract.ts:70`。
- 被违反的声明：第 4.6 节要求"必需方法材料不能只放进普通知识搜索"，并要"用确定的材料选择"在 invoke 前拒绝遗漏。
- 证据链：现有主机只有三种 mandatory 条目，即 instruction、safety、contract，见 `execution-context.ts:76-77`。其他全部材料走 `createPinnedLocalContextLoader`，它用 `searchKnowledgePacks` 按 prompt 前 4096 字节检索，见 `execution-context.ts:211`，属于查询相关的选择，不是确定选择。可选材料默认预算 8192 字节，而规格给 `method_brief` 的上限是 16KiB。`validateContextSync` 只收到 `assembly.selected`，看不到 mandatory，见 `execution-context.ts:104`。唯一能确定进入 prompt 的通道是 `contractBrief`，其上限是 32000，见 `delivery-contract.ts:70`。
- 失败场景：A11 要么永远失败，因为 12KiB 的方法材料在默认预算下必被裁剪；要么实施者为通过测试新增一个 mandatory tier 和新的 fence，这正是报告说不该建的"平行机制"。
- 最小修正：规定方法摘要作为 contract brief 的一部分进入冻结合同，受 32000 字节总预算约束；知识包只承载可选引用；删除 `METHOD_CONTEXT_OMITTED` 作为独立错误码，因为 mandatory 条目不会被省略。W05 相应收缩为 receipt 校验。
- 证伪测试：同一段 12KiB 方法材料，一次放入 pinned pack，一次放入 contractBrief，在默认配置下比较 prepared receipt 的 `omitted` 与 `prompt_sha256`。

**CH03 ｜ P1 ｜ 置信度高 ｜ 确定性矛盾，机器清单与规格不一致**
- 位置：`capability-map.json:1038-1078`，尤其 `capability-map.json:1075-1077`；同类空值见 `capability-map.json:297`、`541`、`575`、`620`、`878`、`922`、`977`、`1127`；`validate-report.py:40-64`；`README.md:33`；`validation.md:98`。
- 被违反的声明：README 称机器清单含"24 组抽取能力、来源、优先级、依赖与验收要求"；validation.md 称来源已映射到"19 项实施安排"。
- 证据链：PS21 是 P0，被 PS01、PS06、PS13、PS20 四个 P0 能力依赖，但它的 `work_packages` 为空。规格里 W01、W02 正是它的实现。PS05、PS10、PS11、PS12、PS17、PS18、PS19、PS22 同样为空，而 W12 到 W16 对应它们。`validate-report.py` 只检查 article 到 delta 到 capability 的反向链，不检查 PS 到 W 的覆盖，所以 `report-validation.json` 的 pass 不能证明这一点。
- 失败场景：任何按 capability-map.json 排计划的人会把 PS21 当作"无需实施"，而它是四个 P0 能力的前置。
- 最小修正：补齐 `work_packages`，并在 `validate-report.py` 增加断言：每个 P0 能力至少一个工作包，每个 W 至少被一个 PS 引用。
- 证伪测试：对 capabilities 过滤 `priority == "P0" and not work_packages`，结果应为空。

**CH04 ｜ P1 ｜ 置信度中高 ｜ 产品假设，P0 范围过宽**
- 位置：`README.md:291-292`、`README.md:300-315`；`integration-spec.md:17-22`、`integration-spec.md:491`；`validate-report.py:68-71`。
- 被违反的声明：`README.md:185` 说"不能因为模型列出很多可能风险就把实现膨胀"；第 10 节的试验设计只需要"实验组只增加 recipe 方法包"。
- 证据链：第 10 节的对照试验在现有主机上就能跑，因为 `bindGraphDeliveryContract` 已接受手写 brief 与注册检查，见 `graph-delivery-contract.ts:37-59`。它不需要来源快照、recipe 编译器、admission 连接层。可规格把 W01 到 W05、W07 到 W11 都留在 P0，只在 C3 后评估价值。`validate-report.py:71` 和 `validate-report.py:68` 把工作包数固定为 19、验收数固定为 48，一旦按 W17 结论修订规格，自检先失败。
- 失败场景：团队投入 14 个包后才得到第一个价值数据；若数据为负，W01 到 W03 全部沉没。
- 最小修正：把 P0 定义为 CH01 收缩后的 W06 加第三节的实验 E0。W01、W02、W09、W10、W11 降到 P1，等 E0 结果决定。自检脚本改为下限而非精确值。
- 证伪测试：不写一行 W01 到 W03 的代码，仅用手写 brief 完成 A18 的流程。能完成，则这三个包不是 P0。

**CH05 ｜ P2 ｜ 置信度高 ｜ 过度设计**
- 位置：`integration-spec.md:150`、`integration-spec.md:334-351`、`integration-spec.md:419`、`integration-spec.md:483-489`、`integration-spec.md:586-588`。
- 被违反的声明：第 3 节禁止 skill-registry "签发权限"，第 5.1 节却为 recipe 建立 discovered、candidate、qualified、active、quarantined 五态生命周期和 active 指针。
- 证据链：recipe 定义是包内文件，位于 `recipes/bug-fix-v1.json`。包内文件的升级和回退就是代码发布与 git revert。需要资格生命周期的是上游快照，因为它随远端变化；recipe 不随远端变化，只随 `source_digest` 失效。
- 失败场景：实施者为四个本地 JSON 构建状态机、active 指针持久化和隔离流程，而没有任何场景会在不发版的情况下把一个包内 recipe 置为 quarantined。
- 最小修正：生命周期只作用于 `MethodSourceSnapshotV1`；recipe 以包版本号标识，`source_digest` 不匹配即 unsupported。W11 收缩为验证功能的漂移分类。
- 证伪测试：写出一个不发布新版本就必须隔离包内 recipe 的场景。写不出来，quarantined 对 recipe 是死状态。

**CH06 ｜ P2 ｜ 置信度高 ｜ 欠定合同，注册表重复**
- 位置：`integration-spec.md:631`、`integration-spec.md:649`、`integration-spec.md:656`；`graph-delivery-contract.ts:38`、`graph-delivery-contract.ts:61-75`；`integration-spec.md:48`。
- 被违反的声明：第 1 节不包含"任意 Markdown-to-shell"；第 8 节推荐结构说新增层"不能创建任意 shell"。
- 证据链：`drive` 接受"登记动作"，`recovery.suggested_registered_action` 指向一个登记动作，但全文没有定义这个动作注册表由谁拥有、如何绑定到真实命令、信任等级是什么。现有主机已有 `AcceptanceCommandSpec` 注册表，以 `deliveryCheckReference(command)` 为身份，命令独立登记、不拼接。
- 失败场景：W06 另建一套命令注册表，两套 shell 命令的信任语义不同；或者 drive 的动作退化为脚本里写死的命令字符串，这就是报告要排除的 Markdown-to-shell 的变体。
- 最小修正：drive 动作就是 `AcceptanceCommandSpec` 条目在隔离 `OSSTACK_HOME` 下的执行；`suggested_registered_action` 填 registry_ref。
- 证伪测试：A33 制造的可恢复错误，其建议动作必须能用 `deliveryCheckReference` 在现有注册表解析。

**CH07 ｜ P2 ｜ 置信度中 ｜ 反馈路径不完整，隐藏运维归属**
- 位置：`author-reading.md:48`；`integration-spec.md:683`、`integration-spec.md:689`、`integration-spec.md:551-557`；`delivery-contract.ts:37`；`graph-delivery-contract.ts:92-104`。
- 被违反的声明：目标体验第 6 步说"相关功能地图和维护状态随之更新"。
- 证据链：冻结合同有 `allowed_paths`，候选路径由 `assertGraphContractPaths` 强制。若 worker 在 implement 节点内更新 `docs/verification/features/*`，要么路径不在授权内被拒绝，要么这些文档改动进入候选 diff 并接受 review。若由主机写，规格没有定义这条主机写路径。owner 由"项目配置指定"，而该配置不存在；周期维护明确不启用。
- 失败场景：地图的 `last_live_evidence` 只在人工跑健康脚本时更新；没有人跑，则所有叶子停在 draft，地图检索对任务没有贡献。
- 最小修正：地图证据只由 W06 工具写入 receipt root，以 `ControlObservationV1.evidence_refs` 形式记录；worker 在运行内不改地图文件。owner 字段在单维护者项目里默认指向仓库 CODEOWNERS 或省略。
- 证伪测试：在 A18 的 recipe 里加入"更新功能地图"步骤，观察 `assertGraphContractPaths` 的结果。

**CH08 ｜ P2 ｜ 置信度中高 ｜ 兼容缺口**
- 位置：`integration-spec.md:88-90`、`integration-spec.md:118`、`integration-spec.md:124`、`integration-spec.md:405`、`integration-spec.md:413`；`acceptance-cases.json:21-33`、`acceptance-cases.json:49-59`；`manifest.ts:13-38`、`manifest.ts:84`；`watcher.ts:4-5`、`watcher.ts:70`；`delivery-contract.ts:4`。
- 被违反的声明：W01 验收①"旧 manifest 不变可读"与②"未知字段失败"；4.1 说 Git commit"采用现有 Commit 规则"。
- 证据链：现有 `SkillManifest` 与 `SkillSource` 不是 strict，zod 会静默剥离未知键，文件头写着"Hand-edits are fine"。改为严格解析后，带多余键的用户手编清单会从可读变为失败。`blessed_sha` 没有格式约束；watcher 接受 7 位以上十六进制；protocol 的 Commit 要求 40 或 64 位。三者不一致，"现有 Commit 规则"指哪一个没有说。A04 要求识别"仅其他插件变化"，这需要比较子树对象，而 watcher 只做 `ls-remote`，设计上"no clone required"。W02 因此隐含引入克隆或 fetch，涉及磁盘、网络和认证，规格未提。
- 失败场景：用户现有清单因一个注释性键在 W01 后失效；watcher 回传的短 SHA 被快照构建器拒绝；W02 在无克隆的环境中无法判断子树变化。
- 最小修正：严格性只加在新的 `subdir` 与快照 schema；pin 规定为 40 位十六进制；W02 范围明示"需要本地对象库"并说明放置位置。
- 证伪测试：用含额外键的旧清单跑新解析；把 watcher 的 7 位 SHA 喂给快照构建器。

**CH09 ｜ P2 ｜ 置信度高 ｜ 欠定合同**
- 位置：`integration-spec.md:171-189`、`integration-spec.md:240`、`integration-spec.md:253-254`；`graph-delivery-contract.ts:48-49`、`graph-delivery-contract.ts:72-74`。
- 被违反的声明：4.5 说 admission "从主机 registry 精确解析 checks"，表中说 checks "满足现有 primaryRef 选择规则"。
- 证据链：主机要求选中的检查里恰有一个 `ref` 等于 `request.spec.input.acceptanceRef`，否则 `GRAPH_CONTRACT_REGISTRY_MISMATCH`。`acceptanceRef` 属于 GraphSpec 输入，参与 specHash。`RecipeProposalV1.required_checks` 没有主检查字段，所以 proposal 无法确定 acceptanceRef；同一个 proposal_digest 可能对应不同 specHash。
- 失败场景：两次用同一 proposal 启动，admission 一次通过一次失败，取决于谁填了 acceptanceRef。
- 最小修正：proposal 增加 `primary_check_id`，admission 将其映射为 acceptanceRef；编译器拒绝没有主检查的 recipe。
- 证伪测试：编译一个含三个检查、无主检查的 proposal，尝试 `bindGraphDeliveryContract`。

**CH10 ｜ P3 ｜ 置信度中高 ｜ 来源归因错误**
- 位置：`capability-catalog.md:72`；`integration-spec.md:706`；对照 `technical-writing/SKILL.md` 全文与 `architect/SKILL.md:79`。
- 被违反的声明：目录称 technical-writing 的提取价值是"先以使用教程反推接口"。
- 证据链：所附 technical-writing 技能只讲 Diátaxis 四模式与句法规则，没有"由使用推导接口"的内容。该思想出现在 architect 的 Outputs 段："The caller's usage is written first and the type sketch derived from it"。第二个来源是 ART2，属不可独立核验的作者阅读记录。
- 失败场景：PS23 的 P0 依据被错误地挂在一个风格技能上；若有人复核来源会降低对整个目录的信任。
- 最小修正：PS23 的"使用先行"引用 architect，并把 ART2 标为未验证来源；technical-writing 只保留文档四模式。
- 证伪测试：在 technical-writing 全文检索 usage、signature、interface，应无命中。

**撤回或收窄的质疑。** 我本想指出 `watch-pr ready` 在上游语境里也不是合并许可，但 `README.md:218` 已承认这一点，且 `poteto-mode/SKILL.md:33` 要求独立验证后才能 arm，这不是对报告的有效反驳。我也考虑过"路由由模型决定因而不可测"，但 `integration-spec.md:15` 已把路由定义为可见可纠正而非确定性，A48 作为 integration 级别是合理的产品假设。

# 三、最小实验、决策与证据限制

**实验 E0，手写 brief 对照试验，不需要 W01 到 W05。**
1. 从 OSStack 历史里挑三个已修复且有回归测试的缺陷，在隔离克隆上回退修复，形成三个 fixture 分支。
2. 为每个 fixture 手写一份 bug-fix 方法 brief，内容限于 intent_frame 与 verification_plan 两项，放入 `FrozenDeliveryContractV2.brief`。注册两到三条验收命令，即失败的回归测试、typecheck、相邻测试。完成级别 `local_verified`。
3. 在独立 `OSSTACK_HOME` 下走现有 Graph v4 路径，对照组 brief 只含目标，实验组含方法 brief。每个 fixture 两臂各跑两次，交错顺序，共 12 次。
4. 记录：join 结果、消耗的 epoch 数、墙钟时间、worker 自报验证与 tests 节点结果是否一致、工具故障次数。
5. Go 条件：实验组在至少两个 fixture 上少用一个 repair epoch，或把 `stop` 变为 `ready`，且没有新增无依据通过。满足则做 W03，把手写 brief 变成可复现编译。
6. Stop 条件：结果无差异或成本上升。此时只保留 CH01 收缩后的 W06 作为 smoke 扩展，W01 到 W05 全部搁置。

这个实验同时交付 W06 的第一个命名场景，因为跑它就需要隔离启动与观察。

**最有后果的三个决定。**
1. 方法材料的运输通道，即 contract brief 还是知识包。这决定 W05 和新 fence 是否存在，见 CH02。
2. 来源固定与 recipe 编译器是否属于 P0。由 E0 的结果决定，见 CH04。
3. drive 动作注册表是否复用 `AcceptanceCommandSpec`。这决定 W06 的形状并避免第二个命令信任域，见 CH06。

**保留。** 所有已确认的边界：只接 `local_verified`、scout 不映射为 implement、上游文本为 untrusted reference、更新只生成 candidate、模型身份标 reported、patch-id 不继承证据、TSV 不作权威。第 0.3 节三类输出分层。R1 到 R4 探针结论。A08、A10、A15、A16、A20 五个否定用例。

**修改。** W06 收缩为一个命名场景四个操作。方法摘要改走 contract brief。补齐 capability-map 的 work_packages 并加自检。P0 重定义为 W06 加 E0。proposal 增加主检查。manifest 严格性只加在新字段。

**延后。** W01、W02 等到有第二个来源或 E0 为正。W09 到 W11、W12 到 W16。recipe 的五态生命周期。setup、wait-settle、trace 三个操作。`FeatureJourneyV1` schema，在三个叶子页之前只用 Markdown。

**验证缺口，与确认缺陷分开。**
- 两篇 X 原文未附，`author-reading.md` 与 `author-articles.json` 是宿主作者的阅读记录。所有标注 ART1、ART2 的设计依据，包括 AD01 到 AD12，本审计一律视为未验证。
- `types.ts` 未提供，无法确认真实 reader 是否接受 `mergeStateStatus: "UNKNOWN"`。R2 只证明分类器语义，报告也是这样表述的。
- main 是否支持独立 socket 与隔离 `OSSTACK_HOME` 下的守护进程，是否已有本地端到端 Graph 运行入口，所附文件无法证实。A13 与 A18 依赖这两点。
- `validation.md:92` 写工作区快照文件为 `workspace-status-at-research.txt`，`validate-report.py:158` 读的是 `workspace-status-at-article-revision.txt`。两个文件均未附，可能是修订 2 的文档漂移。
- 82 项上游测试证明的是上游工具自身行为，与 OSStack 集成的任何一项验收无关；48 个验收场景零执行。
- `evaluation-spec.ts` 的 property、contract 等模式只是标签，报告已正确声明它们不是 formal checker，本审计未发现相反证据。
