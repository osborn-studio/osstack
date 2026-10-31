# Attention：任务状态、决策收件箱与显式交接

Attention 将 Firstmate 的关注列表、结束提醒和交接体验接到 OSStack 已有的任务、会话和回执上。观察者不调用模型、不回答问题、不执行任务。执行仍走原来的会话适配器及审批边界。

## 启用范围

`attention status` 是独立只读入口，不启动 daemon、不运行迁移，支持已核对的数据库 schema 24–41（仅只读投影兼容，不保证实验分支数据库可迁移）。后台功能默认关闭；仅在显式启用 `OSSTACK_ATTENTION=1` 的 daemon 中运行。开发验证必须指定隔离 home：

```sh
OSSTACK_HOME=/absolute/isolated-home OSSTACK_ATTENTION=1 osstack serve
```

使用安装后的发行版本接入真实 home；不要从开发 checkout 指向默认或保留的控制面。迁移 40 新增观察、决策和体验表，迁移 41 新增人工回执处置和冻结的交接有效期。

## 单次快照

```sh
osstack attention status --db /absolute/isolated-home/state.db \
  --task TASK --repo /absolute/repository --default-tenant --json
```

任务和 run 均须属于默认 tenant；session 还必须匹配持久化的 canonical repo。run 的仓库绑定仍标明 unverified。只返回最新 turn，不能据此声称历史问题已经全部处理。进程活性为 unknown，coverage 为 not_monitored。

每类最多 100 条。跟随 `completeness.next_cursor`，使用 `--cursor TOKEN`；游标绑定本次 scope，并记录两类集合是否耗尽。每页都是新快照，不是跨请求的固定数据库快照。旧的 `--after-run/--after-session` 仅适合单集合调试。

## 持续观察与收件箱

```sh
osstack attention watch --task TASK --repo /absolute/repository --default-tenant --json
osstack attention inventory --scope SCOPE --json
osstack attention inbox --scope SCOPE --json
osstack attention get --scope SCOPE --item ITEM --json
```

`watch` 返回 scope ID。观察按 keyset 发现对象，按 ordinal 补读历史 turn，重读当前 turn。decision 的身份是 scope、session、origin turn、decision ID；CAS 版本与身份分开。坏 turn 标记历史缺口并继续读取后续 turn；缺口不会因为一次成功重读而消失。

daemon 全局最多准入 100 个 subject，优先 session；已有 session 的 run 不重复占容量。最多登记 100 个 scope。超额对象仍被发现并列出原因，不会为了新对象静默驱逐旧对象。`total/returned/truncated/next_after` 必须一起看。覆盖依赖完成扫描、当前 generation 和有效期，不能用心跳证明覆盖。

`covered` 只表示已准入来源的新鲜观测，不表示后台正在推进任务。未知进程、缺失来源、历史缺口、未决回执会分别显示。历史决策没有精确回答证据时保留，不通过文本猜测自动关闭。普通问题若有同 origin turn 的 applied 入站回执，可标 continued_externally；审批义务不会因此被消除。

全局最多准入 100 个 subject，不自动驱逐旧来源。容量不足时，可显式释放观察席位：

```sh
osstack attention release --scope SCOPE --kind session --subject SESSION \
  --expected-version VERSION --json
```

版本来自 inventory。释放保留历史决策和回执，不结束会话、不发送消息；该来源保持 `owner_released`，后续扫描不会自动重新准入。范围仍显示覆盖不完整，腾出的席位可供其他来源使用。释放后历史 item 不再自动追踪来源的关闭/继续，已有未决提醒仍保留；回答时依然重新核验实时来源。

## 回答与不确定回执

```sh
osstack attention answer --scope SCOPE --item ITEM --action UNIQUE_ID \
  --revision REVISION --content-hash HASH --text '明确回答' --json
```

同一 action ID 和完全相同参数可重复查询，只有一个 message ID。不同内容重用 ID 会冲突。提交时重新验证来源、当前 turn、版本、决策内容和等待状态；终态会话不能被此入口复活。直接 `session.send` 与 Attention 共用预留门禁，collaborator 的检查/预留也在同一个数据库串行验证。

