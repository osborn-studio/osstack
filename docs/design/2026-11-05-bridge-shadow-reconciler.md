# 阶段 4 实现附录：影子对账器

日期：2026-11-05。基线：`main` `0f006ea3`（含 #373 阶段 3）。
上位文档：[双循环接通设计 v3](2026-11-01-osstack-grok-bridge.md)（下称“设计”）§8.3–§8.5、§10.2–§10.3；[实施方案](../plans/2026-11-02-osstack-grok-bridge-implementation.md)（下称“方案”）阶段 4；[ADR-005](../decisions/ADR-005-bridge-identity-registry.md)、[ADR-006](../decisions/ADR-006-bridge-s0-decisions.md)。

方案阶段 4 要求开工前把实现细节写成设计附录并做一次独立审计。本文就是这份附录。

## 1. 范围

用户决定（2026-11-04）：阶段 4 **只做影子记录，不执行任何动作**。具体含义：

| 做 | 不做 |
|---|---|
| 迁移、链存储、状态机、意图日志 API 及其测试 | 写 `engineering_revision_reservations`、`engineering_publication_intents`（影子链被数据库拒绝，§3.3） |
| 只读 GitHub（主机凭证，与阶段 3 的读取相同） | 用任何 App 令牌；推送、评论、review、check、合并 |
| 把“会做的动作”记为链事件 | 创建子 Mission、派发执行器、`grant-revisions` |
| 回放语料与回放测试 | 改变任何 Mission 的状态或事件 |

影子运行不影响 Mission：对账器只读 Mission 账本，写入只落在本附录新增的链表里。

## 2. PR 拆分

方案 §0.3：阶段 4 在开工设计里再拆分。每个 PR 目标 `main`，一个 PR 一件事，顺序合并。

| PR | 方案任务 | 内容 | 依赖 |
|---|---|---|---|
| 4-0 | — | 本附录（含审计结果） | — |
| 4-A | 4.1、4.2、4.3 | 迁移 51、纯状态机、链存储、fast-check 属性测试 | 4-0 |
| 4-B | 4.4 | `docs/design/specs/bridge.tla` + `.cfg`，TLC 无反例 | 4-0（与 4-A 互不依赖） |
| 4-C | 4.5、4.6 | GraphQL 读取器、录制脚本、#340–#363 语料 | 4-A（用到 `ReviewObservation` 类型） |
| 4-D | 4.7 | 影子对账器、`OSSTACK_BRIDGE=shadow`、`mission status --json` 链字段、回放测试 | 4-A、4-C |

4-B 需要 TLC（`tla2tools.jar`）。本机没有，下载前先问用户（§8 决定 1）。

## 3. 数据模型（4-A）

### 3.1 文件与迁移

- 新文件 `packages/core/src/state/engineering-revision-chain-ddl.ts`，导出 `ENGINEERING_REVISION_CHAIN_DDL`；`migrations.ts` 追加 `{ id: 51, name: "engineering_revision_chains", sql: ENGINEERING_REVISION_CHAIN_DDL }`。当前最后一条是 50 `engineering_contained_missions`。
- 升级测试里写死的 schema 版本号（`upgrade-native*.test.ts`、`upgrade-native-port.ts` 等，按 `git grep "50"` 逐个核对）随之改为 51。
- 只新增表，不改 50 的表；不加外键指向会被重建的表。

### 3.2 表

在设计 §8.3 三张表之外，**新增两张表**：`engineering_revision_chain_events`（只追加审计轨迹）与 `engineering_shadow_decisions`（影子决定，按 head 唯一）。这是与方案 4.1 “三张表”的偏差，理由：链状态需要和 Mission 一样的只追加审计轨迹，影子决定需要一个不与真实预留混用、又能按 head 去重的落点；放进 `engineering_contained_events` 会让对账器写 Mission 账本，违反 §1。

