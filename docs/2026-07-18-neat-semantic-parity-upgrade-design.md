# osstack `neat` 语义对等升级实施规格（Semantic Parity Upgrade, U 系列）

| 项 | 内容 |
|---|---|
| 状态 | **Implemented v2.0 — Auditable semantic hygiene beta release candidate**；U0–U4 能力与 U5 工具链已实现；Khazix parity claim 因外部 hidden evidence 未就绪保持 No-Go |
| 日期 | 2026-07-18 |
| 作者 | Claude Fable 5（CTO 席）+ Osborn；v2.0 contract checker/editor：Codex |
| 前置文档 | v2 规格 `2026-07-17-neat-product-technical-spec-v2.md`（Implemented，R0–R4 已验收）；v1 设计稿（Historical）；ADR-002 |
| 触发原因 | 独立复审确认：当前 neat 是对 neat-freak 的"工程化拆分与扩展"而非等价移植——语义理解 / 记忆整理 / 文档叙事修正 / 跨项目影响推断四项能力缺失或明显不足，且从未做过与原版的等价验证 |
| 升级目标 | 在**不放弃确定性保证**的前提下补齐四项语义能力，并以可复现实验证明达到（或超过）原版 neat-freak 的功能与效果 |
| 约束 | 本文是实现与验收的权威合同；每个工作包独立 PR；实现走 maker/checker 分工；发现偏差先改本文再改代码 |

### 实施授权矩阵

| 增量 | 裁定 | 约束 |
|---|---|---|
| U0a | **GO：可立即编码** | 先实现内部 detector、fixture 与 V1 human 诚实提示；V2 前不得从公共 JSON 发射新 rule id |
| U0b | **GO after U0a contract tests** | 必须先落 `ReportV2` / `FindingV2` / `ConfigV2`，再公开 U0 新 findings |
| U1 | **Phase-gated GO** | 依赖 U0b；首个 judge 仅允许通过 `SemanticJudgePort` conformance 的 no-tool provider |
| U2–U3 | **Phase-gated GO** | 依赖 U1；写入必须经过批准工件与 crash-recoverable applier |
| U4 | **Phase-gated GO** | 依赖 ConfigV2、Core inbox migration；不得主动写下游仓库 |
| U5 | **Phase-gated GO** | 语料标签与统计协议必须在运行基准前冻结 |

---

## 0. CTO 判断：这次升级的正确姿势

复审给出的十行差异表成立。但结论不应该是"把 LLM 塞回 CLI，回到原版的做法"——那等于放弃 v2 花了整个 R0–R4 挣来的可验证性，退回"高覆盖、不可验证"的原点。

**正确的升级公理只有一条：语义工作不豁免于契约。** 原版 neat-freak 的语义能力之所以"效果好"，是因为它自由；也正因为它自由，它不可审计、不可复现、无法知道自己漏了什么。本方案把 LLM 判断引入 neat，但每一次语义判断都必须：

1. **证据受限（evidence-bound）**：LLM 只消费引擎准备好的有界证据包，不自由漫游仓库；
2. **出处可核（source-verified）**：每条语义 finding 必须引用精确文件内容；引擎只能证明出处未伪造，不能据此证明推理成立；
3. **动作可验（deterministically verifiable action）**：每条语义 finding 携带闭集后置条件；引擎证明动作是否完成，语义是否解决由规则的 closure policy 决定；
4. **诚实申报（coverage-honest）**：报告必须声明哪些维度**没有**审——"0 findings" 永远不得冒充"通过了完整知识卫生审查"。

这样得到的不是"原版的复刻"，而是原版从未有过的东西：**可审计的语义知识卫生**。等价验证（§7）负责证明它在效果上不输原版。

### 复审反例的根因分解（指导优先级）

`AGENTS.md` 含 60+ 行会话历史而 CLI 报干净，其实是**三个独立缺陷**叠加，对应三个不同修法：

| 缺陷 | 性质 | 修法 | 归属 |
|---|---|---|---|
| "历史叙事混入规则手册"没有任何检测手段 | 检测缺口 | 先上**确定性叙事启发式**（日期前缀行、会话摘要标记、memory-context 块的模式识别）——这个具体反例根本轮不到 LLM 出手 | U0 |
| 语义级的叙事/矛盾/漂移判断整体缺席 | 能力缺口 | 语义审计通道（evidence-bound LLM pass） | U1 |
| 报告把"没违反闭集规则"呈现为"complete" | **诚实性缺口（最严重）** | 保留 `completeness` 的 inventory 含义；新增 `coverage` 与 `health_claim`，显式列出未审维度 | U0，最高优先级 |

第三条是信任问题，先于一切能力建设。

2026-07-18 在当前仓库基线实跑 `node packages/cli/dist/bin.js neat check --repo . --all --format human`：exit 0，输出 `0 error, 0 warning, 0 info`、`No active findings`、`Completeness: complete`；同一 `AGENTS.md` 明确含 `<claude-mem-context>` 会话史块。这条 as-is 结果冻结为 U0 回归基线：U0a 仍保持 V1 JSON，但 human 输出必须承认 semantic 未审；U0b V2 必须产生 `rulebook.managed_context_block`。

---

## 1. 目标能力与总体架构

### 1.1 四项目标能力 → 五个升级增量

| 复审指出的不足 | 升级增量 | 交付物 |
|---|---|---|
| （信任前提）零发现被误读 | **U0 诚实性与速赢** | 覆盖面申报 + 确定性叙事启发式 + 反例回归测试 |
| 理解语义（矛盾/漂移/叙事） | **U1 语义审计通道** | `neat semantic`：evidence-bound LLM findings，锚点核验 |
| 整理记忆（毕业/合并/清理的**执行**） | **U2 记忆毕业事务** | `neat memory plan/approve/apply/recover`：批准工件 + 可恢复写入 + 去除台账 |
| 修正文档叙事（实际编辑指令文件/docs） | **U3 叙事手术** | patch-plan 工件 + 机械施行 + 后置断言 |
| 推断跨项目影响 | **U4 跨仓影响推断** | 候选依赖边（确定性）+ LLM 排序推断（advisory→confirmed） |
| （元要求）效果从未等价验证 | **U5 等价验证战役** | 双跑对照实验 + 语义召回基准 + 盲评 + 验收线 |

### 1.2 架构：三层取代两层

```
┌────────────────────────────────────────────────────────────────┐
│ L3 决策与批准层（人/skill）                                       │
│   审阅证据与计划工件 · 批准/否决 · 发起施行；不徒手检查、不直接写文件 │
├────────────────────────────────────────────────────────────────┤
│ L2 语义判断层（新增：LLM via SemanticJudgePort，见下）             │
│   消费引擎证据包 → 产出锚点化结构 findings / plan 草案（仅提案）     │
│   headless（daemon/daily 可跑）与交互（skill 驱动）同一编排         │
├────────────────────────────────────────────────────────────────┤
│ L1 确定性引擎（既有 v2，扩展）                                     │
│   证据包制备 · 锚点核验 · 闭合条件判定 · 去除台账核验 · 覆盖面申报    │
│   受限 applier（唯一写字节组件）· 策略门 · 复合指纹 · 历史/趋势 · 评测 │
└────────────────────────────────────────────────────────────────┘
```

写入权责统一声明（复审阻断第 6 项）：**L2 只提案，L3 批准并发起，受限 L1 applier 是唯一向文件写入字节的组件**——v1 中"L3 是唯一动散文的地方"与"L1 机械施行"的表述冲突，以本条为准：L3 决定写什么，L1 applier 执行怎么写。

关键点：**L2 不是 skill 的别名**。今天 neat-skill 的语义工作之所以“只能部分补足”，是因为它无契约、无工件、无验证。L2 把语义工作变成引擎编排的一个**受契约管辖的阶段**：输入输出都有 schema，跑没跑、看了什么、断了什么，全部留痕。skill（L3）只承担交互驱动、证据解释和批准收集，不执行文件写入。

``neat-skill``（L3）只负责解释证据、收集批准并调用正式命令；它不得直接编辑目标文件，也不得绕过 plan revision、policy gate 或 applier。headless 模式可以生成 finding/plan，但不得自行批准写入动作。

LLM 接入经新增 **`SemanticJudgePort`**（复审阻断第 1 项：现有通用 agent 执行契约不满足证据隔离——`AgentTask` 收自由 prompt、adapter 是带工具的完整 agent、`OSSTACK_AUTOAPPROVE=1` 可绕权限，仓库文本还构成 prompt injection 面）。该 port 的硬契约：**只接收证据 JSON、使用空临时 cwd、无工具、无 MCP、无 skill/项目设置、环境变量白名单、证据入包前敏感信息脱敏、固定输出 schema、单轮调用**。注入测试证明的是 containment（无工具事件、无仓库/环境读取、无未脱敏输出），不虚假承诺任意注入文本都不影响概率性判断。底层供应商 SDK 与凭据探测可复用，但**不复用通用 `AgentAdapter.invoke` 执行契约**。builder≠judge 纪律保持：L2 生成 findings/plan 的模型不得充当 U5 编辑质量裁判；主实验 A/B 仍按 §7.2 使用同一模型控制变量。

### 1.3 代码所有权与依赖方向

| 包 | 新职责 | 禁止事项 |
|---|---|---|
| `@osstack/governance` | U0 detector、V2 Zod/JSON Schema、证据包、`SemanticJudgePort` 接口、语义编排、受限 applier | 不依赖供应商 SDK、不访问全局 registry |
| `@osstack/agents` | 实现通过 conformance 的供应商 judge；首个实现基于已安装的 Claude Agent SDK | 不复用通用 code agent；不得暴露工具、cwd、全量环境变量 |
| `@osstack/core` | V2 history/resolution events、plan/recovery journal、跨仓 obligation inbox | 不解释语义、不直接编辑仓库 |
| `@osstack/cli` | 参数解析、依赖装配、人类输出、批准入口、退出码 | 不包含规则逻辑或自由文本解析 |
| `@osstack/supervisor` | portfolio 投影与 daily 未读义务摘要 | 不成为 confirmed dependency 的权威 |

依赖方向为 `governance contracts ← agents implementation ← cli composition`；`core` 只接收已经过 governance schema 验证的持久化输入。不得形成 governance → agents 的反向依赖。

---

## 2. U0 — 诚实性与速赢（先修信任，再谈能力）

### 2.1 覆盖面申报（completeness 语义修正）

