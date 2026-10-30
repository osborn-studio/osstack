# pstack-first feature queue

## 当前优先：原范围阶段验收（2026-10-30）

[完整对账与建议](../../implementation/pstack-stage-acceptance/README.md)保留原24PS/19W/48A和C0/C1/C2。S1–S3只供已交付工具单独验收；S4历史宿主结果仍受限。没有用户签收或范围删减。W13只读分类不额外要求持续watcher；原端到端集成仍未闭合。

This is the delivery queue, separate from activity counts and the 32 formal joint milestones. Main has four entry points and fourteen method materials; those counts are not completed capability counts. The 24 source capability groups currently contain 20 partially delivered and four deferred groups. No whole-capability completion is inferred.

## Active delivery

| Order | User-visible outcome | Current action | Completion boundary |
|---|---|---|---|
| 1 | Read the complete selected method material without silently losing its tail | PR303 merged into maina0ecd79d: bounded paging and digest-pinned continuation | Tool contract + actual exported-byte reassembly; model consumption still requires a fresh host task |
| 2 | Run the full five-case skills-check journey and maintain all mapped cases | PR304 merged at5248195b; merge tree equals verified7ef051ff; historical tests keep their original SHA: optional `--scope full`; retain default two-case compatibility | Actual five outcomes 0/1/2/1/0, semantic receipts, cleanup limits, default projection compatibility and failure-path verification |
| 3 | Give a host the complete five-case result without unrelated fixture fields | PR305 merged e79fc926; tree equals published b0ea4e78, original CI/audit bindings retained | All five cases and failed/not_run/unknown states preserved; original records unchanged |
| 4 | Use current method materials to complete a fresh actual host task | Current packet defect: Codex actual RED/fix/GREEN complete; Claude stopped after permission denial, unrepaired; both16pages delivered; fix published in305 | Separate actual host outcomes and fix delivery from whole capability claims; retain Claude failure and old results, no retries for a better grade |
| 5 | Compare and repair a persistent fixed-five verification map | PR306 merged at6c9a3e8f; actualmain tree equals validated958. Fixed-five map command and CI hook available | Fixed local map only; no automatic bless, new methods, general drift discovery or formal gate |
| 6 | Make PR candidate status easier to assess | PR307 merged at de43f47c; bounded read-only snapshot is available. PR308 merged at a250ad88; PR309 merged at e4643324 after actual-main verification/CI; ordered stack-frontier report validated and preparing publication | Head/base/CI/review observations explicitly bound and refreshed; no automatic approval or merge |

Firstmate deep recovery/supervision is deferred behind these pstack paths except for necessary dependencies. Formal identity issue287 does not block ordinary bounded D2a tools.

## Source capability inventory

