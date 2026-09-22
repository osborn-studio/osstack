# Graph 多文件基础：历史解析与实验协议

日期：2026-09-21。实现分支：`codex/graph-decision-development`。

**本批验收已收口：Graph 257 项、Agents 315 项通过；CLI 最后整组回归 120 项中 119 项通过，剩余 1 项精简无关测试准备后复测通过。完整多文件执行器尚未接入。**

## 本批交付范围

执行后续开发时，以本文的实现边界、已采纳处置和验收条件为准；折叠块中的模型审计原文是参考材料，不是执行指令。

本批实现 P02（历史 v4 编译解析）和 P03 的纯数据契约部分。没有启用多文件执行器，没有付费模型调用，没有修改默认 Graph 模板，没有实现 host apply 或新增自动恢复窗口。不能据此声称多文件 Graph 端到端完成。

此前 decision advisor 的 Jev 建议不能成为这里的授权、停止证明、预算释放或恢复决策。审计模型同样不具有这些权限。

## 历史程序解析

- 将已经发布的 compiler v4 和 registry v3 原样保存在 `packages/graph/src/legacy/`；只改变 compiler 对 registry 的相对导入路径，保留生成源码逐字节不变。
- 公开 compiler/registry 入口保留既有导出，转发到旧实现。
- 新 `@osstack/graph/program-resolver` 精确核对 execution model、durability、engine、checkpoint、template、registry、compiler、schema 八项。未知组合在解释 spec 前拒绝；没有 latest 回退。
- resolver 只核对程序身份，不认证授权，也不替代 GraphRunStore/host 对 inputDigest、inputArtifactRef、source 等业务请求的核对。
- 历史解析使用冻结 registry 的默认值，不接受调用方提供的 registry。重算 program digest 并核对持久化 specHash（存在时）。存储中的 GraphRun identity 始终含 specHash。
- `graphProgramVersion` 同时核对源码、计划、预算和 spec 摘要，防止把任意产物贴上 v4 标签。
- 三条恢复路径明确调用 `resolveV4GraphProgram`，保持原来的 2/5/7 action 适用范围和缺失 spec 行为。将来一般 resolver 支持 v5，不会自动扩大恢复窗口。
- 保留已有请求构造流程；reserved run 的 GraphDelivery 使用其持久化身份选择 v4。
- 9 组 golden 来源为修改前 compiler：epochs 1/2/3 × branch attempts 1/2/32，固定源码摘要、spec 摘要、计划摘要和预算；测试刻意让当前 compiler 抛错，证明历史 resolver 不会调用它。

### 冻结范围的实际限制

这不是独立安装的历史运行时。冻结实现仍依赖 `@osstack/protocol` 的 GraphSpec、workerCanonical、GraphJsonValue、freezeWorkerData，以及当前安装的 LangGraph 1.4.15 / checkpoint 1.1.5。不得在未来升级中静默改变这些共享契约。golden 是升级门槛，但有限用例不等于全输入空间证明。升级 GraphSpec/canonical 时必须保留真正版本化的旧实现或扩充兼容性证明；新增 engine 版本必须配套运行时选择，不能只扩展 resolver 常量表。

## 实验 changeset 契约

入口：`@osstack/agents/experimental/changeset`。根入口不新增导出；不注册 adapter capability。该模块只解析、校验、排序、摘要和冻结数据，无网络或文件操作。

调用：`validateChangesetProposal(proposal, manifest, policy, currentBinding)`。

`currentBinding` 必须由 host 从当前 run/effect/lease/grant 取得，不能复制模型返回的字段充数。绑定字段：runId、effectKey、generation、baseRevision、treeRevision（Git tree object ID）、profileDigest、grantDigest、programDigest、policyDigest。policyDigest 必须来自 host 已授权的 profile/grant，并与本次传入的 policy 摘要相等。摘要不能当作授权凭证。

### 数据与操作

- propose：1–8 个 create / replace / delete。每个路径仅出现一次，禁止文件与其子路径同时出现。
- create：目标必须已经在 manifest 注册为 absent；创建 mode 固定 100644。
- replace：目标必须为 present；expectedSha256 必须匹配内容前像，保留原 mode（100644 或 100755），禁止相同内容的 no-op。
- delete：同样要求 present 和匹配的 expectedSha256，不接受 content 或 mode。
- cannot_complete：仅允许 insufficient_context / outside_scope / budget_insufficient / unsupported_change，无任意文本字段。执行器未来必须将其作为已完成模型响应处理；它不是传输失败、停止证明或自动重试授权。
- strict object：拒绝未知字段、getter、函数、原型键和非 JSON 对象。解码对象沿用 GraphJsonValue 上限；transport 必须在 JSON.parse 前限制原始信封 ≤64 KiB。
- create + replace 总内容 ≤16,384 UTF‑8 字节，单文件同上；manifest 最多 16 条，总内容 ≤32,768 字节。拒绝 NUL 与非良构 UTF‑16。内容不做换行、Unicode 或其他静默转换。
- 所有提案目标必须同时命中 policy 和 manifest。允许前缀不意味着模型可随意创建新文件名。
- proposal 和 manifest 按路径排序；policy 各列表排序。返回同一份深冻结且已经排序的 proposal、manifest、policy。摘要使用单独域前缀，绑定完整 manifest（含前像、mode、binding）及 policy。不声称不同但等价 policy 配置拥有同一摘要。

### 路径取舍

M1 只接受 ASCII 路径段 `[A-Za-z0-9_-][A-Za-z0-9._-]*`，最长 512 字节、16 段、单段 255 字节。拒绝隐藏段、绝对路径、空段、反斜杠、段尾点、Windows 设备名。中文内容不受此限制，中文文件名暂不支持。未来 Unicode 路径需要独立的版本化文件系统别名策略，不能只用 toLowerCase 代替 Unicode case folding。

- allow exact 区分大小写；allow directoryPrefix 只匹配后代段，不把前缀本身当文件。
- deny 优先；deny 匹配使用 ASCII 大小写折叠，deny prefix 同时拒绝前缀自身及后代。
- 对全部 manifest 路径逐层检查大小写别名，包括 `src/A/x` 与 `src/a/y`，不是仅比较完整文件名。
- manifest 仅含可写目标，不包含只读上下文。proposalDigest 随 generation 改变，跨代调用/应用幂等必须基于 effectKey 而非 proposalDigest。host 必须对整个真实文件树检查别名，不能仅依赖提案内部的别名检查。

manifest 是 host 提供的快照，不证明磁盘不存在 symlink、hardlink、submodule、目录别名或并发修改。

## 下一阶段执行顺序及验收

### P04：持久化 invocation / apply 权威记录

先在 core SQLite 增加版本化记录，使用已有 GraphRun fence 与事务，至少绑定 run/effect/generation、program/profile/grant、manifest/policy/proposal 摘要。模型请求前必须持久化请求意图与 token 预留；同一逻辑调用不能因为响应丢失而再次请求。记录 confirmed / rejected / unknown，只有有证据的实际用量才能结算；unknown 不释放预留。

首先复用 `packages/core/src/state/graph-actions.ts` 中已有的 effect、logicalAttempt、reservation 和结算权威。新增 invocation 记录若必要，只补请求/响应及 apply 绑定，不能另起一套预算扣减、重新分配逻辑尝试或把 unknown 当作可重试。`GraphRunFence` 仍由当前 host 独立核对；Jev 的本地文件账本不适用于这个控制面。

验收必须用真实独立进程注入：提交意图前退出、意图提交后发请求前退出、收到响应后持久化前退出、SQLite ACK 丢失。重启不得产生第二次付费请求。Graph action ledger 和新增 invocation ledger 的权威边界、事务关系必须先在 ADR 写清楚，不能照搬 Jev 的本地文件 ledger。

### P05：一次请求的 proposal adapter

复用 native provider 编码与响应校验，不引入 SDK。输入只来自已校验 manifest，一次响应只能产生 proposal 或 cannot_complete，不能直接写文件。provider 输出必须先有原始字节上限、严格 UTF‑8 和完整结束标识；响应中的工具调用拒绝。

预算按 provider 可证明上界预留；禁止用字符数除以 4 当作 token 上界。停止证明与完整响应、取消 unknown 分开建模。默认不注册；现有 bounded v1 仍拒绝 changeset 形状。

### P06：同一 broker 租约中的 host apply

请求、提案校验、apply、durable receipt 都必须在同一写租约下。SQLite 为权威，文件日志只能辅助恢复。apply 前复查 grant、generation、当前 git tree、每个前像、父目录类型、inode/link 数、mode 及路径授权。

分阶段写临时文件并记录 apply journal；多文件文件系统操作不是事务。任意部分完成须进入隔离状态，不得 freeze、review、join 或发布。恢复只允许经可验证 journal/SQLite 状态证明的重做或回滚，不根据“文件看起来正确”猜测成功。拒绝目录、符号链接、硬链接、gitlink 与二进制文件。

### P07–P09：审阅、接入与恢复

