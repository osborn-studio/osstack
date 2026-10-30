# W18 / W19 维护边界分析

基线：仅 Git `147c59cf` 的原设计与源码。身份：**熟悉上下文的分析者，不是 fresh cold 验收者**。本次未执行产品、模型、测试、后台任务或联网服务；未改产品、primary 或账本。本报告是静态边界建议，不能替代 W18/A35/A36/A48 或 W19/A45 实际验收，也不重新解释已关闭 cold 试验。

## 结论

W18 应交付“能找到、能解释覆盖、能识别过期的分层用户路径地图”，并为 W19 留下项目配置 owner 引用、版本和证据连接点。W19 再消费这组地图事实，交付“可查询的验证基础设施健康/维护状态、相关变更触发、真实修复后重驱闭环”。无需把 W19 的健康查询器、维护状态存储或周期调度器塞入 W18；也不能因为已有五例维护比较器，就宣告 W19/A45 完成。

原设计依赖为 W18 ← W06，W19 ← W06 + W18。C0 要求 W06/W17/W18 的工具、场景和接口依据，另由 W19 明确维护边界；不是要求 C0 先建设完整 Firstmate runtime。联合映射把 W19 拆到 J06/J23 不改变这个限定，也不使 J06 局部完成自动等于原 A45 通过。

依据：`docs/reports/2026-10-26-pstack/integration-spec.md:547–563, 665–693, 720–726`；`acceptance-cases.json:614–629`；`docs/design/2026-10-27-joint-engineering/legacy-work-map.json:898–925` 与 `legacy-case-map.json:1975`。

## 固定五例现在实际具备什么

| 层 | 147c59cf 的实际内容 | 不具备/不能推出 |
| --- | --- | --- |
| 期望地图 | `docs/implementation/skills-check-map-maintenance/map.json`：严格五 ID，每行仅 `case_id/expected_product_exit/expected_product_status`；顶层 schema/target/features | 没有用户目的、入口集合、前提、恢复、owner、source revision、driver version 或 last-live 关联；不等于 W18 分层地图 |
| 一次维护 | `runMaintenance({map, output}, seams={})` 读取不可跟随符号链接的 ≤64 KiB UTF-8 普通文件；拒绝遗漏/重复/未知 ID；只收绝对路径；新 output 必须位于 scratch；固定调用 full journey | 不发现一般项目的新功能；不按任务检索相关叶子；没有持久健康目录/维护 owner 查询；不会自动改地图或产品 |
| 维护结果 | `maintenance.json` 保留 before/after hash、unchanged、五行 expected/actual/matches、旅程收据与 manifest hash、首错/后续错误、时间、execution_path；0 consistent、1 mismatch、2 blocked | `mismatch` 不自动归因文档漂移或产品 bug；`blocked` 涵盖输入、环境、工具、证据等多种原因；不能直接一一映射 A45 根因 |
| 真实驱动 | `runJourney({output, scope:'full'})` 逐例 doctor→drive，验证原始输出、源数量/ref/SHA、输入稳定、source/build binding、清理；journey 与 case manifest 保留原始命令/输出 | 默认 journey 只有两例，必须显式 full 才是五例；不是任意入口 driver，也不是模型/native host/正式资格证据 |
| health 基础 | `preflight(...)` / driver `--doctor` 返回 availability checks、ready、executed=false；journey 保留本轮 doctor 命令和输出 | doctor 仅检查已有构建文件、Git、Node、证据目标等；不证明依赖加载/行为健康，更没有统一“最近健康检查/维护状态”记录 |
| ownership 基础 | 自有 scratch、独立证据、fixture 真实路径检查、隔离 OSSTACK_HOME、仅清理所属 fixture | 这是资源所有权，**不是维护责任人**；Git fixture author 也不是项目 owner |
| 材料 owner 字段 | `packages/protocol/src/method-materials.ts:14` 的 strict `material:feature_map` 含 `owner: Ref`，以及 entry/preconditions/actions/observable_end/recovery | schema 接受 Ref 只证明形状，不证明 owner 来自项目配置、获授权、在职或负责该工具；未见本固定维护入口做此解析 |

