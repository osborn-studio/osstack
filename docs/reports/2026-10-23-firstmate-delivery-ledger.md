# Firstmate 24 项能力交付账本（本地开发与验收结果）

> 历史阶段快照，保留当时的实现与验证边界。后续剩余代码、实际入口和最新验收状态见[24 项能力收口账本](2026-10-24-firstmate-capability-completion-ledger.md)。

本地资格更新至2026-10-23 14:34 PDT；第六批真实入口已提交为PR#243。远端检查与Ready状态请查看各PR的实时Checks。**这是已提交代码与已有证据的盘点，不是“24/24 完成”、合并、部署或生产环境验收声明。** 最初的“仅完成研究材料”已不再反映当前开发量；相反，旧状态表的“8 本地实现、12 部分、4 未实施”也不能直接当成今天的完成比例。以下逐项取代那份表的进度描述，保留其历史记录。

本次只读核对已有提交、报告、原始验证摘要及 GitHub 元数据，没有运行新全量测试，没有修改生产代码或主工作区。分支仍在推进；后续提交必须补自己的 exact-head 资格，不能继承本账本的快照结论。

## 1. 口径与证据范围

原始编号严格沿用[深度分析的 24 项能力地图](2026-10-23-firstmate-analysis.md#3-能力地图哪些值得拿如何拿)。它不是 24 个等大小任务，也不同于最初 26 个实施条目、Loop 队列任务或当前 PR 数量。方案来源是[主计划](../plans/2026-10-23-firstmate-remaining-master.md)、[产品集成](../plans/2026-10-23-firstmate-remaining-integration.md)、[可靠性](../plans/2026-10-23-firstmate-remaining-reliability.md)和[扩展计划](../plans/2026-10-23-firstmate-remaining-extensions.md)。

- **范围内实现**：约定的本地来源、租户和执行后端有实际代码入口与对应测试；仍不代表上游所有后端等价覆盖。
- **部分实现**：已有生产调用路径，但能力族仍有未支持的来源、动作、后端或真实环境资格。
- **组件已提交，待集成**：有模块/handler 与定向测试，中央入口、整批验收或外部环境尚未完成；不把 helper 当作完整产品交付。
- **待资格**：路径存在，但现有证据仅为注入式 adapter、假 transport、本地子进程或静态审计；不能外推成真实服务能力。

源码快照包含：#237 `2d33db37`、#238 `6703ceb7`、#239 `7912b5de`、#240 `56f38caa`、#241 `1e84776a`；#242 初始 PR head `7e5a84d7`，盘点时分支已追加 inventory 修复 `7e5e7f10`。Wave 6 已提交组件包括 viewer `26650bc4`、sources `3c7e6f94`、Graph 后续修复 `f0157f51`、O2a `6c5f598d`（原组件 `02f980ba`）和 U2a `14574347`（原组件 `52df9cf2`）；中央接线已提交 c48e29a9，root审计证据 c5cd37ee；Graph原始内容修复已回补#242的317c2070与#243的bfe13252，#242全量5204通过/3跳过，#243全量5388通过/3跳过，均22包、8项检查全部成功。这些不是单一已经合并到 main 的版本。

本文“真实入口”指已有 daemon/bin 路由或实际调用链，不意味着真实模型、真实远端账户或真实发布已验证。特别区分：真实 Git/SQLite/socket 可以与注入式模型 adapter 同时出现在一个测试里。

## 2. PR 与整批验收账本

GitHub 读取时，**#237–243 全部未合并**。#237–241 已退出 draft且各自最终head CI成功；#242–243最终本地资格已通过；远端检查/Ready状态以各PR实时栏为准。GitHub 的 `mergeable:true` 只说明当时没有内容冲突，不等于批准、检查或合并条件全部满足。独立批准仍是合并门槛；本任务没有自动合并或部署。

| PR / 批次 | 已提交的主要结果 | 已有验收与当前缺口 |
|---|---|---|
| [#237](https://github.com/osborn-studio/osstack/pull/237)，监督基础 | Attention 40–41；inbox、等待分类、手动 answer、handoff、quiet/away、通知；整合 main，9 处冲突解决 | 本地 22 包资格记录 4,645 passed / 3 既有 skip；Loop 高争用失败保留并由注明预算的重跑处置；[exact-head CI 40000751879](https://github.com/osborn-studio/osstack/actions/runs/40000751879) 成功。ready，未合并。见[整合报告](2026-10-24-firstmate-main-integration.md)、[最终资格](2026-10-23-firstmate-pr237-final-qualification/README.md)。 |
| [#238](https://github.com/osborn-studio/osstack/pull/238)，Wave 1 | 主 Cockpit/Web/TUI 摘要、监督单飞与停止围栏、通知批处理、真实确定性 router golden | 4,727 passed / 3 skip；八项本地检查与原生资格任务成功；[CI 40007668124](https://github.com/osborn-studio/osstack/actions/runs/40007668124) 成功。ready，依赖 #237。见[证据](2026-10-23-firstmate-wave1-evidence/README.md)、[最终资格](2026-10-23-firstmate-pr238-final-qualification/README.md)。 |
| [#239](https://github.com/osborn-studio/osstack/pull/239)，Wave 2 | migration 42 run retained-event 补读；worker list/inspect；手动及计划 daily 的同范围摘要 | 4,831 passed / 3 skip；八项本地检查和原生最终资格成功；[CI 40013306809](https://github.com/osborn-studio/osstack/actions/runs/40013306809) 成功。ready，依赖 #238。见[证据](2026-10-23-firstmate-wave2-evidence/README.md)、[最终资格](2026-10-23-firstmate-pr239-final-qualification/README.md)。 |
| [#240](https://github.com/osborn-studio/osstack/pull/240)，Wave 3 | guarded-local/git V2 契约、实际 prompt receipt、home 盘点、证据 lesson draft | 源码冻结 `db16ec1a`；文档记录 head `a48ccce0`；八项检查，4,974 passed / 3 skip，原生 verifier 零问题。head `56f38caa` 的 [CI 40021432140](https://github.com/osborn-studio/osstack/actions/runs/40021432140) 成功，PR ready。见[报告](2026-10-23-firstmate-wave3-integration.md)、[最终资格](2026-10-23-firstmate-pr240-final-qualification/)。 |
| [#241](https://github.com/osborn-studio/osstack/pull/241)，Wave 4 | migration 43 持久分诊预算/隔离；44 本地 obligation；真实 daemon/CLI 接线 | `580bd9df` 的八项检查通过，5,064 passed / 3 skip，原生 verifier 零问题；初次 fixture 失败及 133 项修复回归保留。head `1e84776a` 的 [CI 40021647919](https://github.com/osborn-studio/osstack/actions/runs/40021647919) 成功，PR ready。见[报告](2026-10-23-firstmate-wave4-integration.md)、[最终资格](2026-10-23-firstmate-pr241-final-qualification/)。 |
| [#242](https://github.com/osborn-studio/osstack/pull/242)，Wave 5 | Graph 契约/context 实际宿主接线；固定 SSH 只读导出；公平扫描、recovery | 初始 head `7e5a84d7` 的 [CI 40022366557](https://github.com/osborn-studio/osstack/actions/runs/40022366557) **失败**，不能写成已通过。后续 `7e5e7f10` 修复遗漏的 export inventory；主线程又确认 Git stat 缓存会漏掉冻结前修改，raw-blob比较已修复并回补317c2070；第四轮root Haiku确认无剩余P0/P1。最终本地8项全通过，5204passed/3skip；远端最终文档head17dd4320的CI见PR实时Checks。见[报告](2026-10-23-firstmate-wave5-integration.md)。 |
| [#243](https://github.com/osborn-studio/osstack/pull/243)，Wave 6 | viewer V2、R3 本地来源、O2a 授权投递账本与 U2a 升级 plan/journal 组件已提交；native apply 待资格 | 中央接线已提交；实际CLI/daemon/socket回归通过，两组root静态审计无确认P0/P1；首次全量仅旧schema44断言失败，61579141修正后最终全量5388passed/3skip、8项全通过；原失败保留。远端状态见PR实时Checks。组件细节见第4节。 |

以上整批测试数对应不同源码快照，不能相加成“本项目新增测试总数”，也不能拿较早通过结果覆盖较新修复。研究阶段的 81 条上游断言和 216 个 Shell 语法检查只证明当时选定的 Firstmate 测试与语法，不是 OSStack 生产实现验收。

## 3. 原 24 项能力逐项映射

| # / 原能力 | 当前实现与真实入口 | 提交、测试与审计证据 | 仍未完成或不能外推的部分 |
|---|---|---|---|
| 1 单一用户联络入口 | **部分实现，已接主入口。** `readAttentionDashboard` → `dashboard.ts` / `cockpit-tui.ts`；`daily-attention.ts` → manual/scheduled daily；`dashboard.snapshot` 使用 canonical workspace/default tenant，相同过滤下给出行与总数。 | #238 Cockpit 真实浏览器分页、注入、offline 检查；#239 实际 daily/daemon 接线。`packages/cli/src/attention-dashboard.ts`、`daily-attention.ts`。 | 主摘要、执行、回答、Graph、follow-up 仍是明确不同入口；没有新增一个可越过既有授权的“全权主 Agent”。 |
| 2 busy/idle/unknown/dead 语义 | **部分实现。** Attention 分类将业务等待、来源新鲜度和活性分开；worker 只读视图持续标记 `process_liveness:unknown`。disabled/not_watched/stale 不用健康的零待办代替。 | #237 `packages/core/src/attention.ts` 与状态投影；#238 主摘要；#239 worker views；#242 recovery。各自来源/未知/过期反例。 | 未实现所有 backend 的可靠进程存活检测；终端存在、无输出、timeout、stop 返回均不能证明执行已停止或成功。 |
| 3 旧实例事件隔离 | **本地 Attention 范围内实现。** `AttentionStore` 的 owner generation、scope/source binding、版本围栏；service stop 后拒绝迟到投影写入。 | #237 owner/CAS 来源测试；#238 单飞、deadline、stop/DB close 竞态；#239 run 游标绑定；#242 Graph effect/epoch 是独立边界。 | 不能将本地围栏等价外推到未资格的远程 provider；Graph新修复已通过最终本地全量与第四轮窄审计。 |
| 4 等待责任与解除条件 | **约定源范围内实现。** grant、人工决定、审批、在途/未知消息各有责任与解除条件；普通回答不会成为签名审批。主 Cockpit/daily 显示等待与人工决定。 | #237 等待/answer 测试；#238–239 同范围摘要测试。`attention-actions.ts`、`attention-dashboard.ts`、`daily-attention.ts`。 | 缺少可信解除事实的来源保持 unknown；不会通过提醒、模型建议或 local fulfilled 擅自解除业务授权。 |
| 5 事件驱动监督 | **部分实现。** `supervision-service.ts` 由 durable changes 标脏，补扫/单飞；Session ordinal 与 `projectAttentionRun` retained events 分页补读；observer `step` 协作分片。 | #238 生命周期与通知批处理；#239 migration 42、事件 gap/重放；#242 公平性、人工 release 丢失红绿修复。`attention-observer.ts`、`attention-run-projection.ts`。 | 公平性仅在已 admitted 集合；全局 100 subject 不自动轮换扩权。Loop 等仍有快照限制；大负载 soft 5ms 未完全达标，补充10分钟本机合成混合soak通过，但活跃Graph执行、跨平台及Loop tick开销仍待资格。 |
| 6 回合结束交接检查 | **单 harness 范围内实现。** `attention-hook.ts` 通过 foreground nonce、版本绑定、handoff receipt 和一次提醒连接 Claude Stop。 | #237 单独记录真实 Claude Code 2.1.291 Stop 验证与输入/源码限制。 | 取消、强退、多 harness、所有平台的 hook 等价行为未完成；不能称为永久在线监督。 |
| 7 主会话与监督分工 | **部分实现。** 确定性 daemon 管理观察；`AttentionTriageService` 显式、无工具、仅建议，默认 disabled；`controlled-triage.ts` 是受限 provider 路径。 | #238 lifecycle；#241 实际 daemon 默认 provider 初始化/关闭/重启，未知隔离与预算测试。 | 未新增常驻全权监督模型。真实 provider smoke 为 `not_authenticated`，没有 live triage 模型资格；注入 provider 的终止事实只属于测试合同。 |
| 8 决策持久化和来源绑定 | **本地范围内实现。** Attention item 保存 episode、来源摘要、未决状态；投影不替代原 decision/approval 账本。 | #237 原来源绑定、无关 done 不清问题；#239 run replay 以权威源核验 resolved decision。`attention-store.ts`、`attention-run-projection.ts`。 | 未受支持/未绑定来源不因显示一段文字而获得决策身份；远程观测也不新增本地决定写权限。 |
| 9 回答幂等与未知投递 | **受支持 Session 通道内实现。** `AttentionActions` 绑定 action→message、CAS、同 key 重放；unknown 不重发，明确 abandoned_unknown；执行仍走原 session 入口。 | #237 取消准入、保留 lease、未知回执与重复请求回归；#238 stop/outbox 细化。 | 该幂等结论不自动适用于公共消息。O2a 另有签名 grant/attempt ledger，真实外部 transport 尚未资格。 |
| 10 低打扰/离开模式 | **通知偏好范围内实现。** attended/quiet/away 只调整通知行为；有限通知批处理、去重、重试、死信。 | #237 `AttentionExperience`；#238 at most 20 claims / 1s local batch、receipt 故障恢复与停止测试。 | away 不是授权解释器；本地幂等 sender 的性质不能转成公开网络发送保证。 |
| 11 增量返回简报 | **本地范围内实现。** actor/scope/revision 已读位置；短摘要与完整数量分开；daily 增加同范围监督摘要但不 mark seen。 | #237 增量 brief；#239 手动/计划 daily 的 DB 只读、未初始化 home、旧 schema/unknown 与转义测试。 | 无可信来源时显式 unknown/not_watched；不是任意跨 home、跨租户的完整统一简报。 |
| 12 调查与交付分型 | **部分实现。** 原 planning helper 保留 scout/promote 契约规划；`deliver --contract FILE` 的 V2 已实际约束 guarded implement；Graph 仅受限 implement。 | #240 `delivery-contract-host.ts`、`deliver-command.ts`、guarded delivery；#242 `bindGraphDeliveryContract`。 | scout 的真实无写工具执行、显式 promotion 后重新绑定 base/重新准入尚未完整实现。不能用旧 helper 成功或 supplied JSON 充当真实 scout→implement 交付。 |
| 13 统一交付完成标准 | **部分实现，真实执行已接入。** frozen V2 contract/digest、host policy/check registry、candidate/check/review receipts 进入 guarded-local/git；Graph `graph.contract` 只读与 ready durable projection 绑定的 receipt。 | #240 实际 CLI+Git+policy/context，但模型 adapters 注入；#242 Graph host/check/context/source invariants 与双 digest 回归。`delivery-contract-host.ts`、`graph-contract-host.ts`、`graph-delivery-receipts.ts`。 | Graph 首版只有 implement/local_verified/artifact_only、一个注册 check。reviewer identity 是 reported identity；非 provider 权重证明。#242预冻结Git stat问题已用raw-blob比较修复，最终本地全量与静态复核通过。 |
| 14 清理前成果与决策保全 | **已改造路径范围内实现。** daemon 启动/Loop cycle 不再自动删除未知 worktree；未知执行、决定和回执保留；recovery 明确 `canAutoRetry:false`。 | #237 清理保护；#242 `readAttentionRecovery` 的坏行/跨 scope/不自动重试测试。 | 未宣称改造所有独立人工 cleanup 命令，也没有自动证明远端子进程已退出。人工修复不能通过清掉未知记录绕过执行事实。 |
| 15 有界能力协商 | **部分实现。** 既有 Adapter resume 矩阵；Graph 受限 host registration；remote handshake 固定只读 methods；R3 manifest 固定 `snapshot.read`。 | #237 来源/adapter 限制；#242 remote strict schema/nonce/home/protocol；Wave 6 sources schema/pin/capability 拒绝测试。 | 没有通用动态插件执行平台、多 backend 任意协商或 request 自报权限。能力声明不是授权，远端/新 provider 须单独资格。 |
| 16 可见工作进程 | **部分实现。** #239 `worker list/inspect` 读取绑定 Session/run；Wave 6 terminal `PresentationBackend` 与 `handleWorkerViewerCommand` 已提交，定时读原 token、无动作。 | #239 real daemon/token/scope；V2 原提交 `eb5d6c4d`，集成组件 `26650bc4`：63 定向测试，真实 OS SIGINT/EPIPE（fixture inspect），真实 WorkerViewService 无 DB 改写。 | terminal viewer 是结构化快照，不是日志 tail、执行 console 或进程存活证明。中央 `worker watch` 已接真实main/daemon并通过只读回归；tmux/cmux/desktop 实机资格未完成。 |
| 17 远程 home 与断线 unknown | **部分实现，远端实机待资格。** `remote-export --stdio` 已进实际主入口；`remote-home inspect` 固定 SSH 程序和 pin，导出已有 identity 与 worker 快照，失败无本地 fallback。 | #242 `remote-home-{protocol,reader,exporter,command}.ts`；组件 90 测试；真实本地 daemon+child exporter、SSH `-G` 无网络配置解析；root 编译主入口测试。 | 没有真实 SSH 目标主机、真实 host-key 变化/断网恢复资格。R2 远程 action grant/receipt/start/cancel 不在已完成范围；本地 stdio 试验不是跨主机证明。 |
| 18 外部事件扩展 | **部分实现。** 既有 Loop 只读和 CI exact-head；Wave 6 `createHostLocalDataSourceService`、`sources inspect` handler：固定 host 私有配置、manifest/content pins、有限 JSON snapshot、实时撤销重核。 | R3 `b876bd11`，集成组件 `3c7e6f94`：20 测试、类型/Biome、实际文件读/handler、3 轮静态挑战；见[指南](../guides/local-data-source-registry.md)。 | 当前是本地 typed data source，不是通用外部事件总线。中央接线已通过实际入口回归，整批本地资格已通过，真实外部环境资格仍保留；无动态代码、网络 provider、自动 context 注入或事件 sequence/gap 协议。Node 路径竞态与跨重启时钟限制保留。 |
| 19 状态对外 ledger | **部分实现。** Attention inventory/inbox/deliveries、run event cursor、worker/recovery RPC、Graph contract receipt、独立 follow-up 历史均有类型和范围。 | #237–242 对应 store/projection/service；O2a 增加不可变授权/attempt history，且已接真实入口。 | 尚非统一跨源流式 ledger；外部 snapshot、相邻读观察和不同投影不能宣称一个全局原子快照。来源无 gap/身份事实时保持 unknown。 |
| 20 记忆预算与衰减 | **部分实现。** `context-budget.ts` + `createExecutionContextAdapters` 实际生成 AgentTask.prompt；准备/observed receipt，mandatory 超限拒绝；`attention lesson --from-run` 经 RPC 读真来源再写 investigation draft；人工编辑/晋升保留。 | #240 actual prompt/receipt、原仓库保护、lesson create-only/revision/promote 幂等；#242 Graph 当前 effect 对应两阶段 receipt 重读。`execution-context*.ts`、`attention-lesson.ts`、`loop/src/lesson-draft.ts`。 | 普通 run 未证明失败→修复→成功，所以只写 investigation；qualified success-after-repair bridge 仍缺可信完整历史。没有自动批准/发布，也没有给所有会话默认加载；prompt receipt 不证明 provider wire/token window。 |
| 21 轻量任务路由 | **部分实现。** `attention routing-eval --mode router_golden` 调用真实 capability/profile router；固定 22 个可审阅 case，验证显式 override、角色和拒绝原因。 | #238 `attention-routing-evaluation.ts`，22 case 通过，fixture provider invoke=0；[指南](../guides/attention-routing-evaluation.md)。 | 不是独立 holdout 准确率，不证明更便宜模型带来收益。真实模型成对评估、成本/质量/置信区间资格仍缺，默认路由不据此自动改写。 |
| 22 对外承诺持久化 | **本地承诺已接入，公开投递仍部分。** #241 `follow-up create/list/draft/resolve` + migration 44；`fulfilled_local` 与未发送草稿分开。O2a `FollowUpDeliveryService` 单独签名授权/消费/未知/查询账本组件已提交。 | #241 实际 RPC 默认租户/CAS/重启；O2a `02f980ba`（集成 `6c5f598d`）migration 45、123 定向/回归测试（签名、真实 SQLite、SIGKILL、fake sender）。 | O2a最后IMMEDIATE修复晚于组件第三轮审计，已由root投递审计与真实daemon签名fake/关闭测试覆盖。默认无真实公共 provider、目标 registry、签发 UI/issuer；fake send 不等于真实 GitHub/邮件/聊天投递。 |
| 23 自仓库发布边界 | **部分实现，沿用主治理。** V2 publication_scope/requested_actions/merge_authority 进入实际 guarded 路径；host base policy/private overlay 限权；Graph artifact_only 无发布权。 | #240 修复 R3 PR scope、全风险 action 校验、base policy、自修改策略不能自授权、目标 repo/ref/head 重核；实际入口反例。 | 契约字段本身不是批准；没有自动 merge/deploy。真实 provider publication/部署仍独立资格；legacy action 意图并非 V2 allowlist，不能把所有旧入口一概标为升级完毕。 |
| 24 自更新/多 home 收敛 | **部分实现。** #240 `homes inspect --manifest FILE` 只连显式 pin 的同 UID socket；U2a 已提交 exact-version plan、私有 hash-linked journal、跨计划 installation/home claims 与注入式 coordinator。 | `home-inventory.ts` 的真实本地 socket 测试；U2a `52df9cf2`（集成 `14574347`）新增 67 测试、31 既有回归；五轮静态挑战逐项处置。 | U2a 中 native effects 全为 fake，中央 plan/status 接线已提交并通过actual main回归；没有生产 NativeUpgradePort 或 apply 操作。shared-consumer 完整性、真实多 home 升级、实际 build 确认和恢复仍待资格；禁止数据库回滚。 |

## 4. Wave 6 组件交付与证据边界

### V2 terminal viewer

`packages/cli/src/worker-presentation.ts` 与 `worker-viewer-command.ts` 已提交。它只轮询 `worker.inspect`，保持最初授权 token，过期或 unknown 结束；Ctrl-C/close/EPIPE 只关闭本地观察。支持有界间隔/时长、背压、转义与 scope 变化拒绝。

63 项定向测试、CLI 类型检查、Biome 通过；真实 WorkerViewService 读后数据库未变化。另有实际 Node 子进程 SIGINT（退出 130）和关闭 stdout 管道（退出 1）验证，但 inspect 响应是 fixture，不是完整生产 CLI/daemon/远端资格。三轮 Haiku 最终无确认 P0/P1/P2；保留 stalled stdout 最多一份 pending chunk/late-error guard 的边界。证据已归档 `2026-10-23-firstmate-wave6-evidence/viewer/`，另补真实main+daemon只读及socket取消回归。

### R3 本地来源注册

20 项测试覆盖实际私有配置与文件、内容 pin、来源/租户隔离、live revoke、超时后实际槽保留、恶意/大响应、CLI 异仓库替换拒绝。配置固定为 host 的 `source-registry.json`，每次读取重载，读后再校验；缺配置 disabled，坏配置 unknown。默认无来源，不读取 request 指定文件，不执行 repo 脚本。

三轮 Haiku 无 P0/P1 剩余；路径/时钟/早期失败 scope 的限制以指南与反例明确，不声称这些更强保证已经实现。最终源码 native 本地暖缓存样本：56,589 bytes、20 entries、50 warmup + 300 measured，350/350 ready；p95 0.762292ms、max 2.050875ms。仅是本地 service，不能替代 socket p95 或混合负载验收。原始证据已归档至 `2026-10-23-firstmate-wave6-evidence/sources/`。

### O2a 授权投递账本

`02f980ba`（集成 `6c5f598d`）已提交 `follow-up-delivery.ts` / DDL / protocol / CLI handler。实现 exact body/target/scope 的 host-trusted Ed25519 单次 grant、先 durable started 再 sendOnce、未知不重发、显式 reconcile/revoke、observed clock high-water。默认没有生产 sender 或 issuer；已知 transport-without-lookup 不能获得生产资格。

[组件报告](2026-10-23-follow-up-delivery-audit.md)记录 123 测试，以及第三轮后修复 IMMEDIATE transaction 的时间关系。最后修复已由root独立投递审计覆盖，报告0确认P0/P1；第三轮原始P1报告仍完整保留。SIGKILL 是进程崩溃证明，不是物理断电或真实 provider 恢复证明。根入口和可信宿主注入已接线；默认registry为空，真实签发/批准流程、provider adapter与sandbox send+lookup尚未完成。

### U2 升级协调

U2a `52df9cf2`（集成 `14574347`）已提交 `upgrade-plan.ts`、`upgrade-journal.ts`、`upgrade-coordinator.ts`。计划固定版本/build/schema、inventory identity/generation、home/socket、部署组顺序、过期时间和每组预算；私有 journal 以 create-only、hash chain、文件与目录同步保存阶段事实，installation/home claims 跨计划互斥。未知 native effect 不重试、不抢锁；状态只读并明确 `resume_allowed:false`。普通计划始终 `qualification_pending` / `authority:none`，不授权安装。

[组件审计](2026-10-23-upgrade-journal-audit.md)记录新增 67 项测试（plan 14、journal 12、coordinator 41）、31 项既有 home/updater 回归、CLI 类型检查、三个运行时 bundle 与七文件 Biome。所有 native effects 都是 fake；中断测试重建持久阶段，不是物理断电。五轮静态挑战修复跨计划 home claim、partial claim 可见性、重放拒绝和发布后重新读取失败的本次 token 清理等问题；第五轮只确认最后 delta 无新 P0/P1，不替代整批审计。

中央plan/status已接实际main并测试；没有生产 `NativeUpgradePort`，也没有注册 apply。真实 shared-binary consumer 完整性、launchd 多实例、native installation、运行中实际 target build、双 home 顺序恢复和断电耐久均待资格。[指南](../guides/multi-home-upgrade-plan.md)明确禁止数据库恢复式回滚；现有 `upgrade.ts` 不能直接整体包装成新 port。不得对用户真实 homes 隐式更新来补证据。

## 5. 尚未完成工作的明确验收项

1. **PR 栈收口。** #237–241已ready且CI通过，仍需独立批准；#242与#243最终本地全量已通过，当前CI与Ready状态请看PR实时栏。不得用后续 feature 分支上的修复暗示旧 PR head 已通过。
2. **真实 live triage 与模型成对路由评估。** 需要明确模型、现有凭据和 provider 运行结果；不替换认证、不自动换模型、不把无凭据 smoke 写成成功。路由需真正 paired/holdout、质量与成本证据，才可改变默认策略。
3. **Graph 完成边界。** 当前仅一个 check 与 artifact_only；修复所有未决 source/policy/input/epoch 绑定问题后，再给最终候选资格。多 check、真实 provider、publication 和通用 scout 是后续范围。
4. **跨后端持续性与性能。** 已完成10分钟本机100来源合成混合soak（14574347）：12001次真实socket读取零错误、p95 2.206ms、最终全部追平；测量期Graph已完成，只读其status/result。仍缺活跃Graph执行、完整停止/重启/旧实例/容量上限及Loop tick overhead <1%证明。100-run/12,000-event 样本已收敛但 step p95 5.205ms 超过 soft 5ms，不能以小 fixture recovery socket p95 0.286ms 代替。
5. **远程实机。** 真实 SSH host/key/home binding、断线/重连/变更身份/旧 generation/未知、平台失败矩阵；R2 远程 action 单独设计与资格。当前固定命令/local child 测试不能替代这些事实。
6. **公开承诺投递。** O2a已接线并完成root审计；仍须提供真正受控的 issuer、registry、禁 SDK 重试的 provider adapter、精确 author/target/body/correlation receipt lookup 和断线/崩溃验证。此之前保持生产 registry 为空、qualification_pending。
7. **升级与展示后端。** U2 native apply、失败后的显式协调恢复、实际运行版本确认与多 home 顺序恢复（不恢复旧数据库）；tmux/cmux/desktop 等每个平台独立资格。terminal snapshot 不等于这些平台已实现。
8. **知识与调查闭环。** scout 的无写工具执行及显式 promotion 重新准入；可信失败→修复→成功证据接 lesson；来源 registry 与 context 如要连接需专门的权限/预算/来源 adapter。不得复用 investigation 草稿或任意 JSON 来伪造成功经验。

## 6. 如何读取审计与 OSStack 管理记录

任务通过独立 scratch home 的 OSStack 原生 enqueue/run/retry/verification 管理。失败尝试保留，新的资格尝试使用新记录；Loop verifier 零问题只针对其固定命令、源码和 adapter，不等于生产环境证明。现有 full qualification 的八项检查包括 build、typecheck、tests、lint、schema、inventory、startup 等实际记录；应打开对应 manifest 看命令和退出码，不能只看任务成功标签。

研究阶段 Fable 5.1、后续 Sonnet/Haiku 是不同阶段的请求。**CLI 指定 `claude-haiku-5-5`、返回同名 `canonicalModel` 或 `provider:firstParty`，不等于独立验证真实 provider 权重身份。** 多份 stderr 有 `unrecognized_model`，必须保留；审计只证明独立调用对固定输入给出了意见，不是实机测试、授权或发布许可。prompt-too-long、格式无效或未完成请求不能计为已完成审计。

本账本保留每项“有代码”“已接入口”“本地测试”“真实外部环境”“PR 合并/部署”的差别。只有对应证据补齐后，才能逐项收窄上面的未完成范围；当前没有依据宣称 24/24 等价移植已经完成。

## 补充本机持续负载证据

[归档报告](2026-10-23-firstmate-wave6-evidence/qualification-soak/report.md)对应独立快照14574347，不冒充最终源码全量验收。600.061秒、100来源（30Session/50run/20Loop快照）、10091新event、589session版本、295快照更新、10次10倍hot-run burst；12001次真实socket RPC零错误，p95 2.206ms/max17.706ms，收尾18.942秒全部追平，RSS峰值238.84MiB。真实daemon内两个合成Graph先产出artifact，再持续只读查询；没有测量活跃Graph写执行。原始JSON、复现harness、范围与哈希均保留，home/数据库未入库。

## 最终本地资格记录

[#242最终记录](2026-10-23-firstmate-pr242-final-qualification/README.md)：5204 passed/3 skip；[#243最终记录](2026-10-23-firstmate-pr243-final-qualification/README.md)：5388 passed/3 skip。两批均22包、8项检查与原生OSStack verifier通过。所有PR未合并/未部署；独立批准与实时CI保持原门槛，本文不固化会变化的远端状态。主工作区原有107项未提交修改未被纳入这些PR。