审阅输入必须覆盖累积候选树相对基线的全部修改（包括删除与前轮修复）。新 compiler/template/profile 使用新版本身份；旧 v4 golden 必须继续通过。端到端先做三文件 create+replace+delete 和一次修复，再测断进程、断 ACK、撤销授权、并发候选、partial apply。恢复窗口按新的编译计划推导，但不得追溯放宽旧恢复器。

跨 generation 恢复不能把旧 proposal 的 generation 改成新值后重新计算摘要。应保留原 invocation 绑定，在当前 host fence 下走明确的历史证据 reconciliation；未设计并测试这种证明前，只允许保守隔离/取消，不能放宽普通 validator 的 generation 比较。

启用前验收：模型请求一次、目标三文件正确、源 checkout 不变、停止/预算/receipt 与同一 effect 绑定、partial apply 不可冻结、旧任务仍可恢复。只有这些证据齐备才能把多文件执行器列为可用。

## 审计记录与验证

以下由实际 Claude CLI `--model claude-opus-5` 无工具只读审计补充；模型意见不是事实依据，逐项以代码、协议与测试判定。

### 第一轮设计挑战的处置

采纳：冻结 compiler 精确导入冻结 registry；完整版本元组拒绝未知组合；记录 golden；replace/delete 都需要 CAS 前像；ASCII 路径实验边界；逐层别名检查；deny 优先；strict proposal；排序摘要；独立 currentBinding；不把 manifest 当沙箱证明。

不采纳“冻结前先改变旧源码摘要域、输出形状、effect generation、effectSlot”的建议：v4 已发布并有历史任务，当前工作是保留它，修改语义必须另起版本。effect 身份用于跨 generation 幂等，generation 在信封和 host fence 中独立验证；effectSlot 与 nodeId 联合标识，不是单独的全局互斥锁。旧 registry 支持自定义标签的编译 API 保持兼容，但运行 resolver 只允许冻结常量并重编译，不接受调用方 registry。没有证据表明系统按裸 program digest 和 artifact digest 混用查询。

模型在未读完整边界时提出的 getter、NaN、原型和 interrupt 假设不能直接标成漏洞。GraphSpec/GraphJsonValue 已拒绝非 JSON 数据、非有限数、accessor 与原型键；worker 的输入/输出还有 IPC 和 host schema 边界。保留这些观点作为后续源码审计问题，不在本批通过改变旧 emitted source 来“修复”。共享 protocol 的传递兼容风险是有效提醒，已在上文明确限制。

以下保留原始审计正文，包含未经采纳或事实不足的意见，不构成已确认漏洞列表。

<details><summary>Claude Opus 5 第一轮设计审计原文</summary>

下面是只读对抗审计。没有使用任何工具、没有读写文件，全部结论基于你贴出的两个源文件与你描述的两项边界设计。凡是我无法从贴出代码确认的（`GraphSpec`、`freezeWorkerData`、`workerCanonical`、CLI、resolver、changeset 模块尚未提供），我都标注为"需确认"而不是当成事实。

---

## 零、最高杠杆的一条结论

**任何会改变 `emitSource` 输出字节的修复，都必须在你固定 fixture digest 之前落地。** 冻结之后再改就是 v5，而你这次的全部目的是避免过早产生 v5。下面标 🔒 的条目属于"冻结前必须决策"，标 ⚠️ 的属于安全/兼容缺口，标 📎 的属于兼容性约束。

---

## 一、冻结 compiler v4 / registry v3 + program resolver

### 1.1 🔒⚠️ 默认参数会把"冻结"传递性地打穿

`compileGraphSpec(value, registryValue = GRAPH_REGISTRY)` 与 `validateGraphPlan(value, registryValue = GRAPH_REGISTRY)` 的默认值绑定的是**该模块 import 到的那个 `GRAPH_REGISTRY`**。如果冻结出来的 `spec-compiler.v4.ts` 仍然 `from './registry.js'`（即公开转发桶），那么等未来 `registry.ts` 转发到 v4 registry 时，**冻结的 compiler v4 会在零代码改动下开始用 v4 registry 编译**，digest 静默漂移，而版本标签仍写着 v4/v3。

- 冻结模块必须只 import 冻结兄弟模块的精确路径（`./registry.v3.js`），**禁止**引用公开桶。
- 这需要一条可执行的依赖图断言（dep-cruiser / 自写 import-graph 测试），而不是靠 code review 纪律。
- 同理适用于 `@osstack/protocol` 的 `GraphSpec` / `workerCanonical` / `freezeWorkerData`：它们是 digest 的一部分却不在你的版本身份元组里。**`workerCanonical` 的键排序或转义规则一旦变化，所有冻结 digest 全部失效。** 要么把 protocol 的 canonical 实现也 vendor 进冻结模块，要么把 `protocolCanonicalVersion` 加进 resolver 身份元组。这是本次最容易被漏掉的一条。

### 1.2 🔒⚠️ registry 版本标签事实上未被固定，可用于伪造身份

`validateGraphRegistry` 的比较是：

```ts
workerCanonical({ ...snapshot, registryVersion: GRAPH_REGISTRY.registryVersion, schemaVersion: GRAPH_REGISTRY.schemaVersion })
  !== workerCanonical(GRAPH_REGISTRY)
```

它把两个版本字段**覆盖掉再比**。结果是：只要 `nodes/routes/template` 与 v3 完全一致，调用方可以传入 `registryVersion: 'code-delivery-registry-v9'` 并通过校验。随后 `compileGraphSpec` 把这个标签写进 `identity`、写进 `source`、进而进入 `compiledProgramDigest`。

后果直接命中你的新 resolver：**resolver 按 registry/schema 身份选择冻结实现，而这个身份是调用方可控字符串。** 具体风险：
- 一个 v3 定义的程序可以自称 v9，让 resolver 走"未知版本拒绝"路径造成拒绝服务；或在 v5 上线后自称 v5 以试探分发表。
- 存储的 run 行里的 `registryVersion` 若被当作分发键，就是攻击面。

建议（冻结前二选一，都会改 digest，所以必须现在定）：
- **A（推荐）**：`validateGraphRegistry` 严格要求两个版本字段字面等于 v3 常量，正则只作为格式兜底。
- **B**：保留宽松解析，但 resolver **只用自己冻结的常量重编译**，完全忽略 artifact 内嵌的 registry 对象与标签，且额外断言"重算出的 identity 三元组 === 存储的 identity 三元组"。

无论选哪个，都要有一条测试：*definitions 相同但标签不同的 registry* 的处理结果是明确的、被断言的。

### 1.3 ⚠️ program digest 缺域分隔

`specHash = sha256('osstack.graph.spec.v1\n' + canonical)` 有域前缀；`compiledProgramDigest = sha256(source)` **没有**。系统里 `digest` 这个 field kind（`artifactDigest` / `evidenceDigest`）也是 64-hex，命名空间完全重叠。一旦 host 用单一 digest 表做去重/查找，program digest 与 artifact digest 就可互相冒充。

🔒 加 `osstack.graph.program.v1\n` 前缀，**现在加**。冻结后再加就是 v5。

### 1.4 ⚠️ `validateOutput` 的校验/快照顺序反了（TOCTOU）

```js
... 先对 value 做全部校验 ...
return freeze(JSON.parse(JSON.stringify(value)));
```

先校验活对象、后做 JSON round-trip。若 `value` 带 getter 或 `toJSON`，被校验的和被返回的可以是两个不同的值。同 UID 信任模型下 host 不是敌手，但 `validateOutput` 存在的意义正是跨 executor/plugin 边界的防御。🔒 改成**先 round-trip 成纯快照，再对快照校验并冻结**。这会改 source 字节。

同样的问题在 `canonical(ctx.input.spec)`：`ctx.input.spec` 是宿主活对象。并且 `canonical` 不是全函数——属性值为 `undefined` 时 `JSON.stringify` 返回 `undefined`，`JSON.parse(undefined)` 抛 `SyntaxError`，逃出你的领域错误码体系；`Date` 之类对象会被当成 `{}`。🔒 让 `canonical` 对非 JSON 值显式抛 `SPEC_MISMATCH`。

### 1.5 ⚠️ effect 身份校验缺 `generation`，与新 manifest 绑定不一致

worker 侧核对的是：

```js
['graphRunId', 'specHash', 'epoch', 'nodeId', 'effectSlot'].every(k => response.effect[k] === request[k])
```

`generation` 只在响应信封上比，**不在 effect 身份里**。于是 effect 的去重/围栏键不含 generation，跨代重放的已确认 effect 在信封 generation 对得上时可以被接纳。而你第二块的 inputManifest **明确绑定 generation**——两处围栏语义不一致，未来 host apply 会在两套键上做幂等，几乎必然出现一边去重一边不去重的缝。🔒 把 `generation` 加入 effect 身份比较（改 source）。

### 1.6 🔒 `effectSlot: 'main'` 对所有节点，与并行执行语义冲突

