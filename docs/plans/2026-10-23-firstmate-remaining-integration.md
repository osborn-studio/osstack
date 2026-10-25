# Firstmate 剩余 S3 与产品集成实施方案

本报告只做方案，未改生产代码。基线：`/Users/osborn/Developer/CodeX/.worktrees/osstack/pr237-main`，PR #237 整合 `main d2bc09e5` 的工作树；主代理仍在修审计问题，因此后续实施必须重新固定最终提交。依据能力状态表、原设计/计划及以下实际函数。不是将 24 项研究地图解释成 24 项全部交付承诺，也不把离线 helper 解释成运行时集成。

## 1. 明确目前欠缺的连接

| 能力 | 已有真实实现 | 缺口 |
|---|---|---|
| 单一 Cockpit | `attention-command.ts` 的 `handleAttentionCommand` 将 inventory/inbox/brief/deliveries 四个 RPC 依次拼起来 | 主入口 `bin.ts:handleDashboardCommand`、`handleCockpitTuiCommand` 使用 `dashboard.snapshot`；`dashboard.ts:createDashboardSnapshot` 和 `cockpit-tui.ts:cockpitTuiModel` 尚无 Attention 区块，四次读取也不是原子快照 |
| scout / implement | `supervisor/src/attention-planning.ts:deliveryContract/promoteScout/verifyDeliveryContract` | 只由 `cli/src/attention-planning-command.ts:handleAttentionPlanning` 读取外部 JSON；实际 `deliver-command.ts:handleDeliverCommand`、`autonomy/src/engine.ts:GuardedDeliveryEngine`、`cli/src/graph-delivery.ts:GraphDelivery` 未受该契约约束 |
| 统一完成标准 | helper 检查传入 digest/head/passed/reviewed/completion | `passed` 和 `reviewed` 目前是调用者提供的数据，不是验证器证明；单个 `head` 同时代表起点和交付终点也不能适配实际实现提交 |
| 可选分诊 | `acceptAttentionTriage` 允许三种分类，非法输入回退 | CLI 只是读取用户提供的模型输出；没有真实受限调用、预算预留、取消、使用量回执和源版本绑定 |
| 轻量路由 | `evaluateAttentionRouting` 统计外部输入的 route/token 数据 | 没有冻结 golden、真实成对执行、可复现数据分割与策略启用门禁；不能声称准确率或成本收益 |
| 上下文/lesson | `budgetAttentionContext` 做 UTF-8 限额；lesson helper 写新草稿 | 没有连接真实 AgentTask 构造；知识检索和 Loop trace 目前不能当作已注入模型。lesson 未从可信结果回执自动采集、缺少稳定身份与治理来源绑定 |

## 2. 共同约束与可交付口径

1. 以 PR #237 最终通过提交为共同父提交；先完成它的全测试、Haiku 审计与可合并状态，再开始本方案的生产修改。后续 PR 可以依赖 #237 的分支，但不得声称已上线主线。
2. 每项要有真实入口闭环：用户命令 → 受控读取/执行 → 可信来源 → 可见结果 → 有界失败。只有单元函数或 schema 的任务状态应叫“基础完成”，不能叫“能力完成”。
3. 统一的 host 身份、scope、source version、未知回执、权限与审批继续来自现有账本。模型解释不能改变 `attention_items.state`、grant、签名 approval、CI required checks、Graph lease 或 publish 权限。
4. 新模型调用默认关闭；用户明确配置模型/预算后才允许运行。用户指定模型不存在或认证失败时给出准确错误，不静默替换其他模型。
5. 日志输出只保留受控文本/证据摘要；本地 home 绝不默认指向生产。开发和实测 home 放统一 scratch root。敏感内容不自动提交到 PR。
6. `core` 不依赖 `supervisor`。后者已依赖 `core`、`loop`、`governance`，把它引入底层会造成循环。公共纯契约放 `protocol` 或 `core` 叶子模块，宿主装配保持 lazy；新增公共导出先测载入耗时。
7. “可合并”需要测试、独立审计和 GitHub 必要检查；“发布/部署”单独遵循既有授权，完成设计或本地验证不等于部署。