```sql
CREATE TABLE engineering_revision_chains (
  chain_id TEXT PRIMARY KEY CHECK(chain_id LIKE 'rc_%'),
  mode TEXT NOT NULL CHECK(mode IN ('shadow','live')),
  root_mission_id TEXT NOT NULL REFERENCES engineering_contained_missions(mission_id),
  current_mission_id TEXT REFERENCES engineering_contained_missions(mission_id),
  repository TEXT NOT NULL, pr_number INTEGER NOT NULL CHECK(pr_number>0),
  branch TEXT NOT NULL, base_ref TEXT NOT NULL,
  published_head TEXT NOT NULL, published_base TEXT NOT NULL,
  grant_json TEXT NOT NULL CHECK(length(grant_json)<=4096),
  rounds_used INTEGER NOT NULL DEFAULT 0 CHECK(rounds_used BETWEEN 0 AND 2),
  state TEXT NOT NULL CHECK(state IN ('awaiting_review','revision_reserved','revising','publishing',
    'ready_for_human','closed','awaiting_decision')),
  stop_reason TEXT,
  review_deadline INTEGER, budget_json TEXT, spent_json TEXT, trace_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK(revision>0),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  CHECK(state<>'awaiting_decision' OR stop_reason IS NOT NULL),
  -- 影子链不消耗轮次、没有子 Mission，也不进入派发相关状态
  CHECK(mode<>'shadow' OR (rounds_used=0 AND current_mission_id IS NULL
    AND state NOT IN ('revision_reserved','revising','publishing')))
);
-- 每个根 Mission 最多一条链（每种 mode）；每个 PR 最多一条 live 链
CREATE UNIQUE INDEX engineering_chain_root ON engineering_revision_chains(root_mission_id, mode);
CREATE UNIQUE INDEX engineering_chain_pr_live ON engineering_revision_chains(repository, pr_number) WHERE mode='live';
```

触发器（与 `engineering-contained-ddl.ts` 的写法一致）：

- `engineering_chain_fixed`：`chain_id`、`mode`、`root_mission_id`、`repository`、`pr_number`、`branch`、`base_ref`、`created_at`、`trace_id` 不可改；`revision` 每次 +1；`rounds_used` 只增不减。
- `engineering_chain_terminal`：`closed` 是终态，不可再转换。`ready_for_human` 不是终态：同 head 上新的合格 `CHANGES_REQUESTED` 两种模式都回到 `awaiting_review` 的处理；新 head 只在 live 模式且有 `confirmed` 推送意图时回到 `awaiting_review`，影子模式下任何 head 变化都进入 `awaiting_decision`（§4.2 第 3 条）。
- grant 形状按 `mode` 分别检查（CHECK，不变式 1 的数据库层）：`mode='live'` 时 `json_extract(grant_json,'$.kind')='live'` 且 `json_extract(grant_json,'$.rounds') IN (1,2)`，并且 `rounds_used <= json_extract(grant_json,'$.rounds')`；`mode='shadow'` 时 `json_extract(grant_json,'$.kind')='shadow_hypothetical'` 且 `json_extract(grant_json,'$.rounds') IS NULL`。任何字段缺失都让 CHECK 结果为假而非 NULL（写成 `IS` / `COALESCE(…,0)` 比较）。解析层另做同样校验。

`engineering_revision_reservations` 与 `engineering_publication_intents` 按设计 §8.3 建表，另加：

- 两表都有 `chain_id REFERENCES engineering_revision_chains(chain_id)`。
- 触发器 `engineering_reservation_live_only` / `engineering_intent_live_only`：`INSERT` 时若所属链 `mode='shadow'` 则 `RAISE(ABORT,'bridge_shadow_write_denied')`。两表的 `chain_id` 与主键字段另有 `BEFORE UPDATE` 触发器禁止修改，所以已有的 live 行不能改挂到影子链上。这是“影子不预留”的数据库保证，不依赖调用方自律。
- 预留主键（`repository`, `pr_number`, `head_sha`）——不变式 2。
- 每条链最多一个在途预留：`CREATE UNIQUE INDEX engineering_reservation_active ON engineering_revision_reservations(chain_id) WHERE state IN ('reserved','dispatched')`——不变式 3 的数据库层。
- 链的 `current_mission_id` 只能在同一事务中有一条 `dispatched` 预留且其 `child_mission_id` 等于它时设置（触发器 `engineering_chain_current_child`）；清空或换成下一个，要求旧子 Mission 已处于终态（`pr_opened`、`cancelled`、`abandoned`、`failed`）且 `stop_obligation=0`（停止已证明，设计 §8.5 对应表），并且对应预留已不在 `reserved`/`dispatched`。只把预留标为 `void` 不够：旧子 Mission 可能仍在运行。
- 意图 `state` 只能 `pending → confirmed|failed|uncertain`，`uncertain → confirmed|failed`（人工对账），其余转换拒绝。

