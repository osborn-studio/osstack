# Graph 契约与上下文：首期冻结方案

基线 `fe0d159d`，独立分支 `codex/firstmate-graph-contract`。本文件是实施合同，未表示 Graph 集成已通过。范围为既有真实 Graph RPC → host registration → effect ledger → 候选冻结 → 独立 checks/review → publication gate 的增量。

## 首期行为与不变量

- 仅支持 implement、local_verified、artifact_only、publication_scope=none、merge_authority=none，且恰好一个 required_check。命令来自已授权 host registry，要求该 ref 对应的原始命令摘要一致、成功码仅为 0。多 check、scout、PR/merge/deploy 明确拒绝；不将一个 shell 成功伪称多项检查完成。
- Contract 文件/请求只声明需求。可信 policyDigest、reviewPolicyRef、Graph limits 和 accepted registry 均由 host registration 提供，并继续调用原有同步 authorize、lease/admission、effect-slot、generation/owner/CAS。
- Graph `commit-tree` 只在独立 artifact object repository 序列化候选；不授予源 workspace commit。实测源 HEAD、refs、index、文件不变，不修改 V2 local 的禁止源提交约束。
- 不改已冻结 v4 compiler、registry-v3、worker wire 或旧 receipt 含义，不新增 publisher。新版本仅为 host envelope/host completion receipt。以后若支持多 checks/topology，必须独立 v5 compiler/registry，保留历史 resolver。

## 公共宿主接口（CLI 内部模块，不新增 package index）

`graph-delivery-contract.ts`：

```ts
interface GraphContractHostPolicy {
  policyDigest: string;
  reviewPolicyRef: string;
  limits: StartGraphRequest['spec']['limits'];
}
interface GraphDeliveryContractRegistration {
  frozen: FrozenDeliveryContractV2;
  policy: GraphContractHostPolicy;
}
```

`GraphHostRegistration.delivery` / `GraphDeliveryOptions` 增加可选 `deliveryContract`。可信 local registration loader 的依赖增加 policy resolver；resolver 不存在时配置了 contract 就拒绝。root bin/daemon 装配提供 committed policy，不从 RPC JSON 接受 policy。

`bindGraphDeliveryContract(request, registration)` 校验 repo/task/goal/base/policy/review/budget_ref、唯一 registry command 和 limits 上界，产生严格 `GraphContractHostEnvelopeV1`。用完整 envelope 的 SHA 构造内部 `inputArtifactRef=graph-contract-input:<digest>`；外部 inputArtifactRef 仍须先等于注册值，作为 sourceInputArtifactRef 保存在 envelope 中。内部 request 因而经现有 computeGraphInputDigest / idempotency / worker identity 绑定 contract。没有 contract 时 request 完全不变。

envelope 包含 version/sourceInputArtifactRef/frozen/policy/registry选中记录；与 graph_public_delivery.descriptor_json 同事务写入。重复请求只有完整 envelope 相同才复用；变更合同/政策同 idempotency key 必须冲突。延迟启动、状态读取和结果验证使用持久 envelope，不能由当前配置替换。工厂/函数不序列化；重新授权仍由当前 registration 提供。

上下文提供 host-only 可选 factory，必须按 run/effect attempt 创建实例。factory 接受真实 adapter、source repo、frozen contract 和实际 task 观察器，返回 wrapped adapter + receipt refs。上下文配置/pins 的完整摘要须纳入 host envelope；默认 off，不检索/写 context receipt。root 集成可复用已交付 execution-context 模块和私有 writer；不是新 provider。

## 切片 G1：准入与耐久身份

源码：新 graph-delivery-contract.ts/test；graph-rpc.ts/test；graph-delivery.ts/test。Root 统一 bin/daemon 接线。首个提交包含纯验证与真实 RPC reservation 反例，不独立宣称执行完成。