| ID | Capability | Current delivery |
|---|---|---|
| PS01 | 单入口任务路由与渐进方法组合 | 14共享方法、四入口路由/帮助；没有单一runtime编译/强制执行通道 |
| PS02 | 代码机制与历史动机取证 | investigation可用；how/why/teach为方法吸收，没有专门历史取证工具或全面效果验证 |
| PS03 | 意图校准与可纠正的问题模型 | task-framing已合并；实际两宿主均LIMITED，尚非任务执行收益证明 |
| PS04 | 从使用草图到原型证据的架构循环 | architecture/feature/refactoring可用；独立多原型arena和完整采纳循环未交付 |
| PS05 | 覆盖式并行与预先声明的竞赛 | PR301已合入并行分工指南；运行时派发、竞赛和完整宿主效果尚未验收。 |
| PS06 | 独立评审与意见裁决 | code-review材料+本项目独立审查审计实践；产品化跨模型评审/资格未闭合 |
| PS07 | 影响面与关键前提验证 | change-impact材料/关键前提检查；普遍宿主效果未验证 |
| PS08 | 可操控的验证基础设施与功能地图 | create-verification材料、真实隔离CLI driver及默认2/full5旅程已合入；任意项目地图生成、相关叶子检索和完整使用场景仍未闭合。 |
| PS09 | 验证基础设施的健康、归属与漂移维护 | PR306已合入固定五case持久地图维护：合法地图同值consistent0、漂移mismatch1、非法map拒2，真实注入漂移→只改地图→fresh复验成立；广义源码/地图漂移发现、资格激活仍未闭合。 |
| PS10 | 形式化验证生命周期 | 形式化生成/维护与代码mutation对应尚未作为pstack能力实现 |
| PS11 | 状态图与反例解释 | 状态图/反例解释工具未移植，不把普通Mermaid文档当模型检验 |
| PS12 | 反思转结构化约束 | skill-authoring第14方法已随PR302合入；反思到技能约束仅材料切片，不是受控经验晋升运行时。 |
| PS13 | 决策轨迹与证据归因 | 默认两例v1/完整五例v2安全证据投影与check、原始失败/manifest/回执保留已合入；不是运行真实性或身份认证，持久决策检索仍欠缺。 |
| PS14 | 性能结论审查 | 性能审查方法与合成数例可用；无因果性能提升结果 |
| PS15 | 有预算的 hillclimb 与盲评 | 有预算hillclimb/盲评尚未实现；当前有限host probe不是效果benchmark |
| PS16 | 自包含单元与协调者边界 | PR301已合入并行分工指南；运行时派发、竞赛和完整宿主效果尚未验收。 |
| PS17 | 栈前沿与候选绑定验证 | PR307单PR稳定候选快照已合入；1–3 PR有序前沿报告候选8e830已实现验证但未发布；自动发现、持续watch、变更/合并授权均未提供。 |
| PS18 | forge 观察器分类 | PR307有界只读PR观察已合入，308修StatusContext、309修CheckRun分类；缺失/未知不误绿，既有neutral/skipped政策单列。持续watcher/自动重置未实现。 |
| PS19 | 暂停与恢复对账 | session-continuity材料可用；恢复schema/spec不等于J12运行态恢复；PR301已合并紧凑报告/证据归因与协调指南，未提供自动forge观察、检索或恢复运行时。 |
| PS20 | 跨宿主方法适配 | 四入口双host导出；Codex历史checker与Claude历史exporter各有一次有界真实修复闭环，Claude材料读取不全，旧失败保留；尚无全方法等价/强制context/资格激活。 |
| PS21 | 来源快照与能力资格验证 | 更早281来源快照组件与合同、292材料源清单；实际采用闭包/资格/漂移激活未闭合 |
| PS22 | 事件 intake 与补偿模式 | Benny/外部事件intake补偿未启用或移植 |
| PS23 | 使用方式驱动的接口与文档设计 | caller-first architecture、验证材料与文档；三条冻结地图和冷用户验收未全通过 |
| PS24 | 历史上下文恢复与可理解的决策说明 | continuity/解释+301已合并简报材料；无全局记忆自动化；视频/Bot/个人风格暂缓；PR301已合并紧凑报告/证据归因与协调指南，未提供自动forge观察、检索或恢复运行时。 |

## Coordination

One implementation owner for journey code/tests, one documentation owner, one independent verifier. Root owns CI integration, shared ledger, the single full-regression queue and PR publication. Each merged PR is mapped back to PS and J items; a worker activity becoming done does not complete its parent milestone.

Historical Codex/Claude LIMITED/FAILED observations remain unchanged. New model calls require a fresh task protocol, resource boundary and budget; this queue is not an inherited experiment authorization.

## Historical PR305 merge / PR306 actual-main revalidation

PR305 merged at `e79fc92687c144969ad91242a979d904f2b2acdf`; its tree equals published `b0ea4e78`. PR306 now targets main with head `958eb72295937b96ee8affc32fa87910bbdde512`, tree unchanged from `38a6f358` and complete delta identical. Fresh validation, actual map RED→GREEN, independent checks and Sonnet 5.5 review are running. New CI40920378111 must succeed before Ready. Historical tests retain their original SHA and formal PS/J gates remain false.