```sql
CREATE TABLE engineering_revision_chain_events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id TEXT NOT NULL REFERENCES engineering_revision_chains(chain_id),
  kind TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(length(payload_json)<=32768), created_at INTEGER NOT NULL
);
-- 只追加：UPDATE/DELETE 触发器与 engineering_contained_events 相同
```

事件种类：`chain_created`、`transition`（`from`、`to`、`reason`、`head`、`base`）、`observation_cycle`（读取是否完整、观察数、所选 review id、丢弃原因）、`read_failed`（错误码，脱敏）。

```sql
CREATE TABLE engineering_shadow_decisions (
  chain_id TEXT NOT NULL REFERENCES engineering_revision_chains(chain_id),
  head_sha TEXT NOT NULL, base_sha TEXT NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('would_reserve','would_mark_ready','would_stop')),
  reason TEXT NOT NULL, review_ids_json TEXT NOT NULL, feedback_digest TEXT,
  observed_at INTEGER NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (chain_id, head_sha, action)
);
-- 只追加；只接受 mode='shadow' 的链
```

主键让重启或重复周期不会对同一 head 记第二条同类决定（`INSERT … ON CONFLICT DO NOTHING`）。

### 3.3 影子链的 grant

影子链没有真实授权。`grant_json = {"kind":"shadow_hypothetical"}`，不带额度：影子链 `rounds_used` 恒为 0（§3.2 的 CHECK），`would_reserve` 只说明“这个 head 上会预留一次”，不模拟后续轮次。原因见 §4.2 第 3 条：影子模式无法把新 head 归因给发布者，所以链在第一次 head 变化后就停止，模拟的轮次计数没有可靠依据。额度用完（第 3 次要求修改转人）的路径由属性测试、TLA 模型和阶段 5 的沙箱端到端覆盖，不在影子运行中观察。

## 4. 状态机（4-A）

### 4.1 纯函数

`packages/core/src/bridge/revision-chain.ts`（新，无 I/O）：

```ts
export function decideChainStep(chain: ChainView, cycle: ObservationCycle, registry: ProducerRegistry, now: number): ChainDecision
```

- 输入：链当前视图、本周期观察（§5.2，含完整性标记与二次读取结果）、登记表、时间。
- 输出之一：`{ kind: 'none', reason }`、`{ kind: 'transition', to, reason }`、`{ kind: 'reserve', head, review_ids, feedback_digest }`、`{ kind: 'stop', reason }`。
- 选择规则即设计 §8.4 第 1–6 条，逐条映射为丢弃原因码（`snapshot_incomplete`、`head_mismatch`、`base_changed`、`unregistered_reviewer`、`no_feedback`、`reviewer_conflict`、`expired`、`head_already_reserved`）。

存储层 `packages/core/src/state/engineering-revision-chain-store.ts` 只负责把决定在一个 `BEGIN IMMEDIATE` 事务里落库：读链（带 `revision`）、调用纯函数的结果、写链与事件；`revision` 不符即放弃本周期（乐观并发）。

### 4.2 转换表

在设计 §8.5 之上补三处设计没写清的细节（请审计重点看）：

