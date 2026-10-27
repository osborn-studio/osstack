# 共享接口与可执行契约

本文的函数、v2 配置与字段是**拟议接口**。产品目前没有这些新增入口；不提供虚构可运行的 OSStack 命令。机器 schema/fixture 只校验设计形状，不能签发运行权限。

## 1. 使用先行与接口边界

```ts
// Proposed internal API; this is specification, not installed code.
const proposal = compileMethod({ intent, sourcePin, recipe, repositoryCheckBindings });
const frozen = freezeDeliveryContract(host.resolveContract(proposal, existingAuthorization));
const binding = host.bindMethod({ proposal, frozen, contextConfig, supportProfile, trialPermit });
const result = await host.executeExistingPath(binding); // existing fence/owner/dispatch retained
const evidence = await host.verifyCandidate({ binding, result, requiredArtifacts });
controller.observe(evidence); // no completion solely from a model message
```

调用方只选择用户目标、仓库和授权范围；无需选择 source ID、Graph tuple 或 receipt 路径。错误要能告诉用户缺什么、能否重试；内部字段出现在诊断/证据中。

两个首批使用草图：

1. “修复这个复现稳定的本地问题，验证通过即可。”→复现→修复→相同场景与相邻回归→本地验收。无需先有自动 Mission 派发。
2. “继续已有的等待决定任务。”→按精确问题收集回答→既有 Session 回合继续→记录 observed_turn。工程任务另查候选证据；不因回复出现就报告修复成功。

首期只实现第一种方法 `bug-fix-v1`。feature/refactoring 的扩展、investigation 的只读输出分别验证，不能为了资格先实现四种方法。

## 2. 身份与摘要有向图

| 对象 | 身份/摘要输入 | 权威 |
|---|---|---|
| SourcePin | repo identity、commit、subdir、文件内容摘要、许可与实际采用依赖 | 受信来源加载器；commit 支持既有 40/64 hex 规则 |
| MethodProposal | source pin、recipe version、intent revision、规范化检查映射、artifact 要求 | 纯编译输出，无副作用 |
| Frozen contract | 既有合同规范化规则及 digest | 既有 core，不改变 brief |
| Context config | 已审查模板版本、方法字节摘要、预算、仓库/租户和 source refs | 受信 host 配置；不含未来 Binding digest |
| MethodBinding | 全部严格 Binding 字段（排除自身 digest），见 digest-catalog.json | host admission；只在此处关联授权 |
| Execution receipt | Binding + task/run/session/effect + 实际 prompt/材料摘要 | 实际 adapter 边界观察 |
| CandidateEvidence | receipt refs + base/head/tree/diff/workspace + check registry digest + artifact refs | 可信 host 校验；含独立评审范围 |

顺序为 source→proposal→contract/config→binding→execution→candidate evidence，禁止让早期摘要依赖未来回执或把证据写回冻结 proposal。摘要只是身份和完整性，不是签名，不自行建立信任。

新增对象使用 audit-specifications.md §4 定义的 joint-canonical-v1 与域分隔；重复主键拒绝，字段缺失与 null 不互换。现有合同摘要保持原算法，context config 保持原始文件字节 SHA-256。时间和计数必须为非负安全整数，禁止用浮点或溢出值跨 TS/JSON 边界。

同一 request_id 与同一规范化输入返回同一已记录结果；同 ID 不同输入拒绝 `REQUEST_CONFLICT`。retry 不更换 effect_id。新的范围/方法版本形成新的 proposal，并重新准入；不能复用旧授权做扩大后的动作。

## 3. 方法材料通道（J04）

### 已核实的现状

`execution-context.ts` 将 instruction/safety/contract 作为 mandatory，检索知识作为 optional；默认总 prompt 65536 bytes、knowledge 8192 bytes。`graph-execution-context.ts` 观察实际 AgentTask 并验证 prepared/adapter_observed 两份回执。`graph-contract-host.ts` 从配置内容计算 contextDigest，并在调用边界检查配置是否变化。

### 拟议选择

增加显式版本 2 方法装配配置与 receipt；v1 路径原样保留。host 从受信方法绑定读取固定文本与摘要，方法不经过检索命中决定，也不伪装为普通可裁剪 knowledge。拟议新增 `method` mandatory entry；原始上游内容仍是 untrusted reference，只有已审查的本地模板产生操作建议，建议继续服从合同与 policy。

实际预算实现位于 `packages/knowledge/src/context-budget.ts`：现有 mandatory 数量上限为 3，允许种类也只含 instruction/safety/contract。因此 J04 必须原位增加显式 v2 装配分支，保留 v1 的数量、种类和渲染行为；仅在 CLI 增加字段并不足以接入。方法内引用的原始文本使用可转义的数据块，不能通过伪造结束标记提升为宿主指令。

首期方法预算最多 16384 UTF-8 bytes，计入总 prompt 预算；optional knowledge 保留自己的预算。超限报 `METHOD_MATERIAL_MISSING_OR_OVERSIZE`，不得静默裁剪 method。原任务指令、safety 与合同同样不可裁剪。token window 继续标为未资格验证，字节数不是 token 容量证明。

