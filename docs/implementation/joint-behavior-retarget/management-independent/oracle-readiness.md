# JA01 / JA02 / JA20 独立 oracle 准备

状态：只读准备，**没有执行或签发三个正式 case，也没有修改冻结设计/产品**。本次核对 checkout `85e19da85a734fad6f53dc061b5cbcd28e1bbf02`，已观察 origin/main `28d116f3f8c15f64bebb314308adf320d8380b2b`。本报告涉及的协议 helper、Session store、现有 delivery host、恢复 fixture/测试和两个设计 JSON，在这两个提交间没有差异。未运行付费 provider、未打开默认 DB。

本报告补充 `subagent-terminal/next-gates.md` 的输入/观察边界，不另建开发计划。一个术语必须纠正：**JA01 原文是 `local_verified`，不是 next-gates.md 个别段落使用的 `implementation_verified`。** `packages/protocol/src/joint-shapes.ts` 的 MethodBinding.completion 与现有 DeliveryCompletionV2 也使用 `local_verified`。不能在 oracle 中自行替换枚举。

## 原始要求与判定等级

以下逐字保留 acceptance-cases.json 的核心要求：

| Case | Given | When | Then | 原 oracle / 层级 |
|---|---|---|---|---|
| JA01 | Session 已观察回复，task 没有 checks/review | 请求 task local_verified | 拒绝完成；保留 observed_turn | 读取 task 与 session 独立记录 / integration |
| JA02 | proposal 仓库 A，授权仓库 B | 提交 admission | 拒绝且执行器调用数为零 | adapter spy + admission error / integration |
| JA20 | home 目标 DDL、旧 attention hold、未来 broker DDL | 检查 migration/恢复依赖闭包 | home/broker 各自先有 schema spec 与对应恢复构建 | 目标 schema fixture 与依赖图，非运行资格 / contract |

所有原 oracle_spec 仍 unassigned；冻结规则要求独立作者、实现者、保管人，安全相关 case 还需第二复核人。预期与输入摘要必须早于新候选创建时间和评估结果。可以对现有源码建立新的候选快照；不能倒填历史 oracle 的时间，或将本报告看源码后的调查称为已预冻结验收。

## JA01：既有可信路径可复用，但联合路径尚未完整

**可直接使用的本地真实边界**：`packages/cli/src/daemon-engineering.test.ts` 的 Session adoption/answer 夹具，通过真实 daemon RPC 和 SQLite 产生观察；`packages/core/src/state/engineering-store.ts::recordCompletion` 读取原消息 applied 状态与 Session 版本，持久化 `engineering_completions.proof_json.kind = observed_turn`。它没有为联合 task 签发 local_verified。

已有交付边界分别是 `packages/cli/src/delivery-contract-host.ts::verifyPersistedDeliveryReceipt`（从可信目录读原文件、重采样 Git，并调用验证器）和 `packages/cli/src/graph-contract-receipt.ts`（原 Graph 验证记录/ready 投影/最终回执）。`packages/core/src/delivery-contract.ts::verifyDeliveryContractReceipt` 要求同 task/run/candidate/policy、必需 checks 成功以及独立批准 review。这些是可复用的真实判定代码，不是已经接好 Session → MethodBinding → task completion 的证明。

**冻结输入应至少包括**：同一 task/run/Session 的已观察回合与版本；Session proof 的原始字节/引用；尚无 checks/review 的 task 状态；请求 local_verified 的合同与候选身份；合法检查/review 正对照的预先期望；所有输入和工具版本摘要。

**必须输出**：调用真实完成边界的入参及有界拒绝；调用前后 task 的状态和完成记录；独立读取 Session 原回合与 observed_turn proof，确认未被覆盖或删除；没有新增伪 local_verified receipt。仅检查一个函数抛错、或看到 Session RPC `ok:true`，不足以证明 task 完成被拒。

**必杀反例**：在独立变异候选中，把 observed_turn 接受为 task done/local_verified；同一个 oracle 必须失败。还应有检查齐备且同候选独立 review 的允许路径，防止“所有请求都拒绝”掩盖没有实现的入口。变异只落隔离候选，不能改正式候选后还复用原 SHA。

