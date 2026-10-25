# “等待决策”自动移植试点规格

状态：V2 待实施的运行时规格；[V2 实施契约](runtime-contract-v2.md)给出确定的事务和身份规则。本设计包提供机器可读场景与注册表校验，不把设计校验称为生产试点通过。

## 1. 试点边界

主要能力：FM-04（等待责任）、FM-08（决策持久化）、FM-09（幂等与未知投递）。支撑能力：FM-01、02、03、05、07、10、11、13、19。

第一条纵向路径限定为 adopt_session：一个本地仓库、默认租户、一个最小 Mission，采纳已经准入的 Task/Run/Session，复用已有 SessionDecision、attention daemon 和回答通道。它不启动初始 Worker，不依赖运行时注册表或 Loop 服务化。用户在 OSStack 入口回答，系统通过原 Session 通道执行回复回合并验证结果。

先支持普通产品选择和外部输入。风险批准、任务授权、运行审批仍经过各自的正式 resolver；不允许通用文本回答绕过它们。远程控制、自动发布与任意 Graph 不作为试点通过的前提。

下一阶段接入 Run approval/clarify 与固定 Graph 暂停节点。只有每类 resolver 的语义测试通过后才能启用该类决策。不能把 Session 的“已应用”语义直接套给 Graph。

## 2. 从原始材料抽取的行为

| 原始素材 | 应保留的语义 | OSStack 的实现选择 |
|---|---|---|
| `fm-classify-lib.sh` 与 `fm-classify-decision-key.test.sh` | 未决问题不能被后来的无关状态覆盖；只解除精确键 | 使用类型化 decision ID、版本和来源；拒绝共享无范围 default key |
| `fm-wake-drain.sh` 与 open-decisions 测试 | 即使事件队列为空，也展示仍未决的问题 | 每次会话恢复从权威存储重建未决视图，不只读新增事件 |
| `fm-captain-hold.sh` | 谁欠决定、原始回答、暂缓和解除都有持久记录 | WaitObligation 引用现有决策权威；保留回答原文与确认对象 |
| `fm-send.sh --resolve-key` | 一个统一回答入口；失败/不确定发送不得悄悄关闭问题 | 所有 UI 共用 resolver；现有 AttentionActions 负责发送预留和回执 |
| `fm-send.sh` 的 inbox/typed plane 区别 | durable enqueue 与确认 submit 是不同投递语义 | 区分回答已记录、传输已接收、Worker 已应用、工作已继续 |
| `docs/architecture.md` 与原始 AGENTS | 监督不断线；空轮询不打扰；有责任归属的等待不当作卡死 | 无模型 watchdog、分类型等待、按条件重查与有上限的提醒 |

上游终止事件可能按其 key/任务所有权关闭某些记录。OSStack 对影响授权与交付的等待采用更严格规则：只有对应权威记录和 clearing predicate 可解除。差异必须记录在注册表；差分测试不能强迫 OSStack 接受更弱语义。

## 3. 最小用户旅程

1. 用户采纳一个已有授权范围的精确 Task/Run/Session。主控登记最小 Mission、交付要求与观察/回答范围。从新目标自动派发另行实施；旧批准合同不会被自动补跑。
2. 工作者提出兼容性问题；Adapter 写入有效 SessionDecision。
3. 控制器记录该问题关联的阻塞步骤。独立步骤可继续。
4. 联络入口显示问题、选项、影响、建议和任务上下文。
5. 用户选择 A。系统根据显示时的交互 token 找到精确问题版本。
6. resolver 检查身份、内容、源版本、任务范围和权限。
7. 同一事务预留发送并记录回答已接收。用户可看到“已收到，正在送达”。
8. 发送器调用既有通道。记录 applied 或 unknown 等回执。
9. 收到适用的应用/继续证据后，满足 clearing predicate 的步骤恢复。主控不会重复启动已有运行。
10. 试点交付精确回合的 ObservationProof；未解决事项仍单列。后续 goal_dispatch 才交付绑定代码候选的检查和工程结果。

