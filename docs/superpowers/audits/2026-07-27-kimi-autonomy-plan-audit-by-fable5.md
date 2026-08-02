# Kimi Autonomy Plan 审计修订包（Fable 5）

> **状态：Historical。** 本文是固定基线的计划审计修订证据；当前实现与剩余 gate 以[当前状态索引](../KIMI_AUTONOMY_STATUS.md)为准。

**审计对象**：`gilosbornhello/osstack` 分支 `docs/kimi-autonomy-plan`，固定提交 `4981378`（已核验远端一致）
**审计范围**：设计规格 + 总实施计划 + 五份阶段实施计划，共 7 份文档约 6,600 行
**审计方法**：主审（Fable 5）负责总计划/设计规格与跨文档一致性；五个并行审计 agent 各深读一份阶段计划，并逐条对照 pinned commit 的真实源码核验文件、导出、命令与测试约定；对全部 fail-closed 保证做绕过路径推演
**审计日期**：2026-07-27
**用途**：交 Codex（ChatGPT 5.6 SOL）按本包逐条修订计划文本 → 再审计 → 开发。**本包不修改经济/架构决策（KD-01~08 与 Q 冻结项全部保持），全部修订为计划文档级改动。**

---

## 0. 总裁决

| 文档 | 裁决 | 阻断项数 |
|---|---|---|
| 设计规格（specs/...autonomous-development-design.md） | **通过**（少量条款需随计划修订同步，见 §2.7） | 0 |
| 总实施计划（plans/...kimi-code-mac-mini-autonomy.md） | **有条件通过** → 已产出 v2 优化版（配套文件） | 6 |
| A：P0–P2 Adapter/Verifier | **有条件通过** | 5（含全审计唯一 Critical） |
| B：P3 Profile/Deliver 路由 | **有条件通过** | 3 |
| C：P4 Guarded Git Autonomy | **有条件通过** | 4 |
| D：P5–P6 部署与运维 | **有条件通过** | 4（+2 现实性） |
| E：P7 产品化发布 | **有条件通过** | 2 |

**总体评价**：这套计划的工程纪律在同类中属上乘——文件/包名/迁移序号引用与仓库真实代码的吻合度约 90–95%（migration 16→17→18 跨四份文档零矛盾、`RepoConfigCommon` 九字段逐字一致等细节说明计划是对着真代码写的）；failing-test-first 贯穿；fail-closed 主链路均"实现+测试"双落地。**但存在 1 个 Critical + 17 个 High**，其中多个可直接击穿总计划自己声明的 15 条不变量。全部修订均为文档级，预计 2–3 个工作日可完成后放行实施。

**五大跨文档主题**（详见 §1，总计划 v2 已吸收）：

1. **他机路径污染**：全套计划硬编码另一台机器的用户目录——该路径在执行机上不存在，且隐私 grep 使用了仓库中零匹配的旧用户名，真实 Owner 用户名、主机名、私有卷名和私有仓库名全部漏扫。本仓库版报告已将具体私有标识脱敏；原始证据保留在 Owner 本地审计附件中。
2. **只读边界与 diff 权威不完整**：reviewer 写入检测漏 `.git/` 内部与 gitignored 路径（Critical）；post-diff 分类未定义 diff 采集方式，untracked 新文件可绕过风险分类与摘要绑定；批准/证据→commit/merge 存在 TOCTOU 窗口。
3. **人类身份不可自证**：`--actor human:owner` 是任何进程都能传的字符串；同机 Builder（本就有 shell）可冒充人类批准 R3、解除生产冻结。
4. **无人值守缺通知**：设计承诺的 Owner notification 在计划中整篇缺失；R3 挂起、生产冻结、回滚失败全部静默。
5. **独立性证据可配置伪造**：`evidence_source: configured` 与 `reported` 同权重，Codex 经本地 router 走 K3 时 proof 仍声称 provider 独立——恰是设计 §6.4 明令禁止的路径，而该证据被 P4 的 R2 门直接消费。