- 报告结构新增 `coverage` 区，状态为闭集**五态**：`complete` / `partial` / `not_assessed` / `truncated` / `failed`。语义维度使用候选生成器，申报上限为 `partial`；`complete` 只允许可穷举的机械维度。
- `completeness` 保持 V1 已有的“仓库 surface inventory 是否完整”含义，不改字段语义；它从来不是健康结论。V2 另增 `health_claim`，禁止消费者从 `completeness.complete` 推导“仓库干净”。
- V1 human 输出在零 findings 时立即改为：`No findings in the mechanical V1 rule set; semantic dimensions were not assessed.` 这是 U0a 可独立发布的诚实性修复，不改变 JSON schema。
- `neat-skill`、daily、supervisor 和 loop finalizer 不得在 coverage 非完整时输出无范围限定的 `clean` / `healthy`。

#### 2.1.1 `CoverageDimensionV2`

```ts
type CoverageState =
  | "complete"
  | "partial"
  | "not_assessed"
  | "truncated"
  | "failed";

type SemanticProviderFailureCodeV1 =
  | "cancelled"
  | "transport_error"
  | "request_timeout"
  | "authentication_failed"
  | "rate_limited"
  | "http_error"
  | "response_too_large"
  | "invalid_provider_json"
  | "invalid_provider_response"
  | "model_identity_mismatch"
  | "missing_completion_choice"
  | "tool_activity"
  | "output_token_limit_reached"
  | "content_filtered"
  | "insufficient_system_resource"
  | "unsupported_finish_reason"
  | "missing_json_content"
  | "invalid_json_content"
  | "missing_result"
  | "provider_result_error"
  | "missing_structured_output"
  | "stale_nonce"
  | "unknown_provider_error";

interface CoverageDimensionV2 {
  dimension:
    | "mechanical"
    | "narrative"
    | "contradiction"
    | "drift"
    | "memory_overlap"
    | "cross_repository";
  state: CoverageState;
  source_units_total: number;
  candidates_generated: number;
  candidates_assessed: number;
  candidates_skipped: number;
  reason_codes: Array<
    | "not_requested"
    | "bounded_candidate_generator"
    | "input_budget_exhausted"
    | "output_budget_exhausted"
    | "call_budget_exhausted"
    | "judge_unavailable"
    | "scan_incomplete"
    | "provider_error"
  >;
  provider_failure_code?: SemanticProviderFailureCodeV1;
}
```

计数不变量：全部计数为非负整数；`candidates_assessed + candidates_skipped = candidates_generated`。状态 refinement 固定为：

- `complete`：`candidates_skipped=0`、`reason_codes=[]`；
- `partial`：必须含 `bounded_candidate_generator`，不得含 budget/provider/scan failure reason；
- `not_assessed`：四个 candidate 计数均为 0，reason 只能是 `not_requested` 或 `judge_unavailable`；
- `truncated`：至少一个 skipped，且至少含一个 `*_budget_exhausted`；
- `failed`：必须含 `scan_incomplete` 或 `provider_error`，已完成的 assessed 计数仍保留；
- `dimension` 唯一且按本文枚举顺序输出；未请求维度必须是 `not_assessed/not_requested`。

`provider_failure_code` 只允许出现在 `state="failed"` 且
`reason_codes` 含 `provider_error` 的覆盖记录中。该字段只保留封闭错误码，不得持久化
HTTP 响应正文、SDK 异常文本、供应商错误详情或凭据；未识别异常统一映射为
`unknown_provider_error`。字段为可选，旧 V2 报告继续由新 reader 接受。
DeepSeek/OpenAI-compatible `finish_reason` 固定映射为：`length` →
`output_token_limit_reached`、`content_filter` → `content_filtered`、
`insufficient_system_resource` → 同名错误码、`tool_calls` → `tool_activity`；
空值、未来新增值或其他未识别值统一映射为 `unsupported_finish_reason`，禁止把原值写入报告。

#### 2.1.2 `FindingV2` 与 `ReportV2` 最小合同

V1 的 `surface/location/evidence_refs` 不能表达 registry obligation 或外部 adapter URI。V2 不直接 `.extend()` strict V1，而是复用其余字段并替换这三个字段：

```ts
type KnowledgeHygieneSurfaceV2 =
  | KnowledgeHygieneSurfaceV1
  | "dependency";

type KnowledgeHygieneLocationV2 =
  | {
      kind: "repository_scope"; // whole-repository findings such as scan.incomplete
      repo_id: string;
    }
  | {
      kind: "repository";
      repo_id: string;
      path: string;             // portable repository path
      line?: number;
      anchor?: string;
    }
  | {
      kind: "adapter";
      adapter_id: string;
      uri: string;              // adapter-owned opaque URI, never an inferred private path
      line?: number;
      anchor?: string;
    }
  | {
      kind: "registry";
      registry_scope: string;   // sha256(canonical registry path)
      repo_id: string;
      obligation_id?: string;
      edge_id?: string;
    };

type KnowledgeHygieneEvidenceRefV2 =
  | KnowledgeHygieneEvidenceRefV1
  | { kind: "evidence_pack"; ref: string; sha256: string; run_id: string }
  | { kind: "obligation"; ref: string; sha256: string; run_id?: string };
```

location/citation refinement：repository path 必须是无 NUL、非绝对、无 `..` 的 POSIX portable path；registry location 的 scope 为 64 位小写 SHA-256，且 `obligation_id/edge_id` 恰有一个；line 为正整数且 `end_line >= start_line`；excerpt 按 UTF-8 计 ≤1 KiB。`surface=dependency` 只允许 repository 或 registry location；其他 surface 不允许 registry location。

`FindingV2` 继续使用 strict Zod，类型等价于 `Omit<KnowledgeHygieneFindingV1, "rule_id" | "surface" | "location" | "evidence_refs">` 加上下列必填字段：

```ts
interface FindingV2Extension {
  rule_id: KnowledgeHygieneRuleIdV2;
  surface: KnowledgeHygieneSurfaceV2;
  location: KnowledgeHygieneLocationV2;
  evidence_refs: KnowledgeHygieneEvidenceRefV2[];
  origin: "mechanical" | "semantic";
  dimension: CoverageDimensionV2["dimension"];
  closure_policy: "mechanical_sufficient" | "semantic_confirmation_required";
  citations: Array<{
    source:
      | { kind: "repository"; repo_id: string; path: string }
      | { kind: "adapter"; adapter_id: string; uri: string };
    blob_sha256: string;       // evidence-pack snapshot, not current mutable file
    start_line: number;
    end_line: number;
    text_sha256: string;
    excerpt: string;           // redacted, <= 1 KiB
  }>;
}
```

`KnowledgeHygieneRuleIdV2` 是 V1 枚举的超集，新增且只新增：

- `rulebook.managed_context_block`
- `rulebook.narrative_block`
- `rulebook.narrative_density`
- `rulebook.invalid_waiver`
- `dependency.review_due`
- `semantic.narrative`
- `semantic.contradiction`
- `semantic.drift`
- `semantic.memory_overlap`
- `semantic.cross_repository_impact`

`ReportV2` 使用 `schema_version: "2"`，保留 V1 的 `generated_at/repo/input/completeness/summary/metrics/adapters`，将 `findings/resolved_findings` 升级为 V2，并新增：

```ts
interface ReportV2Extension {
  coverage: CoverageDimensionV2[];
  health_claim:
    | "findings_present"
    | "assessed_scope_clean"
    | "assessment_incomplete";
  rejection_counts: Partial<Record<
    "schema_error" | "quote_mismatch" | "input_drift" |
    "unsupported_claim" | "low_confidence" | "provider_error",
    number
  >>;
}
```

`health_claim` 优先级固定为：任何已请求维度为 `failed/truncated/not_assessed` → `assessment_incomplete`；否则 findings 非空 → `findings_present`；否则 → `assessed_scope_clean`。最后一种仍必须随 coverage 范围呈现，不得渲染为全局健康证明。

#### 2.1.3 V1 → V2 兼容策略

1. U0a 只实现内部 detector、fixture 和 V1 human 诚实提示；**不得修改 `KnowledgeHygieneRuleIdV1`，不得从 V1 JSON 发射新规则**。
2. U0b 建立 V2 schema、JSON Schema 与 engine internal model；公开 U0 findings 只能从 V2 发射。
3. `neat check --schema-version <1|2>` 在一个 minor release 内提供兼容；默认 `2`。显式选择 `1` 时只运行 legacy V1 rule set、向 stderr 打印退役提示，且拒绝 semantic/new-rule flags。下一 minor 移除 V1 writer。
4. review/history reader 至少跨两个 minor 同时接受 V1/V2；V1 resolution 投影为 V2 terminal event，原始记录不覆写。所有新写入只写 V2。
5. `neat semantic` 固定输出 V2，传 `--schema-version 1` 返回 usage error（exit 2）。
6. `ConfigV2` 使用 `version: 2`，扩展 V1 的 `ignore` rule enum，并新增 `semantic` 与 `dependencies`；ConfigV1 继续可读，但不能声明 V2-only waiver/dependency。

消费方升级顺序固定为：governance schemas → CLI parser/renderer → Core store/migration → review/trend/propose → loop finalizer → supervisor/daily → neat-skill → smoke/golden/docs。顺序中任一消费者未支持 V2，不得切换默认 writer。

#### 2.1.4 `ConfigV2` 可解析合同

V2 保留 V1 的 `instructions/required_surfaces/budgets/contracts/adapters`，替换 `version/ignore` 并新增以下 strict 字段；省略 `semantic` 等价于 `enabled: false`，省略 `dependencies` 等价于空数组：

```ts
type SemanticDimensionV2 =
  | "narrative"
  | "contradiction"
  | "drift"
  | "memory_overlap";

interface SemanticConfigV2 {
  enabled: boolean;                 // default false
  judge_id?: string;                // enabled=true 时必填
  dimensions: SemanticDimensionV2[];// unique；default ["narrative"]
  schedule: "manual" | "daily";   // default manual；daily 只允许 narrative
  max_input_tokens: number;         // default/range 同 §3.1
  max_output_tokens: number;
  max_calls: number;
}

interface DeclaredDependencyV2 {
  edge_id: string;                  // ^khe_[a-f0-9]{64}$
  upstream_repo_id: string;
  direction: "depends_on";
  kinds: Array<"api" | "sdk" | "env_name" | "url" | "symbol" | "path">;
  owner: string;
  evidence_refs: KnowledgeHygieneEvidenceRefV2[];
  confirmed_at: string;             // RFC 3339
  review_after: string;             // RFC 3339, strictly after confirmed_at
}

type KnowledgeHygieneConfigV2 = Omit<
  KnowledgeHygieneConfigV1,
  "version" | "ignore"
> & {
  version: 2;
  ignore: Array<{
    rule_id: KnowledgeHygieneRuleIdV2;
    paths: string[];                // V1 bounded path rules; bare ** forbidden
    reason: string;
  }>;
  semantic?: SemanticConfigV2;
  dependencies: DeclaredDependencyV2[];
};
```