新 receipt 显式携带 proposal/context digest、方法源摘要、实际 method 字节数、required artifact contract digest。prepared 与 observed 的稳定字段必须一致；host 捕获的最终 task.prompt 摘要必须一致。实际 adapter 未被调用或没有充分回执时不能判定通过。未来 Provider wire 测量要另加证据类型。

wire v2 继承当前完整 receipt 的 task/run/session/capability/adapter、repo/execution_repo/tenant、时间、预算、mandatory/selected/omitted 等字段，另加方法绑定与材料字段；不得用简化对象替换原字段检查。`contract.schema.json` 中的 context_receipt 是新增材料绑定的验收投影 fixture，不能直接作为完整 wire schema 或产品 parser。实施须将上述完整继承关系写入协议，并测试每个原有 scope/identity 字段变异。

新 host profile 必须通过 v1 兼容、新 v2 严格解析、过期/裁剪/篡改/撤权/取消与实际 adapter 探针。Graph v4 的模板/编译输出保持原样；如果实施发现新增数据必须进入程序指令，停止此兼容路径并提出新 tuple，不能偷偷改变冻结版本。

## 4. 检查绑定与主检查

recipe 使用逻辑角色 `reproduce`、`regression`、`acceptance`，不携带任意 shell。每个仓库的已授权检查注册表明确 `role -> registry_ref`，再由原 host 解析实际命令。

- primary 由仓库绑定配置显式指定，必须恰好匹配一个被选中的 required acceptance；缺失、多重或未注册都拒绝。
- `required:false` 表示建议，不进入冻结必需检查；本期不执行隐含的非阻塞命令。用户若选择它执行，重新形成显式检查绑定。
- drive/setup/cleanup 是受控动作，不能冒充按退出码判定的验收 check；各有所有者、参数、幂等和停止语义。
- freeze 在所有映射确定后执行；检查集合、主检查、预算或授权变化必须重新准入。

两仓库反例：仓库 A 使用自己的测试命令，仓库 B 使用不同命令；相同 recipe 只引用角色，禁止复用 A 的 shell 或旧命令摘要到 B。

## 5. 必需产物与完成（J07）

| 产物 | 生成者 | 消费者/拒绝条件 |
|---|---|---|
| intent_frame | 方法规划器；含 observation/hypothesis/unknown | host 验结构与版本；语义评估另用固定 transcript，不能仅看字段存在 |
| reproduction | 受控验证 driver | host 检查任务/环境/命令与失败证据；没有复现就不能声称该 bug 已被修复 |
| candidate_checks | 既有 check suite | host 验 required 全部覆盖、同候选及实际退出结果 |
| independent_review | 分离的 reviewer | host 验对象、版本、blocking findings 处置；身份仅 reported 时如实标记，不认证恶意同用户隔离 |
| cleanup_receipt | 资源所有者/driver | 撤销/完成路径均检查自有资源；cleanup 失败不抹掉已应用效果 |

这些产物位于 host 管理的证据根目录，不进入待验收候选 diff。Worker 提供内容或候选引用；由 host 规范化复制、限长、no-follow/路径检查并计算 digest。Worker 不能任意指定 host 写路径。若报告本身是用户请求的代码仓库交付物，它先成为候选的一部分，再计算最终 tree/diff；不能把验收 receipt 当作候选内容反复重算。

artifact manifest 绑定 kind、相位、producer role、task/run/effect、Binding、字节摘要与大小。intent/cleanup 不强求 candidate；reproduction 绑定 baseline，checks/review 绑定最终 candidate，并通过场景、环境和检查摘要关联。reviewer 通过授权只读引用读取同一内容；删除、替换、跨任务引用、超限或未授权路径都阻止 `local_verified`；baseline 与修复候选不同是合法流程，不能把 baseline 评审作为最终候选评审。缺失不是 warning。

完成由现有系统的可信判断给出：session observed_turn、task local_verified、PR created、merged、published、deployed 分别取证。不得引入一个可以跳过中间要求的统一 done。受控 Git commit 的身份转换继续遵守 expectedHeads/base/tree/diff/workspace 检查；首期没有 commit/publication 权限。

## 6. 首次试验与资格（J08/J10/J23）

状态：candidate → offline_valid → trial_eligible → measured → qualified；active 是只影响新启动的独立选择指针。失败保留 candidate/quarantined，不自动激活。

trial_eligible 由可信操作者通过现有授权机制批准精确的候选方法、合同范围、隔离仓库、host/adapter/profile、预算和有效期。它不要求已有 active recipe，也不授予生产权限。试验许可不得由 planner 自签；许可、操作批准和支持环境证据各自验证。试验执行经过正常 admission，不是 debug 旁路。

J09 是可信开发环境中的受限实验，不能认证 hostile same-UID、远端或生产宿主。J23 在精确支持组合上独立测量；J10 只有证据满足其范围后才能签发 qualified，J27 再决定默认启用。资格保留 source/recipe/template/host/adapter/provider/runtime/schema/check-registry/environment digest、证据与失效规则。

