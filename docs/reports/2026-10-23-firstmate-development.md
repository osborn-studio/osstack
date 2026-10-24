# Firstmate 能力借鉴：实现、审计与验证记录

日期：2026-10-23。开发分支：`codex/firstmate-supervision`。实现提交：`c9ec991`（S0）与 `0f757fe`（完整本地能力）。交付级别：本地实现与验证，后台观察默认关闭；未部署、未合并、未修改生产 home；代码随后已推送为 PR #237。最新逐项覆盖见[24 项能力状态](2026-10-24-firstmate-capability-status.md)。下文保留旧基线验证事实。

## 结果

把 Firstmate 的「持续关注工作、记住未决问题、结束时提醒、显式交接」接到了 OSStack 的 task、run、session、grant 和 receipt 模型。核心观察过程为确定性代码，没有模型端口，也不获得执行、审批或合并权限。

研究基线为 Firstmate `af1c6817fc47589b162cbc361671c43cdb150933`，本地克隆在开发目录的 `firstmate`。上游为 MIT；此次借鉴行为和交互结构，自行实现，没有复制上游生产源码。详细对应关系见[研究](2026-10-23-firstmate-analysis.md)、[设计](../design/2026-10-23-firstmate-capability-adoption.md)与[实施计划](../plans/2026-10-23-firstmate-adoption-plan.md)。

## 实际开发管理

使用 OSStack 自身的 `loop enqueue`、`loop run --source task_queue`、执行命令与 verifier 管理 25 个实施验证任务。另增加最终审计修复的整仓验收任务。每个任务在独立 scratch workspace 内保留 LOOP-STATE、事件和回执；代码修改由本次开发代理完成，Loop 负责运行验收门禁，不声称这些代码由 Loop 自主生成。

所有开发 CLI 明确指定隔离 `OSSTACK_HOME`，scratch 位于 `/Volumes/AIMATE_WORK/tmp/osstack/smoke/firstmate-development-20261023`。没有从开发 checkout 打开默认或保留控制面。开始时保存了 HEAD、已有工作区状态与源码 hash；用户原有的其他改动保留。

[任务索引](2026-10-23-firstmate-development-evidence/queue-index.json)关联每个实际任务和最终回执。早期部分任务通过测试，但 verifier 捕获 daemon 文件末尾多余空行，原任务如实记为 escalated。修复后通过原生 `cockpit retry` 创建有父任务关联的新任务；保留原失败历史，没有手改完成状态。某些 retry 调用总 exit code 仍为 2，因为历史中仍有 escalated；对应新任务的 `outcome: success` 才是验收依据。

## 能力落点与语义

| 能力 | 实现落点 | 已落地行为 |
|---|---|---|
| 单次状态 | CLI `attention-read-model`、protocol | 显式 DB/task/canonical repo/default tenant；单事务只读；复合游标；只支持核对过的 schema；unknown 活性 |
| 宿主所有权 | CLI `daemon-lock`、daemon 生命周期 | 启动副作用之前持有独立固定文件的 SQLite 内核排他锁；PID 仅诊断；异常释放 |
| 保守恢复 | daemon Loop/daily、Loop engine | 中断快照恢复为 stopped/recovery_required；不重放；不按目录名强制删 orphan 成果 |
| 持久观察 | core `attention-store`、`attention-observer` | generation fence、精确 scope、稳定 episode、分页发现与历史 turn 补扫、坏来源隔离、不可静默清除的 gap |
| 覆盖与容量 | observer + `attention release` | 全局 100 个准入席位、最多 100 scope；超过容量仍发现并披露；带版本的人工释放保留历史 |
| 人工回答 | core `attention-actions`、daemon 既有 session 执行入口 | 版本/内容 CAS；action→message ledger；同 key 幂等；未知回执不重发；显式 grant takeover；风险标签只导向签名审批 |
| 未知回执处置 | actions + migration 26 | 人工确认 unknown effects 后记录 abandoned_unknown；原消息不改成功、不重放，不给 collaborator 新权限 |
| 简报与已读 | core `attention-experience` | 三条摘要 + 完整数目；actor/scope/revision 已读；posture 不改变权限 |
| 通知 | 独立 outbox、local sender | 至少一次、有限重试和 dead letter；本地按 delivery ID 原子文件去重；没有默认远程消息 |
| 交接与结束提醒 | foreground、handoff、Claude hook | 精确 subject/version、nonce、generation、冻结有效期；观察交接不等于执行接管；一次提醒 |
| Loop 与 CI | CLI Loop reader、GitHub CI reader | Loop 源路径/身份绑定与 gap；CI exact-head/required checks/有界并发/缓存退避；信息性输出 |
| 规划辅助 | supervisor `attention-planning`、CLI | contract/brief/effective options 同源；scout 显式新契约；分诊输出校验；路由对照评估；分层上下文预算；lesson draft |

### 为什么使用单独的 SQLite 锁文件

