# osstack × Grok Bots 双循环接通：技术开发实施方案与使用说明

日期：2026-11-02。基线：`main` `54e640df`（含 #364 设计、#365 ADR-005）。
输入：《osstack × Grok Bots 打通设计草稿》（PDF，下称“草稿”）、[双循环接通设计 v3](../design/2026-11-01-osstack-grok-bridge.md)（下称“设计”）、[ADR-005 登记名单](../decisions/ADR-005-bridge-identity-registry.md)。

本文把草稿和设计变成可以执行的开发计划：每个阶段写明前置条件、要改的文件、测试、命令和验收标准。第一部分是**使用说明**，阶段 0 合并后即可按它操作。范围以设计为准：阶段 0 现在生效；阶段 1 需用户同意后开工；阶段 2 起需先做设计 §12 的决定；修订链（阶段 4、5）仍按设计**暂缓**，这里只给出开工时的工作分解，不改变暂缓决定。

---

## 0. 总览

### 0.1 草稿步骤、设计阶段与本文阶段的对应

| 本文阶段 | 内容 | 草稿 | 设计 | 改代码 | 开工条件 | 状态 |
|---|---|---|---|---|---|---|
| 阶段 0 | 首期约定上线：Mission PR 识别、事件约定、人工修订、验收演练 | S0、S1 | 首期 A–E、S0a | 否 | ADR-005 已 Accepted | **可执行** |
| 阶段 1 | PR 机器标记、`mission status` 的发布字段 | S2 | 首期 A.4（预留） | 是，小 | 用户同意（§8 决定 1） | 待决定 |
| 阶段 2 | 决定 ADR、ruleset 基线、沙箱仓库、GitHub App 与平台探针 | S0 | S0、S1、S2 | 只有脚本 | 设计 §12 决定 | 待决定 |
| 阶段 3 | 证据：Publisher App 推送、`osstack/verify` check run | — | S3 | 是，中 | 阶段 2 完成 | 待决定 |
| 阶段 4 | 影子对账器、链表与意图日志、回放语料、模型检查 | S3 前半 | S4 | 是，大 | 用户取消暂缓 | **暂缓** |
| 阶段 5 | 同 PR 受控修订 | S3、S4 | S5 | 是，大 | 阶段 4；W13 已合并 | **暂缓** |
| 阶段 6 | Grok Bots 改用 App 身份、`grok/verify-osstack` 必需检查 | S1 的 routine 修改 | S6 | 否（平台侧） | 阶段 2、阶段 3 沙箱验收 | 待决定 |
| 阶段 7 | 主仓库开启 `OSSTACK_BRIDGE=1` 与运行手册 | — | S7 | 文档 | 阶段 5、6 | **暂缓** |
| 不做 | 出站 webhook、bot 合并、Grok Bot 在 osstack 主机执行 CLI | S5、S6、S4 中的“调 CLI” | 推迟项、§7 差异表 | — | 有真实需求再提 | 已否决或推迟 |

草稿与设计的三处主要差异照设计执行：
- Grok Bot 不在 osstack 主机上执行 `mission revise`，修订由人发起（阶段 0）或由 osstack 自己的对账器发起（阶段 5）。
- `pr_opened` 保持终态，修订通过新实体“修订链”完成（设计 §8.3）。
- “全绿”由 GitHub 的必需检查判定，不靠 bot 自律（阶段 2）。

### 0.2 依赖图

```
阶段 0 ──▶ 阶段 1（与阶段 2 互不依赖）

§12 决定 ──▶ 阶段 2 ──▶ 阶段 3 ──▶ 阶段 6 ──────────────┐
                           │                             ▼
                           └──▶ 阶段 4 ──▶ 阶段 5 ──▶ 阶段 7
                                            ▲
                     W13（阶段 5 硬前置）、W14（生产级验收）
```

### 0.3 全局约束（所有阶段）

- 每个 PR 目标分支 `main`，一个 PR 只做一件事；阶段 0–3、6 各一个 PR，阶段 4、5 在解除暂缓后的实现设计里再拆分。osstack 和任何会话都不合并 `main`，由人合并。
- 开发版 CLI 只能对显式的临时 `OSSTACK_HOME` 运行，不能对 `~/.osstack` 或保留 home 运行（AGENTS.md）。
- 临时目录用 `createScratchDir` / `scripts/lib/scratch.mjs`，不直接 `mkdtemp`。
- 新的顶层 import 要先测加载时间（AGENTS.md 性能预算）；桥接相关代码只在 `mission` 命令路径上懒加载。
- 改动 GitHub 仓库设置（ruleset、App 安装、协作者权限）属于对外操作：执行前先停下告诉用户，由仓库管理员执行。

---

## 第一部分　使用说明（阶段 0，现在可用）

阶段 0 不改 osstack，也不改 GitHub 设置。四类角色分别按下面操作。登记的数字 id 以 ADR-005 为准，ADR 变了以 ADR 为准。

### 1. osstack 主机所有者

#### 1.1 一次性准备

1. 在 osstack 主机上安装正式版 `osstack`（按 README 的安装步骤），使用正式的 serving home，不用开发 checkout。
2. 设置守护进程的环境变量。下面列出的变量都必须设置（`contained-mission-rpc.ts` L141–146），缺一个守护进程就不启用 Mission：
   ```bash
   export OSSTACK_ENGINEERING=1 OSSTACK_ATTENTION=1 OSSTACK_CONTAINED_MISSIONS=1
   export OSSTACK_ENGINEERING_AUTH_FILE=<授权文件>             # 主机签发凭证与 scope
   export OSSTACK_CONTAINED_CODEX_BIN=<codex 可执行文件> OSSTACK_CONTAINED_CODEX_HOME=<codex home>
   export OSSTACK_CONTAINED_DOCKER_SOCKET=<docker socket> OSSTACK_CONTAINED_DOCKER_DAEMON_ID=<docker info 的 ID>
   export OSSTACK_CONTAINED_BASE_IMAGE_ID=<固定的基础镜像 ID，sha256:…>
   # 可选：OSSTACK_CONTAINED_CODEX_MODEL、OSSTACK_CONTAINED_CODEX_IDENTITY、OSSTACK_CONTAINED_AUTHOR_NAME/EMAIL
   ```
   基础镜像里必须有你的验证命令要用的解释器（例如 `node`）。授权文件与凭证的格式见[受限 Mission 路径设计](../design/2026-10-31-contained-mission-path.md)。
3. 调用方在 `OSSTACK_ENGINEERING_CREDENTIAL` 中带上凭证。凭证对目标 scope 必须**同时有 read 和 write**：`start` 和 `decide` 需要 write，`status` 和 `decide` 都先检查 read（`engineering-contained-store.ts` L76–78，`contained-mission-host.ts` L90–92）；`cancel` 也先检查 read，再要求 stop 或 write（`contained-mission-host.ts` L84–86）。
4. 守护进程不会自动启动，先在一个终端运行 `osstack serve`。
5. 确认主机 `gh` 登录的是 ADR-005 的 osstack 发布身份：
   ```bash
   gh api user --jq '.login + " " + (.id|tostring)'      # 应输出 gilosbornhello 269190136
   ```
   不是这个身份就不要发布：Grok Bots 不会把这样开出的 PR 认作 Mission PR。

