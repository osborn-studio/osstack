合同 | 部分 | 身份顺序、不变量、错误分类清楚。但摘要算法（RV04）、核心对象 schema（RV05）、产物与候选绑定（RV06）、Graph 输入身份路径（RV07）、permit 信任根（RV08）不足以让两个实现产出互相可验证的回执。schema 作为投影并无泛称错误，`context_receipt` 的 v1 继承字段由 `execution-context.ts` 可推得，不算缺陷。 |
| 48 项能力的语义覆盖 | 部分 | 24 FM + 24 PS 均有非空映射，对称性检查通过。但负例未被执行（RV11），`semantic_difference` 为模板（RV12），租约/角色划分行为无能力行，pstack 来源只是子集（RV17）。上游大文件被截断，FM-02/05/06 与上游 `fm-classify-lib.sh`、`fm-watch.sh` 的语义保真度我无法核验。 |
| 32 里程碑 / 69 旧任务的依赖与 PR 计划 | 部分 | J 图无环，共享写入有序，69 项旧任务全部有映射。但与继承 gate 的投影无校验（RV01），gate 收窄无决策记录（RV02），迁移注册文件无人拥有（RV03），J25 缺 J09（RV09），阻塞 gate 只在散文中（RV10）。 |
| 48 验收案例与 schema/validator | 部分 | 每个案例都有 Given/When/Then、坏变体和 oracle，层级标注诚实，全部 `specified_not_run`，没有把 planned 冒充为通过。但 `required_evidence` 为模板，部分案例不可证伪（RV14）。校验器对索引、图表、投影、负例覆盖都有盲区（RV15）。 |

## 真正不确定的项

这些我无法从输入判断，不应当作缺陷，也不应当作通过：

1. **#271 gate 的收窄是否被 Firstmate 所有者接受。** 联合稿把 R4 当作设计决定，但旧 followups 里它仍是 open。需要所有者表态，见 RV02。
2. **`daad404` 与 `c1cfccf` 在 `packages/` 下是否确无差异。** README 声称等价，我只能看到 `sources.json` 里相同路径出现了不同 sha（14e7433 与 c1cfccf 两个锚点）。我没有对象库，无法重算。
3. **X 文章归因（AD01–AD12）。** 输入只有先前阅读记录，我未读原文，不能确认或否定"作者主张"的转述是否准确。
4. **J23 与 J14 的接口顺序（RV09 第三点）。** 取决于 J23 测的是 adapter 原始能力还是 J14 定义的契约，输入未说明，需要作者澄清。
5. **`engineering.observe` 在 driver 里是否被允许使用（RV13）。** 取决于 J03 的设计意图。
6. **真实 Provider 的可用性与成本（O01/O04）。** 它决定 P0-A 与 E1/E2 是否可执行，现有文本无法判断。
7. **被截断的 Firstmate 大文件。** `fm-watch.sh`、`fm-supervise-daemon.sh`、`fm-captain-hold.sh`、`fm-teardown.sh` 等未提供，所有"上游行为是否被遗漏"的判断都限于已提供的 `fm-lease-lib.sh`、`fm-send.sh` 和 `secondmate-parent-channel.md`。

## 建议的修订顺序

最小修订集，先解阻塞，再补门禁：

1. **先修合同层（RV04、RV05、RV06）。** 补摘要黄金向量、proposal/recipe/产物 schema、按 kind 的候选绑定规则。这是两个实施者兼容的前提。
2. **再修所有权与 gate（RV02、RV03、RV01）。** 明确 broker 里程碑、迁移文件归属，并给 delivery-gates 加投影校验。
3. **然后补验收闭环（RV11、RV12、RV14）。** 负例反向引用、逐项差异说明、统计门槛。
4. **最后收口校验器与流程（RV15、RV10、RV16、RV17）。**

这些修订都是文档与校验器层面的，不要求启动产品实现。

REVIEW_END