---

## 1. 跨阶段修订（总计划层，已全部落入 v2）

| # | 严重度 | 修订 | 落点 |
|---|---|---|---|
| G-1 | High | 全套计划 worktree 路径参数化：`OSSTACK_WORKTREES_ROOT`（默认 `~/Developer/worktrees`，通过 `df` 检查配置根而不写入私有卷名）；每份计划开头声明**执行主机**（开发任务=任意开发机；P0 探针、P5/P6 soak=Mac Mini 真机） | v2 §3/§3.1 |
| G-2 | High | 新增不变量 16–20（.git/ignored 快照覆盖、diff 权威三件套、部署脚本 R3+digest 钉扎、人类批准防冒充、五种状态强制通知），并同步扩充四个晋级门 | v2 §5/§8 |
| G-3 | High | 隐私自检 grep 修正为真实 Owner 标识集合并升级为 CI 门禁 + npm tarball/单二进制产物扫描；`packages/loop/src/publisher.ts` 的 `DEFAULT_COMMAND` Owner 绝对路径（随 npm 发布！）列为 P7 前置清洗项 | v2 §10 |
| G-4 | Medium | 验证阶梯标注 `@osstack/autonomy`/`@osstack/github delivery` 自 Phase C 起适用；总计划 §1 缺口表同步标注 packages/github 已存在（扩展而非新建） | v2 §6 |
| G-5 | Medium | 新增 Kimi 用量与成本预算：`OSSTACK_KIMI_MAX_TOKENS_PER_RUN`/每日 review 次数上限，超限=external_blocker（不降级验证强度）；scorecard 记录 spend | v2 §5-15b/§8 |
| G-6 | Medium | 术语防撞：风险等级统一书写为 `RISK-R0..R4`，避免与 osstack 既有 Release/Loop 轮次术语（R0.4/R1.6/R2.4…）混淆 | v2 §0 |
| G-7 | Medium | D→E 晋级门补现实性前提：soak 前预登记 ≥30 个真实 R1/R2 backlog 任务；Mac Mini `pmset -a sleep 0 autorestart 1` 配置并由 `autonomy health` 校验（否则 7 天 soak 会被系统睡眠打断） | v2 §8 |
| G-8 | Low | 计划自检命令追加隐私 pattern 与"每份子计划声明执行主机"检查 | v2 §10 |

## 2. 各阶段计划修订清单

> 格式沿用各计划的任务编号。**[阻断]** = 实施前必须修订；其余为随同批修订。每条附具体修改方向，Codex 修订时落为计划正文文字。

### 2.1 Plan A（P0–P2 Adapter/Verifier）— 5 阻断