业务 DB 打开会迁移，不能作为进入启动副作用前的进程锁。现有 better-sqlite3 已提供本地 POSIX 文件锁，所以使用一个不含业务 schema 的固定 `.lock.db`，保持 `BEGIN EXCLUSIVE` 至关闭，无需新增原生依赖。固定 inode 不 unlink/replace；检查 symlink/hardlink，拒绝未准入的平台和文件系统。竞争者、同进程重入、进程崩溃、子进程继承、启动失败均有测试。此次实机为 macOS；Linux 仍需发行流水线上的实机资格，不能把 macOS 测试说成跨平台证明。

### 重要状态区分

`covered` 表示在刷新期限内，已登记范围按声明的来源能力完成了观察。它不证明进程还活着，不证明可变 snapshot 有完整事件日志，更不证明系统已接管执行。

`delivered`、`answer_applied`、业务 `completed` 是三件事。accepted/failed 消息可能已有外部副作用，故持久化为未知，重启也不擅自重发。人工放弃未知消息只记录处置，不制造完成证据。risk/task_authorization 标签来自 agent，属于附加拒绝条件，不是 OSStack 的权限来源；具体动作仍受既有执行与签名审批机制约束。

## 审计与修复

使用本地 Claude Code CLI 按请求进行无工具静态挑战。最初执行 Sonnet 5.5 三轮；收到最新模型要求后改为 **Haiku 5.5**，探测和五轮审计都保留原始 JSON、stderr、完整输入快照。参数包括 `--tools ''`、独立 settings、空 MCP、禁用 hooks/plugins/自动记忆和 session 持久化，审计者不执行或修改代码。

CLI 返回的 `modelUsage` 分别记录 `claude-sonnet-5-5` / `claude-haiku-5-5`，成功结果 `is_error:false`。stderr 同时有自定义模型名称 `unrecognized_model` 诊断。这里陈述实际请求和 CLI 回执，不把配置映射当作独立认证的供应商底层模型身份。

| 发现 | 处置与验证 |
|---|---|
| 启动清理异常可能遗留 owner | 分层清理、context 构造失败关 DB、错误时仍释放锁；独立真实子进程与失败启动测试 |
| 双集合分页出现重复；grant 存储状态误报系统接管 | scope 绑定的复合游标含 done 标志；过期/损坏 grant 与活性 unknown 明示 |
| 普通 session.send 新拒绝条件可能无响应 | 错误映射为 RPC envelope，顶层兜底；实际 socket 测试 |
| answer 复活终态；来源丢失覆盖 uncertain | 事务内要求 awaiting_decision；终态关闭 open；缺失只改变 open，原回执保留 |
| 单个坏 decision / discovery 文件错误拖垮全部来源 | 逐来源隔离；坏 turn 留 gap 并继续补扫；ENOTDIR 回归测试保留健康来源 |
| gap 被后续异常吞掉 | gap 持久化并在后续更新保留；每个 subject 用 savepoint，后半段异常回滚游标与投影 |
| 100 个 session/run 双计；超限后永远不能进入 | 关联 session 的 run 不重复占位；未准入项重新评估；owner release 明确释放席位，绝不静默驱逐 |
| 崩溃遗留 reserved；永久封锁人工输入 | 启动对账不重放；显式 abandoned_unknown 处置留证；在途执行不能被处置 |
| 同一 action 并发重放误判 unknown | 按 session→message 精确在途映射；重复请求返回 in_flight |
| 通知与执行重放语义混淆、旧 revision 误发 | 通知明确至少一次；发前 superseded 检查；本地稳定 delivery ID 原子发布；动作不重放 |
| handoff 重放延长承诺、Loop missing 被 covered | 冻结 valid_until 并重验当前覆盖，前台过期后仍可读取历史回执；Loop/run missing/recovery_required 降级 |
| 前台 TTL 过期无法提醒 | 同 generation 的过期前台可提醒一次；不因此延长交接权 |
| malformed structured decision 绕过人工门禁 | 非空无效结构 fail closed，awaiting_decision 缺失当前决策亦拒绝；只保留明确旧版字符串 choices 形态；新增 direct-path 回归 |

最终 Haiku 第四轮排除 C1–C4；第五轮补核 schema 与 Loop 路径，结论为未确认 P0/P1 阻断。[第四轮原文](2026-10-23-firstmate-development-evidence/haiku-wave4.md)与[最后补证原文](2026-10-23-firstmate-development-evidence/haiku-wave5.md)均保留条件和非阻断意见。模型审计是独立意见，不代替测试、签名审批或实际部署验证。所有原始意见保留，包括与最终设计不一致的建议；没有只保留“通过”结果。

## 验证记录

以[最终检查记录](2026-10-23-firstmate-development-evidence/final-checks.json)、[真实试运行](2026-10-23-firstmate-development-evidence/runtime-pilot.json)、[源码指纹](2026-10-23-firstmate-development-evidence/source-manifest.json)为准。