共用来源和资格引用格式；behavior、method、host、executor 各自签发，彼此不能替代。上游未采用插件变化不自动失效；实际采用依赖、运行 host、检查或模板漂移必须重新评估。

## 7. 恢复、预算与迁移

现有 attention/dispatch 为发送权威。方法轨迹只能链接或投影它们。已应用 receipt 优先于后续 cleanup 错误；unknown 保持义务与资源预留，不能新开任务绕过。

主控恢复采用事件重放；历史模型输出作为已记录输入，重放不调用模型和副作用。执行前检查当前 owner、binding、授权、取消和方法版本。取消先提交且有“从未派发”的证明时不执行；已派发时等待真实停止/退出证明。

DEBT02 的操作员恢复合同覆盖旧 attention holds、home 执行义务及未来 broker 孤儿。设计选用增量 operator recovery receipt 表，DDL 先冻结；字段包含 effect/binding/owner/schema/support profile/证明引用/裁决/操作者/时间/幂等键。精确 SQL/迁移编号由 J11 的 schema-spec PR 对当前主干分配，不在本轮占用号码。

恢复对象使用 typed subject：attention_action 绑定 mission/action/message，effect 绑定 effect_id，broker_lease 绑定 broker/lease；不得给旧 attention 行编造 effect_id。恢复回执还须绑定当前 authorization_ref、scope/tenant、目标 home 和实际 recovery build digest。operator_ref 或一个合法 JSON 不是权限证明：可信 host 在事务内验证当前授权、预期 revision 与目标对象，消费幂等键并写裁决；范围或证据不足仍 preserve_unknown。broker 操作额外验证 broker 自己的当前 owner/generation，不能从 home 的接管推导释放权。

J11 先交付目标 DDL/fixture（不运行迁移）→ J12 交付仅能执行白名单恢复账本 bootstrap 的恢复构建与真实 hold 测试 → J13 才允许控制器业务存储迁移。恢复账本例外、完整 phase/decision/proof 矩阵与原 hold 保全见 audit-specifications.md §1–2。broker 使用自己的 schema/recovery 里程碑；只部署 home 时不要求尚未启用的 broker 恢复，但跨 home 支持组合必须两者齐备。旧二进制不能读写/取消新版 DB。

外部效果无法原子包含在 SQLite 事务中，采用 intent→dispatch→receipt/reconcile；不宣称端到端 exactly-once。启动前持久化 effect 派生身份；无法查询、幂等启动或确认停止/容纳的 adapter 禁止自动 start。事务内不调用模型或网络。

## 8. 错误与动作

| 类别 | 处理 |
|---|---|
| INVALID_INPUT / REQUEST_CONFLICT / STALE_BINDING | 拒绝，给出需要重新读取的身份；不自动改 scope |
| METHOD_MATERIAL_MISSING_OR_OVERSIZE / CHECK_BINDING_INVALID | invoke 前失败，修复配置或方法后重新准入 |
| QUALIFICATION_MISSING_OR_EXPIRED | 禁止常规运行；显式选择适用的受限试验路径 |
| PRODUCT_CHECK_FAILED | 保留复现/检查证据，由正常任务修复流程处理 |
| TOOL_UNHEALTHY / ENVIRONMENT_UNAVAILABLE / MAP_DRIFT | 不宣称产品失败或通过；维护责任人处理后重测 |
| EFFECT_UNKNOWN / STOP_UNPROVEN | 保留义务、禁止猜测重试；查询/独立证明/操作员恢复 |
| ARTIFACT_MISSING_OR_MISMATCH | 不完成，保留实际执行事实；不能靠补一句报告转为通过 |

这些是拟议分类，实施时映射已有 recovery.code，避免重复错误体系；机器结果必须保留原始错误、分类、证据、可否重试及下一步。分类器输出也是待验证数据，不获得授权。

## 9. 审计后的规范增量

[审计规格](audit-specifications.md) 明确摘要字节、恢复迁移例外、试验消费事务与预算、材料角色、产物相位、阶段 gate 和原验收继承。J01 必须冻结完整 Recipe/MethodProposal/TrialSupportProfile 与所有产物 body schema；当前 contract.schema.json 是边界 fixture 集，context_receipt 仍是投影，不能直接拿它当完整产品 parser。任何新接口若未通过 `J01.contracts` 的组件冻结与独立验收门槛，依赖它的组件接线 PR 不得合入。仅 J02/J03/J04/J11 可按 [组件分层](gate-layers.md) 的显式白名单消费该门槛；它不证明真实主机授权或任务完成。真实无副作用 admission 边界须经 J08.admission_boundary 的 JA02/JA71；首次完整 trial 仍须先通过保留原 JA01/JA02 的 J01.scoped，满足 J08 原恢复/预算等门槛，并由 JA72 证明复用同一受检入口。任何组件资格都不能直接开启方法执行或绕过原 host/release gate。

修订 3：[复审精确规格](closeout-specifications.md) 明确恢复后态、Graph 消费事务、原 gate/case 消费边及 oracle 生命周期；与旧表述冲突时以此增量及同步机器文件为准。
