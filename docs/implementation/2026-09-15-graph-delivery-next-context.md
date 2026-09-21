# G21 接续上下文：G22–G24 / 用户入口与外部契约

G21 本地验收通过，源 `ab988b32649c9eef084e997bb92d31c0108436fc`；G00–G21 完成（22/30），下一批 G22–G24，C7 pending。见 [G21 报告](2026-09-15-graph-delivery-completion.md)与[准入证据](graph-delivery-evidence/admission.json)。

实施工作区 `/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation`，分支 `codex/graph-runtime-foundation`。原 checkout `/Volumes/AIMATE_WORK/Developer/CodeX/osstack` 仅镜像拥有的文档，保留其 AGENTS 和其他用户改动。开发 CLI 只能使用显式独立 OSSTACK_HOME；禁止打开默认或 reserved serving home。

## 已实现接口

`packages/cli/src/graph-delivery.ts` 的 GraphDelivery 是可信 host 的一次性编排入口，构造参数包括 db、完整 StartGraphRequest、隔离 root、可信 repositoryPath/task、writer/reviewer 与独立身份核验、acceptanceRegistry、G10 acquire、同步 authorize。run() 返回 host route、可选 candidate 与 feedbackRef；没有 freeze 的停止/未知结果没有 candidate。不得从 worker/caller JSON 直接提供 adapter、shell command、路径或身份授权回调。

编译器 code-delivery-functional-v4；固定 registry/schema 仍为 v3，成本和操作定义未增加新工具。每轮 8 个 plan 节点，其中 7 个有实际效果。workspace/implement 或 repair/freeze 串行，两项准备也记账；review/tests 并行。公开 Functional task + sync saver；每轮 host 质量边界通过 interrupt，先观察物理 stop/drain，再由 G15 交接和 interrupt resume 实现修复。模板只缓存 confirmed action RETURN。

GraphDeliveryEpochStore（core/graph-verification 子路径）与迁移32持久化 epoch 许可。GraphActionBroker.installActions 只追加当前连接动作；retryAuthorized 的 replacement 参数只供已授权尝试选择新工作区，payload/cap 保持相同。普通 worker 不能追加任意动作或分配 attempt。core 与 broker 对 code-delivery-functional- 家族要求初始许可，后续轮次需要最新合法负向 immutable join，无 unknown/held，原预算足够。

GraphDelivery 保留自身 owner/generation，只能由自己成功的 G15 返回更新；最终状态必须用 join 快照 revision。不得为了通过冲突而读取最新 owner 冒充它。撤权/换代时旧 host 不投影状态；留给已授权恢复。retry_required 若无法实际准入，返回 stop/retry_dispatch_incomplete 并置 failed，不能返回 retry_required 却封死运行。

prepareGraphVerification 保留旧双分支接口；新 prepareGraphVerificationBranch(options,kind) 只准备一个分支，返回 workspaces map。传入 preparationLease 时由 broker 负责释放，不能再次拿同源锁。动作/receipt 精确匹配 nodeId+effectSlot；retry-N 准备槽与分支 main 不可混淆。

执行回执在 graph-delivery-receipts.ts：graph-delivery:<digest>、128KiB、精确 effect/generation/owner/workspace 绑定、fsync、no-overwrite/no-follow。G19 验证回执仍是 graph-verification:<digest>、64KiB、8KiB report/有界诊断。回执哈希只证明已保存内容；未知外部效果仍须独立核对，不能靠旧 stopped:true 在新 daemon 中自动解除隔离。

## G22 实施要求

保留现有 graph explain 关系诊断入口。新增 validate/run/status 应走已认证 daemon 的持久 run 服务；不要在每次 RPC 重试时盲目 new GraphDelivery().run()：它是 one-shot，root 下的 source 模块采用 exclusive create，已领取的 run 必须从持久状态返回或经 G23 恢复，不能再次 claim。先做 caller/scope、原始输入与幂等键映射，再安装可信 registry 与内部 driver。

入口需要 lazy import；执行模块目前由内部源代码装配，不能宣称已通过完整安装包分发（G27）。添加 CLI/包 index 顶层依赖前测量加载成本。已有 --version <150ms、--help <500ms 本地预算不变。GraphSpec 仍是固定 code-delivery-v1，不开放任意 JavaScript 或任意图拓扑。

## G23/G24 与未完成边界

G23 取消必须先持久 cancel intent；Promise 完成不等于 worker/执行器停止，unknown/held 不得自动重试或清理。新 host 的恢复需由不可变 receipts、候选、checkpoints 和 G15 重新装配工作区注册；G21 验证的是同一 coordinator 中的实际计划性交接，并非任意 daemon crash 自动恢复。保留原 scope/program/input/specHash、createdAt、预算、effect attempt，不能重新给完整预算。

G24 把内部 route/candidate/ref 映射为稳定外部结果，ready 只交付候选，不 merge/push/deploy，不自动完成 task FSM。OSBot/OStag 身份字段只是协议，不等于外部生产鉴权集成。C7 要等 G21–G24 全部完成；G25 故障、G26 兼容、G27 发行、G28 性能、G29 真实试点仍 pending。

G28 特别检查 Git 同步 inventory、workspace clone 和长 artifact I/O；当前仅有续租窗口压缩的真实 heartbeat 测试，不能当作长时间性能试点。same-UID 不是 OS sandbox；WAL NORMAL 不保证断电；完整历史 bundle/平台限制沿用 C5。

## 实际协作与验收

仍使用真实 OSStack Loop；sources:[] + inputTasks、skipCompletedTasks:false、新 taskId/state/home，检查 executedTaskCount/outcome 和全部 verifier。Claude Fable 5.1 已完成两轮审查，最后回审因额度限制未执行；独立 Codex 只读审查通过，不冒充 Claude 的签核。额度恢复后可将本报告和 review-adjudication.md 给 Claude 复核，不需要因此回退已验证代码。

下一批先核对当前 HEAD、任务清单、G21 报告和证据，再实施 G22。不得覆盖原 checkout 的用户文件，不 merge/push/deploy，除非用户随后明确要求。
