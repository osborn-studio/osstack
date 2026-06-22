# osstack 升级开发主计划实现审计

> 日期：2026-06-22  
> 目标文档：`/Users/gilbertchen/Documents/CODE/agentsteam/osstack/docs/2026-06-22-osstack-upgrade-development-plan.md`  
> 审计分支：`codex/osstack-report-foundation`  
> 审计 HEAD：`0a03f60 feat(cli): show queued tasks in cockpit`

## 1. 审计结论

当前分支已经把升级计划中的核心闭环推进到“本地可验证发布候选”状态：

- Phase 1 Evidence Layer、Phase 2 Product Entry、Phase 3 Governed Run、Phase 4 Learning Control Plane、Phase 6 的 Knowledge Cloud/Compliance 大部分已经有代码、命令和测试。
- 最关键的端到端路径已经跑通：`deliver/loop -> report -> scorecard -> proof -> pr body -> knowledge trace -> compliance render`。
- npm 安装后的真实用户路径已有 smoke：tarball pack/install、CLI 二进制、launchd dry-run、doctor、loop doctor、evidence commands、official knowledge eval、Knowledge Cloud package loading、cloud sync cache、cloud outage local fallback。
- Knowledge Cloud 已具备 official/private pack HTTP 服务、sync/search/feedback endpoint、部署资产和本地 smoke。

仍未完成的部分集中在外部发布和产品深化：

- GitHub push 被 OAuth token 缺少 `workflow` scope 阻塞，导致 PR、CI、云端部署、npm 发布无法继续；本地 workflow 已接入 `smoke:deliver-proof` 与包含 installed-CLI knowledge fallback 的 `smoke:npm-install`。
- `npm install -g @osstack/cli` 还没有从真实 npm registry 验证，只验证了本地 tarball 安装。
- 可选单文件分发尚未实现。
- Cockpit 当前是 dashboard/web cockpit + CLI summary，不是完整交互式 TUI。
- Knowledge Cloud 的 ingestion/rewrite/review/publish 生产流水线仍是 MVP/本地包化阶段，还不是完整云端运营系统。

## 2. Phase 完成矩阵

| Phase | 计划目标 | 当前状态 | 证据 | 剩余工作 |
|---|---|---:|---|---|
| Phase 0 Distribution | 一行安装 + daemon install + 可选单文件分发 | 部分完成 | `scripts/smoke-npm-install.mjs` 验证本地 tarball install；`serve --install --no-load` 验证 launchd plist 生命周期 | 真实 npm publish；真实 `npm install -g @osstack/cli`；单文件分发 |
| Phase 1 Evidence Layer | report + scorecard + proof + subprocess-first adapters | 基本完成 | `report-cli.test.ts`、`scorecard-cli.test.ts`、`proof-cli.test.ts`、`agent-list-cli.test.ts`、npm install smoke | daemon event-rich report 仍需更多真实运行样本验证 |
| Phase 2 Product Entry | `osstack deliver` + agent 角色化 | 基本完成 | `deliver-cli.test.ts`、`product-entry-cli.test.ts`、`agent-scorecard-cli.test.ts` | deliver 的 execute-loop 生产路径需更多真实仓库 smoke |
| Phase 3 Governed Run | Run Spec + governance verifier + PR evidence | 基本完成 | `docs/specs/OSSTACK_RUN_SPEC_V1.md`、schemas/test vectors、`governance-cli.test.ts`、`pr-cli.test.ts` | spec MUST 到 verifier 的覆盖矩阵可继续细化 |
| Phase 4 Learning Control Plane | Pitfall KB + Knowledge bootstrap + agent scorecard | 基本完成 | `lessons-cli.test.ts`、`knowledge-cli.test.ts`、`agent-scorecard-cli.test.ts` | pitfall 自动提升 verified_count 的真实 loop 闭环需继续增强 |
| Phase 5 Product Surface | Cockpit/TUI + examples/guide/doctor + i18n + checkpoint | 部分完成 | `dashboard.ts`、`dashboard-cli.test.ts`、`product-entry-cli.test.ts`、`i18n-cli.test.ts`、`checkpoint-cli.test.ts` | 交互式 TUI 未完成；approve/retry 仍待补齐；report/scorecard/cockpit i18n 仍可扩展 |
| Phase 6 Trust/Compliance/Knowledge Cloud | compliance packs + enterprise proof views + Osstack Knowledge Cloud | 部分到基本完成 | `compliance-packs/*`、`compliance-cli.test.ts`、`proof view`、`knowledge-cloud` package、deploy assets、smoke | 真实云端上线、生产 ingestion pipeline、tenant auth/storage/vector index |