五例产品语义仍是 `healthy=0/healthy`、`missing-ref=1/failed`、`drift=2/drift`、`mixed=1/failed`、`empty=0/empty`。`healthy` 是来源检查结果，不是验证基础设施总体健康。driver 0 表示验证器确认了预期行为；负例来源仍 failed/drift，empty 没有健康来源观察。

`journey/feature-map.md` 是本轮结果表，包含证据和清理状态，不能倒称为能检索用户路径的长期分层索引。源码测试已覆盖非法输入、地图变更、未知 cleanup、未运行、组合故障诊断等；本次只阅读测试，不报告它们本次通过。

## 应并入 W18 的真实缺口

1. **分层路径地图和选择记录。** 一级索引有 feature ID、用户目的、关键词、入口与叶子引用；叶子提供原设计 `FeatureJourneyV1` 的入口、前提、drive refs、观察谓词、副作用、gotchas、恢复、覆盖入口、已知缺口和 last-live evidence。记录为何选中、略过什么、哪些 required 入口仍缺。已有五 case 可作为一个 skills-check 用户路径的行为分支；不能仅改名便把它们当作五条独立主要用户旅程。W18 原定先 3–5 主要场景，若首片只覆盖一个 feature 应直报其范围。
2. **最低过期与可用性检查。** 对 source revision、driver version/工具摘要、引用路径、最近真实证据做检查；不足时保留 draft/unknown、stale 或 blocked。检索返回的事实应与 coverage 分开：叶子可被找到不等于场景通过。地图变化不能靠删必需 case 或降谓词恢复绿色。这直接属于 A36，不应全部留给 W19。
3. **跨入口覆盖表。** 保留 declared entry IDs、实际 covered IDs、未覆盖原因；两入口任务不能拿单 CLI 结果完成。现五例固定 CLI 路径不证明 RPC/UI。对本片不存在/未测的其他入口明确 known gap，不为了满足表格新建 Firstmate 运行接口。
4. **最小 owner 接点。** 叶子/索引可指向“项目配置中的维护责任声明”，同时保留该配置位置和版本/摘要，供 W19 解析；配置尚未指定就明确 unassigned/unknown，不填作者、worker 或模型名字。W18 要让缺失可见，W19 才负责完整健康查询与维护归属流程。
5. **证据读取适配。** 引用既有 journey/case manifests、maintenance before/after 和原始结果，验证后才标注其覆盖。last-live 引用缺失/过期不得填“最新通过”。新运行失败不能被较老成功覆盖；分别表达最近尝试和最近成功，是避免 W19 接入后错误健康投影的必要约定。

建议 W18 新增的最小只读契约（建议，不是已存在 API）：`selectFeatures(task/index) -> selectedRefs + reasons + omittedScope + requiredEntries`；`inspectFeature(leaf, declaredRevision/driverBinding/evidenceRefs) -> freshness + prerequisites + coverage + unresolvedRefs`。它们只选择和检查材料，不隐式 doctor/drive/联网，也不写通过票据。是否抽成两个函数可由实际模块边界决定，不必因此建立服务。

## 可直接复用的接口及限制

