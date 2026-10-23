# 一次授权到 PR：Claude Fable 5.1 对抗评审

2026-09-09。两次实际调用 `claude-fable-5-1`，两次返回 `is_error=false`，`modelUsage` 均包含该模型（另有辅助 Haiku 用量）。输入为新写的通用设计，工具与 slash commands 关闭，空 MCP、临时目录、无会话持久化；未传送私有源码或仓库配置。这是设计挑战，不是模型完成了代码审计或在线验收。

## 处理结论

- 采纳重建后验证：保存补丁 → 检查重建路径、blob 内容及普通文件模式 → tree → commit → 干净 checkout 重跑全部 gate → 远端 HEAD。两个验证阶段都必须通过。
- 第一轮指出环境继承风险，第二轮后又收紧初次 verifier：PR 模式显式替换环境变量，两轮均使用私有 HOME，并禁用 Git 系统及全局配置。没有 OS 级权限或网络隔离；受信任命令仍可读取同用户有权限访问的文件。
- 澄清审查绑定：现有 runner 在调用 reviewer 前保存完整补丁（包括新增与二进制文件），之后再次捕获并核对不变。交付消费这一保存产物，不消费 Builder 的最新 index。
- 接受按 proposal 去重与不确定状态保留占用；没有按相似内容跨任务去重。SQLite 事务中的检查和写入不会让两个写入者都成功；不采用“超时释放占用”。
- 采纳基线和 PR 身份检查；查询回执确认 open/draft、仓库 ID、base ref/SHA、head ref/SHA。检查与外部写入不是原子事务；期间基线前移可能留下待核实的草稿 PR，不能报告成功。
- 空预期 lease 只允许创建不存在的分支，不覆盖既有分支；Git 文档支持这一用法。Fable 提议“已有相同 SHA 也必须报失败”过严：无更新时 Git 可能报告 up-to-date，因此只能承诺不覆盖，不能承诺每种已有 ref 都返回非零。执行账本自身阻止重试。
- 不接受把候选验证成功直接当作自改进有效。模型运行身份仍是配置来源，不冒充服务端证明。调用上限为 adapter invocation，费用未知。
- 临时 Git worktree 的 detached HEAD 保留 commit；重建根目录持久记录以便排查。尚无自动清理或恢复。

## 证据边界

真实本地 Git + 模拟 GitHub 覆盖成功、响应丢失、基线漂移、已存在分支、错误回执、停止及干净重建失败。完整 CLI 测试从 draft 开始，预览后只确认一次到模拟草稿 PR。没有把 fixture 当作真实 GitHub/provider 试点。后续真实试点仍是计划检查点 A 的必要条件。

