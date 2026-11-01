# osstack × Grok Bots 双循环接通设计

日期：2026-11-01（北京时间）。状态：v3。**首期只落地零代码部分**（第三部分开头的“首期落地范围”：Mission 定位标记与事件约定）；修订链（§8.3、§8.5–§8.8 及相关阶段）**暂缓**，保留为后续设计。已按 Codex CLI（gpt-6-astra，medium，只读）审计修订（§14）；其余部分实施前需用户确认 §12 的决定。
基线：`main` `648606a7`。上位文档：[v3 双循环设计](2026-10-30-osstack-dual-loop-factory.md) §2、[受限单执行器 Mission 路径](2026-10-31-contained-mission-path.md)、[v3 执行计划](../plans/2026-10-31-osstack-v3-execution-plan.md)。取代《osstack × Grok Bots 打通设计草稿》（下称“草稿”）。

本文分三部分：第一部分说明这个领域的顶尖专家会怎么做（方法、原始素材、工具、独立证明）；第二部分是按这些要求重写的题目；第三部分是详细的技术与产品方案。

---

## 第一部分　专家视角

### 1. 他们会怎么设计

做“自动化代理 + 代码评审 + 受保护主干”的人（GitHub 平台工程、Google/Meta 的代码评审基础设施、Chromium/Kubernetes 的提交机器人、合并队列、SLSA 供应链安全）有几条共同做法：

1. **只有一条总线，而且是平台强制执行的那条。** 双方只读写 GitHub（PR、review、check run、ruleset），不互相调用。草稿选了 GitHub 作总线，但又让 Grok Bot 到 osstack 主机上执行 CLI，这是第二条控制通道。专家会删掉它：**osstack 自己从 GitHub 读回它创建的 PR 的状态，自己决定是否修订**；任何 bot 都不在 osstack 主机上执行命令。
2. **“可以合并”由平台判定，不靠 bot 自律。** `main` 目前没有 required status checks（§3）。专家会用 ruleset 把必需检查绑定到特定 GitHub App 的 integration id，别的账号发同名 check 不算数。
3. **每个角色一个机器身份，用 GitHub App，不用共享个人账号；行为限制和凭证能力分开说明。** 推送者、证据发布者、评审者各是一个 App。App 的权限只能到仓库级，“只能推某些分支、不能合并”必须另由 ruleset 和代码栅栏保证，并用直接 API 调用测试。现在审阅和合并由少数几个账号兼任（§3），评审独立性无法从记录中证明。
4. **控制回路按“对账”写。** webhook 会丢、会重复、会乱序；事件只是“该去看了”的提示。每次都读回完整、分页完整的状态，与账本比较，最多做一个动作；读不完整就不动作。
5. **修订有独立的状态机、预算和截止时间。** 已完成的 Mission 保持终态，修订回路是另一个实体（“修订链”），它有授权、轮次额度、等待截止时间和唯一的在途子 Mission。
6. **远端写入是带租约的比较并交换，加上平台限制。** 推送用 `--force-with-lease=<分支>:<预期旧 head>` 且新 head 必须是旧 head 的后代；分支 ruleset 只允许 Publisher 更新 Mission 分支并禁止非快进。每次远端写入先写意图日志，崩溃后按日志对账。
7. **评审正文是不可信输入。** 只作为“请执行器考虑的意见”，不扩大允许路径，不执行命令，不改变授权。
8. **先影子运行，再放权。** 新回路先只记录“会做什么”，用真实历史 PR 回放并统计，在沙箱仓库端到端通过后才允许推送。

### 2. 他们会做、但你没有要求的事

| 事项 | 为什么 | 本文位置 |
|---|---|---|
| 威胁模型与滥用用例 | 冒充评审者、重放、TOCTOU、注入、失控、成本、凭证泄露，每条对应控制和测试 | §10.1 |
| 身份与能力表（区分“凭证能做什么”和“代码允许做什么”） | App 权限是仓库级，不能单靠权限限制分支或合并 | §8.1 |
| ruleset 以代码管理 | 让批准、检查、会话解决、分支写入者都由 GitHub 强制 | §8.2、S1 |
| 独立沙箱仓库与测试评审 App | 真实端到端演练不在主仓库进行 | §10.3、S2 |
| 回放语料库 | 用真实 PR 时间线离线回放，结果可重复 | §10.3、S4 |
| 故障注入与崩溃边界测试 | 重复、乱序、并发评审、推送后崩溃、令牌吊销、租约竞争 | §10.3 |
| 状态机模型检查 | 证明额度、每 head 一次、外人写入即停 | §10.2 |
| 可观测性、SLO、截止时间 | 等不到评审也要能结束 | §9 |
| 成本预算 | 每条修订链的执行器 token 与容器时长上限 | §8.6 |
| 关闭开关与运行手册 | 出事时可停、可交接 | §11 |
| 决策记录（ADR） | 合并权、身份方案、拉取模型 | S0 |

### 3. 他们会从哪些原始素材入手

从系统真实留下的记录开始，而不是从整理好的文档开始。下表“已读取”为本次实际读取（2026-11-01 约 20:00 北京时间，`main` `648606a7`）；“需获取”为本次没有权限或尚未录制的。

| 原始素材 | 获取方式 | 本次结果 |
|---|---|---|
| `main` 分支保护与 rulesets | `gh api repos/osborn-studio/osstack/branches/main/protection`、`.../rulesets` | 已读取：需 1 个批准；`dismiss_stale_reviews`、`require_last_push_approval`、`required_conversation_resolution`、`enforce_admins` 开；**无 required status checks**；无 ruleset；无 CODEOWNERS |
| 真实 PR 的作者、批准者、合并者 | `gh pr view <n> --json author,reviews,mergedBy` | 已读取：#354 作者 `gilosbornhello`，`Rubebun-Jadeem` 批准并合并；#361 作者 `gilberthello`，`Rubebun-Jadeem` 批准并合并；#362 作者 `gilosbornhello`，`gilberthello` 批准并合并。**推送者身份未读取**，因此不能据此判断 `require_last_push_approval` 是否被满足 |
| 协作者名单 | `gh api repos/.../collaborators` | 已读取：7 个账号；哪些是人、哪些是 bot **未确认** |
| Mission 状态机 | `packages/core/src/state/engineering-contained-store.ts` | 已读取：`pr_opened` 为终态（L34、L51）；终态 Mission 不能再转换（L136 `mission_terminal`）；`supersedes` 只接受终态 Mission（L104），仅在停止已证明时释放工作区声明（L106–110）；`repair_cycles` 由替代 Mission 继承（L105） |
| Mission 分支与工作区 | `packages/cli/src/contained-mission-host.ts` | 已读取：分支为 `osstack/mission/<12 位随机十六进制>`，与 Mission id 无关（L38–43）；已存在的 worktree 路径被拒绝（L66） |
| PR 发布路径 | `packages/github/src/delivery.ts` | 已读取：`resolvePullRequest()`（L941 调用；L373–377）只接受 head 等于本次候选提交的 PR；现有“复用”只覆盖同一候选的重试，**不支持向已有 PR 推送新修订** |
| 发布栅栏 | `contained-mission-path` L278 | 已读取：拒绝 `gh pr merge|edit|close|ready|review|comment`；这是对命令的拦截，不限制直接 API 调用 |
| 双循环接口契约 | `2026-10-30-osstack-dual-loop-factory.md` §2 | 已读取：结论须来自登记生产者、绑定 head 与 base、schema 已知、在有效期内、去重；最多 2 轮 |
| 授权模型 | `packages/cli/src/engineering-access.ts` L7–17；`store.authorize()` | 已读取：read/write/stop/operator 四类 scope；开始 Mission 需当前有效的 write 授权 |
| PR 时间线、review `commit`、review thread `isResolved`、推送事件 | GraphQL `pullRequest { timelineItems, reviews, reviewThreads }` | 需录制（§10.3 回放语料） |
| webhook 投递记录 | `gh api repos/.../hooks`、`/hooks/{id}/deliveries` | 需获取 |
| Grok Bot 平台：routine 定义、事件负载样本、执行日志、能否以 GitHub App 身份运行 | Grok Bot 控制台导出 | 需用户提供；草稿中的平台能力描述**未经核实** |
| osstack 账本真实记录 | 测试 home 中 `osstack mission status --mission <id> --json` | 需在沙箱中产生；不得对 `~/.osstack` 或保留 home 运行开发版 CLI |
| GitHub 官方文档 | 见 §13 参考 | 已列出链接；具体行为以沙箱实测为准 |