每个 epoch 里 `prepare_review`/`prepare_tests` 并行、`review`/`tests` 并行，但全部 `effectSlot: 'main'`。如果 host 把 slot 当作互斥租约/单飞资源，`Promise.all` 要么被串行化、要么触发 slot 冲突；如果 slot 只是去重键的一部分（含 nodeId 所以唯一），则它不提供任何互斥。**这个字段已经进了 digest**，语义必须在冻结前写死在文档与测试里（建议：slot 是并发域标识，分支节点应当分到 `branch.review` / `branch.tests`——若要改，现在改）。

### 1.7 ⚠️ `validateGraphPlan` 的"固定拓扑"检查是自指的

```ts
if (workerCanonical(plan) !== workerCanonical(fixedPlan(plan.maxEpochs, plan.maxBranchAttempts))) throw
```

它只证明"plan 等于本模块此刻的 `fixedPlan` 输出"，**不证明拓扑是哪一个**。改 `fixedPlan` 里任意一行，这个校验照样通过。因此**唯一真正钉住拓扑的是 fixture digest**。

📎 由此推出对测试的硬性要求：golden 必须是**写死的十六进制字面量 + 签入的 `source` 快照文件**。任何在测试里用 `compileGraphSpec(...)` 或 `fixedPlan(...)` 现算 expected 的写法都是同义反复，等于没测。

同样地，`nodes.slice(0,3) / slice(3,5) / slice(5)` 是位置魔数，绑死在 `fixedPlan` 的 push 顺序上。重排 `fixedPlan` 会静默改变"哪些节点并行"，而拓扑校验不会报警（digest 会变，但只有 golden 是字面量时才抓得到）。需要一条用插桩 ctx 断言**实际调用序与并发分组**的测试。

### 1.8 ⚠️ 预算比较对 NaN/Infinity 不安全

```ts
if (budget.maxActionStarts > spec.limits.maxActionStarts || ...) throw BUDGET_EXHAUSTED
```

若 `spec.limits.*` 为 `NaN`，两个比较都是 `false`，**预算检查被完全绕过**。这取决于 `GraphSpec`（未贴出）是否强制整数与上界。需确认并补测：`NaN` / `Infinity` / `-0` / `1e308` / 非整数 / 负数 / 字符串数字。`maxEpochs` 的非整数路径目前靠 `validateGraphPlan` 的 `Number.isInteger` 兜住（错误码会变成 `PLAN_INVALID` 而非预算/规格错），这点要么接受要么显式化。

### 1.9 ⚠️ 原型键查找

`registry.nodes[node.operation]`、`specFields[mapping.field]` 都是原型链可达的普通对象字面量。`operation: 'constructor'` 当前会拿到 `Object.prototype.constructor`（truthy），之后因 `Object.keys(undefined)` 抛 TypeError 而被 catch 兜住——**是意外安全，不是设计安全**。resolver 上线后会有更多"按调用方字符串查表"的分发点。建议全部改 `Object.create(null)` 或 `hasOwn` 守卫，并补 `__proto__` / `constructor` / `toString` 作为 operation、field、registry key、以及 **resolver 版本键**的测试。

### 1.10 ⚠️ `ctx.interrupt` 的返回值未被规范化，却成为 run 的返回值

```js
if (decision.kind === 'ready' || decision.kind === 'stop') return decision;
```

`decision` 是宿主对象，只校验了 `epoch` 与 `feedbackRef`，然后**整个原样返回**，成为 worker run 的结果。同 UID 下不是越权，但：**run 的返回类型是冻结契约的一部分，现在它是开放形状**。下游一旦依赖 `decision` 上的额外字段，就形成了未版本化的隐式契约。🔒 归一化成白名单形状再返回。

另外：`ctx.interrupt` 必须是 checkpoint 可重放且**重放稳定**的。若 host 在重放时返回不同的 `feedbackRef`，results 分叉而 digest 不变——这是静默不确定性。需要一条重放一致性测试。

### 1.11 resolver 本身的缺口

- **不要按字段分发**。按 `engine/checkpoint/template/registry/compiler/schema` 六元组做**完整元组精确匹配的白名单表**（今天只有一条）。按字段各自匹配会产生笛卡尔积，允许 `compiler v4 + registry v4` 这种从未存在过的组合。
- **不得有 fallback/default 分支**，不得有 `?? latest`、不得有 `startsWith`、不得有语义化版本比较。
- **重算必须用 resolver 自己的冻结常量**，不得使用 artifact 内嵌的 registry/plan/budget；比较 `specHash` **和** `compiledProgramDigest`，若持久化了 `source` 也要逐字节比。
- **未知版本 → 独立且稳定的终止性错误码**（如 `PROGRAM_VERSION_UNSUPPORTED`），且必须是**终态拒绝而非可重试错误**，否则 run 会无限循环并消耗 ledger 预算。
- **缺 spec 的旧 run**：这是纯顺序保证——"缺 spec"检查必须排在 resolver 分发**之前**，且当"缺 spec"与"未知版本"同时成立时，surface 的必须仍是旧错误码。需要 golden 错误路径测试覆盖这个交叉。
- **缓存**：若 resolver 缓存解析结果，键必须是完整元组 + specHash，不能只用版本字符串。

### 1.12 📎 CLI 显式要求 v4

真正的风险是 `graphDeliveryVersion` 的集中绑定：CLI 若 import 一个会随版本推进而改值的常量，未来就会自动接纳 v5。

- 集中绑定应当是**元组表** + 一个冻结别名 `CLI_REQUIRED_DELIVERY = GRAPH_DELIVERY.v4`，CLI 比较的是字面量相等，不是"resolver 支持即可"。
- 最有效的回归测试不是断言常量值，而是：**给三条 CLI 喂一个 v5 标签的 artifact fixture，断言全部拒绝、退出码与 stderr 与 golden 一致**。退出码和文案对脚本调用方是兼容契约。

### 1.13 📎 其他兼容点

- 公开桶的**导出名清单**要有 golden 快照，防止转发过程中增删符号。
- 公开桶转发后，`GRAPH_COMPILER_VERSION` 必须仍是字面量 `'code-delivery-functional-v4'`（有些转发写法会变成 getter，破坏 `as const` 推断与 tree-shaking）。
- 类型身份：`CompiledGraphSpec` 若在冻结模块与公开桶各声明一次，会出现结构相同但 nominal 不同的问题；只 `export type { ... } from` 转发。
- 规格字符串的 Unicode：`ref` 只禁控制字符，不做 NFC；而你第二块对 path 强制 NFC。两套规范化策略并存要写清边界（ref 不是 path）。另需确认 `GraphSpec` 是否拒绝**非良构 UTF-16（孤立代理对）**——`workerCanonical` 会转义成 `\udXXX` 所以 digest 不会碰撞，但 `createHash(...,'utf8')` 对孤立代理会替换成 U+FFFD，两条路径的字节语义不一致，值得一条针对性测试。

---

## 二、纯 changeset 协议

前置：我完全接受你的定位——**manifest / hash / profile / grant 都只是描述，不是授权**。下面所有建议都不把它们当成许可，验证函数只做"比对与拒绝"，不做"因此允许"。

### 2.1 ⚠️ `replace` / `delete` 缺前置条件 = 盲写

"16KiB、1..8 op、path policy、manifest 预注册"这几道闸都管不住**丢失更新**。若 op 不携带它所预期的 `expectedSha256`（来自 manifest 条目），那么 propose 与 apply 之间目标文件被改动时，apply 只能在"照写"与"自行猜测"之间选。协议层必须承载 CAS 前置条件：

- `create` → 断言 manifest 条目为 **absent**；
- `replace` → 携带 `expectedSha256` 且等于 manifest 条目的 sha256；
- `delete` → 同上（删除也必须是 CAS，否则删掉的是别人刚写的内容）。

这是本块最容易被漏、后果最实的缺口：它决定了 P05 host apply 能否做成幂等的比较并交换，还是只能做成"尽力而为覆盖"。

### 2.2 ⚠️ 大小与结构上界不完整

"总 UTF-8 内容 ≤ 16KiB" 只界定了 content。仍然无界的有：路径字节数、路径段数、单 op content、**以及 JSON 信封本身**。16KiB 内容经 JSON 转义可膨胀到 ~96KiB，而 8 条 op 的路径字段没有上界。需要：

- 解析**之前**的外层信封字节上限（防止在 `JSON.parse` 上烧 CPU/内存）；
- 每路径 ≤ N 字节、段数 ≤ N、段长 ≤ 255 字节（文件系统 NAME_MAX）；
- 明确 16KiB 是**规范化之后**、**UTF-8 字节**、**是否计入路径**；
- `delete` 无 content 但仍占 op 槽位；0 op 必须拒绝（否则 propose 等价于 noop，而你明确禁止 noop）。

### 2.3 ⚠️ 大小写折叠：`toLowerCase` 挡不住 APFS

"保守折叠"必须写清算法。具体绕过：

