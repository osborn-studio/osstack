# 研究验证记录与结论限制（修订 2）

> **2026-10-27 联合设计增补：** 当前实施契约、能力映射和 PR 顺序请先读 [Firstmate × pstack 联合设计](../../design/2026-10-27-joint-engineering/README.md)。下文保留修订 2 的研究与历史验证；重叠设计按联合规格收敛，产品仍未实施。历史审计只适用于当时输入，不代表本次增补已获模型复审。

## 1. 本轮真实完成的工作

1. clone `cursor/plugins`，采用 partial clone + sparse checkout，完整检出 pstack 及必要生成/验证资料。
2. 固定上游提交、pstack 子树、版本和 200 文件哈希；检查关键技能、playbook 与执行工具。
3. 核实 OSStack 工作区与 main 不同，改以固定 main Git 对象作为集成对照；保留原有修改。
4. 在项目 scratch 根下复制被测工具，锁定依赖安装，执行上游测试和类型检查。
5. 执行六项自行编写的语义探针，对照“文字规定”与“工具实际强制”之间的差别。
6. 创建报告、58 技能/23 playbook 目录、24 组能力映射、19 项实施安排、48 个待实现验收场景（修订 2 后总数）。
7. 通过浏览器完整阅读作者两篇 X 原文，形成 12 项设计修订映射，并更新现有报告、目录、规格和机器清单。

没有向 GitHub 写入，没有发消息，没有安装全局 pstack，没有运行 osstack 默认控制面数据库，没有实施产品功能集成。

## 2. 环境与复跑

本次环境：Node `v26.5.0`，Bun `1.3.13`；锁文件安装得到 commander `14.0.0`、bun-types `1.3.14`、TypeScript `7.0.2`。这些是这次工具环境，不是推荐 OSStack 改用的依赖版本。

克隆目录：`/Volumes/AIMATE_WORK/Developer/CodeX/cursor-plugins`。

从 OSStack 仓库根执行以下研究复跑命令（需要已安装 Node/Bun 与网络依赖下载能力）：

```sh
OSSTACK_SCRATCH_ROOT=/Volumes/AIMATE_WORK/tmp/osstack node docs/reports/2026-10-26-pstack/evidence/run-research-checks.mjs /Volumes/AIMATE_WORK/Developer/CodeX/cursor-plugins
```

脚本复制工具到 `createScratchDir('smoke', 'pstack-research')`，设置独立 TMPDIR、OSSTACK_HOME、Bun/cache 目录，运行 `bun install --frozen-lockfile --ignore-scripts`；为已审查 bootstrap 写入匹配的安装键，防止子 CLI 测试再次安装依赖。执行后清理本轮 scratch，日志留在报告 evidence 目录。复跑会更新研究日志，不应将新环境结果冒充为原始记录。

检查摘要：[research-checks.json](evidence/research-checks.json)。原始测试日志与探针日志均保留。当前产物不需要依赖这些日志里已删除的 scratch 路径。

## 3. 实际测试结果

| 检查 | 结果 | 范围 |
|---|---|---|
| `bun install --frozen-lockfile --ignore-scripts` | exit 0 | 隔离工具环境；不是全局安装 |
| `bun test orch watch-pr check-plan.test.ts` | **82 pass / 0 fail / 282 expect / 5 文件** | 工具单测；约 7.5 秒，仅为本次观察 |
| `tsc --project watch-pr/tsconfig.json --noEmit --strict` | exit 0 | 只覆盖此 tsconfig 范围，不是所有 TS |
| `node scripts/generate-pstack-harness-trees.mjs --check` | exit 0 | 检出版本的生成树一致 |
| 自定义 semantic probes | **6 项断言通过** | 合成 forge 输入、隔离账本、解析器 |

日志：[上游测试](evidence/upstream-tools-tests.log)、[类型检查](evidence/upstream-watch-typecheck.log)、[生成检查](evidence/harness-generation-check.log)、[探针](evidence/semantic-probes.log)。

本报告没有把“82 + 6”称为 88 个上游测试；六项是本次研究自行设计的观察断言。

## 4. 六项探针的解释

| 编号 | 方法 | 实际观察 | 能说明什么 | 不能说明什么 |
|---|---|---|---|---|
| R1 | fakeReader 提供 checks 通过、BLOCKED、REVIEW_REQUIRED | `classifyPr().kind === ready` | 上游 ready 不能直接用作 OSStack 合并许可 | GitHub 会接受合并；存在已利用漏洞 |
| R2 | fakeReader 提供 UNKNOWN merge state/mergeable | 仍为 ready | unknown 信息没有在此分类上阻止 ready | 所有真实未知场景都相同 |
| R3 | 同 key 先写 reviewer failed，再写 worker pass；无效 SHA/缺失证据路径 | 后写 pass 被读出 | store 是记账，未认证 verifier 优先级、SHA 与证据存在性 | 整个宿主没有任何其他检查 |
| R4 | 请求另一个 head key | 被拒绝 | 账本确实按 exact key 查找，不能说完全不区分 head | key 的内容真实或安全 |
| R5 | 解析简单 Mermaid 状态转换 | 得到两个可观察 transition | 基本解析路径可运行 | TLC 完整模型检查成功 |
| R6 | 解析 TLC 值 TRUE | 得到布尔 true | 基本值解析可运行 | Java、TLC、渲染链路均已验证 |

