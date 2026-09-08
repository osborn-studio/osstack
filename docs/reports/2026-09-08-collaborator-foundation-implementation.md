# 协作者与自我迭代：首批实现记录

日期：2026-09-08。起点：`c9c3cd2`。工作分支：`codex/collaborator-foundation`。
承接[共创 RFC](../design/2026-09-08-collaborator-and-self-improvement-rfc.md)。本记录覆盖用户 `go` 后的本地实现，之前的 Fable 设计挑战和论文研究仍是独立的历史记录。

## 当前交付状态

| 切片 | 已实现 | 尚未提供 |
|---|---|---|
| S0 等待诊断 | 会话状态解释等待原因；discovery 全部 deferred 时记录分类计数；daemon 重启保留等待原因 | 尚未取得用户实际等待的命令或 session/run，不能声称复现那次卡点 |
| S1 结构化交接 | 版本化 continuation 协议、适配器验证、四条 start/resume 与 direct/text 落库路径、RPC 展示 | 请求中的证据仍是 agent 自报；不代表验收或授权通过 |
| S5 提案与经验真实性 | 内容绑定的提案 ID、审批历史保护、gate-only 不报 applied、显式失败观察及历史计数兼容 | 实际补丁生成、经验使用归因和独立效果实验 |
| S2/S3 自动接续 | 已核实接入依赖及恢复约束 | 尚无可使用的委托发行、证据核验和持久 dispatcher，`automatic_continuation` 始终为 `false` |
| S4/S6–S8/E1 | 保留为后续交付路径 | 未启用自动合并、发布、软件自改进晋升或后台实验 |

这些变化已进入开发分支，未安装到正在服务的 daemon。没有修改 GitHub 身份、审批规则、App 安装或发布目标。工作区 remote 仍与用户指定的组织命名空间不同，没有据此推断交付目标。

后续通过已安装的 `/opt/homebrew/bin/osstack` 做只读 RPC 检查：`session list --json` 返回空列表，`loop list --json` 返回五个已停止的历史 smoke 循环。当前连接端点未发现用户所述等待；这不代表其他端点或宿主 AI 会话没有等待。没有用开发 CLI 直接打开或迁移服务库。

## 会话与循环的实际行为

`SessionContinuationRequest` 包含协议版本、`gate_kind`、阶段、拟议下一动作与有限数量的证据引用。`gate_kind` 区分 `phase_continue / task_authorization / risk_approval / external_input`。严格解析拒绝未知授权字段、未知版本及重复 choice ID。没有 continuation 的既有会话事件继续兼容；自然语言 `go` 不被转换成结构化授权。

以下为已有命令新增的诊断字段，安装该开发版本后可使用：

```text
osstack session status <session_id> --json
osstack session snapshot <session_id> --json
osstack session list --json
```

例如一个通过协议校验的阶段请求会展示：

```json
{
  "wait": {
    "reason": "phase_continue",
    "request_source": "agent_reported",
    "automatic_continuation": false,
    "continuation": {
      "version": 1,
      "gate_kind": "phase_continue",
      "phase": "verify",
      "next_action": "Continue to the next authorized phase",
      "evidence_refs": []
    }
  }
}
```

该输出描述请求来源，并未验证 `next_action` 或证据。无类型的决策显示 `unclassified_decision`；普通空闲显示 `awaiting_instruction`；无法恢复显示 `resume_unavailable`。正在处理的轮次不显示等待。投递记录尚未确认时，`delivery_uncertain` 优先于较新的 `delivery_failed`，避免误导恢复操作。

全部发现任务待批准、仅建议或被阻止时，LoopState 增加 `wait_reason.code=discovery_deferred` 和三类数量，STATE.md 显示 Waiting 节。混合任务仍执行已允许的部分；待办消失或获准后清除过期等待原因。既有预算、策略和目标终止优先级保留。

续会话现在纳入 `activeRuns`：`task.cancel`、排空和关闭可以追踪它。daemon 排空时拒绝新的或重试的 `session.send`；已完成的同一消息回执仍可重放。重复消息、陈旧版本和不确定投递继续复用既有会话协议。

## 提案与经验的实际行为

- 新提案使用 `prop_v2_<sha256>`，绑定来源仓库、资产、轨迹、证据及提案定义。跨批次重试保持同一 ID，内容或证据变化产生新 ID。
- 同 ID 不得切换仓库或替换已审定义。重复提出不会把 `approved/applied/rejected` 重置为 draft，迟到的 gate 写入也不能覆盖终态。兼容旧生产者的草稿更新与复发证据追加。
- `improve apply --yes` 仍只执行所选工作目录中的既有 gates。通过时返回 `applied:false / action:gates_passed / implementation_status:not_implemented`，不把“当前仓库测试通过”当作“新候选验证通过”。历史 applied 行原样保留，明确不能追认其实施事实。
- `observation_count` 按新显式记录的来源 ID 去重；当前 CLI 从 failed/escalated 任务生成观察，以 `loop_id` 作为 `source_run_id`。同一 loop 重放不增加次数，相关任务成功也不增加观察或效果验证计数。
- lesson 的读取、去重合并与写入统一在一次事务中。并发旧快照冲突明确返回 SQLite 错误，重试后保留双方观察；没有添加自动重试或吞掉冲突。