- `ſ`（U+017F LATIN SMALL LETTER LONG S）：**NFC 不动它，`toLowerCase()` 也不动它**（它本来就是小写），但 Unicode **full case folding** 把它折成 `s`，而 APFS/HFS+ 不区分大小写卷正是按 full case folding 比较。于是 deny 了 `secrets/`，`ſecrets/` 仍可通过你的检查，却在磁盘上命中同一目录。
- `K`（U+212A KELVIN SIGN）：NFC 保留，`toLowerCase()` 会给出 `k`——这条 JS 恰好挡得住，但不要依赖巧合。
- `toLocaleLowerCase()` 在土耳其语环境下 `I → ı`，必须用 `toLowerCase()` 且显式记录 locale 无关性。

另一条容易搞反的方向性规则：**折叠形只能用于 deny 匹配与父子/重复冲突检测，绝不能用于 allow 匹配。** 若 allow 也按折叠比，`README.md` 的白名单会顺带放行 `readme.md`。

**我的实际建议**：实验期把路径字符集收窄为 ASCII 白名单 `[A-Za-z0-9._-]` + `/`。这一刀同时干掉 NFC、折叠、同形字、RTL override、文件系统规范化差异五类问题，NFC 检查退化成恒等断言。等真需要非 ASCII 路径时再单独立项。

### 2.4 ⚠️ path policy 的边界细节

- `directoryPrefixes` 必须按**段边界**匹配：`src` 不得匹配 `srcfoo`（你已提到段匹配，但要连带覆盖 deny 前缀、以及前缀自身也要过同一套路径校验）。
- 空前缀或 `/` 必须**不能**被解释为"全部允许"。
- deny 优先要覆盖全部四种交叉：deny-exact vs allow-prefix、deny-prefix vs allow-exact、deny-prefix vs allow-prefix（更深）、以及都不命中时的默认（必须是拒绝）。
- 除 `..`、`.`、空段、反斜杠、控制字符、绝对路径外，还要拒绝：**段尾的 `.` 或空格**（Windows 会静默剥离）、**Windows 保留设备名**（`CON`/`PRN`/`AUX`/`NUL`/`COM1-9`/`LPT1-9`，含带扩展名形式）、尾部 `/`、`NUL` 字节。即便当前只跑 darwin/linux，产物会被别人 checkout 到 Windows。
- "所有 dot 段拒绝"顺带拒绝 `.github/`、`.gitignore`、`.env`。这对安全是**好事**（堵死 CI 劫持），但它是个产品决策，必须显式写进文档并测试，否则将来有人会当 bug 修掉。

### 2.5 ⚠️ 父子冲突与同路径重复

`a/b` 与 `a/b/c` 同时出现必须拒绝（文件/目录类型冲突）。还要额外拒绝：**同一路径出现两次**（按 NFC + 折叠后的键去重）、`delete` 与 `create` 同路径、以及"删除 `a/b` 同时创建 `a/b/c`"这类顺序敏感组合。

顺带：op 顺序是否影响语义，必须二选一并写死。若无所谓，就**强制按规范化路径排序**，这样同一变更只有唯一表示，digest 与幂等键才是稳定的；否则两个仅顺序不同、效果相同的 proposal 会产生两个 digest，去重直接失效。

### 2.6 ⚠️ mode：禁止隐式提权

- `replace` 省略 mode 时的语义必须写死（建议：沿用 manifest 中的既有 mode）；`create` 默认 `100644`。
- **`644 → 755` 的提升要默认拒绝**。同 UID 下可执行位不是越权边界，但它把一个数据文件变成随后可能被执行的东西——在"提出变更"这个语境里，没有任何正当理由需要它。要放开就走显式白名单。
- 只描述常规文件：需显式拒绝 `120000`（symlink）、`160000`（gitlink/submodule）、`040000`。submodule 这一条尤其容易漏，它是把外部仓库拉进构建的经典路径。

### 2.7 ⚠️ manifest 绑定的完整性

绑定 run/effect/generation/base/tree/profile/grant 之外，**digest 里还必须包含**：

- **manifest 自身的 digest**；
- **path policy 的 digest**——否则在宽松 policy 下验证通过的 proposal 可以被搬到另一套 policy 下重放；
- **compiler/registry 身份元组**——把第一块和第二块焊死，防止 v4 程序产出的 changeset 被重放进 v5 run；
- 自己的**域前缀与协议版本**（`osstack.changeset.v1\n`），理由同 1.3。

另外：
- `generation` 必须由验证函数**比对**（调用方要同时传 manifest 与当前 generation），不能只让调用方递一个 manifest 就算数。
- 纯函数无法验证 manifest 与 `tree` 是否一致。这点要在类型与文档上写死：验证函数**信任** manifest，host 必须在租约下原子地从 `tree` 生成它，并在 apply 时**重新**对活文件树校验。
- "预注册目标"意味着模型**不能发明新文件名**——create 的目标也必须是 manifest 里预注册的 absent 条目。这是重大语义决策，要显式化并测试；同时 absent 条目集合要有数量上界。
- 双闸方向要写清：**在 manifest 但不在 policy → 拒绝；在 policy 但不在 manifest → 拒绝。**

### 2.8 ⚠️ manifest 不是沙箱证明——把 host 义务写成契约

你已经说了这点，我把它落成清单，因为这是最容易在 P05 被"digest 对上了就写"糊过去的地方。absent 条目**不能**证明该路径不是悬空 symlink、不是目录、其父目录不是 symlink。apply 侧必须：逐段 `lstat` 或用 `openat2(RESOLVE_BENEATH|RESOLVE_NO_SYMLINKS)`（macOS 上用 `O_NOFOLLOW` + 逐段 openat）、在租约/flock 下操作、写入后再比对。建议在返回类型上就体现：命名为 `ValidatedChangesetProposal` 而非 `AuthorizedChangeset`，且**不携带任何 apply 可以直接信任的 grant 字段**——digest 是标识符，不是能力令牌。

### 2.9 ⚠️ `cannot_complete` 的文本通道

理由字段若是自由文本，它会成为一条从模型流向日志/审阅界面的注入通道。用有界枚举 + 可选的短、转义后的 detail（长度上限、拒绝控制字符与换行，防日志注入）。同时明确：`cannot_complete` 对该节点是终态、预算如何记账、且不可用于绕过必需 effect；它必须与传输失败可区分。

### 2.10 📎 纯度与"不让旧 adapter 获得新准入"

- 纯度靠构造保证并用测试钉死：实验 subpath 的**传递依赖图**中不得出现 `fs`/`child_process`/`net`/`http`/`fetch`；不得使用 `Date.now`/`Math.random`/`process.env`（否则 digest 不可复现）。
- package `exports` 只暴露 `./experimental/changeset`，**根桶不得转发**；根桶导出名 golden 清单要有测试。
- 由于 registry 冻结在 v3，新协议不在 registry 里，worker 结构上无法发出它——这正是你想要的。但要补一条测试：**默认配置的旧 adapter 收到 changeset 消息时拒绝**，且该准入需要一个默认关闭的独立 capability/grant 开关。
- 最优雅的回归测试：第二块落地后，**断言 compiler v4 的 source 快照与 digest 字节不变**。

---

## 三、必要测试清单（按优先级）

**冻结完整性**
1. golden：**字面量 hex** 的 `specHash` / `compiledProgramDigest` / plan digest / budget digest + **签入的 `source` 快照**逐字节比对。禁止在测试中重新计算 expected。
2. import-graph：冻结模块只依赖冻结兄弟；公开桶转发后导出名与类型身份不变。
3. 双次编译确定性；spec 键插入顺序不同 → 同 digest；孤立代理 / 星平面 / NFC 变体 ref 的 digest 稳定性。

**resolver**
4. 六元组逐字段突变 × 每字段 → `PROGRAM_VERSION_UNSUPPORTED`；无 fallback；未知版本为终态不可重试。
5. 篡改存储的 spec / source / plan / budget 各一字节 → 各自的拒绝码。
6. 内嵌 registry 标签伪造（definitions 相同、标签为 v9）→ 断言既定行为。
7. 缺 spec 旧 run：错误码与**求值顺序**未变；"缺 spec + 未知版本"交叉时仍走旧路径。
8. 原型键（`__proto__`/`constructor`）作为版本键、operation、field。

**CLI**
9. 三条命令：接受 v4 fixture；拒绝 v5 fixture；拒绝"resolver 支持但非 v4"；退出码与 stderr golden。

**编译/预算**
10. `maxEpochs` 0/1/3/4/2.5/NaN；`maxBranchAttempts` 0/1/32/33；limits 为 NaN/Infinity/负数/字符串 → 必须拒绝；恰好等于上限 → 通过，上限 -1 → `BUDGET_EXHAUSTED`。

