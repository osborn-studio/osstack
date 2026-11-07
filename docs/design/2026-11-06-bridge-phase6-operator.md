# 阶段 6 运营者规格：Grok Bots 改用 App C / App D 与 `grok/verify-osstack` 必需检查

日期：2026-11-06。基线：`main` `f09d55a6`。代码行号均指这个基线。
上位文档：[双循环接通设计 v3](2026-11-01-osstack-grok-bridge.md)（下称“设计”）§8.1–§8.2、§11 S6、§13；[实施方案](../plans/2026-11-02-osstack-grok-bridge-implementation.md)（下称“方案”）第一部分 §2、阶段 6、§9；[ADR-005](../decisions/ADR-005-bridge-identity-registry.md)；[ADR-006](../decisions/ADR-006-bridge-s0-decisions.md)（决定 2–5，App 登记表，探针 P-5、P-6、P-7，风险 4）；[App E 影子合并者附录](2026-11-06-bridge-shadow-merger.md)（下称“合并者附录”）。

阶段 6 是平台侧工作，由 Grok Bots 运营者完成，osstack 不改代码。本文把方案阶段 6 那一段写成运营者可以照着实现、照着验收的规则：App C 与 App D 处理哪些事件、怎样在不读 osstack 账本的情况下认出 Mission PR、`grok/verify-osstack` 的 check run 合同、App D 的 review 规则、`main-quality` ruleset 的改动（只给出待审 diff，由人执行）、沙箱验收清单、回滚，以及 osstack 需要运营者提供什么。

2026-11-07 运营交接补充：用户已说明既有 Grok Bots 共用云电脑及 `Rubebun-Jadeem` 登录，验证工程师维护原 `verify-osstack` 技能，Watcher 验证并 approve，Merger 合并，Order 管理顺序 labels，CoS 协调。具体增量交接见[既有平台接入交接](../runbooks/bridge-grok-bots-handoff.md)。这些角色事实不证明 App C/D 已迁移，也不替代下列平台能力和运行条件的验收。

---

## 0. 平台未确认项（先读）

方案 §9 风险 1：**Grok Bot 平台的具体能力没有核实过。** 本文的规则与平台无关；下面这些前提本文**假定**成立，但没有人验证过。运营者在沙箱验收（§9）里逐条回答，做不到的写进 §14 的记录，并按右列处理。

| 编号 | 未确认的前提 | 做不到时 |
|---|---|---|
| U-1 | 平台能以 GitHub App 身份运行，即用 App C、App D 的私钥换安装令牌，以 App 身份写入（设计 §13 风险 3） | 阶段 6 不能开始；Watcher 与 Reviewer 保持阶段 0 的用户账号 |
| U-2 | 平台能拿到本文 §5.1、§7.1 列出的事件。六个 App 目前 **webhook 关闭、不订阅任何事件**（ADR-006 决定 3）。事件来源可以是：(a) 所有者为 App C/D 打开 webhook 并指向平台（改 App 设置，由所有者做）；(b) 平台现有的事件源，App 令牌只用来写；(c) 只靠定时巡检 | 只有 (c) 也可以，但巡检间隔就是延迟上限；§6.3 的超时按巡检间隔调整 |
| U-3 | App C 的权限（`checks: write`、`contents: read`、`metadata: read`）够读 PR（`GET pulls/{n}`）、读提交关联的 PR（`GET commits/{sha}/pulls`）和读别的 App 的 check suite 与 check run | 读 PR 不行时，需要所有者给 App C 加 `pull_requests: read`（改 App 权限，安装处要重新批准）；在此之前 App C 不能上线 |
| U-4 | GitHub 会把 **App B 产生的** `check_run` 事件投递给 App C（GitHub 对 App 的 `check_run` 投递范围没有在本仓库实测过） | 用巡检兜底（§5.1 最后一行），这本来就是必需的 |
| U-5 | check run 的状态能被 `PATCH` 双向修改：`completed` 改回 `in_progress`，`success` 与 `failure` 互改；GitHub 的必需检查按改后的状态判断（`in_progress` 时显示未满足） | App C **不能上线**。本文的“先关闭”（§5.2 第 2 步）和撤回（§6.4 第 1 条）都依赖这一项；改为“新建一条”不能替代，因为旧的 `success` 仍在，而同名多条时 GitHub 取哪一条未知（U-6）。V-27 实测 |
| U-6 | 同一提交上，同一个 App 有多条同名 check run 时，GitHub 的必需检查取哪一条（最新创建？最新更新？）**未知** | §6.4 已按“所有同名条目结论一致”设计，取哪一条都一样；V-13 记录实际行为 |
| U-7 | App 的 `REQUEST_CHANGES` 是否阻塞合并；App 之后的 `APPROVE` 是否清除它自己之前的 `CHANGES_REQUESTED`。P-5 只测了 App 的批准，没测这两项 | §7 的规则不变；V-21、V-22 记录结果，写进运行手册 |
| U-8 | 平台能把运行日志交给 osstack 做验收对照（方案 §6 已提出同样要求） | 对应验收项记为“未验证” |
| U-9 | 平台的 Watcher 自身验证（方案 2.3 的“verify-osstack”）在什么环境里运行 PR 代码、是否隔离 | 不在本文范围；运营者写明。PR 代码不可信，必须在没有 App 私钥和令牌的环境里运行 |
| U-10 | 平台能在一次评估里完成本文要求的读取并保证分页完整（读不完整时能识别出来） | 不能识别读取不完整时，App C 不能上线，因为它可能在不完整的数据上给出 `success` |
| U-11 | 平台有**持久状态**并能**按（仓库，head）串行**执行评估：持久的锁、每个 head 的评估代次、已知 check run id 表、创建意图表（§6.4），平台重启后仍在 | App C **不能上线**。没有串行与代次，较早读到“成功”的评估可能晚写入、盖过较新的“失败”；没有已知 id 表，读取失败时撤不回已有的成功（§6.4 第 1、7 条）。还需要带租约的锁、PR→head 表、等待起点表与未决写表（§5.2、§6.3、§6.4 第 3 条）。这一项不能用“最终一致”代替 |

本文的“已实测”只指 ADR-006 的探针 P-1–P-12（2026-11-05，沙箱）和 2026-11-06 本会话对主仓库做的只读查询（§2）。

---

## 1. 范围

| 做（运营者） | 不做 |
|---|---|
| Watcher 改用 App C（`osborn-grok-pr-watcher`，App id 5620065）：对**每个** PR 在当前 head 上发 `grok/verify-osstack` check run（§5、§6），取代阶段 0 的“结论以 review 提交” | 合并；推送；编辑 PR 正文、标题、base |
| 对 Mission PR，`grok/verify-osstack` 只在当前 head 上有 App B 的成功 `osstack/verify` 时才为 `success`（§5.3） | 在 osstack 主机上运行任何命令；读 osstack 账本或持有 osstack 凭证 |
| Reviewer 改用 App D（`osborn-grok-pr-reviewer`，App id 5620078），review 只作参考（§7） | 让 App D 的批准充当计入的批准（P-5：不计入；所有者决定计入的批准由 `gilosbornhello` 给，ADR-006 风险 4） |
| 跑沙箱验收清单（§9），把结果交给 osstack 记录 | 修改任何 ruleset、App 设置、仓库角色（由人做，§8、§10） |

**人做的部分：** 在 `.github/rulesets/main-quality.json` 加上绑定 App C 的必需检查（§8 的 diff，先沙箱、后主仓库），通过 PR 合并文件改动，再由仓库管理员执行；把 App C、D 安装到主仓库（ADR-006 决定 3：除沙箱外的安装由所有者决定）；账号降权（ADR-006 决定 4）。

---

## 2. 前置条件现状（2026-11-06 核对）