## 3. A：统一 Cockpit 和 daily 主入口

### A1：单次一致快照与主控制台（首个可交付）

**改动落点**：新增 `cli/src/attention-dashboard.ts` 纯读取模块与测试；扩展 `dashboard.ts` 的 `DashboardSnapshotOptions` / `DashboardSnapshot` / `createDashboardSnapshot`；在 `daemon.ts` 的 `dashboard.snapshot` 分支传入服务状态；`cockpit-tui.ts:cockpitTuiModel`、`renderCockpitFullscreen`；协议若新增公共 schema 则置 `protocol/src/attention.ts`。主代理集中修改 `daemon.ts` 和 `bin.ts`，子代理交付独立模块。

**接口**：`attention: { status: disabled|unavailable|available, sampled_at_ms, generation?, scope_filter, totals, scopes, next_after, truncated, limitations }`。单 scope 行含 scope_id/task_id/repo、coverage 原因、业务未决数量、unknown receipts、uncovered subjects、通知死信数、最近成功 scan 时间。只列存在且已绑定的 scope；明确 canonical workspace 过滤，不能把别的仓库 scope 计进“当前仓库无待办”。没有显式 actor 时只显示事实总数，不返回 actor 简报/已读数据。

单次只读 SQLite 事务计算 scope 行和总数；不在事务中访问 GitHub、启动 watcher、调用模型或文件扫描。一次最多 100 scope、每 scope 展示前三项；总数不能由页面行数推导。已停用 observer 仍可展示历史事实，但 coverage 必须 unavailable/stale；旧 schema 且无 Attention 表时返回 unavailable，不迁移、不抛整个控制台错误。

主入口显示“待你处理 / 系统等待 / 来源不确定 / 未监控 / 通知失败”。`answered`、`applied`、任务完成保持不同概念。每个操作是带明确 scope/item/version 的结构化下一步，TUI 默认选择只输出命令；既有 `bin.ts:executeCockpitTuiAction` 支持显式 `--execute-action`，新增 Attention 动作只能经过同一受控 CLI/RPC 与 source version 校验，不能因来自快照而视为授权。A1 先只提供查询/打开动作，不把 answer/abandon 自动加入可执行 action 列表。Web 对不可信说明做 HTML 转义，终端去控制字节，不拼可执行 shell。保留既有 cockpit/dashboard 别名兼容。

**反例验收**：多个 repo 同名任务不混；全量 101 scopes 截断有总数；并发更新不会产生“一半新一半旧”关联状态；service disabled 不显示 0 待办伪健康；observer 过期但 timer 活着显示降级；unknown action 不显示“点击重试”；quiet 不隐藏未决；Web XSS/TUI ANSI 内容只作文本；80×24 终端不会把高风险警告裁掉。

**性能**：索引读取目标 RPC p95 <10ms，100 scopes/100 subjects/1000 items 固定数据测试；超预算先 query plan/分页，不能放宽 source 校验。`--help` 和 `--version` 按仓库预算复测。

### A2：daily 与增量反馈

`daily-command.ts:DailyBrief/runDailyBrief/deriveOwnerDecisions/renderDailyMarkdown` 接受同一 Attention summary provider；默认不隐式启动 daemon，不为 daily 增加模型调用。选择显式 scopes + actor 后才产生增量 brief；读取不调用 `seen`。daily 出现源错误时保留上一条观测时间与 error，不能报告“全部清空”。

验收：daily 离线可生成剩余已有内容；attention 超时不挂起其它内容；一次读取不会改变已读、posture、grant；同一未决不重复生成多个 owner decision。此 PR 依赖 A1 接口，可以独立开发 daily 适配器。

## 4. B：交付契约真正进入 delivery / autonomy / Graph

### B0：契约 V2 与可信证据边界