- 全仓 build、严格 typecheck、2,520 个测试、protocol schema 新鲜度、CLI startup budget、暂存及工作区 diff whitespace 检查均通过。最终 startup 中位数：version 35ms / help 83ms。
- 定向故障测试：锁竞争/崩溃/继承、失败启动、dirty/untracked/unmerged worktree 保留、daily/Loop 不重放、来源丢失、毒化 decision、历史 gap、容量溢出与释放、跨 scope、grant 与未知 receipt、CAS/idempotency、通知迟到和 dead letter。
- 实际 daemon/socket 集成测试运行 watch→inbox→answer→重复 action，确认同一指令只执行一次；不能把 fixture 适配器测试等同于所有真实 agent 支持。
- 隔离实机试运行：100 个 session、100 个关联 run、1,000 个历史 turn，得到 100 个 subject / 1,000 item；100 次 inventory RPC 采样，p95 为 0.814ms，初次 watch 为 119.854ms；三条 brief 保留总数 1,000；observer 模型调用为零。
- 真正启动 Claude Code 2.1.291，并让 Stop hook 调用构建后的 CLI 与 Unix RPC，数据库写入一次提醒，重复调用返回 null。另测 SIGINT：只出现 SessionEnd，没有 Stop，故取消/强退不承诺提醒。

这不是持续 1,000 事件/分钟的 soak，也不是 Loop tick <1% 的证明；没有把短时 backlog 样本扩展为长期吞吐承诺。

## 与研究提案的实现调整及边界

1. `attention status` 保持零迁移；opt-in daemon 使用 migration 25–26。宿主锁和保守恢复、直接 send 的未知回执保护即使不开 Attention 也生效，属于明确的兼容行为变更。
2. run 和 Loop 当前为有界 snapshot，明确 gap/unverified，不宣称实现提案中的完整 run event-seq 保留与 replay。Session 历史按 ordinal 补扫。
3. Cockpit 以 `attention cockpit` 聚合相关信息，没有把所有已有 dashboard/portfolio 页面替换成新收件箱。
4. CI 为独立信息性读取，没有成为 merge gate。真实 GitHub 凭证/远程检查未在本次调用；网络异常与 required check/head 条件用受控 runner 验证。
5. contract 是显式本地 helper，没有改写现有 delivery/autonomy 管线。分诊只校验调用者提供的模型输出；路由评估接收 golden 输入，未声称已获得真实数据集准确率或节省成本，不改变默认路由。
6. 上下文预算与 lesson draft 不覆盖用户记忆，不修改 AGENTS，不自动 promote。Remote Relay、多租户、移动端、自动执行托管及独立离线 watchdog 为 Future，没有混入本次交付。
7. 当前本地通知每次扫描最多一条（30 秒周期）；无自动数据清理。大规模长期使用需单独验证积压和保留策略。人工释放不会清除历史 obligation，也不会自动恢复到已释放来源。
8. 本地 owner 信任面：能写 home/DB 的同一系统用户可破坏状态；锁文件不可删除强抢。不是面向不可信多租户网络的服务。

使用入口、完整命令及 Stop 配置见[Attention 使用指南](../guides/attention.md)。

## 最终审计的条件性问题补证

Haiku 第三轮确认四项既有 P1 均已修复，未确认新 P1；因输入未包含完整 daemon 和 SessionRepository，提出 C1–C4。第四轮补入具体调用链，而非用口头保证消除意见：

- C1：daemon 在普通 service dispatch 前处理 answer/abandon，真实 socket 回归覆盖两条入口。
- C2：`applyInbound` 遇到相同已有 envelope 仅返回 duplicate；daemon 对 accepted/failed 同 ID 不分派。新增 abandoned 原 ID → 无 resume、新人工 ID → 单次 resume 的集成测试。
- C3：`latestSnapshot` 缺失 decision 返回 null。awaiting_decision + null 已 fail closed；普通非等待会话仍保持原人工指令能力。历史风险 item 不因普通消息被假冒为签名审批。
- C4：`completeInboundTurn` 原子写 turn、推进 version、标 applied。未知结果阻止重发是刻意兼容变化；需要人工启用 Attention、登记范围、核对现场再处置，不是自动恢复承诺。

额外处理了缺失 run 的 coverage、Loop 容量重新准入和 release 标记、过期 handoff 历史回执。CI 格式验证原本就在 AttentionCiReader，向审计补交源码。release 后历史 item 不再自动更新、积压与数据保留等 P2 如实保留在指南和边界中。

第五轮补证提示词误提了 `scope_expand/budget_reconsider`，这两个值并不存在于本项目 schema；采纳审计者纠正，以源码四值枚举为准：`phase_continue/task_authorization/risk_approval/external_input`。其中 task_authorization 与 risk_approval 都在共用预留门禁中拒绝普通回答，另两种不自行授予权限。此结论依赖第四轮给出的消费端与第五轮 schema 的联合阅读，不能仅用 schema 代替授权审计。

静态审计剩余非阻断事项包括 legacy send 恢复分支死代码、adapter 成功但落库失败时错误码仍较笼统、以 `..` 开头的合法 Loop 文件名被保守拒绝。对应消息不会因通用错误而自动重放；历史回执、原始审计与限制均保留。