### 4. 具体方法与工具

| 目的 | 方法 | 工具 |
|---|---|---|
| 读取 GitHub 真实状态 | 分页读到底，检查 `pageInfo.hasNextPage` 与总数；任一部分缺失即放弃本周期 | GraphQL、Octokit、`gh api --paginate` |
| 类型化解析 | 官方 schema 校验，未知字段拒收 | `@octokit/webhooks-types`、zod |
| 平台强制 | ruleset：必需检查绑定 integration id、批准、会话解决、最后推送批准、分支写入者与非快进限制 | GitHub Rulesets（`gh api .../rulesets` 以代码管理） |
| 机器身份 | 每角色一个 App，短期安装令牌 | GitHub Apps |
| 证据发布 | check run（`head_sha`、`external_id`、摘要） | Checks API |
| 远端写入 | 意图日志 + 带租约推送 + 写后读回 | `git push --force-with-lease=<ref>:<old>`、`git merge-base --is-ancestor` |
| 状态机正确性 | 模型检查与属性测试 | TLA+/TLC、fast-check + vitest |
| 回放与故障注入 | 录制真实时间线，离线回放；注入异常 | vitest 夹具、新脚本 `scripts/record-pr-timeline.mjs` |
| 测试有效性 | 改坏实现，确认测试失败（M8 已用此法） | 手工反向实验，可选 Stryker |
| 端到端 | 沙箱仓库 + 测试评审 App | 独立测试仓库、GitHub-hosted runner |
| 可观测性 | 每条修订链一个 trace id | OpenTelemetry、`osstack stats` |
| 注入防护 | 固定注入语料 | 红队用例集 |

### 5. 除了你我之外，什么能证明结果正确

| 独立证明者 | 能证明什么 | 不能证明什么 |
|---|---|---|
| GitHub 平台（ruleset 拒绝合并、拒绝非授权推送） | 未满足批准、检查、会话解决的 PR 合不进 `main`；Mission 分支只有 Publisher 能更新 | 代码逻辑正确 |
| GitHub-hosted CI（必需检查，绑定 App） | 与 osstack 主机无关的机器上，同一 head 的测试通过 | 测试是否充分 |
| 可复现验证 | 任何人在干净容器里对同一 SHA 重跑验证命令得到同一结果 | 验证命令本身是否恰当 |
| 账本与 GitHub 时间线对账（对账完成后） | osstack 记录的每次推送都在 GitHub 上，且 Mission 分支上没有未登记的提交 | — |
| 模型检查与属性测试 | 状态机在所有交错下满足额度、每 head 一次、外人写入即停 | 实现与模型一致（靠测试补） |
| 变异测试 | 关键检查被改坏时测试会失败 | — |
| 不同来源的评审模型 | 与执行器（Codex）不同来源的意见 | 不能替代人 |
| 回放统计 | 影子运行时“会做的动作”与人实际做法的一致率 | 新类型 PR |
| 人类合并者 | 最后一道闸 | — |
| （推迟）签名证据，如 GitHub Artifact Attestations | 证据由某个身份针对某个 SHA 产生且未被篡改 | 证据内容语义 |

---

## 第二部分　重写后的题目

> **题目：** 为 osstack（内循环）与 Grok Bots（外循环）设计一条以 GitHub 为唯一总线的双循环，使 osstack 创建的 PR 能在同一 PR 上按登记评审者的意见受控修订（每条修订链最多 2 轮、有截止时间和成本预算），“可以合并”由 GitHub 平台强制判定，合并由人执行。
>
> **要求：**
> 1. **从原始记录出发**：分支保护与 rulesets、真实 PR 的作者/推送者/批准者/合并者、PR 时间线与 review 绑定的提交、Mission 状态机与发布路径源码、账本记录、Grok Bot 的 routine 定义与事件样本、GitHub 官方文档；每条结论注明来源、读取时间、是否已核实。
> 2. **按领域最佳做法设计**：单一总线；分页完整的拉取式对账；每角色一个 GitHub App 并区分凭证能力与行为限制；必需检查绑定 App；修订链独立于 Mission 状态机；带租约的远端写入与意图日志；评审正文按不可信输入处理；先影子运行再放权。
> 3. **补上未要求但必需的部分**：威胁模型、身份与能力表、沙箱仓库与测试评审 App、回放语料、故障注入与崩溃边界、模型检查、可观测性/SLO/截止时间、成本预算、关闭开关与运行手册、ADR。
> 4. **列出方法与工具**：具体到命令、API 字段与库名。
> 5. **给出独立证明**：说明除作者和评审者之外，哪些机制分别证明什么、不能证明什么。
> 6. **交付物**：技术与产品方案（接口、状态机、数据结构、阶段计划、每阶段可执行的验收标准）、用户决定清单、风险与未确认项清单；由独立模型只读审计并记录处理结果。
> 7. **边界**：osstack 不合并、不评论、不批准；任何 bot 不在 osstack 主机上执行命令；不对生产 osstack home 运行开发版 CLI；评审意见不能扩大修改范围或改变授权。

---

## 第三部分　技术与产品方案

### 首期落地范围（零代码）

首期不改 osstack 代码，也不改 GitHub 设置。本文合并后，约定在登记名单 ADR（D）合并、routine 按约定配置后生效。只约定两件事，供 Grok Bots 的 routine 按约定读取 osstack 开出的 PR：怎样认出一个 Mission PR（A），以及各类 GitHub 事件怎样处理（B）。修订仍由人决定和发起（C）。修订链、对账器、GitHub App 身份和 ruleset 改造都暂缓。