新增 `protocol/src/delivery-contract.ts`，纯规范化/摘要逻辑建议 `core/src/delivery-contract.ts`。现有 helper 保留 V1 兼容与明确“离线输入校验”标记；不要无声把 V1 输入当运行时批准。

建议 V2：`schema_version, contract_id, parent_contract_id?, task_id, canonical_repo, mode, base_head, goal, required_checks[{id,registry_ref}], review_policy_ref, requested_completion, allowed_paths, requested_actions, budget_ref, policy_digest`。digest 覆盖规范化后的完整值，required_checks ID 唯一。`base_head` 为入场基线；`candidate_head` / `tree_digest` / `diff_digest` 出现在 host 写入的 evidence binding 中。实现通常产生新提交，不能要求最终 HEAD 等于起始 HEAD。

运行记录：`contract_digest, run_id, run_kind, candidate_identity, policy_digest, verification_receipt_refs, review_receipt_ref?, publication_receipt_refs, achieved_completion, status`。存储优先扩展现有 autonomy context 的严格 schema 和 Graph 输入/证明绑定；只有需要跨 run 查询契约血缘时再加独立 `delivery_contracts` / `delivery_contract_runs` 表。若新增迁移，由单独集成负责人分配最终编号，禁止并行代理各写相同 migration ID。

**权威验证**：`verifyDeliveryContract` 的布尔 `reviewed` 不进入生产通过条件。逐项加载 host 的 receipt，核对 run、candidate、命令注册 ID、执行结果、独立评审身份、policy digest 与完成阶段；拒绝用户 JSON 声称的 passed。验证命令来自已接受的 CLI/policy 配置；contract 中的外来文本不是 shell 执行授权。

### B1：guarded-local / guarded-git 最小运行集成

`deliver-command.ts:handleDeliverCommand` 增加 `--contract FILE`，先解析/绑定 workspace/base head、派生 effective options、打印同 digest brief，再创建执行记录。CLI 参数与 contract 冲突应失败而非最后覆盖；较严格组织策略与 contract 取并集，不能通过 contract 降低必需检查。`DeliverCommandDeps.startGuardedGit` 显式携带 frozen contract。

`autonomy/src/engine.ts:GuardedDeliveryContextSchema` 保存版本化 contract；`GuardedDeliveryEngine.runLocalAndClassify` / `writeCandidateAndDeliver` / `writeFinalAndComplete` 在对应阶段验证绑定回执。旧 run 没有 contract 仍使用旧逻辑，报告 legacy；不能在恢复时从当前 CLI 偷换 contract。`local_verified` 终止于本地 proof；`pr_opened` 不继续自动 merge；`merged/deployed` 仍需要现有风险与签名批准。

**scout 最小范围**：先支持受限无工具调查材料生成/校验，不将普通 code executor 当只读模型。scout 只可 `local_verified`，禁用 `--execute`、写入型 adapter、push/merge/deploy ports；若无法证明 adapter 无写工具，则拒绝 scout 执行。产出是研究报告及证据，不能标成代码交付。`promote` 是显式创建新 implement contract，与旧 contract 建父子引用；重新绑定当前 base_head 和重新做 risk admission，不能继承 scout 的“通过”或 approval nonce。允许重试创建时用 request ID 幂等，避免重复 promotion 生成多个兄弟契约。

**反例验收**：contract 换 repo/head/check；在运行中替换文件；恢复跨版本；CLI `--verify` 删除必需项；review 自证；scout 混入发布 action；旧 scout 证据套给 implement；只承诺 PR 却到 merge；用户指定 model 被 availability fallback；动作失败未知时再起新 contract 绕过回执。所有案例 fail closed，且不能消耗错误 scope 的授权。

### B2：Graph 完成证明连接（必须独立 PR）