#### 1.2 发起 Mission 并开 PR

```bash
osstack mission start --scope <scope> --repo <仓库路径> --base main \
  --goal "<目标>" --allow '<路径 glob>' --verify-arg node --verify-arg <自包含的检查脚本> \
  --publish-repository osborn-studio/osstack --publish-draft false --json
osstack mission status --mission cm_<id> --json
```

1. 反复运行 `status`，直到 `mission.state` 为 `awaiting_decision`，并且 `events` 中最近一条 `kind` 为 `halted` 的事件，其 `payload`（JSON 字符串，需要先解析）里的 `reason` 是 `publication_pending`（`contained-mission-runner.ts` L89–91、L346–347）。`publication_pending` 是原因，不是状态：
   ```bash
   osstack mission status --mission cm_<id> --json \
     | jq -r '.mission.state, ([.events[] | select(.kind=="halted")] | last | .payload | fromjson | .reason)'
   ```
2. 批准发布，再用 `status` 等到 `mission.state` 为 `pr_opened`：
   ```bash
   osstack mission decide --mission cm_<id> --decision approve_publication --json
   ```
   在 `start` 时加 `--publish-preauthorized` 可以省掉这一步。
3. **草稿 PR：** `--publish-draft` 默认为 `true`（`contained-mission-command.ts` L76），PR 会以草稿打开。上面的命令用了 `--publish-draft false`；如果用了默认值，合并前要由人把 PR 标为 ready（osstack 的发布栅栏不允许 `gh pr ready`）。
4. **验证命令：** 容器里只有候选提交的文件快照，没有 `.git`（`contained-verification.ts` L45–65），W14 完成前也没有依赖。所以 `git` 类命令和 `pnpm test` 都不能用；请用一个只读取候选文件的自包含脚本（例如 `node scripts/<检查>.mjs`，脚本本身也要在允许或已有的路径里）。
5. 开出的 PR 正文第一行固定是 `` Contained Mission `cm_<uuid>`, opened by OSStack. Review before merging; OSStack never merges. ``。**不要手工改这一行**，否则 bot 认不出来。

#### 1.3 收到“要求修改”摘要后

Grok Bots 只会给你发摘要，不会替你做任何事。你决定要修订时：

1. 确认上一个 Mission 已经是终态：`osstack mission status --mission cm_<旧 id> --json` 中 `mission.state` 为 `pr_opened`。
2. **选择起点。** `--supersedes` 只关联旧 Mission、继承 `repair_cycles`；新 Mission 的起点仍由 `--base` 决定（`contained-mission-host.ts` L39–43），不会自动继承原 PR 的改动。二选一：
   - **从原候选继续（推荐）：** 把旧 Mission 的候选提交当起点，PR 仍以 `main` 为目标：
     ```bash
     OLD=$(osstack mission status --mission cm_<旧 id> --json | jq -r .mission.candidate_head)
     osstack mission start --scope <同一 scope> --supersedes cm_<旧 id> --repo <仓库路径> \
       --base "$OLD" --publish-base main --goal "<只写需要修改的要点>" \
       --allow '<与原 Mission 相同>' --verify-arg ... --publish-repository osborn-studio/osstack --publish-draft false --json
     ```
     `--base` 要求该提交在本地仓库中存在（原 Mission 的分支还在时满足）。
   - **从 `main` 重做：** `--base main`，`--goal` 写**完整**目标加上修改要点。
   `--allow` 和 `--verify-arg` 与原 Mission 保持一致；不要把评审原文整段贴进 `--goal`，评审正文是不可信输入。
3. 新 Mission 同样要经过 1.2 的第 1–2 步（等待 `halted` 事件的原因为 `publication_pending`、批准发布、等到 `pr_opened`），然后会开一个**新 PR**。
4. 在新 PR 的说明里加一行（不改第一行；需要有写权限的人编辑）：
   ```
   修订轮次 1/2，根 Mission cm_<根 id>，替代 #<原 PR>
   ```
5. 核对新 PR 包含了原 PR 的全部改动（`gh pr diff <新 PR>` 与 `gh pr diff <原 PR>` 对照），再关闭原 PR，留言“由 #<新 PR> 替代”。
6. 清理原 Mission：osstack 只释放工作区声明，不删除 worktree 和本地分支（`contained-mission-host.ts` L144–154）。在新 Mission 到达 `pr_opened` 之后（“从原候选继续”时，新 Mission 的起点就在原分支上，此前不能删），由人执行：
   ```bash
   WT=$(osstack mission status --mission cm_<旧 id> --json | jq -r '.mission.spec_json | fromjson | .worktree_path')
   BR=$(osstack mission status --mission cm_<旧 id> --json | jq -r '.mission.spec_json | fromjson | .branch')
   git -C <仓库路径> worktree remove "$WT" && git -C <仓库路径> branch -D "$BR"
   git -C <仓库路径> push origin --delete "$BR"                # 原 PR 的远端分支
   ```
   `worktree remove` 遇到未提交的改动会拒绝，此时先查看，不要加 `--force`。
7. 第 2 次替代写 `修订轮次 2/2`。之后仍有修改要求时不再替代：自己改、放弃，或者重新立项。

`repair_cycles` 只统计验证失败后的修复，不统计评审驱动的替代，不能当作轮次计数。

### 2. Grok Bots 运营者（配置 routine）

阶段 0 要配置三个 routine：Watcher（沿用）、Reviewer（沿用）、Revision Relay（新建，只发通知和摘要）。下面的规则与平台无关，每个 routine 都要先实现 2.1 的公共过滤。

**运行身份：** 每个 routine 用哪个 GitHub 账号运行，要在配置里写明。ADR-005 中的 Watcher 账号也是人在使用的评审账号，所以“不自激”只过滤**本 routine 自己产生的动作**（按 routine 的运行记录，或按它写入正文的 `verify-osstack:` 前缀加 routine 自己的账号），不能把这些账号的所有事件都丢掉，否则 Relay 会漏掉 Watcher 的结论。

#### 2.1 公共过滤（每个事件都先过一遍）

```ts
// 参考实现，供 routine 作者对照；不是 osstack 发布的代码。
const PUBLISHER_ID = 269190136;                       // ADR-005 osstack 发布身份
const REVIEWER_IDS = new Set([160148718, 243772068, 317464155, 2900559, 127640032, 292102352]);
const CHECK_APP_ID = 15368;                           // GitHub Actions
// 必须全部存在且成功的具体检查名（.github/workflows/ci.yml 在 main 54e640df 的矩阵）；CI 矩阵变了要同步更新这里和 ADR-005。
const REQUIRED_CHECKS = ["check", "graph-macos-fixtures (22)", "graph-macos-fixtures (24)",
  "graph-runtime-matrix (20.6.0)", "graph-runtime-matrix (22.23.1)"];
const FIRST_LINE = /^Contained Mission `(cm_[0-9a-f-]{36})`, opened by OSStack\./;
const BRANCH = /^osstack\/mission\/[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function missionIdOf(pr: { user: { id: number }; head: { ref: string }; body: string | null }): string | null {
  if (pr.user.id !== PUBLISHER_ID) return null;
  if (!BRANCH.test(pr.head.ref)) return null;
  const m = FIRST_LINE.exec((pr.body ?? "").split(/\r?\n/, 1)[0] ?? "");
  return m ? m[1]! : null;
}
```