| 严重度 | 位置 | 问题与修订 |
|---|---|---|
| **Critical [阻断]** | Task 6 | **reviewer 写入检测可绕过**：快照基于 `git status/diff/ls-files --others --exclude-standard`，不覆盖 `.git/` 内部与 gitignored 文件。被注入的 reviewer 可写 `.git/hooks/pre-commit` 或 `.git/config`（`core.fsmonitor` 可指向任意命令），快照前后哈希相同；Phase C 在同一 worktree 自动 commit 时执行攻击者 hook。**修订**：快照纳入 `.git/config` 与 `.git/hooks/**` 逐文件 SHA-256 + `git ls-files --others --ignored --exclude-standard -z`；加"reviewer 写 hook 必被检出"失败测试。结构性根治（建议采纳）：reviewer 改在一次性 detach 只读副本 worktree 上审查，审完即毁，快照降级为纵深防御 |
| **High [阻断]** | Task 9 | **doctor 目标文件错误 + roles 断言自相矛盾**：`control-plane-doctor.ts` 是控制平面体检（封闭 check 联合类型），agent 探测实际在 `packages/cli/src/config.ts` 的 `config doctor`；且 Task 4 广告 `code.debug` 能力会派生 `coding` 角色，Task 9 断言 `roles=test-verify,reviewer,release/proof` 必挂。**修订**：Modify 目标改为 `config.ts`；Task 4 初始能力收敛为 P1 的 `code.review, release.verify`（与设计 §6.1 分阶段表一致） |
| **High [阻断]** | Task 4/7 | **review 字段未进 Hermes 契约**：`DonePayload` 无 `review_verdict` 等四键，daemon 路径经 zod parse 会静默剥掉 → 结构化裁决静默降级回 legacy 文本 fallback（恰是本计划要消灭的模式）。**修订**：`hermes-adapter` 的 `DonePayload` 增加版本化可选 `review` 嵌套对象 + conformance"parse 后字段保留"断言；Task 7 规定"配置了结构化 reviewer 但 done payload 无 review 字段 → error（fail closed）" |
| **High [阻断]** | Task 10 | **种子缺陷 false-pass=0 是同义反复**：观察 verdict 由测试自己注入，只验管道搬运。**修订**：拆双层——offline 层（fake，CI 恒跑，验 fail-closed 搬运）+ live 层（`eval-kimi-review.mjs --live` 在 Mac Mini 用真实 Kimi 审 10 case，按 `expected_finding_rules` 出 false-pass/false-alarm 记分卡）；A→B 晋级门改绑 live 层结果；记分卡复用为 P6 soak 的"Kimi finding 命中率"周报数据源 |
| **High [阻断]** | Task 1/§3 | 他机路径（见 G-1） |
| Medium | Task 3/4 | `subject_run_id` 二义（reviewer 自身 run id vs 被审 run id）——加仲裁句：等于 adapter 收到的 `task.run_id`（`_verify_` 后缀），或改名 `review_run_id` |
| Medium | Task 1/3/4 | stream-json 键形以 P0 实测为准的仲裁句；`--agent-file` 旗标纳入 P0 探针清单 |
| Medium | Task 4/7 | verifier 自身 120s 超时会覆盖 `OSSTACK_KIMI_TIMEOUT_MS`，真实审查必超 → fail always。per-adapter timeout 上浮（建议默认 600_000） |
| Medium | Task 4 | `buildKimiPrompt` 未定义（diff 如何进 reviewer 输入）——补定义：boundary 清洗后的 changed_paths + 截断 diff + 确定性结果摘要拼 prompt，reviewer 不主动读 workspace 外内容 |
| Medium | Task 7 | unknown-id 收紧是对现有"passing orphan=warning"**有意设计**的反转——写明需翻转哪些既有断言并更新设计注释 |
| Low | Task 2/5/3 | fingerprint 勿纳入 LLM 自由文本 message；`forbidden_paths` 的 `.git` 规则永不命中（注明由 symlink 检查与 Task 6 承担）；`import.meta.dirname` 与仓库 `__dirname` 惯例统一 |

### 2.2 Plan B（P3 Profile/Deliver 路由）— 3 阻断