落点 `cli/src/graph-delivery.ts:GraphDeliveryOptions/GraphDelivery.run/evaluate/binding`、`graph-delivery-receipts.ts:publishDeliveryReceipt/loadDeliveryReceipt`、`graph/src/templates/code-delivery-v1.ts:deliveryEpoch` 及真实 graph spec/compiler/host 请求类型。对已有 `specHash`、run identity、candidate epoch、lease 的绑定做增量，将 contract digest 纳入 host input identity；**不修改已发布 registry/template 同版本的含义**，若语义变更需新版本和兼容 reader。

Graph 的 candidate_ready 是本地候选证明，不等于 GitHub PR/merge/deploy。高层 contract 按各阶段 receipt 聚合 `achieved_completion`；Graph 本体不得凭一个 `completion=merged` 字段自行得到 publish capability。重跑 candidate epoch 后旧 checks/review 不能转移；只有同 candidate 证据可完成。新 contract 不绕过 budget/lease/approval。

测试重点：模板 hash 变化检测；旧 graph run 恢复保持 legacy；新 candidate/新 epoch 不复用旧 receipt；外部伪造 contract digest 不覆盖 host reservation；Graph failed/cancelled/unknown 不被标完成。B2 在 B0 schema 冻结后可与 B1 分开实现，最后集中接 CLI 装配。

## 5. C：真实的受限分诊调用

### C1：无工具 provider 与一轮显式分诊

新增 `cli/src/attention-triage.ts` service、`agents` 或现有受限会话层的窄 provider 封装，复用 `agents/src/controlled-session.ts:ControlledSessionAdapter` 的 SDK 固定 tools/settings/MCP/环境约束，禁止直接使用会话通用 `invoke` 的任意 adapter。该 adapter 当前是 session 持久化模式，应增加专用一次性接口或限定独立 runtime 生命周期；不能共用可恢复主会话，否则污染主对话或引入工具权限。

输入：`scope_id, item_id, item_revision, source_hash, deterministic_category, bounded_question_excerpt, schema_version`。输出：`category: human_decision|system_wait|source_uncertain, explanation<=500`，严格拒绝额外字段。模型建议仅为 `advisory`；真实类别/等待责任/风险审批仍以确定性字段为准。即使模型输出 system_wait 也不能隐藏 human approval；每条解释标注 model/policy fingerprint、input digest 与时间。

接口初版 `attention triage --scope ... --item ... --model ...`，显式配置开关后可使用；线上 read-only query 不同步阻塞等待模型。建议每 scope 每小时最多 5 次、全 daemon 同时 1 次、输入≤8KiB、输出≤2KiB、单次≤20s、maxTurns=1，全部参数须有有限上界。初版只主动调用，自动事件分诊在预算可证明后单独开关。

### C2：预算、缓存与故障恢复

若跨重启预算需要可靠，新增小的 `attention_triage_attempts`：attempt_id、scope/item/revision/input_digest、model_id/policy_fingerprint、budget_window、reserved_at、status、usage/result_digest。预留预算事务先于网络调用；失败和超时也算一次尝试；崩溃后的 reserved/started 标 unknown，不返还额度或自动重新发起。唯一缓存 key 包含 item revision/source hash/model policy；源变后结果标 stale，不覆盖新来源。

完成后只写解释记录，不能修改 item.state 或调用 answer/resume/approve/merge。预算耗尽、credentials 缺失、provider error、超时、无 usage、JSON 错误全部回到确定性结果，并显示明确 reason。provider init 未验证 tools=[]/MCP=[]/model exact 时立即拒绝。模型实体由请求和 provider 返回标识记录，不声称独立验证模型权重。

**反例验收**：并发两次只占允许额度；重启不能重置预算；恶意问答注入“调用工具/删除状态”无动作；有效 JSON 多一个 command 字段拒绝；超时后晚到响应不更新 revision；model unavailable 不改用默认；unknown receipt 不被模型判断为“已答”；数据库失败导致预算不明时不调用模型。