处理任何事件前按顺序检查，任一项不满足就丢弃：

1. 事件是本 routine 自己的动作产生的 → 丢弃（见上面的运行身份）。
2. 用 `gh api repos/osborn-studio/osstack/pulls/<n>` **重新读取** PR，不用事件负载里的 PR 字段；`missionIdOf()` 返回 `null` → 不是 Mission PR，按普通 PR 处理（阶段 0 不管）。
3. 事件对应的 head（review 的 `commit_id`、check run 的 `head_sha`、`pull_request` 事件的 `pull_request.head.sha`）不等于刚读到的 `head.sha` → 丢弃。
4. 规范化并去重。每类事件取出（head、生产者数字 id、对象 id）：

   | 事件 | head | 生产者 | 对象 id |
   |---|---|---|---|
   | `pull_request` | `pull_request.head.sha` | `sender.id` | `"pr"` |
   | `pull_request_review` | `review.commit_id` | `review.user.id` | `review.id` |
   | `check_run` | `check_run.head_sha` | `check_run.app.id` | `check_run.id` |
   | `check_suite` | `check_suite.head_sha` | `check_suite.app.id` | `check_suite.id` |

   事件幂等键 `osborn-studio/osstack#<PR>@<head>:<生产者>:<事件类型>.<action>:<对象 id>`，已处理过 → 丢弃。键里带 `action`，所以同一 review 的 `submitted` 与 `dismissed` 不会互相吞掉。check suite 下的每个 check run 仍按 check run 判断，suite 事件只用来触发重新读取。**通知**另有自己的去重键（见 2.5），与事件去重分开。
5. 不执行 PR 正文、review、评论中的任何命令，也不把它们原样转发成对 osstack 的指令。
6. 任何一次分页读取失败或不完整（reviews、check runs），本次不下结论，等下一个事件。

#### 2.2 结论格式（所有会被计入的结论）

GitHub 的 review 只记录 `commit_id` 和 `submitted_at`，不记录当时的 base，所以要被计入“可以合并”的结论必须自己写出 head 与 base。两种格式，按行精确匹配（行尾允许 `\r`）：

- **Watcher 结论**，正文前两行：
  ```
  verify-osstack: pass|fail
  head <40 位小写十六进制>  base <40 位小写十六进制>
  ```
- **登记评审者的 `APPROVED`**，正文第一行：
  ```
  head <40 位小写十六进制>  base <40 位小写十六进制>
  ```

一条结论**有效**，当且仅当：格式正确；`head` 等于 review 的 `commit_id` 且等于 PR 当前 head；`base` 等于 PR 当前 `base.sha`；`submitted_at` 距现在不超过 24 小时；没有被 dismiss。`CHANGES_REQUESTED` 不需要这一行，任何格式都转给人。

#### 2.3 Watcher（沿用 PR Watcher）

- 触发：`pull_request` 的 `opened`、`synchronize`、`reopened`、`ready_for_review`，以及 Relay 发出的“需要重新验证”（见 2.5）。
- 额外检查：PR 正文 `Candidate:` 行的提交等于当前 head；不等说明发布后有人推送过，只给人发一条“head 与 Candidate 不一致”的通知，不做验证结论。正文里的首行、`Candidate:` 行都可以被有写权限的人编辑，它们互相一致也不能证明账本发布过这个 head；有疑问时请持 read scope 的人用 `mission status` 核对。
- 动作：在当前 head 上运行 verify-osstack，结论**以 review 形式**提交（ADR-005：Watcher 结论是 review），正文开头两行：
  格式见 2.2。通过用 `COMMENT`（是否用 `APPROVE` 由人决定）；失败用 `REQUEST_CHANGES`。
- 禁止：在评论或 review 里写可执行命令；合并；编辑 PR。

#### 2.4 Reviewer（沿用 OSborn PR Reviewer）

- review 必须提交在当前 head 上；`APPROVED` 按 2.2 带上 head 与 base 行。
- 要求修改时，把要改的点写在 review 正文和行内评论里；不写命令。

#### 2.5 Revision Relay（新建，阶段 0 只发通知）

**触发：** `pull_request` 的 `synchronize`、`edited`（base 改变）、`ready_for_review`；`pull_request_review` 的 `submitted` 与 `dismissed`；`check_run` 与 `check_suite` 的 `completed`；另加**定时巡检**，每小时对所有打开的 Mission PR 跑一次。base 前移（`main` 上有新提交）和结论过期不会产生上面任何事件，只能靠巡检发现。每次都重新读取全部状态再判断，不依赖事件本身的内容。

**读取：**

```bash
gh api repos/osborn-studio/osstack/pulls/<n>/reviews --paginate \
  --jq '.[] | [(.user.id|tostring), .state, .commit_id, .submitted_at, (.id|tostring), (.body|split("\n")[0:2]|join(" | "))] | @tsv'
gh api repos/osborn-studio/osstack/commits/<head>/check-runs --paginate \
  --jq '.check_runs[] | [.name, (.app.id|tostring), .status, (.conclusion // "")] | @tsv'
```

**归约：**

- **评审者状态：** 只看登记评审者的 review（不含 Watcher 结论，见下条），每人按 `submitted_at` 顺序处理：`CHANGES_REQUESTED` 置为“要求修改”（不论在哪个 head 上，GitHub 也把它当作阻塞，直到被 dismiss 或被同一人的批准取代）；`APPROVED` 置为“批准”，但只有满足 2.2 有效条件时才算**有效批准**；`DISMISSED` 清除状态；`COMMENTED` 不改变状态。
- **Watcher 状态：** 只看正文第一行为 `verify-osstack: pass|fail` 的 review，取**当前 head 上**最后一条未被 dismiss 的。它为 `pass` 且满足 2.2 有效条件，才算“验证通过”；最后一条是 `fail`，或者通过的那条已过期、base 不等，都不算。后来的 `fail` 使之前的 `pass` 失效。
- **检查状态：** `app.id = 15368` 的检查中，`REQUIRED_CHECKS` 的每一个名字都存在，并且全部是 `completed/success`。同名有多条时取 `id` 最大的一条（`Paid DeepSeek semantic smoke` 不计入）。

**动作（每条通知都有自己的去重键）：**

| 条件 | 通知 | 去重键 |
|---|---|---|
| 有登记评审者处于“要求修改” | 给主机所有者发摘要：Mission id、PR 链接、head、base、评审者 login、要点（不超过 10 条，每条一句），以及“如需修订，请按使用说明 1.3 发起替代 Mission”。PR 说明中有 `修订轮次 2/2` 时改为“已达上限，需要人决定” | `summary:<review id>` |
| 没有人处于“要求修改”；至少一个有效批准；Watcher 验证通过；检查全部通过；PR 不是草稿 | 通知人“可以合并（参考）” | `ready:<head>:<base>` |
| 除批准或 Watcher 结论“过期或 base 不等”之外，其余条件都满足 | 通知 Watcher 与人“需要在当前 base 上重新验证/重新批准”，Watcher 收到后重新运行 | `refresh:<head>:<base>` |
| 状态读不完整，或者不能确定 | 不发任何通知 | — |

