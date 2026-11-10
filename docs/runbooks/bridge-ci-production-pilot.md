# osstack GitHub CI 无人值守试点放行单

**状态** 生产关闭。本文请求负责人审批下列范围和变更。沙箱 #31 已用 #438 合入的版本完成一次无人值守关单。生产仓库尚未执行 Mission 试点。

## 生产读回

| 项目 | 已核实 | 放行前动作 |
| --- | --- | --- |
| CI | `ci.yml` 在最近已合并的 PR 上运行六项可计入的检查。均由 GitHub Actions App 15368 报告。当前策略固定该 workflow blob，后续 workflow 变更需要重新读回并复审策略。主分支的分支保护和适用规则目前没有必需检查。 | 将六项检查及来源写入无绕过的 `main-quality`。在试点源上核对 workflow blob、Ubuntu 和 macOS runner、矩阵及必需步骤。 |
| Watcher | Rubebun-Jadeem 是仓库管理员。在 #436 与 #438 都有当前提交的审批记录。当前规则要求一条审批、最新推送由另一人审批、旧审批失效、解决线程，并适用于管理员。 | Pilot PR 实测只有 Watcher 的新提交审批时，GitHub 返回 `APPROVED`，且 GraphQL 显示该用户可推送。同步保存 Grok Routine 运行记录。按最小权限评估将 Watcher 降至 Write，另行批准。 |
| App A | 用 App A 自身身份读回。沙箱安装有 Contents write、Pull requests write。主仓库安装查询返回 404。 | 经批准后给主仓库授权，读取准确仓库、安装与权限。Mission 分支的创建和更新仅由 App A 执行。 |
| App E | 用 App E 自身身份读回。沙箱安装有 Contents write、Pull requests read、Checks read。主仓库安装查询返回 404。 | 经批准后给主仓库授权，独立凭证只交给 Mac mini。合并请求只允许指定提交的 squash。 |
| Actions 权限 | 默认 token 权限为 read，Actions 自行审批关闭。 | 保持两项设置，读取受保护的 workflow。 |