R1/R2 的默认 fixture 其余字段由上游 `fakeReader` 提供；本报告只对该明确构造负责。R3 发生在临时目录，未接触用户原有 ledger。代码见 [semantic-probes.ts](evidence/semantic-probes.ts)。

## 5. 没有执行的验证

- 完整 statechart/TLA+/TLC/Java/渲染套件。上游测试模块会在顶层查找/准备 TLC 与 renderer；本轮没有为读源码分析启动整套环境，解析器探针也不构成替代。
- Cursor 真实 cloud agent、routines、Benny Slack triage、跨模型评审的在线端到端运行。
- 任何真实 push、PR 创建、merge、deploy、消息发送或外部补偿。
- OSStack 应用全量测试。本轮未更改产品代码；对 main 的观察来自固定源码，不是对该提交完整部署行为的实测。
- 模型遵从性、真实缺陷减少、ROI 与长期维护成本。报告中的优先级和相对成本属于设计判断。

`acceptance-cases.json` 的 48 个场景全部标记 `specified_not_implemented`。它们不能被计入本轮通过数。

## 6. 关键证据索引

| 结论 | 主要证据 |
|---|---|
| pstack 不是纯提示词集合 | inventory、orch/watch-pr/statechart 源码、上游测试日志 |
| orch 不调度 agent | `playbooks/orchestrate.md` 的角色/CLI 说明 |
| verifier 优先级没有在 store 强制 | `store.ts` ledger record/check + R3/R4 |
| ready 不等于可合并 | `watch-pr/policy.ts` + R1/R2 |
| 固定十条 live lane 是上游模板要求 | `playbooks/multi-phase-plan.md`，非本报告建议 |
| 已检查 workflow 没调用 Bun 工具测试 | `.github/workflows/validate-plugins.yml` |
| main 有真实 Graph 执行能力 | main `graph-runtime.ts`、`legacy/code-delivery-v4.ts`、core graph state |
| v4 不能任意增加节点 | `validateGraphPlan` exact fixed topology + program resolver |
| 当前 Graph host 只接 local_verified | `graph-delivery-contract.ts` admission 检查 |
| Engineering pilot 只到 observed_turn | `protocol/src/engineering.ts` + engineering command/host |
| source registry 不等于完整 ingest | `skill-registry/src/index.ts`、manifest、watcher |
| context receipt 不是 provider 证明 | `execution-context.ts` 与 `graph-execution-context.ts` |
| 模型独立性身份为 reported | `protocol/src/delivery-contract.ts` |

所有上游文件固定链接见 [inventory](evidence/pstack-inventory.json)；OSStack 文件固定链接见 [source index](evidence/osstack-source-index.json)。未将本机其他私有资料上传到外部服务。

## 7. 产物自检

提供 [validate-report.py](evidence/validate-report.py)，校验机器清单身份、数量、引用、依赖无环、相对链接、固定来源文件哈希和 main 对象哈希，并记录结果到 `report-validation.json`。这验证报告内部可追踪性，不能证明每段分析都正确，也不能代替未来产品验收。

本轮保留了原有工作区状态快照 [workspace-status-at-research.txt](evidence/workspace-status-at-research.txt)。最终检查仅对本报告目录作格式与引用验证，不改写或整理原有未提交修改。

## 8. 作者文章补读与修订验证

本次补读成功来自 X 原站浏览器，不是搜索摘要或转载。读取范围和访问限制见 [author-articles.json](evidence/author-articles.json)。普通 fetch 的 403 没有被记作已读；只有后续完整浏览器正文才用作文章依据。没有保存全文副本或声称网页内容不可变。

两个来源分别映射到 12 项设计差异、24 组能力中的相关条目、19 项实施安排和总计 48 个验收场景。新增 A33–A48 都是待实现要求。本次没有重新运行或改变上游工具测试，之前 82 项测试 / 6 项探针仍对应原固定提交与原日志；不能把原成绩当成新增产品设计已通过。

修订 1 文件哈希保存在 [revision-1-artifact-hashes.json](evidence/revision-1-artifact-hashes.json)，用于说明版本边界。生成器已更新，重建机器清单/目录不会丢失文章修订。自检新增：文章→设计差异→能力→工作包→验收引用完整、W06 验证先行与 W03 等待实证探索的依赖、默认无自动化，以及新旧版本状态分离。

本轮只检查文档与规格一致性；W06 控制工具、W17 原型和 W18 地图尚未成为产品实现。结构化文件通过自检不证明这些设计优于备选，后续必须用命名场景验证。