base 变化后去重键随之变化，所以新 base 上的结论会重新通知。

**禁止：** 在 osstack 主机上运行任何命令；代人发起 Mission；合并；approve。

#### 2.6 allowlist 维护

routine 里的 id 必须与 ADR-005 Accepted 版本一致。ADR 改了，routine 重新配置；从名单移除的账号，从重新配置那一刻起不再计入，过去的摘要不回溯。

### 3. 评审者与 Watcher（ADR-005 中的人账号）

- 只在当前 head 上提交 review；新推送后旧 review 作废（`dismiss_stale_reviews` 已开启），需要重新评审。
- 结论写在 review 里，不要只写普通评论，普通评论不计入。`APPROVED` 正文开头带 2.2 的 head 与 base 行，否则不计入“可以合并”的参考通知（GitHub 本身仍会计入批准）。
- 不要在评论里给 osstack 或 bot 下命令；需要修订就写“要改什么”，由主机所有者决定。
- `linxinlan1980` 目前只有 read 权限：它的 review 可以作为参考，但 GitHub 不计入必需批准，它也不能合并。

### 4. 合并者（`gilberthello`、`Rubebun-Jadeem`）

bot 的“可以合并”只是参考。合并前运行（数字 id 和 review 正文都要看）：

```bash
PR=<号>; R=osborn-studio/osstack
gh pr view $PR --repo $R --json author,headRefName,headRefOid,baseRefName,baseRefOid,isDraft,mergeStateStatus,body \
  --jq '{author:.author.login, branch:.headRefName, head:.headRefOid, baseRef:.baseRefName, base:.baseRefOid, isDraft, mergeStateStatus, first:(.body|split("\n")[0])}'
gh api repos/$R/pulls/$PR --jq '.user.id'
gh api repos/$R/pulls/$PR/reviews --paginate \
  --jq '.[] | [(.user.id|tostring), .user.login, .state, .commit_id, .submitted_at, (.body|split("\n")[0:2]|join(" | "))] | @tsv'
gh api repos/$R/commits/$(gh pr view $PR --repo $R --json headRefOid -q .headRefOid)/check-runs \
  --paginate --jq '.check_runs[] | [.name, (.app.id|tostring), .conclusion] | @tsv'
```

1. `first` 是 Mission 首行；`branch` 以 `osstack/mission/` 开头；PR 作者的数字 id 是 269190136；`baseRef` 是 `main`；`isDraft` 为 `false`。
2. 按 2.5 的归约（就在合并前重新判断，不用 bot 之前的结论）：没有登记评审者处于“要求修改”；至少一个有效批准；Watcher 在当前 head 和当前 base 上验证通过且未过期。
3. `REQUIRED_CHECKS` 的五个检查都存在且成功，`app.id` 为 15368。
4. `mergeStateStatus` 为 `CLEAN`。它只表示 GitHub 的分支保护满足（批准数、会话解决、最后推送批准），不包含上面第 2 条的约定，两者都要满足。`require_last_push_approval` 要求的是**批准者**不是最后推送者，与合并者是谁无关。
5. PR 说明里有 `修订轮次` 行时，确认原 PR 已关闭。

### 5. 停用与回滚

- 停用阶段 0：暂停 Revision Relay；Watcher 和 Reviewer 恢复为对 osstack PR 的原有行为。osstack 侧没有需要回滚的东西。
- 发现 bot 做了约定之外的写操作（合并、编辑 PR、推送、在主机上运行命令）：立即暂停该 routine，保存 routine 的运行日志和 PR 时间线（`gh api repos/osborn-studio/osstack/issues/<PR>/timeline --paginate`），再决定是否继续。

### 6. 阶段 0 验收演练（设计首期 E）

演练分两个独立案例，用两个只改文档的小 Mission。

**案例 A：正常路径（最后合并）**

| 步 | 操作 | 期望 | 怎么检查 |
|---|---|---|---|
| A1 | 主机所有者按 1.2 开 Mission PR（非草稿） | 首行、分支、作者满足 2.1 | 合并者清单第 1 条 |
| A2 | 等 Watcher | 当前 head 上有一条 verify-osstack review，正文含 head 与 base | `reviews` 的 `commit_id` 等于 head |
| A3 | 一位登记评审者提交 `REQUEST_CHANGES` | 主机所有者收到 2.5 的摘要，且只收到一次 | 摘要里的 head 等于当前 head |
| A4 | 重投递 A3 的 review 事件（GitHub webhook 的 Redeliver，或平台自带的重放） | 不产生第二条摘要 | 摘要计数；平台不能重投递时在 §10 记为“未验证” |
| A5 | 主机所有者按 1.3 从原候选继续，发起替代 Mission | 新 PR 带 `修订轮次 1/2` 行，包含原改动；原 PR 关闭 | `gh pr diff` 对照 |
| A6 | 一位登记评审者先 `APPROVED`（带 head、base 行），此时 CI 尚未结束 | 不发“可以合并” | Relay 输出 |
| A6′ | 等待 `main` 前移（或 24 小时）后巡检 | 发“需要重新验证”，Watcher 在新 base 上重跑 | Relay 与 Watcher 输出 |
| A7 | CI 完成且全部成功 | Relay 在 `check_run completed` 时发“可以合并（参考）” | Relay 输出 |
| A8 | 合并者按第 4 节核对后合并 | 合并成功 | 合并记录 |

**案例 B：发布后有人推送（只关闭，不合并）**

| 步 | 操作 | 期望 |
|---|---|---|
| B1 | 开另一个 Mission PR | 同 A1 |
| B2 | 由人手工推送一个提交到该分支 | Watcher 只发“head 与 Candidate 不一致”通知，不做结论；Relay 不发“可以合并” |
| B3 | 关闭该 PR，删除远端分支 | — |

**两个案例结束后：** 对照 routine 的运行日志、主机 shell 历史与 PR 时间线，确认 bot 除 review 和通知外没有写操作，也没有在 osstack 主机上执行命令。PR 时间线只能说明“这个 PR 上发生了什么”，不能证明主机上没有执行命令；拿不到运行日志时，在 §10 记为“未验证”。演练记录（PR 号、时间、每步结果）写进 §10，作为阶段 0 完成的证据。

另外补几个只读检查，用已有 PR 或演练 PR 的数据离线判断 Relay 的规则：缺少一个 matrix 成员（例如只有 `graph-runtime-matrix (22.23.1)`）时不发“可以合并”；两位评审者结论冲突时只发摘要；同一 review 先 `submitted` 后 `dismissed` 时，dismiss 生效；Watcher 先 pass 后 fail 时不算通过。

---

## 第二部分　开发计划

### 阶段 1　PR 机器标记与发布字段（草稿 S2）

**目的：** 让 bot 和人不依赖可读文本就能定位 Mission，并让 `mission status --json` 直接给出 PR 号、URL 和发布的 head，不用翻事件尾部（`status` 只返回最近 50 条事件，每条截断到 2 000 字符，`contained-mission-host.ts` L36）。

