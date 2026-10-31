# 分支治理第二轮（W12）：清单与处理

日期：2026-10-31。基准：`origin/main` = `08a6690e`。范围：v3 设计 §7、执行计划 W12。
方法：对每个本地与远端分支，判断其是否为 `main` 的祖先；不是祖先的，用 `git cherry origin/main <branch>` 统计 `main` 中没有等价补丁的提交（下称“独有提交”），再查同名 head 的最新 PR 状态，以及合并 PR 的合并提交是否在 `main` 中。不从分支名推断废弃。

总量：远端 81 个，本地 276 个，外加 25 个 worktree。

## A. 可直接删除（工作已在 main）

| 组 | 判据 | 本地 | 远端 |
|---|---|---|---|
| A1 已合并或补丁已在 main | 是 `main` 的祖先，或没有独有提交 | 212 | 46 |
| A2 PR 已合并，提交被改写 | PR 合并提交在 `main` 中（#147、#151、#155、#157、#159、#176、#177、#201）；或 PR 合入了叠放分支（#178–#184），但这些分支新增的 CLI 模块（`agent-`、`steward-`、`skills-`、`assurance-`、`product-entry-`、`session-command.ts`）都已在 `main` 中 | 15 | 14 |
| A3 已合并 PR 的 worktree | `land-delivery-preservation`（#332）、`land-node26-tests`（#329）、`land-untrack-knowledge-dist`（#331）：无改动，分支已在 main | 3 | — |
| A4 已移植并关闭的 Firstmate draft 线 | #317–#322 已关闭；内容已按 L2 移植到 main（#323–#337）；`firstmate-operating-model` 的文档已进入 main。worktree 内只有被追踪 `packages/knowledge/dist` 的构建产物改动（D3 已停止追踪） | 7 + 7 个 worktree | 6 |

当前主 checkout 所在的 `codex/firstmate-supervision` 已被 main 包含，但本地分支保留到主 checkout 切回 `main` 为止，只删远端。

## B. 需要确认（不在 main，判断为已被取代或已废弃）

| 分支 | 位置 | 独有提交 | 最后提交 | 判断 |
|---|---|---|---|---|
| `codex/pstack-loop-long-path-delivery` | 本地+远端，PR #316（draft，开放） | 6 | pstack 长路径交付 | pstack 已移出核心（#335），建议关闭 #316 后删除 |
| `codex/pstack-first-use`（#315 已关闭）、`pstack-first-use-control`、`pstack-loop-long-path-control`、`pstack-method-bridge-control`、`pstack-source-manifest`、`opus-handoff-control`、`pr314-main-control` | 本地，多数也在远端 | 1–14 | 10-30 的 pstack 控制与记录 | L1 完成后不再需要 |
| `codex/joint-adoption-preparation`、`joint-post286-control` | 本地+远端 | 3、5 | 10-27 的 joint 记录 | joint 方法合同不再推进 |
| `codex/joint-adoption-closure-spec`、`joint-bootstrap-file-spec` | 仅 worktree | 0 | 有**未提交**的 joint 规格文档与恢复测试 | 未提交内容会随 worktree 一起丢失 |
| `codex/firstmate-follow-up-delivery`、`firstmate-obligations`、`firstmate-remote-readonly`、`firstmate-batch1-integration`、`session-debt03` | 本地 | 1–3 | 10-23 至 10-26 | 已被 main 中的跟进投递账本、只读快照与后续 Firstmate 线取代 |
| `codex/capability-registry-pilot`（#251 已关闭） | 本地+远端 | 1 | 等待会话采纳与决策收据 | main 已有会话采纳 |
| `codex/graph-decision-development` | 本地+远端 | 6 | 09-21，Graph changeset 写入权威 | 9 月实验，未继续 |
| `codex/release-neat-0.10.0`、`loop-governance-recovery`、`review-boundary-extensions`、`codex/copilot-session`、`wip/report-package`、`archive/clones-2026-10-17/*`（2 个） | 本地或远端 | 1–26 | 07 月至 09 月 | 早期实验与存档 |