| 现有接口 | W18/W19 复用方式 | 必须保留的限制 |
| --- | --- | --- |
| `node scripts/maintain-skills-check-map.mjs --map ABS --output NEW_ABS`；导出 `parseOptions`、`runMaintenance` | W18 为固定场景提供精确 drive_ref；W19 在明确请求修正后以新目录重驱并关联前后记录 | CLI 只有 map/output；不可添加假想 `--case`、`--scope`、任意 command。不要把 strict 五行 schema 扩成通用叶子，也不要把测试 seams 视为真实驱动 |
| `runJourney({output, scope:'full'})`；`verifyCaseEvidence({directory,scratch,caseId,repository,stdout,driverExit})` | 复用五例驱动及原始证据语义；提供 fixed-case adapter，不重写 exit-only verifier | verifyCaseEvidence 有当前目标/路径/fixture 不存在等前提，不是可对任意远端或归档目录无条件调用的通用 ArtifactRef resolver；需尊重来源/路径绑定 |
| `preflight({repository,evidenceDir,mode,caseName,path})`；driver `--doctor` / `--dry-run` | 显式检查工具前提并显示 check 明细；W19 可关联到 health observation | ready/preflight 不能升级为完整行为 healthy；检查无 subprocess/product import，不能顺手安装或启动服务 |
| `sourceBindings(repository)`；journey `tool_files`；manifest | 记录 source/build/driver 和 map 的明确身份，供 freshness 比较 | 当前 sourceBindings 会扫描全部 package src/dist，不是增量叶子影响分析器；hash 不能证明编译调用或独立生产者身份；保留这些 limits |
| `read-method-material.mjs --file ... [--start --lines --sha256]` | 读取已选叶子的有界快照，后续页锁定首读 hash | 仅 bounded bytes/page/EOF，不做相关性选择、证据验证或理解认证；勿把 EOF 当覆盖完成 |
| strict `MaterialSchemas.MaterialFeatureMap` / `MethodMaterial` | 已有 entry/preconditions/actions/observable_end/recovery/owner 的材料表达可做消费者投影 | `FeatureJourneyV1` 与此 schema 不同；别向 strict v1 填未经版本化的新字段。优先旁置详细叶子并明确映射，真需扩展时单独版本化并测消费者 |
| `projectJourney` / `checkPacket`（可选） | 后续确有分享需要时提供有限消费材料 | 不是 W18 检索或 W19 健康真值来源；packet 检查不重跑产品，也不认证原始来源；本次不执行 |

原设计还列出 `packages/skill-registry/src/watcher.ts` 和 `packages/supervisor/src/evaluator-epoch.ts`：前者 `checkSource/checkAll` 是显式 Git `ls-remote` 的来源 ref 漂移检查，可能联网，并无周期计时器；它不等于 feature 叶子源码/动作漂移分析。后者是 evaluator promotion/quarantine 逻辑，不是健康查询器。W18 不应为“复用”而接入网络 watcher 或资格晋升；W19/W11 真有对应需求再接，保留既有授权与 gate。

## 必须保留给 W19 的工作

- **健康与维护查询。** 原建议 `docs/verification/maintenance.md`、`scripts/method-control-health.mjs` 及健康记录 schema 在所查目标路径未出现；应消费 W18 叶子与证据生成可查询记录，而不是再建事实权威或借用来源 healthy。
- **健康记录最小语义。** 建议包含 project/feature/entry refs、owner configuration ref+version、工具/地图身份、最近 preflight、最近实际 drive、最近尝试与最近成功、已知缺口、维护状态、证据 refs、触发来源、周期配置状态。建议状态清楚区分 unknown/unassigned、environment blocked、harness failure、map drift、observed product failure；状态名须经实现契约冻结，不在本报告冒称已有 schema。
- **故障归因与修复复验。** A45 必须分别出现工具故障、地图漂移、产品回归，另保持环境不足类别；证明工具坏不能成功、修复一个工具问题后真实重驱受影响场景、旧失败与 cleanup 后证据留存。已有 stale-map→修正→一致仅覆盖地图更正片段；输入缺 case 修复也不是“工具故障修复”的替代。
- **相关变更触发。** 消费 W18 的 source/entry/driver references 形成受影响叶子集合，明确未覆盖或无法判定的映射；不每次隐式全仓扫描。既有维护工具固定跑满五例，不能假装支持子集执行：对该工具，相关 feature 被选中后仍 full 五例，成本和范围须明确。若未来支持更细粒度，另做有界契约变更，不偷偷更改 full 定义。
- **责任人配置治理。** 定义从哪一份项目配置读取、配置优先级/冲突、缺失时的结果、变更后的版本绑定与作用域。责任人是对工具/地图可靠性负责的项目指定角色或主体，不授予修改产品、删除证据、通知第三方或自动晋升的权限。
- **周期能力是可选后续。** A45 当前最低义务是未配置时无后台任务/通知。无需为了验证“禁默认后台”先实现 scheduler；若后续用户明确启用周期才单独设计并验证配置、范围和停止语义。