GitHub 记录见 [#436 审批](https://github.com/osborn-studio/osstack/pull/436#pullrequestreview-5820875770)、[#438 检查](https://github.com/osborn-studio/osstack/actions/runs/42601098716) 和 [沙箱 #31](https://github.com/osborn-studio/osstack-bridge-sandbox/pull/31)。

六项必需检查是 `check`、`bridge-offline-node-tests`、`graph-macos-fixtures (22)`、`graph-macos-fixtures (24)`、`graph-runtime-matrix (20.6.0)` 和 `graph-runtime-matrix (22.23.1)`。`Paid DeepSeek semantic smoke` 是按需手动任务。

## 请负责人审批的范围

1. 仅 `osborn-studio/osstack`、`main` 和一个登记 scope。用隔离 daemon 和独立的 `OSSTACK_HOME`，Docker 保持停止。最多登记五条新 Mission，每次一条。每次登记前快进试点克隆的本地 main，并核对远端 tip。每条最多自动推回一次，只修改该 PR 原先已经改过的获批文件。修复禁止删除文件和修改测试文件。负责人审批具体路径清单和到期时间，最长 72 小时。
2. 准备四条 GitHub 规则。在获批的实际试运行窗口启用并读回。现有的审批和线程保护保留。新 `main-quality` 不设绕过，要求六项检查来自 15368，要求分支跟上最新 main，保留最新推送审批与旧审批失效。新 `main-update` 的唯一例外是 App E 通过 PR 更新 main。`mission-writers` 仅允许 App A 创建和更新 `osstack/mission/**`。`mission-history` 禁止这类分支删除及非快进更新，且无绕过。**App E 独占 main 更新期间，普通 PR 的现有 Merger 也会被阻止合并。** 先清空普通合并队列，在登记每条试点任务前启用独占规则。关单后或撤权停住时恢复普通 PR 的合并路径。应单独批准该影响。分支规则与 App 设置都需要管理员操作。
3. 给现有 Watcher 和 Merger 增加仅用于登记 Mission 的路由。Watcher 按原来的 `verify-osstack` 真跑验证，通过时对当前 head 提交 APPROVED，写入单独一行 `verify-osstack: pass HEAD BASE`，再打 `verified`。Merger 对这些 Mission 在满足全部门槛后只发一条 `osstack-ci-pilot-merge HEAD BASE`，App E 在本机执行合并。两处都填写完整 SHA。合并顺序有依赖、身份不明或状态不完整时交由负责人处理。两个 Bot 共用 GitHub 用户，因此用实际 Routine 日志辨认每个角色的执行。
4. 在负责人批准的两天窗口内进行只读影子观察。先用 GitHub 只读观测及现有 PR 核对 CI 和角色信号。App 与规则 ID 读回后，试点 daemon 可用 `OSSTACK_CONTAINED_CI_PILOT=shadow`，可读回登记账本，拒绝登记新生产 Mission 和远端写入。影子观察应先完成，App E 独占的规则在实际试运行窗口启用。
5. 影子门通过后再由负责人确认 live 开关与精确的 host release。五条连续关单中至少一条经历真实 CI 失败、同 PR 自动修复、原矩阵通过、Watcher 复验及 App E 合并。保留 PR、GitHub run/attempt、审批、合并、任务关单和撤权日志。通过后由负责人决定是否扩大范围。

### osbornalpha 独立试点

使用独立 daemon home、独立登记 scope 和只包含 `osborn-studio/osbornalpha` 的 GitHub 安装令牌。profile 设置 `"repository": "osborn-studio/osbornalpha"`。旧 profile 省略该字段时继续使用 `osborn-studio/osstack`。App A、App E 可用同一组织中各自的安装，但各令牌都限定到当前仓库。Alpha 使用该仓库读回的四条规则 ID、单独审批的精确路径和到期时间，以及自己的 release 文件。

Alpha 的三个必需检查为 `test`、`provider-date-ingress` 和 `source-fixtures`，均由 GitHub Actions App 15368 发布，分别来自 `ci.yml`、`industry-release-audit.yml` 和 `macro-source-integration.yml`。宿主在当前 head 和 base 核对三个 workflow 文件，要求每个检查来自相同一组最新运行与重跑次数。每个 job 只把策略中登记的测试步骤视为可自动修复的失败。后续改动 workflow 时重新读回、更新并复审策略。

对已登记的 Alpha Mission，Watcher 使用仓库的 `verify-osbornalpha`，在当前 head 的正式审批里写入独立一行 `verify-osbornalpha: pass HEAD BASE`。现有 Merger 为该 Mission 发送 `osstack-ci-pilot-merge HEAD BASE`，由本机 App E 校验后执行。使用完整 SHA。普通 PR 继续走原有 Bot 规则。Alpha 当前批准的采集窗口为两天，规则集在观察期间保持禁用。App E 独占更新规则一旦启用，会阻止现有 Merger 合并普通 PR。上线前单独安排试点窗口并读回所有规则。

## 主机配置和回滚

`$OSSTACK_HOME/bridge/ci-pilot.json` 是 0600 私有文件，所在目录为 0700，必须在源码仓库和候选工作树之外。字段为 `version`（1）、`scope_id`、精确文件名数组 `paths`、`publisher_installation_id`、`merger_installation_id`、`merger_key_path`、`main_quality_ruleset_id`、`main_update_ruleset_id`、`mission_writers_ruleset_id`、`mission_history_ruleset_id`。使用 GitHub 读回的值，App A 与 App E 不能使用同一个安装。既有 `apps.json` 和 `rulesets.json` 必须与试点 scope 的仓库和 App A 配置相符。

只有负责人批准试运行后才创建 `ci-pilot-release.json`。同样用 0600，字段为 `version`（1）、原始 profile 文件的 SHA-256 `profile_sha256`、`issued_at`、`expires_at`（Unix 毫秒）、`principal_id` 和 `client_session_id`。使用独立 App E 私钥文件。在单独 daemon 设置 `OSSTACK_CONTAINED_CI_PILOT=live`。原先的 `OSSTACK_BRIDGE=1` 属于评审驱动路线，继续按自己的门禁。不要混用沙箱环境变量。

停止时先移走 release 文件，保留 profile 和 SQLite。登记、自动修复和合并的写入授权随即失效。daemon 可重启为 `shadow`，继续只读对账。已释放的 GitHub 请求可能落地。用 PR/head/base、一次性预留及合并者核对结果。已经落地但本机缺推送回执的修复进入待处理记录，不发第二次推送。合并回复丢失时用只读结果关单。无法核对时停止后续派发，保留证据。当前证据来自使用真实 SQLite 与注入 GitHub 响应的隔离测试。生产试点还需核对 GitHub 真实权限和运行结果。

相关规则见 [ADR-007](../decisions/ADR-007-bridge-github-ci-first.md) 和 [阶段 7](../plans/2026-11-02-osstack-grok-bridge-implementation.md#阶段-7-主仓库单-scope-试运行)。