**运行时（在 VM/worker 中实际执行 source）**
11. `response.generation` / 五个 effect 字段（外加新增的 generation）逐一失配；`worker_action_rejected`；`outcome.state !== 'confirmed'`。
12. 每个 field kind 的正负样本；缺字段/多字段；cached task return 也被校验；带 getter/`toJSON` 的返回值（TOCTOU）。
13. `candidateRevision`/`workspaceLeaseRef` 的输入输出同一性钉死。
14. interrupt：epoch 不符、`nextEpoch` 不符、非法 `feedbackRef`、非法 kind、**重放返回不同值**。
15. 插桩 ctx 断言精确调用序与并发分组（3 串行 / 2 并行 / 2 并行）。
16. `ctx.signal.aborted` 路径；`EPOCH_BUDGET_EXHAUSTED`。

**changeset**
17. 路径拒绝集的属性/模糊测试：绝对路径、`..`、`.`、dot 前缀段、空段、`//`、尾 `/`、反斜杠、控制字符、NUL、段尾 `.`/空格、Windows 保留名、超长段、非良构 UTF-8/UTF-16。
18. Unicode：NFC/NFD 对 → 冲突拒绝；`ſ` / `K` / 全角 / 同形字 vs deny 条目；土耳其 locale 下的 `I`/`ı`。
19. deny 优先四象限 + `src` vs `srcfoo` 段边界 + 空前缀不等于全放行 + 默认拒绝。
20. 父子冲突 `a/b`+`a/b/c`；同路径重复；create+delete 同路径。
21. 上界：0/1/8/9 op；content 恰好 16KiB / +1 字节（多字节字符跨界）；信封字节上限；delete 带 content 拒绝；未知 op kind 拒绝；`shell`/`noop`/`read` 按名显式拒绝。
22. manifest 绑定：目标缺条目、create 命中 present、replace/delete 命中 absent、`expectedSha256` 失配、mode 非 644/755、644→755 提升、symlink/gitlink mode、run/effect/generation/base/tree/profile/grant 逐字段失配。
23. digest：键序无关、op 序策略、域前缀存在、policy 或 manifest 变化则 digest 变化、golden 字面量。
24. 纯度：依赖图无 fs/net、无 Date/random/env；重复验证返回相同值；返回对象深冻结且 strict mode 下改写抛错。
25. 准入隔离：根桶导出清单不变；实验 subpath 仅经 `./experimental/*` 可达；默认配置旧 adapter 拒绝 changeset 消息；compiler v4 source 快照在第二块落地后**未变**。

---

## 四、给你的一句话优先级

先把 **1.1（冻结模块的 import 边界）** 和 **1.2（registry 标签未真正固定）** 处理掉——这两条各自都能让"冻结"名存实亡；然后把 **1.3 / 1.4 / 1.5 / 1.6 / 1.10** 这几处会改动 source 的修复一次性合入再固定 fixture。第二块里 **2.1（replace/delete 缺 CAS 前置条件）** 和 **2.3（ſ 绕过折叠）** 是我认为最可能被漏掉、且后果最实的两条；**2.3 的最省事解法是实验期把路径收窄到 ASCII 白名单**。

我没有修改任何文件，也没有运行任何命令。

</details>

### 第二轮实际代码审计：处置原则

采纳：changeset 摘要固定向量；将 policyDigest 加入 independently checked binding，避免替换 policy；返回深冻结且已经排序的 manifest/policy，避免下游重新实现规范化；补足 generation 摘要与跨代 effect 幂等的区别、真实文件树别名检查、只读上下文暂不支持等契约说明。

不采纳向 graphProgramVersion 添加 specHash：core 的 GraphProgramVersion 是 strict schema，GraphRunStore 负责生成并追加 specHash/inputDigest；修改返回类型会破坏现有 API。旧 emitted source 直接包含 specHash，program digest 绑定 spec，因此审计提出的同模板不同 spec 摘要相同假设不成立。也不重命名历史 identity.schemaVersion、不修改旧摘要或已发布字段。编译入口本来就先 GraphSpec.parse，happy-path getter 不会执行。compiledProgramDigest 是必填 string，不存在审计假设的 optional undefined 路径。

有限 golden、模块内容摘要和人工 review 都不是防恶意维护者的安全边界；不会伪称 fixture 来自生产 checkpoint，它们确实在修改前从原 compiler 导出。

<details><summary>Claude Opus 5 第二轮实际代码审计原文</summary>

# 审计报告：P02 历史解析 + P03 实验性纯协议

**审计范围说明**：本次为静态阅读你粘贴的 4 个文件，未运行工具、未执行测试。`workerCanonical`、`freezeWorkerData`、`legacy/code-delivery-v4.ts`、`fixtures/code-delivery-v4.json` 未提供，凡依赖它们的结论我都写成条件式判断，并给出可证伪的具体检查方式。

**总判断**：没有发现 P0（没有可复现的策略绕过、没有 preimage 校验漏洞、没有路径逃逸）。路径可移植性、大小写别名、父子冲突、deny-先于-allow 这几处的方向和实现都是对的。但有 5 处 P1 值得在进入 durable invocation/apply **之前**修，理由是它们都会把错误固化进将要长期持久化的信封或摘要里，事后修的代价远高于现在；且 5 处修复都不触碰旧 emitted source、不改 effect identity、不把 `generation` 引入跨代幂等键，与你的冻结约束完全相容。

---

## 一、P1（真 defect，建议 apply 之前收口）

### P1-1 `graphProgramVersion` 返回的 identity 丢掉了 `specHash`，而校验侧对 `specHash` 是**条件**校验

`resolveV4GraphProgram` 里：

```ts
if (snapshot.compiledProgramDigest !== compiled.compiledProgramDigest ||
    ('specHash' in snapshot && snapshot.specHash !== compiled.specHash)) { ... }
```

`specHash` 只有"存在时"才比。而 `graphProgramVersion` 在**自检时传入** `specHash`，**返回时却不带**：

```ts
const version = { ...V4_GRAPH_PROGRAM, compilerVersion, registryVersion, schemaVersion, compiledProgramDigest };
const historical = resolveGraphProgram(compiled.spec, { ...version, specHash: compiled.specHash }); // 带
return version;                                                                                    // 不带
```

测试 `expect(graphProgramVersion(compiled)).toEqual({ ...V4_GRAPH_PROGRAM, compiledProgramDigest })` 把"不带"这件事锁死了。结果：**凡是用 `graphProgramVersion()` 的返回值写入持久化的 identity，全部落在弱校验分支上**。

影响取决于 `compiledProgramDigest` 是否绑定 spec。可证伪检查：在 fixture 里取两个 `specHash` 不同的 case，若它们的 `sourceDigest` 相同，则 `resolveGraphProgram(caseA.spec, {...V4, compiledProgramDigest: caseB.sourceDigest})` 会成功 —— 即**任意被篡改的持久化 spec 都能以合法 v4 程序被解析**（改 `baseRevision` / `repositoryRef` / `limits` 都不会被发现）。若 `compiledProgramDigest` 确实覆盖 spec，则本项降为 P2 的"冗余字段"问题。从 `template: z.literal("code-delivery-v1")` + `templateVersion: '4'` 的模板化设计看，同一模板不同输入产出同一份 emitted source 的概率很高，我倾向前者。

修复（兼容）：`graphProgramVersion` 返回值补上 `specHash`；`resolveV4GraphProgram` 保留缺失分支**仅作为旧记录兼容**，但改成显式的 legacy 路径（打点/计数，文档写明哪个日期之前写入的信封可以没有 `specHash`），而不是让"字段不存在"这个可被剥离的条件充当降级开关。旧信封仍可解析，emitted source 与 effect key 均不变。需要同步改上面那条 `toEqual`。

### P1-2 changeset 的三个摘要没有任何固定 golden 向量，而 `workerCanonical` 与冻结 compiler 共享

`changeset.test.ts` 只断言了 `proposalDigest` 满足 `/^[a-f0-9]{64}$/`、顺序无关、以及 policy 变化后不等。**没有一个写死的 hex**。而 `boundDigest` 的原像是 `osstack.changeset.<domain>.v1\n` + `workerCanonical(...)`。按你的说明，`workerCanonical` 正是冻结 compiler 与 protocol 共享的那部分 —— 也就是说它是**会被别处的需求推动而演进**的代码。

v4 侧有 `planDigest` 金样把它钉住了；changeset 侧完全没有。后果：`workerCanonical` 的任何行为变化（键序、数字编码、空对象/空数组处理）都会静默改变 `manifestDigest`/`policyDigest`/`proposalDigest`，而两个包的测试可以全绿。这些摘要一旦进入 durable apply 就是永久标识。

修复：加 1~2 个写死 hex 的向量测试（固定 manifest/policy/proposal → 固定 `manifestDigest`/`policyDigest`/`proposalDigest`）。另建议把验证器版本纳入原像，例如 `boundDigest('proposal', { validatorVersion: 1, manifestDigest, policyDigest, proposal })` —— 否则 M2 改 `CHANGESET_LIMITS` 后，同一个 proposal 在不同校验语义下产出同一个摘要。

### P1-3 `policyDigest` 与 `grantDigest` 之间没有任何绑定，docstring 也没把这条义务写死