| 严重度 | 位置 | 问题与修订 |
|---|---|---|
| **High [阻断]** | Task 5/6 | **legacy 行为被静默改变**：激活条件 `|| !input.executeCommand` 使裸 `deliver`/`loop run` 在 legacy 模式下也开始解析 profile、探测 adapter——与总计划 §7"legacy=现状行为"的回滚契约正面矛盾，且现状无快照测试兜底。**修订**：激活条件改为 `explicitProfile || roleOverrides || guardedAutonomy || (autoAgent && !executeCommand)`；新增前置任务"legacy 行为快照"（裸 deliver/loop run 的 JSON 输出与 adapter 零探测断言） |
| **High [阻断]** | Task 9 | **验收依赖不存在的任务**：无任何任务修改 `config.ts` 的 show/doctor 使其展示 runtime identity。**修订**：Task 5 与 9 之间插入任务（Modify `packages/cli/src/config.ts` + 新建 config-cli.test.ts，断言输出含 `provider_id` 且无 secret） |
| **High [阻断]** | Task 2/3 | **独立性证据可配置伪造**（跨文档主题 5）。**修订**：`provider-or-model` 级独立性判定中，任一侧 `evidence_source !== "reported"` → `{pass:false, reason:"configured/inferred identity cannot prove provider independence"}`；`independence_reason` 强制含双方 evidence_source 并写入 proof |
| Medium | Task 5 | 独立性硬校验限定 guarded-* 模式解析期报错；legacy/loop 沿用引擎层 `enforceRoleSeparation`（现有机制，计划未提及——写明保留为纵深防御并加绕过测试） |
| Medium | Task 7 | 类型名漂移（`LoopEngineOptions`→实际 `LoopRunOptions`）；`LoopProfileSummary` 必填化是破坏性变更（改可选或引入子类型）；daemon 侧改动缺文件锚点（Files 补 `daemon.ts`/`daemon-loop.test.ts`，写明 RPC 增 `profileRouting`、恢复后断言不重解析）；建议拆 7a/7b |
| Medium | Task 6 | verify 检测表漏现存第 5 条规则（package.json scripts.test→npm test）；fixture 缺 lockfile 且离线可跑性未定义（改零依赖 `node --test`） |
| Medium | Task 8 | 审批 argv 二义（硬编码 vs 存储 profile 名——固定为 `--profile <meta.profile_name>`）；旧合同卡片无 `profile_name` 时 fail closed 提示重签 |
| Low | Task 9/10 | 冒烟前先 build（否则跑旧 dist 假绿）；candidate proof 措辞越 phase（改为"现有格式 proof pack"）；zod 双版本冲突（config→agents 仅 `import type`） |

### 2.3 Plan C（P4 Guarded Git Autonomy）— 4 阻断

| 严重度 | 位置 | 问题与修订 |
|---|---|---|
| **High [阻断]** | Task 7/11 | **状态机自锁**：post-diff 升 R3 → `awaiting_approval` 的出边只有 `preparing/cancelled/escalated`，批准后唯一通路是整轮重跑 Builder → 产生新 diff → 按不变量 9 批准又失效 → 死循环。**修订**：增加 `awaiting_approval → candidate_proof` 边（仅当 resume 的 decision digest 与当前 `diff_sha256` 匹配）；加测试"post-diff R3 批准后不得重新调用 runLocal，直接进 candidate_proof"。配套定义两段审批语义：preflight 批准（`sha256("")` 哨兵）仅授权 build/verify；交付类动作必须由 post-diff 第二次批准授权 |
| **High [阻断]** | Task 4/11/13 | **untracked 文件绕过**：diff 采集方式未定义，而 commit 端口用的 `commitWorktreeChanges` 是 `git add -A` 全量提交——Builder 把 auth/secret 逻辑放进新建文件即可不进风险分类、不进 approval digest、不进 candidate proof，却被提交并 auto-merge。**修订**：post-diff 输入 = `git add -A` 后 `git diff --cached` + `git status --porcelain`，`diff_sha256` 对该产物计算；加测试"untracked 新增 auth 文件必命中 R3" |
| **High [阻断]** | Task 9/11 | **TOCTOU 窗口**：批准校验/candidate proof 与 `git commit` 之间无重算；`gh pr view` 与 `gh pr merge` 之间可向分支追加提交。**修订**：commit 前重算 staged diff 哈希并断言等于批准的 `diff_sha256`，不等转 `escalated` 留证；merge 改 `gh pr merge --squash --match-head-commit <pushedSha>`（原子校验交给 GitHub 服务端） |
| **High [阻断]** | Task 9/13 | **零保护仓库 fail-open**：未检测 branch protection；`gh pr checks` 对零 check 仓库行为未定义，最坏零门禁仓库被自动 squash-merge，"CI 全绿"空真。**修订**：交付前置 `gh api .../branches/{base}/protection`（404 → `blocked_delivery`）；"零个 check 视为失败"；补 unprotected fixture |
| Medium | Task 7/11/12 | `action_scope` 只进哈希不做执行期校验——每个外部写动作前做 scope membership 检查 + 测试；human actor 自声明（见 G-2 不变量 19：TTY 交互确认 / 拒绝 agent 会话环境 / 审批来源通道入 proof 三选一起步）；双审批体系并行（autonomy approval 关联写入 `contract_approval_decisions` 审计行，词表映射 R1/R2→low/medium、R3→high） |
| Medium | Task 12/13 | 协议状态枚举冲突：`needs_approval` 不在 `CommandStatus`（`"n"` 才是待审批）——CLI 人类可读层用 needs_approval，协议信封映射 `"n"` + `required_approvals` |
| Medium | Task 7/9/11 | `blocked_delivery` 无出边=瞬时网络故障判死刑——push/pr/ci-poll 各一次带退避重试 + `→ pushing` 恢复边（经 `autonomy resume` 且 Git 状态核验）；`opening_pr` 幂等化（先 `gh pr view` 复用已存在 PR）；Task 8 文件清单补 `packages/loop/package.json` 依赖声明（否则 typecheck 必红） |
| Medium | Task 5/3 | R3 规则缺项：`.env` 正则匹配不到 `.env.local`（改 `/(^|\/)\.env(\..+)?$/`）；补 sql-DDL 内容规则、sudo、新增网络目的地启发式；**策略自改绕过**：目标仓库为 osstack 自身时 `packages/autonomy/src/risk.ts` 只算 R2——R3_PATH_RULES 增加对 risk/approval/state-machine 源文件的自我保护；repo policy 一律从 base commit 读取（`git show <base>:.osstack/repo.yaml`），防 worktree 篡改弱化校验 |
| Low | 多处 | `pr --create` 双轨提示；merge 后 smoke/conflict 新 worktree 等 spec 承诺在 C 阶段的有意降级需文档声明；每仓库单写锁提前到 C（migration 17 加部分唯一索引）；分支名 `git check-ref-format` 校验；kill 测试明确 SIGKILL |