## 3. 任务级状态

### Task 0.1：发布 `@osstack/cli`

状态：部分完成。

已完成：

- `@osstack/cli` package 可 build/pack/install。
- 本地 tarball 全局安装 smoke 通过。
- 安装后 `osstack --version` 通过。
- 安装后 `doctor`、`loop doctor`、evidence commands、knowledge commands 通过。
- `.changeset/osstack-upgrade-knowledge-cloud.md`、`.github/workflows/release.yml` 已存在。

未完成：

- 还没有真实 npm registry 发布。
- 还没有从 npm registry 执行 `npm install -g @osstack/cli`。
- push/CI/release workflow 被 GitHub `workflow` scope 阻塞。

下一步：

1. 执行 `gh auth refresh -h github.com -s workflow`。
2. push branch 并开 PR。
3. CI 通过后跑 release workflow 或 changesets publish。
4. 用真实 npm registry 复跑安装 smoke。

### Task 0.2：`osstack serve --install`

状态：基本完成。

已完成：

- CLI 支持 `serve --install`、`serve --status`、`serve --uninstall`。
- npm install smoke 使用临时 `OSSTACK_HOME` 与 `OSSTACK_LAUNCH_AGENTS_DIR` 执行 `--no-load`，避免触碰真实用户环境。
- launchd plist 写入、status、uninstall 路径已被 smoke 覆盖。

未完成：

- 真实 macOS launchd load/start 的人工/机器验证尚未记录到发布证据。

### Task 0.3：可选单文件分发

状态：未完成。

证据：

- 当前没有 Bun compile、Node SEA、pkg 或 macOS arm64 single binary 产物。

建议：

- 保持 npm 为主路径。
- 后续单独做 `scripts/build-single-binary.mjs` 评估，不阻塞当前 PR。

### Task 1.1 - 1.4：Report / Scorecard / Proof

状态：基本完成。

已完成：

- `osstack report`、`osstack scorecard`、`osstack proof` 命令存在。
- 支持 `--loop` artifact id，并校验 `LOOP-STATE.json` 的 loop_id，避免误读证据。
- proof pack 包含 manifest、report、scorecard、loop state、governance/knowledge results、sha256sums。
- `proof view` 支持 audience-oriented evidence views。
- npm install smoke 会生成 scorecard markdown、proof manifest、proof zip。

未完成/需增强：

- daemon SQLite event-rich report 需要更多真实 run fixture。
- proof pack 的 reviewer/checker-output/logs 可以继续丰富。

### Task 1.5：subprocess-first adapters

状态：基本完成。

已完成：

- `osstack agent list` 显示 role、capability、auth mode。
- `codex-cli` 等 subprocess/login-reuse 模式已进入测试。
- agent scorecard 可显示成功率、失败、适合任务类型。

需增强：

- README 中“默认不保存模型 API key”的说明可再加粗。

### Task 2.1：`osstack deliver`

状态：基本完成。

已完成：

- `osstack deliver "..." --verify "..." --auto-agent --worktree` 命令存在。
- 可生成 task queue。
- 可输出 report/scorecard/proof。
- `deliver-cli.test.ts` 覆盖命令路径。

需增强：

- 在真实外部 repo 上做一条 execute-loop smoke。
- auto verify command suggestion 仍可进一步智能化。

### Task 2.2：Agent 角色化展示

状态：基本完成。

已完成：

- agent list 显示 role/capability/auth mode。
- agent scorecard 显示成功率、平均耗时、capability fit、recent failures。
- report/proof/PR evidence 可记录 agent 选择。

### Task 3.1：`OSSTACK_RUN_SPEC_V1`

状态：基本完成。

已完成：

- `docs/specs/OSSTACK_RUN_SPEC_V1.md` 存在。
- schemas/test vectors 存在，包括 task/event/loop-state/policy-decision/proof-pack/knowledge-pack。
- `run-spec-files.test.ts` 验证 spec 文件和 vectors。

需增强：

- 建议新增 `docs/specs/CONFORMANCE_MATRIX.md`，把每条 MUST 映射到 schema/test/verifier。

### Task 3.2：Governance verifier