**前置：** 用户同意开工（§8 决定 1）。设计首期 A.4 把标记定为“预留，暂不实现”；开工即把它变为实现。

#### 1.1 标记格式

在 `publicationBody()`（`contained-mission-runner.ts` L439–450）的最后追加一行：

```
<!-- osstack:mission v=1 id=cm_<uuid> spec_digest=<64 位十六进制> head=<40 位十六进制> start=<40 位十六进制> -->
```

字段名沿用设计首期 A.4（`id`、`spec_digest`），另加 `head`（候选提交）和 `start`（起点提交）。解析规则（同时写进设计首期 A.4）：

- **逐行解析**，行尾允许 `\r`。只看不在 Markdown 代码块（```` ``` ```` 围起的部分）内的行。
- 以 `<!-- osstack:mission ` 开头的行都算“标记候选”。候选行必须整行匹配
  `^<!-- osstack:mission ((?:[a-z_]+=[^\s=]+ )+)-->$`，否则视为畸形。
- 字段类型：`v` 为 `1`；`id` 匹配 `^cm_[0-9a-f-]{36}$`；`spec_digest` 为 64 位小写十六进制；`head`、`start` 为 40 位小写十六进制。不符即畸形。
- 未知键、重复键、缺少任一必需键：畸形。
- **计数与结果：** 先数候选行（畸形的、`v` 不是 `1` 的都算）。候选行不是恰好一条 → 没有标记。恰好一条：格式正确且 `v=1` → 得到标记；`v` 不是 `1` → 没有标记（版本不识别，不算畸形）；畸形 → 没有标记。
- 标记只用于定位 Mission，不证明来源，也不授权任何动作。PR 正文可以被有写权限的人编辑，`--goal` 的内容也会出现在正文里，伪造的标记会让候选变成多条从而全部失效。使用者必须核对首行中的 Mission id 与标记 `id` 一致；来源有疑问时，由持 read scope 的人用 `mission status` 对账。首期不引入签名。

不放 `evidence_digest` 和轮次：证据摘要包含 PR 号（runner L434），开 PR 之前还不存在；轮次属于修订链，仍暂缓。

`--goal` 可以有多行（`contained-mission-rpc.ts` L17），而且就写在标记前面（runner L444），既能伪造候选行，也能用一个不闭合的 ```` ``` ```` 把真正的标记吞进代码块。所以 `publicationBody()` 改为：先按现有规则截断到 2 000 字符，**再**把 goal 渲染成单行——`\r` 和 `\n` 换成空格，`` ` `` 换成 `'`，`<!--` 换成 `<\!--`。单行的 goal 跟在 `**Goal:** ` 之后，不可能出现在行首，也就不能开代码块或成为候选行。账本里的规格不变，只影响正文显示。

#### 1.2 代码改动

| 文件 | 改动 |
|---|---|
| `packages/cli/src/contained-mission-marker.ts`（新） | `formatMissionMarker(input)`、`parseMissionMarkers(body): { marker?: MissionMarker; candidates: number; malformed: number }`；纯函数，无依赖 |
| `packages/cli/src/contained-mission-runner.ts` | `publicationBody()`：goal 截断后渲染为单行并转义（见上）；末尾追加 `formatMissionMarker({ id, spec_digest: m.spec_digest, head: m.candidate_head, start: spec.start_commit })`；`candidate_head` 为空时抛错（发布前必有候选） |
| `packages/cli/src/contained-mission-host.ts` | `status()` 返回值增加 `publication`（见下），仍按 `readable()` 检查 read scope，整体经过 `redactSecrets` |
| `packages/cli/src/contained-mission-command.ts` | 帮助文本中 `status` 行注明 `--json` 输出含 `publication` |
| `docs/design/2026-11-01-osstack-grok-bridge.md` | 首期 A.4 从“预留”改为“已实现”，附解析规则；本文 §0.1 状态更新 |

`publication` 字段的来源（不改事件格式）：

```ts
type MissionPublication =
  | { kind: "opened"; pr: PrRef; evidence_digest: string; pushed_commit: string; base_head: string | null }
  | { kind: "opened_before_cancel"; pr: PrRef; pushed_commit: string | null; base_head: string | null }
  | { kind: "evidence_missing"; pr: PrRef; evidence_digest: string };
type PrRef = { number: number; url: string; reused: boolean };
// status().publication: MissionPublication | null
```

- `opened`：最后一条 `pr_opened` 事件的 `payload.pr` 与 `payload.evidence_digest`，再取 `evidence_digest` 相同的 `delivery_evidence` 事件的 `head`（即推送的提交）与 `base_head`（runner L417、L423、L433–437）。
- `evidence_missing`：有 `pr_opened`，但找不到摘要相同的 `delivery_evidence`；不抛错。
- `opened_before_cancel`：没有 `pr_opened`，但有 `pr_opened_before_cancel`（runner L420，payload 只有 `pr`，没有摘要）；`pushed_commit` 与 `base_head` 取这条事件之前最后一条 `delivery_evidence`，没有则为 `null`。
- 都没有：`null`。

查询直接按事件种类在账本中查，不受 50 条尾部限制。

#### 1.3 测试（先写，先看到失败）

| 测试文件 | 用例 |
|---|---|
| `contained-mission-marker.test.ts`（新） | 格式化再解析得到同样的值；CRLF 正文可解析；代码块内的标记被忽略；未知键、重复键、缺键、字段长度或字符不对、值含空格或 `-->` 都没有标记；唯一一条 `v=2` → 没有标记；一条有效加一条畸形 → 没有标记；两条有效 → 没有标记 |
| `contained-mission-runner.test.ts` | 发布正文第一行不变（现有断言保留）；最后一行是唯一可解析的标记，字段与 Mission 一致；goal 含换行加 `<!-- osstack:mission … -->`、goal 以不闭合的 ```` ``` ```` 结尾、goal 恰好在截断边界处有 ```` ``` ```` 时，正文里都仍只有一条有效标记 |
| `contained-mission-host.test.ts` | 发布前 `publication` 为 `null`；`opened` 各字段等于端口返回值与 `delivery_evidence`；插入 60 条无关事件后仍正确；取消前已开 PR 时为 `opened_before_cancel`；缺 `delivery_evidence` 时为 `evidence_missing`；没有 read scope 的凭证被拒；字段经过脱敏 |
| 反向实验 | 临时去掉追加标记、去掉 goal 转义、或让 `status` 改读尾部，确认至少一个测试失败，然后恢复 |

#### 1.4 命令与验收

```bash
pnpm --filter @osstack/cli test -- contained-mission      # 迭代时
pnpm build && pnpm typecheck && pnpm test                 # 开 PR 前，全套
node scripts/bench-cli-startup.mjs                        # 新模块只在 mission 路径懒加载，启动预算不变
```

验收：上面全部通过；Codex 只读审查无未处理的 P1；PR 描述附一段测试 home 中 `osstack mission status --json` 的 `publication` 片段（用假端口生成，不触网）。

### 阶段 2　决定、平台基线与身份探针（设计 S0、S1、S2）

**前置：** 设计 §12 的决定 2–5 由用户给出（决定 1“人合并”已由 ADR-005 的合并者名单确定）。