活动 grant 默认阻止人工抢答。显式接管须加 `--takeover --grant EXPECTED_GRANT_ID`，且没有在途检查或消息；grant 改变即拒绝。agent 报告的 risk_approval/task_authorization 只导向既有签名审批，不通过普通回答代批。agent 标签本身不构成执行授权；缺少标签也不是动作安全证明。

`applied` 只证明指令回执被应用，不证明任务完成。adapter 失败或完成回执不明时保留 uncertain，不能靠换 message/action ID 重发。重启会对账 reserved actions，不自动重新执行。

若人工检查后决定放弃原始指令，可显式记录一次处置：

```sh
osstack attention abandon-receipt --scope SCOPE --session SESSION \
  --message MESSAGE --expected-version VERSION \
  --reason '已人工核对现场，放弃原指令，不重放；执行结果仍未知' \
  --evidence-sha256 SHA256 --acknowledge-unknown-effects --json
```

这只记录 `abandoned_unknown`，不会将原消息标为成功、不会重放、不会授予 collaborator 继续执行的权限。在途消息不能被处置。SHA256 是操作者声明的审计引用，不是 OSStack 自动认证的外部执行证明。随后若需继续，必须另发明确的新人工指令。旧 action 重试仍返回已放弃，不能再次发送。

## 简报、通知和 Cockpit

```sh
osstack attention brief --scope SCOPE --actor owner --json
osstack attention cockpit --scope SCOPE --actor owner
osstack attention posture --scope SCOPE --actor owner --posture quiet
osstack attention seen --scope SCOPE --actor owner --revisions '[{"item_id":"ITEM","revision":1}]'
osstack attention deliveries --scope SCOPE --json
```

简报按不确定性、审批需求、普通问题排序，显示前三条和完整数量。读取不是已读，已读按 actor、scope、item revision 显式记录。Cockpit 聚合库存、收件箱、简报和投递结果。

posture 为 attended、quiet、away，只改变体验，不改变权限。当前为本地 owner 模型；任一 actor 的 quiet 会保守地静默整个 scope，恢复通知须将该 actor 改回 attended/away。

posture 记录进入时间；重复设置当前 posture 不改变起点。从 away 改回 attended 时，返回结果带 `return_brief`：仍在等你的全部决定（最早在前，带年龄与提醒次数；列表有上限，但总数与省略数总会给出）、离开期间新开与已解除的决定、离开期间死信的首发通知与提醒。`osstack attention return-brief --scope SCOPE --actor owner [--since MS] [--limit N] --json` 只读预览，不改变 posture。quiet 改回 attended 不生成回归简报。简报只是信息，不授予任何权限。

若启动时另设 `OSSTACK_ATTENTION_NOTIFY=local`，通知写到 home 下 `attention-notifications/`。每个 delivery ID 原子发布一个本地文件，重复尝试不会生成第二份。其他 transport 通过受限 sender 端口注入；协议为至少一次，接收方须按 delivery ID 去重。失败最多 5 次，随后 dead_letter；旧 revision 在发送前判为 superseded。没有配置 transport 时不外发消息。

- delivered：transport 收到，不代表用户已读。
- answer_reserved / answer_uncertain：指令已预留，结果尚未证实。
- answer_applied：存在对应应用回执，不代表业务完成。
- completed：原业务来源的完成状态。

## 前台登记、交接与 Claude Code 提醒

```sh
osstack attention foreground --scope SCOPE \
  --subjects '[{"subject_id":"SESSION","source_version":VERSION}]' --json
osstack attention handoff --scope SCOPE --client CLIENT --token TOKEN --json
```

登记返回随机 token，绑定精确 subject set、来源版本和 daemon generation。交接要求范围内完整、未降级的扫描，以及前台所列 subject 无未决回执；回执冻结 `valid_until`，重复查询不延长它。`execution_takeover:false` 与进程 unknown 明确保留。前台到期后仍可收到一次结束提醒，不能据此续期交接权限。

已在 Claude Code **2.1.291** 上实测正常 Stop → 已构建 CLI → Unix RPC，并确认第二次提醒为 null。使用单独的权限为 0600 的 binding JSON：

```json
{
  "harness_version": "2.1.291",
  "session_id": "CLAUDE_SESSION_ID",
  "scope_id": "SCOPE",
  "client_id": "CLIENT",
  "token": "64_HEX_TOKEN",
  "role": "foreground_owner"
}
```