`bindingSchema` 里有 `grantDigest`、`programDigest`、`profileDigest`，但 `policy` 是**第三个独立入参**，只在 `proposalDigest` 的原像里出现，从未与 `grantDigest` 核对。也就是说：调用方传一份更宽的 policy（多几个 `directoryPrefixes`），照样能拿到一个结构完整、binding 匹配、看起来完全合法的 `proposalDigest`。

docstring 目前只写了 `Host must recheck ... policy/grant and lease before applying`，这句话把"重查"的义务说了，但没说清**必须把本函数用的 policy 与 grant 里承诺的 policy 做摘要级相等比较**——这正是最容易被下游漏掉的一步，而且漏掉时没有任何症状。

修复（现在最便宜）：加一个必填入参 `expectedPolicyDigest: string`，在函数内比较 `policyDigest !== expectedPolicyDigest → CHANGESET_POLICY_MISMATCH`。这不给模块任何执行权限，只是把"policy 必须来自 grant"从口头义务变成类型层面的强制。若你不想改签名，至少把这条写进 docstring 的第一行。

### P1-4 摘要是对**归一化后**的对象算的，但归一化结果没有返回

函数内部就地排序了 `manifest.entries`、`proposal.changes` 和 `policy` 的四个数组，然后对排序后的对象算摘要，最后只返回 `{ proposal, manifestDigest, policyDigest, proposalDigest }`。

两个后果：

1. 宿主手里的 manifest 是**未排序**的原始输入，它无法复现 `manifestDigest`，除非在自己这边重新实现同一套排序 + `workerCanonical`。摘要分叉的经典成因。
2. apply 步骤需要 manifest 才能拿到 `mode`（docstring 明确写 `replace preserves manifest mode`），但返回值里没有 manifest —— 宿主只能用自己那份未绑定到 `manifestDigest` 的副本去取 mode。于是"mode 来自被摘要保护的 manifest"这个不变式在交接处断掉了。

修复：把冻结后的归一化 `manifest` 和 `policy` 一并返回。纯增量，不影响现有摘要值。

### P1-5 冻结目录目前只有约定保护，没有机械化守护

你的最硬约束是"绝不能修改旧 emitted source / effect identity"。但在当前交付里，`packages/graph/src/legacy/**` 和 `packages/graph/src/fixtures/code-delivery-v4.json` 的不可变性**完全依赖人工纪律**：

- `program-resolver.test.ts` 的 golden 来自 fixture 文件本身。如果有人"修 bug"顺手改了冻结 compiler 并重跑生成脚本更新 fixture，测试照样全绿。自引用的 golden 不能守护它自己的来源。
- `vi.mock('./spec-compiler.js')` 只能证明"没有经过这个模块说明符"。一旦 `spec-compiler.ts` 被改名或拆成 `spec-compiler/index.ts`，mock 变成 no-op，测试仍然通过 —— 它宣称守护的性质悄悄失效。

修复：加一个断言文件内容 SHA-256 等于硬编码常量的测试（覆盖 `legacy/` 下每个文件与 fixture 文件），再配 CODEOWNERS。这样任何对冻结树的编辑都会在 CI 上大声失败，而不是靠 review 发现。另外 fixture 的权威来源应写明是"发布时从生产 checkpoint 导出并冻结"，而不是"由当前冻结 compiler 生成"。

---

## 二、P2（真 defect，可与 apply 一起做）

**program-resolver.ts**

- **identity 信封没有 strict schema**：`Object.entries(V4_GRAPH_PROGRAM).some(...)` 只比 8 个已知键，未知键被完全忽略。`resolveGraphProgram(spec, {...V4_GRAPH_PROGRAM, compiledProgramDigest: d, futureFence: 'x'})` 会成功。这与 `Unknown tuples fail closed` 的文档声明直接矛盾（未知**元组**确实 fail closed，未知**字段** fail open）。实际影响有限（v5 必然会改 `compilerVersion`），但既然信封要长期持久化，改成 `.strict()` 的 zod object 成本几乎为零。
- **`compiledProgramDigest` 缺少类型断言**：`snapshot.compiledProgramDigest !== compiled.compiledProgramDigest`，若 `CompiledGraphSpec` 上该字段是 optional 且某条路径返回 `undefined`，则 `undefined !== undefined` 为假 → 整个 identity 门禁被跳过。加一行 `typeof snapshot.compiledProgramDigest === 'string'` 即可根除这类 nullish-vs-nullish 通过。
- **错误类型**：`throw Error('GRAPH_PROGRAM_UNSUPPORTED')` 不在 `GraphErrorCode` 内，也没用 `GraphContractError`。调用方只能字符串匹配 `error.message`。协议里已有语义对应的 `CHECKPOINT_INCOMPATIBLE`。
- **`schemaVersion` 撞名**：`V4_GRAPH_PROGRAM.schemaVersion = 'code-delivery-schema-v3'` 是字符串，而 graph.ts 里从 `Spec` 到 `GraphDelegationStatus` 处处是 `schemaVersion: z.literal(1)`（数字）。同名不同义的字段一旦进入持久化信封就改不动了；现在改成 `registrySchemaVersion` 成本最低。
- **spec 未经边界解析就交给冻结 compiler**：`compileGraphSpec(spec)` 直接吃 `unknown`。测试 `expect(touched).not.toHaveBeenCalled()` 只覆盖了 version 不匹配的**早退分支**；在 happy path 上，恶意 spec 的 getter 会被 compiler 读取。changeset 那边用 `GraphJsonValue.parse` 做了这层防护，这边没有。注意：若要补，必须确认 `GraphJsonValue` 的 record 重建不改键序（zod 保持插入序，理论上安全），并且必须由 P1-5 的 golden 摘要守护后再合。
- **`graphProgramVersion` 每次调用整整重编译一遍** spec，外加两次 `workerCanonical`。若在 durable 循环里逐步调用会被放大，建议缓存或只在写入信封时调用一次。

**changeset.ts**

- **policy 数组排序但不去重**：`denyPaths: ['a','a']` 与 `['a']` 语义相同却产生不同 `policyDigest`，进而不同 `proposalDigest`。摘要对语义等价的策略不规范。
- **`maxContentBytes` 同时充当单文件上限与提案总量上限**：`bytes > CHANGESET_LIMITS.maxContentBytes` 把整个提案锁在 16 KiB（`maxChanges: 8` 实际上永远用不满）。若是有意的，应拆成 `maxProposalBytes` 独立命名，否则很容易在 M2 调大单文件上限时无意放大总量。
- **错误分类不一致**：manifest 侧路径被策略拒绝抛 `CHANGESET_PATH_DENIED`，提案侧却走 `if (!e || !allowed(c.path, policy)) throw Error('CHANGESET_TARGET_REQUIRED')`，把"策略违规"（安全事件，应审计/告警）和"manifest 过期"（平凡错误）压成同一个码。
- **`proposalDigest` 含 `generation`，但 docstring 没写它不能当跨代幂等键**：`binding.generation` ∈ manifestDigest ∈ proposalDigest，所以同一份内容在 generation 1 和 2 下摘要不同。跨代稳定的标识是 `binding.effectKey`。按你的架构这是正确的（generation 是信封 fence），但 apply 落地前必须在 docstring 里写死"`proposalDigest` 是 fence-scoped 的验证凭据，durable apply 的幂等键用 `effectKey`"，否则下游极易误用导致重复 apply。
- **能力边界未文档化**：`portablePath` 的 `^[A-Za-z0-9_-]` 首字符规则禁止任何以点开头的 segment → `.github/workflows/*`、`.gitignore`、`.npmrc`、`.eslintrc` 永远无法交付。同时 manifest 条目也必须通过 `allowed()`，意味着**无法携带只读上下文文件**。这两条都是合理的 M1 收紧，但必须在文档里显式写成能力边界，否则会被当成 bug 反复提。
- **docstring 的 64 KiB 表述不准**：四个入参各自独立走 `GraphJsonValue`（各 64 KiB 上限），单次调用解码后总量可达 ~256 KiB。若四者同在一个传输信封里，宿主的字节预算要按 4× 算。

**测试（两个文件共有）**

- **几乎全部 `.toThrow()` 不带错误码断言**，导致"测试因为正确的原因通过"无法保证。最明显的是 `requires exact manifest preimages and supported modes` 里的 `{...proposal.changes[0], mode:'100644'}` 和 `{...proposal.changes[2], content:''}` —— 这两个实际是被 `.strict()` 以"多余字段"拒绝的，和 preimage/mode 逻辑毫无关系，标题和通过原因不符。建议全部改成 `.toThrow('CHANGESET_XXX')`。
- `it.each(fixture.cases)` 在 fixture 退化为空数组时可能静默产生零用例（取决于 vitest 版本是否对空 each 报错）。加 `expect(fixture.cases.length).toBeGreaterThanOrEqual(N)`。
- 未覆盖：identity **缺少** `compiledProgramDigest`（只测了值错）、identity 含未知字段、`freezeWorkerData` 是否深冻结（只断言了 `a.proposal` 顶层，没测 `a.proposal.changes[0]` 是否可变）。