1. **“所有登记评审者 APPROVED”**：登记评审者有 6 个自动化账号（ADR-005/006），要求全部批准永远达不到。改为按 head 固定的**参与评审者集合**：当前 head 与 base 上，按设计 §8.4 第 4 条归约后状态非空（`APPROVED` 或 `CHANGES_REQUESTED`）的登记评审者。`ready_for_human` 当且仅当该集合非空且全部为 `APPROVED`。未参与（没有 review、只有 `COMMENTED`、最新一条被 `DISMISSED`）的登记评审者不计入。这是对设计 §8.5 的**政策修改**，需要用户确认（§8 决定 3）；在确认前，影子运行按此规则记录，不影响任何动作。
2. **`ready_for_human` 之后**：同 head 上新的合格 `CHANGES_REQUESTED` → 按 `awaiting_review` 的规则处理（链未终结，人还没合并）。PR 合并或关闭 → `closed`。新 head 按第 3 条处理。
3. **head 变化的归因**：GitHub 时间线不能说明普通推送是谁做的（`PullRequestCommit` 没有推送者；`HeadRefForcePushedEvent.actor` 只覆盖强推），所以**时间线不用于归因**。live 模式（阶段 5）只在意图日志里有对应的 `confirmed` 推送意图（`new_head` 相等）时接受新 head；其他任何 head 变化都是 `external_write`（新 head 不是 `published_head` 的后代时是 `head_regressed`）。影子模式没有意图日志，所以**任何 head 变化都停止影子链**（`stop_reason = attribution_unknown`）。影子链因此只覆盖“一个 head 上的决定”，这已足够回答 4-D 要回答的问题：在这个 head 上会不会预留、会不会判 `ready_for_human`、会因什么停止。

| 从 | 条件 | 到 | 影子模式下 |
|---|---|---|---|
| `awaiting_review` | 合格 `CHANGES_REQUESTED`，`rounds_used < grant.rounds` | `revision_reserved` | 不转换；写 `engineering_shadow_decisions(would_reserve)`，链留在 `awaiting_review` |
| `awaiting_review` | 合格 `CHANGES_REQUESTED`，额度用完 | `awaiting_decision`（`rounds_exhausted`） | 不出现（影子链没有额度） |
| `awaiting_review` | 第 1 条成立 | `ready_for_human` | 照常转换，并写 `would_mark_ready` |
| 任意非终态 | PR merged/closed | `closed` | 照常转换 |
| 任意非终态 | base 变化、评审冲突、截止时间到 | `awaiting_decision` | 照常转换，并写 `would_stop` |
| 任意非终态 | head 变化 | live：有 `confirmed` 意图 → `awaiting_review`，更新 `published_head`/`published_base`；否则 `awaiting_decision`（`external_write`/`head_regressed`） | `awaiting_decision`（`attribution_unknown`），并写 `would_stop` |

`revision_reserved`、`revising`、`publishing` 三个状态在阶段 4 只由属性测试里的 live 链走到，影子链被 §3.2 的 CHECK 禁止进入。

### 4.3 阶段 4 不实现的路径

子 Mission 派发、`publishRevision`、启动恢复（设计 §8.7）属于阶段 5。4-A 的存储层提供 `reserve()`、`recordIntent()`、`settleIntent()` 等 live API 及其单元/属性测试，但没有任何生产代码调用它们；4-D 的对账器拿不到这些方法（只传入 `ShadowChainWriter` 接口，§5.3）。live API 的不变式 3 由 §3.2 的部分唯一索引与 `current_mission_id` 触发器在数据库层保证，不依赖调用方，所以阶段 5 接入时不需要再改约束。

## 5. 读取与影子运行（4-C、4-D）

### 5.1 读取器

文件名与方案不同：方案 4.5 写的是 `contained-mission-bridge.ts`，但阶段 3 已用这个文件放 App 令牌与 check 发布。读取器放 `packages/cli/src/contained-mission-bridge-reader.ts`（新），对账器放 `contained-mission-bridge-shadow.ts`（新），均从 `contained-mission-rpc.ts` 懒加载。

读取分两层，两层之间是一个**不含任何正文**的中间格式 `PrSnapshot`：

```
传输（gh api graphql，可注入）──▶ 原始页 ──normalizeSnapshot()──▶ PrSnapshot ──decideChainStep()──▶ 决定
```

- **传输**：`gh api graphql`，主机凭证（阶段 3 已证实 App 令牌读不了分支保护；读取统一走主机凭证）。签名 `(query, variables) => Promise<unknown>`。
- **查询**：`pullRequest { state merged closed headRefName headRefOid headRepository{nameWithOwner} baseRefName baseRefOid }`，以及四个连接，每个都带 `pageInfo { hasNextPage endCursor }`：
  - `reviews(first:100)`：`databaseId state submittedAt commit{oid} author{__typename ... on User{databaseId} ... on Bot{databaseId}} body`
  - `reviewThreads(first:100)`：`id isResolved comments(first:100){ pageInfo{…} nodes{ databaseId pullRequestReview{databaseId} body author{…} } }`
  - `commits(first:100)`：`commit{oid}`（设计 §8.4 第 1 条、方案 4.5 要求读完）
  - `timelineItems(itemTypes:[HEAD_REF_FORCE_PUSHED_EVENT, BASE_REF_CHANGED_EVENT, BASE_REF_FORCE_PUSHED_EVENT, MERGED_EVENT, CLOSED_EVENT, REOPENED_EVENT], first:100)`：只用于检测 base 变化、合并与关闭，不用于推送归因（§4.2 第 3 条）。