### 数据迁移与兼容

Migration 23 只新增 `pitfall_lessons.observation_run_ids_json`，旧行默认空数组。旧 `verified_count` 和 `source_run_ids_json` 原样保留，没有反推使用历史、没有回填新观察。JSON 保留旧 `verified_count` 并新增 `legacy_verified_count`；CLI/dashboard 明确标记历史混合计数不是效果证据。兼容函数 `verifyPitfallLessons` 现为无副作用空结果，内部自动调用已移除。

这是一项向前迁移；测试只在临时 SQLite fixtures 中从 v22 升到 v23。没有打开或迁移用户的服务库。正式安装仍应遵守仓库已有的控制面数据备份与版本兼容流程，不能把 Git 回退当作数据库回退。

## 对下一条自动接续路径的结论

现有三种入口和状态域尚未统一：`agent_sessions` 的可续会话、LoopEngine 循环状态，以及受控交付的 `autonomy_run_projection`。受控交付的本地阶段已复用 LoopEngine，但尚未绑定会话的 turn/receipt 与多轮委托。R3 的单次签名审批绑定精确 diff、phase、nonce；合同的 `approved` 和可传入的 `human:owner` 字符串也不是新的多轮委托身份。不能直接组合这些字段就声称协作者已获授权。

下一条可验收路径是**单一会话的有限阶段计划**：冻结顺序、下一条输入与验收器，以单独的签名委托绑定会话和运行策略；daemon 自行取得验收结果。原子预留预算、检查撤销/版本、保留消息与 dispatch 回执后续接。不得直接把 agent 的 `next_action` 作为下一条有权限的指令。

拟议 dispatcher 的恢复规则：已 applied 的动作对账，尚未发出的动作重检；accepted 或 failed 的自动动作不换新 ID 重发。当前适配器没有远端动作回执查询能力，`snapshot:true` 不能证明投递状态。现有手动 `session.send` 的失败重试规则保留；本批没有实现自动动作恢复器。

当前 session 没有可信 usage 事件，初版可硬限制轮数、验收次数、期限和超时，不能宣称已硬封顶 token/美元。签名私钥、信任配置、控制库和验收器必须在候选执行者的写权限之外；同一 UID 下拥有任意 shell 权限不构成这种隔离。需先绑定实际使用的 adapter 与运行范围，再启用这条路径。

## 验证记录

新增回归均先复现 RED 再验证 GREEN，覆盖结构化交接、排空/取消、未确认投递被遮盖、经验并发丢失、旧库迁移、提案冲突、NEAT 20→21 次复发窗口和已审 Stack 提案复跑。新增 DB、socket 与任务执行测试使用隔离 fixtures，没有调用真实模型或接触服务数据库。

当前工作目录的首次全仓 `pnpm test` 被既有、非本批修改的 `AGENTS.md` 阻断：123 行超过配置的 120 行 warning 预算，`knowledge-hygiene/osstack-config.test.ts` 要求零 findings。该文件保持原样，不降低门禁或删除用户记忆。

最终在提交 `071c1ff` 的独立干净工作树验证，运行时代码截至 `e08f06f`。依赖使用冻结 lockfile 离线安装，再执行 `pnpm -r rebuild better-sqlite3` 准备对应 Node ABI 的原生依赖；测试没有借用原工作区的 workspace 构建产物。

| 检查 | 结果 |
|---|---|
| `pnpm build` | 全仓通过 |
| `pnpm typecheck:check` | 全仓通过 |
| `pnpm test` | 278 个测试文件、2,262 个测试通过，0 失败 |
| `pnpm lint` | 0 错误；2 条既有警告位于未修改的 deployed-home.test.ts 与 upgrade.ts |
| `node scripts/generate-inventory.mjs --check` | fresh |
| `node scripts/check-changeset-coverage.mjs --base c9c3cd2 --head HEAD` | 5 个受影响公开包均覆盖；自检也通过 |
| `node scripts/bench-cli-startup.mjs` | 5 次中位数：version 26ms、help 71ms；预算分别为 150ms、500ms |
| 文档链接、围栏与 `git diff --check` | 通过 |

独立代码审阅发现的未确认回执遮盖、经验并发覆盖、NEAT 滚动窗口与 Stack 已审提案覆盖问题均已修复并补回归。最终复审无新增必须修正项。

测试通过仅证明本批行为与回归符合断言，不证明 OSStack 已获得可泛化的自我提升能力。
