# osstack `neat` — 知识卫生（Knowledge Hygiene）能力设计文档

| 项 | 内容 |
|---|---|
| 状态 | Historical Draft v1 — implementation superseded by Accepted v2 |
| 日期 | 2026-07-17 |
| 作者 | Claude Fable 5（CTO 席）+ Osborn |
| 来源技能 | [KKKKhazix/khazix-skills → neat-freak](https://github.com/KKKKhazix/khazix-skills/tree/main/neat-freak)（MIT），公众号讲解文《洁癖》 |
| 目标仓库 | `/Volumes/AIMATE_WORK/Developer/CodeX/osstack`（@osstack/monorepo） |
| 约束 | 本文仅方案文本，不含实现代码；落地遵循 Fable-CTO/Opus-实现 的 maker/checker 分工，每增量独立 PR |

> Implementation source of truth: [`2026-07-17-neat-product-technical-spec-v2.md`](./2026-07-17-neat-product-technical-spec-v2.md)
> and [`2026-07-17-neat-implementation-plan.md`](./superpowers/plans/2026-07-17-neat-implementation-plan.md).
> This draft is preserved for source analysis and decision history; do not
> implement directly from its R0-R4 roadmap.

---

## 1. 背景与问题定义

### 1.1 要解决的问题

AI 协作开发中存在一个系统性衰减：**代码在迭代，而围绕代码的知识层（项目文档、agent 指令文件、跨会话记忆）在腐烂**。表现为：

1. **文档滞后**：代码迭代七八轮，`docs/` 还停在第一版；README 的安装步骤跑不通。
2. **指令漂移**：`AGENTS.md`/`CLAUDE.md` 里的路由清单、环境变量表与实际代码对不上，下一个 agent 基于错误前提做决策。
3. **记忆膨胀**：agent 记忆天生只追加（每条教训一个新文件），没有反向阀门；索引超过加载上限后**静默截断**——超出的部分等于没记。
4. **规则退化**：工作空间定了的规矩（命名、必备文件、同源约束）没人审计执行情况，规则退化成装饰品；规则文件本身也会烂（死引用、上下级矛盾、规则与实践漂移）。

neat-freak 的作者把这个现象概括为 "agent 脑腐"（不是模型变笨，是喂给模型的知识层坏了）。这个诊断与 osstack 的定位高度相关：**osstack 是驻留全机器组合（portfolio）的 PM agent，它的决策质量直接依赖每个仓库知识层的健康度**。

### 1.2 neat-freak 是什么（一句话）

一个跨平台 prose-only Agent Skill：会话收尾时以"知识库编辑"（而非记录员）的姿态，对**三层知识**（agent 记忆 / 项目指令文件 / 对外 docs+README）做审查、同步、瘦身，并审计工作空间规则的执行情况，最后产出变更摘要。触发方式 `/neat` 或自然语言（"整理一下"、"收尾"）。

### 1.3 为什么值得抽取进 osstack（价值论证提要）

- **补位**：osstack 现有能力覆盖"任务执行→验证→复盘"（loop/verify/retro/lessons），但**没有覆盖"知识层收尾"**——任务做完后文档/指令/记忆是否跟上，目前无人负责。neat 正好补上生命周期的最后一环。
- **升维**：neat-freak 是纯 prompt 技能，全靠 agent 自律逐条执行，不可验证、不可度量、不可调度。osstack 可以把其中**约 60% 可机械核验的部分沉淀为确定性代码**（可测试、可进 CI、可跑 portfolio 扫描、可出评分），只把编辑判断留给 LLM。这是"prompt 技能 → 工程化产品"的典型升维，也是 osstack 相对任何单机 skill 的差异化优势。
- **组合创新**：osstack 独有机器级仓库注册表（`~/.osstack/repos.json`）、daily 会话、supervisor 成熟度报告。neat 接入后可以做到 neat-freak 永远做不到的事：**全组合知识卫生巡检**（一条命令审计所有在册仓库）、**每日简报中的卫生评分**、**知识债趋势曲线**。

---

## 2. 来源技能剖析

### 2.1 材料与阅读范围

- 一手材料（已全文精读）：`neat-freak/SKILL.md`（283 行）、`references/sync-matrix.md`（变更影响矩阵）、`references/governance.md`（规范审计细则）、`references/agent-paths.md`（四平台路径速查）、仓库 README。
- 二手材料：公众号原文被微信验证页拦截，已通过搜狐转载摘要 + README 中的作者自述交叉确认——文章是该 skill 的叙事化讲解，**技术规格全部以仓库 SKILL.md 为准**，无信息缺口。

### 2.2 核心设计思想（按重要度排序）

1. **三层知识、三种受众**（最核心的概念模型）：

   | 层 | 受众 | 职责 | 不同步的代价 |
   |---|---|---|---|
   | Agent 记忆系统 | agent 自己（跨会话） | 偏好、非显而易见事实、跨项目 reference | 下次会话忘记历史决策 |
   | 项目根指令文件（CLAUDE.md/AGENTS.md） | 当前项目里的 AI | 约定、结构、红线、环境变量、路由清单 | 下次 AI 走弯路 |
   | `docs/` + README | **其他人**（同事、下游、接手者） | 接入指南、架构、运维手册、交接 | 别人无法接入/运维 |

   三层受众不同、职责不重叠，必须分别处理。"只改 CLAUDE.md 就收工"是该 skill 定义的头号翻车模式。

2. **指令文件是规则手册，不是变更日志**：判据一句话——"下次 AI 写代码时没看到这条会不会犯错？"不会 → 不配进指令文件。历史叙事归 git log / CHANGELOG，详细机制归 docs。

3. **记忆"毕业"（promote）机制**（防膨胀的唯一治本手段）：docs 靠就地编辑收敛，记忆天生只追加，必须有反向阀门把稳定知识往上泵。毕业判据：同主题教训出现第 3 次 / 讲的是"系统怎么工作"而非"踩过什么坑" / 纯事件记录。毕业动作：内容并入 docs 或指令文件，原记忆删除或缩成一行指针。辅助信号：索引行记"最后引用日期"，连续多次未被引用的非 reference 条目列为淘汰候选。

4. **尺寸体检优先于增量同步**：硬上限（MEMORY.md ≤200 行且 ≤25KB，超出部分会话加载时静默截断）+ 软上限（指令文件 ~300 行、单条记忆 ~100 行、单篇 doc ~1500 行）+ "体量倒挂"体检（memory 目录不应大于 docs 目录）。超尺寸的优先级高于补漏——先精简再补漏，两种心态不能混。

5. **规范执行审计（双向）**：方向一"实践有没有跟上规则"——从层级规则文件里提取**可机械核验的约定**（判据：能否写成一条 shell 命令核验），逐条核对；方向二"规则文件本身有没有烂"——死引用、矛盾、漂移。铁律：**规则真身永远在层级指令文件里，skill 不复制任何规则内容**（复制即制造两处真相）。

6. **处置分级**（安全模型核心）：安全/可逆/纯补齐 → 直接修并报告；破坏性/有外部影响/需权威判断 → 不动手，列入"待你拍板"，附依据出处 + 影响说明 + 建议。每条违规只有两种去处，不存在"看见了但没记录"。

7. **同类违规反复出现 → 建议 hook 化**：散文规则是建议性的，hook 是确定性的。反复被违反的规则应升级为事中强制拦截（skill 只建议不代配）。

8. **变更影响矩阵**：把"本次改了什么 → 要同步哪些文件"做成查表制度（新增 API → 指令文件路由清单 + integration-guide + architecture 三处；新增环境变量 → 指令文件 + runbook + 下游 guide；退役 → grep 被删符号清理所有非载荷引用；跨项目改动 → 上下游 docs 都要对齐——历史上最常翻车的场景）。

9. **强制自检清单**：改完后逐条打勾（净涨幅 ≤30 行、无相对时间遗留、新增路由在两处 docs 都出现、MEMORY.md 实测 ≤25KB……），打不了勾就回去补。作者称之为"这个 skill 的灵魂"。

10. **变更摘要即产品界面**：只列有实际变更/需行动的条目；体检读数只在超上限 70% 时展示——"摘要是行动引导，不是巡检日志"。

### 2.3 逐项能力的机械化可行性评估

这是集成设计的关键分析：哪些能力可以固化为确定性代码（进 CLI），哪些必须留给 LLM（留在 Skill 层）。

| # | neat-freak 能力 | 机械化程度 | 结论 |
|---|---|---|---|
| A | 尺寸体检（行数/字节/du 对比/阈值） | ★★★ 完全 | 进 CLI |
| B | 盘点（平台探测、文件枚举、清单核销） | ★★★ 完全 | 进 CLI |
| C1 | 规范审计·核验已知约定（软链完整性、必备文件、.gitignore 红线、命名约定、声明一致性） | ★★★ 完全 | 进 CLI（检查项注册表） |
| C2 | 规范审计·从散文规则中**提取**新的可核验约定 | ★☆☆ 需 LLM | Skill 层提取 → 沉淀为注册表新检查项 |
| D1 | 规则文件死引用检测（grep 路径 → ls 核验） | ★★☆ 大部分 | 进 CLI（多设备场景降级为"待拍板"） |
| D2 | 规则矛盾/漂移判断 | ★☆☆ 需 LLM | Skill 层 |
| E1 | 变更类型检测（git diff → 新增路由/env/表/退役符号） | ★★☆ 大部分 | 进 CLI（启发式 + 语言相关探测器） |
| E2 | 按影响矩阵实际改写 docs | ☆☆☆ 纯编辑 | Skill 层（CLI 只产出"应改清单"） |
| F1 | 记忆毕业**候选判定**（引用日期、类型前缀、重复主题计数、开放项过期扫描） | ★★☆ 大部分 | 进 CLI |
| F2 | 毕业**执行**（并入 docs 的改写、缩指针） | ☆☆☆ 纯编辑 | Skill 层 |
| G | 自检清单（后置条件断言：净涨幅、相对时间 grep、双处出现检查） | ★★★ 完全 | 进 CLI（`neat verify` 后置门） |
| H | 变更摘要渲染 | ★★★ 完全 | 进 CLI（human Markdown + `--json` 协议输出） |
| I | 安全自动修复（补软链、补 .gitignore 条目、建脚手架） | ★★★ 完全 | 进 CLI（`neat fix`，走策略门） |
| J | hook 化建议 | ★★☆ 大部分 | 进 CLI（违规频次统计 → improvement proposal） |

结论：**A/B/C1/D1/E1/F1/G/H/I/J 十项进确定性引擎；C2/D2/E2/F2 四项留在 Skill 编辑层**。这就是双层架构（§5.1）的依据。

---

## 3. 对 osstack 的价值分析

### 3.1 与现有能力的重叠矩阵（避免重复造轮子）

| osstack 现有能力 | 位置 | 与 neat 的关系 |
|---|---|---|
| `checkAgentInstructionDrift()`（loop doctor 内） | `packages/cli/src/bin.ts` ~10317 | **直接前身**。已实现 AGENTS.md 权威 + CLAUDE.md 必须为软链或 `@AGENTS.md` 单行引用的核验。neat 的"同源约束"检查应**抽取复用**此逻辑，而非新写一份 |
| `stack retro` / `renderStackRetro` | `packages/loop/src/stack-retro.ts` | 复盘哪个 gate 抓到问题、写 memory fact、提 improvement proposal。neat 是它的**知识层姊妹**：retro 管流程复盘，neat 管知识收尾。retro 输出中可追加"建议跑 `osstack neat scan`" |
| `lessons`（pitfall lessons + lesson drafts） | `bin.ts` ~6153、`packages/loop/src/lesson-draft.ts` | osstack 自有的记忆层。neat 的"毕业机制"应把 **lesson drafts → promote → docs** 这条既有通路作为毕业的一等去向（§5.7） |
| `governance` scanner | `packages/governance/src/scanner.ts` | 已有文件级扫描 → `GovernanceFinding` 的骨架。neat 的检查项注册表在数据模型上应与其对齐（Finding 结构可共享血统） |
| `steward`（分支清理） | `@osstack/github` | 收尾的"分支卫生"面。neat 是"知识卫生"面，二者并列为 finishing 家族，报告可互链 |
| `supervisor` 成熟度报告 + 仓库注册表 | `packages/supervisor`、`.osstack/repos.json` | neat portfolio 模式的宿主：卫生评分成为成熟度报告新维度 |
| `daily` 简报 | `packages/cli/src/daily-command.ts` | neat 摘要读数（逼近上限的仓库）进 daily brief |
| `osstack init` 脚手架 | `packages/skills/src/init/scaffold.ts` | neat fix 的"缺指令文件建脚手架"应复用它（skip-if-exists 语义现成） |
| policy gate（fail-closed） | `packages/cli/src/policy-gate.ts` | neat fix 的所有写操作必须经过它（§5.8） |

结论：osstack 已有约 30% 的零件（drift check、governance finding、lessons 通路、脚手架、策略门），neat 的工程本质是**把这些零件编排进一条七阶段流水线，并补齐缺失的检查项与报告面**。

### 3.2 差异化价值（osstack 版 neat 能做到而原版做不到的）

1. **可验证**：每个检查是确定性代码 + 测试 + conformance 行，而非"希望 agent 照做"。原版 SKILL.md 里"漏一个不行"、"必须逐项过"全靠模型自律；osstack 版把自律变成断言。
2. **可调度**：daily/daemon 定时巡检，卫生债不再依赖用户记得跑 `/neat`。
3. **可度量**：卫生评分 + 趋势（本周 MEMORY.md 距截断上限 82%→64%），进 scorecard。
4. **组合规模**：一条命令扫全部在册仓库；跨项目影响检查（原版最常翻车的场景）在 portfolio 注册表加持下可以真正做到"知道下游是谁"。
5. **闭环到治理**：违规频次统计自动生成 improvement proposal（"该 hook 化"建议落进既有 `upsertImprovementProposal` 通路），而非停留在摘要文本里。

### 3.3 明确不做（Non-goals）

- **不做通用 linter**：不重复 biome/markdownlint 的职责；neat 只管"知识层与代码的一致性"，不管文风与语法。
- **不自动改写 docs 正文**：编辑判断（怎么把一段机制写清楚）永远在 Skill/agent 层，CLI 不生成散文。
- **不引入新的记忆系统**：复用各平台既有记忆位置 + osstack 自有 facts/lessons，不发明第五种存储。
- **不代配 hook**：与原版一致，只建议、不代配（建议以 improvement proposal 形式落库）。
- **R0-R2 不做矛盾/漂移的自动语义判断**：LLM 判断留在 Skill 层，引擎只提供证据材料。

---

## 4. 产品设计

### 4.1 定位与命名

- **命令名**：`osstack neat` —— 顶级命令族（不并入 `stack`：`stack` 家族语义是合并编排，neat 语义是知识卫生，受众和触发时机都不同）。保留 "neat" 一词作为对来源的致敬，也与社区已形成的 `/neat` 心智一致。
- **中文名**：知识卫生（正式）/ 洁癖（昵称，帮助文案里保留）。
- **双形态**：
  - **CLI 子命令**（确定性引擎）：`osstack neat scan|fix|memory|verify|report`，支持参数化执行、`--json` 协议输出、portfolio 模式。
  - **子 Skill**（编辑智能层）：`neat-skill/`（与 `loop-engineering/`、`hermes-skill/` 同级的仓库内 skill 目录），SKILL.md 驱动 agent 完成 CLI 无法做的编辑工作，所有机械步骤**必须调 CLI 而不是徒手做**。这正是 osstack 既有的 "skill 是 CLI 的薄封装" 模式（loop-engineering 先例）。

### 4.2 用户故事

1. **会话收尾（原版核心场景）**：Osborn 在某仓库干完一件事，对 agent 说"收尾"→ skill 触发 → 调 `osstack neat scan --json` 拿到 findings → agent 完成编辑类处置 → 调 `osstack neat verify` 过后置门 → 输出变更摘要。
2. **纯命令行快检（无 agent）**：`osstack neat scan` 直接在终端出报告：哪些文件超限、哪些软链断了、哪些死引用。30 秒内完成，退出码可进 CI。
3. **安全修复**：`osstack neat fix` 只执行"直接修"级别的动作（补软链、补 .gitignore 红线、建指令文件脚手架），每个动作过策略门，产出可回滚记录。
4. **组合巡检**：`osstack neat scan --portfolio` 扫描 `.osstack/repos.json` 全部在册仓库，输出按仓库分组的卫生榜（谁的 MEMORY.md 快截断了、谁的 AGENTS.md 分叉了）。
5. **每日暗巡**：daemon 的 daily 会话跑 portfolio scan，只有逼近阈值（>70%）的读数进当日简报——沿用原版"摘要是行动引导不是巡检日志"的克制原则。
6. **loop 收尾钩子（后期）**：LoopEngine 的 run 成功收尾后，可选执行 neat scan 并把 findings 写入 LOOP-STATE 的收尾区，retro 时可见。

### 4.3 能力范围

**In scope（R0–R3 全景）**：尺寸体检、盘点、同源/必备文件/红线/命名/声明一致性核验、死引用检测、变更影响清单（检测+提示）、记忆毕业候选判定、过期开放项扫描、后置自检门、安全自动修复、摘要渲染（human + JSON）、portfolio 模式、卫生评分、hook 化建议落库、companion skill。

**Out of scope**：见 §3.3。

### 4.4 CLI 界面设计（命令族与参数）

> 以下为界面规格描述，非实现代码。动词集为**闭集**（遵循仓库闭枚举纪律）。

#### `osstack neat scan`（默认动词，只读）

全量七阶段流水线的只读前五阶段（§5.4），产出 findings 报告。

| 参数 | 语义 |
|---|---|
| `--repo <path>` | 目标仓库（默认 cwd） |
| `--portfolio` | 扫描注册表全部仓库；与 `--repo` 互斥 |
| `--scope <project\|workspace\|all>` | 审计范围，默认 `project`（当前项目 + 直接上级工作空间的名字层核验），对齐原版默认范围语义 |
| `--since <git-ref>` | 变更影响检测的 diff 基线（默认最近一次 tag 或 merge-base，可显式指定） |
| `--checks <id,…>` / `--skip-checks <id,…>` | 检查项子集控制 |
| `--json` | 输出协议 `AgentCommandResult`（§5.9） |
| `--fail-on <error\|warn\|none>` | 退出码策略，默认 `none`（报告不拦截）；CI 可用 `error` |

#### `osstack neat fix`（写操作，策略门管辖）

只执行处置分级为 `auto_fix` 的 findings。

| 参数 | 语义 |
|---|---|
| `--dry-run` | 列出将执行的动作与影响，不落盘（**默认开启**；真正落盘需显式 `--apply`） |
| `--apply` | 实际执行；每个动作先过 policy gate，gate 拒绝或抛错即跳过该项（fail-closed） |
| `--only <finding-id,…>` | 精确执行某几条 |
| `--json` | 同上 |

#### `osstack neat memory`（记忆层专用视图）

| 子参数 | 语义 |
|---|---|
| `--platform <claude-code\|codex\|opencode\|openclaw\|auto>` | 平台记忆路径选择，默认 auto 探测（对齐原版"只盘点真实存在的平台"） |
| `--graduation-candidates` | 输出毕业候选清单（含判据：重复主题 / 机制类内容 / 长期未引用 / 过期开放项），供 skill 层编辑执行 |
| `--stale-open-items` | 单独输出"开放项标记 + 过期绝对日期"命中行 |

#### `osstack neat verify`（后置自检门）

对应原版第五步自检清单的机械子集，作为**编辑完成后的验收门**：净涨幅 ≤30 行断言、相对时间 grep 清零、MEMORY.md 实测尺寸、索引链接有效性、"新增路由须在两处 docs 出现"类双处断言。skill 层必须在收尾前跑它并使其通过——把原版"灵魂步骤"从自律变成门禁。

| 参数 | 语义 |
|---|---|
| `--baseline <file>` | scan 阶段落盘的基线快照（净涨幅计算依据） |
| `--json` | 同上 |

#### `osstack neat report`

渲染最近一次 scan/fix/verify 的汇总摘要（沿用原版摘要五段结构：记忆变更 / 文档变更 / 规范审计 / 体检读数（>70% 才显示）/ 未处理），并支持 `--format md|json`。

#### 帮助与 i18n

英文 + zh-CN 双语帮助文案（bin.ts 既有 `resolveLanguage()` 机制），中文帮助保留"洁癖"梗但正式描述用"知识卫生"。

### 4.5 Skill 层设计（`neat-skill/`）

- **结构**：遵循 agentskills.io 开放标准与仓库内 `loop-engineering/` 先例——`SKILL.md`（frontmatter：name/description，含中英触发词，全面继承原版触发词表：`/neat`、"收尾"、"整理一下"、"同步一下"、"sync up" 等）+ `references/`（渐进披露：editorial-playbook.md、change-impact-matrix.md、agent-paths.md）+ `scripts/`（对 CLI 的薄封装入口）。
- **职责边界（写进 SKILL.md 的铁律）**：
  1. 机械步骤一律调 CLI（scan/memory/verify），**禁止徒手 ls/wc/grep 复刻**——保证行为与 CI/daemon 巡检一致；
  2. skill 只做四类编辑判断（§2.3 的 C2/D2/E2/F2）：从散文规则提取新检查项建议、矛盾/漂移的语义判断、docs 正文改写、记忆毕业的编辑执行；
  3. 收尾前必须 `neat verify` 通过；
  4. 处置分级照抄原版：破坏性动作只列"待你拍板"，永不动手；
  5. 继承原版编辑原则全文（减优于加、合并优于追加、删除优于保留、毕业优于内部挪腾、绝对时间、受众不混、指针不重复、同源不分叉）。
- **原版内容的取舍**：`sync-matrix.md` 与 `governance.md` 的方法论内容以改写形式收入 references（MIT 许可允许，保留出处署名）；`agent-paths.md` 四平台路径表直接继承并按 osstack 语境校订（osstack 权威文件方向与原版相反，见 §5.6）。

### 4.6 成功指标

| 指标 | 目标 |
|---|---|
| 机械检查覆盖率 | 原版自检清单中 ≥70% 条目变为 `neat verify` 可断言项 |
| 组合卫生可见性 | daily 简报出现卫生读数；supervisor 报告含卫生评分维度 |
| 静默截断事故 | 在册仓库 MEMORY.md 超 25KB 静默截断事件降为 0（scan 在 70% 即预警） |
| 采纳 | 会话收尾场景下 skill 调 CLI 的比率（通过 evidence 记录核验）而非徒手复刻 |
| 性能 | 单仓 scan P50 < 3s；portfolio(20 仓) < 30s（只读、可并行） |

---

## 5. 技术设计

### 5.1 架构总览：双层分工

```
┌──────────────────────────────────────────────────────────┐
│  Skill 编辑层（neat-skill/SKILL.md，LLM 判断）             │
│  规则提取建议 · 矛盾/漂移判断 · docs 改写 · 记忆毕业执行     │
│            │ 调用（唯一合法方式）            ▲ findings/JSON │
├────────────▼────────────────────────────────┴────────────┤
│  确定性引擎（@osstack/cli 内 neat 命令族）                  │
│  七阶段流水线 · 检查项注册表 · 处置分级 · 策略门 · 报告渲染   │
├──────────────────────────────────────────────────────────┤
│  复用零件：checkAgentInstructionDrift · governance scanner │
│  init 脚手架 · lessons/facts · policy gate · repo registry │
└──────────────────────────────────────────────────────────┘
```

分工原则一句话：**引擎产出"事实 + 处置分级"，skill 产出"编辑"，verify 门把两者缝合成可验收的闭环**。

### 5.2 包与模块布局

- **新代码全部落在 `packages/cli/src/`**，命名 `neat-cli.ts`（对外 `handleNeatCommand(args, deps)`，切 sub-verb 的 switch，闭集动词，返回退出码）+ 支撑模块 `neat/`（checks 注册表、pipeline、report renderer、baseline 快照）。理由：
  - 遵守 ADR-001 §D3 import 边界（kernel 包不得依赖 CLI；neat 依赖方向朝下：core/governance/supervisor/skills/protocol）；
  - 与 `stack-cli.ts` 同构，是仓库公认的"新子命令家族模板"（可注入 deps：`dbPath`/`runner`/`now`/`out`，保证测试 hermetic）。
- **可复用逻辑的抽取**：`checkAgentInstructionDrift` 目前内联在 bin.ts；本设计要求把它抽到 `neat/checks/instruction-drift.ts` 并让 loop doctor 与 neat 共同引用（单一实现，两个入口）。这是一次顺带的健康重构，独立成第一个 PR 的一部分。
- **bin.ts 接线**：dispatch 链加一行 `neat` 分支；英文/中文帮助块各加一段。
- **不新建 workspace 包**（R0-R2）：neat 无需被其他 kernel 包 import，留在 cli 包内最省边界成本。若 R3 后 portfolio 巡检要进 supervisor 的报告渲染，再评估把纯函数部分下沉到 `@osstack/governance`。

### 5.3 数据模型（以 Zod 闭枚举描述，此处为规格而非代码）

**NeatFinding**（对齐 `GovernanceFinding` 血统）：

| 字段 | 类型/取值 | 说明 |
|---|---|---|
| `id` | string | 稳定 ID：`<check_id>:<相对路径>:<定位>`，幂等去重键 |
| `check_id` | 闭枚举（附录 B） | 命中的检查项 |
| `severity` | `error \| warn \| info` | error=会造成静默丢失/决策错误（如 MEMORY.md 超硬限、指令分叉）；warn=软限超标、死引用；info=读数 |
| `disposition` | `auto_fix \| needs_decision \| editorial` | **三态处置分级**：原版两级（直接修/待拍板）+ 新增 `editorial`（需 LLM 编辑，路由给 skill 层）——这是双层架构在数据模型上的体现 |
| `evidence` | 结构化对象 | 依据出处（哪个规则文件哪一节）、实测读数、影响说明——对齐原版"每条违规带依据和影响，用户拍板需要判断材料" |
| `suggested_action` | string | 人类可读建议 |
| `repo` | string | portfolio 模式下的仓库标识 |

**NeatReport**：findings[] + 五段摘要结构 + 体检读数（含"距上限百分比"）+ scan 基线快照引用（供 verify 计算净涨幅）。

**CheckSpec**（检查项注册表条目）：`check_id`、类别（size/inventory/convention/reference/change-impact/memory）、默认 severity、默认 disposition、适用平台、核验描述。注册表是**数据表 + 每项一个纯函数**，新增检查项 = 加枚举值 + 加函数 + 加测试 + 加 conformance 行（`noFallthroughCasesInSwitch` 保证消费端穷尽处理）。

### 5.4 七阶段流水线（scan → fix → verify 的内部结构）

对齐原版六步 + 尺寸优先原则，重排为引擎友好的七阶段；**前五阶段只读（scan），第六阶段写（fix），第七阶段验收（verify）**：

1. **Baseline**：对目标文件集拍快照（行数/字节/哈希），落 `$OSSTACK_HOME` 下的 dated 工件（沿用 daily-briefs 的 dated-artifact 惯例，天然幂等）。
2. **Size Check（最高优先级）**：硬限（MEMORY.md 200 行/25KB）、软限（指令文件 ~300 行、单记忆 ~100 行、单 doc ~1500 行）、体量倒挂（memory du > docs du）。原版"超尺寸优先级大于补漏"的语义落为：size 类 findings 排序永远置顶，且 report 中显式标注"先精简后补漏"。
3. **Inventory**：平台探测（只枚举真实存在的记忆系统）、项目文件清单（docs/、散落 .md、指令文件、README）、逐文件"评估过/要改/不用改"核销状态机——原版"漏一个不行"变成引擎的完备遍历保证。
4. **Convention Audit**（方向一：实践 vs 规则）：跑注册表内全部适用检查项——同源约束（复用 instruction-drift）、必备文件、.gitignore 红线、命名约定、声明一致性（指令文件里的命令/路径/env 在代码中真实存在）。范围默认 project 级，对齐原版"同级项目只核名字不读内容"的成本控制。
5. **Reference & Change-Impact Audit**（方向二 + 影响矩阵）：
   - 死引用：规则文件内路径引用 → 存在性核验；多设备不确定场景不判死，降级 `needs_decision`（继承 governance.md 的误判提醒）；
   - 变更影响：对 `--since` 基线做 diff 分类（新增/退役符号、env、路由、表结构的启发式探测器），查影响矩阵（数据化为映射表，附录 C），产出"应同步文件清单"类 `editorial` findings；退役类额外做被删符号在 docs/记忆中的 grep 命中列表；
   - 记忆层：过期开放项扫描（开放项 marker + 早于今日的绝对日期同行命中）、相对时间残留、索引链接有效性、毕业候选判定（F1 判据机械化：重复主题近似计数、未引用时长、类型前缀生命周期）。
6. **Fix（独立命令）**：只消费 `auto_fix` findings；默认 dry-run；`--apply` 时逐项过 policy gate（fail-closed：gate 抛错=拒绝）；动作全集初期限定为**补软链/单行引用、补 .gitignore 条目、按 init 脚手架建缺失指令文件、清确认已删项目的死引用**四类（与原版"直接修"清单一致）；每个动作记录 before/after 证据。
7. **Verify（独立命令）**：后置断言集（§4.4），失败项返回非零退出码 + 未通过清单。skill 层收尾必须通过它。

### 5.5 检查项注册表与"规则提取"的闭环

原版铁律"规则真身在层级指令文件里，skill 不复制规则内容"在 osstack 版的对应物：

- **注册表只存"核验方法"，不存"规则内容"**。例如 `naming.kebab-case` 检查项的参数（哪些目录适用、豁免清单）来自**运行时读取**工作空间规则文件的结构化声明，而非硬编码。
- **结构化声明的载体**：在工作空间/仓库根引入可选的 `neat.config`（YAML，位置与格式在 R1 定稿；候选：`.osstack/neat.yaml`）。它不是规则的第二真身，而是**规则的机器可读投影**——由 skill 层从散文规则中提取、经用户确认后写入，散文与投影冲突时以散文为准并报 `needs_decision`。
- **提取闭环**：skill 层读散文规则 → 识别"能写成一条 shell 命令核验"的祈使句（原版判据）→ 生成投影条目草案 → 用户确认 → 落入 config → 此后引擎每次 scan 自动核验。散文规则每被违反一次，违规频次 +1；频次过阈值 → 引擎自动 `upsertImprovementProposal`（"建议 hook 化/gate 化"），完成原版第 7 条思想的工程化落地。

### 5.6 权威文件策略：与原版的关键冲突及解决

**冲突**：neat-freak 约定 CLAUDE.md 为真身、AGENTS.md 为软链；osstack 既有约定（`checkAgentInstructionDrift` 强制）恰好相反——**AGENTS.md 权威，CLAUDE.md 必须是软链或 `@AGENTS.md` 单行引用**。

**解决**：权威方向做成检查项参数 `canonical_instruction_file: agents_md | claude_md | auto`：

- osstack 管辖的仓库默认 `agents_md`（尊重既有约定与 doctor 行为，绝不因引入外来技能反转本仓约定）；
- `auto` 模式按现场探测（谁是真实文件谁是链接）判定方向，仅当**两份都是独立真实文件**时报 `needs_decision`（分叉合并需人工确认权威——与原版处置一致）;
- 该参数进 neat.config，portfolio 模式下按仓库各自解析。

这个冲突的处理原则值得写进设计准则：**抽取外来技能时，方法论照搬、本地约定优先**。

### 5.7 记忆毕业机制的 osstack 化

三条既有通路 + 一条新视图，不新建存储：

1. **平台记忆（Claude Code memory 目录等）**：引擎只做候选判定与读数（F1），编辑执行留 skill 层；`agent-paths.md` 的四平台路径表内置为探测器数据。
2. **osstack lessons**：lesson drafts 的 promote/discard 通路已存在——neat 把"毕业"语义接上：`neat memory --graduation-candidates` 同时列出平台记忆候选与 pitfall-lesson 候选，毕业去向按原版铁律仅二选一（docs/ 或指令文件），**永不毕业成新 skill**（原版用户约定，照抄为不变量）。
3. **memory facts**（`writeFact`，按文本去重）：neat 摘要中的稳定结论沿 retro 先例写 fact，幂等。
4. **引用日期信号**：R2 起在索引行维护"最后引用 YYYY-MM-DD"（写操作属 `auto_fix` 级、幂等更新），为淘汰候选提供实证依据——对应原版"膨胀记忆库拖低任务成功率"的效用观点。

### 5.8 安全模型与策略门

- **只读默认**：scan/memory/report/verify 零写入（除 dated 基线工件）；fix 默认 dry-run，落盘需显式 `--apply`。
- **fail-closed**：每个 apply 动作单独过 `evaluatePolicyGate`；gate 缺席≠放行（与 LoopEngine 的 kernel policyGate 语义一致）。
- **破坏性动作永不自动执行**：重命名、删除文件/目录、合并分叉指令文件——引擎连 `auto_fix` 选项都不提供，只产出 `needs_decision` findings 携带影响面说明（git remote/部署脚本/Syncthing 同步等，继承 governance.md 的影响清单）。
- **幂等**：所有 fix 动作可重复执行无副作用（软链已存在则跳过、.gitignore 条目已存在则跳过）；符合仓库 hermeticity 惯例（skip-if-exists、按文本去重、按 id upsert）。
- **证据链**：fix 的 before/after、verify 的断言结果进 evidence_refs，可被 proof pack 引用。

### 5.9 协议与 conformance 合规（新功能的仓库义务清单）

| 义务 | 内容 |
|---|---|
| 协议输出 | 所有 `--json` 输出为 `AgentCommandResult`（status、result、`evidence_refs`、≤3 条 `next_actions`），PROTOCOL_VERSION 1.x；`next_actions` 用于承载"待你拍板"条目的行动引导 |
| JSON Schema | `NeatFinding`/`NeatReport` 入 `docs/specs/schemas/`；test-vectors 提供至少 1 good + 1 `-BAD-` 冻结 fixture |
| CONFORMANCE_MATRIX | 新增 clause 行（finding 模型、处置分级不变量"无第三种去处"、fail-closed fix、verify 断言集）与 schema/vector/测试的映射，**同 PR 落地** |
| 闭枚举纪律 | sub-verb、check_id、severity、disposition 全部闭枚举 |
| Changesets | 每个用户可见增量附 changeset |
| CI | docs-only 快速路径不受影响；neat 自身的 smoke 脚本（hermetic home 中造一个带病仓库 → scan 断言 findings → fix → verify 通过）加入 `smoke:*` 家族 |

### 5.10 平台适配

四平台路径表（Claude Code / Codex / OpenCode / OpenClaw）作为探测器内置数据维护在一处（引擎），skill references 中的速查表声明"以 CLI 探测结果为准"——避免两处真相。Codex 的特殊语义照抄原版：`~/.codex/memories/` 机器生成文件不可手改，同步目标是 `AGENTS.md`；唯一手动清理对象是死 skill 目录（列为 `needs_decision`）。无记忆系统的平台整层跳过，把权重放到 docs 层（原版降级策略）。

### 5.11 性能与规模

- 单仓 scan 为纯本地文件系统遍历 + git diff，无网络；portfolio 模式按仓库并行（只读无锁风险），沿用 supervisor 的注册表读取。
- 大仓防护：inventory 遍历遵守既有排除惯例（node_modules/.git），maxdepth 控制散落 .md 的兜底抓取（原版 maxdepth 2）。

### 5.12 测试策略

- **单测**：每个检查项纯函数一组表驱动用例（含豁免/误判场景：work/ 沿用公司名不算违规、sandbox 豁免、多设备路径不判死——governance.md 的误判提醒全部转成测试用例）。
- **CLI 测试**：colocated `neat-cli.test.ts`，注入 deps（hermetic home + 临时仓库 fixture），覆盖退出码策略与 `--json` 形状。
- **conformance**：finding schema 校验、"处置三态无第四种"不变量、fix fail-closed 行为（gate 抛错必须跳过）。
- **smoke**：端到端病仓剧本（分叉指令文件 + 超限 MEMORY.md + 死引用 + 缺 .gitignore 红线 → scan 全中 → fix 修安全项 → verify 报出剩余 editorial 项）。
- **回归保护**：instruction-drift 抽取重构必须保持 loop doctor 现有行为字节级不变（既有测试作证）。

---

## 6. 落地路线图（每增量独立 PR，maker/checker 分离）

| 阶段 | 内容 | 验收 |
|---|---|---|
| **R0 — 只读 MVP** | `neat scan`（size + inventory + 同源/必备/红线检查）+ `neat report`；抽取复用 instruction-drift；human 输出 | 病仓 fixture 全中；loop doctor 行为不变；单测 + smoke 绿 |
| **R1 — 修复与协议** | `neat fix`（四类安全动作 + policy gate + dry-run 默认）+ `--json` 协议输出 + schemas/test-vectors + CONFORMANCE_MATRIX 行 | fail-closed 测试；幂等重跑测试；conformance 绿 |
| **R2 — 记忆与验收门** | `neat memory`（毕业候选/过期开放项/引用日期）+ `neat verify`（后置断言集）+ 变更影响检测（--since diff 分类 + 影响矩阵数据化） | 自检清单 ≥70% 条目可断言；退役符号 grep 剧本通过 |
| **R3 — 组合与智能层** | `--portfolio` + daily/supervisor 集成 + `neat-skill/` 发布 + 规则提取闭环（neat.config + 违规频次 → improvement proposal） | 20 仓 portfolio < 30s；skill 收尾剧本 E2E；卫生评分进成熟度报告 |
| R4（远期，另立设计） | LoopEngine 收尾钩子、卫生趋势曲线、跨项目下游影响图（依赖 registry 的依赖关系建模） | — |

升级条件与回退：每阶段独立可用、独立可回退（纯增量命令，不改既有命令行为；唯一重构点 instruction-drift 抽取有回归测试兜底）。

---

## 7. 开放社区最佳实践参照（除 neat-freak 外的借鉴源）

| 实践 | 借鉴点 | 在本设计中的体现 |
|---|---|---|
| Anthropic 官方 memory/CLAUDE.md 指引 | CLAUDE.md 占最贵注意力预算、只配放普遍适用内容；MEMORY.md 前 200 行/25KB 加载上限 | 尺寸体检的阈值来源与"静默截断"预警（70% 即报） |
| agentskills.io 开放标准 | SKILL.md frontmatter + references/ 渐进披露 | neat-skill 结构；触发词全集继承 |
| superpowers（obra）`verification-before-completion` / `finishing-a-development-branch` | "收尾是一个显式阶段，且必须验证而非自觉" | `neat verify` 作为收尾门禁的产品定位 |
| everything-claude-code `doc-updater` / `save-session` / `rules-distill` / `skill-health` | 文档同步 agent 化、规则蒸馏、技能健康度的先例 | 规则提取闭环（散文→机器可读投影）与卫生评分 |
| claude-mem 观察压缩 | 记忆效用信号（引用即价值） | "最后引用日期"信号与淘汰候选 |
| Diátaxis 文档框架 | tutorial/how-to/reference/explanation 四象限 | 原版"四处都补"（integration-guide/architecture/runbook/handoff）与之同构，影响矩阵数据化时按此归类 |
| ADR 实践（Nygard） | 决策记录有专门归宿 | "决策叙事不进指令文件"的判据在 osstack 语境下多一个合法去向：`docs/decisions/` |
| docs-as-code 工具链（markdownlint/Vale/lychee） | 死链/引用检查早有确定性工具先例 | 死引用检查的工程可行性佐证；同时划清边界（文风不归 neat 管） |
| pre-commit/husky hook 生态 | "反复违规 → 事中拦截"的标准解法 | hook 化建议 → improvement proposal 通路 |
| OpenAI AGENTS.md 规范（agents.md） | AGENTS.md 作为跨工具权威指令文件的行业方向 | 支持 osstack 默认 `agents_md` 权威方向的外部依据 |
| 记忆系统研究（只增不删拖低任务成功率） | 膨胀记忆是负资产的实证支撑 | 毕业机制与淘汰候选的立论 |

---

## 8. 风险与缓解

| 风险 | 等级 | 缓解 |
|---|---|---|
| bin.ts 已 447KB，继续内联加剧巨石化 | 中 | neat 全部逻辑在独立模块，bin.ts 只加一行 dispatch；顺带抽出 instruction-drift 是减法 |
| 检查项误报造成"狼来了"（用户开始忽略报告） | 高 | 继承 governance.md 全部误判提醒为测试用例；豁免机制（config 内 per-check 豁免清单）；读数 70% 阈值克制展示 |
| neat.config 成为规则的第二真身（违背原版铁律） | 中 | 定位为"机器可读投影"，冲突时散文优先并报 needs_decision；投影条目必须携带散文出处引用 |
| skill 层绕过 CLI 徒手复刻（行为漂移） | 中 | SKILL.md 铁律 + verify 门 + evidence 记录核验采纳率 |
| fix 在多设备同步（Syncthing）环境误动 | 中 | 破坏性动作零自动化；软链创建属安全类但在摘要中标注同步影响 |
| portfolio 扫描触碰不属于 osstack 管辖的仓库 | 低 | 只扫注册表在册仓库；scan 只读 |
| 与未来上游 neat-freak 版本演进脱节 | 低 | skill-registry（`~/.osstack/skills.config.yaml`）登记上游源与 blessed_sha，沿用既有外部技能追踪机制做升级观察 |

---

## 9. 留给复审（ChatGPT 5.6 SOL）的开放问题

1. **命令归属**：`osstack neat` 顶级命令族 vs 并入既有 finishing 语义（如 `osstack steward` 扩展）——本文选择前者，理由是受众与触发时机不同；请复核。
2. **neat.config 的必要性**：机器可读投影是否过度设计？替代方案是检查项参数全部硬编码默认值 + CLI flag 覆盖（更简单但失去"从散文规则提取"的闭环）。
3. **verify 的净涨幅断言（≤30 行）**：阈值直接继承原版经验值，是否应按仓库规模自适应？
4. **变更影响探测器的语言覆盖**：R2 的路由/env/表结构启发式探测器先做 TS/Node 生态（osstack 组合的主体），Python/其他生态延后——覆盖顺序是否合理？
5. **LoopEngine 钩子（R4）的耦合方向**：作为 `LoopRunOptions` 的可选 finalizer 注入，还是完全外置由 daemon 调度串联？前者内聚但增大 loop 面积，后者松耦合但时序保证弱。
6. **卫生评分公式**：本文未定义评分权重（size/convention/reference/memory 四类如何加权），建议 R3 前用 2 周真实 portfolio 数据校准后再定稿。
7. **原版内容的许可与署名**：MIT 允许改写收录，本文选择 references 改写 + 出处署名；是否需要在 NOTICE 层面更正式的致谢条目？

---

## 附录 A：neat-freak 原始能力 → osstack 设计映射全表

| 原版步骤/机制 | osstack 落点 | 形态变化 |
|---|---|---|
| 第零步 尺寸体检 | scan 阶段 2（size checks） | prompt 指引 → 确定性断言 + 70% 预警 |
| 第一步 盘点（强制枚举） | scan 阶段 3（inventory 核销状态机） | "漏一个不行"的自律 → 完备遍历保证 |
| 第二步 规范审计·方向一 | scan 阶段 4（检查项注册表） | 现场提取规则 → 已知项引擎核验 + 新项 skill 提取闭环 |
| 第二步 规范审计·方向二 | scan 阶段 5（死引用）+ skill 层（矛盾/漂移） | 拆分：机械部分下沉，语义部分留 LLM |
| 第三步 变更影响矩阵 | scan 阶段 5（diff 分类 + 矩阵查表 → editorial findings） | 查表制度 → 数据化映射 + 自动检测 |
| 第四步 实际修改 | fix（安全类）+ skill 层（编辑类） | 处置两级 → 处置三态（auto_fix/needs_decision/editorial） |
| 第五步 自检清单 | `neat verify` 后置门 | 自律清单 → 门禁断言（灵魂步骤的工程化） |
| 第六步 变更摘要 | `neat report` + 协议 next_actions | 文本摘要 → human MD + JSON 双形态 |
| 毕业机制 | `neat memory --graduation-candidates` + lessons promote 通路 | 判定机械化，执行留编辑层；去向不变量照抄（仅 docs/指令文件，永不成 skill） |
| hook 化建议 | 违规频次 → improvement proposal | 摘要文本 → 治理通路落库 |
| 特殊情况处理（无新事实也审计、跨项目双边对齐、历史漏洞归自己管） | SKILL.md 编辑手册继承 + portfolio 模式强化跨项目面 | 照抄 + 注册表加持 |

## 附录 B：R0-R2 默认检查项清单（闭枚举初始集）

| check_id | 类别 | severity | disposition |
|---|---|---|---|
| `size.memory-index-hard-limit`（200 行/25KB，70% 预警） | size | error/warn | editorial |
| `size.instruction-file-soft-limit`（~300 行） | size | warn | editorial |
| `size.single-memory-soft-limit`（~100 行） | size | warn | editorial |
| `size.doc-soft-limit`（~1500 行） | size | warn | editorial |
| `size.memory-docs-inversion`（体量倒挂） | size | warn | editorial |
| `convention.instruction-file-drift`（同源；复用现有实现；方向按 config） | convention | error | auto_fix（补链/单行引用）或 needs_decision（分叉） |
| `convention.required-files`（有可运行代码但缺指令文件） | convention | warn | auto_fix（init 脚手架） |
| `convention.gitignore-redline`（.env 等） | convention | error | auto_fix |
| `convention.naming`（config 声明的命名约定；含豁免） | convention | warn | needs_decision |
| `convention.declared-reality`（指令文件内命令/路径/env 真实存在） | convention | warn | editorial |
| `reference.dead-path`（规则文件死引用；多设备不确定降级） | reference | warn | auto_fix（确认已删）/ needs_decision |
| `reference.index-link-broken`（记忆索引链接失效） | reference | warn | editorial |
| `memory.relative-time-residue`（相对时间残留 grep） | memory | warn | editorial |
| `memory.stale-open-item`（开放项 marker + 过期日期） | memory | warn | editorial |
| `memory.graduation-candidate`（毕业候选三判据 + 未引用时长） | memory | info | editorial |
| `change.retired-symbol-residue`（被删符号在 docs/记忆中的非载荷引用） | change | warn | editorial |
| `change.sync-target-missing`（影响矩阵推导的应同步文件未动） | change | warn | editorial |

## 附录 C：变更影响矩阵的数据化表示（示意规格）

矩阵以静态映射表内置（R2），每行：变更类型（闭枚举：`api_route_added` / `env_var_changed` / `db_schema_changed` / `feature_added` / `term_renamed` / `deploy_changed` / `downstream_contract_changed` / `symbol_retired`）→ 目标文档角色集（闭枚举：`instruction_file` / `integration_guide` / `architecture` / `runbook` / `handoff_changelog` / `downstream_docs`）。文档角色到实际文件路径的解析按仓库探测（存在 `docs/integration-guide.md` 之类的惯例名即绑定；无则该角色标记 `absent` 并在 findings 中提示可选创建）。跨项目角色 `downstream_docs` 在 portfolio 模式下解析为注册表中声明依赖本仓的仓库集（R4 前退化为提示文本）。

---

*来源致谢：neat-freak（洁癖）由数字生命卡兹克（KKKKhazix）以 MIT 许可开源；本设计的三层知识模型、毕业机制、处置分级、变更影响矩阵、自检清单等方法论均源出该项目并按 osstack 工程语境改造。*