**性能**：默认关闭时零 provider 初始化/零模型调用；分诊在独立队列，observer tick 和 RPC 查询不等待；memory/output bound 经实测。用户指定 Haiku 5.5 适合这条工作流的测试和审计，但运行时模型选择仍来自显式配置。

## 6. D：路由 golden 与成对真实评估

落点现有 `supervisor/src/attention-planning.ts:evaluateAttentionRouting`；真正执行路由是 `core/src/orchestrator/router.ts:routeCapability`，产品 profile 在 `cli/src/loop-profile-routing.ts:resolveLoopProfileRouting`，推荐提示 `stack-routing.ts:recommendRouting`。这三者职责不同，评估不得把提示推荐当真实模型调度。

新增 `supervisor/src/routing-evaluation.ts` 及 `fixtures/routing-golden-v1.jsonl`，新 CLI runner 独立 `attention routing-eval --dataset ... --run --model ... --output ...`。离线既有 `--input` 聚合保留，但报告明确来源 `supplied_predictions`；真实执行来源 `recorded_provider_runs`。

golden case：`case_id, split, intent, prompt_fixture_ref, expected_capability_kind, required_role, independent_review_required, risk_flags, forbidden_downgrades, expected_override?`；保存 label rationale、dataset hash 与版本。先建设约 60 条开发集+约 40 条封闭 holdout，覆盖调查/实现/只审计/迁移/UI/部署/模糊任务/显式 agent override/审批诱导；这只是第一版资格样本，不是总体准确率证明。任务类别和安全关键子集都分层汇报，禁止只报总平均。

每 case 两个输入 arm：只任务意图、完整 prompt；相同 model/policy/budget，随机或交错执行次序，记录 prompt digest、原始输出、parse errors、usage 是否测得、延迟、fallback、review 漏失/不必要升级。tokens 缺失标 unknown，不填 0。数据生成/标签阶段不得用待测模型的输出当真值；holdout 不调参、不用 eval 提示泄露 expected。

严格 validate：重复 case ID、空集、非法 route、负/NaN tokens、被污染 split、缺 case 结果、未完成 arm 全部使结果 incomplete。报告同时保留 denominator、失败数、精确路由匹配、允许兼容路由、review 漏失；不得把超时 case 从分母删除。

**启用门禁**：这批只交付 benchmark/shadow，不改默认路由。后续策略启用独立 PR，要求 holdout 安全关键子集零已知漏 review、全部显式 override honored、成本与延迟收益有可重复测量，至少两个独立重复批次，并由策略配置显式选用。出现任何安全降级维持 disabled。

**反例验收**：prompt 中“忽略 review”不得弱化 required_role；配置 unavailable exact agent 必须沿用 `AgentOverrideError` fail closed；把错误结果复制到另一 case/input hash 不能算通过；断点续跑只重做已证明未调用项，其余记 unknown；预算达到上限不会继续循环。

## 7. E：context 连接实际 prompt 与治理

现有 `budgetAttentionContext` 对任意 entries 排序，但没有检索来源与 payload integrity；`knowledge/src/pack.ts:resolveKnowledgeSearch/retrieveKnowledge/assembleKnowledgeSnippet` 已有来源元数据，`cli/src/bin.ts:createKnowledgeProofEvidence` 是证明采集；`loop-engine.ts` 的 knowledge 只记录 trace/event，不足以证明内容进入 AgentTask.prompt。

新增 `core` 或 `knowledge` 的纯 `context-budget.ts` 与 `cli/src/execution-context.ts` 宿主装配。先实现一条真实路径：guarded-local deliver → 完成授权/契约选定 → 检索显式配置的 local knowledge pack → 预算组装 → 真正发出的 AgentTask.prompt → proof 同 digest 记录。再扩到 Graph writer/reviewer，独立 PR。

规范 entry：`id, source_kind, source_ref, source_digest, scope, tier, text, verified_at, expires_at?, evidence_kind`。instruction/contract/safety mandatory 单独来源，不接受知识正文把自己标为 required。mandatory 不能因 expired 自动消失；过期或超限必须阻断执行并显示 required_omitted。未决 action/decision 继续保存在源账本，不能当过期记忆裁掉。可选知识才按新鲜度与预算淘汰。