## 4. 数据契约

以下是拟新增的协议。实现时使用严格 Zod schema 并生成 JSON Schema。这里不覆盖现有协议字段。

```ts
type DecisionAuthorityRef =
  | { kind: "session_decision"; scope_id: string; item_id: string; item_revision: number;
      session_id: string; turn_id: string;
      decision_id: string; source_version: number; content_hash: string }
  | { kind: "run_approval"; run_id: string; approval_id: string;
      source_version: number; content_hash: string }
  | { kind: "run_clarify"; run_id: string; clarify_id: string;
      source_version: number; content_hash: string }
  | { kind: "contract_approval"; contract_id: string;
      source_version: number; content_hash: string };

type ClearPredicate =
  | { kind: "answer_applied"; action_id: string; source_instance_id: string;
      source_generation: number; message_id: string; completed_turn_id: string; session_version: number }
  | { kind: "approval_accepted"; authority_id: string; subject_digest: string }
  | { kind: "external_condition_verified"; check_id: string; subject_digest: string };

interface WaitObligation {
  wait_id: string;
  mission_id: string;
  revision: number;
  blocked_step_ids: string[];
  owner: "human" | "controller" | "external" | "unknown";
  subject:
    | { kind: "decision"; authority_ref: DecisionAuthorityRef }
    | { kind: "external"; source_id: string; source_generation: number;
        predicate_ref: string };
  clear_predicate: ClearPredicate | null; // 未预留回答时可为空；不得据此解除
  due_at: string | null;
  next_check_at: string | null;
  state: "open" | "deferred" | "answer_recorded" | "delivery_unknown"
    | "cleared" | "superseded" | "needs_reconciliation";
}
```

外部条件分支为后续协议保留；首个试点只接入 `subject.kind=decision`。`continuation.gate_kind=external_input` 仍是需要精确回答的 SessionDecision，不等于外部条件已经满足。

所有时间协议用 UTC ISO 8601；进程内超时使用单调时钟；重启后从持久 deadline 和当前时钟重新核对。时钟回退不能延长 grant 或伪造新鲜度。

资源边界：问题沿用现有 SessionDecision 上限（question 1000 字符、最多 8 个选项，每个标签 160 字符）；回答沿用 attention text 上限；mission 关联、ID、列表上限在新增 schema 明确冻结。采用现有协议时不能偷偷扩大它们。

## 5. 对话与接口

拟新增的服务接口，不是当前可执行 CLI：

| 接口 | 输入与前置条件 | 输出 |
|---|---|---|
| `engineering.adopt`（试点） | 精确 task/run/session、scope、request_id；awaiting_decision 与非空 native ID；completion_level=observed_turn；身份由可信通道提供 | mission_id、revision、已采纳的身份 |
| `engineering.submit`（后续） | goal、repo identity、request_id、期望交付级别与具体派发授权 | mission_id、revision、合同状态 |
| `engineering.observe` | mission_id、cursor、limit；只读 scope 检查 | 状态、开放等待、增量事件、证据引用 |
| `engineering.decide` | mission_id、wait_id、if_revision=mission_revision、含 item_revision 的 decision_ref、action_id、answer、interaction_token | accepted/replay/rejected/unknown；receipt ID |
| `engineering.defer` | 精确 wait version、action_id、revisit_at、reason | deferred；仍未回答，不增加授权 |
| `engineering.cancel` | mission_id、if_revision、request_id | stop_requested；后续独立报告 stop_confirmed |
| `engineering.reconcile` | query_action 查询原 action/receipt；dispose_wait 按 ADR-13 绑定 Mission/Wait CAS、观测快照和 steering 授权 | 已确认结果、unknown 或明确撤出观察义务；不伪造投递证据 |
| `engineering.endObservation` | mission_id、if_revision、request_id；明确结束观察 | observation_ended；不声称成功、不停止源 Worker，保留未决副作用的责任归属 |

