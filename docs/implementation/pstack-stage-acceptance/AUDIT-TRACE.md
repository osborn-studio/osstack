# 原作者修订与两轮审计：实施追溯

固定实际main `e4643324b9de1d2db51c744e59ccd7c05146b0a6`。原阶段包a不修改。12项文章修订、AU12+CH10共22意见、联合RV18+CH16+CO10+CF3共47意见逐号见trace.json；HV01另列，不算第23条。

**结论：原研究提出的问题已经进入设计，并有合同/来源/固定验证工具等局部产品交付；但必需材料与产物的可信接线、主检查映射、首资格/恢复及价值实验仍不能宣布闭环。**

## 重点逐主题对账

### T01 使用先于接口冻结 / W17

- 原索引：AD04/05；D02；AU/CH原CH01/04；联合CH08/09、RV12、CO08
- 设计已处理：W17→J06、W03依赖W17/W18已写入；E0可continue/shrink/stop，纯合同可先行。
- 产品证据：已有实际CLI用户路径、有限宿主修复及五例journey，证明可驱动/可观察的具体路径。
- 尚缺：没有原W17统一usage-sketch回执与命名repro/wait/cancel三图验收；不能由后来的接口文档倒称首次冻结前已做完整使用试验。
- 依据：`docs/implementation/method-full-journey/README.md`；`docs/implementation/pstack-current-repair/README.md`

### T02 PS21遗漏与完整映射

- 原索引：D01；AU01/08、CH03/10；RV15/16/17
- 设计已处理：PS21 work_packages现为W01/W02/W11，article_delta_work_packages独立为空；J02/J08/J10/J26/J01关联单列。
- 产品证据：typed registry、opt-in source inspector与固定Git/path/预算组件已交付。
- 尚缺：依赖闭包J02b、资格/漂移/撤销实际链仍欠缺；映射不空不等于来源能力完成。
- 依据：`docs/implementation/joint-source-inspection/README.md`

### T03 必读材料送达与必需产物checker

- 原索引：D03；AU04/11、CH02；RV06/11、CH15、CO05/06
- 设计已处理：角色材料、全局完成义务、host-owned配置、预算/不可裁剪、可信receipt及消费职责设计已明确；直接改frozen.brief建议被真实负例拒绝。
- 产品证据：四入口/14方法双导出；分页工具wholefile SHA与EOF；闭合两文件/v2五例投影检查器；部分实际host有字节送达。
- 尚缺：reader不证明理解/强制消费；projection不证明原运行真实性。J04 mandatory MethodBinding与J07受信同候选产物拒缺链未完成。Claude历史export最后4行未读LIMITED仍保留。
- 依据：`docs/implementation/method-material-reader/README.md`；`docs/implementation/method-full-projection/README.md`；`docs/implementation/pstack-export-repair/README.md`

### T04 检查注册与主检查选择

- 原索引：D04；AU03/06、CH09；RV08、CH16
- 设计已处理：primary_id唯一required→registry command digest→AcceptanceCommandSpec.ref，检查数/命令字节/退出规则已固定。
- 产品证据：严格schema/契约正负例和已有宿主检查基础可复用；固定工具命令已真实执行。
- 尚缺：J05 recipe compiler/两仓库不同命令映射/多个检查主项选择未按新入口完成；不能以既有host拒绝测试或硬编码smoke替代。
- 依据：`docs/implementation/joint-contract-acceptance/README.md`

### T05 首次资格与维护依赖

- 原索引：HV01/D05；AU09；RV02/03/04/12、CH03/04/11、CO04/06/07/10
- 设计已处理：candidate试验许可与active区分、单root消费/预算、profile、J11→J12→J08、J10分阶段已规定；后续gate-layers避免组件与host循环。
- 产品证据：有合同/离线恢复DDL/支持profile基础；没有首次trial运行产品证据。
- 尚缺：method-host-admission、createAndConsumeTrial FULL持久性、原子消费/崩溃恢复、实际operator/profile/首资格失败不激活仍待实施。普通D2a材料不需冒充qualified才可使用。
- 依据：`docs/implementation/joint-recovery-composition/README.md`；`docs/implementation/joint-broker-spec/README.md`

### T06 真实验证场景、地图维护与故障归属

- 原索引：AD01/02/07/08/09；D02/06；AU05/09、CH01/06/07；RV09/10、CH07/08
- 设计已处理：命名driver、环境/产品/工具/unknown分类、owner与地图writer及负例设计已明示。
- 产品证据：实际five-case 0/1/2/1/0语义验证；固定地图错配RED→只改地图→fresh GREEN；保留原始失败、partial和cleanup。
- 尚缺：固定本地五例并非任意项目生成/发现/修复；原J03/06命名统一driver和JA05/06/44仍未整体执行；注入地图漂移不是新生产bug。
- 依据：`docs/implementation/skills-check-map-maintenance/README.md`；`docs/implementation/pstack-real-loops/README.md`

### T07 语义、独立性与价值实验