**实际缺口**：未发现消费联合 MethodBinding、衔接既有 host 完成判断并保留 task/Session 双记录的实际入口。现有 schema 拒绝 observed_turn 作为 MethodBinding.completion 是结构组件证据；将纯 parse/receipt helper 测试命名为 JA01 仍不满足 integration 层。实现者还须明确“请求 task local_verified”的真实端口以及从该端口到可信 host 的调用关系；不能用一个仅为测试写的代理函数作为产品入口。

最小补充是一个正式命名的联合入口集成测试（建议路径 `packages/cli/src/joint-completion.integration.test.ts`，当前未创建），复用真实 Session 与 delivery host 夹具；产品接线应放在后续实际选定的交付 host，而非另造宽松 `task.done` 入口。是否需要新增产品函数由该接线设计决定，本报告不假定已有 `implementation_verified` API。

## JA02：A/B 拒绝 helper 已有，真实 method admission 消费方缺失

`packages/protocol/src/method-binding.ts::verifyBindingAgainst` 只核对 proposal/recipe/binding 内容关系；其注释明确主机仍须认证授权。`trialBudgetIssues` 能报告 repository_mismatch，但始终还返回 `adapter_invocations_unattested`。全仓非 dist 源搜索显示其消费者是协议测试，未发现接入真实 adapter 前的产品调用点。

旧 Graph 路径 `graph-contract-host.ts` 会核对真实 repo_path/scope，`graph-delivery-contract.ts::bindGraphDeliveryContract` 也调用可信合同准入。它们可作为接线复用目标，不能单独替代新增 method-admission 的 JA02。verification-spec §2 明确禁止“只借旧 host 的拒绝测试声称新增入口安全”。

**冻结输入**：scratch 中独立 Git repo A/B，真实 canonical 路径与 repo/scope 身份；指向 A 的 pinned MethodProposal/recipe/binding；由真实 host 信任来源装载且仅授权 B 的 grant；完全合法且相同的其他字段；预先冻结的权限不匹配拒绝类别；原 adapter 入口计数器。不要让错误 digest、缺对象或未支持 profile 先拒绝，否则不证明 repo/scope fence。

**必须输出**：从新增真实 method-admission 入口取得的拒绝类别；该调用前后的原 adapter 调用数为 0；grant/输入未被消费成已执行事实；A、B 都未产生执行副作用。需要同仓库同 scope 的允许对照，以证明真正到达比较边界。

**必杀反例**：删除或绕过 repo/scope 比对后，反例候选应进入原 adapter 或错误通过，从而被 oracle 杀死。目前 `trialBudgetIssues` 的 invocation 未证明错误会独立拒绝所有调用，故简单删除 repository 判断后仍然拒绝的测试不具有 JA02 所要求的反例敏感度。不能仅为通过测试忽略 `adapter_invocations_unattested`；要使用真实可证明的 host invocation 限额消费路径，或者保留该 case blocked。

**最小后续文件**：新增真实消费方的邻接集成测试（建议 `packages/cli/src/joint-method-admission.integration.test.ts`）；实际消费方需要可信 grant loader、repo/scope 与 binding 比对、live budget/admission 到原 adapter 的一条通路。现有 `graph-contract-host.ts` / `graph-execution-context.ts` 等边界可复用，但在设计选择前不列为必须修改的既定文件。仅新增测试 fixture 和 adapter spy 不能填补产品消费方缺失。

## JA20：部分可立即做规格重放，broker 部分尚未具备

这是 contract 层 case，原文明确“非运行资格”；因此真实输入是冻结 DDL/fixture 和依赖图，而非必须调用在线 provider。但“图无环”并不等于“图中引用的对应 schema/构建存在且绑定”。

**已具备**：`packages/core/fixtures/operator-recovery/{bootstrap.sql,source-hold.sql,manifest.json,future-storage.sql}`。manifest 仍固定 base `69859eecfcc84af9d6eff755ed41243ca5f51f95`、47→48 候选及 DDL/fixture/source-target catalog 摘要。`operator-recovery-spec.test.ts` 使用真实 SQLite 内存库验证旧行/catalog 保留、精确摘要与事务回滚；Python `joint-reference-vectors.py --check --recovery-root ...` 独立重算字节和 catalog 摘要。