- **分页**：顶层四个连接按 `endCursor` 读完；**每个**线程的 `comments` 若 `hasNextPage` 为真，用 `node(id:<thread id>){ ... on PullRequestReviewThread { comments(first:100, after:…) } }` 单独翻页。上限：单个连接 10 页，每周期总请求 40 个；任一连接超上限、任一请求失败或返回 `errors` → `snapshot_incomplete`，本周期放弃（设计 §8.4 第 1 条）。
- **`normalizeSnapshot()`**：把原始页转成 `PrSnapshot`：PR 的 head、base、状态；每条 review 的 `{ review_id, state, submitted_at, review_commit, reviewer:{app_id, actor_id} }`；每个登记评审者在当前 head 上的归约状态；对每条可能被选中的 review 计算 `has_feedback`（顶层正文或属于它的未解决线程非空）与 `feedback_digest = sha256(规范化顶层正文 + 按线程 id、评论 id 排序的未解决线程正文)`，规范化 = CRLF→LF、去行尾空白、去首尾空行。正文在这一步之后丢弃，`PrSnapshot` 不含任何正文、路径、login 或 URL。`User` 的 `app_id` 为 `null`，`Bot` 的 `app_id` 由登记表按 `actor_id` 反查。
- **二次读取**：决定要写 `would_reserve` 或 `would_mark_ready` 前，再读一次 `headRefOid`、`baseRefOid`、`baseRefName` 和所选 review 的 `state`；任一变化 → 丢弃本周期（`snapshot_moved`）。二次读取与写入之间仍有窗口；影子决定只是记录，下个周期会看到变化并按 §4.2 停止，所以不再加第三次读取。

### 5.2 登记表

`$OSSTACK_HOME/bridge/producers.json`（主机私有，不入仓库；缺失即影子关闭，存在但无效即启动失败）：

```json
{ "version": 1, "repository": "osborn-studio/osstack",
  "publisher": [{ "actor_id": 269190136, "app_id": null }],
  "reviewers": [{ "actor_id": 160148718, "app_id": null }, { "actor_id": 243772068, "app_id": null }] }
```

- 只按数字 id 匹配，不看 login（ADR-005）。
- `publisher` 只用于发现链时核对 PR 作者（与阶段 1 的 Mission PR 识别一致），不用于 head 归因。
- 发布者不能同时是评审者（ADR-005 规则 1），解析时拒绝。
- `gilosbornhello` 给的“计入批准”（ADR-006 风险 4）是 GitHub 侧的合并门槛，不是链的评审输入；它不登记为 reviewer。

### 5.3 影子对账器

- **开关**：`OSSTACK_BRIDGE=shadow` 且 `producers.json` 存在时启用；未设或 `0` 关闭；`1` 在阶段 4 启动时报 `BRIDGE_LIVE_NOT_IMPLEMENTED` 并拒绝启动服务。
- **与 App 凭证隔离**：影子对账器**不调用** `loadBridgeConfig`，也不依赖 `apps.json`、`rulesets.json`。它由 `contained-mission-rpc.ts` 单独构造，只接收：只读的 Mission 视图（`listPrOpened()`、`publication()`）、`ShadowChainWriter`（`createShadowChain`、`applyShadowDecision`、`appendEvent`）、读取器传输、时钟。它拿不到 `ContainedMissionHost`、runner、ports、`createBridgeKit` 或任何令牌源。
- **链的来源**：`pr_opened` 且 `publication.kind = 'opened'`、仓库等于登记表 `repository` 的 Mission，首次见到时建 `mode='shadow'` 链：`published_head = publication.pushed_commit`，`published_base = publication.base_head`。`base_head` 为 `null`、PR 作者不在 `publisher` 中、或同一个（仓库、PR）已被另一个 Mission 的影子链占用时不建链，写一条服务日志（不写链表，也不写 Mission 账本）。
- **节奏**：独立于 Mission tick 的定时器，默认每 5 分钟扫一遍非终态影子链，每次最多 10 条（游标续扫，与 `ContainedMissionHost.tick` 的写法相同）；同一条链两次读取至少间隔 5 分钟。整个周期在 Mission tick 之外异步运行，不 `await` 在 Mission 路径上（性能预算：loop tick 开销 < 1%）。
- **失败**：任何读取或解析错误只写 `read_failed` 事件（脱敏，复用 `redactBridge`），链不转换。