## owner 来源与禁后台默认语义

**owner 来源要求（原规范 + 最小证据化建议）：** 原规范明确“由项目配置指定，不从 article 作者、worker 名或模型自述推断”。因此真实 owner 值必须有可定位的项目配置声明；本报告不猜一个 owner。`method-owner` 等计划角色、Git author、scratch fixture ownership、schema 的 `owner: Ref` 都不能独自替代该声明。建议引用保存配置路径/键、配置 revision 或 digest、适用 feature/tool 范围；缺失明确输出未配置，禁止静默 fallback。配置冲突不能随意取模型偏好的值。owner 缺失不必使纯索引读取失败，但禁止报告“维护归属已配置/完整健康可用”。

**默认语义：** 浏览索引、读取叶子、查 health、导入模块不创建 watcher/cron/automation/daemon，不启动 runtime、不发通知、不调用网络、不自动修复、不运行模型。显式一次维护只有一次有界调用与自有资源；返回后没有默认重试/轮询/预约复跑。相关代码变更是影响选择的输入，不是隐藏的后台订阅。未配置周期应显示 disabled/not_configured，不能用 unknown 暗示已经观察到调度正常运行。

这里“health 查询默认只读”是本报告建议的清晰接口边界；原 W19 明文约束是未配置无后台/通知、区分故障、修复后重驱。若 health 入口另提供显式执行模式，应在命令/帮助上清楚区分 observation 与 execution，不能在读取历史时顺带执行。

对后续验收应检查一次调用的资源/调度/通知副作用，而不是只断言某函数没被 mock 调用；也不扩展为 Firstmate 长期托管、宿主资格、云/远端运行、监督器自主修复或全后代终止证明。现实现已明确 `descendant_termination: not_attested`，不能在 W19 健康汇总时擦掉这一限制。

## 分批完成口径

- W18 完成口径：有限 3–5 主要场景的分层检索、所选/省略理由、入口覆盖、前提/恢复、版本/证据 freshness 与 owner 配置引用边界；相关 A35/A36/A48 实验和断言另行真实执行。若仅 skills-check 片段，明确未覆盖项。
- W19 完成口径：读取 owner/健康/版本/最近驱动/维护状态，完成 A45 三类故障区别及工具修复后真实重驱，证明未启周期无后台/通知且证据保留。不能由 W18 发布或固定五例 consistent 代替。
- C0/C1 接点：本片可确定维护边界和可复用接口，不能借此宣告所有原 C0 或进入 Firstmate 深 runtime。继续依原 C1→C2 的接入/资格条件逐项推进。

## 主要证据坐标（全部为 147c59cf）

- `docs/reports/2026-10-26-pstack/integration-spec.md`：W18/W19、FeatureJourneyV1、owner 与维护语义。
- `docs/reports/2026-10-26-pstack/acceptance-cases.json`：A35/A36/A45/A48；`capability-map.json`：PS09。
- `docs/design/2026-10-27-joint-engineering/legacy-work-map.json`、`legacy-case-map.json`：依赖映射、原 gate 不自动通过。
- `scripts/maintain-skills-check-map.mjs`、对应 `.test.mjs` 与 `docs/implementation/skills-check-map-maintenance/README.md`：固定输入、比较/拒绝/保留行为及明确限制。
- `scripts/method-verification-journey.mjs`、`scripts/lib/skills-check-verification.mjs`：doctor、驱动、完整证据核对、资源所有权、来源绑定。
- `packages/protocol/src/method-materials.ts`、`scripts/read-method-material.mjs`：可复用材料形状与有限读取边界。
- `osstack-methods-skill/references/maintain-verification.md`：完整维护的源审查、故障分类、纠正后重驱和无周期自动化原则（本次作为仓库设计材料阅读，不是执行该 skill）。
- `packages/skill-registry/src/watcher.ts`、`packages/supervisor/src/evaluator-epoch.ts`：原设计列出的集成点与实际能力差距。