- 原索引：AD03/06/11；D08；AU07/08、CH04；RV13、CH09/10/12、CO08/09
- 设计已处理：结构与语义、共同oracle、冻结时点/真实principal、完整分母、E0/E1/E2与default-enable决定已分开。
- 产品证据：有独立工程挑战、静态Sonnet审计、有限真实双host观察与修复，原FAILED/LIMITED有记录。
- 尚缺：未实施预冻结成本/任务/holdout的正式E0/E1及baseline/F/P/F+P四臂、冷用户/功效/成本实验；不推出因果收益、模型排名、独立身份或J32继续决定。
- 依据：`docs/implementation/method-continuity-delivery/host-report.md`；`docs/implementation/method-verification-journey/README.md`

### T08 摘要/恢复/旧门槛和迁移

- 原索引：D07；AU02/10、CH08；RV01/05/07/14、CH01/02/05/06/13/14、CO01/02/03/05/07、CF01/02/03
- 设计已处理：严格raw JSON/canonical域、typed恢复后态、每迁移资格、legacy完整闭包与local例外均已设计修正。
- 产品证据：J01严格解析/摘要/交叉字段组件；J11/J17真实SQLite候选DDL和离线恢复fixture。
- 尚缺：不等于真实hold处置、openRecoveryDb、跨进程CAS、broker启用或发布资格；正式oracle未认证，旧gate不由组件通过替代。
- 依据：`docs/implementation/joint-contract-acceptance/README.md`；`docs/implementation/joint-recovery-retarget/README.md`

### T09 来源、文档生命周期与入口收敛

- 原索引：AD10/12；AU12/CH05非缺陷；RV18、CO10
- 设计已处理：旧计划退出默认上下文、单目标入口路由、来源hash/完整checkout/归档前提及不采纳建议有记录。
- 产品证据：四入口14方法、来源许可、历史原审计与修订档案已保存。
- 尚缺：没有通用计划退休/上下文自动清理运行时；同模型多prompt不等于跨模型独立共识；文档统计不能替代任何产品场景。
- 依据：`docs/implementation/osstack-method-entrypoints/README.md`

## 不能升级的历史结论

- DONE_WITH_CONCERNS是原研究/规格审查完成，不是19工作包全部可开发。联合PASS_WITH_CONCERNS只对相应输入/最后三项修订有效，不是全源码全面复审或产品放行。
- 原77项文档、100合同正负例、24正摘要、5非法JSON、227锚点通过，只证明当时的文档/结构检查；当时新增69项联合JA产品场景全部未运行（原联合claude-audit.md第109行；另有66 Firstmate+48 pstack=114项继承场景，分母不同；当前main新增JA已72项，不回写历史69）。后来的产品证据必须逐候选另计，不回填历史。
- Fable/Sonnet身份来自CLI modelUsage/canonicalModel，不是独立principal认证；review和challenge均同模型。X原文由宿主阅读记录证明，Claude未独立访问原文。
- 直接追加frozen.brief、任意tree不变即可放行、统一40位Git SHA、强制新增父合同等原建议未照抄；不采纳项与其反证保持。

## 原编号索引（只指主题，不改原裁决）

- article：AD01→T06，AD02→T06，AD03→T07，AD04→T01，AD05→T01，AD06→T07，AD07→T06，AD08→T06，AD09→T06，AD10→T09，AD11→T07，AD12→T09
- original_audit：AU01→T02，AU02→T08，AU03→T04，AU04→T03，AU05→T06，AU06→T04，AU07→T07，AU08→T02，AU09→T05，AU10→T08，AU11→T03，AU12→T09
- original_challenge：CH01→T01，CH02→T03，CH03→T02，CH04→T07，CH05→T09，CH06→T06，CH07→T06，CH08→T08，CH09→T04，CH10→T02
- joint_initial：RV01→T08，RV02→T05，RV03→T05，RV04→T05，RV05→T08，RV06→T03，RV07→T08，RV08→T04，RV09→T06，RV10→T06，RV11→T03，RV12→T05，RV13→T07，RV14→T08，RV15→T02，RV16→T02，RV17→T02，RV18→T09，CH01→T08，CH02→T08，CH03→T05，CH04→T05，CH05→T08，CH06→T08，CH07→T06，CH08→T01，CH09→T07，CH10→T07，CH11→T05，CH12→T07，CH13→T08，CH14→T08，CH15→T03，CH16→T04
- joint_closeout1：CO01→T08，CO02→T08，CO03→T08，CO04→T05，CO05→T08，CO06→T03，CO07→T08，CO08→T07，CO09→T07，CO10→T05
- joint_closeout2：CF01→T08，CF02→T08，CF03→T08

HV01→T05：首次资格与维护/升级资格区分，当前首次trial仍欠实现。PS21→T02：原为空的完整映射已修，不能将修映射算来源资格完成。

本报告不新增验收、模型调用、测试、实现或中央修改。原a manifest保持不变。