参考：[Git push 官方文档](https://git-scm.com/docs/git-push)、[GitHub 创建 PR 官方接口](https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request)。

## 第 1 轮输入

请挑战原创通用设计，无私有源码/审计，不声称看过仓库。首版一次授权到草稿PR：可信本地操作员前台CLI，预览绑定任务定义、GitHub不可变repoID/规范名称、基线SHA、精确允许路径、独立验证命令、Builder/Evaluator模型配置、各一次调用和阶段时限。一次--yes+预览摘要批准draft提案并原子claim执行和PR交付账本；不等同签名后台委托，现有no-tools阶段继续权限不能进入此路。没有自动重试/merge/release。
执行生成候选，验证保存的patch及文件hash。交付从固定base在新的私有bare仓库重建index和commit；不提交builder旧index，不重新生成代码，不运行候选hooks/filters。交付进程持有GitHub写权限，builder workspace-write且不获得这些额外凭据；这是明确的可信本地仓库模式，不宣称OS级恶意worker隔离。远端通过GitHub API验证ID和base SHA，再推唯一分支并创建draft PR；远端base漂移不重base。
账本先记录push_dispatched，再发一次push；确认ref匹配才到pushed。先记录pr_dispatched，再发一次PR创建；按repoID/headRepoID/headSHA/baseRef/draft核对才delivered。响应丢失保持原dispatched及error，只读对账，不盲目重发。重复execution ID只返回历史不再运行；即使重启后仍然不会重新生成候选或重复PR。stop同时覆盖构建和候选已验证后的交付，未dispatch不再发，已dispatch可完成但保留核实状态；不承诺撤回外部效果。
请给5个最关键可证伪失败测试，并挑战信任边界、审批摘要漂移、重复/并发执行及精确patch→commit绑定。不要为了上线删除必须边界；不要将本地前台产品假装后台委托。中文约1000字。
## 第 1 轮原始回复

以下仅基于所述设计推理，未看过任何仓库或审计结果；所有判断是逻辑推演，非实测证据。

## 信任边界的挑战

**边界1：交付进程的"重建"是否真的与builder隔离。** 设计说交付从固定base在私有bare仓库重建index，不用builder旧index、不跑hooks。但patch本身是builder产出，若patch包含符号链接、`.gitattributes`（filter/smudge）、`.gitmodules`或指向允许路径外的相对路径，"精确允许路径"检查若只按patch头文件名匹配，仍可能被绕过。允许路径必须在apply后对结果树逐条目验证（含类型、模式位、链接目标），而非只看diff头。

**边界2：验证命令在哪里跑、信任谁。** "独立验证命令"若在builder的workspace执行，builder可篡改环境（PATH、node_modules、测试文件在允许路径内）。验证若不在重建后的干净树上跑，等于验证了一个与交付物不同的东西。设计未说明验证发生在重建树还是builder树。

**边界3：hash绑定的对象。** "文件hash"若指patch文件或工作区文件，与最终commit的tree SHA不是同一对象。真正的绑定应是：预览摘要 → patch hash → 重建后tree SHA → commit SHA → 远端headSHA，每一步在账本落地且链式引用。

## 审批摘要漂移

--yes批准的是"预览摘要"，执行的是"任务定义+配置"。若摘要是任务定义的投影，则任何未投影的字段（模型配置、时限、验证命令的环境变量、base SHA的解析结果）都可能在批准后与执行不一致。特别是：摘要中的repoID/规范名称若在批准时未与GitHub API当场核对，"规范名称"可能因转移/重命名与ID不一致，用户批准了名称，执行按ID推。要求摘要包含全部影响外部效果的字段的hash，claim时比对。

## 重复/并发执行

"重复execution ID只返回历史"依赖ID由谁生成：若客户端生成，两个前台会话可用不同ID对同一任务定义各自claim，产生两个PR。去重键应是任务定义+base SHA的内容hash，而非调用方ID。原子claim若实现为"先读后写"而非CAS，重启窗口内仍可能双claim。

## 5个可证伪失败测试

1. **摘要漂移**：批准后、claim前修改任务定义中未出现在摘要里的字段（如验证命令环境变量）。预期：claim拒绝。若执行，设计失败。
2. **路径逃逸**：patch在允许路径内新增符号链接指向`../secrets`，或新增`.gitattributes`声明filter。预期：交付拒绝。若commit包含该条目，失败。
3. **patch→commit不一致**：在验证通过后、交付重建前，改动builder工作区中被patch触及的文件。预期：交付使用保存的patch，commit tree SHA与账本预记录值一致，与工作区无关。若commit反映工作区改动，失败。
4. **push响应丢失**：在push_dispatched记录后注入网络超时（实际push已到达远端）。预期：账本停在dispatched+error，对账后转pushed，且第二次不产生新分支或force push。若出现重复push或状态未记录，失败。
5. **并发claim**：两进程同时用同一任务定义（不同或相同execution ID）触发。预期：恰好一个claim成功，另一个返回历史或拒绝。若产生两个PR，失败。

## 不应删除的边界

停止时"已dispatch可完成但保留核实状态"和"不承诺撤回外部效果"是诚实的；不要为了UX改成"stop即回滚"。"远端base漂移不重base"应保留——静默重base等于未经批准的第二次执行。此设计是可信本地操作员前台工具：交付进程与builder同机同用户，凭据隔离靠进程约定而非OS强制，这一点应在文档中明示，不能借"account ledger"字样暗示等同已签名后台委托的审计强度。

## 第 2 轮输入

Challenge this revised generic design; no source code or private repository data is supplied. This is a trusted local operator foreground workflow, not hostile-worker OS isolation or signed daemon delegation. One preview digest binds proposal, immutable repository ID, canonical name, base branch+SHA, allowed paths, configured builder/reviewer, commands, timeouts, and one draft PR endpoint. A transaction approves a draft proposal, claims the execution ID and delivery intent. The same proposal cannot have another nonblocked delivery (including after successful delivery). Different proposal IDs are not globally deduplicated by patch content because intent may differ. One builder, one reviewer, no automatic retry. Cost unknown; invocation counts are not model API counts.
After candidate verification, capture immutable patch+file hashes; reconstruct in a fresh private Git repository from the exact authorized remote base, apply to index, inspect resulting changed paths and regular-file modes, bind patch hash -> tree SHA -> commit SHA. Run the original deterministic commands again in clean checkout and check no tracked/untracked mutations (conventional ignored caches permitted). No automatic dependency install: commands must work in clean checkout or fail closed. Initial candidate commands use legacy local environment; clean replay uses filtered environment/private HOME. Neither is a hostile same-user sandbox.
Persist preparation path, commit binding and dispatch state before external calls. Push uses --force-with-lease=refs/heads/unique-branch: so it only creates an absent ref, cannot overwrite. Check repo identity and exact remote base before push and PR creation. PR must be open draft, same repo IDs, base ref+SHA and head ref+SHA. Lost responses are reconciled using GETs only; no write retry/resume. Uncertain verification or dispatch retains an occupied workflow, requiring future explicit recovery. Stop prevents next dispatch but does not undo dispatched effects; read-only reconciliation still allowed. No merge/release. Future base movement after PR is observed remains subject to normal GitHub protections.
Our response to your first challenge: accepted clean replay and post-apply tree inspection; kept per-proposal dedupe instead of globally forbidding similar legitimate tasks. Tests use real local Git and simulated GitHub, not a live-provider claim. Identify remaining critical correctness gaps and necessary tests, especially race windows and authority-vs-evidence. Keep response concise and distinguish design reasoning from empirical evidence.

## 第 2 轮原始回复

# Review of the revised design

**Evidence status:** I have no code, logs, or test output. Everything below is design reasoning against your description. Where I cite GitHub behavior, that is general knowledge, not something verified against your system or the current API.

## Remaining critical gaps

**1. Reviewer verdict is not bound to the shipped tree (authority vs evidence).**
Hashes are captured "after candidate verification," but nothing states the reviewer's approval references a specific patch hash/tree SHA. If the workspace can change between review and capture (builder cleanup, formatter run by verification commands, reviewer with write access), you ship something the reviewer did not approve. Bind verdict → patch hash → tree SHA, and refuse dispatch if the capture hash differs from the reviewed hash.

**2. Patch capture may not equal candidate workspace.**
Plain `git diff` omits untracked files and, without `--binary`, binaries. The reconstructed tree can silently differ from what was built/tested. Additionally compare blob hashes of every changed path in the candidate workspace to the reconstructed tree; mismatch → refuse.

**3. Tree inspection is under-specified.**
"Regular-file modes" must mean: reject any entry not 100644/100755, i.e. symlinks (120000), gitlinks (160000), and exec-bit changes unless explicitly allowed. Also reject: any path component `.git`; `.gitmodules`/`.gitattributes`/workflow files unless in allowed paths; non-NFC or control-character bytes (this is macOS: NFD/NFC and case-insensitive collisions can make two tree entries land on one file). Allowed-path matching must be byte-exact on the tree diff vs base, never on patch headers or the filesystem.

**4. Empty/no-op result.** If reconstructed tree == base tree, PR creation fails (422) after a branch already exists → occupied state for a trivial cause. Refuse before push.

**5. Command determinism is assumed, not enforced.** Filtered env does not block network; a command may fetch external state. Mutation check must be derived from a fresh `write-tree` after commands (not just `status`), with `--untracked-files=all`, and compared to the bound tree SHA. Strip all `GIT_*` vars; note system gitconfig (`/etc/gitconfig`, Homebrew path) still applies despite private HOME — set `commit.gpgsign=false`, explicit author/committer, and `GIT_CONFIG_NOSYSTEM` if you want the replay actually hermetic.

**6. Which run is authoritative?** State explicitly: clean replay is the gate; legacy-env results are advisory. Timeout values in replay should be the bound ones; timeout → uncertain, not fail.

**7. Race windows**
- *Approval vs edit:* the approving transaction must recompute the preview digest from stored proposal content and compare; otherwise an edit between preview and approve is approved under a stale digest.
- *Concurrent operator processes:* per-proposal dedupe needs a partial unique index (`proposal_id WHERE state != blocked`) inside the same transaction that claims the execution ID; two foreground CLIs must not both win.
- *Base check → push → PR create:* not atomic. PR API takes a base *ref*, not SHA; verify `base.sha` and `head.sha` from the create response equal bound values, else occupied. Accept that a drifted draft PR now exists.
- *Push succeeded, PR not created (crash/stop):* branch exists, no PR. Define whether stop between the two writes is allowed; it yields an occupied delivery either way.
- *Recovery → blocked:* a delivery may only become "blocked" (and thus permit a second delivery for the same proposal) after GET confirms neither the unique branch nor any PR with that head exists. Otherwise recovery produces duplicate PRs.
- *Repo identity:* API GET follows rename redirects; compare returned `id` and reject if `full_name` ≠ canonical name. The git push itself is URL-based and not ID-checked; the window is small but real if names are recycled. After push, GET the branch by repo ID and confirm SHA.

**8. Object retention.** After commit-and-persist, create a local ref in the private repo pointing at the commit so nothing prunes it before push/reconciliation.

**9. Runtime identity.** The digest binds configured builder/reviewer *names*; record actual runtime identifiers (model IDs, git version) as evidence and refuse on mismatch with the bound config.

## Necessary tests

*Real local git (can be empirical):*
- `--force-with-lease=refs/heads/x:` creates when absent, fails when present with any SHA, including a second push of the identical commit.
- Patch with symlink, gitlink, mode flip, rename into/out of allowed paths, `..`-like and NFD paths, `.git/` component, binary file, untracked new file → each rejected or correctly included.
- Case-collision tree checked out on the default darwin FS → mutation detected.
- Command that writes a tracked file, an untracked file, an ignored cache, and a file under `.git/` → first two fail, third passes, fourth is at least visible.
- Fetch-by-SHA base whose branch has moved → fails closed.

*Simulated GitHub:*
- Lost push response with (a) ref = our SHA, (b) ref absent, (c) ref = foreign SHA.
- Lost PR-create response with PR present / absent / present-but-not-draft / base.sha drifted.
- Rename redirect (same ID), and same name with different ID.
- 403 secondary-rate-limit and 422 (already exists, no diff, draft unavailable) → classified as uncertain vs failed correctly.
- Concurrent approval of one proposal; edit-after-preview; recovery attempting to mark blocked while a branch exists.

*Cannot be established by your test suite (needs live evidence):* GitHub's actual force-with-lease semantics, `base.sha` semantics at create time, read-after-write consistency between push and API GET, draft-PR plan availability. Treat these as assumptions and document them as such.