| 任务 | 产出 | 谁做 | 验收 |
|---|---|---|---|
| 2.1 ADR-006 | 身份方案（4 个 App + 测试评审 App）、ruleset 改造、默认额度与预算；取代 ADR-005 中“用户账号”的部分时另起 ADR，不改 ADR-005 原文 | 人决定；会话起草 | ADR 合并 |
| 2.2 ruleset 以代码管理 | 三个文件：`.github/rulesets/main.json`（`REQUIRED_CHECKS` 的五个检查为必需且绑定 `integration_id` 15368、1 个批准、会话解决、最后推送批准、禁止 force-push 与删除）、`mission-writers.json`（`osstack/mission/**` 只允许 App A 更新，App A 为 bypass）、`mission-history.json`（`osstack/mission/**` 禁止 force-push 与删除，**无** bypass）。`scripts/rulesets-check.mjs`：分页列出 `GET /repos/<repo>/rulesets`，再逐个 `GET /repos/<repo>/rulesets/{id}` 取完整内容，规范化后比较 target、conditions、rules、bypass_actors、enforcement；只读，不一致时非零退出 | 会话写文件与脚本；**人**执行创建或更新（对外操作，执行前先停下告诉用户） | 三个 ruleset 读回与文件一致；沙箱中作者自批被拒 |
| 2.3 沙箱仓库 | 一个独立测试仓库，套同一份 ruleset；名字由用户决定 | 人建仓库 | `scripts/rulesets-check.mjs --repo <沙箱>` 通过 |
| 2.4 GitHub App | App A `osstack-publisher`、B `osstack-evidence`、C `grok-pr-watcher`、D `grok-pr-reviewer`、测试评审 App；权限按设计 §8.1；私钥只放主机或平台密钥库，不进仓库 | 人建 App 并安装到沙箱 | 每个 App 的安装 id 记入 ADR-006 |
| 2.5 平台探针 | `scripts/bridge-probe-github.mjs --repo <沙箱>`：逐项尝试并记录结果（JSON），见下表。探针会做破坏性尝试，只允许对 ADR-006 中登记的沙箱仓库运行（白名单，不是只拒绝主仓库名） | 会话写脚本；人提供令牌并运行 | 每项都有记录的结论，回写设计 §12、§13 |

平台探针清单（每项记录“允许 / 被拒 / 错误码”）：

| 编号 | 尝试 | 期望 |
|---|---|---|
| P-1 | App A 令牌：merge PR、发 review、发评论、推送 `main` | 被拒；若有任何一项被允许，在 ADR-006 写明该项只由代码栅栏保证 |
| P-2 | App A 快进推送 `osstack/mission/*` | 允许 |
| P-3 | App A force-push、删除 `osstack/mission/*` | 被拒（第二组规则无 bypass） |
| P-4 | 其他身份推送 `osstack/mission/*` | 被拒 |
| P-5 | 测试评审 App 的 `APPROVE` 是否计入必需批准 | 记录结果；不计入则批准由人完成 |
| P-6 | 测试评审 App 能否解决 review 线程 | 记录结果；不能则由人解决 |
| P-7 | 另一个 App 发名为 `check` 的检查，PR 是否显示满足必需检查 | 不满足 |
| P-8 | App B 推送或评论 | 被拒 |
| P-9 | App A、B 的 App id 与安装 id 是否与 ADR-006 登记一致 | 一致（App id 用于检查归属，安装 id 用于换取令牌，不能混用） |
| P-10 | 三个 ruleset 全部启用时，用现有发布路径（阶段 3 修改前）发布一个 Mission | 被 `delivery.ts` L863–872 拒绝（确认冲突存在）；阶段 3 修改后重跑应成功 |

### 阶段 3　证据与发布身份（设计 S3）

**前置：** 阶段 2 的探针 P-1 至 P-4、P-8 有结论。

**必须先解决的冲突：** 现有发布路径把候选分支上“任何适用的规则”都当作分支保护（`packages/github/src/delivery.ts` L583），并拒绝推送受保护的候选分支（L863–872）；GitHub 对还不存在的分支也会返回适用规则。所以阶段 2 的两个 Mission 分支 ruleset 一旦启用，现有发布就会全部失败。阶段 2 的 ruleset 只能先套在沙箱上，等下表第一行合并后才能套到主仓库。

| 文件 | 改动 | 测试 |
|---|---|---|
| `packages/github/src/delivery.ts` | 只对受限 Mission 的“只开 PR”发布：候选分支的适用规则**全部**来自主机私有配置中登记的 Mission ruleset id（`$OSSTACK_HOME/bridge/rulesets.json`），且规则类型只是写入者限制、禁止 force-push、禁止删除时，不视为受保护；其他情况保持现状。目标仓库、推送 URL、发布栅栏检查都不变 | 三个 ruleset 全部启用时沙箱发布成功；多出一条未登记的 ruleset，或登记的 ruleset 里多出其他规则类型时仍被拒；非 Mission 发布路径行为不变 |
| `packages/cli/src/contained-mission-github-app.ts`（新） | 从主机私有配置（`$OSSTACK_HOME/bridge/apps.json`，不入仓库）读取 App id、安装 id、私钥路径；签 JWT，换取短期安装令牌；令牌只放内存 | 过期刷新；私钥文件权限不是 `0600` 时拒绝；日志里不出现令牌（用 `redactSecrets` 断言） |
| `packages/cli/src/contained-mission-ports.ts` | 推送与开 PR 改用 App A 令牌（通过 git credential helper 注入，不写进 remote URL）；未配置 App 时保持现有主机 `gh` 行为 | 推送 URL 检查（L166–168）仍然生效；配置 App 后 `git remote get-url` 不含令牌 |
| 同上 | 新增 `publishVerifyCheck()`：App B 在候选 head 上发 `osstack/verify`，`external_id = <mission_id>:<head>`；查找键为（head、名称、`app.id` = App B、`external_id`），存在则更新。查找与创建之间有并发窗口，所以同一键出现多条时以 `id` 最小的为准、把其余的更新为 `neutral` 并在摘要中注明重复 | 重试幂等；创建成功但回执丢失后重试不新增；两个并发调用最终只有一条有效；其他 App 的同名 check 被忽略；head 不等于 `candidate_head` 时拒绝 |
| `packages/cli/src/contained-mission-runner.ts` | 开 PR 成功后发 check。Mission 到 `pr_opened` 后已是终态，守护进程的 tick 不会再处理它（`contained-mission-host.ts` L32–34、L118），所以 check 失败时记事件 `verify_check_failed`，并提供人工重试 `osstack mission publish-check --mission <id>`（需 write scope，只重发 check，不碰分支与 PR） | check 端口失败时 Mission 仍到 `pr_opened`，事件被记录；人工重试幂等；对非 `pr_opened` 的 Mission 拒绝 |

验收：沙箱中一个 Mission PR 的作者是 App A，`osstack/verify` 的 `head_sha` 与账本 `candidate_head` 一致；探针 P-1 在接入后重跑结果不变。

### 阶段 4　影子对账器（设计 S4，暂缓）