### 5.4 回放语料

两类语料，用途不同：

| 语料 | 来源 | 用来验证 | 不能验证 |
|---|---|---|---|
| **历史决定语料**（4-C） | `osborn-studio/osstack` #340–#363（方案 4.6），都不是 Mission PR，均已合并 | 每个 PR 一份**录制时刻的精确快照**：`normalizeSnapshot()` 与 `decideChainStep()` 在真实评审形态（多评审者、DISMISSED、COMMENTED、多个 head 上的 review）上的归约与选择 | 过去各时点的决定（见下）、链的发现、head 归因、端到端影子运行 |
| **沙箱 Mission 语料**（4-D） | 沙箱中经阶段 3 发布路径开出的 Mission PR（如 #13），由 `osstack-sandbox-test-reviewer` App 按脚本提交 review、推进 base、关闭 PR | 端到端影子运行的时间序列：链发现、周期、二次读取、停止 | 主仓库的评审者行为 |

- **不重建过去时点**：GraphQL 只返回当前状态。review 的 `commit.oid` 与时间线事件不能还原当时的 base SHA、线程当时是否已解决、review 何时被 DISMISSED，所以历史 PR 不生成逐时点快照。历史语料每个 PR 只有一份录制时刻的快照，决定断言只针对它；针对各个过去 head 的断言仅限于不依赖 base 与线程状态的部分（每个评审者在该 head 上的 review 归约）。
- **时间序列只来自实时录制**：沙箱 Mission 语料由脚本化场景生成，每一步（提交 review、推进 base、关闭）之后立即录制一份快照，时间点是真实的观察时刻。
- **录制**：`scripts/record-pr-timeline.mjs --repo <owner/name> --pr <n> [--pr …] [--append]` 用 §5.1 的同一组查询读 PR，在本机跑 `normalizeSnapshot()`，把 `PrSnapshot`（带 `observed_at`）写入或追加到 `packages/cli/src/__fixtures__/bridge/<repo>-<pr>.json`。原始页不落盘。沙箱场景脚本的写操作（test reviewer 的 review、base 推进）由场景脚本用 test reviewer App 与主机凭证完成，只针对沙箱仓库；对账器本身仍然只读。
- **去个人信息**：`PrSnapshot` 的 JSON Schema 是白名单（只允许 id、oid、状态、时间戳、digest、布尔值），录制脚本按 schema 校验，多出任何字段即失败。`actor_id` 用每个文件内一致的假名（`a1`、`a2`…）替换，文件自带对应的假名登记表；脚本最后扫描输出，任一源 login、真实数字 actor id、URL、`@` 或邮箱模式出现即失败。沙箱 App 的 id 是公开的 ADR-006 内容，同样替换，保持两类语料格式一致。
- **转换器单独测试**：`normalizeSnapshot()` 用手写的合成原始页（含正文、空正文、多页评论、DISMISSED）测试，不依赖录制语料。
- **断言方式**：回放测试不只比对快照，而是对每个文件断言不变式：每条 `would_reserve` 的 review 来自登记评审者且绑定当时的 head 与 base；同一 head 最多一条 `would_reserve`；head 变化后链不再产生 `would_reserve`；无 `read_failed`；无未分类的丢弃原因。事件序列快照另外保存，用于发现回归。

## 6. 测试计划