1. 在 GraphRpcService.submit 既有可信 scope/task/input/registry 检查后、create transaction 之前计算 frozen envelope；事务内重验 authority 与配置绑定。
2. 将内部 normalized request 与 envelope 同原 public descriptor 保存；已有队列与启动唯一赢家逻辑不变。
3. GraphDelivery 构造及 run 开始验证 envelope/request/run.inputDigest 一致。contractBrief 进入 writer/repair 的真实 prompt；原 task 和固定 feedback 仍必需。
4. paths 在 freeze 捕获前及冻结 manifest 后检查，比较全部候选对原始 contract.base_head 的差异（含 rename 两端、删除、跨 repair epoch 累积差异）。不能只比较上一候选。失败只保留隔离候选。

反例：重复 check、unregistered hash、同命令不同 ref、通过码 1、跨 repo/task/base、任一 limits 超 host policy、同 idempotency 合同换值、构造后外部对象变更、grant 在事务前失效、无 contract 的旧 digest 与结果 shape 不变。

## 切片 G2：真实 completion 与 context

新增 `GraphContractCompletionReceiptV1`，source=`osstack_graph_host`，不能套用 `osstack_loop_host` 或虚构 provider/model。绑定 run/scope/inputDigest/specHash/generation/epoch、contract/policy digest、候选 revision/tree/artifact digest、真实 review/tests 的 effect keys 与 evidence refs、immutable join ref、context refs、achieved_completion=local_verified。

1. `GraphVerificationJoinService.evaluate` 继续从最新 ledger 与 host verification envelopes 计算并 CAS 提交，保持原资格逻辑。
2. GraphDelivery 在 ready 决策后，读取该 snapshot 的真实 envelopes/manifest，校验唯一 command 原文摘要、实际 exit 0、review accept/host verifyReviewer、candidate/epoch/effect attempt、允许路径，写不可变 host receipt。
3. 写 receipt 含 await，之后必须回到原 snapshot 围栏重新核对 authority、generation/owner/revision、lease、worker exit 与 executor inventory。在同一既有 ready projection 事务中引用 receipt。发现变更不能刷新 premise 继续；失败/unknown/repair route 不标 local_verified。孤立 receipt 不是完成证明，只有 DB 已绑定的 receipt 才可读作完成。
4. GraphRpcService.result 以 schema 兼容的已有 evidenceRefs 暴露 `graph-contract:<digest>`，receipt 内容经受授权的 host reader 获取。旧 candidate_ready/ready 仍只意味着 artifact_only。
5. 上下文必须在 reviewer 的实际 task 重建后、invocations.set 记录 hash 前组装。复用 wrapper 的方式是把“记录最终实际 task 的 adapter”放在 context wrapper 内层，最终再调用真实 reviewer；不能在外层包好后仍记录原 plan.prompt。writer 同理。两阶段 prepared/adapter_observed 只证明 AgentTask prompt，不证明 provider wire 或物理停止；原 confirmStopped 委托保持 this。
6. 每份 context ref 绑定 effectKey/epoch/logicalAttempt 与 task/run/session，验证原 bytes SHA。repair/retry 不能复用前次 refs；源 repo 和执行 candidate 路径分别记录。mandatory brief 只出现一次。

实际验收：真实 SQLite + Graph worker + candidate freeze + tests/review，成功与 repair 两条；源 HEAD/refs/index/files 不变；真实最终 adapter prompt SHA 等于落盘回执与 reviewerInvocation；checks 后改 candidate、旧 epoch/retry refs、伪 receipt、取消/unknown、grant 在 receipt await 时撤销、CAS 改 revision 均不能进入 verified。失败保留 artifact/receipt，不清空旧记录或重发未知动作。

## 验证与发布顺序

先 G1 定向单测/RPC，再 G2 真实 Graph suites、旧 compiler/resolver fixtures 与 bounded writer/contained/recovery 回归；变更按需 build/typecheck/Biome。Haiku 5.5 静态挑战保留 exact input/output 与逐项处置。root 最后做实际 local config/bin 接线、全量、schema/startup 与 exact-head CI。未配置外部服务时不取得真实发布、部署或远程 Graph 资格。

回退为移除新注册配置/关闭新 admission；已有 legacy 流程不变，已有 contract run 不可降级成 legacy 或替换合同继续。需保留原 descriptor/envelope 读能力及审计证据，不删除迁移数据（首期无新迁移）。