用户取消暂缓后按下表开工；开工前把实现细节写成设计附录并做一次独立审计（设计 §14 末尾的要求）。

| 任务 | 文件 | 验收 |
|---|---|---|
| 4.1 迁移 | 新文件 `packages/core/src/state/engineering-revision-chain-ddl.ts` 写设计 §8.3 的三张表（与现有 `engineering-contained-ddl.ts` 分开）；`migrations.ts` 追加一条引用它（当前最后一条是 50 `engineering_contained_missions`）；升级测试中的版本号随之更新 | 迁移门禁与升级保持测试通过 |
| 4.2 链存储 | `packages/core/src/state/engineering-revision-chain-store.ts`（新）：链状态机（设计 §8.5）、按（仓库、PR、head）唯一的预留、意图日志；所有转换在事务内 | 单元测试覆盖每条转换与每个停止条件 |
| 4.3 属性测试 | fast-check：随机交错 review、推送、崩溃、外人写入、base 变化 | 设计 §10.2 的每条不变式都有对应的属性，且每类故障都被生成器覆盖；具体次数在解除暂缓后的实现设计中定 |
| 4.4 模型 | `docs/design/specs/bridge.tla` | TLC 无反例 |
| 4.5 读取器 | `packages/cli/src/contained-mission-bridge.ts`（新）：GraphQL 分页读取 PR、reviews、reviewThreads、commits，读不完整就放弃本周期；转成 `ReviewObservation`（设计 §8.4） | 用录制的时间线回放，结果可重复 |
| 4.6 回放语料 | `scripts/record-pr-timeline.mjs`：录制指定 PR 的时间线到 `packages/cli/src/__fixtures__/bridge/`（去掉正文中的个人信息，只保留结构与 id） | 录制 #340–#363 |
| 4.7 影子运行 | `OSSTACK_BRIDGE=shadow`：只记录“会做的动作”事件，不预留、不派发 | 回放无异常；无未登记身份被消费 |

### 阶段 5　同 PR 受控修订（设计 S5，暂缓）

**硬前置：** 阶段 4 完成；W13（主机 git 子进程在守护进程崩溃后存活）已合并；阶段 2 探针 P-2 至 P-4 通过。生产级验收另需 W14。

| 任务 | 文件 | 验收 |
|---|---|---|
| 5.1 授权 | `contained-mission-command.ts` 加 `grant-revisions --mission <root> --rounds 1\|2 --expires <时长>`，只能在交互终端执行并要求输入确认（与 `issue-grant` 相同） | 非 TTY 被拒；`grant` 绑定 principal、client session、scope、仓库与 base |
| 5.2 子 Mission | `contained-mission-host.ts`：每轮新本地分支 `osstack/mission/<新随机 id>`，`start_commit = published_head`，规格继承允许路径、验证命令、保护集合，带 `publish_target` | 允许路径、验证命令、保护集合与根 Mission 完全相同（逐字段断言）；规格摘要会因分支、worktree 路径、`publish_target` 等字段不同而变化，不作断言 |
| 5.3 发布 | `contained-mission-ports.ts` 的 `publishRevision`（设计 §8.7 第 4 步的 7 个子步骤）；`ports.publish` 拒绝带 `publish_target` 的规格 | 租约失败、读回不符、base 变化、PR 关闭都转人 |
| 5.4 栅栏 | `contained-mission-runner.ts`：`beforeRemoteMutation` 加链与授权检查，紧挨着推送；每次发布尝试按 `publish_target` 分派 | 取消子 Mission 后重启，不推送 |
| 5.5 恢复 | 启动时只读回执对账（设计 §8.7 第 5 步） | 推送后、记录前杀进程，重启后按回执完成或转人 |
| 5.6 故障注入与变异 | 设计 §10.3 的故障注入与变异测试 | 每个变异都有测试失败 |
| 5.7 沙箱端到端 | 沙箱中两轮修订后通过；另一条链第 3 次要求修改转人；越权测试 | 时间线与账本一致 |

### 阶段 6　Grok Bots 改用 App 身份（设计 S6）

**前置：** 阶段 2 完成，且阶段 3 已在沙箱验收（Publisher 已是 App A）。阶段 3 未完成时不能切换：否则 PR 作者仍是用户账号，而 ADR-005 已被取代。

平台侧工作，由 Grok Bots 运营者完成：Watcher 改为 App C，对所有 PR 发 `grok/verify-osstack` check run（取代阶段 0 的“结论以 review 形式提交”），并对 Mission PR 检查当前 head 上有 App B 产生的 `osstack/verify` 且为成功；Reviewer 改为 App D。之后由人把 `grok/verify-osstack` 加进 `main` 的必需检查（绑定 App C 的 integration id，改 `.github/rulesets/main.json` 并按 2.2 执行）。若探针 P-5、P-6 显示 App 的 review 不计入批准或不能解决线程，批准与解决仍由人完成，写进运行手册。ADR-005 被新的 ADR 取代。

### 阶段 7　主仓库上线（设计 S7，暂缓）

运行手册 `docs/runbooks/bridge.md` 先合并（关闭开关、吊销 App A、`awaiting_decision` 每种原因的处理），再对单个 scope 开 `OSSTACK_BRIDGE=1`。验收：连续 5 条链无异常，设计 §6 的指标能用 `osstack stats` 读出。

---

## 第三部分　验证、风险与决定

### 7. 每个阶段的验证方式

| 阶段 | 自动化 | 独立证明（设计 §5） |
|---|---|---|
| 0 | 无 | PR 时间线、routine 运行日志、人工演练记录 |
| 1 | 单元测试 + 反向实验 | GitHub-hosted CI 在 PR head 上通过 |
| 2 | `rulesets-check.mjs`、探针脚本 | GitHub 平台拒绝越权调用 |
| 3 | 单元测试、沙箱 PR | check run 的 `head_sha` 与账本对账 |
| 4–5 | 属性测试、模型检查、回放、故障注入、变异 | TLC、沙箱端到端、对账后账本与分支一致 |
| 6–7 | ruleset 读回 | 必需检查由指定 App 产生 |

每个代码阶段的 PR 在开出前都要跑：`pnpm build`、`pnpm typecheck`、全套 `pnpm test`（迭代时可以只跑受影响包）、CLI 启动预算，以及一次 Codex 只读审查；审查结果写进 PR 描述。阶段 0 的独立证明有限：PR 时间线只说明某个 PR 上发生了什么，不能证明主机上没有执行命令，需要 routine 运行日志补充。

### 8. 需要用户做的决定

1. **是否开工阶段 1**（机器标记与 `publication` 字段）。不开工也不影响阶段 0。
2. **设计 §12 的决定 2–5**（App 身份方案、ruleset 改造、默认额度/预算/截止时间；协作者人/bot 已在 ADR-005 中回答）。阶段 2 及之后都等这一项。
3. **沙箱仓库的名字和归属**。
4. **是否取消修订链的暂缓**。不取消时，阶段 4、5、7 不开工，修订一直按使用说明 1.3 由人发起。

### 9. 风险与未确认项

