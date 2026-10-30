# 固定版本材料采用与局部导出

本批把固定 pstack **0.15.36** 的修复、调查、评审和证据实践实际写入 OSStack 首批材料，并让 exporter 检查所声明材料的精确字节。已有显式采用候选和 Codex/Claude 局部 bundle 导出能力。**尚未形成“单张看板卡 → 自动方法编译 → Loop/deliver 修复 → 同卡证据回写”的首用结果。** 本页只报告本批实际范围，不宣布全 P2/P3 完成。

## 用户现在得到什么

五份已修改的材料是 `bug-fix.md`、`investigation.md`、`code-review.md`、`evidence.md` 与 `sources.md`。它们增加当前路径/历史分离、条件式 TDD、run-verified findings 与静态 concerns 分栏、doctor/恢复/工具修复后重驱动，以及单卡任务和 host 收据关联说明。详见 [材料采用及调用草图](MATERIAL-ADOPTION.md)。

当前 host 可以显式读取材料。现有 exporter 可以将四个共享入口及 references 写入**全新项目局部目录**：Codex 为 `.agents/skills/`，Claude 为 `.claude/skills/`。这不是写入已有项目或默认 home 的 installer。14 个命名方法的数量没有增加；五份材料的新来源声明不把其他旧 pin 材料或整个目录升级为 0.15.36。Lauren Tan（poteto）与 MIT 归属保留。

调用现有导出入口时，先选择普通自有目录，其父目录必须存在、目标必须不存在，包括不能是 symlink。下面是现成命令的形状，不是独立真实导出已通过的回执：

```sh
pnpm export:methods --host codex --output /absolute/owned-parent/new-codex-bundle --dry-run
pnpm export:methods --host codex --output /absolute/owned-parent/new-codex-bundle
pnpm export:methods --host claude --output /absolute/owned-parent/new-claude-bundle
```

失败时保留工具输出和已创建的自有残留；修复原因后使用新目标，不覆盖现有 bundle。读取生成的 manifest、provenance 和实际材料后，再决定后续安装/host 使用。本批没有安装、激活、修改模型配置、验证 native discovery 或执行真实 host 任务。早期其他候选的 native/显式读取实验不能移作本批成绩。

## 固定来源与有界闭包

固定仓库声明：`https://github.com/cursor/plugins`；commit `c742dd61706fbacc1b95f1a20b7b988cf096ce6c`；package label `0.15.36`。版本标签与 commit 分开保存。

协调者对以下 **11 个目录组件**进行有界 source inspection，再按显式声明装配依赖闭包：

- `playbooks`：`pstack/skills/poteto-mode/playbooks`
- `tdd`：`pstack/skills/tdd`
- `how`：`pstack/skills/how`
- `why`：`pstack/skills/why`
- `sequence`：`pstack/skills/principle-sequence-verifiable-units`
- `test-behavior`：`pstack/skills/principle-test-behavior-not-implementation`
- `review`：`pstack/skills/interrogate`
- `arena`：`pstack/skills/arena`
- `create-verification`：`pstack/skills/create-verification-skill`
- `maintain-verification`：`pstack/skills/maintain-verification-skill`
- `prove-it-works`：`pstack/skills/principle-prove-it-works`

三个根是 playbooks、review、maintain-verification。候选去重后是 **51 个文件、174,474 bytes**，共享 LICENSE 只计一次。它没有提高 whole-subtree 的文件预算，也没有截断 573 路径的完整 pstack 子树来冒充全部采用。目录中包含的全部文件被记录，不等于每个 playbook、参考文或模型编排都已语义采用。

候选字段明确为：

- `declared_closure: verified`：已验证声明图及输入检查结果的一致性。
- `semantic_completeness: not_assessed`：未自动发现或证明所有语义依赖。
- `repository_identity: caller_asserted`、`package_version_identity: caller_asserted`：仓库和版本标签由调用方声明，未认证。
- `installation: not_performed`、`activation: false`、`formal_snapshot: false`。

两个外部前提仍为 `not_checked`：`authorized-local-host`（实际 host 的材料读取和任务权限），以及 `registered-project-checks`（目标仓库的注册复现/验证命令实际执行）。闭包成功不表示这两个前提已经成立。

`pstack/plugin.json` 的版本身份另由原始 Git 对象读取，**不属于上述 51 文件的组件闭包**。它与 LICENSE 的单独读取记录在 materials/source-components.json；该文件的 17 个阅读对象是材料作者的实际阅读集合，不能和协调者的 51 文件检查集合混成一个覆盖数字。

## Provenance 实际检查什么

