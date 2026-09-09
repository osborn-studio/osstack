# 一次授权到草稿 PR：可信本地前台模式

2026-09-09，基于已合并的 #219。新增 `osstack improve deliver`，把提案批准、候选构建、独立评审、确定性验证与草稿 PR 交付串成一次本地操作员确认。支持现有低风险 docs/test/eval 提案；不能修改受保护路径、工作流、权限或依赖清单。

## 使用

先确保注册仓库有至少一条验证命令，提案也有验收门，profile 配置了独立 Builder 和 Evaluator，GitHub CLI 已登录且对目标仓库有写权限。`origin` 必须使用 github.com HTTPS 或 SSH 地址，本地 HEAD 必须等于目标远端 base。使用开发 checkout 时必须设置独立、非保留的 `OSSTACK_HOME`，不能打开默认或生产控制面数据库。

```sh
osstack improve deliver --proposal <proposal-id> --execution <stable-id> \
  --registry <registry-path> --profile <profile-name>

# 核对预览中的完整 request 后，原参数加以下两项；无需单独 approve。
osstack improve deliver --proposal <proposal-id> --execution <stable-id> \
  --registry <registry-path> --profile <profile-name> \
  --request-digest <preview-sha256> --yes

osstack improve status --execution <stable-id>
osstack improve status --execution <stable-id> --reconcile
osstack improve stop --execution <stable-id> --reason '暂停本次交付' --yes
```

可选 `--base <branch>`，默认目标仓库默认分支；可选 `--timeout-ms`，范围 1000–600000，每阶段默认 120000。普通预览不批准提案、不调用 Builder、不写 GitHub。确认绑定请求摘要；提案、base、gate 或 profile 变化必须重新预览。同一执行 ID 再次调用只展示记录。成功退出码 0；已运行但未确认交付为 2；请求或状态错误为 1。

## 一次确认内发生什么

1. 同一 SQLite 事务批准 draft/approved 提案、领取执行 ID，并写入 PR 交付意图。其他提案状态不自动批准。已占用或已交付的同一提案不能用另一个执行 ID 重复交付。
2. 外部 worktree 调用一次 Builder；保存完整补丁和文件摘要；一次独立 Evaluator 与所有验证命令通过后，核对候选未改变。
3. 从远端精确 base 重建独立 Git 仓库，应用保存的补丁；检查最终路径、普通文件模式和原始 blob 哈希。记录 patch → tree → commit 绑定，在新 checkout 再执行全部原验证命令，并检查源文件和 index 没有改变。
4. 重新核对 GitHub 仓库 ID、名称和 base；先持久记录 push dispatch，再只创建唯一分支。重新核对后持久记录 PR dispatch，再创建草稿 PR。
5. 查询并核对 open/draft、仓库 ID、base ref/SHA、head ref/SHA，只有匹配才记录 `delivered` 与可点击 PR URL。

每个正常执行最多一次 Builder adapter 调用、一次 Evaluator adapter 调用，两遍完整 gate，没有自动返工或重试。该计数不是隐藏的模型 API 请求数或 token 上限；`cost_usd` 为 null，不能当零费用。状态中的 `applied: false` 指候选尚未合入，不表示没有创建远端分支或 PR。`candidate_verified` 也不等于 `delivered`，两者都不代表自改进有效。

## 停止与失败

交付账本：`authorized → preparing → prepared → push_dispatched → pushed → pr_dispatched → delivered`。schema 27 追加表，不改变已发布迁移；旧候选执行和停止记录保留。

- 只有已知候选失败、尚未开始 PR 准备的记录会转成 `blocked`。干净验证失败/超时、进程丢失和外部写入响应丢失均保留阶段及占用，不允许自动重做。
- `--reconcile` 只发送 GitHub GET 并保存观察结果，不推送、不建 PR、不重跑模型。推送已成功但 PR 尚未派发时，会停在 `pushed`，本版没有自动恢复命令。人工核实远端及旧进程后才能设计下一次恢复，不能手工删锁当作停止证明。
- stop 是下一受控动作的阻断请求，不杀进程；dispatch 已入账后发生的 stop 不能撤销外部请求。已发出动作仍允许只读核实，因此 stop 后可能观察到已经创建的 PR。
- 远端基线前移不会自动 rebase。基线检查与 PR 创建不具备跨 GitHub 的原子性，期间漂移可能留下草稿 PR，但本地不得报告匹配交付成功。
- 证据目录与重建根目录保留用于诊断，后者见 `delivery.workspace_path`；本版不自动清理、不自动删除远端分支。

## 明确的支持边界

本版为可信本地操作员模式，GitHub 写操作由本地 `gh` 身份执行，不冒充另一个人的 review。没有登录界面、GitHub App、多账户代批、自动合并或发布。Git 的空预期 lease 防止覆盖既有分支；仍服从 GitHub 权限与保护规则。[Git 官方说明](https://git-scm.com/docs/git-push)、[GitHub PR 接口](https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request)。

两个验证阶段替换环境变量继承，使用私有 HOME，并禁用 Git 系统/全局配置；这不等于容器、网络隔离或同用户文件权限隔离。配置的模型身份不冒充服务端证明。因此不接入 `phase_continue` 签名授权，也不启用后台代码委托。

干净 checkout 不自动安装依赖。验收命令需要能在干净环境自行完成已授权的准备与验证；依赖缺失会阻断交付。不要为试点削弱注册的验收门。通用锁文件环境重建、worker 终止证明、签名代码委托与后台恢复仍按后续计划实施。

## 验证与下一步

测试使用真实本地 Git 仓库、真实 commit 和 bare remote 推送，GitHub API 与模型使用明确标注的 fixture。完整 CLI 测试验证 draft 预览不批准、摘要漂移不执行、一次确认到草稿 PR、重复执行无新增副作用；异常测试覆盖补丁篡改、base 前移、分支已存在、错误 PR 回执、响应丢失、停止及干净复验失败。新增 schema 26 升级保留测试。

两轮真实 Claude Fable 5.1 设计挑战及采纳/驳回原因见[评审记录](2026-09-09-authorize-to-pr-fable-review.md)。模型回复不是代码审计或测试替代物。本轮提交的是该功能的实现 PR；尚未把新命令与真实提供方、真实 GitHub 联合运行成在线试点，不宣称计划检查点 A 已完成。

后续优先完成可复现依赖环境与受限 worker，然后做一个预先冻结范围的真实任务试点；再接入签名委托和 daemon 持久接力。效果晋升须另有保留任务集与基线比较。


本地验证结果：`pnpm test` 共 290 个测试文件、2562 个测试通过；`pnpm build`、`pnpm typecheck:check`、`pnpm lint`、inventory freshness 均通过（lint 保留两条既有 warning）。启动预算检查：`--version` 中位数 32ms，`--help` 85ms。所有 CLI/整仓测试使用独立临时 `OSSTACK_HOME`。