回答是 discriminated union：`choice`、`text` 或 `approval_token_ref`。session 普通决定允许 choice/text；风险批准必须绑定合适的 approval token。unknown 类型和额外字段直接拒绝。

交互 token 精确绑定 principal_id、client_session_id、mission_id、mission_revision、wait_id、item_id、item_revision、content_hash、expires_at 和 nonce；与 ADR-04 一致，不混用 wait_revision。服务从验证后的通道推导身份，不接受用户 JSON 声称的 actor。

试点使用明确 choice_id/选项按钮；外部输入问题可提交原文 text。自由文本“继续”不由模型猜成某个选择。有歧义时展示明确问题和选项，不自行授权。批量回答逐项校验和返回结果；不把部分成功显示成全部成功。

API 错误必须可行动：`stale_decision`、`scope_mismatch`、`signed_approval_required`、`source_unavailable`、`action_conflict`、`delivery_unknown`、`executor_not_qualified`、`budget_exhausted`、`cancelled_original_answer`、`dispatch_gate_required`、`not_dispatched_use_cancel`。每项返回事实引用与下一步，不只返回“系统错误”。

产品入口建议为 `osstack chat --adopt-session <id>`，诊断入口可为 `osstack mission status <id>`。后续 goal_dispatch 才支持从新目标开始。这些名字属于提案。保留已有 `attention`、`session`、`loop`、`graph`、`start/control` 命令；不用新命令名称暗示已经实现。

## 6. 三条状态轴

不能用单一 `resolved` 字段表达整个过程。

| 状态轴 | 状态 | 何时可以前进 |
|---|---|---|
| 决策 | open / deferred / answer_recorded / superseded | 有效身份、正确版本、原始权威允许该回答 |
| 投递与执行回复 | none / reserved / dispatch_committed / applied / unknown / cancelled_before_dispatch / abandoned_unknown | 扩展现有 action 的 dispatch phase；applied 是完整回复回合落库 |
| 执行 | blocked / eligible / resuming / running / stopped / unknown | clearing predicate、权限、预算、执行器状态均满足 |

用户回答落盘后，可停止重复要求其回答，但要显示“正在送达”或“送达结果未知”。不能继续显示“等你回答”，也不能宣称“已经继续工作”。

延后只改变提醒安排，不意味着批准。deadline 到期只触发重查或升级，不产生答案。取消请求也不把决定改成通过。

## 7. 事务与现有实现的对接

### 7.1 T1：发现等待

读取权威记录及来源版本。以 `(authority_kind, authority_id, generation)` 建立唯一关联。写入 obligation 和主控事件。重复观察只更新新鲜度，不重新生成问题，不重置首次发现时间。

来源出现 gap、失联或被替换时保留 obligation，并标记证据不足。不能因 source list 暂时为空删除它。解除需要原始明确处置；精确人工回答或授权重规划可按 ADR-07 supersede。仅 turn 前进进入 needs_reconciliation，不是已回答。

### 7.2 T2：接收回答

服务先认证和核对 scope，处理同 actor/同 payload 的幂等回执读取，再检查首次操作的 token 与版本。使用现有 `AttentionActions.reserve` 的校验与预留。重构为能参加同一个 `withWrite` 事务的内部服务接口。在同一事务记录 Mission 的关联和待处理事件。若嵌套事务语义不能保证，先重构事务所有权，不做两个独立 commit 的乐观拼接。

唯一约束：`action_id` 全局唯一且 payload hash 不可变；同一问题版本只允许一个有效回答；同一 authority ref 不能误绑定多个不相容 Mission。重复相同请求返回同一回执；相同 ID 不同正文返回冲突。

普通 Session 回答仍调用 `reserveSessionInstruction`；其 `signed_approval_required` 等拒绝条件必须保留。不能为了自动化改成通用文字批准。