---

## 三、host 义务（不是本次交付的 defect）

这些标注是正确的，我确认它们属于后续 G10/G12/G16 的职责，**不构成本次代码缺陷**：活体 preimage 复核、inode/symlink/硬链接类型检查、lease 与 grant 的时效与撤销、传输层字节上限、`GraphEffectIdentity` 的 `logicalAttempt` 必须由 ledger 分配、`ResolveAuthenticatedGraphTransport` 不实现认证只是集成缝。

**标注不足、建议补进 docstring**（属于契约模块的文档缺陷）：

1. **大小写不敏感文件系统上与真实树的折叠比较**。`checkPaths` 只检测**本次提交集合内部**的别名，无法发现 manifest 说 `src/a` 为 absent 而磁盘上存在 `src/A` 的情况。docstring 的 `recheck live preimages` 勉强覆盖，但没点名 case-folding，而这恰恰是 macOS/APFS 上最容易漏的一条。
2. P1-3 的 policy↔grant 绑定。
3. P2 里 `proposalDigest` 不可作跨代幂等键。

**必须继续声明为未完成**：host 侧安全（认证、授权、租约围栏、原子 apply）在本次交付中一行都没有实现，也不应被任何"摘要匹配"读作授权 —— docstring 里 `A matching digest is not authorization` 这句写得准确，建议保留并在 P03 的对外文档里重复。

---

## 四、明确**不**建议改动的地方

- 不要动 `legacy/**` 与 fixture 的任何内容，包括"顺手格式化"。P1-5 的摘要守护就是为了让这条变成机械约束。
- 不要把 `generation` 放进跨代 effect key；`bindingSchema` 里带 `generation` 并要求与 `currentBinding` 全等是正确的 fence 语义（跨代必然 fail closed，由宿主重新驱动）。
- 不要为了"独立性"把 `workerCanonical`/`GraphSpec` 从冻结 compiler 里复制一份出来。当前"冻结 compiler 直接导入冻结 registry、共享 protocol 的 GraphSpec/canonical、由旧 golden 摘要守护"的传递兼容约束是可接受的，但文档里必须写明这是**传递兼容**而非独立 runtime —— 并且 P1-2 的 golden 向量正是这条约束能成立的前提条件，两者要一起交付。
- `allowed()` 的 deny 大小写不敏感 / allow 大小写敏感是刻意的非对称，方向正确，不要"统一"。

---

## 五、结论

P1-1 到 P1-5 值得在 durable invocation/apply 之前修，因为它们分别固化了：持久化信封的弱校验分支（1）、将成为永久标识的摘要缺少守护（2）、apply 时最容易漏掉的授权绑定（3）、摘要与 apply 所需数据的交接断裂（4）、以及你最硬那条约束缺乏机械执行（5）。五项合计工作量不大，且都不违反冻结约束。P2 可以随 apply 一起做。

未发现 P0。当前交付确实没有注册执行器、模型调用或文件写入 —— 我没有在任何路径上找到能触达文件系统或网络的调用。

</details>

### 超时专项协作：已证伪的假设

Opus 提议检查重复版本重编译。实际 GraphDelivery.run 仅在启动时调用一次 graphDeliveryVersion；临时插桩记录本次调用为 42.56ms。公开 compiler 是纯转发，legacy compiler 无 memo/cache；因此不能把审计所称“每动作重复校验税”当作根因，也没有为迎合假设加入缓存或删除校验。摘要字节和版本键顺序保持一致。以下为模型的原始假设，后附实际测试结果。

<details><summary>Claude Opus 5 超时专项原文</summary>

只读分析，按可信度排序。

## 确定（代码可直接推出）

**1. `graphProgramVersion` 每次调用都做一次完整重编译 + 两次规范化，而它替换的是一个纯字面量构造。**
旧 `graphDeliveryVersion` 是 O(1) 对象字面量；新版每次调用内部执行：
- `GraphJsonValue.safeParse(identity)`（zod 递归 union，对整个 JSON 对象逐节点校验，通常是这几项里最贵的）
- `compileGraphSpec(spec)`（第二次编译）
- `workerCanonical(plan)` + `workerCanonical(budget)` + `source` 全串比较

这全部是**同步 CPU 阻塞**。关键问题不是 17ms 本身，而是调用次数：请数一下 `graph-delivery.ts` 里 `graphDeliveryVersion(` 的调用点（run 投影 / action 开始与确认 / checkpoint 写 / worker launch / epoch 记录）。构造期只 436ms、而**每个阶段都整体右移**（2.2→2.5→5.3→8.8→11.6→20.6→25.9→28），这是"每动作固定税"的形态，不是一次性构造开销的形态。这是本回归最可能的主因。

**2. 事件循环阻塞放大效应（非线性）。**
测试用 `waitConfirmed` 每 10ms 轮询 SQLite，且 review/tests 两分支互相等待确认。宿主线程每次同步阻塞 N ms，都会同时推迟轮询、子进程 I/O 回收和确认写入。在 load 15-18 时单次 17ms 可被拉长数倍，且乘以调用次数后按分支串行叠加——足以解释 27s→43s 而与"生成字节完全一致"并不矛盾。

**3. 双模块实例导致编译永远冷路径。**
`graph-delivery.ts` 用 `@osstack/graph/spec-compiler`，`program-resolver.ts` 用 `./legacy/code-delivery-v4.js`。若 `spec-compiler.ts` 不是对 legacy 的纯再导出，而是同源副本，则两份模块各自持有 registry / 任何模块级 memo，互不共享：resolver 侧每次都是冷编译，且 vitest 要转换并加载两套模块图。请确认 `spec-compiler.ts` 现在是 `export * from './legacy/code-delivery-v4.js'` 还是副本。

## 猜测（需实测，别据此改代码）
- 若 legacy 编译器内部有按 spec 对象缓存（WeakMap/Map），两实例会使命中率归零，放大第 1 条。
- 新版 version 的**键顺序**与旧字面量不同（`registryVersion`/`compilerVersion` 位置互换）。若任何地方用裸 `JSON.stringify(version)` 而非 `workerCanonical` 生成摘要或比较，会出现身份不一致。测试的 action 计数全部通过，说明没触发额外 epoch/重试，所以这条大概率无影响——但值得 grep 一次。

## 建议的下一步（不降低安全性）
先证实，再优化：
1. 在 `graphProgramVersion` 里加临时计数器 + 累计耗时，跑一次 `retry` 用例，打印 `calls / totalMs`。若 calls ≫ 1，主因确认。
2. 修法是**按已编译程序对象记忆化**，而不是删除校验：用 `WeakMap<CompiledGraphSpec, Version>` 缓存结果。语义等价——`compiled` 是不可变的，其程序身份校验对同一对象的结果恒定，检查仍然每个编译产物执行一次、仍然 fail-closed。
3. 顺带确认 `resolveV4GraphProgram`（`reservedRun` 路径）不在热路径上；集成测试没有 reservedRun，所以它不应出现在这次回归里——若计数器显示它被调用了，说明有意料之外的调用点。

## 对照实验的补充
你正在做的"当前实现 + 同名临时文件"对照，建议加一组中间态：只把 `graphDeliveryVersion` 改回旧字面量、**保留** legacy 迁移和 `resolveV4GraphProgram`。若这一组回到 27s，即把主因精确钉在 version 路径而非模块迁移上；若仍是 43s，则指向第 3 条的模块重复加载。

</details>

## 实际验证记录（含修复前失败）

- RED：先新增 resolver 测试，因模块不存在失败；先新增 changeset 测试，因模块不存在失败；policy binding 补强先增加测试，因缺少 policy digest helper 失败。随后实现并转绿。
- Graph 最终全包：14 文件、257 项通过。包括 21 项新 resolver/冻结证据测试及真实 checkpoint 子进程断点恢复。
- Agents 最终全包：22 文件、315 项通过。
- Changeset 最终：30 项协议测试通过；manifest/policy/proposal 三个固定摘要与独立 Python hashlib + sorted compact JSON 结果一致。
- 旧 bounded adapter 增加拒绝 changeset 的案例；该文件 84 项通过，拒绝后文件内容保持原样。
- Agents/CLI typecheck 通过；Graph、Agents、CLI build 通过；inventory fresh；git diff --check 通过。Biome 新协议/解析器无问题，既有 preparation recovery 行存在一个 optional-chain 风格 warning，未为清理它改动无关行为。
- CLI 首轮六个相关文件：73 项中 70 项通过、3 项失败（总耗时 486.67s）。失败分别为 repair 45s 超时、retry 30s 超时、future-template 夹具 20s 等待超时。
- repair 串行复测在原 45s 阈值内以 43.73s 通过。
- future-template 根因不是恢复放行：旧夹具先修改 create 的版本，再企图运行未来程序。新增启动校验正确拒绝。夹具现改为支持的真实调用结束后，在专用临时测试 DB 事务中构造未来历史身份并恢复 immutable trigger；原拒绝恢复、保留租约、调用仅一次的断言不变。该用例复测 6.48s 通过。
- retry：原测试和同名条件诊断均多次触发原 30s 门槛。`b6d04b7` 原版 GraphDelivery 临时副本两次为 28.60s、26.64s；同一测试进程交替当前/旧版后，两者均触发 30s 超时。机器当时 load 约 15–18。不能仅凭这些证据断言由本次改动引起，也不能断言仅由机器负载引起。
- 临时阶段插桩显示任务仍推进：2.2s workspace、2.5s implement、5.3s freeze、8.8/11.6s branch preparation、20.6s 首次 review failed、25.9s tests confirmed、28.0s retry preparation。版本校验仅一次，实测 42.56ms。没有发现循环重编译，未移除校验或加无依据缓存。
- 所有诊断副本/插桩均已删除；原集成测试和超时阈值未修改。此时的 retry 超时属于修复前记录；后续已通过查询合并收口，最终结果见末节。本批未运行全部 CLI/整个 monorepo 测试，也未打开 PR、推送或发布。