### 2.4 Plan D（P5–P6 部署与运维）— 4 阻断 + 2 现实性

| 严重度 | 位置 | 问题与修订 |
|---|---|---|
| **High [阻断]** | Task 3/5 | **部署脚本供应链缺口**：policy 引用的 `tooling/health-prod.sh`/`rollback-prod.sh` 等是以 daemon 权限执行的任意代码，但修改它们不触发 R3——恶意 R1 级 PR 毒化回滚脚本后等下次部署引爆（rollback 是失败路径唯一安全网）。**修订**：解析 merged policy 中 command/verify/health/rollback 引用的仓库内路径，diff 触碰 → 强制 R3；eligibility 增加 `deploy_script_digests` 输入，与上次演练 digest 不一致 → deny（`deploy_script_changed_requires_drill`） |
| **High [阻断]** | Task 2/3 | **change-type 开放词表**：`allowed_change_types` 是自由字符串且无确定性推导器，任务可自称 `frontend-copy` 直通生产——还倒退于仓库现有 `PolicyChangeCategory` 的闭集纪律。**修订**：改封闭 enum；新增纯函数 `deriveChangeTypes(changedPaths, diffStats)` 表驱动测试；不可归类→不产出 type→deny；禁止 LLM 信号进入 |
| **High [阻断]** | Task 11.5（新增） | **通知通道缺失**（跨文档主题 4）。**修订**：新增任务——状态机进入 `awaiting_approval/escalated/deploy_frozen/rollback_failed/delivery_evidence_failed` 时向 `OSSTACK_NOTIFY_WEBHOOK_URL` POST 摘要（run id/repo/reason/审批命令，无 secrets/diff）；fake HTTP server 测试；通知失败不阻塞 run。Owner 现有 Telegram bot 基建可直接消费 webhook |
| **High [阻断]** | Task 7 | **freeze clear 可被同机 agent 冒充人类**（跨文档主题 3）。**修订**：freeze clear 与 R3 approve 同通道，要求 `process.stdin.isTTY` 交互确认，daemon socket 的 non-TTY clear 一律拒绝；governance 危险命令规则把 `osstack autonomy approve|reject|freeze clear` 列入 Builder/Reviewer 禁用命令并加测试 |
| Medium | Task 5 | 子进程 `env: {...process.env}` 全量透传（与自家证据脱敏纪律矛盾）——白名单 `PATH/HOME/LANG/TMPDIR` + policy 显式 `env_passthrough`（受 stricter-merge 约束）；注入 `FAKE_SECRET_TOKEN` 断言子进程不可见 |
| Medium | Task 3/12 | 回滚演练只有消费方无生产方——新增 `osstack autonomy drill rollback --repo ID`（真实执行 rollback+health，证据落 SQLite：时间/脚本 digest/结果）；eligibility 校验 drill ≤30 天且 digest 与当前脚本一致 |
| Medium | Task 2 | stricter-merge 四处未定义语义：overlay 整体省略 target（=repo 策略生效）；overlay 提供 command（=schema 错误 fail closed）；路径交集须前缀感知收窄；路径匹配一律段边界（`apps/web` 不匹配 `apps/website`，需显式反例测试） |
| Medium [现实性] | Task 9/10/13 | **macOS 睡眠未处理**：launchd KeepAlive 不阻止系统睡眠，7 天 soak 会被冻结。安装流程加 `sudo pmset -a sleep 0 autorestart 1` + `autonomy health` 报告 `pmset -g`；daemon 检测时钟跳变后按 network-recovery 路径重探测 |
| Medium [现实性] | Task 12 | **30 任务/7 天无供给计划**——soak 前置检查：预登记 ≥30 个带验收标准的真实 R1/R2 backlog（从两个真实仓库 TODO/issue 导入）；校验 prompt digest 互异且 workspace 非 fixtures 路径；供给不足时显式允许延长窗口 |
| Low | Task 2/7/10/13 | freeze_windows 的 IANA tz 校验 + 跨午夜语义；设计 §6.9 YAML 示例标注"v1 示意，以本 plan v2 schema 为准"；日志轮转与 proof 保留策略（否则自产日志触发自家 5GiB 磁盘刹车）；launchd 任务补 red 步骤与真机 `launchctl print` 验证记录 |