### 7.3 T3：发送

**现有 session_messages / attention_actions 是这次发送的唯一账本。**新增 Mission 待处理事件只引用 action_id，不再独立创建第二条发送任务。

发送器在事务外执行；先按 ADR-05 将原 action 的 reserved 原子转换为 dispatch_committed，检查取消屏障、权限和 daemon fence。新协议 reserved 只可按 ADR-05/11 的完整证明恢复尚未发生的首次派发；dispatch_committed 和 legacy_unknown 永不自动再调用。任何不确定窗口保持 unknown；仅有严格未派发证明才记录 cancelled_before_dispatch。不会换键重发。

### 7.4 T4：应用与恢复

现有 Session 的 applied 表示整个回复执行回合成功并落库。只有精确 action、源实例和新 turn 证据满足时才解除该阻塞边。承载回答的 resume 在 T-dispatch 执行，不以先清除义务为前提。accepted 不能当作 applied，开始执行也不能当作完成。

Session Adapter 已经通过回答继续运行时，主控只观察它，不再启动第二个 Worker。对需要显式 resume 的 Graph executor，使用其独立恢复接口与幂等键，不能复用 session send。

如果候选代码、合同、scope、policy 或授权主体发生变化，恢复前重新验证。仅回答“保留字段”不授权新增发布动作。

### 7.5 T5：完成

试点按 ADR-14 的 observed_turn 条件完成，只输出 ObservationProof，明确“本次回复回合已确认”，不宣称代码工程交付。idle 或 Run terminal 单独都不能完成。新决定继续产生义务；失败、取消、未知分别显示。直接操作源会话但没有本 Mission 的 applied 证据时，可按 ADR-13 撤出旧等待，并明确结束观察为 observation_ended，不伪造成功。后续 goal_dispatch 必须满足同候选检查和工程交付级别，不能用试点证据替代。

## 8. Owner、取消与竞态

| 竞态 | 必须采用的结果 |
|---|---|
| 用户回答时问题被改写 | 旧 hash/revision 被拒绝；展示新版本差异 |
| 两个 UI 同时回答 | CAS 只有一个胜出；另一方得到已回答或冲突 |
| 控制器重启与旧控制器同时执行 | 新 generation 生效；宿主拒绝旧 generation 的新副作用 |
| 用户取消与回答并发 | 以 T-dispatch 与 T-cancel 的事务顺序为准；取消后无新 dispatch commitment；在途动作独立停止，不经 session 指令通道 |
| 授权被撤销但普通回答到达 | 可记录回答事实；禁止执行不再授权的动作 |
| 事件重复或乱序 | 依 generation+sequence+event identity 去重；缺口保留 unknown |
| 重试时任务迁到另一个 repo | subject/scope 校验拒绝，不重定位到相似目录 |
| Worker 自行退出或用户手动继续 | 按 ADR-07 验证精确停止/人工处置证据；无证据保持 needs_reconciliation；不二次恢复 |
| 同时有 B 与 C 等待，B 已回答 | 只解除 B 的阻塞边；C 保留 |

跨任务等待构成有向依赖图。检测环和无责任人的等待。环不自动以“全都继续”解除，应展示最小环与可行动的责任项。

## 9. 自动移植流水线

### 9.1 输入与阶段

```text
固定 upstream commit + 原始脚本/测试/故障记录
  → 变化影响清单（path、symbol、test、行为 ID）
  → 行为契约与差异说明
  → 中立事件场景（不包含执行权限）
  → 上游行为回放 + OSStack 适配后的契约测试
  → 隔离 worktree 中实现缺口
  → adversarial / fault / regression 检查
  → 绑定候选提交的证据包
  → registry 资格更新 + 可审查 PR
  → 合并、宿主资格验证、分阶段启用
```

每个阶段输出持久记录：输入摘要、工具版本、退出码、输出摘要、未解决分歧。阶段失败停止后续资格升级，已生成材料可继续供人工审查。