#### A. Mission PR 的识别

1. **今天就能用的标记（现有输出，零代码）：** osstack 开出的 PR 正文第一行固定为
   `` Contained Mission `cm_<uuid>`, opened by OSStack. Review before merging; OSStack never merges. ``
   （`contained-mission-runner.ts` L443）。识别一个 Mission PR 需同时满足：
   - 正文第一行匹配 `` ^Contained Mission `(cm_[0-9a-f-]{36})`, opened by OSStack\. ``（Mission id 格式见 `contained-mission-rpc.ts` L12）；
   - PR 的 head 分支匹配 `^osstack/mission/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`（`contained-mission-host.ts` L35）；
   - PR 作者是登记的 osstack 发布身份（今天是 osstack 主机 `gh` 的账号，按 GitHub 数字 id 登记，见 D）。

   任一条不满足就不按 Mission PR 处理。
2. **正文中的其他字段只是提示：** `Candidate:` 行的候选提交、`Spec digest:` 行的规格摘要。bot 必须核对 PR 当前 `headRefOid` 等于 `Candidate:` 行的提交；不相等说明 PR 在 osstack 发布之后被改动过，只通知人，不做验证结论。
3. **权威来源：** PR 正文可被有写权限的人修改。权威是 osstack 账本（持有 read scope 的人运行 `osstack mission status --mission <id> --json`），或者直接问人。bot 不持有 osstack 凭证。
4. **预留的机器标记（暂不实现）：** 将来在正文末尾追加 `<!-- osstack:mission v=1 id=cm_… spec_digest=… -->`。解析规则现在先定下：`key=value` 以空格分隔；`v` 不是 1 时整条忽略；同一 PR 出现多条时整条忽略。实现前，bot 只用第 1 条中的第一行匹配。

#### B. 事件约定

只处理 A 认出的 Mission PR。

| GitHub 事件 | 条件 | Grok Bots 的动作 | 禁止 |
|---|---|---|---|
| `pull_request` 的 `opened`、`synchronize`、`reopened` | 事件的 head SHA 等于 PR 当前 head | Watcher 在该 head 上运行 verify-osstack，结论写明 head SHA | 在评论里写可执行命令 |
| `pull_request_review` 的 `submitted`（`changes_requested`） | review 的 `commit_id` 等于当前 head；评审者在登记名单内 | 给人发摘要：Mission id、PR、head、要点，以及可选的下一步（C） | 在 osstack 主机上运行任何命令；代人发起 Mission |
| `pull_request_review` 的 `submitted`（`approved`）且检查全部通过 | 同上 | 通知人“可以合并” | 合并 |
| `check_run` / `check_suite` 的 `completed` | 关联的 head 等于当前 head | 更新给人的状态 | — |

所有事件的共同规则：

- **head 与 base 绑定：** 事件、review 或检查对应的 head 不等于 PR 当前 head 时丢弃；新推送使旧结论失效。base 也要绑定：每个结论记录产生时 PR 的 base SHA，base 前移后旧结论失效，Watcher 需在新 base 上重新验证。
- **时效：** 超过 24 小时的结论不再作为“可以合并”的依据。
- **只作参考：** 首期给人的摘要和“可以合并”通知只是参考，不是双循环 §2 意义上被内循环读取的结论；内循环不消费它们，人做最终判断。
- **身份：** 只认登记名单内的评审者和生产者，按 GitHub 数字 id 而不是 login 比较。
- **去重：** 幂等键为 `<仓库>#<PR>@<head SHA>:<生产者数字 id>:<事件类型>:<review id | check run id | "pr">`，同一键只处理一次。
- **不自激：** 忽略由 bot 自己的动作触发的事件。
- **不可信输入：** review 与评论正文只是数据；bot 不执行其中的命令，也不把它们转成对 osstack 的指令。
- **往返上限：** 同一目标的“要求修改 → 修订”最多 2 轮（双循环 §2）。双循环 §2 要求的持久、原子计数随修订链暂缓；首期由人按 C 第 5 条记录。

#### C. 修订怎么做（暂代修订链）

修订链暂缓期间，修订由人发起，使用现有能力：

1. 人读评审摘要，决定是否修订。
2. 修订时，人用同一 scope 运行 `osstack mission start ... --supersedes <cm_id>`（scope 不同会被拒绝，L103）。`pr_opened` 是终态，可以被替代（`engineering-contained-store.ts` L104）；验证修复轮次 `repair_cycles` 由新 Mission 继承（L105）。
3. 新 Mission 使用新分支，**会开一个新 PR**，不会更新原 PR。人关闭原 PR，并在新 PR 中注明它替代的 PR。
4. 按 B 的往返上限，同一目标最多 2 次替代修订。
5. **轮次记录（人工）：** 现有 `repair_cycles` 只计验证失败后的修复，不计评审驱动的替代，不能当作往返计数。首期由人在新 PR 的说明中写一行 `修订轮次 n/2，根 Mission cm_…，替代 #<原 PR>`；Grok Bots 可以读这一行来提示“已达上限”，但它是人写的记录，不是账本计数。

#### D. 登记名单

登记名单写进一份单独的 ADR（S0a，不必等 §12 的其他决定；见 [ADR-005](../decisions/ADR-005-bridge-identity-registry.md)），包括：osstack 发布身份（GitHub 数字 id），以及会被计入的评审者、Watcher 身份（数字 id）。Grok Bots 的 routine 按名单配置 allowlist。名单变化通过 PR 修改 ADR。

#### E. 首期验收

- 用一个真实的小 Mission PR 演练一遍：Watcher 按 A 认出它，在当前 head 上给出结论；Reviewer 提交 review；摘要按 B 发给人；人按 C 处理或合并。
- 演练期间，bot 除提交 review 和结论外没有其他写操作，也没有在 osstack 主机上执行命令。
- 在 PR 发布之后手工推送一个提交：Watcher 按 A 第 2 条只通知人。

### 6. 产品定义

（以下 §6–§13 为完整方案。其中修订链相关部分暂缓，已在标题中注明；身份、ruleset 与平台探针需在 §12 决定后按阶段实施。）

**用户：** osstack 主机所有者（发起 Mission、授予修订额度、合并）；Grok Bots 运营者（维护 Watcher 与 Reviewer）。

**用户得到什么：** 发起 Mission 并授予修订额度后，PR 由 osstack 开出；Grok Bots 在 PR 上验证与评审；评审要求修改时，osstack 在同一 PR 上推送修订，最多 2 轮；评审通过后 osstack 把链标为“等人合并”。用户只在四个时刻介入：发起与授权、回路停止时的决定、截止时间到期时的决定、合并。

**不做：** bot 合并 `main`；osstack 读取评论里的命令；多仓库或多 PR 的 Mission；osstack 向 bot 发出站 webhook；签名证据（推迟，§11 推迟项）。

**成功指标：**