### 2.5 Plan E（P7 产品化发布）— 2 阻断

| 严重度 | 位置 | 问题与修订 |
|---|---|---|
| **High [阻断]** | Task 3/9 | **`packages/loop/src/publisher.ts` 的 `DEFAULT_COMMAND` 硬编码 Owner 外置存储绝对路径且随 npm 包发布**，完全在清洗范围之外（Task 3 只扫 config 默认值、Task 9 只扫 README/docs）。**修订**：`DEFAULT_COMMAND` 移除默认值，`enabled=true` 时 `command` 必填否则 fail closed；同步清理 `scripts/README.md` 的 Owner home 路径 |
| **High [阻断]** | Task 9 | **隐私 grep 目标错误**：使用零匹配的旧用户名会产生虚假绿灯。**修订**：由 Owner 在仓库外提供完整私有标识 pattern inventory；范围扩至 `packages/*/src` + 双语 README + docs + **npm pack 解包产物与单二进制 strings**；升级为 CI job（fail-closed 门禁）。仓库内不再复写具体私有标识 |
| Medium | Task 4 | Kimi"未安装"与"未登录"两态未区分——输出契约 `kimi_not_installed` vs `kimi_not_authenticated`；`config doctor` 三态展示；`isAvailable()` 升级三态判定，安装/doctor/运行期 fallback 三处复用 |
| Medium | Task 7/10 | 平台承诺超售：Linux 只有 fake binary 验证。释义强制平台矩阵：macOS=supported（soak 实证）/ Linux=experimental / Windows=unsupported；`config doctor` 非 macOS 给 Kimi 打 experimental 标 |
| Low | Task 3/6/8/9 | "default YAML/JSON"措辞改为序列化 `defaultConfig()` 与 template 落盘产物；agents build 不复制 .md（补 copy 脚本）；升级 smoke 补"新 CLI 验证旧 proof `ok=true`"；`README.zh.md` 入清单；Task 3/6/7/8 补先红步骤 |