refinement 固定为：所有数组去重；`kinds` 非空；`edge_id` 不重复；dependency evidence 至少一条；`review_after > confirmed_at`；`semantic.enabled=false` 时不得配置 `judge_id` 或 daily；daily 只允许 `dimensions=["narrative"]`。ConfigV1 → internal V2 projection 只补默认值，不把 V2 数据反写入 V1 文件。

这是本方案中成本最低、优先级最高的一条：它把复审引语——"零发现只代表没有违反当前封闭规则集"——从批评变成产品自己说出口的话。

### 2.2 确定性叙事启发式（不动用 LLM 就能抓住的那部分）

U0a detector 只扫描 inventory 中 `surface=instruction` 的真实 canonical 文件；import-only mirror 不重复扫描，`docs/` 与 CHANGELOG 永不进入本规则。规则参数在本文冻结，不得留到 PR 临时决定：

| rule id | 确定性触发 | severity / confidence | remediation |
|---|---|---|---|
| `rulebook.managed_context_block` | 独立行匹配 `<claude-mem-context...>` 至闭标签；或下述精确 HTML comment marker 管理块。缺闭标签时锚到 EOF | warning / high | agent_edit |
| `rulebook.narrative_block` | 同一 section 内至少 5 条 observation/session 记录，或至少 5 个连续日期前缀事件行；泛化日期规则只匹配行首事件列表，不匹配代码围栏 | warning / medium | agent_edit |
| `rulebook.narrative_density` | 非空、非围栏行中 suspicious lines **至少 8 行且占比 ≥20%** | warning / medium | agent_edit |
| `rulebook.invalid_waiver` | pragma 未知 rule、缺 reason、未紧邻目标或语法不闭合 | warning / high | human_decision |

HTML marker start 只接受 `<!-- ECC:SUMMARY -->` / `<!-- ECC:SUMMARY START -->` / `<!-- SessionStart hook -->` / `<!-- SessionStart hook START -->`；end 只接受对应 token 的 `... END -->` 或 `<!-- /<token> -->`，比较时大小写敏感。start 后未找到 end 则锚到 EOF。实现不得用“任意包含 SessionStart 的行”这种宽松匹配。

明确的 suspicious line 词法集合为：ISO 日期开头的列表事件；`Session summary/会话摘要/Compaction occurred`；`Legend:`、`Stats:`、`Fetch details:`、`Access <n> tokens`；以及 `<数字 observation-id> <时间> <事件类型> <摘要>`。第一人称密度不进入 U0a，因为跨语言精确率不足，留给 U1 narrative。

豁免只有两条正式路径：

1. V2 config `ignore` 使用精确 rule id + 有界 path pattern + 非空 `reason`；继续禁止 `**` 全局 suppression。
2. 紧邻目标行/管理块前一行的 pragma：`<!-- osstack-neat-disable-next-line <rule-id> reason="<non-empty>" -->`。它只豁免下一行；若下一行是已识别 managed block，则豁免整个块。未知 rule、缺 reason、孤立 pragma 均作为 `rulebook.invalid_waiver` finding；该 id 也加入 `KnowledgeHygieneRuleIdV2`。

所有 U0 findings 的机械关闭只证明嫌疑块离开 instruction surface；若执行 `move`，目的地守恒按 §4.2 验证。U1 可确认或否决 medium-confidence finding，但 U0 findings 在 U1 未运行时仍必须可见，不能用“之后由 LLM 消噪”掩盖机械误报。

U0a 评测集在 detector 编码前冻结，至少包含 30 个标注块：≥10 个 positive、≥20 个易误伤 negative，并覆盖当前 AGENTS.md 真实反例、标签变体、未闭标签、合法日期规则、代码围栏、合法 CHANGELOG/docs 叙事和 20% 边界。发布门：显式 marker recall = 100%；总体 recall ≥90%；precision ≥90%；当前真实反例必须产生 `rulebook.managed_context_block`，不得依靠泛化规则碰巧命中。

---

## 3. U1 — 语义审计通道 `neat semantic`

### 3.1 命令面

完整 CLI grammar（复审要求：可解析的正式文法，替代 v1 的示意写法）：

```
osstack neat semantic
  [--repo <path>]                     # 默认 cwd；与 --base/--head 可同用
  [--base <git-ref> [--head <git-ref>]]  # 变更集模式；--head 仅在 --base 存在时合法
  [--all]                             # 全量模式；与 --base/--head 互斥
  [--dimensions <d1,d2,...>]          # 闭集：narrative|contradiction|drift|memory-overlap；默认 narrative
  [--judge <judge-id>]                # SemanticJudgePort id；不是通用 agent adapter id
  [--max-input-tokens <n>]            # 默认 32000，合法范围 1..250000
  [--max-output-tokens <n>]           # 默认 4000，合法范围 1..32000
  [--max-calls <n>]                   # 默认 8，合法范围 1..64
  [--allow-truncated]                 # 显式接受预算截断；默认截断 exit 3
  [--config <path>]
  [--schema-version 2]                # semantic 只支持 V2
  [--format <human|json>] [--json]
  [--record] [--db <path>]
  [--fail-on <error|warning|none>]
```

重复 flag、未知维度、非整数/越界预算均为 usage error。`--all` 与 `--base/--head` 互斥；`--head` 依赖 `--base`；`--db` 依赖 `--record`；`--json` 与 `--format human` 冲突。任一预算触顶必须产生 `truncated` coverage；默认 exit 3，只有显式 `--allow-truncated` 才按 finding threshold 返回 0/1。

退出码固定为：0=所请求通道完成且未触发 threshold；1=完成且触发 threshold；2=参数/config/schema 错误；3=judge/runtime/scan 失败，或所请求维度出现未获准的 `failed/truncated/not_assessed`。正常的 bounded-candidate `partial` 不导致 exit 3，但 human 输出必须显示范围限定。

- 独立动词而非 `check` 的 flag（**复审已裁定确认**）：成本模型完全不同（LLM 调用、预算、耗时），必须显式触发；daily/daemon 可按预算配置定时跑。
- 输出使用 ReportV2/FindingV2，进同一 review/trend/propose 通路。`--judge` 不复用现有 `--adapter claude-code`：后者仍专指只读 memory surface adapter，避免一个 flag 承担两种安全语义。

### 3.2 证据包制备（引擎侧，确定性）

按维度生成有界证据包。证据包默认只在内存中存在；报告仅保存 pack SHA-256、redacted citation 与 provenance。调试需要保留全文时必须显式启用 `OSSTACK_NEAT_DEBUG_EVIDENCE=1`，写入 `$OSSTACK_HOME/neat/evidence/<run-id>/`，目录 0700、文件 0600、默认保留 7 天且永不进入仓库。

| 维度 | 证据包内容 | 界定方式 |
|---|---|---|
| narrative | U0 启发式命中行段 ± 上下文窗口 + 指令文件角色说明 | 只送嫌疑段，不送全文件 |
| contradiction | 规则句抽取（祈使句/约束句启发式）两两配对，仅同主题词对（关键词聚类预筛） | 配对数上限 + 预算截断需申报 |
| drift | 规则句 + 引擎实测证据（该规则关联检查的历史违规频次、现状快照） | 只对有实测证据的规则出题 |
| memory-overlap | 记忆条目标题/首段的相似簇（确定性文本相似度预聚类）| 只送簇内条目 |

**有界候选的诚实申报（复审阻断第 3 项）**：四个维度都只审启发式先命中的候选——narrative 不看未命中段、contradiction 只看同关键词对、drift 只看有机械证据的规则、memory-overlap 只看文本相似簇——系统性盲区客观存在（别名矛盾、低词面相似的重复知识、无机械投影的漂移）。因此语义维度 coverage 一律按 §2.1 五态申报且上限 `partial`，候选宇宙/送审/跳过/截断四个读数强制输出；扩大召回（如嵌入相似度替代词面相似）是后续优化项，不改变"上限 partial"的诚实语义。

每个 pack 必含：`pack_id`、`dimension`、source-unit 总数、候选生成器 id/version、按 portable path 排序的 source blob hashes、redaction 计数、prompt/schema version、budget 和 pack SHA-256。单个 excerpt ≤8 KiB，单 pack 原始 JSON ≤2 MiB；超限在分包前按稳定排序截断并申报 coverage，不能靠运行时异常静默丢证据。

指纹增量（**复审收紧：复合指纹，不是"文件是否变化"**）：缓存键必须由以下全部分量哈希合成——目标文件内容、证据包候选索引（配对/聚类的成员集）、neat 配置、规则版本、prompt 模板版本、返回 schema 版本、模型标识、judge 标识、预算三分量、redactor 版本，以及**参与该维度判断的全部关联文件内容**（矛盾对的另一半、跨仓边的对端文件）。任一分量变化即缓存失效。否则矛盾对与跨仓边会产生假阴性：A 文件没变但 B 变了，A-B 对的旧裁决就是错的。

semantic finding fingerprint 不含模型 rationale、confidence 或行号，按 `schema version + rule id + dimension + 排序后的主体 portable ids + citation text hashes + rule version` 计算；同一引用只发生行位移时 fingerprint 稳定，引用内容改变时生成新 fingerprint。contradiction pair 的两个主体先排序，避免 A-B/B-A 重复。

### 3.3 结构化裁决与出处核验

L2 只能返回 strict `SemanticDecisionV1`，不得直接生成最终 FindingV2：

```ts
interface SemanticDecisionV1 {
  dimension: "narrative" | "contradiction" | "drift" | "memory_overlap";
  verdict: "issue" | "no_issue" | "uncertain";
  confidence: "high" | "medium" | "low";
  citations: FindingV2Extension["citations"];
  rationale: string;
  proposed_disposition: "move" | "compress" | "delete" | "review" | "none";
  closure_conditions: Array<
    | { type: "source_bytes_absent"; path: string; sha256: string }
    | { type: "target_contains_bytes"; path: string; sha256: string }
    | { type: "target_contains_anchor"; path: string; anchor: string }
    | { type: "budget_within"; path: string; max_lines?: number; max_bytes?: number }
    | { type: "claim_ledger_complete"; plan_id: string }
  >;
}
```

引擎按固定顺序校验：schema → pack id/response nonce → citation portable path → evidence snapshot blob hash → line range与 excerpt hash → closure-condition 闭集 → confidence policy。失败整条拒收并分类为 `schema_error/quote_mismatch/input_drift/low_confidence/provider_error`；`unsupported_claim` 仅能由独立 verifier 或人工裁判写入，L1 不假装机械判断语义蕴含。