### 诊断阶段的后续要求

在可记录 CPU/IO 负载的独立测试环境复现 retry，用相同进程与相同顺序做交叉对照，测量每个 Git 子进程、工作区 fingerprint、checkpoint ACK 与事件循环延迟；先确定占时来源，再决定修复实现还是拆分过大的测试。不得通过抬高阈值掩盖回归。保留原端到端行为断言与独立进程故障测试。本批完成查询合并与相关回归后，下一阶段进入 P04 invocation ledger；在 P04–P09 未完成前，实验协议不获得执行准入。

### 最后一次耗时定位补充

对原集成用例使用仅计时的 Node preload 包装 execFileSync（不修改参数、返回值或超时），得到 458 次 Git 调用、累计 16.398s，其中 rev-parse 299 次 / 10.584s，write-tree 74 次 / 2.742s，ls-files 74 次 / 2.485s。该次原测试在原 30s 阈值内以 29.030s 通过，所有 ready、两次审阅、九项 action 的原断言均保留。计时日志写入独立临时目录，没有提交 instrumentation。

这证明当前实现能够完成原场景，同时揭示其对 Git 子进程启动耗时敏感；不等于已找到每次超时的唯一根因。后续性能优化应优先研究重复 fingerprint 内的 Git 查询合并，保持每次授权/前像复核，不可通过跨检查阶段缓存旧工作区证据提高速度。

### 已实施的性能修复

根据上述实测，将每次 candidateIdentity 的 HEAD / HEAD^{tree} 两次 Git 调用合并为一次 `rev-parse HEAD HEAD^{tree}`，仍通过原有 gitRaw hardened 参数执行。没有减少 observation、authorize、fingerprint 或前后证据比对次数，也没有缓存任何工作区证据。新 helper 严格要求恰好两条合法 commit/tree ID，并兼容 CRLF 行分隔；Git 错误继续传播。

新增七项测试验证实际仓库连续两次提交后 HEAD/tree 都实时变化、每次 observation 仅一次子进程、非法/缺失/多余输出拒绝、SHA-256 ID、CRLF 与 Git 失败传播。先 RED 后实现；CRLF 另做 RED/GREEN。首次回归中修复恢复以 42.397s、分支重试以 26.670s 在原阈值内通过。最终完整相关回归结果见下节。

Opus 对这处改动未发现安全倒退。两项模型表述需修正：同一进程仍不是文件系统原子快照；299 次 rev-parse 并非全部来自此处，不能声称它们被减半。原计时里每种 write-tree/ls-files 各 74 次，每次快照只减少一个 HEAD/tree 子进程；最终收益必须看实际测量。

<details><summary>Claude Opus 5 性能修复审计原文</summary>

## 审计结论：可以合并，未发现安全或语义倒退

**正确性**
- `rev-parse HEAD HEAD^{tree}` 按参数顺序逐行输出，解构 `[head, tree]` 与原两次调用的语义一致；解析值逐字节相同，因此 `repositoryDigest`/v4 emitted source 及任何下游摘要不变。
- 对象字面量中展开位置在 `repositoryDigest` 之后、`indexTree` 之前，且函数返回 `{ head, tree }` 保持该插入顺序，所以若 `CandidateIdentity` 被 `JSON.stringify` 参与哈希，键序不变。这是本次改动最容易被忽略的隐性契约，值得在合并说明中点名。
- `git()` 已 `trim()`，故 `split('\n')` 不产生尾部空元素，`extra.length` 判据成立；生产调用链仍经 `git → gitRaw`，`GIT_CONFIG_GLOBAL=/dev/null`、`GIT_CONFIG_NOSYSTEM=1`、`GIT_OPTIONAL_LOCKS=0` 等硬化参数完整保留。
- 失败传播不变：`rev-parse` 非零退出由 `execFileSync` 抛出并原样上浮（测试已覆盖）；unborn HEAD 与改动前同样失败。

**HEAD 期间变更**
- 每次 `candidateIdentity()` 仍起一个新进程、不缓存，`candidateCheck`/`authorize`/`fingerprint` 的观测次数未减少，跨观测的竞态检测能力完全不变。
- 改动方向上反而更强：原来 HEAD 与 HEAD^{tree} 取自两个时刻，可能产生互不匹配的 commit/tree 组合；现在同一进程内解析，单次观测自洽。注释明确声明它不是文件系统级原子快照、比较责任仍在调用方，措辞准确。

**解析强度**
- 正则 `^(?:[a-f0-9]{40}|[a-f0-9]{64})$` 无 `m` 标志，`$` 仅匹配串尾，无法被换行绕过；git 输出小写 hex，不加 `i` 是恰当的收紧。SHA-256 仓库（64 hex）被正确接受。
- 未解析的字面量（如 `HEAD^{tree}`）、缺行、多行均 fail-closed 抛 `CANDIDATE_REVISIONS_INVALID`，测试已覆盖。CR 结尾或大写也会拒绝——同样是 fail-closed，可接受。

**性能**
- 仅 `rev-parse` 从 299 次降至约 150 次，总调用约 458 → 约 309；`write-tree`、`ls-files`、fingerprint 一次未减。收益是实打实的但幅度有限，若报告为"16.4s 大幅改善"会高估，建议按实测重新记时后再写入证据。

**次要观察（非阻塞）**
1. `readCandidateRevisions` 因测试而导出，扩大了模块公开面；若有 API 面积约束，可考虑内部导出约定。
2. 正则允许 head 为 40 位、tree 为 64 位的混合长度组合；git 不会产出该形态，但补一条"两者长度必须一致"的断言可零成本消除该缝隙。
3. 测试未覆盖尾部 `\r` 与大写 hex；行为是拒绝，补两个用例可把该意图固化为契约。

以上均在给定改动范围内判断，未假设其他变更。

</details>

- 最终启动预算检查（独立临时 OSSTACK_HOME）：`--version` 中位 123ms / 150ms；`--help` 中位 341ms / 500ms，均通过。

## 最终验收与提交

1. Graph 全包：257 / 257，通过。
2. Agents 全包：315 / 315，通过，含 30 个 changeset 契约案例及旧 adapter 拒绝新协议。
3. CLI 最后整组：8 文件、120 项，119 通过、1 项原 15s 超时；总耗时 1036.18s。该失败用例只验证 reviewer 三种结果，却创建未使用的 tests 工作区。改用既有 prepareGraphVerificationBranch(..., 'review') 后，保留所有原断言与 15s 阈值，定向复测以 8.428s 通过。
4. 同次定向复测还重新通过 7 个候选 revision helper 测试（测试 Git 环境隔离）；合计 8 通过、39 未运行。这 39 项已经在上述整组回归通过，不是被跳过的失败项。
5. CLI 完整交付端到端文件 11 / 11 通过，重试 17.869s / 30s，修复恢复 28.513s / 45s。不同运行存在外部负载变化，不把所有时长变化都归因于代码优化。
6. 未增加测试超时、未删除行为断言、未缓存权限或文件证据。对未使用的测试工作区做了夹具精简；双分支隔离与并发仍由原专门用例完整覆盖。

实现依旧是 P02 + P03 纯契约及实际测量驱动的候选查询优化。P04–P09 尚未实现，不能使用实验 subpath 绕过现有 Graph 执行器准入。下一阶段从持久化 invocation/apply 权威设计与故障注入开始。

本批代码提交：

- `59e89ed` — 实验 changeset 契约、策略绑定、固定摘要与旧 adapter 拒绝测试。
- `c54e156` — 冻结 v4 编译器/registry、历史 resolver、恢复路径与未来版本夹具。
- `ffffb9d` — 单次候选 revision 查询、实时性测试及 review-only 夹具精简。

最终 typecheck、Biome 新增/变更实现检查、inventory freshness 与 whitespace 检查通过。所有修改位于隔离工作树 `/Users/osborn/.codex/worktrees/osstack-graph-decision-development/osstack`；原 checkout 的未提交内容未由本任务修改。