| 指标 | 目标 |
|---|---|
| 每条修订链的修订轮次 ≤ 授予额度 ≤ 2 | 100%（模型检查 + 测试） |
| 每条链必然结束（合并、关闭、等人、放弃之一） | 100%：等待评审超过截止时间即转人 |
| 未登记身份的结论被消费 | 0 |
| 对账完成后，账本推送集合与 Mission 分支提交不一致 | 0 |
| 第 1 轮修订后评审通过率 | 观测，作为是否继续投入的依据 |
| `CHANGES_REQUESTED` 到修订推送的中位时间 | 观测；SLO 初值 2 小时，影子期后调整 |

### 7. 总体架构

```
       人：mission start + mission grant-revisions（交互终端）
            │
            ▼
 ┌──────────────────────── osstack 主机 ───────────────────────────┐
 │ 子 Mission 执行（只读提议 → 主机提交 → 无网验证）                │
 │ Publisher（App A）：带租约推送 osstack/mission/*，首轮开 PR      │
 │ Evidence（App B）：每个 head 发 check run `osstack/verify`       │
 │ 修订链对账器（新）：读回 PR、选取合格评审、派发下一个子 Mission  │
 │ 意图日志：每次远端写入前记录，崩溃后对账                         │
 └────────────────────────────┬────────────────────────────────────┘
                              │ 只读写 GitHub
                              ▼
 ┌────────────────────────── GitHub ───────────────────────────────┐
 │ main ruleset：必需检查（现有 CI + grok/verify-osstack，绑定 App）│
 │   1 个批准、会话全部解决、最后推送批准、禁止 force-push          │
 │ osstack/mission/** 规则（拟议，未验证）：写入者限制 + 禁止非快进/删除 │
 └────────────────────────────┬────────────────────────────────────┘
                              │ 只读写 GitHub
                              ▼
 ┌───────────────────────── Grok Bots ─────────────────────────────┐
 │ Watcher（App C）：每个新 head 跑 verify-osstack，发 check run   │
 │ Reviewer（App D）：在当前 head 上提交 review；能解决则解决线程  │
 └─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
                 人：GitHub 显示可合并后合并
```

与草稿的差异：

| 草稿 | 本方案 | 原因 |
|---|---|---|
| Grok Bot 在 osstack 主机上调 `mission revise` | osstack 的对账器自己读回 GitHub 并决定 | 去掉第二条控制通道；草稿开放问题 3（主机命令能否常驻批准）不再存在 |
| `pr_opened` 后用 `supersedes` 继续 | 新实体“修订链”；Mission 保持终态，每轮修订是链上的一个新子 Mission | 终态 Mission 不能转换（L136），把 `pr_opened` 改为非终态又会破坏“只能替代终态 Mission”（L104） |
| 继承分支即可推到原 PR | 新的“修订发布”合同：PR 号、预期旧 head、新 head、仓库、base；带租约推送；写后读回 | 现有发布路径要求 PR head 等于本次推送并且不支持修订（delivery.ts L373） |
| “全绿”靠 bot 自律 | `main` ruleset 必需检查绑定 integration id | 平台强制 |
| 推送与评审用个人账号/共享账号 | 4 个 GitHub App + 人，并由 ruleset 限制分支写入 | 最小权限、可吊销 |
| 按 login 登记评审者 | 登记（App id，bot actor 数字 id）对 | login 可改名；review 的作者是 actor，不是 App |

### 8. 组件与接口

#### 8.1 身份与能力

| 身份 | GitHub App 权限 | 代码允许的行为 | 平台另外的限制 | 必须测试的越权尝试 |
|---|---|---|---|---|
| App A `osstack-publisher` | `contents: write`、`pull_requests: write` | 推送 `osstack/mission/*`；首轮开 PR 拟议（未验证）：Mission 分支两组规则——写入者限制（App A 为 bypass）与禁止 force-push/删除（**无** bypass）；`main` 的合并限制见 S1 | 用 App A 令牌直接调用 merge、comment、review、推送 `main` |
| App B `osstack-evidence` | `checks: write`、`metadata: read` | 发 `osstack/verify` | — | 用 App B 令牌推送或评论 |
| App C `grok-pr-watcher` | `checks: write`、`contents: read` | 发 `grok/verify-osstack` | — | — |
| App D `grok-pr-reviewer` | `pull_requests: write` | 提交 review；解决自己发起的线程（若平台允许） | — | 用 App D 令牌推送 |
| 人 | 维护者 | 合并 | — | — |

App 权限是仓库级的，`contents: write` 本身允许推送任何未受保护的分支和合并 PR。ruleset 的 bypass 对该 ruleset 内的所有规则生效，所以写入者限制与“禁止非快进/删除”必须放在两个 ruleset 中，后者不给 App A bypass。因此“App A 不合并、不推 `main`”由三层保证：代码栅栏（现有）、ruleset（S1 实测能否把 `main` 的更新限制到人）、沙箱中的越权测试（S2）。若 ruleset 无法把合并限制到人，就在 ADR 中写明这是代码栅栏保证而非平台保证。

#### 8.2 检查名称与 ruleset

| 检查 | 生产者 | 是否在 `main` 必需 | 原因 |
|---|---|---|---|
| 现有 CI（`check` 等） | GitHub Actions | 是 | 所有 PR 都有 |
| `grok/verify-osstack` | App C | 是（S6 起） | Watcher 对所有 PR 运行 |
| `osstack/verify` | App B | 否 | 只有 Mission PR 有；设为必需会卡住普通 PR。由 Watcher 检查 Mission PR 上该检查存在且 head 一致 |

#### 8.3 修订链（新实体）（暂缓）

新表 `engineering_revision_chains`（新迁移）：

| 字段 | 含义 |
|---|---|
| `chain_id` | 主键 |
| `root_mission_id`、`current_mission_id` | 首个 Mission；当前唯一的在途或最新子 Mission |
| `repository`、`pr_number`、`branch`、`base_ref` | 绑定的 PR |
| `published_head`、`published_base` | 最近一次由 App A 推送并读回确认的 head 与当时的 base |
| `grant`（JSON） | 授予人 principal、client session、scope、仓库与 base、额度（1 或 2）、到期时间 |
| `rounds_used` | 已派发的外部修订轮次；与 Mission 的 `repair_cycles`（验证失败重试）分开计数 |
| `state` | 见 §8.5 |
| `review_deadline` | 等待评审的截止时间 |
| `budget`（JSON）、`spent`（JSON） | 成本预算与已用量（§8.6） |
| `trace_id` | 可观测性 |

新表 `engineering_revision_reservations`：主键（`repository`, `pr_number`, `head_sha`），字段 `chain_id`、`review_ids`、`feedback_digest`、`child_mission_id`、`state`（`reserved`/`dispatched`/`void`）。主键保证**每个 head 最多一次修订**，无论该 head 上有几个 review。

新表 `engineering_publication_intents`：每次远端写入（推送、开 PR、发 check）之前写入，字段为类型、绑定（仓库、分支、预期旧 head、新 head、PR、check 名）、状态（`pending`/`confirmed`/`failed`/`uncertain`）。