2026-10-29 actual-main publication: PR305 merged at e79fc926; PR306 head958eb722 is Ready on main after CI40920378111 five applicable SUCCESS/paid SKIP. Card_b8d97bff blocked only for user merge. No formal gate or whole capability promoted. See `docs/implementation/pr306-main-retarget/ci-final`.


2026-10-29T17:49:32Z: user merged PR306; actual main6c9a3e8f tree356296e4 equals published958. Maintenance card done for that slice. Next bounded PR candidate snapshot supports PS17/18 and PS13/J07; J20 is design context only. Current integration5744 adds actualmain with empty tree delta. No new method or formal milestone completion.


Current next repair: existing stack ingestion discarded legacy StatusContext.state. New scoped two-source-file fix60495 has genuine12 RED→33 GREEN, independent old9/36 failures→36/36 and full7207/5/0 atbda. It does not change the pre-existing CheckRun neutral/skipped policy or refresh existing cards. PR307 original lint failure is retained; 24bed CI40928407347 passed lint/build but failed generated PUBLIC_EXPORTS freshness; original evidence retained, minimal generated sync8fd28911 pushed; latest CI is evaluated separately.

PR308 b4a2fc30 publishes the scoped legacy StatusContext repair, Draft on PR307 parent. Latest307 inventory repair8fd28911 CI40929858660 is running;308 must wait for actual307 user merge, retarget and validation. Existing CheckRun ACTION_REQUIRED/STALE/STARTUP_FAILURE and WAITING/REQUESTED/empty-conclusion policies remain an explicit next gap, not fixed by308.


2026-10-29 18:56UTC update: PR307 head8fd28911 now Ready/main after CI40929858660 five applicable SUCCESS/paid SKIP, root readiness mutation and readback confirmed. User approval/merge still required. PR308 headb4a2fc30 CI40930144304 also has five applicable SUCCESS/paid SKIP but remains Draft on parent307; actual-main retarget/revalidation is still required after user merge307. Both activity cards are blocked solely on their stated merge dependency, not formal qualification. Original lint/inventory failures remain preserved.


## 2026-10-30：307 合并后的执行窗口

#307 已由用户合入 main `de43f47c29d5c08ae6e6c5eb366767320ffcdd0c`，合并树等已发布8fd。#308 已以 `6d978973` 改为main，树等原b4a，CI40977980388与新鲜定向复验进行中，保持Draft。三个子代理分别承担主线复验、CheckRun异常状态修复、预冻结独立反例验证；OSStack新卡card_14b72dd7贡献PS18并支持PS17/J07，root独占PR/中央账本/full队列。异常或不完整CheckRun不能误判成功，neutral/skipped既有显式政策保留。没有新增方法或正式资格通过，历史失败/CI不改写。


## CheckRun 分类修复候选（2026-10-30）

PS18/J07支持卡card_14b72dd7已完成作者56同测试RED17→GREEN、独立57预冻向量旧20失败→新全过；root d5eea3e5全仓22包7232通过/5跳过/0失败，8677已跟踪文件字节执行期间不变，初始含4新鲜dist，不称clean committed tree。实际Sonnet5.5静态PASS，原意见与失败保留。只明确完成且SUCCESS/NEUTRAL/SKIPPED可成功，已知失败优先，其他不完整/未知pending。已有卡不自动刷新；snapshot另有政策。待发布依赖308的Draft，308当前4a7ee75d/main新CI40979169462尚未完成；不得合入featurebase。见[修复记录](../../implementation/stack-checkrun-state/README.md)。


Publication snapshot 2026-10-30T00:28:26.368600+00:00: PR309 f31e557a is Draft on parent308, CI40979844215 running; PR308 4a7ee75d targets main with CI40979169462 running. Root requires all applicable checks before Ready; user merge308 must precede actual-main retarget/revalidation of309. Original superseded308 run40977980388 was cancelled to release final candidate CI, not retried as a test failure.