## C. 内部磁盘上的旧 worktree（需要确认）

`~/Documents/Codex/2026-09-30/.../wiki-development/` 下有 10 个 osstack worktree（9 月的 cost / loop-defaults 工作）。分支都已在 main，但其中 6 个有未提交改动（2–25 个文件，涉及 `delivery.ts`、`loop-engine.ts`、`guarded-git-runtime.ts`、`bin.ts` 等）。它们违反“代码只放 SSD”的规则，也是 git 账面上 10 个无法删除的本地分支。删除即丢弃这些未提交改动。

## 保留

`main`、`changeset-release/main`（发布流程管理），以及正在使用的 worktree：`branch-governance-2`（本工作包）、`mission-contained-design`（W11）。

## 附录：A1 完整清单

**本地：**
`agent/fix-cli-smoke-build-order` `agent/npm-install-version-handshake` `agent/probe-acceptance-answer` `archive/changeset-release-main-pre-refresh-4f340ef` `archive/changeset-release-main-pre-refresh-76c4d5f` `archive/changeset-release-main-pre-refresh-93b4d46` `archive/changeset-release-main-pre-refresh-d7e6bd5` `archive/changeset-release-main-pre-sync-2c191` `archive/clones-2026-10-17/merge-orchestration-loop-s1` `codex/checkrun-state-author` `codex/checkrun-state-control` `codex/ci307-ready-control` `codex/clean-typecheck` `codex/cost-ci-test-repair-reviewed` `codex/darwin-lock-filesystem` `codex/darwin-npm-version` `codex/firstmate-behavior-loader` `codex/firstmate-cockpit` `codex/firstmate-completion` `codex/firstmate-completion-delivery` `codex/firstmate-completion-final` `codex/firstmate-completion-scout` `codex/firstmate-completion-upgrade` `codex/firstmate-context-sources` `codex/firstmate-daily-summary` `codex/firstmate-delivery-contract` `codex/firstmate-delivery-ledger` `codex/firstmate-evidence-lessons` `codex/firstmate-execution-context` `codex/firstmate-extension-integration` `codex/firstmate-graph-contract` `codex/firstmate-npm-022` `codex/firstmate-observation-reliability` `codex/firstmate-qualification-soak` `codex/firstmate-r01-r02` `codex/firstmate-release-main` `codex/firstmate-routing-next` `codex/firstmate-run-events` `codex/firstmate-supervision-next` `codex/firstmate-terminal-viewer` `codex/firstmate-triage-budget` `codex/firstmate-upgrade-evidence` `codex/firstmate-upgrade-journal` `codex/firstmate-upgrade-plan` `codex/firstmate-upgrade-roadmap` `codex/firstmate-worker-view` `codex/fix-governance-release-skew` `codex/fix-launchd-bootstrap-race` `codex/fix-launchd-reload` `codex/fix-probe-help-question` `codex/fix-release-version-gate` `codex/graph-admission-lease-closeout` `codex/graph-deployment-closeout` `codex/graph-engineering-foundations` `codex/graph-production-beta-closeout` `codex/graph-public-release-closeout` `codex/graph-raw-paths` `codex/graph-runtime-foundation` `codex/graph-runtime-release-followup` `codex/hub-agent-publish-diagnostics` `codex/improvement-authorize-to-pr` `codex/improvement-candidate-execution` `codex/improvement-execution-control` `codex/improvement-live-provider-pilot` `codex/improvement-native-build-policy` `codex/improvement-pnpm-environment` `codex/joint-291-main-proof` `codex/joint-behavior-audit-fixes` `codex/joint-broker-spec` `codex/joint-contract-acceptance` `codex/joint-delivery` `codex/joint-entry-composition` `codex/joint-final-ci-composition` `codex/joint-gate-layers` `codex/joint-host-effects` `codex/joint-json` `codex/joint-nextwave-control` `codex/joint-post284-control` `codex/joint-recovery-composition` `codex/joint-recovery-spec` `codex/joint-source-snapshot` `codex/joint-terminal-preflight` `codex/joint-verification-composition` `codex/land-attention-batch` `codex/land-baseline-backports` `codex/land-overdue-reminders` `codex/land-return-brief` `codex/land-session-cli` `codex/land-session-registry` `codex/land-session-runtime` `codex/land-supervision-takeover` `codex/land-v3-docs` `codex/maintenance-real-loop` `codex/method-architecture-design` `codex/method-change-impact` `codex/method-code-review` `codex/method-concise-evidence` `codex/method-continuity-delivery` `codex/method-continuity-publication` `codex/method-evidence-projection` `codex/method-framing-delivery` `codex/method-framing-publication` `codex/method-full-journey-author` `codex/method-full-journey-control` `codex/method-full-journey-delivery` `codex/method-full-journey-docs` `codex/method-full-projection-author` `codex/method-full-projection-delivery` `codex/method-full-projection-docs` `codex/method-full-projection-publication` `codex/method-host-usage` `codex/method-impact-control` `codex/method-impact-performance-delivery` `codex/method-journey-delivery` `codex/method-journey-reference` `codex/method-material-delivery` `codex/method-material-reader` `codex/method-material-revision` `codex/method-native-control` `codex/method-native-discovery` `codex/method-next-composition` `codex/method-parallel-guide` `codex/method-parallel-reporting-delivery` `codex/method-parallel-reporting-publication` `codex/method-performance-measurement` `codex/method-post300-control` `codex/method-pr-readiness-author` `codex/method-pr-readiness-delivery` `codex/method-pr-readiness-publication` `codex/method-projection-control` `codex/method-projection-delivery` `codex/method-review-control` `codex/method-session-continuity` `codex/method-skill-authoring` `codex/method-skill-authoring-delivery` `codex/method-task-framing` `codex/method-wave-control` `codex/neat-bilingual-release-docs` `codex/neat-fingerprint-uniqueness` `codex/neat-v3-baseline` `codex/npm-authenticated-release` `codex/npm-deprecation-recovery` `codex/npm-macos-release-fix` `codex/npm-trust-configurator` `codex/osstack-method-entrypoints` `codex/post307-ci-close` `codex/pr-candidate-snapshot-author` `codex/pr-candidate-snapshot-delivery` `codex/pr-stack-frontier-author` `codex/pr304-main-retarget` `codex/pr305-main-retarget` `codex/pr305-retarget-ledger` `codex/pr306-control` `codex/pr306-main-retarget` `codex/pr307-inventory-repair` `codex/pr307-lint-author` `codex/pr307-lint-root` `codex/pr308-main-retarget` `codex/pr309-main-retarget` `codex/pr310-ci-close` `codex/pr314-main-retarget` `codex/private-repo-trusted-publish` `codex/probe-data-model-decision` `codex/probe-release-evidence` `codex/probe-test-data-privacy` `codex/promote-session-cli` `codex/promote-session-design` `codex/promote-session-docs` `codex/promote-session-registry` `codex/promote-session-runtime` `codex/promote-session-state` `codex/pstack-adoption-bundle` `codex/pstack-adoption-bundle-delivery` `codex/pstack-c0-usage` `codex/pstack-current-repair-control` `codex/pstack-feature-map-control` `codex/pstack-feature-map-delivery` `codex/pstack-fixed-release-control` `codex/pstack-maintenance-health` `codex/pstack-method-bridge` `codex/pstack-method-bridge-delivery` `codex/pstack-real-loops-control` `codex/pstack-w18-scope` `codex/public-release-020` `codex/readme-graph-user-guide` `codex/release-020-from-main` `codex/remove-joint-recovery-specs` `codex/session-cli` `codex/session-design` `codex/session-docs` `codex/session-pilot-debt` `codex/session-pilot-safety` `codex/session-pilot-verification` `codex/session-registry` `codex/session-runtime` `codex/session-start-cleanup` `codex/session-state` `codex/session-terminal-fence` `codex/session-verification-landing` `codex/skills-check-exit` `codex/skills-check-verification` `codex/skills-map-maintenance` `codex/skills-map-maintenance-delivery` `codex/stack-status-context-author` `codex/stack-status-context-control` `codex/stack-status-context-delivery` `codex/stack-status-context-root` `codex/test-isolation-and-macos15` `codex/update-cache-version` `codex/verification-kit` `feat/rpc-latency-stats` `pr-332` 
**远端：**
`agent/fix-cli-smoke-build-order` `agent/npm-install-version-handshake` `agent/probe-acceptance-answer` `codex/ci-release-pr-push` `codex/clean-typecheck` `codex/firstmate-contract-integration` `codex/firstmate-followthrough` `codex/firstmate-graph-recovery` `codex/firstmate-local-ledgers` `codex/firstmate-next-wave` `codex/firstmate-supervision` `codex/firstmate-upgrade-roadmap` `codex/fix-governance-release-skew` `codex/fix-launchd-bootstrap-race` `codex/fix-launchd-reload` `codex/fix-release-version-gate` `codex/i18n-help-scorecard` `codex/neat-fingerprint-uniqueness` `codex/neat-v3-baseline` `codex/npm-deprecation-recovery` `codex/npm-trust-configurator` `codex/private-repo-trusted-publish` `codex/probe-data-model-decision` `codex/probe-release-evidence` `codex/probe-test-data-privacy` `codex/promote-session-cli` `codex/promote-session-runtime` `codex/promote-session-state` `codex/proof-validate-negative-vectors` `codex/proof-zip-unsafe-entry` `codex/release-action-plan` `codex/release-operator-actions` `codex/release-plan-safety` `codex/release-pr-ci-diagnostics` `codex/release-pr-diagnostics` `codex/release-readiness-gates` `codex/session-cli` `codex/session-design` `codex/session-protocol` `codex/session-registry` `codex/session-runtime` `codex/session-state` `codex/test-isolation-and-macos15` `codex/umadev-knowledge-adaptation` `codex/update-cache-version` `verify/add-verification-skill` 