`osstack-methods-skill/provenance.json` 列出五份材料的 SHA256、声明的上游路径/hash与 adoption candidate digest。`scripts/lib/method-provenance.mjs` 校验形状、路径、大小和所列 OSStack 材料的当前 bytes；exporter 复制该声明并在输出 manifest 中区分 bound/unbound materials。

输出状态是 `declared_material_hashes_checked`，并明确 `authenticated:false`、`upstream_content_verified:false`、`host_delivery_verified:false`。Exporter **不会**重读原始 Git 对象、认证作者/仓库身份、重新验证 candidate 内容，或证明 agent 收到了材料。其余 unbound 材料继续保留原归属。摘要一致是字节绑定，不是可信来源认证或执行授权。

最终候选 digest 为 `699ffdbbdd848f4e55dc0f7466d6bf21807b87306f2ff45ee436dc26ab26d7d3`，来自相同保留 inspections 重组，非新Git读取。旧候选 `fcdbd613…` 和原文件完整保留。各来源引用现在区分 adopted_guidance/context_only/identity_license，跨binding同path矛盾hash会拒绝。JSON重复key仍last-wins，已公开说明。摘要字段不等文件SHA256。

## 当前验证与原失败

| 记录 | 本次已收到的结果 | 能支持的结论 |
| --- | --- | --- |
| root exporter/provenance | `root/provenance-repair/green.stdout`：115 passed，0 failed | exporter 与 provenance 的当前聚合测试通过；不是 110 次真实 host 使用 |
| 作者 source-adoption | `materials/audit-repair/green.stdout`：35 passed，旧同测试33pass/2fail；先前作者30pass另留 | 声明闭包与有界输入行为；前次 green-1 的 4 fail/26 pass 保留，含 UNKNOWN_JOINT_DIGEST_DOMAIN |
| 独立 adoption 向量 | `independent/results-v2/results.json`：38 passed | 独立固定向量的声明、预算、路径和一致性边界 |
| 独立 provenance 向量 | `independent/provenance-results.json`：11 passed | 材料漂移与声明拒绝/接受边界，明确不认证上游摘要 |
| 独立实际 Codex/Claude 导出 | 独立真实两布局各89 payload（88材料+1 provenance），每布局333本地inline链接，4入口可达，逐文件hash/bytes一致 | 证明本次项目局部导出与可达引用；不是host使用 |

另有5个实际拒绝控制通过；独立第一次graph harness错误要求setup私有副本，修正为入口到共享材料的可达性后使用全新输出，原错误保留。这是验证脚本判断错误，不是产品失败。

以上测试集合有不同目的，不能相加成唯一场景总数或 native-host 覆盖率。没有在本 README 工作中重跑产品或上述测试。

初稿两处链接跳出自包含包，root 初轮 exporter 测试因此失败；修复为普通仓库路径后才得到当前 110 pass。原 `root/provenance-green.stdout` 保留失败，不因文件名带 green 而称成功。初稿文件保存在 materials/bug-fix-initial-draft.md 与 sources-initial-draft.md。旧上游 rubric 路径不存在的读取失败也保留，不能用新 pin 偷换历史引用。

## 证据位置

本批工作原件根为 `/Volumes/AIMATE_WORK/tmp/osstack/runtime/pstack-adoption-bundle-20261030/`。此页不是独立归档验收收据。

- `root/declaration.json`：11 组件及显式依赖；文件 SHA256 `7d6436d5fbce92d25027d126dc2c3c9a9d23b61a4571fd6645d9d5ed32a1df66`。
- `root/inspections/*.checked.json` 与 `root/adoption-candidate.json`：实际检查记录及装配候选。
- `materials/source-components.json`、`refs-matrix.json`、`material-bindings.json`：原始 Git blob/hash、逐材料采用来源及前后 bytes 绑定。
- `materials/upstream/`、`materials/before/`、`materials/static-check.json`：已读原文、改前材料与包内链接静态检查。
- `root/`、`author/`、`independent/`：各轮原日志和结果，包括失败与修正后的记录。

## 首次真实任务仍缺什么

**P4** 仍需单方法纯编译：将 bug_fix 材料、目标 repo 与注册复现/主检查绑定为确定的 MethodRecipe/Proposal；未知 check 或缺 required feature 应拒绝，产物保持 `executable:false`。这里已有材料与来源，不是已接消费者的 recipe 编译器。

**P5** 仍需在既有 deliver / execution-context-host / delivery-contract-host 内接线：真实 adapter 收到完整材料，invoke 前核版本/权限/预算，缺材料时 invoke=0。当前有这些宿主能力并不证明新的 mandatory method 已接入；不另建 scheduler。