1. Grok Bot 平台的具体能力（事件种类、能否以 GitHub App 身份运行、能否重投递事件）未经核实；阶段 0 的 routine 规则是平台无关的写法，运营者需要按平台实际能力实现，做不到的项写进 §10 记录。
2. 阶段 0 的轮次记录是人写的，可能漏写或写错；bot 只把它当提示。
3. Watcher 结论以 review 提交，而 Reviewer 与 Watcher 是同一批账号（ADR-005 说明），只能靠 review 正文开头的 `verify-osstack:` 区分。
4. base 绑定很严格：`main` 每次前移都会让旧的验证结论失效，Watcher 需要重新运行；PR 多时成本上升。
5. W14 之前，Mission 的验证只能是冒烟级。
6. 使用说明 1.3 的“从原候选继续”（`--base <旧候选提交> --publish-base main`）按代码推断可行，还没有实际跑过；阶段 0 演练 A5 是它的第一次实测，失败时改用“从 `main` 重做”。
7. 设计 §13 列出的平台未确认项（App review 是否计入批准、ruleset 能否把合并限制到人等）由阶段 2 探针回答。

### 10. 记录

**阶段 0 演练：** 待做（按 §6 填写 PR 号、时间与每步结果）。



### 11. 审计记录

**第 1 轮（Codex CLI gpt-6-astra，medium，只读，基线 `54e640df`）：** 8 个 P1、9 个 P2、2 个 P3。逐条核对代码，全部接受：

| 发现 | 处理 |
|---|---|
| P1 发布流程漏了草稿 PR、`publication_pending` 是原因而非状态、替代后需再次批准 | 1.2 第 1–3 步、1.3 第 3 步 |
| P1 `git diff --check` 在容器里不可用（只有文件快照，没有 `.git`） | 1.2 第 4 步改为自包含脚本，并注明镜像要有解释器 |
| P1 `--supersedes` 不继承原 PR 的改动，起点仍由 `--base` 决定 | 1.3 第 2 步：从原候选继续或从 `main` 重做，二选一；第 5 步核对 diff |
| P1 只有 write 不够，`status` 与 `decide` 需要 read | 1.1 第 3 步；1.1 第 2 步列出全部必需变量 |
| P1 Relay 只听 review，会漏掉“先批准后 CI 成功”；未按评审者归约；只要求 `check` 存在 | 2.5 重写：监听 review 与 check 事件，每次重读全部状态，冲突不发（检查完整性在第 2 轮进一步修正） |
| P1 base 与时效只对 Watcher 有要求，review 本身不带 base | 2.2 结论格式；2.5 重新验证提示；2.3 增加触发 |
| P1 合并清单把 `require_last_push_approval` 解释反了；按历史 review 判断会误判 | 第 4 节：按最终状态归约，以 `mergeStateStatus` 为准，查询补 `author`、`headRefName`、`isDraft` |
| P1 验收演练先推送再合并、又要求不合并，自相矛盾 | 第 6 节拆成案例 A（合并）与案例 B（只关闭） |
| P2 `delivery_evidence` 里是 `head` 而不是 `pushed_commit` | 阶段 1.2 字段来源与关联规则；补测试 |
| P2 标记字段名与设计 A.4 不一致，解析边界未定义 | 阶段 1.1 统一为 `spec_digest`，逐行、代码块、类型、计数规则；1.3 补边界测试 |
| P2 正文一致不等于真实性；goal 可带入伪标记 | 阶段 1.1 写明只用于定位；goal 中 `<!--` 转义；2.3 补说明 |
| P2 时间线不能证明主机上没执行命令；Watcher 与评审是同一批账号 | 第 2 节运行身份、第 6 节与第 7 节补 routine 运行日志，拿不到记“未验证” |
| P2 ruleset 只列了 `main`；列表接口不返回完整规则 | 阶段 2.2 三个 ruleset，逐个 GET 比较；探针改为沙箱白名单 |
| P2 阶段 6 少了对阶段 3 的依赖，漏了 `osstack/verify` 检查 | 阶段 6 前置与 Watcher 检查；P-9 区分 App id 与安装 id；依赖图 |
| P2 check 幂等未限定 App、并发未处理、终态后无人重试 | 阶段 3：查找键含 App B，重复收敛规则，`mission publish-check` 人工重试与测试 |
| P2 阶段 5 规格摘要的验收条件不可能成立 | 改为逐字段断言允许路径、验证命令、保护集合 |
| P2 测试门槛低于 AGENTS.md；缺少替代后的清理 | 第 7 节开 PR 前全套 `pnpm test`；1.3 第 5 步清理 |
| P3 迁移 DDL 文件名不对 | 阶段 4.1 新建独立 DDL 文件 |
| P3 过早固定“每阶段一个 PR”和 10 000 次 | §0.3 与阶段 4.3 调整，具体安排留给解除暂缓后的实现设计 |

**第 2 轮（同一模型与设置，基于第 1 轮修订稿）：** 第 1 轮 19 项中 12 项判为已解决、7 项部分解决；新增 2 个 P1、6 个 P2、1 个 P3。第 2 轮还确认“从原候选继续”在代码上可行：发布路径不要求 `start_commit` 在发布 base 上（`contained-mission-ports.ts` L161–180，`delivery.ts` L761–1038），但分类只覆盖从起点以来的改动，不覆盖继承来的部分。逐条核对代码后全部接受：

| 发现 | 处理 |
|---|---|
| P1 阶段 2 的 Mission 分支 ruleset 会让现有发布全部失败（`delivery.ts` L583、L863–872） | 阶段 3 第一行：只放行登记的 Mission ruleset；探针 P-10；ruleset 先只套沙箱 |
| P1 合并清单没有要求 Watcher 通过、base 绑定与时效 | 第 4 节：合并前按 2.5 重新归约，看数字 id 与 review 正文，要求 base 为 `main`；说明 `CLEAN` 不含这些约定 |
| P2 Watcher 格式与 2.2 冲突；历史 pass 仍被计入 | 2.2 两种格式按行定义；2.5 Watcher 取当前 head 上最后一条未 dismiss 的结论，后来的 fail 使 pass 失效 |
| P2 事件去重不含 `action`；`check_suite` 未规范化 | 2.1 第 4 步规范化表，键含 `action`；通知去重单列 |
| P2 base 前移与过期没有事件触发 | 2.5 定时巡检；通知键含 head 与 base；批准与 Watcher 结论都可触发重新验证；演练 A6′ |
| P2 每类至少一个检查不能保证矩阵完整 | `REQUIRED_CHECKS` 改为五个具体名称；演练补“缺一个成员” |
| P2 goal 转义挡不住不闭合的代码块和截断 | 阶段 1.1：截断后渲染为单行；测试补不闭合与截断边界；版本计数规则重写 |
| P2 等待说明写的事件名不存在 | 1.2 第 1 步改为 `halted` 事件的 `payload.reason`，附 jq 命令 |
| P3 `publication` 类型与缺证据行为矛盾；取消前开 PR 的事件没有摘要 | 阶段 1.2 改为带 `kind` 的联合类型，三种情况分别定义 |
| 部分解决：替代后的清理只写了“按现有规则” | 1.3 第 6 步给出 worktree、本地与远端分支的删除命令和时机 |
| 部分解决：`cancel` 也先检查 read | 1.1 第 3 步 |