| 项 | 现状 | 来源 |
|---|---|---|
| 方案阶段 6 前置：阶段 2 完成、阶段 3 沙箱验收 | 满足。沙箱 PR #13 作者是 `osstack-publisher[bot]`，App B 的 `osstack/verify` 为 success、`head_sha` 一致 | 方案阶段 3 验收记录 |
| App C、App D | 已建，**只装在沙箱**（安装 id 178742326、178742542）；webhook 关闭；私钥在建 App 的会话所在主机上（ADR-006 决定 3），平台还没有 | ADR-006 登记表 |
| 沙箱 ruleset | 四个都在：`main-quality` 26575831、`main-update` 26577634、`mission-writers` 26577637、`mission-history` 26577639 | 本会话 `gh api repos/osborn-studio/osstack-bridge-sandbox/rulesets`（只读） |
| 主仓库 ruleset | **一个都没有**（`GET rulesets` 与 `GET rules/branches/main` 都返回空）。`main` 仍是旧式分支保护：1 个批准、`dismiss_stale_reviews`、`require_last_push_approval`、会话解决、`enforce_admins`，**没有任何必需状态检查** | 本会话 `gh api`（只读），2026-11-06 |
| 主仓库可见性 | public | 同上 |
| 方案写的文件名 | 方案阶段 6 写“改 `.github/rulesets/main.json`”。仓库里没有这个文件；ADR-006 决定 5 把 `main` 拆成两个 ruleset，必需检查在 `main-quality.json`（ADR-006 决定 5 写明 “`main-quality` (plan 2.2's `main.json`)”）。本文改的是 `main-quality.json` | `.github/rulesets/` |

由此得出主仓库的顺序约束：`grok/verify-osstack` 要成为主仓库的必需检查，主仓库得先有 `main-quality`（S1，ADR-006 决定 5，所有者在套用时决定）。在那之前，主仓库上的 App C 只能“发 check 但不必需”（§8.3 第 3 步）。

---

## 3. 身份与公共规则

### 3.1 登记的数字 id

所有比较按数字 id，不看 login（ADR-005）。注意 **App id 与 bot 用户 id 是两个不同的数**：check run 与 check suite 的 `app.id` 是 App id；PR 作者、review 作者、事件 `sender` 是 bot 用户（`<slug>[bot]`）的用户 id。

| 身份 | App id（比较 `app.id`） | bot 用户 id（比较 `user.id`、`sender.id`） | 用在哪里 |
|---|---|---|---|
| App A `osstack-publisher` | 5620012 | 352680398 | Mission PR 作者（§4.1 S-1） |
| App B `osstack-evidence` | 5620053 | 不需要 | `osstack/verify` 的生产者（§5.3） |
| App C `osborn-grok-pr-watcher` | 5620065 | 352681463 | 发 `grok/verify-osstack`；过滤自身事件 |
| App D `osborn-grok-pr-reviewer` | 5620078 | 352681749 | 提交 review；过滤自身事件 |
| GitHub Actions | 15368 | — | 现有五个必需检查 |
| `gilosbornhello` | — | 269190136（User） | 计入的批准（ADR-006 风险 4）；不是 App D 的事 |

公开身份采样：2026-11-07 15:02:19 UTC，通过只读 `gh api users/<slug>%5Bbot%5D --jq '{login,id,type,html_url}'` 核对三条响应。A 返回 `osstack-publisher[bot]` / 352680398，C 返回 `osborn-grok-pr-watcher[bot]` / 352681463，D 返回 `osborn-grok-pr-reviewer[bot]` / 352681749；三者 `type` 均为 `Bot`，分别指向对应 App 的公开页面。上表 App id 列沿用既有 App 登记，不把用户 endpoint 的 `id` 当作 App id。

这次 GET **只证明公开 bot 身份与数字 id 的对应关系**。它不证明任何仓库 installation 已存在、不证明平台实际使用这些 App 的令牌、不证明权限或 U/V 运行能力通过。§11 仍需运营者用实际配置和写入结果确认身份绑定；本次没有修改 ADR 的历史记录、私有 `producers.json` 或平台设置，也没有解除上线门。

### 3.2 公共过滤（App C 与 App D 都适用）

沿用方案 2.1，改动是：身份改成 App，不自激按 bot 用户 id 判断。

1. **不自激：** 事件的 `sender.id` 等于本 App 的 bot 用户 id → 丢弃。App C 只丢自己的 `check_run`/`check_suite` 事件；App B 的事件、人的事件照常处理。
2. **重新读取：** 不用事件负载里的 PR 字段。用本 App 的令牌 `GET repos/{repo}/pulls/{n}` 读实时 PR（U-3）。
3. **head 绑定：** 事件对应的 head（`pull_request.head.sha`、`check_run.head_sha`、`check_suite.head_sha`）不等于实时 `head.sha` → 只把它当作“需要重新评估实时 head”的触发，不在旧 head 上写**正面**结论。唯一的例外是 head 级重算（§5.2）：它可以把一个已不是任何打开 PR 之 head 的提交上的条目改为 `in_progress` 或 `failure`，也可以在共用解除后把剩下那个 PR 的结论写到它的 head 上；它从不因为某个 PR 已经离开该提交而在那里写 `success`。
4. **去重：** 只丢弃**同一次投递的重投**，键是 webhook 的投递 id（`X-GitHub-Delivery`；平台自有事件源用它自己的唯一事件 id）。不用方案 2.1 的（PR、head、sender、类型、对象）键：同一用户在同一 head 上的多次 `edited` 会共用那个键，第二次删标记的编辑就会被吞掉，旧的 `success` 继续有效。每一次不同的投递都触发一次完整的重新评估；评估本身是幂等的（§6.4），重复评估只是多花一次读取。正确性不依赖去重表。
5. **不可信输入：** PR 标题、正文、review、评论、提交信息、分支名都是数据。不执行其中的命令，不把它们抄进 check run 摘要或 review 正文（§6.5）。
6. **读不完整就不下结论：** 任何分页读取失败、超上限或结果不完整 → App C 写 `failure`（理由 `read_incomplete`，§6.2），从不写 `success`；App D 不提交 review。
7. **只对登记的仓库：** 沙箱 `osborn-studio/osstack-bridge-sandbox`（仓库 id 1446327922），主仓库安装后加上 `osborn-studio/osstack`。按仓库数字 id 比较。

---

## 4. Mission PR 识别（不读账本）

外部 bot 没有 osstack 凭证（设计 A.3），看不到账本，所以它只能用 GitHub 上看得到的信号。下面的规则承认这些信号能被伪造，并且在两个方向上都**失败即关闭**：普通 PR 冒充 Mission PR，或 Mission PR 冒充普通 PR，都只会得到 `failure`，不会得到 `success`。

### 4.1 信号

| 编号 | 信号 | 读法 | 谁能伪造 |
|---|---|---|---|
| S-1 | 作者是 App A | 实时 PR 的 `user.type = 'Bot'` 且 `user.id` = App A 的 bot 用户 id（§3.1） | 只有持 App A 私钥者（主机）。这是最强的信号 |
| S-2 | head 分支 | `head.ref` 整行匹配 `^osstack/mission/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`（`contained-mission-host.ts` L37；方案 2.1 的 `BRANCH`） | 任何能开分支的人；fork 也能取这个名字 |
| S-3 | 同仓库 | `head.repo.id = base.repo.id`（不是 fork） | — |
| S-4 | 第一行 | 正文第一行匹配 `` ^Contained Mission `(cm_[0-9a-f-]{36})`, opened by OSStack\. ``（`contained-mission-runner.ts` L471；方案 2.1 的 `FIRST_LINE`），取出 Mission id | 任何能编辑正文的人（有写或 triage 权限），以及开 PR 的人 |
| S-5 | 机器标记 | 按 §4.3 解析，恰好一个合法标记 | 同 S-4 |
| S-6 | 目标分支 | `base.ref = 'main'`（登记的目标分支，与合并者附录 `base_ref` 相同） | 任何能改 PR base 的人 |

### 4.2 分类

```
claimed  = S-1 或 S-2 或 S-4 成立，或正文里至少有一条标记候选行（§4.3 的 candidates ≥ 1）
mission  = S-1 且 S-2 且 S-3 且 S-4 且 S-5 且 S-6
           且 第一行的 Mission id = 标记 id
           且 标记 head = 实时 head.sha
```

| 分类 | 条件 | App C 的处理 |
|---|---|---|
| 普通 PR | `claimed` 不成立 | 只看 Watcher 自身验证（§5.2 验证段） |
| Mission PR | `mission` 成立 | Watcher 自身验证 **且** App B 证据（§5.3） |
| 声称是 Mission 但不合格 | `claimed` 成立而 `mission` 不成立 | `failure`，理由列出哪几条不满足（`mission_claim_invalid:<信号>`）。**不**回退为普通 PR |

为什么“声称”一项就要求全部满足：

- 如果只看 S-1–S-6 全部满足才算 Mission、否则算普通 PR，那么有人把 App A 的 PR 正文里的标记删掉或改坏，这个 PR 就会被当作普通 PR，`grok/verify-osstack` 不再要求 App B 证据。所以只要有任一 Mission 信号，就必须整套成立。
- 反方向：普通 PR 抄一个标记、或起一个 `osstack/mission/` 的分支，S-1 不成立，结果是 `failure`，不会冒充成功。
- 代价：讨论标记的文档 PR 如果把标记行写在代码块外，会被判 `mission_claim_invalid:author`。作者把示例放进代码块即可（§4.3 不看代码块内的行）。这是有意的。

已知限制：阶段 5 的同 PR 修订不更新 PR 正文（同 PR 修订附录 §5.3 末，`ports.ts` L71 禁止 `gh pr edit`），修订推送后标记 `head` 不再等于实时 head，App B 的 `external_id` 也换成子 Mission 的 id。按上面的规则这类 PR 会得到 `failure`（`mission_claim_invalid:marker_head`），方向是安全的，与合并者附录对修订 PR 的处理（`G0.join_ambiguous`）一致。阶段 5 目前没有上线；它上线前需要另定识别规则。

### 4.3 标记解析规则

与 `packages/cli/src/contained-mission-marker.ts` 的 `parseMissionMarkers()`（L25–38）完全一致。平台用别的语言实现时，用该文件的测试 `contained-mission-marker.test.ts` 的输入做对照。

1. 正文按 `\n` 切行，行尾的一个 `\r` 去掉（L27–28）。正文为 `null` 时按空串处理。
2. **代码块：** 行首最多 3 个空格后跟 3 个以上反引号或波浪号，开始一个代码块（L10）；结束行只能是同种字符、长度不短于开始行，后面只允许空格或制表符（L12、L29）。代码块内的行一律跳过。没有闭合的代码块一直延续到正文末尾。
3. **候选行：** 代码块外、以 `<!-- osstack:mission `（含末尾空格，L8）开头的每一行都是候选行，不论格式对不对。
4. **候选行数不是恰好 1 → 没有标记。** 所以伪造一条额外的候选行会让真标记也失效；在 App C 这里结果仍是 `failure`（§4.2：candidates ≥ 1 即 `claimed`）。
5. 唯一的候选行必须整行匹配 `^<!-- osstack:mission ((?:[a-z_]+=[^\s=]+ )+)-->$`（L9）；键恰好是 `v`、`id`、`spec_digest`、`head`、`start` 各一次，不能有未知键或重复键（L46–49）；`v` 必须是 `1`，否则没有标记（L50）。
6. 值格式（L15）：`id` 为 `^cm_[0-9a-f-]{36}$`；`spec_digest` 为 64 位小写十六进制；`head`、`start` 为 40 或 64 位小写十六进制。不符即没有标记。

### 4.4 标记什么也不证明

标记与第一行只用来**定位**：它们在可编辑的正文里，任何能编辑正文的人都能改。App C 不因为标记合法就给出任何正面结论。真正把“这个 head 是 osstack 验证并发布的”与这个 PR 绑在一起的是三样标记以外的东西：

1. **作者是 App A**（S-1）：只有主机持有 App A 私钥。
2. **Mission 分支只能由 App A 写**（`mission-writers` 26577637，探针 P-2–P-4）：在沙箱成立。**主仓库目前没有这个 ruleset**（§2），有写权限的人可以推送到 Mission 分支；这时 head 会变，下一条成立与否就决定结果。
3. **App B 在实时 head 上的成功检查，且 `external_id = <标记 id>:<实时 head>`**（§5.3）：App B 只在账本里的 Mission 到达 `pr_opened`、证据通过后才发（`contained-mission-bridge.ts` L180–186），`external_id` 用的是账本里的 Mission id 与 `candidate_head`（L186）。推一个新 head，就找不到对应的 App B 检查。但这只证明“**正文声称的那个 Mission 在这个提交上有 App B 证据**”，**不**证明这个 Mission 属于这个 PR：App B 的键只有 Mission id 与 head，没有 PR 号（L186）。如果同一提交上已有另一个 Mission 的 App B 成功检查（例如同一提交被两个 Mission 产出，或 App B 为另一个 Mission 发在了这个提交上），有正文编辑权的人把第一行和标记 `id` 一起改成那个 Mission，App C 仍会判为成功；标记里的 `spec_digest`、`start` App C 也只能校验格式。Mission 与 PR 的真正绑定只在账本里（合并者附录 G0–G2），App C 做不到；V-28 覆盖这个情形。

App C 也看不到 G1、G2c 所依赖的账本证据（发布证据、`pushed_commit`），所以 `grok/verify-osstack` 的 `success` **不等于** ADR-006 决定 2 的合并门槛，只是其中“必需检查”一项的输入。合并门槛仍由 App E（影子）与人判断。

**提交级检查不是 PR 身份门槛。** check run 挂在提交上。设想：某提交先作为普通 PR 的 head 得到 `success`，随后有人以同一提交开出一个 Mission PR（或反过来）；在 App C 处理新 PR 的 `opened` 之前，这个提交上已经有一个 `success`，新 PR 的必需检查在这段时间里显示为满足。§5.2 写入段第 2 步（`opened` 时先把该 head 的条目全部改回 `in_progress`）把窗口缩短到事件处理延迟，但不能消除；只靠巡检时窗口最长是巡检间隔。因此：App E 的门槛（G0–G3 从账本出发核对 PR 身份与 App B 证据）和 `gilosbornhello` 的批准不得把 `grok/verify-osstack` 当作“这是合格 Mission PR”的证据；这个残余窗口列入 §13 决定 8，由所有者接受或另加控制后，才在主仓库把它设为必需检查。

---

## 5. App C 事件处理

### 5.1 触发

| 触发 | 动作 |
|---|---|
| `pull_request`：`opened`、`reopened`、`ready_for_review` | 评估实时 head（§5.2） |
| `pull_request`：`synchronize` | 评估新 head **和**该 PR 之前的 head。平台持久记录每个打开 PR 上一次看到的 head（PR→head 表）；事件负载里的 `before` 只作参考，以表为准。旧 head 的重算按 §3.2 第 3 条的例外处理 |
| `pull_request`：`edited` | 评估实时 head。正文改动会改变分类（§4.2），base 改动会改变 S-6；两者都要重新评估。`edited` 不带新提交，所以更新的是同一 head 上已有的 check run（§6.4） |
| `check_suite`：`requested`、`rerequested`（App C 自己的 suite） | 评估该 suite 的 `head_sha` 关联的所有打开 PR |
| `check_run`：`rerequested`（有人在界面上点了 App C 检查的 Re-run） | 同上；**更新**已有的 check run，不新建（§6.4） |
| `check_run`：`completed`，且 `check_run.app.id = 5620053`、`name = 'osstack/verify'`（若平台收得到，U-4） | 评估该 `head_sha` 关联的打开 PR |
| 定时巡检：每 60 分钟（只有巡检这一种事件源时缩短到 10 分钟，U-2）对所有打开的 PR；另对处于“等待 App B”（§6.3）的 PR 按 1、5、15、30 分钟各查一次 | 评估。这是必需的，不是可选的：App B 的事件不一定投递到 App C（U-4），而且平台可能漏事件 |

`closed`：对该 PR 的 head 做一次**head 级重算**（§5.2），因为关闭可能解除共用 head（§6.4 第 5 条）。草稿 PR 也评估（它不能合并，但避免转为就绪时检查缺失）。

评估的单位是**（仓库，head）**，不是 PR：check run 挂在提交上，GitHub 按提交查必需检查。每个触发都先换算成“要重算的 head 集合”，再逐个 head 执行 §5.2。

### 5.2 评估步骤（每个 head）

对 head `H` 的评估分两段：**验证段**不持锁，**写入段**持（仓库，`H`）的租约锁（U-11）。

**验证段（不持锁）：** 在 `H` 上运行平台现有的 verify-osstack（方案 2.3；内容由运营者定义，U-9）。只有它明确通过才算通过；超时（硬上限 50 分钟，由平台强制终止）、出错、被取消都算不通过（`watcher_failed` / `watcher_error` / `watcher_timeout`）。结果按 `H` 持久缓存，因为它只取决于提交内容。验证可以与写入段并行，写入段需要结果而结果还没有时，按“验证中”处理（写 `in_progress`，不写结论）。

**写入段（持锁）：** 锁是带租约的（建议 2 分钟，持有者每 30 秒续约）；持有者崩溃或停顿超过租约，别的执行者（评估或清扫）可以接管。接管时代次加一，所以停顿后醒来的旧持有者在下一次核对代次时就会停下。写入段只做读取与写入，不跑验证，因此正常情况下几秒内完成，不会让清扫长时间等待。进入时把代次加一，记为 `g`；**每一次** GitHub 写请求发出之前都先核对代次仍是 `g`，不是就停止，什么都不再写。

1. **查找：** 按 §6.4 第 2 条列出 `H` 上 App C 的全部条目，并入已知 id 表。查找不完整 → 走 §6.4 第 1 条的撤回路径，结束。
2. **先关闭（屏障）：** 把这些条目逐条 `PATCH` 为 `in_progress`（`Grok verify running`），然后**读回确认**每一条都是 `in_progress`。任一条改不了或读回不是 `in_progress` → 走撤回路径（§6.4 第 1 条），本次评估**不得**写 `success`，结束。只有屏障完整通过，才进入下一步。`opened`、`reopened`、`synchronize` 触发时这一段最先执行，用来缩短“新 PR 继承旧成功”的窗口（§4.4 末）。
3. **列出以 `H` 为 head 的打开 PR：** 完整分页读取 `GET repos/{repo}/pulls?state=open&per_page=100`（最多 30 页；超过 → `read_incomplete`），按实时 `head.sha === H` 精确分组，同时更新 PR→head 表。不用 `commits/{sha}/pulls`：它返回的是“包含该提交”的 PR，包括 head 已经前进的 PR，对已进入默认分支的提交语义也不同。
   - 0 个：所有条目写 `failure`（`no_open_pr`），结束。
   - 多于 1 个：确保每个 PR 都有条目（没有就创建，见第 4 步），所有条目写 `failure`（`head_shared`），结束（§6.4 第 5 条）。
   - 恰好 1 个：记为 PR `n`，继续。
4. **确保条目存在：** PR `n` 在 `H` 上没有条目 → 按 §6.4 第 3 条创建，**创建时一律是 `in_progress`**。这样等待 App B 或验证中的 PR 从一开始就有一条未满足的必需检查，清扫也有对象。
5. 按 §4.2 对 PR `n` 分类。普通 PR：结论只取决于验证段。声称但不合格：`failure`。Mission PR：再做 §5.3。验证段还没有结果、或 App B 尚在等待期（§6.3）：保持 `in_progress`，结束本次（等结果或下次重查）。
6. **写前重读：** 重新做第 3 步（PR 集合与每个 PR 的 head、base ref、正文分类），对 Mission PR 重新做 §5.3，并确认没有未决的写请求（§6.4 第 3 条）。任一项与前面不同 → 不写最终结论，回到第 3 步（最多 3 次，仍不稳定 → 所有条目写 `failure`（`unstable`））。
7. **写最终结论：** 按 §6.2 得到结论，用 `PATCH` 写到 `H` 上 App C 的**全部**条目（含其他 PR 号的旧条目）。写完后再查找一次（§6.4 第 2 条）：发现新条目、或任一条目与结论不同，回到第 2 步。

第 6 步缩小但**不消除**读与写之间的窗口：重读之后、写入之前，正文仍可能被编辑。残余窗口由“每次编辑都会产生一次投递、每次投递都会触发重算（§3.2 第 4 条）、而重算先关闭”收敛；在收敛之前，`H` 上可能短暂保留一个基于旧正文的成功。另外 GitHub 不提供带条件的写入（没有“仅当版本为 X 才改”），所以一个已经发出、迟迟才生效的旧 `PATCH` 仍可能在新结论之后落地；第 7 步的写后查找与下一次重算会把它改回来，但不能保证远端从不出现过期写。这些窗口是提交级必需检查固有的，见 §4.4 末与 §13 决定 8。

### 5.3 App B 证据（只对 Mission PR）

与 `contained-mission-bridge.ts` 的查找（L198–233）以及合并者附录 G3 相同。**不用** `GET commits/{head}/check-runs`：GitHub 文档说明该端点只覆盖该提交最近的 1 000 个 check suite，翻完页也不能证明没有漏掉（这是阶段 3 已修过的问题，见该文件 L198–199 的注释）。

1. `GET repos/{repo}/commits/{head}/check-suites?app_id=5620053&per_page=100&page=<n>`，逐页读到某页少于 100 条为止，**最多 10 页**（L15–16、L204）。超过 → `read_incomplete`。
2. 只保留 `app.id = 5620053` 且 `head_sha = head` 的 suite（L220–222）。
3. 对每个 suite：`GET repos/{repo}/check-suites/{id}/check-runs?check_name=osstack%2Fverify&filter=all&per_page=100&page=<n>`，同样每个 suite 最多 10 页；所有 suite 合计最多 1 000 次请求（L17–18、L213–216）。超过 → `read_incomplete`。
4. 只保留同时满足下列各项的 check run（L227–229）：`app.id = 5620053`；`external_id = <标记 id>:<head>`（标记 id 即 §4.2 已核对与第一行一致的 Mission id）；`head_sha = head`；`id` 为整数。别的 App 发的同名检查一律忽略。
5. 结果：
   - 没有 → `osstack_verify_missing`（§6.3 的等待规则）。
   - 有：取 `id` **最小**的一条（阶段 3 的规则，L243；App B 把其余的改成 `neutral`，L246–251）。它必须 `status = completed` 且 `conclusion = success`；否则 `osstack_verify_not_success:<status>/<conclusion>`。注意被 App B 标为重复的那几条是 `neutral`，**不能**因为看到 `neutral` 就判失败，也不能取它们，只看最小 id 那条。
6. App C 不解析 App B 的 `output.summary`，也不把它抄进自己的摘要；只用上面的结构化字段和 check run id。

### 5.4 head 与 base 的绑定

- **head：** check run 的 `head_sha` 就是评估时的实时 head；新推送产生新 head，旧 head 上的结论自然不再适用（GitHub 按 PR 当前 head 查必需检查）。§5.2 第 6、7 步在写前重读、写后查找并核对代次，缩小（不消除）在过时状态上写成功的窗口。
- **base ref：** Mission PR 必须以 `main` 为目标（S-6）。改 base 不产生新提交，所以 `edited` 触发后**更新同一个 check run**。
- **base SHA：** check run 是提交级的，不能按 base 区分。`main-quality` 的 `strict_required_status_checks_policy` 为 `false`（`.github/rulesets/main-quality.json` L27），GitHub 不要求 PR 基于最新的 `main`。本文的默认做法：**`main` 前移不使已有结论失效**，摘要里写明评估时的 `base.sha`。对 Mission PR，“发布以来 `main` 没动”的要求由 App E 的 G5 负责，不由 App C 负责。这与阶段 0 的“base 前移后旧结论失效”（设计首期 B）不同，列为偏差（§12）和需要决定的事项（§13 决定 2）。

---

## 6. `grok/verify-osstack` check run 合同

### 6.1 字段

| 字段 | 值 |
|---|---|
| `name` | `grok/verify-osstack`（精确，区分大小写；必需检查按这个名字匹配） |
| 生产者 | App C，App id 5620065。必需检查绑定这个 id（§8）；别的 App 发同名检查不满足必需检查（P-7 对现有名字已实测） |
| `head_sha` | 评估时的实时 head |
| `external_id` | `<owner>/<repo>#<PR 号>:<head>`，例如 `osborn-studio/osstack#412:<40 位十六进制>`。仓库名小写 |
| `status` | 只用 `in_progress` 与 `completed` |
| `conclusion` | 只用 `success` 与 `failure`（§6.2） |
| `output.title` | `success` 时 `Grok verify passed`；`failure` 时 `Grok verify failed: <第一个理由码>`；`in_progress` 时 `Grok verify running` |
| `output.summary` | §6.5 |
| `details_url` | 可选：平台运行记录的链接，只有当这个链接不含令牌、不需要凭证也不泄露内部地址时才填 |
| `actions` | 不设（不提供 `requested_action` 按钮） |

**绝不使用 `neutral`、`skipped`。** GitHub 的必需检查把 `success`、`neutral`、`skipped` 都当作通过（合并者附录 §7 因此在 G4 里比 GitHub 更严）。App C 只要写一次 `neutral`，就等于放行。`cancelled`、`timed_out`、`action_required`、`stale` 也不用：它们虽然不算通过，但含义容易被误读，统一写 `failure` 并给出理由码。

### 6.2 结论

`success` 当且仅当以下全部成立；否则 `failure`，理由码按出现顺序列出（码只用下表的固定写法，不带任何来自 PR 的文本）：

| 条件 | 不满足时的理由码 |
|---|---|
| 所有读取完整（§3.2 第 6 条、§5.3） | `read_incomplete:<哪一步>` |
| 本仓库恰好一个打开的 PR 以该提交为 head（§5.2 第 3 步） | `head_shared`、`no_open_pr` |
| 写前重读与前面一致（§5.2 第 6 步） | `unstable` |
| Watcher 自身验证明确通过（§5.2 验证段） | `watcher_failed`、`watcher_error`、`watcher_timeout` |
| 不是“声称但不合格”（§4.2） | `mission_claim_invalid:<author|branch|fork|first_line|marker|marker_id|marker_head|base_ref>` |
| Mission PR：App B 证据成立（§5.3） | `osstack_verify_missing`、`osstack_verify_not_success:<status>/<conclusion>` |

### 6.3 状态与超时

- 评估开始时写 `in_progress`。`in_progress` 不满足必需检查，PR 在此期间不能合并，这是有意的。
- `in_progress` 最长 60 分钟；超过即由平台的定时清扫按已知 id 表（§6.4 第 1 条）写 `failure`（`watcher_timeout`）。清扫与写入段共用（仓库，head）的租约锁；锁的持有者失联时清扫在租约到期后接管（§5.2），所以清扫最多晚一个租约。清扫是独立的定时任务，不依赖任何评估进程存活。
- **等待 App B：** Mission PR 刚开时，App B 的检查可能还没发出（它在开 PR 之后才发，失败时要人工 `osstack mission publish-check` 重试，方案阶段 3）。只差 `osstack_verify_missing` 这一项时，保持 `in_progress`，按 1、5、15、30 分钟重查；30 分钟后仍没有，写 `failure`（`osstack_verify_missing`）。之后每次巡检或事件仍会重新评估，App B 补发后会改为 `success`（§6.4）。
- **截止时间不重置：** 平台按（仓库，PR，head）持久记录第一次进入 `in_progress` 的时间与等待 App B 的起点，60 分钟与 30 分钟都从这个起点算；重查、重启、巡检都不重置它。head 变了才是新的起点。

### 6.4 幂等与重复

一个 PR 的条目由键（仓库，`head_sha`，`name`，`app.id = 5620065`，`external_id`）标识；但**结论按 head 统一**：同一 `head_sha` 上 App C 的所有 `grok/verify-osstack` 条目，不论 `external_id` 指向哪个 PR，始终被写成同一个状态与结论（§5.2 第 7 步）。

1. **已知 id 表（持久，U-11）：** 平台记下自己在每个 head 上创建过或查到过的每个 check run id。读取失败时，靠这张表仍能把已知条目改成 `failure`（`read_incomplete`）；连 `PATCH` 也失败、或表里没有任何条目而查找又失败时，平台立即通知运营者与所有者（“App C 无法撤回结论”），这属于 §10 R-1 的触发条件。
2. **查找：** 与 §5.3 相同的两步：`commits/{head}/check-suites?app_id=5620065`，再逐个 suite 列 `check_name=grok%2Fverify-osstack&filter=all` 的 check run，同样的页数上限；只保留 `app.id = 5620065`、`head_sha = head` 的，并入已知 id 表。超限或失败按第 1 条处理，**不是**“不写”。
3. **创建意图与未决写：** `POST` 只用来创建 `in_progress` 条目，**从不直接创建 `completed`/`success`**；成功只能由之后的 `PATCH` 写出，而那时条目的 id 已知、已过屏障。创建前先在持久表里写下“（键，代次）待创建”，再 `POST repos/{repo}/check-runs`（带 `external_id`），拿到 id 后记入已知 id 表、清掉意图。任何结果不明的写请求（`POST` 或 `PATCH` 超时、连接中断）都记为“未决”；有未决写时本 head 不写 `success`，先查找对账，直到未决项都能在查找结果中解释（找到对应条目且状态符合预期，或超过 10 分钟仍未出现，按丢失处理并保持该 head 不为 `success` 直到下一次完整重算）。回执丢失（超时、崩溃）时，意图仍在：恢复时先查找，找到就并入；找不到不能断定请求没有生效（它可能稍后才完成），所以可以再建，但之后每次查找都会把迟到的那条并进来，按第 4 条统一结论。GitHub 不保证 `external_id` 唯一，所以本文**不承诺**“只有一条”，只承诺**收敛**：同一 head 上所有条目最终结论相同；新建的条目一律是 `in_progress`，有未决写时不写 `success`，所以收敛前出现的 `success` 只可能来自一个已经发出、迟到生效的旧 `PATCH`（§5.2 末），写后查找与下一次重算会把它改掉。
4. **多于一条：** 每一条都 `PATCH` 成同一个状态与结论；同一 `external_id` 有多条时，摘要加一行 `Duplicate of check run <最小 id>`。不像 App B 那样把重复项改成 `neutral`，因为 `neutral` 会通过必需检查（§6.1），而且同名多条时 GitHub 取哪一条未知（U-6）。所有条目结论一致，取哪一条都一样。新发现的迟到条目若是 `success` 而当前结论不是，立即改掉。
5. **同一 head 多个 PR：** §5.2 第 3 步让该 head 上所有条目都是 `failure`（`head_shared`），不论 GitHub 看哪一条。其中一个 PR 关闭或 head 前进后（`closed`、`synchronize` 都触发 head 级重算），剩下那个 PR 的结论写到该 head 的**全部**条目上，包括已关闭 PR 的旧条目，所以不会残留一条 `failure` 或 `success` 与当前结论矛盾。
6. **Re-run（`check_run.rerequested`）：** 对该 head 做 head 级重算，按上面各条更新，不另建。
7. **并发：** 同一（仓库，head）的写入段必须串行（U-11 的租约锁）；每次写入段带代次 `g`，每个写请求发出前核对代次，过期的执行者停止（§5.2）。代次只约束平台自己，约束不了已经发到 GitHub 的请求，见 §5.2 末。平台做不到时 App C 不能上线（U-11）。

### 6.5 摘要内容（不含秘密）

`output.summary` 只允许以下各行（固定顺序，纯文本，总长不超过 4 000 字符，去掉控制字符）：

```
Repository: <owner/repo>
Pull request: #<号>
Head: <40/64 位十六进制>
Base: <base.ref> @ <base.sha>（评估时）
Classification: ordinary | mission | mission_claim_invalid
Mission (claimed by PR body, not verified by this check): <cm_…>        ← 只在 mission / mission_claim_invalid 时
osstack/verify: check run <id> success | missing | <status>/<conclusion> ← 只在 mission 时
Watcher verification: passed | failed | error | timeout
Reasons: <理由码，逗号分隔，或 none>
Evaluated at: <UTC ISO 8601>
This check is advisory input to required checks; it is not merge approval and not ledger evidence.
```

不允许出现：令牌、私钥或私钥路径、安装 id、平台内部地址、环境变量、PR 正文或标题的任何片段、review 或评论文本、分支名以外的用户输入、验证日志原文。Watcher 自身验证失败时，如需附上失败摘要，最多 20 行、每行最多 200 字符，先按 `redactBridge`（`contained-mission-bridge.ts` L49：`redactSecrets` 再加 `gh[pousr]_…` 令牌）的规则脱敏，并去掉控制字符（L132–134）。拿不准是否含秘密的内容一律不写。

---

## 7. App D review 规则

### 7.1 触发

`pull_request` 的 `opened`、`reopened`、`synchronize`、`ready_for_review`；`review_requested`（请求的是 App D 时）。按 §3.2 过滤并重读 PR。草稿 PR 不 review，转为就绪时再 review。

### 7.2 只作参考

- P-5：App 的 `APPROVE` 不计入必需批准。所有者决定 Mission PR 计入的批准由 `gilosbornhello` 读过 PR 后给出（ADR-006 风险 4）。App D 的 review 不是这个批准，也不能被说成“有人批准了”（ADR-006 决定 1）。
- 每条 review 必须带 `commit_id = 实时 head`（`POST pulls/{n}/reviews` 的参数），提交前重读 head，不同就放弃。
- 对普通 PR 与 Mission PR 规则相同。Mission PR 分类（§4.2）只用来在正文里多写一行 Mission id。

### 7.3 review 类型与正文格式

**启用条件：** 下表的 `APPROVE` 与 `REQUEST_CHANGES` 只有在 V-21、V-22 实测（U-7）并记入 §14 之后才启用。在那之前 App D **只发 `COMMENT`**（正文格式相同，第一行仍写 `pass`、`changes` 或 `none`），因为未经实测就发 `REQUEST_CHANGES`，可能留下一个它自己清不掉、只能由用户 dismiss 的阻塞。

| 结论 | review `event` | 正文前两行（按行精确匹配，行尾允许 `\r`） |
|---|---|---|
| 没有要改的 | `APPROVE` | `grok-review: pass` / `head <hex>  base <hex>` |
| 要求修改 | `REQUEST_CHANGES` | `grok-review: changes` / `head <hex>  base <hex>` |
| 无法评审（太大、出错、超时） | `COMMENT` | `grok-review: none` / `head <hex>  base <hex>` |

第二行与方案 2.2 的 head/base 行完全相同（两个十六进制值之间两个空格，`<hex>` 为 40 或 64 位小写十六进制；`base` 是提交时的 `base.sha`）。第三行起是正文：Mission PR 加一行 `Mission (claimed by PR body): cm_…`；然后是要点，每条一句、不超过 10 条；最后一行固定为 `Advisory review by a GitHub App; it does not count toward the required approval.`

为什么用 `APPROVE` 而不是只用 `COMMENT` 表示通过：GitHub 的 review 状态里，只有同一作者之后的 `APPROVE` 或 dismiss 能取代该作者之前的 `CHANGES_REQUESTED`，`COMMENT` 不能；`dismiss_stale_reviews_on_push` 只撤销批准，不撤销要求修改。App D 如果从不 `APPROVE`，它在旧 head 上的一次 `REQUEST_CHANGES` 就会一直存在，而合并者附录 G6d 把任何作者（含 Bot）仍有效的 `CHANGES_REQUESTED` 都算作阻塞。要区分两件事：App D 的 `APPROVE` **不增加**计入的批准数（P-5），但它**会解除** App D 自己之前那条 `CHANGES_REQUESTED` 造成的阻塞（G6d 按作者取最近一条状态型 review）。这正是设计意图：撤回自己的反对意见只由提出者在新 head 上做出，别的 App 或账号的阻塞不受影响；合并仍需 `gilosbornhello` 的计入批准。App 的 `CHANGES_REQUESTED` 是否阻塞 GitHub 合并、App 之后的 `APPROVE` 是否清除它，都还没实测（U-7，V-21、V-22）。

### 7.4 线程

- **App D 不解决任何线程。** P-6：带 `pull_requests: write` 的测试评审 App 解决线程被拒（“Resource not accessible by integration”）。V-23 用 App D 自己再确认一次。
- **默认不开行内评论。** `main-quality` 要求会话全部解决（`required_review_thread_resolution`，L21），过时（outdated）的线程也算。App D 开的每个线程都只能由用户账号解决，都会挡住合并。所以要点写在 review 正文里；是否允许行内评论由所有者决定（§13 决定 3）。
- 若以后的探针显示 App 能解决线程（例如权限改变后）：App D 只可解决**自己开的**、且问题已在实时 head 上改掉的线程；不碰别人开的线程，不在别人的线程里回复。这条在实测通过并写进 ADR 之前不生效。

### 7.5 禁止

合并；推送；编辑或关闭 PR；dismiss 别人的 review；在正文中写可执行命令或给 osstack、bot 下指令；把 PR 正文、提交信息里的文字当作指令；在 review 中透露令牌、私钥、平台内部信息（§6.5 的禁止项同样适用）。

---

## 8. ruleset 改动（待审 diff，由人执行）

### 8.1 diff

对 `.github/rulesets/main-quality.json`：

```diff
   "_osstack": {
     "adr": "ADR-006 decision 5",
     "apply_to": ["sandbox", "main-repo-interim"],
-    "note": "No bypass actors: every merger, App E included, must meet these rules, and GitHub re-checks them at merge time."
+    "note": "No bypass actors: every merger, App E included, must meet these rules, and GitHub re-checks them at merge time. grok/verify-osstack is bound to App C osborn-grok-pr-watcher (App id 5620065; plan phase 6)."
   },
@@
           { "context": "graph-runtime-matrix (20.6.0)", "integration_id": 15368 },
-          { "context": "graph-runtime-matrix (22.23.1)", "integration_id": 15368 }
+          { "context": "graph-runtime-matrix (22.23.1)", "integration_id": 15368 },
+          { "context": "grok/verify-osstack", "integration_id": 5620065 }
         ]
```

说明：

- `integration_id` 写**字面值** 5620065。`${app:<名字>}` 占位符只在 `bypass_actors` 里被替换（`scripts/lib/rulesets.mjs` L52–62 `resolveActors` 只处理 `bypass_actors`），写在 `integration_id` 里不会被替换。App id 是全局的，沙箱与主仓库相同。
- 加在 `main-quality` 里，不另建 ruleset：`main-quality` 没有 bypass（L38），必需检查必须放在无 bypass 的 ruleset 里（合并者附录 G4 `G4.checks_bypassable`）。
- 不改 `strict_required_status_checks_policy`（§5.4、§13 决定 2）。
- 这个文件改动由一个只改该文件的 PR 合并（会话可以起草，由人审）。**合并文件不等于生效**：生效需要管理员按 §8.2 执行。

### 8.2 执行（仓库管理员）

```bash
# 1. 生成请求体（只读，不需要令牌以外的权限）
node scripts/rulesets-check.mjs --print-body main-quality > /tmp/main-quality.body.json   # 或任意临时路径
# 2. 管理员执行（对外写操作；沙箱 ruleset id 26575831）
gh api --method PUT repos/osborn-studio/osstack-bridge-sandbox/rulesets/26575831 --input /tmp/main-quality.body.json
# 3. 读回（只读，需能管理 ruleset 的账号，否则缺 bypass_actors 视为失败）
node scripts/rulesets-check.mjs --repo osborn-studio/osstack-bridge-sandbox --target sandbox --actors <apps.json>
```

主仓库：主仓库目前没有 `main-quality`（§2）。S1 套到主仓库时（所有者决定时间与 `main-update` 名单，ADR-006 决定 5），**必须用不含 `grok/verify-osstack` 的版本**（把 §8.1 合并前的四个 ruleset 文件用 `git show <该提交>:<路径>` 取到一个临时目录，再 `node scripts/rulesets-check.mjs --print-body main-quality --dir <该目录>` 生成请求体），除非下面 §8.3 第 3、5 步与 §13 决定 8 在那时都已完成。否则 App C 尚未在主仓库安装或观察时，所有 PR 都会被挡住。读回用 `--target main-repo-interim`；这时文件与线上不一致是预期的，读回报告的差异只能是这一条检查。

### 8.3 顺序

1. 沙箱：App C、D 由平台以 App 身份运行，**还不是**必需检查；跑 §9 的 V-1–V-17、V-20–V-25。
2. 沙箱：合并 §8.1 的文件改动，管理员按 §8.2 执行并读回；跑 V-18、V-19、V-26。同时更新沙箱 `merger.json` 的 `required_checks`（§11），否则影子合并者对每个 PR 都报 `G4.required_set_drift`。
3. 主仓库：所有者把 App C、D 安装到 `osborn-studio/osstack`；App C 发检查但不必需，至少观察 7 天（§13 决定 4），每天对照 `grok/verify-osstack` 与人的判断。
4. 主仓库：同时满足以下各项后，管理员 `PUT` 含 `grok/verify-osstack` 的版本并读回，主仓库 `merger.json` 同步：`main-quality` 已在主仓库生效（S1）；第 3 步的观察期结束且无未解释的误判；第 5 步的新 ADR 已合并；U-11 已在沙箱实测；§13 决定 8 已由所有者做出。
5. 另起 ADR 取代 ADR-005 的 Watcher、Reviewer 两行与检查生产者表（加 App C 与 `grok/verify-osstack`；方案阶段 6 “ADR-005 被新的 ADR 取代”）。ADR 合并前，routine allowlist 与 ADR 不一致（ADR-005 §3），所以这一步应在第 3 步之前起草、第 4 步之前合并。
6. 账号降权按 ADR-006 决定 4，由所有者在 App C、D 在主仓库正常工作之后决定；本文不规定时间。

---

## 9. 沙箱验收清单（运营者运行）

只在 `osborn-studio/osstack-bridge-sandbox` 上做。Mission PR 用 `scripts/sandbox-bridge-scenario.mjs`（它只能写沙箱，走真实的阶段 3 发布路径，App A 开 PR、App B 发 `osstack/verify`）或方案阶段 3 的验收路径开出；需要 App B 证据缺失或错误时，由持主机 App B 私钥的人在沙箱构造（V-6、V-7）。每项记录：时间、PR 号、head、check run id、实际结果、平台运行日志位置。

| 编号 | 操作 | 期望 |
|---|---|---|
| V-1 | 读回 App C、D 安装令牌的权限 | C：`checks: write`、`contents: read`、`metadata: read`；D：`pull_requests: write`、`metadata: read`（ADR-006 登记表） |
| V-2 | App C 令牌：`GET pulls/{n}`、`GET commits/{sha}/pulls`、`GET commits/{sha}/check-suites?app_id=5620053`、`GET check-suites/{id}/check-runs` | 全部 200（回答 U-3）。任一失败，停止，按 U-3 处理 |
| V-3 | 开一个合格的 Mission PR（App B 成功） | `grok/verify-osstack` 由 App C 产生，`success`，`external_id` 为 `osborn-studio/osstack-bridge-sandbox#<n>:<head>`，摘要符合 §6.5 |
| V-4 | 开 Mission PR，App B 的检查晚 2 分钟才发 | 先 `in_progress`，App B 发出后（事件或 1/5 分钟重查）变为 `success`，仍是同一条 check run（回答 U-4、U-5） |
| V-5 | Mission PR，App B 的检查 30 分钟内都没有 | `failure`（`osstack_verify_missing`）；之后补发，下一次评估改为 `success` |
| V-6 | Mission PR，App B 在该 head 上发一条 `external_id` 为另一个 Mission id 的成功检查 | `failure`（`osstack_verify_missing`） |
| V-7 | Mission PR，App B 在同一键下有两条，最小 id 为 `neutral`、另一条 `success` | `failure`（`osstack_verify_not_success:completed/neutral`）——证明只看最小 id |
| V-8 | `gilosbornhello` 开普通 PR，正文代码块外抄一条合法标记与 Mission 第一行，分支名 `osstack/mission/x` | `failure`（`mission_claim_invalid:author`）；同一正文把标记放进代码块、分支改普通名后为普通 PR |
| V-9 | 合格的 Mission PR 上，有写权限的人编辑正文：删掉标记；另一次改标记 `id`；再一次加第二条候选行 | 每次 `edited` 后同一 check run 改为 `failure`（`mission_claim_invalid:marker` 或 `marker_id`），没有一次回退为普通 PR |
| V-10 | 把 Mission PR 的 base 改为另一个分支 | `failure`（`mission_claim_invalid:base_ref`） |
| V-11 | 先让普通 PR 在提交 `H` 上得到 `success`，再以 `H` 开第二个 PR（另一个分支指向同一提交）；记录第二个 PR 打开到 App C 把 `H` 的条目改为 `in_progress` 之间的时长 | 两个 PR 的条目都为 `failure`（`head_shared`）；关闭一个后，`H` 上**全部**条目（含已关闭 PR 的那条）改为剩下 PR 的结论；记录的时长写进 §13 决定 8 |
| V-12 | 同一投递重投两次；再模拟平台在 `POST check-runs` 返回前崩溃后重启 | 重投不触发第二次评估；崩溃后**收敛**：该 head 上所有条目结论相同，收敛前没有一条是 `success`（§6.4 第 3 条）。不要求只有一条 |
| V-12b | 同一 PR 在同一 head 上连续两次编辑正文：第一次无害，第二次删标记 | 两次投递都触发重算；第二次之后为 `failure`（证明去重不吞事件，§3.2 第 4 条） |
| V-12c | 让 §6.4 第 2 步的查找失败（例如在沙箱里临时撤掉平台对 App C 令牌的网络访问，或在平台侧注入失败） | 已知条目被改为 `failure`（`read_incomplete`）；连 `PATCH` 都失败时，运营者与所有者收到“无法撤回结论”通知 |
| V-12d | 两个评估并发运行在同一 head 上：先启动的那个读到 App B 成功，之后让 App B 的检查变为不成功，再启动第二个；让第一个最后写 | 第一个因代次过期什么都不写；最终结论为 `failure`（U-11） |
| V-13 | 人为在同一键下造出两条 App C 条目（用 App C 令牌直接 `POST` 两次） | 下一次评估把两条改成同一结论；记录 GitHub 必需检查实际取哪一条（回答 U-6） |
| V-14 | 在 App C 的检查上点 Re-run | 更新已有条目，不新增（`check_run.rerequested`） |
| V-15 | 普通 PR，Watcher 自身验证失败（运营者用平台已有的失败用例） | `failure`（`watcher_failed`） |
| V-16 | 平台的 verify 超过 60 分钟 | `failure`（`watcher_timeout`） |
| V-17 | 检查 App C 自己产生的事件 | 被 `sender.id` 过滤，没有自激循环 |
| V-18 | ruleset 生效后：用 App B 令牌在某 PR head 上发一条名为 `grok/verify-osstack`、`success` 的检查，App C 的检查为 `failure` | 必需检查不满足，PR 不能合并（与 P-7 同理） |
| V-19 | ruleset 生效后：一个其余条件都满足的 PR，App C 为 `success` / `failure` / `in_progress` / 缺失 | 只有 `success` 时 `mergeStateStatus` 能到 `CLEAN`；另三种为 `BLOCKED`；可选：用 App E 令牌做 P-11 式的合并尝试，只有 `success` 时成功 |
| V-20 | App C 令牌尝试推送、提交 review、评论 | 推送被拒（`contents: read`）；review、评论被拒（无 `pull_requests` 写权限） |
| V-21 | App D 对一个 PR `REQUEST_CHANGES`，其余条件都满足 | 记录 `reviewDecision` 与能否合并（回答 U-7 前半） |
| V-22 | 推新 head 后 App D 在新 head 上 `APPROVE` | 记录它之前的 `CHANGES_REQUESTED` 是否被取代；再确认 App D 的 `APPROVE` 不计入必需批准（P-5 用 App D 本身复测） |
| V-23 | App D 尝试解决一个线程、推送、合并 | 全部被拒（P-6、设计 §8.1 “用 App D 令牌推送”） |
| V-24 | App D 的 review 正文格式 | 前两行与 §7.3 精确匹配；`commit_id` 等于提交时的 head |
| V-25 | 检查所有 App C 摘要、App D 正文与平台日志 | 搜不到 `gh[pousr]_`、`-----BEGIN`、`x-access-token`、安装 id、私钥路径；没有抄 PR 正文 |
| V-27 | 用 App C 令牌把一条 `completed/success` 改回 `in_progress`，再改为 `failure`，再改为 `success`；每一步看 PR 的必需检查状态 | 每次修改都生效，`in_progress` 与 `failure` 时必需检查未满足（回答 U-5；不通过则停止上线） |
| V-28 | 在提交 `H` 上让 App B 为 Mission X 发成功检查；以 `H` 开 Mission PR 但正文标记写 Mission Y；再把第一行与标记都改成 X；另一次只改 `spec_digest`、`start` | 写 Y 时 `failure`；改成 X 后 App C 判为成功（证明 §4.4 第 3 条的局限，记录在案）；只改 `spec_digest`、`start` 时 App C 不察觉。三种情形都要用 App E 影子记录对照，确认 G2 拒绝 |
| V-29 | 持锁的执行者在写入段中途被杀；另一次让平台验证永不返回 | 租约到期后清扫或新评估接管；验证在 50 分钟被终止，60 分钟内条目为 `failure`；旧执行者恢复后不再写 |
| V-30 | 只开巡检（10 分钟），App B 永不出现 | 条目从 PR 打开起就是 `in_progress`；30 分钟（按持久起点）后为 `failure`，之后巡检不把截止重置回 `in_progress` |
| V-31 | 两个 PR 共用 `H`，其中一个推送到 `H2` | `synchronize` 同时重算 `H` 与 `H2`；`H` 上全部条目改为剩下 PR 的结论，不必等巡检 |
| V-26 | 回滚演练（§10 R-1）：从沙箱 `main-quality` 去掉 `grok/verify-osstack` 再加回 | 每次读回与对应文件版本一致；去掉后 V-19 中 App C 缺失的 PR 不再被挡 |

另外，按方案 §6 的要求：对照平台运行日志与 PR 时间线，确认 App C、D 除 check run 与 review 外没有其他写操作（拿不到日志时记为“未验证”，U-8）。

---

## 10. 回滚

`grok/verify-osstack` 成为必需检查后，App C 停摆会挡住**所有** PR 的合并（不只 Mission PR）。回滚从不通过“让 App C 发 `success`”来做。

| 情况 | 动作 | 谁 |
|---|---|---|
| R-1 App C 停摆、误判、结论不可信，或 App C 报告“无法撤回结论”（§6.4 第 1 条） | 管理员**从当前线上配置出发只删这一项**，不要回放旧文件（旧文件可能连带撤销之后加的其他保护；文件里的 `_osstack` 也不是 API 请求体）：<br>`gh api repos/<repo>/rulesets/<id> \| jq '{name,target,enforcement,conditions,bypass_actors,rules:(.rules\|map(if .type=="required_status_checks" then .parameters.required_status_checks\|=map(select(.context!="grok/verify-osstack")) else . end))}' > body.json`，人看一遍 `body.json`，再 `gh api --method PUT repos/<repo>/rulesets/<id> --input body.json`。读回：`GET rulesets/<id>` 与改前相比只少了这一条。随后提交一个只删这一行的文件 PR，使文件与线上一致；`merger.json` 的 `required_checks` 同步去掉 | 仓库管理员 |
| R-2 App C 或 D 做了约定之外的写操作 | 所有者在 GitHub App 设置里**暂停（suspend）该安装**，立即停止它的写入；保存平台运行日志与 PR 时间线（`gh api repos/<repo>/issues/<PR>/timeline --paginate`）；若 App C 在必需检查里，同时做 R-1 | 所有者 |
| R-3 私钥泄露或疑似泄露 | 所有者在 App 设置里删除该私钥并暂停安装；需要恢复时生成新私钥交给平台密钥库；旧令牌最长 1 小时内失效（安装令牌有效期） | 所有者 |
| R-4 App D 的 `REQUEST_CHANGES` 误挡合并（若 V-21 表明它阻塞） | 有写权限的用户 dismiss 该 review（会留在时间线上）；问题持续则 R-2 暂停 App D | `gilosbornhello` 或所有者 |
| R-5 退回阶段 0 | 按顺序：① 若 `grok/verify-osstack` 已是必需检查，先做 R-1；② 停掉 App C、App D 的 routine（必要时 R-2 暂停安装）；③ 处理遗留：App D 仍有效的 `CHANGES_REQUESTED` 由用户 dismiss，App D 开过的线程由用户解决（App 不能解决，P-6）；④ 再让平台用用户账号运行阶段 0 的 Watcher 与 Reviewer（方案 2.3、2.4）。ADR-006 决定 4 规定账号要等 App 在主仓库正常工作后才降权，在那之前这条退路一直在。账号**已经降权**之后：退路是先恢复所需的仓库角色（所有者操作，ADR-006 决定 4 的清单反向执行），再做 ④；在角色恢复之前，只能做 ①–③，即“没有 Watcher 与 Reviewer、由人工处理” | 运营者；①③ 由管理员或 `gilosbornhello` |

ruleset 改动与 `merger.json` 改动必须一起做或一起回滚：一边有 `grok/verify-osstack`、另一边没有时，影子合并者报 `G4.required_set_drift`，所有决定都是 `refused`（方向安全，但对照数据作废）。

---

## 11. 交接：osstack 与运营者互相需要什么

**运营者需要 osstack 提供：**

| 项 | 值 / 位置 |
|---|---|
| App A 的 bot 用户 id | 352680398；公开 GET 采样时间和证明边界见 §3.1 |
| App C、App D 的 bot 用户 id | C：352681463；D：352681749。对应 App id 分别为 5620065、5620078，两类 id 不混用 |
| App B 的 App id | 5620053 |
| 登记的目标分支 | `main` |
| 标记解析规则与对照测试 | §4.3；`packages/cli/src/contained-mission-marker.ts`、`contained-mission-marker.test.ts` |
| App C、D 的私钥 | 由所有者交到平台密钥库，或在 App 设置里新生成一把只放平台（§13 决定 1）；不经过仓库、聊天或 PR |

**osstack 需要运营者提供：**

| 项 | 用在哪里 |
|---|---|
| 将公开身份与平台实际 installation / 写入身份绑定的证据 | 已知 C bot 用户 id 为 352681463、D 为 352681749。若按 §13 决定 5 登记 D，`producers.json.reviewers` 使用 `{ "actor_id": 352681749, "app_id": 5620078 }`；C 的 bot 用户 id 用于事件识别。`publisher` 使用 A 的 `actor_id: 352680398` 与 `app_id: 5620012`。这些是待核对的配置值，不代表本次已经应用；installation、平台令牌和运行能力仍待实际证据 |
| 确认 `grok/verify-osstack` 的生产者是 App id 5620065 | 两份 `merger.json` 的 `required_checks` 加 `{ "context": "grok/verify-osstack", "app_id": 5620065 }`（App id，不是 bot 用户 id），时间与 §8.3 第 2、4 步相同 |
| 事件来源（U-2 的 a/b/c） | 写进运行手册；决定巡检间隔 |
| Watcher 自身验证的定义与运行环境（U-9） | 写进运行手册 |
| §0 每个 U 项与 §9 每个 V 项的结果 | §14 记录；新 ADR 的依据 |
| 平台运行日志的获取方式（U-8） | 验收对照 |
| 紧急联系人与暂停 routine 的方法 | §10 |

`producers.json` 与 `merger.json` 都是主机私有文件（`$OSSTACK_HOME/bridge/`，不入仓库）；由所有者或在所有者同意下由会话修改。

---

## 12. 与上位文档的偏差

| 上位文档 | 本文 | 原因 |
|---|---|---|
| 方案阶段 6：“改 `.github/rulesets/main.json`” | 改 `main-quality.json` | ADR-006 决定 5 拆成两个 ruleset；必需检查在无 bypass 的 `main-quality` 里（§2、§8.1） |
| 方案阶段 6：Mission PR 检查“当前 head 上有 App B 的 `osstack/verify` 且为成功” | 另加：`external_id = <标记 id>:<head>`、按 suite 查找、取最小 id；以及“声称但不合格”一律失败 | 只看名字和结论时，另一个 Mission 的检查或被改过的标记都能通过（§4.4、§5.3） |
| 设计首期 B：base 前移使旧结论失效 | `main` 前移不使 `grok/verify-osstack` 失效；改 base ref 才重新评估 | check run 是提交级的，`strict=false`；Mission PR 的 base 绑定由 App E G5 负责（§5.4、§13 决定 2） |
| 方案 2.2：`APPROVED` 正文第一行是 head/base 行 | App D 的正文第一行是 `grok-review: …`，第二行才是 head/base 行 | App D 不是计入的评审者；前缀让解析者区分 App D 的参考结论与用户账号的批准（§7.3） |
| 设计 §8.1：App D “解决自己发起的线程（若平台允许）” | 不解决任何线程；默认不开行内评论 | P-6 表明不允许；未解决的线程会挡住合并（§7.4） |
| 合并者附录 G3、阶段 3：App B 把重复项改为 `neutral` | App C 把重复项改成与主条目相同的结论 | `grok/verify-osstack` 是必需检查，`neutral` 会放行（§6.4） |
| 方案阶段 6：“对所有 PR 发”（隐含按 PR 评估） | 按（仓库，head）评估，结论写到该 head 上 App C 的全部条目 | 必需检查按提交判断；按 PR 各写各的，会让一个 PR 的成功放行另一个 PR（§5.1 末、§6.4） |
| 方案 2.1 第 4 条的事件幂等键 | 按投递 id 去重 | 原键会吞掉同一 head 上的后续正文编辑（§3.2 第 4 条） |

---

## 13. 需要用户做的决定

1. **App C、D 的私钥放在哪里**：沿用会话建 App 时生成的那把（从主机移交平台密钥库），还是在 App 设置里为平台新生成一把、主机上的旧钥删除。建议后者，这样主机上不留 C、D 的私钥。
2. **`main` 前移是否要让 `grok/verify-osstack` 失效**（§5.4）。默认否；选“是”则 App C 在每次 `main` 前移后对所有打开 PR 重跑，成本随 PR 数增加（方案 §9 风险 4）。
3. **App D 是否允许行内评论**（§7.4）。默认否；允许则每条行内评论都要 `gilosbornhello` 手动解决才能合并。
4. **主仓库“发检查但不必需”的观察期**（§8.3 第 3 步）：建议 7 天，或连续 20 个 PR 无误判，以先到者为准。
5. **App D 是否进入 `producers.json` 的 `reviewers`**（§11）：进入后，阶段 4 影子对账器会把 App D 的 `REQUEST_CHANGES` 当作修订输入记录；不进入则只记录用户账号的 review。
6. **何时把 App C、D 安装到主仓库**（ADR-006 决定 3：沙箱以外的安装由所有者决定）。
7. **取代 ADR-005 的新 ADR**（§8.3 第 5 步）由谁起草、何时合并。
8. **提交级必需检查的残余窗口**（§4.4 末、§5.2 末）：同一提交被另一个 PR 复用时，新 PR 在 App C 处理之前可能短暂显示 `grok/verify-osstack` 满足；正文编辑与重算之间也有同样的短窗口。可选：接受为风险（合并仍要 `gilosbornhello` 的批准，Mission PR 另有 App E 的账本门槛）；或要求平台以 webhook 事件源运行（U-2 的 a）以把窗口压到秒级；或不把它设为主仓库必需检查。V-11 实测的时长作为依据。

---

## 14. 审计记录

平台实测记录（§0 的 U 项与 §9 的 V 项）：待运营者在沙箱验收后填写。

**第 1 轮（Codex CLI gpt-6-astra，medium，只读，基于初稿）：** 5 个 P1、7 个 P2，无 P3。逐条对照初稿与引用的代码核对后全部接受：

| 发现 | 核对 | 处理 |
|---|---|---|
| P1 方案 2.1 的事件幂等键让同一 head 上的第二次 `edited`（删标记）被丢弃，旧 `success` 留着 | 属实：键里没有投递 id，两次编辑同键 | §3.2 第 4 条改为按投递 id 去重，每次投递都重算；V-12b |
| P1 §5.2 先写结论（第 6 步）再“写前重读”（第 7 步） | 属实，顺序写反 | §5.2 重写：先关闭（全部条目 `in_progress`），重读在任何最终写入之前；删去“保证”的说法，写明残余窗口 |
| P1 并发兜底只说“最终一致”：早读到成功的评估晚写入，会盖过较新的失败 | 属实：重读只比 head 与正文，不比 App B 状态 | 新增 U-11（持久锁、代次、已知 id 表），做不到不能上线；§5.2 第 5、6 步核对代次；V-12d |
| P1 查找失败时“不写”，已有 `success` 留着，与“读不完整从不 success”矛盾 | 属实（初稿 §6.4 第 1 条） | 已知 id 表；失败时把已知条目改为 `failure`，改不了就通知并触发 R-1；V-12c |
| P1 同一提交被新 PR 复用时，新 PR 在处理前继承旧 `success` | 属实：check run 是提交级的，这个窗口无法在 App C 内消除 | §4.4 末写明“不是 PR 身份门槛”、App E 与批准者不得依赖它；`opened` 时先关闭以缩短窗口；§13 决定 8；V-11 记录时长 |
| P2 `commits/{sha}/pulls` 返回“包含该提交”的 PR，不等于“以它为 head” | 属实（GitHub 文档） | 改为完整分页列出打开 PR，按 `head.sha` 精确分组 |
| P2 按 `external_id` 隔离，关闭共用 head 的 PR 后其 `failure` 条目残留，结论不一致 | 属实 | 评估单位改为（仓库，head），结论写到该 head 的全部条目，`closed` 也触发重算；§12 加偏差 |
| P2 崩溃后“只有一条”没有依据，`external_id` 不保证唯一 | 属实（GitHub 文档未保证） | 创建意图表；只承诺收敛且收敛前无 `success`；V-12 改验收敛 |
| P2 S1 套主仓库时允许直接带上新检查，可能早于安装和观察期 | 属实 | §8.2：S1 必须用不含它的版本，除非 §8.3 第 3、5 步与决定 8 已完成；§8.3 第 4 步列全前置 |
| P2 回放整份旧文件会连带撤销后加的保护；文件含 `_osstack` 不是请求体 | 属实（`rulesets.mjs` L64–68 `applyBody` 才去掉 `_osstack`） | R-1 改为从线上配置用 `jq` 只删这一项，读回比较改前改后 |
| P2 退回阶段 0 没有顺序：必需检查仍在，App D 的要求修改与线程仍在；降权后无路径 | 属实 | R-5 写成四步顺序，补“已降权”时的路径 |
| P2 App D 的 `APPROVE`/`REQUEST_CHANGES` 依赖未实测的 U-7，且“没有放行作用”说法不对：它会解除 G6d 的阻塞 | 属实（合并者附录 G6d 按作者取最近一条） | §7.3 加启用条件：V-21、V-22 实测前只发 `COMMENT`；改写为“不增加批准数，但解除自己的阻塞” |

**第 2 轮（Codex CLI gpt-6-astra，medium，只读，基于第 1 轮修订稿）：** 第 1 轮 12 项中 7 项判为已解决（其中“新 PR 继承旧成功”判为“作为残余风险记录，并未消除”），5 项部分解决；新增 3 个 P1、4 个 P2，无 P3。逐条核对后全部接受：

| 发现 | 核对 | 处理 |
|---|---|---|
| P1 评估持锁跑外部验证，验证挂起或进程崩溃时清扫拿不到锁，“最多 60 分钟”不成立 | 属实 | §5.2 拆成不持锁的验证段（硬上限 50 分钟）与持租约锁的写入段（2 分钟租约、续约、到期接管、代次加一）；每个写请求前核对代次；清扫是独立定时任务；V-29 |
| P1 创建意图挡不住迟到的成功：超时的 `POST` 可能在新失败之后落地，已发出的 `PATCH` 也不受本地代次约束 | 属实；GitHub 没有带条件的写入 | `POST` 只创建 `in_progress`；结果不明的写记为未决，有未决写不写 `success`；写后再查找；§5.2 末写明远端过期写无法完全排除 |
| P1 “先关闭”不是屏障：逐条 `PATCH` 部分失败会留下旧 `success`，却没有规定中止 | 属实 | 写入段第 2 步改为“全部改为 `in_progress` 并读回确认”，任一失败走撤回路径且本次不得写 `success`；删去无条件的“从这一刻起没有成功” |
| 部分 / P2 等待 App B 时可能还没有条目（只在写最终结论时才创建）；截止时间每次重查都会重置 | 属实 | 写入段第 4 步在评估开始就创建 `in_progress` 条目；§6.3 按（仓库，PR，head）持久记录起点，不重置；V-30 |
| 部分 / P2 `synchronize` 只评估新 head，旧共用 head 上的 `head_shared` 要等巡检；与“不写旧 head”的公共规则冲突 | 属实 | 持久 PR→head 表；`synchronize` 同时重算新旧 head；§3.2 第 3 条写明 head 级重算是唯一例外且从不在旧 head 写因 PR 离开而得的 `success`；V-31 |
| P2 U-5 只覆盖结论互改，没覆盖“先关闭”需要的 `completed → in_progress`；“改为新建”的退路与协议不兼容 | 属实 | U-5 扩为双向修改并作为上线前置，删去“改为新建”的退路；V-27 |
| P2 §4.4 称“改标记 id 就找不到 App B 检查”不成立：App B 的键没有 PR 号，同一提交上另一 Mission 的成功检查可以被换绑；`spec_digest`、`start` 只校验格式 | 属实（`contained-mission-bridge.ts` L186） | §4.4 第 3 条改为“只证明声称的 Mission 在该提交上有证据，不证明它属于该 PR”，绑定只在账本（App E G0–G2）；V-28 |
| 附注：`integration_id` 字面值、`resolveActors`/`applyBody`、`merger.json` 同步、R-1 的 `jq`、R-5 的顺序、P-5/P-6 的一致性 | 审计判为无问题 | 不改 |

协调会话要求在第 2 轮后停止审计。第 2 轮的修订（§5.2 的两段式协议、§6.3 的持久起点、§6.4 第 3 条、V-27–V-31）没有再经过独立审计；运营者实现前，建议对平台侧实现做一次独立审查，重点是租约接管与未决写对账。