#### 8.4 结论信封与选择规则

对账器把一次评审转为内部信封后才使用：

```ts
interface ReviewObservation {
  schema: "osstack.bridge.review/v1";
  repository: string; pr: number;
  review_commit: string;                  // GitHub review 的 commit_id
  observed_head: string; observed_base_sha: string; observed_base_ref: string;
  reviewer: { app_id: number; actor_id: number };
  review_id: number; state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "DISMISSED";
  submitted_at: string; observed_at: string;
  expires_at: string;                     // submitted_at + 24 小时
  body: string;                           // review 顶层正文
  threads: { id: string; review_id: number; path: string; line: number | null; body: string }[];
  feedback_digest: string;                // sha256(规范化 body + threads)
}
```

选择规则（全部满足才使用）：

1. 快照完整：reviews、reviewThreads、comments、commits 均分页读完；`mergeable` 为 `UNKNOWN` 时只影响“可合并”判断，不影响修订选择。分页读取不是同一时刻的快照，所以在预留前**再读一次** PR 的 head、base 与所选 review 的状态，任何变化都丢弃本周期。
2. `review_commit` 与 `observed_head` 都等于链的 `published_head`；`observed_base_sha` 等于 `published_base`，`observed_base_ref` 等于链的 `base_ref`。base 有任何变化即转人（不自动重放到新 base）。
3. `reviewer` 的（App id，actor id）对在主机私有登记表中（`$OSSTACK_HOME/bridge/producers.json`，不入仓库）。
4. 每个登记评审者的状态按提交时间归约：取其在当前 head 上最新一条 `APPROVED` 或 `CHANGES_REQUESTED`（`COMMENTED` 不改变状态，`DISMISSED` 清除状态）。修订输入包括该 review 的顶层正文和属于它的未解决线程；两者都为空时不修订，转人。
5. 两个登记评审者在当前 head 上结论冲突（一个通过、一个要求修改）即转人。
6. 未过期；（仓库、PR、head）未被预留。

#### 8.5 修订链状态机（暂缓）

```
awaiting_review ──合格 CHANGES_REQUESTED，rounds_used < 额度──▶ revision_reserved
       │                                                             │（同事务：预留 + rounds_used+1 + 意图）
       │                                                             ▼
       │                                                   revising（子 Mission 执行/验证）
       │                                                             │
       │                                                   publishing（意图日志 → 带租约推送 → 读回）
       │                                                             │
       ◀─────────────────────────── published_head 更新 ──────────────┘
       │
       ├─ 当前 head 上所有登记评审者 APPROVED ─▶ ready_for_human（终态之一；等人合并）
       ├─ PR 已合并 / 已关闭 ──────────────────▶ closed
       └─ 停止条件 ──────────────────────────▶ awaiting_decision（人：再授一轮 / 放弃 / 手工接管）

停止条件：额度用完且仍有修改要求；外人写入或 head 回退；base 变化；评审冲突；
          子 Mission 失败或停在 needs_reconciliation / stop_unknown；授权失效；
          超出预算；review_deadline 到期；意图处于 uncertain 且对账无法确定。
```

额度用完不等于失败：若最后一轮修订后评审通过，链进入 `ready_for_human`。

**子 Mission 状态到链状态的对应：**

| 子 Mission 状态 | 链状态 | 后续 |
|---|---|---|
| `authorized` … `verified`、`verify_failed`（仍在自身修复额度内） | `revising` | 子 Mission 按现有规则运行 |
| `delivering` | `publishing` | §8.7 第 4 步 |
| 子 Mission 发布确认 | `awaiting_review` | 链更新 `published_head`；子 Mission 进入终态 |
| `awaiting_decision`、`needs_reconciliation`、`stop_unknown` | `awaiting_decision` | 人先按现有 `mission decide` 处理**同一个**子 Mission（恢复或终结）；在它进入终态且停止已证明、工作区声明释放之前，链不得派发新的子 Mission |
| `cancel_requested`、`cancelled` | `awaiting_decision` | 取消会使该子 Mission 的发布意图失效（§8.7 第 5 步）；不自动再派发 |
| `failed`、`abandoned` | `awaiting_decision` | 预留标为 `void`；人可放弃链或在原额度内对**新的 head**（若之后有新评审）继续 |

人“再授一轮”只把 `grant.rounds` 提高，链的累计轮次上限始终为 2。由于预留按 head 唯一，同一个 head 不会派发第二个子 Mission；要重试同一 head，只能恢复原子 Mission。

#### 8.6 成本预算（暂缓）

`grant` 中给出上限，默认值待 §12 决定：

```jsonc
{ "max_executor_tokens": 400000, "max_container_seconds": 3600, "max_wall_clock_hours": 48 }
```

派发前从剩余预算中为子 Mission 预留本轮上限（写入子 Mission 规格：执行器 token 上限、容器超时）；执行中由现有执行器与容器超时强制停止，超出即按现有停止路径处理；结束时用实际用量结算 `spent`。剩余预算不足一轮上限时转人。

#### 8.7 修订子 Mission 的工作区与授权（暂缓）

1. **授权：** `grant` 绑定授予人 principal、client session、scope、链、仓库与 base、额度与到期时间。每次派发前和每次远端写入前，用 `engineering-access` 重新校验该 principal 仍有该 scope 的 write 授权且 `grant` 未过期；任一失败转人。授予命令 `osstack mission grant-revisions --mission <root> --rounds 1|2 --expires <时长>` 只能在交互终端执行并要求输入确认（与 `issue-grant` 相同）。
2. **工作区：** 每轮新建 worktree 和一个**新的本地分支** `osstack/mission/<新随机 id>`，起点 `start_commit = published_head`，完全沿用现有 `worktree add --no-checkout -b` 与安全检出、按分支名做比较并交换的提交、恢复与采纳路径（plumbing.ts L213、L251–306；ports.ts L140–143）。本地分支名与 PR 的远端分支名不同：远端分支保存在链的 `branch` 字段，只在发布时作为推送目标。上一轮子 Mission 的工作区按现有规则在终态且停止已证明后释放；停止未证明时不得派发（W13，见 S5 前置）。
3. **规格继承：** 允许路径、验证命令、保护集合与根 Mission 完全相同（规格摘要不同只因 `start_commit` 与评审意见）；评审意见放在执行器提示的“不可信评审意见”段。
4. **发布：** 新增 `publishRevision`，意图中绑定：仓库、PR 号、PR 的 head 仓库与远端分支、本地分支、`expected_old_head`、`new_head`、`expected_base_ref`、`expected_base_sha`、子 Mission id 与其 revision。步骤：
   1. 在 owner 栅栏下写意图（`pending`）。
   2. 读 PR：仍为 open、head 仓库与分支未变、`headRefOid = expected_old_head`、base ref 与 base SHA 等于预期；否则意图 `failed`，转人。
   3. 确认 `new_head` 是 `expected_old_head` 的后代。
   4. **紧挨着推送**调用现有的 `beforeRemoteMutation` 栅栏（ports.ts L83–89 在派发推送前调用，runner.ts L398–401 的检查：子 Mission 仍为 `delivering`、revision 与候选未变、已验证、无停止义务），并在同一回调中加上链检查：链未停用、授权未过期且 principal 仍有 write scope、子 Mission 未取消、链的 owner 未变。栅栏与推送之间不再有异步读取。
   5. `git push --force-with-lease=refs/heads/<远端分支>:<expected_old_head> <new_head>:refs/heads/<远端分支>`。租约由服务端在更新引用时比较，失败即有外人写入。
   6. 读回 PR：open、`headRefOid = new_head`、base 未变 → 在一个事务中把意图标为 `confirmed`、更新链的 `published_head` 并把子 Mission 转为终态；否则 `uncertain` 并转人。
   7. App B 发 check run：单独的意图，按（head、check 名、`external_id`）查找已有 check 后幂等重试，不影响链状态。

   分支租约只能锁住分支引用，不能同时冻结 PR 的 base 或开关状态；第 3 步与第 6 步之间若检测到这类变化，链停止并转人。