Next selected slice (proposal only): a one-time explicit ordered 1–3 PR stack-frontier report reusing the merged singleton collector, preserving unknowns and never authorizing merge. Author and independent source-grounded selections are retained in `docs/implementation/stack-checkrun-state/next-selection`. Historical comparison and stored-card refresh are deferred. Implementation and acceptance freeze are not yet dispatched; no inherited host budget or new method.


Final PR308 closure 2026-10-30T00:46:39.573481+00:00: head4a7ee75d is Ready on actual main de43 after CI40979169462 five applicable SUCCESS/paid SKIP, root readiness mutation and readback. Actual synthetic25bb08b5 check/Test22packages7207pass7skip0fail, GitHub172/CLI14; exporter94total93pass1skip, projection88/journey43/reader14/maintenance24 and actual fixtures pass. Complete log is retained losslessly, no remote artifact download or rehash claim. Card7e0b1be2 blocked only for user merge. Historical CI/full/REVISE remain separately bound. PR309 stays Draft until parent merge and actual-main retarget/revalidation.


User merge308 2026-10-30T00:51:07.891452+00:00: actual main a250ad88/tree735612bc equals published4a7. Card7e0b1be2 done for the bounded slice. PR309 fc272c63 now targets main, tree equals f31 and complete16path delta unchanged; fresh verification/newCI40982097784 running. Historical parentCI40979844215 remains f31→4a,22packages7230pass7skip0fail (not local7232/5). Three-agent dispatch resumes: A implements ordered1–3 PR stack-frontier report after C independent freeze; C independently verifies; B revalidates309; root uniquely owns PR/ledger/full. New card6962ab52 contributes PS17 with PS18/13/J07 support, J20 design only. No new method/host budget or formal gate.


## 2026-10-30：309 已合并，顺序候选核对进入发布

用户于01:13:25Z合并309；actual main e4643324/treeafb6等fc272。309新main CI40982097784五适用SUCCESS/paidSKIP，check/Test22包7230pass7skip0fail；原完整log与Ready→merge回执保留，不重标旧localfull。

新有界工具只读核对显式1–3个PR顺序，不新增method。root540全仓22包7261pass5skip0fail，8784tracked执行期间字节同，初始4freshdistdirty，非clean committed tree；后单独CLI显示修复及docs/main合并不冒充finalfull。最终代码/文档8e830561在actualmain e464上224GitHub/29CLI/94export通过。C42场景58断言；Sonnet初静态PASS附真实autolink/bidi缺陷，作者同29CLI RED17/12→GREEN29，独立Pandoc10例旧7fail→新全过，限定SonnetclosurePASS，原意见和失败保留。一次真实308→309八查询在01:05历史时点识别mergedprefix/frontier且保留draft/checkpending/reviewrequired；不是Ready/merge授权或当前状态。card6962ab52贡献PS17，PS18/13/J07支持、J20设计；32J formalfalse和24PS20partial4deferred0whole不变。下一需求由源驱动选题，不重跑旧宿主失败翻绿。

## 发布回执：PR310 / pstack原范围对账

PR310 Draft/main，head `db0652dde3ec4695ef592b0d7f1c14a14a30917e`，CI40988439592运行。收口有序PR前沿在途工具和原24PS/19W/48A对账；用户验收及原C0–C3未签发，原失败保留。接下来优先原C0→C1→C2，Firstmate深runtime后排。

## PR310 最终 CI 与 Ready（2026-10-30）

PR310 head db0652dde3ec4695ef592b0d7f1c14a14a30917e 已Ready/main/MERGEABLE。CI40988439592五适用SUCCESS/paidSKIP，实际synthetic db37d26669d6bcb155cd9b99d08859d5d32c9777，22包7259pass7skip0fail；export94total93pass1skip，github224/stackCLI29。仅等gilberthello审批合并；不代表原pstack C0–C3或32J正式验收，S1–S3签收仍未发生。原失败和旧SHA证据保持。 完整原日志losslessgzip、metadata、Ready回读和三板见 `docs/implementation/pr-stack-candidate/ci-final`；未下载远程artifact，不声称重hash。未修改候选产品或重复代码审计。