出处核验只证明引用来自送审 snapshot。它不证明 rationale 正确，也不证明证据包覆盖全面。`uncertain` 与 low-confidence 决策不生成默认 finding，但必须计入 rejection/decision metrics，coverage 仍记为 assessed。

### 3.4 finding lifecycle 与 review

V2 resolution 改为 append-only event，不再假设一个 finding 只有一条最终 resolution：

```text
open
  ├─> mechanically_applied
  │      ├─> mechanically_resolved
  │      ├─> semantically_resolved
  │      ├─> accepted_risk
  │      ├─> suppressed
  │      └─> obsolete
  ├─> reviewed_no_change
  ├─> accepted_risk
  ├─> suppressed
  ├─> obsolete
  └─> closed_absent
```

- `mechanical_sufficient` finding 在后置条件通过后从 `mechanically_applied` 进入 `mechanically_resolved`；绝不借用 `semantically_resolved` 名称。U0 managed block、失效链接等纯机械 finding 使用此 policy。
- contradiction/drift/compress 固定为 `semantic_confirmation_required`；机械动作完成后仍保持非终态，必须由 human review 或**另一 judge/model**基于新 evidence pack 确认。
- `mechanically_resolved/semantically_resolved/reviewed_no_change/accepted_risk/suppressed/obsolete/closed_absent` 是终态；全部需要 actor、reason、timestamp、evidence refs。自动机械事件的 actor 为 `system:governance`；suppression 必须带 scope 与可选 expiry。
- partial semantic run 中“本次没再发现”永远不自动关闭历史 finding。`closed_absent` 只允许在该 finding 所属 origin/dimension/rule 本次 coverage=`complete` 且规则确实被选择时产生；因此 semantic finding 实际不会靠 absence 关闭。
- `resolved_legacy` 是 dual-reader 内部终态，只用于 V1 `fixed` 的诚实投影，不允许 V2 writer 生成，也不得计入“已语义确认”。

`closure_policy` 由 governance 的 `rule_id → policy` 闭表决定，judge 输出无权选择：全部 `semantic.*` 规则固定为 `semantic_confirmation_required`；四个 `rulebook.*` U0 规则与 `dependency.review_due` 固定为 `mechanical_sufficient`；V1 规则沿用其既有 review/patch 语义。未知映射 fail closed。

事件合同固定为：

```ts
type FindingLifecycleStateV2 =
  | "open"
  | "mechanically_applied"
  | "mechanically_resolved"
  | "semantically_resolved"
  | "reviewed_no_change"
  | "accepted_risk"
  | "suppressed"
  | "obsolete"
  | "closed_absent"
  | "resolved_legacy";

interface ResolutionEventV2 {
  schema_version: "2";
  event_id: string;                 // khev_<sha256>
  repo_id: string;
  fingerprint: string;
  from_state: FindingLifecycleStateV2;
  to_state: FindingLifecycleStateV2;
  actor: { kind: "human" | "agent" | "system"; id: string };
  reason: string;
  evidence_refs: KnowledgeHygieneEvidenceRefV2[];
  occurred_at: string;              // RFC 3339
  plan_id?: string;
  suppression?: { scope: string; expires_at?: string };
}
```

每个 event 以 `event_id` 幂等，`from_state` 必须等于当前 projection；非法边、空 reason、缺 evidence 或时间倒退全部拒绝。`closed_absent` 必须额外携带本次 run 的 coverage evidence。

#### 3.4.1 Core additive migration 与 V1 投影

现有 SQLite `knowledge_hygiene_findings.current_state` 有 `active|resolved|closed_absent` CHECK，不能承载 V2 生命周期。不得重建或放宽旧表；next migration 新建独立的：

- `knowledge_hygiene_runs_v2`：保存 `schema_version/coverage_json/health_claim/report_sha256` 与 run 元数据；
- `knowledge_hygiene_findings_v2`：保存 strict-validated `finding_json`、first/last seen 与 occurrence count；
- `knowledge_hygiene_occurrences_v2`：按 run/fingerprint 记录出现事实；
- `knowledge_hygiene_resolution_events_v2`：append-only 权威事件；
- `knowledge_hygiene_finding_state_v2`：可由 events 重建的当前状态 projection，更新与 event insert 在同一 SQLite transaction。

V2 表不外键指向 V1 findings，避免两套状态约束耦合；所有 JSON 入库前由 governance schema 验证。dual-reader 对旧表做只读映射：`active→open`、`closed_absent→closed_absent`；V1 resolution 的 `reviewed_no_change/accepted_risk/suppressed/obsolete` 同名映射，`fixed→resolved_legacy`。合成 event id 由旧 row primary key 与内容 hash 确定，重复读取稳定。迁移不复制、不覆写 V1 row；默认 writer 切到 V2 后只写 V2 表，trend/review 在查询层 union 两代数据。

### 3.5 `SemanticJudgePort` 可编码合同

```ts
interface SemanticJudgePort {
  readonly id: string;
  readonly model_id: string;
  readonly prompt_version: string;
  readonly supports_no_tools: true;
  judge(input: {
    run_id: string;
    nonce: string;
    evidence_pack: unknown;       // governance 已验证、脱敏且有界
    output_schema: unknown;       // JSON Schema + sha256
    budget: { max_input_tokens: number; max_output_tokens: number; max_calls: number };
  }, signal: AbortSignal): Promise<{
    nonce: string;
    raw_output: unknown;
    usage: { input_tokens: number; output_tokens: number; calls: number };
    provider_request_id?: string;
  }>;
}
```

