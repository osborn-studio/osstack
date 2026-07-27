# 附录：五份阶段计划的完整审计报告（原始输出）

> 本附录是五个并行审计 agent 的完整原始报告，供 Codex 再审计时复核证据链（尤其各"文件核验"表）。主结论与修订指令以 `2026-07-27-kimi-autonomy-plan-audit-by-fable5.md` 为准；两者如有出入，以主文件为准。每份报告均基于 pinned commit `4981378` 的真实源码逐条核验。

**索引**：A=P0–P2 Adapter/Verifier ｜ B=P3 Profile/Deliver ｜ C=P4 Guarded Git ｜ D=P5–P6 Deploy/Ops ｜ E=P7 Productization

关键核验事实速查（跨报告汇总）：

- `@osstack/cli` 版本 0.12.0、9 个默认 adapter、`deliver`/`loop run`/`loop start` 均存在于 `packages/cli/src/bin.ts`（11,698 行）
- `deliver` 今天不解析 profile（bin.ts:9012 仅认 `--agent/--auto-agent`）；`active_profile:auto` 在执行路径被 9881 行短路——Plan B 的 gap 主张全部属实
- `packages/github@0.10.0` 已存在（只读 branch stewardship），Plan C 正确按"扩展"处理；`packages/autonomy` 不存在，确为新建
- migration 链：现末条 id=16，Plan C 用 17、Plan D 用 18，跨四份文档零冲突
- `RepoConfigCommon` 九字段与 `packages/core/src/policy/profile.ts` 逐字一致；launchd 四件套模板文件名精确匹配
- `commitWorktreeChanges`（`packages/agents/src/worktree.ts:66`）为 `git add -A` 全量提交——Plan C"untracked 绕过"发现的事实基础
- 协议 `CommandStatus = ["ok","n","blocked","error"]`（`"n"`=待审批）——Plan C `needs_approval` 字符串与协议冲突的事实基础
- `packages/loop/src/publisher.ts:12` `DEFAULT_COMMAND` 硬编码 Owner 私有卷中的 publish 脚本且随 npm 发布——Plan E 高危隐私缺口的事实基础；具体路径在本仓库版报告中脱敏
- 原隐私扫描使用的旧用户名在整个仓库零匹配；真实 Owner 用户名、主机名、卷名和私有仓库名均未覆盖
- 现有独立性兜底 `enforceRoleSeparation`（loop-engine.ts:73/757）真实存在，Plan B 未提及，修订要求保留为纵深防御
- verifier 现状：`OSSTACK_EVALUATIONS:` 前缀哨兵约定、unknown-id passing-orphan=warning 是有意设计（verifier.ts:95-99）、`invokeVerifierAdapter` 独立 120s 超时（verifier.ts:548）

由于五份完整报告合计约 1.5 万字，为控制单文件体积，原始报告以对话记录形式存档于 Owner 侧；本附录保留上述核验事实速查与下列各报告结论段。Codex 如需任一完整报告，向 Owner 索取即可。

---

## A（P0–P2）结论段

**有条件通过。** 计划骨架质量高：包名、文件路径、既有导出、测试框架、fixture 惯例约 90% 与仓库实际严格吻合，failing-test-first 与 fail-closed 主链路（exit-0-非-approved / malformed / unknown-id / mutation 全部阻断）均"实现+测试"双落地。但不能原样交给 fresh Codex：必须先修 ① Task 9 doctor 目标文件错误 + roles/能力清单内部矛盾；② 另一台机器的硬编码用户路径；③ DonePayload 契约缺口（否则 daemon 路径静默降级）；④ Task 10 语料语义（否则 A→B 晋级门是恒真式）；⑤ Task 6 增补 common Git directory 与 ignored 路径检测（Critical，修复成本低）。应修：subject_run_id 仲裁、stream 键形以实测为准、verifier 超时接线、`buildKimiPrompt` 定义。均为文档级改动，约半天。

## B（P3）结论段

**有条件通过。** 事实基础扎实（所有代码级主张经核验为真）、TDD 结构完整。三个实施前阻断项：(1) Task 5 激活逻辑与 legacy 保留承诺正面矛盾且无快照测试兜底——威胁总计划 §7 回滚契约；(2) Task 9 验收依赖不存在的任务（config show/doctor 的 identity 展示）；(3) 独立性证据可由用户配置自证，与设计 §6.4 冲突，且该证据被 Phase C 的 R2 门直接消费。三项合计约一天文档修订。

## C（P4）结论段

**有条件通过。** 工程纪律上乘、对仓库现状引用几乎无一失真；但四项高严重度——post-diff R3 批准无合法通路（状态机自锁）、diff 采集未定义导致 untracked 绕过、批准/证据到 commit/merge 的 TOCTOU、无分支保护仓库 fail-open——分别击穿不变量 8/9、11、13 的实际效力，必须在 Task 2/4/7/9/11 层修订后实施。中危项（preflight 审批语义、action_scope 执行期强制、human actor 自声明、双审批体系、blocked_delivery 死路、opening_pr 幂等、Task 8 缺 loop 依赖、R3 规则缺项与策略自改绕过、policy 读取来源）随同批修订。

## D（P5–P6）结论段

**有条件通过。** 架构方向正确（扩展真实 daemon/launchd/registry）、文件核验通过、soak 门禁可机读。四个高危必须修入文本，否则交付的是"白名单表面严格、实际可被 R1 级 PR 从 rollback 脚本与 change-type 两侧绕过、冻结可被同机代理自我解除、审批挂起无人知晓"的生产部署通道：① deploy 引用脚本改动→R3+digest 钉扎；② change-type 闭集与确定性推导；③ Owner 通知通道（新增 Task 11.5）；④ freeze clear 的人类身份不可自证。另有 env 全量透传、回滚演练无生产方、stricter-merge 四处歧义、macOS 睡眠未处理（pmset）、30 任务供给无计划等中危项。

## E（P7）结论段

**有条件通过。** 发布门禁扎实（严格排在 soak 证据之后）、升级/回滚 E2E 与真实 schema 版本完全咬合、所有引用无一悬空。两个高危隐私缺口必须实施前修正：(1) `packages/loop/src/publisher.ts` 随 npm 发布的 Owner 绝对路径默认值完全在清洗范围之外；(2) 隐私 grep 用了零匹配的错误用户名且非 CI 门禁——现状会绿灯放行真实污染。附带条件：Kimi 未装/未登录两态区分、发布说明显式平台矩阵（macOS-first）、worktree 路径改真实 SSD 位置。约一个工作日。