5. **崩溃恢复：** 启动时只做**只读回执对账**：
   - 推送意图：远端分支等于 `new_head` 且 PR 读回满足第 6 步 → 按第 6 步完成；等于 `expected_old_head` → 意图 `failed`（不自动重推），子 Mission 回到 `delivering` 重试，重试同样走 `publishRevision`（见第 6 点），由第 4 步的栅栏决定能否再推；其他 → `uncertain`，转人。
   - 首轮开 PR 意图：按（仓库、远端分支）查找 PR，找到且 head 一致即确认，否则交给现有 `delivering` 重试路径。
   - check 意图：按第 7 步查找后重试。

   任何重试都重新走第 2–4 步，栅栏仍紧挨着推送；子 Mission 已取消或链已停用时不再推送。只有对账完成后，“账本推送集合 = 分支上的提交”才被检查。
6. **发布路径按规格分派：** 修订子 Mission 的规格带 `publish_target: { kind: "revision", chain_id, pr, remote_branch }`。runner 的每一次发布尝试（首次与重启后的重试）都按它分派：有 `publish_target` 时只调用 `publishRevision`，`ports.publish`（按 `spec.branch` 推送并开 PR，ports.ts L176–177）对这类规格直接拒绝，避免把新本地分支开成另一个 PR。

#### 8.8 需要改动的代码（暂缓）

| 文件 | 改动 |
|---|---|
| `packages/core/src/state/engineering-ddl.ts` 与新迁移 | §8.3 的三张表；迁移门禁与升级保持（W8 规则） |
| `packages/core/src/state/engineering-revision-chain-store.ts`（新） | 链状态机、预留、意图日志，全部在事务内 |
| `packages/cli/src/contained-mission-host.ts` | 修订子 Mission：新本地分支，`start_commit = published_head`；规格中记录链 id 与远端分支 |
| `packages/cli/src/contained-mission-runner.ts` | 发布步骤（L406）按 `publish_target` 分派到 `publishRevision`，重试同样；`beforeRemoteMutation` 增加链与授权检查；首轮 PR 描述追加 `<!-- osstack:chain v=1 id=… trace=… -->`（仅索引）；执行器提示加入不可信评审意见段 |
| `packages/cli/src/contained-mission-ports.ts` | `publishRevision`；推送改用 App A 安装令牌；check run 发布（App B） |
| `packages/cli/src/contained-mission-bridge.ts`（新） | 对账器（§8.4、§8.5），默认关闭，`OSSTACK_BRIDGE=1` 启用 |
| `packages/cli/src/contained-mission-command.ts` | `grant-revisions`；`mission status --json` 增加链字段 |
| `docs/design/2026-10-31-contained-mission-path.md` | “外循环反馈的消费”从“不做”改为指向本设计 |

### 9. 可观测性与 SLO

- 每条链一个 trace id，写入 PR 标记、账本事件与 check run 摘要。
- `osstack stats` 增加：链按状态计数、每轮耗时、`awaiting_decision` 原因分布、对账周期耗时与失败次数。
- 截止时间：`review_deadline` 默认 24 小时（每次推送后重置）；到期转人。
- 对账周期：默认 60 秒；GitHub 限流时指数退避，退避期间不做任何写入。

### 10. 安全与正确性

#### 10.1 威胁与控制

| 威胁 | 控制 | 测试 |
|---|---|---|
| 冒充评审者 | 登记（App id，actor id）对 | 未登记 actor 的 review 被忽略；改名不影响 |
| 重放旧评审 | 必须绑定当前 head 与 base；有效期；每 head 一次预留 | 旧 head、过期、同 head 第二个 review 均不触发 |
| TOCTOU | 带租约推送；推送后读回；意图日志 | 读回前后注入外人提交、head 回退到祖先 |
| 外人写入 Mission 分支 | 租约（已有机制）；拟议的分支规则（未验证） | 其他账号推送：规则生效时被 GitHub 拒绝，未生效时租约失败转人；App A 的 force-push 与删除被第二组规则拒绝 |
| 提示注入 | 意见只进不可信段；允许路径与保护集合不变；不执行命令 | 注入语料：命令、`../`、`.github/workflows/`、伪造标记 |
| 回路失控 | 额度原子消费；每 head 一次；每链一个在途子 Mission；截止时间 | 模型检查 + 属性测试 |
| 成本失控 | 预算 | 超预算转人 |
| 伪造“全绿” | 必需检查绑定 integration id | 其他身份发同名 check，GitHub 仍显示不满足 |
| App A 越权合并或评论 | 代码栅栏 + ruleset + 越权测试 | 沙箱中用 App A 令牌直接调 API |
| 凭证泄露 | 私钥只在主机/bot 平台；安装令牌短期；可吊销 | 吊销后推送失败且转人 |
| 推送成功但回执未记录（崩溃） | 意图日志与只读回执对账 | 在推送后、记录前杀进程 |
| 取消后恢复时仍推送 | 重试前重新走完整发布栅栏 | 取消子 Mission 后重启，确认不推送 |
| base 变化或 PR 关闭时仍推送 | 推送前后读 PR 并比较 base SHA 与状态 | 执行期间推进 `main`、改 base、关闭 PR |

#### 10.2 不变式

1. 每条链 `rounds_used ≤ grant.rounds ≤ 2`。
2. 每个（仓库、PR、head）最多一个修订预留。
3. 每条链同时最多一个在途子 Mission。
4. 检测到外人写入（租约失败、读回不符、head 回退）后，链不再推送，直到人做决定。
5. 修订子 Mission 的允许路径、验证命令、保护集合与根 Mission 相同。
6. 对账完成后，Mission 分支上的每个提交都对应一条 `confirmed` 意图。

#### 10.3 验证计划