### 9.2 自动化与人工判断边界

可确定性自动化：固定 Git 对象、许可/路径清单、依赖影响分析、Schema 校验、测试运行、差异报告、证据索引、PR 草稿生成。

可由模型辅助但需可审查输出：从脚本抽取行为、生成规格、提出适配代码、解释差异、生成攻击场景。模型不能自行把行为差异判为“全部兼容”。

必须有独立准入：权限扩大、发布/部署、支持矩阵升级、破坏性迁移、默认路由切换。遵循既有授权和仓库保护要求；不新增每个可逆开发步骤的审批。

初版不承诺任意 Shell 自动编译为 TypeScript。采用受限映射：事件谓词、状态转换、身份/作用域规则、清除条件、测试场景。无法映射的行为生成 `unmapped_semantics` 缺口，并阻断对应能力“完成”的声明。

### 9.3 试点输出

- 三个决策主能力及支撑能力的完整 registry 条目。
- `decision.requested / unrelated.progress / answer.recorded / answer.applied / transport.unknown / controller.restarted` 等中立事件场景。
- 上游实际 fold/wake/send 测试结果。
- OSStack adapter 的契约测试和真实会话证据。
- 语义差异清单：OSStack 的身份绑定与授权要求可更严格，不允许弱化。
- 一条完整用户会话录像或可重放 transcript，外加独立机器回执。录像不能替代机器检查。

## 10. 必测场景

机器清单见 [pilot-scenarios.json](pilot-scenarios.json)。每个场景记录执行层级、delivery_stage 和 owner_work_item。D07/D08 必须通过全部 adopt_session 场景；后续场景仍待各自工作包验收。不能用模型模拟结果顶替宿主实测。

| 场景组 | 场景与预期 |
|---|---|
| 保留 | 无关进度不清除；无关 done 不清除；空队列仍展示；来源短暂消失不删除 |
| 精确回答 | 选项绑定精确 ID；旧 revision 拒绝；旧 content hash 拒绝；跨 scope 拒绝；多问题“继续”不猜测 |
| 授权 | 伪 human actor 拒绝；审批问题拒绝普通 text；授权撤销后不恢复 |
| 幂等 | 相同 action 同正文复用回执；相同 action 不同正文冲突；多窗口竞争一个胜出 |
| 未知 | 发送成功前后断线均保留不确定；重启不重发；查询无证据时仍未知 |
| 恢复 | 有效 applied 只解除目标阻塞；来源 generation 改变需对账；不重复启动 Session |
| 姿态 | away 不扩大权限；defer 不等于同意；无变化轮询不调用模型；返回时展示未决项 |
| 完成 | 检查对象不同不得完成；未决义务不被 done 文本清空；取消未确认不得清理 |
| 压力 | 有界队列、毒消息、时钟回退、最大尺寸、多任务公平性 |

## 11. 试点退出标准

1. 从同一 OSStack 入口采纳已有会话、回答决定并观察回复回合结果，用户没有复制底层命令，也没有选择 Agent。该试点不替代后续从目标自动派发的验收。
2. 上游行为映射、OSStack 测试和负例全部有可复查证据。
3. 至少完成一次真实进程重启、一次实际会话回答、一次模拟传输未知；恢复过程没有重复执行。
4. 模型故障不丢等待；控制器与 Worker 生命周期分离。
5. 支持矩阵逐项通过，不支持的 Adapter 明确拒绝自动恢复。
6. 证据不足时显示 unknown；没有“全部通过”的兜底话术。

## 12. 回退

先关闭新 Mission 的自动执行开关及恢复首次派发开关。保留观察、回答已有决定、停止与对账。把现存任务交还已有 attention/session 入口，并显示其精确 ID。已有 action 的统一派发门保持生效。已经发送的回答不撤销、不重复发送。迁移采用加表/加字段；不通过删除新表让未知副作用消失。