在该次 Claude 会话的独立 settings 中配置 Stop command：

```sh
osstack attention claude-hook --binding-file /absolute/private-binding.json
```

该命令读取 hook stdin，只接受匹配 session 的 root Stop，拒绝 worker、stop_hook_active、未知版本和错误身份。只返回一次 systemMessage，永不返回 block、永不自动续轮。用户全局 Claude 配置不会被自动修改。

实测 SIGINT 在本版本只发 SessionEnd，不发 Stop；取消、强退和进程丢失没有结束提醒保证。未安装独立 watchdog，不能声称离线检测或无人值守继续。事件格式参考 [Claude Code 官方 Hooks](https://code.claude.com/docs/en/hooks)。

## Loop、CI 与离线辅助工具

```sh
osstack attention loop --scope SCOPE --state-path /absolute/repository/LOOP-STATE.json --loop-id LOOP --json
osstack attention ci --scope SCOPE --github-repo OWNER/REPO --pr 123 \
  --head EXACT_40_HEX_SHA --required '["test"]' --json
osstack attention contract --input contract.json --json
osstack attention contract --input scout.json --head NEW_HEAD --json
osstack attention contract --input contract.json --evidence evidence.json --json
osstack attention routing-eval --input routing-results.json --json
osstack attention triage --input model-result.json --json
osstack attention context --input evidence-entries.json --budget 8000 --json
osstack attention lesson --input lesson-draft-input.json --repo /absolute/repository --json
```

Loop 只读有界文件、绑定 workspace 和 loop ID；运行中快照显示 recovery_required，缺失/冲突降级，不能自动接管未知 worker。注册后后台补读，始终披露 best-effort snapshot gap。

CI 使用已有 GitHub 命令执行器，独立并发上限 2、缓存上限 100、失败退避；需要完整 required check 名单及精确 head，缺 check/凭证、head 改变、网络错误均不能变成通过。仓库/PR 是操作者显式选择的外部来源，结果仅供观察，不替代 merge/deploy 的既有资格验证。

交付契约工具从同一冻结对象派生 digest、brief、effective options；scout→implement 产生新 ID。校验 mode、head、必选验证、review 与完成层级。它检查输入自洽，不是外部执行证明，也不会自动调用 deliver 或复用审批授权。

上述 `--input` 分诊是离线输入检查，只接收三种分类和有限解释，拒绝 action/tool 字段；显式 `triage --scope ... --item ... --model EXACT` 才会调用已配置的受限 provider。`routing-eval` 默认评估调用者提供的预测；`--mode router_golden` 运行确定性路由 fixture，`--mode paired_holdout` 才进行显式双模型评估，需要凭据和合格数据。未证明收益前不改变默认路由。context 按层级、时间与 UTF-8 字节预算筛选，披露被省略的必选信息；lesson 只新建带随机 ID 的既有格式 draft，不覆盖用户记忆，不修改 AGENTS，不自动 promote。

## 恢复行为变更

daemon 在 socket 清理、业务 DB 打开、恢复前取得独立 SQLite 文件的内核排他锁。锁文件固定 inode，崩溃时内核释放；PID 文件仅用于诊断。限已验证的本地文件系统，不能删除锁文件强行抢占。

旧 running/stopping Loop 和 daily 快照恢复为 stopped/recovery_required。启动和 Loop cycle 都不再强制删除未知 orphan worktree。保留成果后由操作者核对并明确开启新工作。未知外部 worker 不会被本功能终止或自动重启。

整合前实验版 Attention 的 schema 25–26 与已发布 main 编号冲突，不能直接复用其 home；保留原目录与旧版本用于对账，在新隔离 home 验证。新版本会拒绝冲突的迁移谱系，不重置版本号或改写旧账本。

## 集成能力与验证

- [Cockpit 只读监督视图](attention-cockpit.md)
- [真实确定性路由评估](attention-routing-evaluation.md)
- [后续开发总计划](../plans/2026-10-23-firstmate-remaining-master.md)

本地通知每轮最多处理 20 项、等待预算 1 秒，关闭时取消并等待逻辑回执完成。回执写失败在下一次扫描恢复；这只保证本地按 delivery ID 幂等的 artifact，不代表公共消息送达。