### 2.6 各计划亮点（保留，勿在修订中丢失）

- **A**：快照设计覆盖 index-only 篡改；对 verifier 现有宽松点（missing judgments 放行、adapter 完成即通过）诊断精准；先抽取后改造 11,698 行 bin.ts 的顺序正确。
- **B**：所有代码级 gap 主张经核验为真（deliver 不解析 profile、`active_profile:auto` 执行路径短路）；proof 落点选在已存在且被 schema 校验的 `policy-decision.json`/`agent-runtime.json`；凭据边界纪律与不变量 15 严格对齐。
- **C**：LLM 信号在 risk.ts 输入层结构性不存在（非纪律性）；persisted-before-execute 有专门测试；candidate proof 失败禁 push 配有"fake runner 未被调用"强测试；包依赖方向无环。
- **D**：argv 数组 + `shell:false` 是对设计 shell-string 的实质升级；stricter-merge 被逐字段展开成表；soak 门禁可机读（checksum 报告 + `--require-productization` 只读 gate）。
- **E**：发布严格 gate 在 soak 证据之后；schema 16→17→18 链条与升级/回滚 E2E 咬合；所有 CLI/脚本引用无一悬空。

### 2.7 设计规格随动修订（3 处，非阻断）

1. §6.2 reviewer 只读隔离：补"快照必须覆盖 `.git/config`、`.git/hooks/**` 与 gitignored 路径"或改只读副本审查（对应 A-Critical）。
2. §6.9 YAML 示例标注"v1 示意，字段以 Plan D v2 schema（argv 数组）为准"。
3. §6.15/P6 产出清单：把"owner notification"落为 webhook 通知的明确交付物（对应 D-阻断 3）。

---

## 3. 修订执行顺序（给 Codex）

1. **第一批（安全阻断，~1.5 天）**：A-Critical（.git 快照/只读副本）→ C 四阻断（状态机边+两段审批、diff 权威三件套、`--match-head-commit`、branch protection fail-closed）→ D 四阻断（脚本 R3+digest、change-type 闭集、通知任务、freeze TTY）→ B-阻断 3（证据分级）。
2. **第二批（一致性阻断，~1 天）**：A（Task 9 doctor 文件+能力收敛、Hermes 契约、双层语料）→ B（legacy 快照+激活条件、Task 9 前插任务）→ E（publisher.ts、隐私 grep/CI）→ G-1 路径参数化全套替换。
3. **第三批（Medium/Low 随同批）**：按各表逐条落入对应任务文本。
4. 修订后跑总计划 v2 §10 自检命令（含新增隐私 pattern），然后进入你的再审计。

## 4. 对抗规则（给 Codex 再审计）

- 逐条证实或证伪本包全部 [阻断] 项：要么引用计划/代码原文证明审计误判，要么给出比建议更优的修订文字；禁止泛泛同意。
- 重点复核四个绕过链的封堵完整性：`.git hooks 写入 → Phase C commit 执行`、`untracked 新文件 → auto-merge`、`审批/证据 → commit/merge 的 TOCTOU`、`R1 PR 毒化 rollback 脚本 → 下次部署引爆`。
- 所有修订不得触碰 KD-01~08 决策与 Q 冻结项；若你认为某条修订实质改变了架构决策，单列出来交 Owner 裁决，不要静默吸收。
- 五个审计 agent 的完整报告可按需向 Owner 索取；本包已保留全部 Critical/High 与关键 Medium 的完整上下文。
