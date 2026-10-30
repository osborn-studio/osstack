# W18 最小产品切片建议（只读核对）

结论：**复用 `searchKnowledgePacks` 的现有 BM25，增加一级索引到有限叶子的选择与读取薄层；不新建检索体系。** 当前缺的是可执行的功能地图选择、必需旅程闭包及材料完整性报告，不是另一套排名算法。本报告未运行产品、模型或测试，未改仓库；没有签发 W18/A35/A36/A48 完成结论。

## 固定来源与当前事实

- 候选：`147c59cfab63de7cb93d0445c63334a52f5c57a0`；主线：`01ec1852ffcf0cff4f1e4a0632b1ae3a8ddc1211`。下列 knowledge 源、execution-context、reader、journey、map-maintenance 在两对象之间 `git diff --stat` 为空。本报告用候选行号，不读取脏 primary 作为基线。
- 原合同 `docs/reports/2026-10-26-pstack/integration-spec.md:547–553`：W18 依赖 W06，先 3–5 场景；找到入口/前提/动作/终点/恢复；只读相关叶，跨入口覆盖明确；过期或缺前提不算通过。`664–689` 的 `FeatureJourneyV1` 是内容 schema，`last_live_evidence` 需既有 resolver 校验，缺证据仍 draft。
- 原 `acceptance-cases.json:457,473,663`：A35 是检索加实际多入口/跨表面驱动；A36 是漂移/前提失败不静默略过；A48 是按需求选择与纠正，不要求用户掌握大量命令。这三项不能由选择器单测替代。
- 原 pstack 固定 `99b609a72323b70204eab407c622f436e858e112`：`pstack/skills/create-verification-skill/references/feature-map-example/{README,create-note,search}.md`；`pstack/skills/maintain-verification-skill/SKILL.md` 第 25–35 行。前者先索引再用户路径配方，区分 CLI/UI 覆盖；后者要求实际驱动、区分图漂移/驱动缺口/产品回归。新内容独立表达，保留 Lauren Tan/MIT 来源，不照搬 Cursor 路径或无条件代理编排。

| 现有实现 | 可复用点 | 不能替代的义务 |
|---|---|---|
| `packages/knowledge/src/pack.ts:857–905`、`index.ts:1–2` | 已公开纯函数 `searchKnowledgePacks(packs, query, {limit})`，输出分数/匹配词/稳定 ID | 不能识别 required closure、入口覆盖、执行前提 |
| `pack.ts:27–36,908–936,1267–1274` | pack 验证与本地检索；现有 tokenizer 支持有限中英文字符 | `loadKnowledgePack` 把所有 chunk body 读入；中文连续短语不做语义分词，不能承诺自然语言理解；不应为 W18 顺带改 tokenizer |
| `packages/cli/src/execution-context.ts:183–221`；`packages/knowledge/src/context-budget.ts:47–102` | 既有 pinned 文件/scope/hash 验证及预算记录 | 当前知识全部 optional，可因预算省略；不能把 required feature 当 optional 后宣称材料完整；不改主机准入 |
| `packages/protocol/src/method-materials.ts:14` | `material:feature_map` 已有 entry/preconditions/actions/end/recovery/owner | 是单个产物合同，不是 §12.2 分层索引，不应擅自扩充共享协议 |
| `scripts/read-method-material.mjs:27–84` | 有界只读、整文件 hash、分页漂移与真实 EOF | 不做相关性选择、依赖闭包、前提判定；该私有读取函数也不是现成公共库，不建议为复用它改旧脚本 |
| `scripts/method-verification-journey.mjs:204–260`；`scripts/maintain-skills-check-map.mjs` | 真实固定五案例驱动、源/构建绑定、恢复与保留证据 | `feature-map.md` 是执行后的五行结果表；固定五案例 expectation map 不是分层场景索引。不要重命名它们冒充 W18 |

## 推荐可实施接口与算法

新增一个同时可 import、可直接调用的窄脚本 `scripts/method-feature-map.mjs`，调用现有已构建 `@osstack/knowledge` 公开导出。CLI 建议：

```sh
node scripts/method-feature-map.mjs --index docs/verification/features/index.json --query '验证地图 漂移' --limit 1
```