状态：基本完成。

已完成：

- `packages/governance` 存在。
- `osstack govern check` / `osstack governance check` 存在。
- 支持 JSON 输出、diff/workspace 扫描、warning/strict 语义。
- governance findings 可进入 report/scorecard/proof。

需增强：

- frontend anti-slop 与 backend safety 规则可继续扩展。
- strict mode 应继续补更多 e2e fixtures。

### Task 3.3：PR body evidence

状态：基本完成。

已完成：

- `osstack pr <run_id> --dry-run` / `--create` 命令存在。
- dry-run 写 PR body。
- default branch 检查、gh auth 探测、manual fallback 已有测试。
- PR body 可包含 proof/governance/knowledge evidence。

未完成：

- 真实 GitHub PR 创建被 push/auth 阻塞。

### Task 4.1：Pitfall KB

状态：基本完成。

已完成：

- SQLite pitfall lessons 存储存在。
- `osstack lessons list` 存在。
- dashboard/cockpit 可展示 lessons。

需增强：

- verify failed/reviewer failed/max-iter escalation 到 pitfall 的自动写入与 verified_count 增长还需要更多真实 loop 验证。

### Task 4.2：Knowledge Cloud bootstrap client

状态：基本完成。

已完成：

- `osstack knowledge login/sync/list/search/inspect/import/ingest/pin/feedback/eval/sources` 存在。
- local cache、cloud search、official packs、本地降级、provenance、retrieval eval 均有测试；安装后 smoke 也覆盖 cloud outage -> cached official packs fallback。
- report/proof 可记录 knowledge mode、packs、chunks。

需增强：

- 本地 cache 的版本清理、pin enforcement、离线策略可以继续产品化。

### Task 4.3：Agent scorecard

状态：基本完成。

已完成：

- `osstack agent scorecard` 存在。
- 基于 run history 聚合 success rate、duration、fit、recent failures。
- cockpit snapshot 展示 agent scorecards。

### Task 5.1：Cockpit/TUI MVP

状态：部分完成。

已完成：

- `osstack cockpit` 存在。
- 支持 daemon status + dashboard snapshot summary。
- 支持 `cockpit --json`。
- 支持 `cockpit run` 以 task queue 为默认 source 运行 queued work，并默认生成 report、scorecard、proof。
- 支持 `cockpit report` 从 loop evidence 生成 report。
- 支持 `cockpit proof` 从 loop evidence 生成 proof pack，并可 `--open` 打开 proof 目录。
- Web dashboard 展示 active runs、queued tasks、active loops、agents、kanban、reports/proof packs、lessons、scorecards。

未完成：

- 还不是完整交互式 TUI。
- 还不能直接在 cockpit 中执行 approve/retry。

建议：

- 当前可作为 Cockpit MVP。
- 后续再做 Ink/blessed 或增强 Web cockpit。

### Task 5.2：Examples / Guide / Doctor

状态：基本完成。

已完成：

- `osstack examples`、`osstack guide`、`osstack doctor` 存在。
- Quickstart 覆盖 doctor -> enqueue/run -> report/scorecard/proof。
- npm install smoke 检查 examples 至少 6 条，并覆盖 deliver/proof。

### Task 5.3：中英 i18n

状态：部分完成。

已完成：

- CLI help/product surface 部分支持 `OSSTACK_LANG=zh-CN`。
- cockpit/report 相关文案有中英文路径。
- `i18n-cli.test.ts` 存在。

需增强：

- scorecard、proof view、compliance render 的完整中英输出还可继续补齐。

### Task 5.4：Optional shadow checkpoint

状态：基本完成。

已完成：

- checkpoint CLI 与测试存在。

需增强：

- rewind/restore 产品化仍是后续工作。

### Task 6.1：Compliance mapping packs

状态：基本完成。

已完成：

- `compliance-packs/engineering-readiness`、`soc2-lite`、`iso27001-lite`、`eu-ai-act-lite`、`internal-audit` 存在。
- 每个 pack 含 manifest、controls、evidence-map、report-template、score-rubric。
- `osstack compliance list` / `render` 存在。
- compliance report 不声称外部认证。
- `smoke:deliver-proof` 已从真实 deliver proof dir 渲染 `engineering-readiness` compliance report，并校验 proof manifest checksum evidence mapping。

需增强：