| PR | 测试 | 通过标准 |
|---|---|---|
| 4-A | 单元：每条转换、每个丢弃原因、每个停止条件；DDL 触发器（不可变字段、终态、额度、影子链 CHECK、影子写入拒绝、意图转换、一个在途预留、`current_mission_id` 绑定）；同一条链在两个不同 head 上并发 `reserve()` 只成功一个；`engineering_shadow_decisions` 重复写入幂等（重启后重跑同一周期不产生第二条） | 全部通过 |
| 4-A | 属性（fast-check，新增 core 的 devDependency）：随机交错 review（登记/未登记、四种状态、旧 head）、发布者推送（带/不带 `confirmed` 意图）、外人普通推送与强推、head 回退、base 变化、PR 关闭、截止时间（有效/缺失/过去）、崩溃（事务中途抛错后重放）、两个对账器并发 | 不变式 1–4 与 6 在每次运行后成立；不变式 5（子 Mission 规格继承）属于阶段 5，此处不测。`pnpm test` 中 1 000 次，`OSSTACK_PROPERTY_RUNS=10000` 时 10 000 次（设计 §10.3），CI 加一步跑 10 000 次 |
| 4-A | 变异检查（手工，记入 PR 描述）：去掉预留主键、去掉在途唯一索引、去掉额度触发器、去掉 base 比较、去掉影子写入触发器、把“任何 head 变化停止影子链”改成接受后代 head | 每个变异都有测试失败 |
| 4-B | TLC：链、2 个评审者、1 个外人（普通推送与强推）、崩溃；不变式 1–4、6 | 无反例；状态数与运行时间记入 PR |
| 4-C | 读取器：顶层分页、单个线程评论翻页、`commits` 读完、上限与 `errors` 放弃、二次读取变化；`normalizeSnapshot()` 合成用例；录制脚本的 schema 白名单与扫描（喂入含 login、URL、邮箱的输入，确认失败） | 全部通过 |
| 4-D | 历史决定语料与沙箱 Mission 语料回放（§5.4 的不变式断言）；开关矩阵（未设、`0`、`shadow`、`1`、缺 `producers.json`、无效 `producers.json`）；两个 Mission 指向同一 PR 时只建一条链；**负向集成测试**：在真实的服务装配中跑一个影子周期，对令牌源（`createInstallationTokenSource`、`createBridgeKit`）、Mission 写入（store 的每个写方法）、runner/派发、以及传输中任何 `mutation` 查询打桩计数，断言全部为 0；Mission 账本在影子运行前后逐行相同 | 全部通过 |

每个 PR 开出前照方案 §7：`pnpm build`、`pnpm typecheck`、受影响包的测试（全套交给 CI）、CLI 启动预算、Codex 只读审查。

## 7. 与上位文档的偏差

| 偏差 | 理由 |
|---|---|
| 另加两张表 `engineering_revision_chain_events`、`engineering_shadow_decisions` | §3.2 |
| 读取器与对账器的文件名 | `contained-mission-bridge.ts` 已被阶段 3 占用（§5.1） |
| “所有登记评审者 APPROVED”改为“参与评审者集合非空且全部批准” | 登记评审者是 6 个自动化账号，“全部”达不到（§4.2 第 1 条；待用户确认） |
| 影子链不模拟轮次，任何 head 变化都停止 | GitHub 时间线不能归因普通推送（§4.2 第 3 条） |
| live 模式的 head 归因只认 `confirmed` 推送意图 | 同上；设计 §8.7 已有意图日志，这里把它定为唯一依据 |
| 回放分两类语料，历史 PR 只验证决定函数 | #340–#363 不是 Mission PR（§5.4） |
| 链表增加 `mode`、`stop_reason`、`revision` | 影子与真实链共存、可审计的停止原因、乐观并发 |

## 8. 需要用户做的决定

1. **4-B 是否下载 TLC**：需要从 GitHub Releases 下载 `tla2tools.jar`（约 4 MB，`tlaplus/tlaplus` 官方发布）到 `$OSSTACK_SCRATCH_ROOT` 下，CI 中同样下载并校验 sha256。不同意则 4-B 推迟，4-A/4-C/4-D 不受影响。
2. **主仓库是否开影子运行**：4-D 合并后，在宿主机上对 `osborn-studio/osstack` 设 `OSSTACK_BRIDGE=shadow` 只产生只读 GraphQL 请求和本地链表写入；需要宿主机 `OSSTACK_HOME/bridge/producers.json`，其中登记名单由你确认。默认只在沙箱开。
3. **`ready_for_human` 规则**（§4.2 第 1 条）：是否接受“参与评审者集合非空且全部批准”代替设计的“所有登记评审者批准”。阶段 4 只记录，不影响动作；阶段 5 开工前必须定下。