**A2：**

| 分支 | PR | 位置 | SHA |
|---|---|---|---|
| `codex/agent-cli-module` | #179 MERGED | local+remote | a609fa9c |
| `codex/assurance-cli-module` | #182 MERGED | local+remote | f5ddb82c |
| `codex/neat-cn-providers` | #151 MERGED | local+remote | 699d78c4 |
| `codex/neat-semantic-parity` | #147 MERGED | local+remote | 5ff3dc0d |
| `codex/probe-restate-audit-pack` | #184 MERGED | local+remote | 8b2c7a45 |
| `codex/product-entry-cli-module` | #180 MERGED | local+remote | 114c6f18 |
| `codex/release-train-resilience` | #176 MERGED | local+remote | 8ee076dd |
| `codex/session-cli-module` | #178 MERGED | local+remote | 810ed45d |
| `codex/session-relay-recovery` | #177 MERGED | local+remote | 4d660845 |
| `codex/skills-cli-module` | #183 MERGED | local+remote | 7cf7485f |
| `codex/steward-cli-module` | #181 MERGED | local+remote | 5305838d |
| `feat/guarded-deploy-operations` | #159 MERGED | local+remote | 8a6eea66 |
| `feat/kimi-adapter-verifier` | #155 MERGED | local+remote | f1b359fe |
| `feat/kimi-profile-deliver` | #157 MERGED | local+remote | 7d24089c |
| `perf/cli-fast-path-bench` | #201 MERGED | local | 4428ada7 |