| 层 | 内容 | 通过标准 |
|---|---|---|
| 单元与属性测试 | 选择规则、预留、停止条件、意图恢复；fast-check 随机交错 | 10 000 次随机交错中 §10.2 成立 |
| 模型检查 | TLA+ 规格 `docs/design/specs/bridge.tla`：链、head、2 个评审者、1 个外人、崩溃 | TLC 无反例 |
| 回放 | 录制 #340–#363 时间线，影子模式回放 | 每个“会做的动作”可解释；无未登记身份被消费 |
| 故障注入 | 重复/乱序事件、并发评审、外人推送、head 回退、base 变化、API 5xx 与限流、推送后崩溃、令牌吊销、授权到期、1 轮额度 | 全部转人或幂等完成，无重复推送 |
| 变异测试 | 去掉租约、去掉预留唯一约束、去掉额度检查、去掉 base 比较 | 每个变异都有测试失败 |
| 沙箱端到端 | 沙箱仓库 + 测试评审 App：要求修改 → 同 PR 修订 → 通过 → 人合并；另一条链第 3 次要求转人；越权测试 | 时间线与账本一致；越权调用被拒或被栅栏拦截 |
| 注入红队 | 固定语料 | 无越界写入、无命令执行 |

验证容器在 W14 完成前没有依赖布局：S5 的端到端只能用不需依赖的验证命令（冒烟级）；用真实 `pnpm test` 的生产级验收要等 W14。

### 11. 分阶段计划

每阶段一个 PR 或一个人工决定，按顺序进行。

| 阶段 | 内容 | 负责 | 验收 |
|---|---|---|---|
| S0a 约定落地（首期） | 登记名单（首期 D）写成 ADR；Grok Bots 的 routine 按 A–C 配置 | 人 + Grok Bots 运营者 | 首期 E；不依赖 §12 的其他决定 |
| S0 决定 | §12 的其余决定写成 ADR | 人 | ADR 合并；S1 及之后的阶段从这里开始 |
| S1 平台基线 | ruleset 取代经典分支保护：现有 CI 为必需检查（绑定 GitHub Actions）、批准、会话解决、最后推送批准、禁止 force-push；实测能否把 `main` 的更新限制到人；建沙箱仓库并套同一规则 | 人（仓库管理员） | `gh api .../rulesets` 读回与 ADR 一致；沙箱中自批被拒 |
| S2 身份与平台探针 | 建 App A–D 与测试评审 App；在沙箱中实测：App review 是否计入必需批准、App 能否解决线程、App A 越权调用（merge、comment、review、推 `main`）、Mission 分支两组规则（App A 可快进；App A 的 force-push 与删除被拒；其他身份的更新被拒） | 人建 App；cloud agent 写探针脚本 | 每项探针有记录的结论；结论回写 §12、§13；Mission 分支规则未通过探针前，S5 不得开启推送 |
| S3 证据 | App A 推送、App B 发 `osstack/verify`；首轮 PR 标记；`mission status --json` 链字段 | cloud agent | 沙箱 PR 作者为 App A；check 的 `head_sha` 与账本一致 |
| S4 影子对账器（暂缓） | 链表与意图日志迁移；对账器只读运行，记录会做的动作；录制回放语料；TLA+ 与属性测试 | cloud agent | 回放无异常；模型检查与属性测试通过 |
| S5 同 PR 修订（暂缓） | **前置：W13 已合并。** 预留、子 Mission 工作区、`publishRevision`、`grant-revisions`、崩溃恢复 | cloud agent；先出实现细节并审计 | §10.3 除 W14 级验收外全部通过；沙箱两轮修订 + 第 3 次转人 |
| S6 Grok Bots 适配 | Watcher 改为 App C，对所有 PR 发 `grok/verify-osstack`，`main` ruleset 加入该必需检查；Reviewer 改为 App D | Grok Bots 运营者 + 人改 ruleset | 沙箱与主仓库上该检查由 App C 产生；若 S2 显示 App review 不计入批准或不能解决线程，则批准与解决由人完成并写入 runbook |
| S7 主仓库上线（暂缓） | `OSSTACK_BRIDGE=1`，先只对单个 scope；runbook 合并 | 人 | 连续 5 条链无异常；§6 指标可读 |
| 推迟 | 出站 webhook；bot 合并；合并队列；签名证据 | — | 有真实需求再做 |

**运行手册（S7 前合并）要点：** 关闭开关 `OSSTACK_BRIDGE=0` 只停止新的预留与派发，在途子 Mission 走现有取消路径，`pending` 意图仍在下次启动时对账；吊销 App A 安装可立即阻止推送；`awaiting_decision` 每种原因的处理步骤。

### 12. 需要用户做的决定

1. **合并权：** 维持“人合并”（推荐）；并说明 `Rubebun-Jadeem`、`gilberthello` 是人还是 bot。
2. **身份方案：** 同意用 4 个 GitHub App（加 1 个沙箱测试评审 App）取代个人账号与共享账号。
3. **协作者名单：** 7 个账号逐一标注人或 bot，bot 是否降权。
4. **ruleset 改造：** 同意 S1（会改变所有 PR 的合并条件）。
5. **默认额度、预算与截止时间：** 每条链默认授予 1 轮还是 2 轮；§8.6 预算与 24 小时截止时间是否合适。

### 13. 风险、未确认项与参考

**风险与未确认项**

1. App 提交的 review 是否计入必需批准数、App 能否解决线程：未确认，S2 实测；不计入则由人批准与解决。
2. ruleset 能否把 `main` 的更新限制为人：未确认，S1 实测；不能则合并限制只由代码栅栏保证，需在 ADR 写明。
3. Grok Bot 平台能否以 GitHub App 身份运行：未确认，需平台导出样本。
4. W13（主机 git 子进程在守护进程崩溃后存活）：修订推送路径同样受影响，S5 的硬前置。
5. W14（验证容器无依赖布局）：在此之前修订回路只能做冒烟级验证。
6. 评审意见在允许路径内“改坏逻辑”：分类器挡不住，只能靠验证、独立 CI 与人。
7. GraphQL 读取成本与限流：大 PR 的分页读取次数需在影子期测量。
8. Mission 分支的写入者限制与禁止非快进规则：拟议配置，未验证，S2 实测。
9. 分支租约不能原子地冻结 PR 的 base 和开关状态：只能检测，检测到即停止。

**参考（实施前在沙箱中逐条实测）**

- GitHub rulesets 可用规则：https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/available-rules-for-rulesets
- Rules REST API（必需检查的 `integration_id`）：https://docs.github.com/en/rest/repos/rules
- 受保护分支（含 `require_last_push_approval` 语义）：https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches
- GitHub App 权限：https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app
- Pull request reviews REST API：https://docs.github.com/en/rest/pulls/reviews
- GraphQL `PullRequestReview` 与 `PullRequestReviewThread`：https://docs.github.com/en/graphql/reference/pulls
- `git push --force-with-lease`：https://git-scm.com/docs/git-push

### 14. 审计记录

**第 1 轮（Codex CLI gpt-6-astra，medium，只读，基于 v1）：** 10 个 P1、6 个 P2、2 个 P3。逐条核对代码后全部接受，v2 的处理如下：