## 9. 审计记录

**第 1 轮（Codex CLI gpt-6-sol，medium，只读，基于初稿）：** 3 个 P1、6 个 P2、1 个 P3。逐条核对后全部接受：

| 发现 | 处理 |
|---|---|
| P1 head 归因不成立：`PullRequestCommit` 没有推送者，`HeadRefForcePushedEvent` 只覆盖强推 | §4.2 第 3 条：时间线不用于归因；live 只认 `confirmed` 推送意图；影子链遇任何 head 变化即停止（`attribution_unknown`） |
| P1 影子轮次在无关推送上被计入；`shadow_reserved_head` 没有定义 | 影子链 `rounds_used` 恒为 0（CHECK）；影子决定移到按（链、head、动作）唯一的 `engineering_shadow_decisions` |
| P1 回放语料去掉正文后，读取器无法复现选择逻辑 | §5.1 分两层：`normalizeSnapshot()` 在本机算 `has_feedback` 与 digest 后丢弃正文；录制与回放都用 `PrSnapshot`；转换器用合成数据单独测试 |
| P2 嵌套评论分页未定义，漏了 `commits` 连接 | §5.1：每个线程的评论单独翻页，`commits` 读完，上限与 `errors` 都放弃本周期 |
| P2 数据库不保证每链一个在途子 Mission | §3.2：在途预留部分唯一索引，`current_mission_id` 触发器；§6 加并发预留测试 |
| P2 `ready_for_human` 规则与设计不等价 | §4.2 第 1 条：明确为政策修改，定义按 head 固定的参与评审者集合，列为 §8 决定 3；§6 覆盖缺席、DISMISSED、COMMENTED、冲突 |
| P2 用非 Mission PR 合成链会验证错的行为 | §5.4：历史语料只验证决定函数；端到端用沙箱 Mission 语料；按不变式断言 |
| P2 去个人信息的断言不够 | §5.4：schema 白名单、actor id 假名化、扫描源 login、真实 id、URL、`@`、邮箱 |
| P2 影子与 App 凭证的隔离没有在真实装配上验证 | §5.3：影子对账器不调用 `loadBridgeConfig`，单独构造，只拿只读视图与 `ShadowChainWriter`；§6 加负向集成测试 |
| P3 测试计划漏了关键边界 | §6 补充普通推送、嵌套翻页、二次读取后变化、重启重复决定、多 Mission 同 PR、截止时间缺失或无效 |

**第 2 轮（Codex CLI gpt-6-sol，medium，只读，基于第 1 轮修订稿）：** 第 1 轮 10 项中 8 项判为已解决，2 项部分解决；新增 1 个 P1、3 个 P2。逐条核对后全部接受：

| 发现 | 处理 |
|---|---|
| 部分：`current_mission_id` 在预留转 `void` 后即可更换，旧子 Mission 可能仍在运行 | §3.2：更换要求旧子 Mission 终态且 `stop_obligation=0`，预留不在在途状态 |
| 部分：`ready_for_human` 政策修改未确认 | 保留为 §8 决定 3，阶段 5 开工前定下 |
| 新 P1 影子写入拒绝只查 `INSERT`，live 行可经 `UPDATE` 改挂到影子链 | §3.2：两表的 `chain_id` 与主键字段禁止 `UPDATE` |
| 新 P2 grant 额度约束没写出，`rounds` 缺失时比较为 NULL | §3.2：按 `mode` 分别 CHECK grant 形状与额度，缺失字段判为假 |
| 新 P2 `ready_for_human` 遇新 head 回到 `awaiting_review` 与影子规则矛盾 | §3.2 终态触发器说明改为按模式区分 |
| 新 P2 历史 PR 不能重建过去时点的快照 | §5.4：历史语料只录当前时刻的精确快照；时间序列只来自沙箱的实时录制 |