完整 rendered prompt（分隔符/引用元数据/转义开销都算）验 UTF-8 bytes；若模型 token window 是准入条件，必须使用被声明的 tokenizer 或保守上界并标 estimate，不能把 bytes 当 tokens。建议初始可选知识预算 8KiB/总上下文配置硬上限，留足模型回答空间；没有可信 model window 时不宣称不超窗口。

未信任检索材料用独立区块和 provenance 明示为资料，不成为权限指令。验证包 digest/pin/检索 stale 状态；拒绝跨 repo/operator 私有 scope。只扫描显式来源路径，复用 `governance/.../instruction-source.ts:inspectInstructionSource` 的 source 检查，不自行覆盖 AGENTS.md。`knowledge-hygiene/rules/budget-rule.ts:BUDGET_RULES_V1` 的静态预算建议与运行预算需要统一单位定义，但静态规则通过不能代替最终 prompt 限额。

**反例验收**：中文/emoji 与包装字节实际超限；同名 ID 不同来源冲突；恶意 source 自称 required；未来 verified_at；内容 hash 改变；过期必须说明；mandatory 不能静默遗漏；跨 tenant/repo pack 被拒；模型实际接收的字符串 digest 等于 proof；plain knowledge trace 但无注入不能标 used。

## 8. F：从执行证据生成 lesson draft，并连接现有审核

`loop/src/lesson-draft.ts:renderLessonDraft/writeLessonDraft/listLessonDrafts/promoteLessonDraft` 已有草稿生命周期；`core/src/state/lessons.ts:upsertPitfallLesson` 是 pitfall 库；两者不能无声合并或自动把草稿变成有效知识。现有 `attention-planning-command.ts` lesson 只是用户 JSON → 新文件，没有证明其确实发生过。

新增 `cli/src/attention-lesson.ts`：显式 `attention lesson --from-run RUN --repo ...` 从同 scope 的可信 run/verification evidence 构造 `LessonDraftInput`，禁止相信输入 self-reported finalVerdict。只有“之前 verifier 真实失败，之后同任务经验证恢复”才用 success-after-repair 模板；unknown 或未完成只能生成明确的 investigation draft，不能写 success 文案。记录 run/contract/candidate/check/source hashes，引用证据路径；摘要不复制密钥、完整私有 transcript。

稳定草稿键由 scope/task/失败族/最终 proof digest 得出；create-only、同键同内容幂等、冲突另建修订引用，不覆盖现有用户编辑。目录路径必须 realpath confined，拒绝 drafts/promoted symlink 越界；输出目录按 repo 配置确定。初版事件触发只排 pending draft suggestion，用户显式命令才能写 repo；如果未来默认自动生成，要独立选择开关和容量/保留策略。

审核继续使用现有 `loop lessons show/promote/discard`，向 guide 明确显式 promote 可改 skill，新增 bridge 不自动调用 promote，不自动发布 Knowledge Cloud。支持调用现有 knowledge publish validation 输出可发布性报告；验证通过也不是发布动作。draft 变更通过仓库正常 PR 审核保留证据来源。

**反例验收**：缺 final receipt/未知 action 不写成功课题；伪造 run_id/repo 不跨读；用户编辑草稿不被覆盖；重复事件仅一个 draft；磁盘失败无半成品；symlink 指到 AGENTS/skill 不写；draft source 过期展示复核，不自动移除；pitfall observation_count 增长不标 effectiveness verified。

## 9. 可并行 PR 拆分与交接规则