首个 provider 固定在 `@osstack/agents` 内实现，针对仓库当前 `@anthropic-ai/claude-agent-sdk@0.3.143` 使用：`tools: []`、`settingSources: []`、`skills: []`、`mcpServers: {}`、`plugins: []`、`hooks: {}`、`agents: {}`、custom `systemPrompt`（不使用 preset）、`outputFormat: json_schema`、`maxTurns: 1`、`permissionMode: dontAsk` 与空临时 cwd；永不设置 `allowDangerouslySkipPermissions`。首 provider 要求显式 API credential，子进程 env 仅允许 `ANTHROPIC_API_KEY/PATH/LANG/LC_ALL/TMPDIR`；明确剔除 `HOME/CLAUDE_CONFIG_DIR/OSSTACK_AUTOAPPROVE/HERMES_HOME` 及全部仓库级变量。需要企业代理或自定义 CA 的环境在后续 provider 设计中单独扩展 allowlist 与测试，不能临时透传 `process.env`。SDK 类型明确规定空 `tools` 禁用内置工具，Anthropic API 也支持 `tool_choice: none`；两者任何一次升级都必须重跑 port conformance。[Anthropic tool configuration](https://platform.claude.com/docs/en/managed-agents/tools)，[Anthropic tool choice](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools)

2026-07-20 provider 增量实现把 registry 扩为 `anthropic-no-tools` 与 `deepseek-no-tools`。DeepSeek 使用一个仅 HTTP 的 OpenAI-compatible transport，其 judge id、HTTPS endpoint 与 credential 变量均在 `@osstack/agents` 内冻结，仓库内容和 ConfigV2 不能提供任意 Base URL。transport 不传 `tools`/`tool_choice`，若响应出现 `tool_calls`、非 `stop` finish reason、响应模型身份与请求不一致、超预算字节、畸形 provider JSON 或不符合本地 schema 的 decision，均 fail closed；HTTP 错误不得回显 body，transport 异常只输出分类，默认 120 秒超时。它只从环境读取 `DEEPSEEK_API_KEY` 与显式的 `OSSTACK_NEAT_DEEPSEEK_MODEL`，不把 ambient env 传给子进程或 provider；请求显式启用 thinking 并按官方接口使用 `max_tokens`。U5 doctor 接受任一完整 provider 配置，但 partial 配置仍为 No-Go。DeepSeek JSON Output 与固定模型参数见[官方 Chat Completion API](https://api-docs.deepseek.com/api/create-chat-completion)。

当前 Codex CLI 是能读文件和运行命令的 coding agent，read-only sandbox 不是 no-tool contract，所以不得直接注册为 SemanticJudgePort。未来 provider 必须提供同等的 no-tool/structured-output 证明后才能进入 registry。[OpenAI Codex CLI safety model](https://help.openai.com/en/articles/11096431)

conformance 必测：零 tool/MCP/skill/hook/subagent event；无法读取 repo 或 HOME sentinel；除 SDK 到配置供应商 API 的 transport 外，模型没有 URL fetch/network 工具；env sentinel 不出现在 provider input/output/log；schema/nonce/预算错误 fail closed；取消能终止调用；含 `IGNORE PREVIOUS`、伪 tool 指令和数据外泄请求的 evidence 仍只能产生 schema 内数据。测试 transport 使用录制/假 server，不把“provider 自己需要联网”误写成“进程完全断网”。这里验证 containment，不以一次概率性 verdict 完全相同冒充“注入免疫”。

---

## 4. U2 — 记忆毕业事务

原版的 memory → docs/rules 晋升被拆成 plan、approve、apply、recover 四个显式阶段：

```text
osstack neat memory plan
  --repo <path> --adapter claude-code --claude-memory-dir <absolute|~/path>
  [--judge <judge-id>] [--format human|json]

osstack neat memory approve
  --plan <plan-id> --actions <id,...> --actor <id> --if-revision <n>

osstack neat memory apply
  --plan <plan-id> --if-revision <n> [--dry-run | --execute]

osstack neat memory recover --plan <plan-id>
```

`--execute` 与 `--dry-run` 互斥；不传时默认 dry-run。headless/daemon 只能 plan，不能 approve 或 execute。memory root 必须由现有 read-only adapter 显式检测，绝不推断平台私有路径；写入阶段不把 adapter 升级成通用 write API，而是把已批准的绝对 root 交给受限 applier 作为本次 allowlisted root。

### 4.1 PlanV1 与批准合同

JSON 是权威工件，Markdown 是同源的人类投影。两者位于 `$OSSTACK_HOME/neat/plans/<repo-id>/<plan-id>/`，目录 0700、文件 0600，不进仓库。Plan 必含：

- `plan_id`、`kind: memory|narrative`、`revision`、`state`、创建/过期时间（默认 24 小时）；
- repo realpath、repo/base tree fingerprint、显式 memory root 及 root fingerprint；
- source/target portable path、blob SHA-256、精确 byte/line anchors；
- 闭集 action（move/compress/delete）、草案文本、claim ledger、closure conditions；
- write-set preview、风险级别、所需批准粒度、生成该计划的 finding/evidence refs；
- approvals（actor、actions、revision、timestamp、reason）与 apply/recovery receipts。

权威 byte anchor 与 action union 固定为：

```ts
interface ByteSpanV1 {
  root_id: "repo" | "memory";
  path: string;                    // portable path inside allowlisted root
  blob_sha256: string;
  start_byte: number;              // UTF-8 byte offset, inclusive
  end_byte: number;                // exclusive; end > start
  bytes_sha256: string;
  start_line: number;              // display-only cross-check
  end_line: number;
}

interface InsertionPointV1 {
  root_id: "repo" | "memory";
  path: string;
  preimage_sha256: string | null;  // null means absent/new file
  anchor_sha256?: string;
  placement: "before" | "after" | "replace";
}

type ClaimDispositionV1 =
  | { status: "preserved"; target_bytes_sha256: string }
  | { status: "merged"; target_claim_id: string; source_claim_ids: string[] }
  | { status: "explicitly_discarded"; reason: string };

type PlanActionV1 =
  | {
      action_id: string; kind: "move"; risk: "medium";
      source: ByteSpanV1; target: InsertionPointV1;
    }
  | {
      action_id: string; kind: "compress"; risk: "high";
      sources: ByteSpanV1[]; target: InsertionPointV1;
      replacement_utf8: string;
      claims: Array<{ claim_id: string; source: ByteSpanV1; disposition: ClaimDispositionV1 }>;
    }
  | {
      action_id: string; kind: "delete"; risk: "high";
      sources: ByteSpanV1[];
      discards: Array<{ source_bytes_sha256: string; reason: string }>;
    };
```

byte offset 是施行权威，line 仅用于展示与二次一致性检查。一个 source byte 不能被同 plan 的两个 action 重叠消费；target 必须属于枚举目的地（documentation、instruction canonical 或原 memory file），不能靠自由 path 新建 skill/脚本。每个 claim/source discard 必须恰好映射一次；replacement 与 write-set preview 都进入 plan revision hash。

状态机固定为 `draft → partially_approved|approved → applying → applied|recovery_required → recovered`，并允许任一非终态进入终态 `stale|cancelled`；任一 source hash、target preimage、repo root、memory root、plan revision 或 expiry 不匹配即 `stale`，必须重新 plan。apply 以 `plan_id + revision` 幂等：已完成的同 revision 返回 `already_applied`，不同请求内容复用 id 返回 conflict。

批准规则：move 可批量批准；compress/delete 必须逐 action 批准。批准只对当前 revision 有效，计划变化自动清空旧批准。`approve` 与 `apply --execute` 都要求本地交互 TTY；`actor` 是审计标签而不是身份认证声明，receipt 另记录本机用户 id 与 TTY consent time。无人值守调用只能 plan/dry-run/recover。未来远程批准必须新增签名主体合同，不能复用自由 `--actor` 字符串冒充认证。

### 4.2 Crash-recoverable applier

跨多个文件系统不可能真正原子，因此本文不再使用“原子事务”承诺，而定义**逐文件原子、跨文件可恢复**：

1. 取得 `$OSSTACK_HOME/neat/locks/<plan-id>.lock` 排他锁；锁只协调 osstack，不能替代 preimage 检查。
2. 生成 write-set manifest；对每个现存目标以 `O_NOFOLLOW` 读取并核验 realpath/allowlisted root/preimage hash，将 preimage 复制到 `$OSSTACK_HOME/neat/backups/<plan-id>/`。
3. recovery log 在任何写入前 fsync；每个文件在同目录写临时文件、fsync 后 rename，随后记录 applied receipt。任何一步前再次核验 preimage，检测外部并发修改即停止。
4. 失败时按 journal 逆序恢复；进程被 kill 留下 `recovery_required`，后续 apply 必须先 recover。新建文件的 preimage 记为 absent，恢复时只删除 manifest 中精确记录且 after hash 匹配的文件。
5. backup/recovery receipt 默认保留 30 天；成功后也不自动 Git commit。U 系列不提供 `--commit`，版本提交由用户现有 Git 流程负责。

允许写入的根只有 repo realpath 与本计划显式批准的 memory root；拒绝 symlink target、hard-link count 异常、device/FIFO、路径穿越和未列入 manifest 的文件。文件 mode 保持 preimage；新 Markdown 用 0644。故障注入验收至少覆盖：备份失败、第一/中间/最后一步 kill、并发变更、恢复期间再次中断、跨 device rename、已应用重放。

### 4.3 内容去除台账

- `move`：source 删除的 byte sequence 必须在 target 中连续逐字出现；否则 apply 失败。
- `compress`：每个源 claim 都有稳定 `claim_id + source citation`，并映射到 `preserved(target citation)`、`merged(target claim ids)` 或 `explicitly_discarded(reason)`。引擎只证明 ledger 完备，语义保真需要用户批准或独立 judge。
- `delete`：每个 source block 都必须是 `explicitly_discarded` 并逐条批准，不存在隐式删除。

后置断言复用 verify：索引 ≤ 平台上限、全部索引链接有效、指针格式合规、目标 section 存在、move bytes 可寻。体量倒挂只作为趋势指标，不因单次未改善就回滚正确迁移。

---

## 5. U3 — 叙事手术（指令文件与 docs 的实际修正）

U0/U1 负责"发现叙事病灶"，U3 负责"动刀"：

```text
osstack neat narrative plan --repo <path> --findings <fingerprint,...> [--judge <id>]
osstack neat narrative approve --plan <id> --actions <id,...> --actor <id> --if-revision <n>
osstack neat narrative apply --plan <id> --if-revision <n> [--dry-run | --execute]
osstack neat narrative recover --plan <id>
```

- L2 对每个叙事 finding 起草 **patch-plan 工件**：行段锚定的操作序列（闭集操作：`move`（迁往 CHANGELOG/docs 指定节，逐字守恒）/ `compress`（多行史实压成一行规则，附草案文本 + claim ledger）/ `delete`（附理由，显式 discard + 批准）），不含自由文本 diff；守恒粒度与 U2 同一套裁定；
- 受限 L1 applier 施行批准后的精确 bytes；plan/artifact/state/idempotency 与 §4 完全共用，不建立第二套 patch 引擎；
- 后置断言：目标 finding 锚点消失，三个 U0 narrative rules 对该目标块复扫清零，被 move 的 bytes 在目的地可寻，且没有未批准 write-set 变化；
- 安全分级不变：`compress`/`delete` 默认需逐条批准；`move` 在交互模式可批量批准。CLI 仍然不即兴生成散文——所有新文本都来自被批准的计划工件，权责清晰。

U2/U3 完成后，osstack 获得原版的编辑与毕业能力，但只承诺：动作有证据、去除有 ledger、写入可恢复、语义确认有责任主体；不再宣称 compress 具有机械守恒证明。

---

## 6. U4 — 跨项目影响推断

分两级，确定性先行：

### 6.1 候选依赖边（L1，确定性）

扫描注册表在册仓库间的机械信号，构建**候选边集**（带证据）：package.json/pnpm workspace 互依、共享环境变量**名称**、URL host/子域交叉引用、跨仓符号命中、git submodule/路径引用。不得读取或保存环境变量值、`.env` 内容或凭据。所有路径以 registry repo id + portable path 表示，不把机器绝对路径送给 L2。

```text
osstack neat dependencies scan --registry <path> [--record] [--judge <id>]
osstack neat dependencies inbox --registry <path> --repo-id <id>
osstack neat dependencies confirm --obligation <id> --repo <downstream-path>
  --actor <id> --if-revision <n> [--dry-run | --execute]
osstack neat dependencies revoke --edge <id> --repo <downstream-path>
  --actor <id> --if-revision <n> [--dry-run | --execute]
```

scan/inbox 永远只读仓库；confirm/revoke 必须由用户在 downstream repo 上显式 execute，并走 §4 applier。CLI 校验 downstream realpath 与 registry entry 一致，不能借 `--repo` 修改任意未注册目录。

### 6.2 推断与义务下发（L2 排序 + advisory 语义）

- L2 只在候选边之上做排序与语义判断（"A 的这次 API 变更是否波及 B 的 integration 文档"），不凭空发明依赖；
- 推断出的跨仓义务进入 **Core SQLite obligation inbox**，以 canonical registry path 的 SHA-256 作为 registry scope。inbox 是 candidate/advisory/promoted/dismissed/expired 义务及其历史的唯一权威；`repos.json` 仍只保存 repo 注册信息，不塞事件队列。
- 下游运行 neat 时读取 inbox 投影；daily 只显示未读数。系统无权在 scan/daily 时写下游仓库。
- 用户确认后，权威 declared edge 只存在于下游仓 `ConfigV2.dependencies`；Core 保存 projection 与 source config hash，发现投影不一致必须重建，不得反向覆盖 config。

`ConfigV2.dependencies` 使用 §2.1.4 的 `DeclaredDependencyV2[]` strict 合同。到期不会自动修改或降级权威 config；它只产生 `dependency.review_due` warning，必须由用户 confirm 更新日期或 revoke。obligation 与 edge 都保留 provenance、revision、actor 和 append-only transition history。

obligation 最小合同为：

```ts
interface DependencyObligationV2 {
  obligation_id: string;          // ^kho_[a-f0-9]{64}$
  registry_scope: string;
  source_repo_id: string;
  upstream_repo_id: string;
  downstream_repo_id: string;
  kinds: DeclaredDependencyV2["kinds"];
  state: "candidate" | "advisory" | "promoted" | "dismissed" | "expired";
  revision: number;
  evidence_refs: KnowledgeHygieneEvidenceRefV2[];
  rationale?: string;             // 只有通过 SemanticJudgePort 才可写
  created_at: string;
  expires_at: string;
  promoted_edge_id?: string;      // state=promoted 时必填
}
```

`obligation_id` 由 registry scope、source/upstream/downstream ids、排序后的 kinds 与 evidence identity 哈希；重复 scan 幂等。`edge_id` 由 registry scope、upstream/downstream ids、direction 与排序后的 kinds 哈希，evidence 更新不改变 edge identity。candidate 仅需机械证据；进入 advisory 必须有通过 schema/citation 验证的 semantic verdict；dismiss/promote 需要 actor、reason、revision event；expiry 由时钟事件产生但不删除 row。

状态机分离：inbox obligation 为 `candidate → advisory → promoted|dismissed|expired`；declared edge 为 `confirmed → review_due → confirmed|revoked`。`promoted` 只表示该义务已被转换成某个 config edge，不取代 config 的权威。confirm 先通过 §4 applier 写入并复核 downstream ConfigV2，再写 Core promoted event；若 config 成功而 Core event 失败，下次 confirm/scan 必须按确定性 `edge_id + config hash` 补记 promoted event。Core 失败不得反向删除已经批准的 config。revoke 同样以 config 为准，projection 可由 config 与 append-only events重建。

原版靠模型临场推断跨项目影响、每次从零猜；本方案让每次推断沉淀为可复用的声明边，**越用越不需要推断**。

---

## 7. U5 — 等价验证战役（没有它，前面一切都是主张）

复审点名缺失的四项证据，逐项补：

### 7.1 腐坏语料库（golden rot corpus）

- 至少 5 个在册仓库、30 个隔离 case snapshot、120 个标注 defect units；至少三分之一为历史中自然发生的问题，其余才允许受控播种。
- 覆盖叙事混入、规则矛盾、规则/实践漂移、过期与重复记忆、体量倒挂、跨仓断裂；当前 AGENTS.md 反例是首个天然样本。
- checker 在实现候选生成器前冻结标签、commit SHA、预期影响范围与可接受修复集合；maker 只能看 train/dev，hidden test 标签与快照由独立保管者在最终运行时注入。
- 快照入库前扫描并移除 secrets/PII，记录许可证与来源；播种脚本确定性且保留 clean→rot manifest，禁止手工改完不留病灶 provenance。

### 7.2 双跑对照协议

同一快照三臂运行：**A 臂** 原版 neat-freak——未来第一次 hidden run 的有效基准冻结为**固定提交** `2b4a645` 的 [Khazix neat-freak v3](https://github.com/KKKKhazix/khazix-skills/tree/2b4a645cfdc894156ae347d897723562f719ce95/neat-freak) 六文件运行时包（`SKILL.md`、四个 `references/*.md`、`scripts/audit-inventory.sh`），bundle SHA-256 为 `e77e30e39e67f05d3159548605057d396794d1bde20bd59a070670e109c3d904`；上游 `evals/` 不属于运行时依赖且会向 A 臂泄漏测试素材，因此排除。**B 臂** osstack neat（U 系列全开）；**C 臂**当前 v2。每次运行使用 fresh session + disposable copy、网络关闭、相同模型/推理档/总 token 与 wall-clock budget。A/B 在主模型每 case 独立运行 3 次，在第二模型家族各运行 2 次；C 为满足 bit-for-bit gate 每 case 确定性运行 2 次。7 月 18 日冻结的 `5a963d9` 单文件基线仅保留为历史审计记录；它未执行 hidden A/B，不能作为 v3 parity 结论。

B 臂 production approval 不得被绕过。eval harness 在 disposable copy 中以明确 `actor=eval-harness` 生成批准事件后施行 plan，仅为得到 diff；这些 receipt 标记 `evaluation_only`，不能导入真实 history。统一采集 findings、coverage、plan、diff、拒收原因、运行时间、tokens/calls 与失败。

模型协议（复审裁定）：**主实验 A/B 同模型**（控制变量，主对照结论以此为准）；随后换**另一个模型家族**整套复跑一次作敏感性复验——结论若在两个家族上方向一致才算稳健，不一致则如实报告分歧。

### 7.3 度量与裁判

| 指标 | 方法 |
|---|---|
| 语义召回/精确 | 对播种病灶按标签机械判分（找到/漏掉/误报） |
| 编辑质量 | 去署名、随机顺序的 paired diff；两个独立模型裁判按冻结 1–5 rubric 评分；全部分歧由人类裁判，另随机复核 20% 一致样本 |
| 下游效果 | 小规模但必做：清理后 vs 未清理仓库各跑同一组任务 agent，比较任务成功率与纠错轮数。任务集按复审裁定：**冻结的标准任务 + 隐藏的真实历史任务**（从 git 历史选已完成任务复演，agent 不可见原实现），多次运行取分布；**不使用正在开发的 backlog**（避免污染在飞工作与数据泄漏） |
| 稳定性 | 机械层 bit-for-bit；语义层比较归一化 finding sets 的 pairwise Jaccard 与 verdict agreement 分布 |
| 出处真实性 | B 臂分类 rejection counts；A/B 引文由 checker 对 snapshot hash 抽检，不再使用笼统“幻觉率”名称 |
| 成本 | tokens、calls、wall-clock 和 provider failures 全量报告；成本不是效果等价的替代指标 |

### 7.4 验收线（"等价"的操作性定义）

验收只看 hidden test，并在第一次运行前把脚本、随机种子、模型完整 id、rubric 与以下界值冻结：

- 召回与精确率使用按 case cluster bootstrap 的 95% CI；`B-A` 下界均须 ≥ **-0.05**。
- 编辑质量使用 paired 1–5 分；`B-A` 平均差的 95% CI 下界须 ≥ **-0.25 分**。未发现显著差异不等于通过；CI 过宽按失败处理。
- 裁判一致性 Krippendorff's alpha ≥ **0.67**；不足则先修 rubric/裁判流程并重跑全部盲评，不挑样本重判。
- B 机械报告、fingerprint、patch preview 在相同输入上必须 bit-for-bit；语义 finding-set pairwise Jaccard 中位数 ≥ **0.80**，且任一维度不得低于 **0.70**。
- 既有 12-scenario golden、全量机械 tests/smoke 不得回退；新增 U0 corpus 单独满足 §2.2 门槛。
- 功效分析若要求大于最低 120 defects，则扩充 hidden corpus，不降低界值。provider/systemic failure 超过 5% 直接失败，不从分母删除。
- 每仓 3–5 个下游 agent 任务只作探索性附录，不进入 parity 宣称。

任一不达 → 回到对应 U 增量迭代，**评测报告如实发布**（含自评偏差声明与裁判模型配置）——不许移动球门柱。

---

## 8. 排期、成本与风险

### 8.1 顺序（每项独立 PR，可独立回退）

主依赖链：**U0a → U0b → U1 → U2/U3 → U4 → U5**。U5 corpus tooling 与标签冻结可在 U1–U4 期间并行，但 hidden test 运行必须等功能冻结。详细工作包、文件范围与每 PR gate 见 §10。

### 8.2 成本控制

语义通道使用 §3.1 三分量预算；超限进入 `truncated` coverage。复合指纹缓存只复用完全相同的 evidence/prompt/model/config 判定。daily 不默认启用 semantic；只有 ConfigV2 显式 opt-in 才允许 narrative-only 定时审计，且永远只读、默认不持久化全文 evidence。

### 8.3 风险表

| 风险 | 缓解 |
|---|---|
| L2 判断质量不稳（模型/提示漂移） | provider/model/prompt 全版本化 + 分类 rejection metrics + U5 stability 分布；不再用出处核验冒充正确性证明 |
| 仓库文本 prompt injection / 数据外泄 | no-tool port、空 cwd/setting sources、env 白名单、脱敏、默认不落全文 evidence、conformance 攻击用例 |
| compress 遗漏语义 | claim ledger 只证明台账完整；必须批准/独立复核，不宣称机械语义守恒 |
| 多文件 apply 中断 | 逐文件原子 + preimage backup + fsync journal + recovery-required 状态；不承诺跨文件系统原子性 |
| 语义误报淹没报告 | 两级漏斗（启发式→语义复核）+ confidence 阈值 + suppress 通路 |
| patch 锚点漂移（文件在 plan 与 apply 之间被改） | plan 默认 24 小时过期；每步重核 preimage/if_revision，漂移即 stale，不覆盖用户修改 |
| 评测语料播种偏向自家强项 | 播种清单由复审方（SOL/codex）审定后冻结；A 臂运行环境由复审方抽查 |
| V1/V2 消费者分裂 | dual-reader、单 writer 切换顺序、一个 minor V1 writer 兼容窗、schema/smoke contract tests |
| 成本失控 | 三分量硬顶 + 完整 cache key + semantic 默认手动触发 |

---

## 9. 复审裁定记录（Historical audit trail）

本节保留 v1.1/v1.2 的审查轨迹，表中的“待 checker”是当时状态，不是当前门禁。v2.0 当前授权以文首矩阵和 §10 为准。

### 9.1 总裁定

- **架构方向：通过。** 状态改为 `Draft v1.1 — Architecture accepted, contract revision required`。
- **U0：可先行开工**（须先满足 §2.2 的收紧要求）。
- **U1–U5：No-Go**，待八项阻断契约问题逐一关闭后解禁。

### 9.2 八项阻断问题清单（2026-07-18 补录完毕；关闭方案均已修入正文对应章节）

| # | 级别 | 阻断项摘要 | 关闭方案（正文落点） | 状态 |
|---|---|---|---|---|
| 1 | P0 | 通用 agent adapter 不满足证据隔离：自由 prompt、带工具、`OSSTACK_AUTOAPPROVE=1` 绕权限、仓库文本构成 prompt injection 面 | 新增 `SemanticJudgePort`：仅证据 JSON、空临时 cwd、无工具、env 白名单、脱敏、固定输出 schema；注入/外泄测试为验收必测；仅复用供应商通道不复用执行契约 → §1.2 | 方案已入正文，待 checker 复核 |
| 2 | P1 | `ReportV1`/`FindingV1` strict schema + `rule_id` 闭枚举，无法兼容 `coverage`/`origin`/semantic findings | `ReportV2`/`FindingV2` 工作包：版本协商、迁移路径、消费方升级顺序、V1 支持周期、exit-code 语义、review/history 数据迁移；U0b 依赖此项，禁止 V1 临时实现 → §2.1 | 同上 |
| 3 | P1 | 有界候选集只能申报 partial：narrative 未命中段、别名矛盾、低词面重复、无机械投影漂移均为系统性盲区 | coverage 五态（complete/partial/not_assessed/truncated/failed）+ 候选宇宙/送审/跳过/截断四读数强制输出；语义维度上限 partial → §2.1、§3.2 | 同上 |
| 4 | P1 | 引文存在 ≠ 判断真实 ≠ 问题闭合；单一 hallucination 计数混淆多种拒收原因 | 拒收原因分类；`mechanically_applied` 非终态，机械/语义闭合分别进入 `mechanically_resolved` / `semantically_resolved`；contradiction/drift 须权威裁定或独立复核 → §3.3–§3.4 | 同上 |
| 5 | P1 | "内容守恒证明"对 compress 不成立，"不可能丢知识"是过强承诺 | 守恒三态：move=byte-conserving（可机械证明）；compress=claim ledger（claim_id 三态标注，机械核验台账完备性、语义保真需批准/复核）；delete=显式 discard+逐条批准；承诺修正为"每处去除显式、可追溯、经批准" → §4.2 | 同上 |
| 6 | P1 | git commit/时间戳备份不是事务；自动 commit 污染分支；L1/L3 写入权责矛盾 | 事务协议：plan_id + base fingerprint + if_revision 乐观锁、write-set manifest、preimage hash、仓外备份清单、recovery log、故障注入测试、默认不自动 commit；权责统一=L2 提案/L3 批准/受限 L1 applier 唯一写字节 → §1.2、§4.2、§5 | 同上 |
| 7 | P1 | 跨仓义务权威位置不得留到实现时定；"neat.yaml 或注册表扩展"形成双权威 | registry inbox 为 candidate/advisory 唯一权威（只读投影给下游）；confirmed edge 由下游仓 neat.yaml 声明、registry 存投影；边 schema 含方向/owner/证据/状态机/TTL/撤销/过期复核 → §6.2 | 同上 |
| 8 | P1 | "差异不显著"不能证明非劣；B 臂含 LLM 不能要求逐字一致 | 预注册（δ/样本量/CI/重复次数/失败判据）、train/dev/hidden test 三分、随机配对多次运行、裁判盲化+一致性系数、下游任务降为探索性证据、语义层测 stability 分布、机械层保持 bit-for-bit → §7.4 | 同上 |

**历史解禁条件**：checker 对八项关闭方案逐项复核。该条件已由 v2.0 的二次 source/code-contract review 满足；后续不再维持全局 No-Go，而按每个工作包自己的依赖 gate 推进。

### 9.3 收紧要求（已修入正文）

1. U0 启发式：冻结 `N`/severity/忽略机制/最小精确率；fixture 集多正例多负例；`<claude-mem-context>` 等真实标签为显式模式而非泛化碰撞 → 已修入 §2.2。
2. 增量缓存复合指纹（含配对对端与配置/prompt/schema/模型/预算分量）→ 已修入 §3.2。
3. `--budget` 拆为 `--max-input-tokens/--max-output-tokens/--max-calls`；完整可解析 CLI grammar → 已修入 §3.1。
4. A 臂基准冻结为固定提交 `5a963d9`；"作者推荐模型"表述作废，改为同模型主对照 + 第二模型家族敏感性复验 → 已修入 §7.2。

### 9.4 五个开放问题的裁定（全部关闭）

1. `neat semantic` 独立动词：**确认**。
2. 守恒粒度：`move` 逐字守恒；`compress` claim ledger；`delete` 显式 discard + 批准 → 已修入 §4.2/§5。
3. 任务集：冻结标准任务 + 隐藏真实历史任务，多次运行，不用在飞 backlog → 已修入 §7.3。
4. advisory 暂存 registry 侧 inbox，绝不主动写下游仓库 → 已修入 §6.2。
5. 模型协议：同模型控制变量为主实验，另一模型家族敏感性复验 → 已修入 §7.2。

### 9.5 v2.0 checker 结论

- 阻断 1：通过 `SemanticJudgePort` 接口、首 provider 配置与 conformance gate 关闭。
- 阻断 2：通过具体 Report/Finding/Config V2 合同、dual-reader 迁移和 writer 切换顺序关闭。
- 阻断 3：通过 coverage 五态、计数不变量及 semantic 上限 partial 关闭。
- 阻断 4：通过 source verification 降级、分类 rejection 与 append-only lifecycle 关闭。
- 阻断 5：通过 move bytes / compress claim ledger / delete discard 三态关闭。
- 阻断 6：通过单一 L1 applier、逐文件原子、跨文件可恢复协议关闭。
- 阻断 7：通过 Core obligation inbox 与 downstream ConfigV2 declared edge 分权关闭。
- 阻断 8：通过冻结样本下限、非劣 margin、CI、重复次数与稳定性界值关闭。

checker 同时新增一个实现门：U0a 新 rule id 不能偷渡进 V1 JSON；因此 U0a 可立即编码，但公开 findings 必须等 U0b V2 writer。

### 9.6 2026-08-03 v3 基线修订

- 原作者在 2026-07-19 发布 neat-freak v3；旧 `5a963d9` 基线早于该版本，且只锁定 `SKILL.md`，没有覆盖 v3 的 references 与 audit script。
- 因旧协议从未执行 hidden A/B，本次在第一次 hidden run 前新建 `protocol-v1-v3.json` 与 `corpus-lock-v1-v3.json`，阈值、随机种子、预算、运行次数和判定规则不变，只升级 A 臂运行时基线及其可追溯 provenance。
- 旧协议、旧 lock 和 2026-07-18 报告不改写，继续作为历史证据；任何 v3 parity 声明必须使用新协议、独立 hidden custody、冻结的完整模型 ID、隔离 adapter 与盲审结果。

---

## 10. 实施工作包（按依赖顺序）

每个工作包遵循 RED → GREEN → REFACTOR → checker；目标是单 PR 聚焦、通常不超过 5 个手写文件。生成的 JSON Schema、fixture 数据和 changeset 不计入手写逻辑文件数，但必须随对应 PR 提交。

### 10.0 B0：恢复全量测试绿线（首个 merge 前置，不阻塞 U0a 编码）

当前 `pnpm test` 只有一个已复现基线失败：`packages/cli/src/probe-render.test.ts` 在 macOS 将未 canonicalize 的 `/var/folders/...` 期望值与 production 返回的 `/private/var/folders/...` realpath 比较。B0 只修测试期望为 canonical realpath，不改变 production path-safety 行为；先跑该单测，再跑全量。B0 可与 U0a 编码并行，但 U0a 首个 PR 合并前两者都必须绿。

### 10.1 U0a：立即启动

#### U0a.1 — Narrative detector（首个 maker 任务）

- 文件：
  - `packages/governance/src/knowledge-hygiene/narrative-detector.ts`
  - `packages/governance/src/knowledge-hygiene/narrative-detector.test.ts`
  - `packages/governance/fixtures/knowledge-hygiene/u0-narrative/manifest.json`
  - `packages/governance/fixtures/knowledge-hygiene/u0-narrative/cases/*.md`（含脱敏冻结的当前 AGENTS.md positive snapshot）
- RED：先写 30+ fixture scorer 与四个规则断言；在 detector 尚未实现时测试因缺少预期 signals 而失败，不能以调用旧 engine 的结果代替 RED。
- GREEN：实现 code-fence aware line classifier、managed-block parser、section grouping、20%/8-line density 与 pragma parser。
- 输出只允许内部 `NarrativeSignalV1[]`，不导出 Finding、不修改 RuleIdV1。
- Gate：marker recall 100%、overall recall/precision ≥90%，同一 fixture 顺序打乱后输出稳定。
- Verify：`pnpm --filter @osstack/governance test -- narrative-detector`。

#### U0a.2 — V1 human honesty

- 文件：`packages/cli/src/neat-command.ts`、`packages/cli/src/neat-command.test.ts`、`docs/guides/neat.md`、changeset。
- 行为：V1 human 零 findings 输出范围限定句；JSON byte shape 不变；有 findings 时也在 completeness 行旁标注 semantic not assessed。
- Gate：既有 JSON snapshots 不变；human tests 覆盖 zero/nonzero/incomplete scan。
- Verify：`pnpm --filter @osstack/cli test -- neat-command`、`pnpm smoke:neat`。

### 10.2 U0b：V2 合同与公开规则

#### U0b.1 — V2 schemas

- 新增 governance V2 Zod：RuleId/Finding/Coverage/Report/ResolutionEvent/Config；为每个 schema 建 valid/invalid fixture。
- 生成并校验 `knowledge-hygiene-*-v2.schema.json`；V1 schema 文件 byte-for-byte 不变。
- Gate：strict parse、coverage 计数不变量、ConfigV1→internal projection、V1/V2 discriminated reader。
- Verify：governance test/typecheck/build + `pnpm --filter @osstack/governance check:schemas`。

#### U0b.2 — V2 detector rules

- 将 U0a signals 映射为四个 V2 rule ids；实现 exact config ignore 和 next-line pragma；invalid waiver 独立 finding。
- Finding fingerprint 按 §3.2 稳定规则计算，mirror/import 不重复报。
- Gate：当前 AGENTS.md fixture 产生 high-confidence `managed_context_block`；合法 docs/CHANGELOG 永不进入扫描。

#### U0b.3 — Engine/CLI V2 writer

- engine internal model 升为 V2；实现 `--schema-version` dual writer、V2 human renderer 与 health claim。
- V1 compatibility mode 只运行 V1 rules，stderr 有 deprecation；semantic/new rules + V1 为 exit 2。
- Gate：0/1/2/3 退出码 contract tests；V1 JSON golden 保持；V2 golden 新增 coverage。

#### U0b.4 — Consumers and history

拆成三个 PR：

1. Core next migration + V2 store/dual reader；absence closure 按 coverage scope，不得关闭 semantic partial finding。
2. CLI review/trend/propose/loop finalizer 支持 V2 resolution events。
3. supervisor/daily/neat-skill 支持 health claim 与 coverage，不输出无范围 clean。

切换默认 V2 writer 前，以上三个 checker 必须全部通过；迁移只 additive，不删除 V1 rows/columns。

### 10.3 U1：Semantic channel

#### U1.1 — Port contract and conformance harness

- governance 定义 `SemanticJudgePort`、request/response schema、nonce/usage/error semantics；测试 fake provider 的成功、畸形 schema、超预算、取消与 stale nonce。
- agents 实现 Claude no-tool provider；锁定 SDK options；package.json 将实际使用的 SDK 声明为直接依赖，不依赖偶然 transitive package。
- Gate：§3.5 全部 conformance；任何 tool event 立即 fail closed。

#### U1.2 — Evidence builders and redactor

- 每个 dimension 一个 deterministic candidate builder；统一 pack builder、stable sorter、size cap、redactor 与 cache-key composer。
- RED fixtures 覆盖别名漏检、对端文件变化失效、redaction、2 MiB 截断和 code-fence 数据。
- Gate：相同 snapshot pack byte-identical；任一 cache component 改变都会 miss。

#### U1.3 — Semantic orchestrator and CLI

- governance 编排 judge→validate→citation verify→FindingV2；CLI 实现 §3.1 grammar。
- 所有 provider failure/rejection/coverage 都进入 ReportV2；raw evidence 默认不落盘。
- Gate：offline fake-provider integration、真实 provider opt-in smoke、退出码与预算测试。CI 默认不得调用付费 provider。

### 10.4 U2/U3：Plan 与安全写入

#### U2.1 — Plan/approval schemas

- governance 定义 Plan/Action/Claim/Approval/Receipt schemas 与状态机；Markdown renderer 必须由 JSON 生成。
- Core 保存 plan revision 与 append-only events；idempotency/revision conflict tests。

#### U2.2 — Crash recovery applier

- 扩展现有 patch applier，不另写旁路；先实现 read/preview，再实现 backup/journal/apply/recover。
- Gate：§4.2 全部 failure injection、symlink/path traversal/hard-link/concurrency tests；测试只使用临时目录，不碰真实 home。

#### U2.3 — Memory commands

- 实现 §4 CLI；外部 memory root 必须显式配置并经 adapter detect；headless apply 被拒绝。
- Gate：plan→approve→dry-run→execute→recheck happy path，以及 stale/expired/partial approval/recover paths。

#### U3.1 — Narrative commands

- 复用同一 plan/applier，新增 narrative plan renderer 与 U0 recheck 后置断言。
- Gate：move byte-conserving；compress ledger 缺一 claim 拒绝；delete 无逐条批准拒绝；write-set 外零变化。

### 10.5 U4：Portfolio obligations

#### U4.1 — ConfigV2 declared dependencies

- 实现 dependencies schema、`dependency.review_due` rule、confirm/revoke patch plan。
- 到期只报 review_due，不自动改 config。

#### U4.2 — Core obligation inbox

- next available migration 建 obligation/transition/projection tables；scope 为 registry canonical-path hash。
- Gate：candidate/advisory/promoted/dismissed/expired 状态机、重复 scan 幂等、config-write/Core-event 故障协调与 projection 重建。

#### U4.3 — Scanner, CLI, supervisor

- deterministic edge evidence 只采名称/host/symbol/path，不采 secret values；semantic ranking 走 SemanticJudgePort。
- 实现 §6 commands、downstream realpath authority check、daily unread projection。
- Gate：两个临时 repo integration；scan/daily 写仓库文件数必须为 0；confirm 只能改当前 downstream ConfigV2。

### 10.6 U5：Parity evaluation

1. `U5.1 corpus`：clean/rot manifests、secret scan、train/dev/hidden split 与独立标签冻结。
2. `U5.2 runner`：A/B/C isolated execution、预算/模型 pin、重复运行、eval-only approval receipts。
3. `U5.3 scorer`：cluster bootstrap、paired quality、alpha、stability、failure accounting。
4. `U5.4 report`：发布完整方法、配置、失败、自评偏差与原始聚合数据；不发布 hidden corpus secrets。

U5 结果不达 §7.4 时，产品可继续以“auditable semantic hygiene beta”发布，但不得使用“Khazix semantic parity achieved”表述。

---

## 11. 测试、发布与回滚合同

### 11.1 每 PR 最小验证

```bash
pnpm --filter @osstack/governance test
pnpm --filter @osstack/governance typecheck
pnpm --filter @osstack/governance build
pnpm --filter @osstack/governance check:schemas
pnpm --filter @osstack/cli test
pnpm --filter @osstack/cli typecheck
```

涉及对应包时追加 Core/Agents/Supervisor tests。合并前必须执行：

```bash
pnpm test
pnpm typecheck
pnpm build
pnpm lint
pnpm smoke:neat
pnpm eval:neat-goldens
git diff --check
```

provider live smoke 是手动、显式凭据、非 CI gate；fake-provider 与安全 conformance 必须离线进入 CI。所有测试 fixture 使用临时根，禁止读取真实 `~/.claude`、`~/.codex` 或 `$OSSTACK_HOME`。

### 11.2 安全边界

- **Always**：外部/模型输入在 Zod 边界验证；portable path + realpath 双检；raw evidence 默认 ephemeral；写入先批准、备份、journal；日志脱敏；provider/model/prompt/schema 全版本化。
- **Ask first / explicit execute**：仓外 memory 修改、compress/delete、downstream dependency confirm/revoke、保留 raw evidence、任何 live provider 调用。
- **Never**：通用 code agent 充当 judge；autoapprove/bypass permission；自动 Git commit；semantic/daily 自动写文件；scan 时写下游仓；把 partial/not_assessed 渲染成全局 clean；从未配置位置推断 memory root；记录环境变量值。

### 11.3 发布与回滚

- 每个首次公开 package 行为附 changeset；ReportV2 默认切换需要 release note 中明确 BREAKING JSON contract 与 V1 compatibility window。
- semantic、memory apply、narrative apply、cross-repo confirm 初始均 opt-in；daily semantic 默认关闭。
- 数据库迁移只 additive。代码回滚后旧版可忽略新表；不得通过 down migration 删除 history。
- provider kill switch 在 ConfigV2 `semantic.enabled: false`；关闭后 mechanical check 继续工作并诚实标记 semantic `not_assessed`。
- applier kill switch 固定为 `OSSTACK_NEAT_APPLY_DISABLED=1`：阻止 memory/narrative/dependency 的新 `--execute`，但 dry-run 与 recover 始终可用，避免禁用功能后无法恢复 journal。

上线波次固定为：

| 波次 | 对外行为 | 进入条件 | 回滚 |
|---|---|---|---|
| R1 / U0a | V1 human 诚实提示；detector 仅 internal | U0 corpus gate + CLI golden | 回滚 CLI 文案；V1 JSON 无变化 |
| R2 / U0b | 先发 dual-reader 与 `--schema-version 2` opt-in；全部消费者通过后同一 minor 切默认 V2 | §10.2 三组 consumer checker + migration rehearsal | 设显式 `--schema-version 1`；V2 表保留不删 |
| R3 / U1 | `neat semantic` beta，默认关闭 | no-tool conformance + fake-provider integration + 手动 live smoke | `semantic.enabled=false`，mechanical 继续 |
| R4 / U2–U3 | plan/dry-run 默认可用；execute 需批准与 TTY | failure injection 全绿 + recovery drill | `OSSTACK_NEAT_APPLY_DISABLED=1`，recover 保留 |
| R5 / U4 | scan/inbox beta；confirm/revoke 仍显式 execute | 双仓 integration + config/Core reconciliation | 停 scan；下游 config 保持权威 |
| GA claim / U5 | 仅在所有 parity gate 通过后宣称语义等价 | 冻结 hidden protocol 完整通过 | 撤回 parity 文案，不回滚已验证能力 |

每波次先在本仓和一个非关键在册仓 canary；观察至少连续 48 小时且累计 20 次成功运行，7 天内不足 20 次则延长而不是降低门槛。期间 provider failure、recovery_required、schema rejection、false-positive appeal 均进入发布报告。出现数据丢失、write-set 越界、权限绕过或无法恢复 journal 为立即回滚条件；语义质量/成本不达门槛则关闭对应 opt-in，不影响 mechanical channel。

### 11.4 2026-07-18 实施前 preflight 快照（Historical）

| 命令 | 结果 |
|---|---|
| 文档 fence/heading/whitespace checks | PASS |
| `pnpm lint` | PASS（398 files） |
| `pnpm typecheck` | PASS（19 workspace projects） |
| `pnpm build` | PASS |
| `pnpm --filter @osstack/governance check:schemas` | PASS |
| `pnpm smoke:neat` | PASS |
| `pnpm eval:neat-goldens` | PASS（12 scenarios；blocking 100%；warning 80%；0 false negatives） |
| `pnpm test` | **BASELINE FAIL**：535/536 CLI tests pass；唯一失败为 §10.0 的 `/var` realpath expectation |
| 当前仓 `neat check --all` | exit 0、0 findings，仍漏掉 `<claude-mem-context>`；按 §0 冻结为 U0 regression |

本快照不是对尚未实现的 U 系列宣称测试通过；它只证明当前代码基线和本文实现入口可复现。B0 修复后必须用相同命令更新为全绿，才允许首个实现 PR 合并。

### 11.5 2026-07-19 实施后 release-candidate 验证

| 门 | 结果 |
|---|---|
| U0–U4 package tests | PASS；governance 280、Core 190、Agents 46、CLI 560 |
| `pnpm lint` | PASS（451 files） |
| `pnpm typecheck` | PASS（20 workspace projects） |
| `pnpm build` | PASS（20 workspace projects） |
| `pnpm test` | PASS |
| public V2 schemas + generated artifact freshness | PASS |
| `pnpm smoke:neat` | PASS；默认 V2 coverage/health claim、显式 V1 compatibility、read-only 均已验证 |
| `pnpm eval:neat-goldens` | PASS（12 scenarios；blocking 100%；warning 80%；0 false negatives） |
| `pnpm eval:neat-parity:corpus` | PASS（5 profiles / 30 cases / 120 defects） |
| `pnpm eval:neat-parity:offline` | PASS（C 臂 60/60；逐 case 两次 bit-for-bit） |
| `pnpm eval:neat-parity:doctor` | **预期 No-Go**；外部 hidden bundle/custody、冻结模型、四 adapter 与 production semantic credential 未提供 |

No-Go 不回滚已验证能力；它把发布声明锁定在 **auditable semantic hygiene beta release candidate**，并阻止 Khazix parity 文案。production semantic live smoke 与 48 小时/20 次 canary 仍是公开 beta 波次的外部门，不能由离线测试替代。

---

## 12. Definition of Done

### U0 release

- 当前 AGENTS.md 反例由显式 marker 命中；U0 corpus 达 §2.2 门槛。
- V1 human 输出诚实；V1 JSON 未变；V2 coverage/health claim schema 与 goldens 通过。
- 所有消费方能读 V2，partial semantic absence 不关闭历史 finding。

### Semantic beta

- SemanticJudgePort conformance 全绿，通用 AgentAdapter 无调用路径。
- narrative/contradiction/drift/memory-overlap 均能生成有 citation 的 V2 findings，coverage 从不超过其真实范围。
- provider/schema/input/预算失败均 fail closed 且有分类统计。

### Safe editing beta

- plan/approval/revision/idempotency/expiry 全部可验证；headless 无批准能力。
- move/compress/delete 三种去除语义符合 §4.3；故障注入后可恢复且不覆盖并发用户修改。
- repo 与显式 memory root 之外写入数为 0；不自动 commit。

### Cross-repository beta

- registry scan/daily 只读；inbox 与 downstream ConfigV2 权威不冲突。
- confirm/revoke 只在用户显式 execute 时修改当前 downstream config；到期不自动降级权威声明。

### Parity claim

- §7.4 所有 hidden-test gates 同时通过，报告包含成本、失败与模型完整配置。
- 若任一 gate 未通过，公开文档只描述已验证能力，不宣称与原版功能/效果等价。

本文没有剩余架构开放问题。实施中若必须改变公共 schema、退出码、authority、write boundary、统计 margin 或安全能力，先提交本文修订并重新 checker，禁止代码先行造成事实规格。