| 发现 | 处理 |
|---|---|
| P1 现有发布路径不能修订已有 PR（delivery.ts L373） | §8.7 新增 `publishRevision` 合同 |
| P1 继承分支不能复用工作区（host L66、plumbing `-b`）；分支名不是 Mission id | v2：每轮 `--detach` 新 worktree（v3 改为新本地分支，见第 2 轮）；§3 更正分支命名 |
| P1 `pr_opened → awaiting_decision` 违反终态规则 | §8.3、§8.5 新实体“修订链”，Mission 保持终态 |
| P1 原子消费不保证不变式（同 head 多个 review、崩溃窗口、额度） | §8.3 按（仓库、PR、head）唯一预留，同事务计数与意图；外部轮次与 `repair_cycles` 分开 |
| P1 读后快进推送不是比较并交换 | §8.7 带租约推送 + 祖先检查 + 读回；§8.2/§7 分支 ruleset |
| P1 自主修订的授权未定义 | §8.7 授权绑定与每次写入前复核 |
| P1 App id 与 review 作者 actor id 不是同一命名空间 | §8.4 登记（App id，actor id）对 |
| P1 结论校验漏了 base、schema、有效期 | §8.4 `ReviewObservation` 信封与选择规则；base 变化转人 |
| P1 App 权限不能保证“不合并、不评论、不评审” | §8.1 区分凭证能力与行为限制，S1/S2 实测与越权测试 |
| P1 崩溃恢复无法维持账本不变式；check 发布失败无重试 | §8.7 意图日志与启动对账；check 单独意图可重试；不变式 6 改为对账后成立 |
| P2 “一次 GraphQL 读取”不是快照协议 | §8.4 分页完整、最新有效 review、失败即放弃 |
| P2 检查名称不一致；`osstack/verify` 必需会卡普通 PR | §8.2 统一名称，`osstack/verify` 不设为必需 |
| P2 “批准者=合并者”不违反最后推送批准 | §1、§3 删除该推断，注明推送者未读取 |
| P2 S6 依赖未确认的平台能力 | S2 先做平台探针；S6 写明人工后备 |
| P2 阶段依赖与验收不完整（W13、W14、测试 App） | S5 硬前置 W13；S2 建测试评审 App；§10.3 区分冒烟与 W14 级验收；补充崩溃、并发、1 轮额度、吊销、租约测试 |
| P2 第二部分承诺的交付物在第三部分缺失 | §8.6 预算、§9 SLO 与截止时间、§11 运行手册要点；签名证据明确推迟；额度用完但通过 → `ready_for_human` |
| P3 若干来源描述不准（工作区释放条件、delivery.ts L683、W6） | §3 更正；变异测试改为引用 M8 的做法 |
| P3 观察缺少时间戳与官方引用 | §3 加读取时间；§13 加官方文档链接 |

**第 2 轮（Codex CLI gpt-6-astra，medium，只读，基于 v2）：** 第 1 轮中 10 项判为已解决，8 项部分解决；新增 4 个 P1、2 个 P2。逐条核对代码后全部接受，v3 的处理如下：

| 发现 | 处理 |
|---|---|
| 新 P1 detached worktree 与现有提交/恢复/采纳路径不兼容（plumbing.ts L251–306，ports.ts L140–143），且漏了 `--no-checkout` | §8.7 第 2 步改为每轮新本地分支，完全沿用现有路径；远端分支只作推送目标 |
| 新 P1 链的决定与停住或取消的子 Mission 不衔接 | §8.5 子 Mission 到链状态的对应表；恢复同一子 Mission，终态且停止已证明后才派发；累计轮次上限 2 |
| 新 P1 启动恢复可能推送已取消的工作，且不能处理所有意图类型 | §8.7 第 5 步改为只读回执对账，重试重新走完整栅栏；按意图类型分别对账 |
| 新 P1 发布只比较 base 名称，不比较 base SHA 与 PR 状态 | §8.7 第 4 步意图绑定 base ref 与 SHA、PR 状态与 head 仓库；推送前后都读 |
| 新 P2 结论信封混淆 review 提交与观察时 head，漏了顶层正文 | §8.4 分开 `review_commit` 与 `observed_head`；保存顶层正文；按提交时间归约状态；有效期从提交时间算 |
| 新 P2 Mission 分支平台保证未验证，单个 ruleset 的 bypass 会放过 force-push | §7、§8.1、§10.1、§13 标为拟议未验证；拆成两组规则；S2 探针通过前不开推送 |
| 部分：预留后子 Mission 创建与派发的原子性 | §8.5 预留按 head 唯一，同一 head 只能恢复原子 Mission；子 Mission 的授权、声明与链关联在 §8.7 第 1–2 步内完成（实现细节在 S5 的设计中写出并审计） |
| 部分：分页读取不是同一时刻快照 | §8.4 第 1 条：预留前再读一次，变化即丢弃 |
| 部分：预算只在结束时结算 | §8.6 派发前预留本轮上限并写入子 Mission 规格，由执行器与容器超时强制 |
| 部分：§3 对 delivery.ts L941 的描述 | 已更正为“只接受 head 等于本次候选提交的 PR” |

**第 3 轮（Codex CLI gpt-6-astra，medium，只读，基于 v3 初稿）：** 第 2 轮 6 项新发现中 5 项判为已解决，启动恢复部分解决；新增 2 个 P1，均已核对代码并接受：

| 发现 | 处理 |
|---|---|
| 新 P1 发布栅栏在异步检查之前，而不是紧挨着推送 | §8.7 第 4 步：读 PR 与祖先检查在前，`beforeRemoteMutation`（加链与授权检查）紧挨着推送 |
| 新 P1 现有 `delivering` 重试路径会按新本地分支另开 PR | §8.7 第 6 点：规格带 `publish_target`，runner 每次发布尝试都分派到 `publishRevision`，`ports.publish` 拒绝修订规格；§8.8 runner 行补充 |

第 3 轮之后未再审计；S5 开始前，实现细节设计需再做一次独立审计。

**范围调整（v3 之后）：** 按用户决定，首期只落地零代码部分（Mission PR 识别与事件约定），修订链暂缓。新增“首期落地范围”一节，相关小节和阶段标为暂缓；修订链的设计内容未改。

范围调整后的审计（Codex CLI gpt-6-astra，medium，只读）：3 个 P2、1 个 P3。
- P2：首行正则多了一个反斜杠。核对后不成立：文件中是单个反斜杠，未改。
- P2：事件约定缺少 base 绑定与时效。已在 B 中补上 base SHA 绑定和 24 小时时效，并写明首期摘要只作参考，内循环不消费。
- P2：人工计数不是契约要求的计数器。已写明原子计数随修订链暂缓，`repair_cycles` 不能代替，首期改为 C 第 5 条的人工轮次记录。
- P3：首期生效依赖 §12 的全部决定。已把登记名单拆成单独的 S0a，不依赖其他决定。