| PR | 范围 | 依赖 | 并行所有权/不得触碰 |
|---|---|---|---|
| P1 | A1 原子 Attention dashboard summary + TUI/Web | #237 | dashboard/attention-dashboard/cockpit-tui；主代理装配 daemon/bin |
| P2 | B0 contract V2/规范化/可信 evidence schema | #237 | protocol delivery-contract/core leaf；不改 autonomy |
| P3 | C1/C2 受限分诊 provider、预算、CLI | #237；schema 接口先定 | 新 attention-triage 模块；迁移由主代理集中分配 |
| P4 | D golden 数据/runner/shadow 报告 | #237 | routing-evaluation + fixtures；不改默认 router |
| P5 | E local knowledge → 实际 prompt + proof | #237；B0 输入绑定定稿 | 新 context 模块/knowledge；deliver 装配由主代理 |
| P6 | F evidence → lesson draft + review bridge | #237 | 新 attention-lesson/lesson 安全 IO；不改共享命令总入口 |
| P7 | A2 daily 统一 | P1 | daily-command/测试 |
| P8 | B1 guarded-local/scout/promote | P2 | deliver/autonomy，独占修改 |
| P9 | B1 guarded-git 完成级别/恢复 | P8 | autonomy + proof，避免与 P8 同时编辑 |
| P10 | B2 Graph 绑定/候选证明 | P2 | graph-delivery/receipts/template-version，独占 |
| P11 | E Graph writer/reviewer context | P5+P10 | Graph prompt 单一路径 |
| P12 | 产品入口/完整回归/文档与性能资格 | P1–P11 | 主代理集成收口 |

四个实际并发槽位包括主代理；建议首波三个子代理 P1/P2/P4，主代理负责 #237 收口和接口审查；次波 P3/P5/P6；后续 P7/P8/P10，再串行 P9/P11/P12。不是无限增开代理；重叠文件、数据库迁移和公共入口必须串行。每个代理提交独立 worktree、commit、测试摘要、已知限制；不互相直接修改共享工作树。

OSStack 管理任务建议以本表 PR 为父 task，下分 contract/schema、实现、反例、性能、审计、文档六种验收项，任务 artifact 包含 baseline SHA、source hash、命令退出码、测试数量、audit request/result model、独立证据引用。完成状态由真实命令回执推进，不能提交一份计划就把实现任务标 verified。

## 10. 每个 PR 的 Haiku 审计与集成验收

1. 冻结该 PR 实际 diff、依赖接口与威胁/反例表；Claude Code CLI 固定请求 `claude-haiku-5-5`，无工具/无 hooks/MCP、独立 scratch config、读取 stdin context、输出 JSON 及 stderr。模型不可用如实阻断该审计资格，不改名或虚构通过。
2. 审计提示要求找可复现行为与文件/函数；重点攻击 scope/actor/未知回执、contract 证据伪造、模型权限逃逸、预算并发/重启、source 注入/过期和新增入口旁路。保存原始结果及 request model / response modelUsage。
3. P0/P1 必须修复并用失败→通过的反例测试证明；每次实质修复重新给审计器看最终 diff。P2 是否接受需说明用户影响和落点；不把模型“无发现”当测试通过。
4. 定向 package 测试 → 完整 `pnpm build/typecheck/test` → 实际 lint/schema freshness/changeset coverage/CLI startup → 干净 worktree smoke。新上下文/分诊需真实 provider 最小运行资格；无凭证时保留禁用状态、报告未验证，不能假装已完成真实集成。
5. 保留 no-new-permissions/no-side-effects 的零调用探针，最终审查 main 漂移。PR 标 ready 之后删除对应临时 worktree；不自动 merge/deploy。

## 11. 本方案不宣称已覆盖的其它 Firstmate 工作

远程 home、可见终端 worker、公共 Relay、通用扩展握手、多 home 更新收敛仍须独立设计（身份/传输/隔离/断连与恢复）。本方案完成后，能力 #1/#12/#13/#20/#21 会从 helper 进一步变为产品路径；#7 为确定性监督附加有限解释；它不承诺模型常驻 supervisor 或上游所有后端等价。对外能力表应逐项更新真实入口和资格，不能把 PR 数量换算成“24 项全完成”。