1. 只读一级 closed-schema index：版本、ID、用户目的、显式中英文关键词、入口表面、相对叶引用/hash、`required_feature_ids`。固定有界数量/字节；拒重复 ID、未知依赖、循环及逃逸引用。依赖声明是新增索引元数据，不是新的权限或真实完成来源。
2. 将 **索引内容** 临时投影为一个 `KnowledgePack`（相同 quality，不产生虚构审查资格），chunk ID=feature ID，title=目的，body=目的+关键词，tags=关键词。直接调用现有 `searchKnowledgePacks`，不加载任何 leaf body、不调用 cloud/cache/import/sync。返回分数/匹配词仅为词面相关性理由。
3. limit 只限制初选；展开必需旅程闭包，记录每个叶是匹配选中还是 required 依赖。预算不足、必需叶丢失或 hash 不符必须报告 incomplete/drift，不能截断闭包后称 complete。未命中明确 `no_match`，不要回退全库。未选叶正文不读；应列 omitted IDs/reason。
4. 仅读取所选固定引用，realpath 限 index 所在树、regular file、有界大小、精确 SHA；解析 §12.2 `FeatureJourneyV1` 的已定字段，核 ID/入口引用/covered IDs 自洽。索引 hash 一致只证明材料快照，不证明源码未变或旧运行仍有效；报告 source_revision/driver_version 和当前证据状态。
5. stdout JSON 报 query、index hash、selected reasons、required closure、各叶 hash/内容、omitted、缺口；stderr 稳定诊断。exit 0 仅表示选择与材料读取完整，**不是执行通过**；无匹配/材料缺失或漂移非零，输入损坏单独错误码。脚本不执行叶里的命令、不写 DB、不安装、不网络、不启动主机、不生成正式验证票据。
6. 前提只按叶描述交给调用者观察，未测标 unknown。`last_live_evidence` 首版可留空并明确 draft；不能把 hash/路径存在当 resolver 校验。现有 ArtifactRef/resolver 的精确接线若尚未确定，不在薄切片中另造一个，保留此实施缺口。

建议有限上限供实现前冻结：index 64 KiB / 32 IDs；最多 8 个所选含 required 叶，每叶 32 KiB、合计 128 KiB；query 4 KiB，limit 1–5。超限失败，不静默裁剪。数字为建议，尚非既有合同或已执行验证。

## 三个真实场景与最少文件分包

首批叶按已有可运行用户入口描述，不新增方法数量：

- `skills-map-maintenance`：`maintain-skills-check-map.mjs --map … --output …`，输入错误/合法期望漂移/真实五案例结果、修自有图后同入口恢复。
- `skills-check-journey`：`method-verification-journey.mjs --scope full --output …`，固定五案例与 product/driver exit 区分、失败/not_run、证据清理边界。
- `journey-evidence-packet`：`project-method-journey-evidence.mjs --scope full …` 与 `--check …`，依赖 journey 叶；仅是证据投影/内部一致性，不是原始历史认证。

有意令维护查询只加载维护叶，投影查询选中 packet 后加载必需 journey，未加载维护叶；实际依赖以用户可执行前提为准，不因为脚本内部调用就强行把整个库加入闭包。这是三个真实 CLI 场景，**尚无 UI/RPC 跨表面能力**。

遵守 W18 “超过五个直接文件按 feature 拆包”：

- 垂直包 A（4 文件）：`scripts/method-feature-map.mjs`、`.test.mjs`、`docs/verification/features/index.json`、`docs/verification/features/skills-map-maintenance.json`。先形成一个可调用场景；只声明 W18 子集。
- 垂直包 B（最多5文件）：更新 index/test，新增 `skills-check-journey.json`、`journey-evidence-packet.json`、`docs/verification/features/README.md`。最终交付达到原先3场景范围。README 复用 root 教程入口，不复制架构/旧实验包。
- 不必改 `packages/knowledge` 的算法/registry、共享 protocol/context-budget、旧 reader/journey、中央 ledger 或 Firstmate runtime。root 可另负责 alias/CI 接线，不把它们塞进作者独占范围。

## 必须验证的行为与交付边界

1. 真 CLI 查询、JSON 解析、help、不匹配与坏输入；基于真实三叶的中英文约定关键词。记录未覆盖自由改写，不以少量查询声称语义检索。
2. unrelated 叶设为不可读取的负例，相关查询仍成功，证明未偷读全文；required 叶不匹配也必须加入。删 required 叶、篡改同大小字节、超预算、逃逸/symlink、重复/循环引用必须具体失败，不输出 complete。
3. task 纠正后重新查询，selected/omitted 与实际理由变化；不沿用旧选择冒充新需求。读取结果逐字 hash 绑定；源/driver revision 不一致或前提未知不会变成 verified。
4. 本地实际用户垂直演示：冷读者先运行选择器、仅凭所选叶找到已存在 CLI 入口与恢复，再由唯一协调者按原权限驱动一次既有案例并保存原命令/输出/失败/恢复。**这一步仍待派发，报告未执行；不重跑已关闭 C0 packet来补数量。** 若复用已有 C0 结果，仅做证据引用，不声称本选择器曾参与该运行。
5. A35 的真实多入口/跨表面覆盖、A48 主机自动选择/纠正后送达、必需材料调用围栏仍属剩余验收；本切片可证明分层选择和相关材料可用，不证明模型理解、主机消费、完整 W18/C0/C1/C2 或 Firstmate 资格。

实际阻塞：未发现必须先等待 Firstmate runtime 的代码依赖。需要 root 在实施前冻结新增 index 字段/上限和首批叶证据处置；若要直接签原 A35 或把 last_live_evidence 标有效，则必须补真实双入口/跨表面执行和既有 resolver 绑定，这不是词面检索库可以代办的事。