**P6** 仍需选一张当前真实缺陷卡，冻结输入与预算，让实际 host 完成 RED→修复→同入口 GREEN、最终候选核验，再将原失败/成功/方法/receipt 回写同一卡。card→合同、注册检查映射及幂等证据投影尚须完成或明确人工步骤。不能重跑旧 packet/W19 或借用已关闭问题充当新首用。人类负责 merge；没有自动发布。

这些是直接使用链的剩余接点，不把全 61 skill、Firstmate 深运行、多模型排名或 formal/statechart 追加成首用门槛。本批可交付的是固定来源下的首批实际材料、声明闭包检查和局部导出/材料 hash 校验；实际用户修复结果仍待后续证据。

## 本批回归环境记录

root初次full在同一候选 `2389dcd9` 的默认Node26.5下遇到原有 `delivery.test.ts` 的 `stripTypeScriptTypes(mode: transform)` 拒绝。独立最小探针确认该API在Node26仅支持strip、Node22.22.1支持transform，涉及源/测试与base dd63字节相同；本批未修改它。切至Node22后首轮又因本地better-sqlite3仍为ABI147、运行时需要127而失败。pnpm rebuild退出0但未改变二进制，内存DB探针仍失败；显式Node22 npm rebuild后新二进制和内存DB探针成功，才允许新的full。全部原日志保留。前两轮不算完整回归通过；Node26兼容缺口留作独立真实任务候选。

最终full绑定 `2389dcd9f9f556df4c79e419bdc3e68561cba128`：Node22.22.1/ABI127原生依赖就绪后22包7334pass、5skip、0fail；9033 tracked bytes执行前后完全一致，初始4fresh knowledge/dist脏和文档未跟踪，不称clean committed tree。此结果早于后续审计小修，不能重标最终whole-tree full。

## 审计修订

[原审计逐项处置](AUDIT-DISPOSITION.md)保留D1–D7/R1–R7与局部修复。修订后fresh build/typecheck、目标TS lint、inventory检查均通过；MJS未被Biome覆盖，不称其lint已验。未重跑已完成full，不把旧7334结果换绑最终代码。

限定实际Sonnet5.5复审为PASS（仅D1–D7/R1–R3/R7源码修订，未执行）；原PASS_WITH_CONCERNS与全部可选项保留。独立后审计6向量旧4pass/2fail→新6pass；D1角色wire按预先追加说明调整，断言确认为source_conflict而不是shape拒绝；R1为typed RESOURCE_LIMIT。其新候选重组与root完全一致，新两布局各89payload/333inline边/hash/role再次通过；不是新host使用。初候选比较脚本漏计新增版本限制的失败及修正均保留，非产品失败。

独立初始455文件清单SHA `9604c7a9f73b8f5805a3798b73b0805cfc5ba4d42fae8d8dc6e325e49c39e1c2`；后审计234文件清单SHA `d0ccba31fb0325fda12d5faf789e14cfc84905455b924fa74187b21ede3d3ad2`，报告SHA `c5308a21fc67a6902df889f306533e4d48c5b9b407f7a40d074543a037e1ccbe`。root逐成员bytes/hash/mode复核。这些集合不能累加为真实用户场景数量。

## 归档与交付绑定

最终产品修订提交 `b36d97567d6ad0b3ab7458649583079512bf4dce`；定向35/115、fresh build/typecheck、TS lint和inventory绑定修订后代码。241文档检查通过。full仍只绑定2389dcd9，不与最终修订混淆。四份fresh knowledge/dist在全部验证结束后保存实际bytes/hash/patch并逐字节确认，再只恢复这四文件。

[evidence/raw-manifest.json](evidence/raw-manifest.json)列1286成员（1064files/222dirs，30,450,418 filebytes），[原件归档](evidence/raw-verification.tar.gz)SHA `f38dbe9453ec706a77f6122409c86beb74a4ed446a100ebbc9481b400f120d60`，manifest SHA `0fb426034573a4f14c09888b06ce8a377792ee3e7dcd686b7888df7f8438b752`。包含两次实际静态审计完整输入输出、作者/独立冻结与原失败、actual Git原件、两轮候选和全回归环境失败/成功日志、最终源码绑定。root已逐type/mode/size/hash核对源与tar，无symlink成员。本归档不包含模型实际使用或formal资格证明。

独立归档核验同样逐1286成员与源/manifest比较，且42项最终源码/Git、两审输入绑定通过：[核验报告](evidence/independent-archive/report.md)。核验包清单SHA `3e18aed8f740aa11e833a8961e97122dfb7b48ad3faffd60e07fa43060b736c1`。

本批发布为 [PR313](https://github.com/osborn-studio/osstack/pull/313)，head f6d7c09a，Draft依赖312，CI41036945434待终态；需父合并后actualmain重验。该发布记录在后续control保存，不改变候选CI身份。
