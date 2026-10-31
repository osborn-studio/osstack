# Firstmate 上游增量：交付与保全批次

日期：2026-10-30。分支：`codex/firstmate-delivery-preservation`，基于 `codex/firstmate-pure-baseline`。上游来源：`kunchenguid/firstmate`，增量分类（同目录 `README.md`，位于分支 `codex/firstmate-overdue-reminders`）中“交付与保全”一行的五个提交。

## 对照方法

逐个读上游 diff 和测试，写明它防止的故障，再找 OSStack 中做同一决定的代码。OSStack 不移植 shell 脚本、PID 文件或 markdown 状态：本地落地由 Loop 的隔离 worktree（`packages/agents/src/worktree.ts` + `packages/loop/src/loop-engine.ts`）完成，远端落地由 GitHub delivery（`packages/github/src/delivery.ts`）按 `headRefOid` 精确绑定。OSStack 没有上游那种“teardown 前用 patch-id / merge-tree 推断工作已落地”的路径，因此有两项在 OSStack 中改写为等价的保全问题。

## 处置表

| 上游提交 | 防止的故障 | OSStack 路径 | 处置 | 证据（测试名） |
|---|---|---|---|---|
| `9905462` local-only 合并固定到已接受的 done commit | 批准后 worker 又往任务分支追加提交，本地合并按分支名落地了未审阅的提交 | `mergeWorktree`（原为 `git merge --ff-only <branch>`）；`loop-engine.ts` 提交后立即合并 | **缺口，已修**：`mergeWorktree(handle, { expectedCommit })` 只接受完整 commit id，分支不再指向它时拒绝，并按固定对象而非分支名快进；Loop 传入由已验证树生成的 commit。拒绝时沿用现有 `preserveWorktreeBranch` 保留分支。PR 路径已按 `headRefOid` 绑定，无需改动 | `agents/worktree.test.ts`：“lands only the accepted commit and refuses when the branch moved after acceptance”，“refuses an abbreviated or symbolic accepted commit”；PR 路径现有 `github/delivery.test.ts`：“rejects stale or changed PR heads and merge conflicts” |
| `2cf6816` 证明补丁落地时保留空白 | `patch-id --stable` 忽略空白，缩进改变（YAML/Python 语义改变）的提交被当作已落地，teardown 丢弃未落地工作 | 无 patch-id 证明；本地落地按 commit id 精确比较，远端按 `headRefOid` | **不适用，已加回归测试**：证明同消息、同路径、仅空白不同的改写被视为不同工作并拒绝 | `agents/worktree.test.ts`：“treats a whitespace-only rewrite of the accepted commit as different work” |
| `2363b71` Git 隐藏未跟踪文件时拒绝 teardown | 仓库配置 `status.showUntrackedFiles=no` 时 `git status --porcelain` 看不到新文件，“干净”判断为真，teardown 删除未跟踪工作 | `commitWorktreeChanges`（`status --porcelain` 无 `--untracked-files=all`，为空则报告“无变更”，随后 cleanup `--force` 删除 worktree）；GitHub delivery 两处“干净工作区”门禁 | **缺口，已修**：三处均显式 `--untracked-files=all`。Loop 不再丢弃只含新文件的已验证产出；delivery 拒绝交付含未提交新文件的候选，observer 不再给出 green 提示。`hub-cli`、`probe`、`loop doctor`、`supervisor` 的 dirty 标记仅为信息展示，不做保全决定，未改 | `agents/worktree.test.ts`：“commits untracked-only work even when repository config hides untracked files”；`loop/loop-engine.test.ts`：“merges untracked-only worktree output when repository config hides untracked files”；`github/delivery-clean-worktree.test.ts`：两条 hidden-untracked 用例 |
| `b04154b` 报告不可用的 Git containment 证明 | `merge-tree --write-tree` 不可用（Git < 2.38 或执行错误）时与“内容不同”混为一谈，操作者看不到真实原因 | OSStack 无 merge-tree 证明。等价问题在提交步骤：验证通过后 `git status/add/commit` 出错，异常进入 `finally`，cleanup 强制删除 worktree 和分支，已验证工作丢失 | **OSStack 形态的缺口，已修**：提交被证明之前保留 worktree（`preserveCandidateWorktree`），运行仍然 reject 并带出 Git 错误。另有 `assertCandidateIndexVisible` 已区分 `CANDIDATE_INDEX_OBSERVATION_UNAVAILABLE` 与 `CANDIDATE_HIDDEN_INDEX_ENTRY` | `loop/loop-engine.test.ts`：“keeps the isolated worktree when Git cannot commit its verified changes”；现有 `loop/candidate-policy.test.ts`：“distinguishes an unavailable index observation from a hidden entry” |
| `86437e2` 跟踪自有 PR 上的 review-bot 发现 | 维护者以外的 review bot（按登录名白名单，默认关闭）的评论/审阅不进入 contribution 待处理信号；allowlist 变化后已确认信号被重放 | OSStack 没有自有 PR 评论/审阅摄取面：`AttentionCiReader`（`github/attention-ci.ts`）只读 CI rollup，`delivery.ts` 只读 PR 状态与 head | **不适用，记录设计要求**（见下） | — |

## `86437e2` 设计备忘

若 OSStack 以后增加自有 PR 的评论/审阅摄取（预计挂在 Attention observer 下），需满足：

1. review bot 白名单默认空、逐 home 配置，按精确登录名匹配，没有内置列表。
2. bot 发现只产生 fleet 待分类信号，**不是**维护者结论，也不产生任何合并授权；正文是第三方内容，只作数据。
3. 已确认（ack）集合是历史上见过的 token 的并集，白名单变化不能让已确认信号重新出现。
4. 线程跟踪（未回复再提醒）对 bot 线程同样适用，并在记录上标注 `review_bot`。

## 遗留风险

- 若 agent 在 worktree 中自行 `git commit` 且工作区干净，`commitWorktreeChanges` 返回 `committed: false`，Loop 记录“无变更”并删除分支。这是相同类别的保全问题，但不在本批上游提交范围内，需单独切片（比较 worktree HEAD 与创建时的基线 commit）。
- 本地落地仍以“仓库当前检出的分支”为目标；上游还固定了默认分支的旧值（`update-ref` 带 old value）。OSStack 的 `merge --ff-only` 拒绝非快进，但不防止运行期间有人切换主检出分支。