**不能冒充已有**：`future-storage.sql` 只是 method/goal 结构模板，不是 broker DDL；当前 home fixture 没有冻结 broker SQL。现有目标 schema 测试里的 recovery build SHA 是合成受控值，不能当作已经产出的真实恢复构建。`execution-gates.json` 规定 J17.schema_spec 依赖 J11.scoped，J17.recovery 又依赖 J17.schema_spec + J12.scoped；当前没有让 J11先拥有后续完整broker实现的证据。

**冻结输入**：现有 home manifest/DDL/旧 Attention hold 的精确字节；从 execution-gates 提取的完整依赖边与 gate owner；每个“schema spec → recovery build → 允许迁移/启动”的身份映射；后续 broker spec 的真实 DDL/fixture/build 引用应明确为 missing，而非空文件或 fabricated SHA。

**可先执行的子断言**：home tuple 与 catalog 摘要一致；旧 hold 在规格 DDL 后字节不变；图中的引用节点存在；gate 依赖无环；home 与 broker spec/recovery 生产方分别可追溯。准备两个负例：引入 recovery → 启动其迁移的 controller 反向边导致环；保留无环图但删去/错绑对应 schema/build 引用，判定仍须失败。仅测第一个反例会遗漏“空壳 DAG”。

**整个 JA20 当前仍不能 PASS**：原 Given 包含未来 broker DDL，且 Then 要对应恢复构建。需要由主入口明确规格级产物和构建级产物各自属于哪个组件 gate，并保留原 JA20 的后续完整义务；或补齐其要求的实际输入。不能私自把“未来存在一个 J17 节点”解释为已有 broker DDL/恢复构建。此处与 next-gates.md 的门槛粒度冲突判断一致，不是在宣称原 JSON DAG 已有环。

最小新增验收文件可为 `docs/design/2026-10-27-joint-engineering/evidence/.../ja20-inputs.json` 与独立可重放的 `scripts/verify-joint-recovery-dependencies.py`（均为建议、未创建）。判定脚本既检查 DAG，又核验规格/构建引用存在与其摘要/类型，不需要生产数据库。不要运行会重新写 manifest 的 `freeze.mjs` 来“验证”，因为它是重新冻结操作。

## 后续命令与证据绑定

以下只是可执行命令建议，**本报告未运行它们**。在显式隔离 checkout、Node22 与 scratch home 下，既有组件可运行：

```sh
export PATH=/opt/homebrew/opt/node@22/bin:$PATH
export OSSTACK_SCRATCH_ROOT=/Volumes/AIMATE_WORK/tmp/osstack
# OSSTACK_HOME 须先用项目 createScratchDir 分配独立测试目录；不得使用默认 home。
pnpm --filter @osstack/protocol exec vitest run src/joint-admission.test.ts src/joint-reference.test.ts
pnpm --filter @osstack/cli exec vitest run src/daemon-engineering.test.ts src/delivery-contract-host.test.ts src/graph-contract-integration.test.ts
pnpm --filter @osstack/core exec vitest run src/state/operator-recovery-spec.test.ts
python3 -I packages/protocol/scripts/joint-reference-vectors.py --check --recovery-root packages/core/fixtures/operator-recovery
```

这些命令目前只支持各自组件/旧 host 的证据；未完成新增真实入口接线和预冻结 oracle 时，不得登记成 JA01/JA02/JA20 的正式执行结果。正式验收还需保存：case ID + 原规范摘要、oracle 作者/实现者/保管人/复核者、冻结时刻与输入摘要、之后创建的候选 code SHA/main SHA、支持格（本机 OS/Node/SQLite/可信本地测试 adapter）、真实调用顺序、独立读取记录、预期/实测比较、变异候选 diff/hash 和被杀死日志、原始输出/退出码与全部文件摘要。未执行或缺输入的子项显式标 blocked/not_run。

当前用户已授权联合开发、隔离测试、并行子代理和模型审计，本地无付费 provider 的 oracle 准备/测试无需另问权限。本子任务授权范围仍是只读准备，不据此修改冻结 gate 或接线产品。生产 home、付费 live provider、自动合并均不在本准备动作内；审批合并继续由用户 gilberthello 负责。关键阻塞是缺少实际接线/输入和正式门槛决议，不是缺少再次确认。