- 如果要把 compliance report 默认打进 proof pack，还需要新增产品选项或默认策略；当前已验证的是 proof dir 可生成可引用合规视图。

### Task 6.2：Enterprise proof views

状态：基本完成。

已完成：

- `osstack proof view <run_id> --audience engineer|manager|auditor|customer` 存在。
- 视图基于已有 proof evidence，不生成假证据。

需增强：

- 缺失证据的“红色/高亮”在 Markdown/HTML 视图中可继续增强。

### Task 6.3：Osstack Knowledge Cloud

状态：部分到基本完成。

已完成：

- `@osstack/knowledge-cloud` package 存在。
- HTTP endpoints 存在：`/healthz`、`/v1/packs`、`/v1/sync`、`/v1/private-packs`、`/v1/search`、`/v1/feedback`。
- official packs 6 个，retrieval eval 30/30。
- official packs 有 version、quality_score、last_reviewed_at、source_provenance。
- CLI 支持 cloud login/sync/search/import/ingest/pin/feedback/sources。
- 本地 smoke 验证 official/private packs、sync、search、feedback。
- deploy assets 存在：Dockerfile、Fly、Render、GitHub Actions。

未完成：

- 真实云端域名/URL 未上线。
- 生产 storage/Postgres/vector index/BM25 未实现。
- ingestion pipeline 仍是本地 MVP，不是完整 source intake -> rewrite -> review -> publish 系统。
- tenant auth/permissions 仍是轻量参数，不是生产级权限模型。

## 4. 当前最高优先级 Backlog

| 优先级 | 项目 | 原因 | 完成证据 |
|---:|---|---|---|
| P0 | 刷新 GitHub auth scope 并 push | 没有 push 就无法 PR/CI/deploy/npm publish | `git push -u origin codex/osstack-report-foundation` 成功 |
| P0 | 创建 PR 并跑 CI | 把本地候选变成可审查变更 | PR URL + green CI |
| P0 | 部署 Knowledge Cloud 到真实云端 | Phase 6 需要“上线”而非本地 smoke | 生产 URL + `/healthz` + search smoke |
| P0 | npm publish 并从 registry 安装 | Phase 0 一行安装的最终验收 | `npm install -g @osstack/cli` 成功 |
| P1 | `CONFORMANCE_MATRIX.md` | 让 OSSTACK_RUN_SPEC_V1 的 MUST 条款可审计 | 每条 MUST 映射 schema/test/verifier |
| P1 | 真实 repo deliver e2e smoke | 证明 Product Entry 可处理实际项目 | 临时 repo 跑 deliver/loop/proof 成功 |
| P1 | Compliance report 从 proof dir 渲染 smoke | 证明 enterprise proof 包装闭环 | deliver proof dir 可渲染合规报告且不声称外部认证 |
| P2 | 单文件分发评估 | 可选增强，不阻塞 npm 主路径 | macOS arm64 binary + smoke |
| P2 | 交互式 TUI | 当前 cockpit 是 Web/summary + run/report/proof MVP | cockpit 中可 approve/retry 并提供完整交互式 TUI |

## 5. 外部阻塞记录

当前执行：

```sh
git push -u origin codex/osstack-report-foundation
```

仍失败：

```text
refusing to allow an OAuth App to create or update workflow `.github/workflows/ci.yml` without `workflow` scope
```

需要用户在本机执行：

```sh
gh auth refresh -h github.com -s workflow
```

授权后继续：

```sh
git push -u origin codex/osstack-report-foundation
gh pr create --draft --base main --head codex/osstack-report-foundation \
  --title "Upgrade osstack product foundation and knowledge cloud" \
  --body "Adds Loop evidence flows, official knowledge packs, Knowledge Cloud deploy assets, npm install smoke coverage, cockpit improvements, and release readiness evidence."
```

## 6. 下一步建议

在授权解除前，建议继续做本地可验证的 P1：

1. 为未来外部 `verify-results.json` / `worktree-status.json` 文件级 imports 增加 schema validation。
2. 继续补更多 negative/malformed vectors，覆盖坏的 manifest、policy decision、knowledge evidence。
3. 授权恢复后验证远端 CI 中的 `smoke:deliver-proof` 和 installed-CLI knowledge fallback smoke。

授权解除后，立即转入 P0：

1. push branch。
2. 创建 Draft PR。
3. 修 CI 差异。
4. 部署 Knowledge Cloud。
5. npm publish。
