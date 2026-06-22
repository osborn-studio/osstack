# osstack 升级开发主计划实现审计

> 日期：2026-06-22
> 目标文档：`/Users/gilbertchen/Documents/CODE/agentsteam/osstack/docs/2026-06-22-osstack-upgrade-development-plan.md`
> 审计分支：`codex/releasing-operator-docs`
> 审计 HEAD：`9fda27b ci: split macos release candidate smoke`

## 1. 审计结论

当前分支已经把升级计划中的核心闭环推进到“本地可验证发布候选”状态：

- Phase 1 Evidence Layer、Phase 2 Product Entry、Phase 3 Governed Run、Phase 4 Learning Control Plane、Phase 6 的 Knowledge Cloud/Compliance 大部分已经有代码、命令和测试。
- 最关键的端到端路径已经跑通：`deliver/loop -> report -> scorecard -> proof -> pr body -> knowledge trace -> compliance render`。
- npm 安装后的真实用户路径已有 smoke：tarball pack/install、CLI 二进制、launchd dry-run、doctor、loop doctor、evidence commands、official knowledge eval、Knowledge Cloud package loading、cloud sync cache、cloud outage local fallback。
- Knowledge Cloud 已具备 official/private pack HTTP 服务、sync/search/feedback endpoint、部署资产和本地 smoke。

仍未完成的部分集中在外部发布和产品深化：

- GitHub push/PR 已恢复，Version Packages PR #5 当前为 `CLEAN / MERGEABLE`，但 GitHub Actions 在账户层被 billing/spending-limit 阻塞，runner 尚不能启动；`release doctor` 已新增 `github_actions` 检查并能把该阻塞写入 `release plan`。
- npm publish 仍需要仓库 secret `NPM_TOKEN`；Knowledge Cloud `deploy=true` 仍需要仓库 secret `FLY_API_TOKEN`。
- 日常 PR CI 已拆到 `ubuntu-latest`，macOS single-binary release-candidate smoke 已拆到独立 `.github/workflows/macos-release-candidate.yml`，正式 release workflow 仍保留 macOS archive candidate artifact。
- `npm install -g @osstack/cli` 还没有从真实 npm registry 验证，只验证了本地 tarball 安装。
- 可选单文件分发已有 portable CLI bundle smoke、Bun single executable smoke、本地 release asset manifest/checksum/SPDX SBOM、ad-hoc codesign 验证、`.tar.gz` release archive smoke，并已接入 CI/release workflow candidate artifact 与 tag/workflow_dispatch GitHub Release 上传路径；发布级 Developer ID 签名/公证/跨机器验证尚未完成。
- Cockpit 当前是 dashboard/web cockpit + CLI summary，不是完整交互式 TUI。
- Knowledge Cloud 的 ingestion/rewrite/review/publish 生产流水线仍是 MVP/本地包化阶段，还不是完整云端运营系统。

## 2. Phase 完成矩阵

| Phase | 计划目标 | 当前状态 | 证据 | 剩余工作 |
|---|---|---:|---|---|
| Phase 0 Distribution | 一行安装 + daemon install + 可选单文件分发 | 部分完成 | `scripts/smoke-npm-install.mjs` 验证本地 tarball install；`serve --install --no-load` 验证 launchd plist 生命周期；`scripts/smoke-portable-cli.mjs` 验证 portable bundle；`scripts/build-single-binary.mjs` 生成 Bun single executable release candidate；`scripts/generate-single-binary-sbom.mjs` 生成 SPDX SBOM；`scripts/smoke-bun-single-binary.mjs` 验证 manifest/checksum/runtime；`scripts/smoke-single-binary-signing.mjs` 验证 ad-hoc codesign；`scripts/smoke-single-binary-release-pack.mjs` 验证 release archive 可解包运行；`scripts/smoke-single-binary-release-publish.mjs` dry-run 验证 release upload inputs；CI/release workflow 已接 candidate artifact 与 formal upload path | 真实 npm publish；真实 `npm install -g @osstack/cli`；Developer ID 签名/公证/跨机器验证/远端正式 GitHub Release asset |
| Phase 1 Evidence Layer | report + scorecard + proof + subprocess-first adapters | 基本完成 | `report-cli.test.ts`、`scorecard-cli.test.ts`、`proof-cli.test.ts`、`agent-list-cli.test.ts`、npm install smoke | daemon event-rich report 仍需更多真实运行样本验证 |
| Phase 2 Product Entry | `osstack deliver` + agent 角色化 | 基本完成 | `deliver-cli.test.ts`、`product-entry-cli.test.ts`、`agent-scorecard-cli.test.ts`、`smoke:npm-install` 安装后 deliver/worktree/proof smoke | 可继续在外部真实业务 repo 上扩展长任务 smoke |
| Phase 3 Governed Run | Run Spec + governance verifier + PR evidence | 基本完成 | `docs/specs/OSSTACK_RUN_SPEC_V1.md`、`docs/specs/CONFORMANCE_MATRIX.md`、schemas/test vectors、`governance-cli.test.ts`、`pr-cli.test.ts` | 继续随新 MUST 条款补 runtime/schema/vector 覆盖 |
| Phase 4 Learning Control Plane | Pitfall KB + Knowledge bootstrap + agent scorecard | 基本完成 | `lessons-cli.test.ts`、`knowledge-cli.test.ts`、`agent-scorecard-cli.test.ts` | pitfall 自动提升 verified_count 的真实 loop 闭环需继续增强 |
| Phase 5 Product Surface | Cockpit/TUI + examples/guide/doctor + i18n + checkpoint | 部分到基本完成 | `dashboard.ts`、`dashboard-cli.test.ts`、`product-entry-cli.test.ts`、`i18n-cli.test.ts`、`proof-cli.test.ts`、`compliance-cli.test.ts`、`checkpoint-cli.test.ts` | 完整交互式 TUI 未完成；更深层报告模板/运营内容本地化仍可扩展 |
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
- `release doctor --target npm` 已接入 `npm_publish_assets` 静态 preflight，检查 `@osstack/cli` package 元数据、changeset、release workflow 的 changesets action、`pnpm smoke:npm-install`、npm provenance、`NPM_TOKEN` 与 `NODE_AUTH_TOKEN` 发布约束；`release plan` 的 npm validation commands 也会列出 `pnpm smoke:npm-install`。

未完成：

- 还没有真实 npm registry 发布。
- 还没有从 npm registry 执行 `npm install -g @osstack/cli`。
- GitHub push/CI/release workflow 已恢复；真实 npm publish 仍需要仓库 secret `NPM_TOKEN`，可用 `osstack release doctor --target npm --json` 做发布前置检查。

下一步：

1. 配置仓库 secret `NPM_TOKEN`。
2. 跑 `osstack release doctor --target npm --json`。
3. CI 通过后跑 release workflow 或合并 changesets Version Packages PR。
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

状态：本地 smoke 完成，发布级分发未完成。

证据：

- `scripts/smoke-portable-cli.mjs` 已新增，验证 workspace packages build/pack 后可以被安装进临时 portable prefix。
- portable bundle 包含 `bin/osstack`、`lib/node_modules/@osstack/cli/dist/bin.js`、`lib/node_modules`，并实际执行 `osstack --version`、`osstack help`、`osstack loop doctor --json`。
- `scripts/build-single-binary.mjs` 已新增，可生成 `osstack-<version>-<platform>-<arch>`、`sha256sums.txt`、`*.manifest.json`。
- `scripts/sign-single-binary.mjs` 已新增，可对 manifest 指向的 binary 执行 `codesign` 并更新 manifest/checksum。
- `scripts/notarize-single-binary.mjs` 已新增，可在 Developer ID 签名后把命令行工具打成临时 zip，使用 `xcrun notarytool submit --wait` 送交 Apple 公证，再用 `spctl --assess` 完成正式 macOS 公证校验，并把 manifest 标记为 `notarized=true`。
- `scripts/generate-single-binary-sbom.mjs` 已新增，可生成 SPDX 2.3 JSON SBOM，记录 binary、manifest、checksum 文件及 SHA-256。
- `scripts/package-single-binary.mjs` 已新增，可把 binary、manifest、`sha256sums.txt` 打成 `osstack-<version>-<platform>-<arch>.tar.gz`，并生成 archive manifest。
- `scripts/publish-single-binary-release.mjs` 已新增，可 dry-run 验证或使用 `gh release upload` 上传 archive assets。
- `scripts/smoke-bun-single-binary.mjs` 已新增，使用 Bun `build --compile` 生成临时单文件可执行文件，并实际执行 `osstack --version`、`osstack help`、`osstack loop doctor --json`。
- smoke 会校验 manifest kind、binary sha256、checksum 文件，并明确 manifest 中 `signed=false`、`notarized=false`。
- `scripts/smoke-single-binary-signing.mjs` 已新增，执行本地 ad-hoc signing、`codesign --verify`、`osstack --version`，并确保 manifest 不声称 notarization。
- `scripts/smoke-single-binary-release-pack.mjs` 已新增，执行 build -> ad-hoc sign -> package -> `tar -tzf` -> extract -> `osstack --version`，并确保 archive manifest 不声称 GitHub Release 上传。
- `scripts/smoke-single-binary-release-publish.mjs` 已新增，dry-run 验证 GitHub Release upload inputs，不访问 GitHub。
- `.github/workflows/ci.yml` 已改为 Ubuntu 日常质量门，不再为普通 PR 强制跑 macOS release archive smoke。
- `.github/workflows/macos-release-candidate.yml` 已新增，负责 macOS single-binary release-candidate smoke，可在主线相关路径变更或手动触发时运行。
- `.github/workflows/release.yml` 已接入 single-binary archive candidate build/sign/package，并通过 `actions/upload-artifact` 上传 workflow artifact。
- `.github/workflows/single-binary-release.yml` 已新增，支持 tag `v*` 或手动触发，dry-run 验证或正式 `gh release upload`；非 dry-run 路径现在要求 Apple notarization 与 Developer ID 证书 secrets，导入临时 keychain 后重新签名、公证、重打包。
- CLI entrypoint 已兼容 Bun 虚拟文件系统路径；版本号通过 `OSSTACK_VERSION` 编译期注入，避免 single executable 运行时找不到 `package.json` 后退到 `0.0.0`。
- portable smoke 会输出 Node SEA、Bun、pkg、nexe、postject 的本机候选状态，给后续分发策略留出机器可读证据。
- `release doctor --target single-binary` 已接入独立的 `single_binary_release_assets` 静态 preflight、Apple/Developer ID repository secrets gate 和 `single_binary_workflow` 远端 workflow 检查，`--target all` 也会包含该检查；它会检查 build/sign/notarize/SBOM/package/publish 脚本、release pack/publish smoke、tag/manual workflow、dry-run upload、`GH_TOKEN`、workflow artifact 留存，以及 `Single Binary Release` workflow 是否 active / 最近 validation 是否成功；`release plan --target single-binary` 和 `--target all` 的 validation commands 会列出 `pnpm smoke:single-binary-release-pack`、`pnpm smoke:single-binary-release-publish` 与 Single Binary Release dry-run workflow。
- 当前仍没有远端 Developer ID codesign/notarization 成功记录、跨机器安装验证、正式 GitHub Release 上传。

建议：

- 保持 npm 为主路径。
- 将 portable bundle 作为“无全局 npm 安装”的备用分发形态。
- 将 Bun single executable 作为首选单文件路线继续产品化。
- 后续配置 Apple/Developer ID repository secrets，跑通远端 Single Binary Release 非 dry-run 路径，并补齐跨机器 smoke。

### Task 1.1 - 1.4：Report / Scorecard / Proof

状态：基本完成。

已完成：

- `osstack report`、`osstack scorecard`、`osstack proof` 命令存在。
- 支持 `--loop` artifact id，并校验 `LOOP-STATE.json` 的 loop_id，避免误读证据。
- proof pack 包含 manifest、report、scorecard、loop state、governance/knowledge results、sha256sums。
- `proof view` 支持 audience-oriented evidence views。
- `osstack proof validate <run_id>` 支持对 proof pack 做机器可读结构门禁，默认检查 proof-core，也可通过 `--pack` 或 `--audience` 复用 compliance/proof-view 控制项。
- `osstack release plan --workspace <workspace>` 会复用 release doctor 的 workspace proof 检查；也支持 `--proof-dir <proof_dir>` 固定某个已审核 proof pack，并把 release doctor / proof validate validation commands 绑定到同一个证据目录，避免上线时误读自动发现的旧证据。
- `osstack release doctor --proof-dir <proof_dir>` 会执行 proof-core 校验；未传 `--proof-dir` 时会从 `--workspace`/当前目录的 `release/osstack-proof-*` 自动发现最新 proof dir。缺失或 malformed evidence 会输出 `proof_validation` error，让 release readiness 失败并进入 next steps。
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
- `smoke:npm-install` 会从 workspace tarballs 安装 CLI 后，在临时 git repo 中运行 `osstack deliver --worktree --auto-agent --json`，并校验 L4 report、proof manifest、verify pass、worktree merged evidence。

需增强：

- 在真实外部业务 repo 上做更长任务的 execute-loop smoke。
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

已增强：

- `docs/specs/CONFORMANCE_MATRIX.md` 已把 R-001 到 R-014 映射到 schema、test vector、deterministic verifier、smoke 或 CLI test。
- `run-spec-files.test.ts` 会防止矩阵遗漏 stable clause、回退到旧的 `workflow-scope push` blocker 文案，并要求记录 installed-CLI deliver smoke 与当前 GitHub Actions billing blocker。

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
- 支持 `cockpit retry` 从失败/升级的 loop state task 重新入队，保留原任务、loop、agent、error/verify 摘要上下文。
- 支持 `cockpit approve` 将 kanban card 标记为 done，并可追加审批 comment。
- 支持 `cockpit report` 从 loop evidence 生成 report。
- 支持 `cockpit proof` 从 loop evidence 生成 proof pack，并可 `--open` 打开 proof 目录。
- Web dashboard 展示 active runs、queued tasks、active loops、agents、kanban、reports/proof packs、lessons、scorecards。
- CLI cockpit summary 展示 actionable next steps，包含 ready/running/blocked 状态、下一步标签和执行路径说明。
- 支持 `cockpit next` / `dashboard next` 单独输出 actionable next steps，并支持 `--status ready|running|blocked` 过滤与 `--json` 给后续 TUI/脚本复用；每条 next step 包含可复制建议命令。

未完成：

- 还不是完整交互式 TUI；当前是 Web cockpit + script-friendly CLI summary + cockpit action commands。

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
- cockpit/report/scorecard/proof view/compliance render 相关文案有中英文路径。
- `i18n-cli.test.ts` 存在。
- `proof view --lang zh-CN` 已覆盖中文标题、受众、缺失证据说明、表头和 auditor 关注点文案。
- `compliance render --lang zh-CN` 已覆盖中文标题、运行、映射包、外部认证声明、免责声明、表头和内部映射说明。
- 所有内置 compliance packs 已补齐 control 级 `title_zh` / `description_zh`，中文 compliance render 会使用中文控制项标题和描述。
- `proof view --lang zh-CN` 会对默认 `engineering-readiness` 证据视图使用中文控制项标题。

需增强：

- 更深层报告模板、运营说明、客户交付文案仍可继续系统化本地化。

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
- `smoke:deliver-proof` 已从真实 deliver proof dir 渲染 `engineering-readiness` 与 `soc2-lite` compliance reports，并校验 proof manifest checksum evidence mapping 以及 lite pack 不声称外部认证。

需增强：

- 如果要把 compliance report 默认打进 proof pack，还需要新增产品选项或默认策略；当前已验证的是 proof dir 可生成可引用合规视图。

### Task 6.2：Enterprise proof views

状态：基本完成。

已完成：

- `osstack proof view <run_id> --audience engineer|manager|auditor|customer` 存在。
- 视图基于已有 proof evidence，不生成假证据。
- proof/compliance 的结构级证据检查已抽成 `validateProofEvidence`，可复用地输出 `present` / `missing` 控制项，并由 `osstack proof validate` 作为上线前门禁使用。

需增强：

- 缺失证据的“红色/高亮”在 Markdown/HTML 视图中可继续增强。

### Task 6.3：Osstack Knowledge Cloud

状态：部分到基本完成。

已完成：

- `@osstack/knowledge-cloud` package 存在。
- HTTP endpoints 存在：`/healthz`、`/v1/packs`、`/v1/sync`、`/v1/private-packs`、`/v1/search`、`/v1/feedback`。
- official packs 6 个，retrieval eval 30/30。
- official packs 有 version、quality_score、last_reviewed_at、source_provenance。
- publish gate 会阻止 official/external `processed_mit` 知识包继续使用裸上游 `MIT` 许可标签，要求显式标记为 Osstack processed/derived license label，避免把上游知识库痕迹直接发布成 official pack。
- 私有知识包 HTTP 访问要求 bearer token + 显式 `tenant_id`，无 tenant 的 `/v1/private-packs` 请求会被拒绝，私有 search 只有在授权且 tenant 明确时才合入 tenant-scoped private packs，避免未绑定 tenant 的私有包被泛授权搜索泄露。
- Knowledge Cloud 支持 tenant-bound private tokens：`osstack-knowledge-cloud --private-tenant-token tenant=token` 和 `OSSTACK_KNOWLEDGE_PRIVATE_TENANT_TOKENS_JSON` 可把私有知识包访问绑定到具体 tenant，错误 tenant token 无法读取目标 tenant 的 private packs；旧的 `--private-token` 仍作为兼容的全局 private token。
- feedback entry 支持记录 `tenant_id` 与 `authorized`，CLI `knowledge feedback` 支持 `--tenant`，云端 `/v1/feedback` 会把 tenant/auth 范围写入 sink 与响应，便于后续做知识质量审计和租户级反馈分析。
- 云端服务支持 `/v1/feedback/summary`，可按 `tenant_id` 聚合 useful/bad/total 和 chunk 级反馈计数；Knowledge Cloud smoke 已覆盖 tenant feedback summary。
- `osstack-knowledge-cloud` 支持 `--feedback-log` / `OSSTACK_KNOWLEDGE_FEEDBACK_LOG` 将 feedback entry 追加写入 JSONL，并在启动时预加载既有 JSONL 作为 summary 初始状态；Fly/Render 部署配置默认使用 `/data/feedback/feedback.jsonl`，deploy asset smoke 会检查该落盘路径。
- Knowledge search result 会返回 `matched_terms`，本地检索和云端检索 validator 均已覆盖，prompt snippet 会携带命中词，便于 proof/report 解释 chunk 为什么被检索命中。
- 本地与云端共用的 `searchKnowledgePacks` 已从简单词频排序升级为 BM25-style 排序：考虑 query term 文档频率、chunk 长度归一化和 pack quality score，并覆盖“稀有词完整命中优先于重复通用词”的回归测试。
- CLI 支持 cloud login/sync/search/import/ingest/pin/feedback/sources。
- 本地 smoke 验证 official/private packs、sync、search、feedback。
- deploy assets 存在：Dockerfile、Fly、Render、GitHub Actions；`release doctor --target knowledge-cloud` 已接入 `knowledge_cloud_deploy_assets` 静态 preflight，检查 Dockerfile、Fly/Render healthcheck、feedback JSONL 持久化路径、workflow smoke、Docker build、`FLY_API_TOKEN` gate 与 Fly deploy 命令；传入 `--cloud-url <url>` 时还会访问 `<url>/healthz` 并要求 HTTP 2xx、`ok=true`、`service=osstack-knowledge-cloud`，同时用默认 `proof pack checksum` 查询 `<url>/v1/search` 并要求至少 1 条结果；`release plan` 的 Knowledge Cloud validation commands 也会列出 `pnpm smoke:knowledge-cloud:deploy`。

未完成：

- 真实云端域名/URL 未上线；`--cloud-url` health + search gate 已具备，但尚无生产 URL 通过记录。
- 生产 storage/Postgres/vector index 未实现；BM25-style 本地/云端共享排序已作为 MVP 检索排序落地。
- ingestion pipeline 仍是本地 MVP，不是完整 source intake -> rewrite -> review -> publish 系统；当前已有 publish gate 可检查 Osstack voice、provenance、source_refs、quality/review/taxonomy 与 processed license label。
- tenant auth/permissions 已有 global token、tenant-bound token 与 explicit tenant scope 的本地 HTTP gate，但仍不是完整生产级账号、组织、角色、审计日志权限模型。

## 4. 当前最高优先级 Backlog

| 优先级 | 项目 | 原因 | 完成证据 |
|---:|---|---|---|
| P0 | 修复 GitHub Actions billing/spending limit | 当前 runner 在账户层启动前失败，PR #26 无法变绿；`release doctor` 已能自动识别该 blocker | PR #26 CI rerun 后 runner 正常启动并通过 |
| P0 | 配置 `NPM_TOKEN` | 没有 npm publish secret 不能合并 Version Packages PR | `osstack release doctor --target npm --json` ready |
| P0 | 配置 `FLY_API_TOKEN` | 没有 Fly deploy secret 不能运行 Knowledge Cloud `deploy=true` | `osstack release doctor --target knowledge-cloud --json` ready |
| P0 | 部署 Knowledge Cloud 到真实云端 | Phase 6 需要“上线”而非本地 smoke | 生产 URL + `release doctor --target knowledge-cloud --cloud-url <url>` health/search gate |
| P0 | npm publish 并从 registry 安装 | Phase 0 一行安装的最终验收 | `npm install -g @osstack/cli` 成功 |
| P1 | `CONFORMANCE_MATRIX.md` 持续维护 | 让 OSSTACK_RUN_SPEC_V1 的 MUST 条款可审计 | 每条新增/变更 MUST 同步 schema/test/vector/verifier/smoke 映射 |
| P1 | 真实 repo deliver e2e smoke | 证明 Product Entry 可处理实际项目 | `pnpm smoke:real-repo-deliver` 在带 `package.json` 和 `node --test` 的临时 git repo 中跑 deliver/worktree/`npm test`/proof 成功，并已接入 CI |
| P1 | Compliance report 从 proof dir 渲染 smoke | 证明 enterprise proof 包装闭环 | 已覆盖真实 deliver proof dir 渲染 `engineering-readiness` 与 `soc2-lite`，且不声称外部认证 |
| P2 | 单文件 release asset 产品化 | 可选增强，不阻塞 npm 主路径；Bun single executable 本地 release archive candidate 已有 manifest/checksum/SPDX SBOM/ad-hoc signing/extract smoke，workflow artifact 与 formal upload path 已接入 | macOS arm64 Developer ID signed/notarized asset + cross-machine smoke + remote formal GitHub Release proof |
| P2 | 交互式 TUI | 当前 cockpit 是 Web/summary + run/retry/approve/report/proof MVP | 提供完整交互式 TUI |

## 5. 外部阻塞记录

当前执行：

```sh
GitHub push、PR、release workflow 定义已恢复。当前阻塞点是账户级 Actions 与真实发布凭证：

- GitHub Actions runner 启动前失败：`recent account payments have failed or your spending limit needs to be increased`。
- npm registry publish 需要仓库 secret `NPM_TOKEN`。
- Knowledge Cloud `deploy=true` 需要仓库 secret `FLY_API_TOKEN`。
- 本地人工排障可继续配置 `npm login` 与 `flyctl auth login`。
- `osstack release doctor --json` 当前会输出 `github_actions` error，并让 `release plan` 保持 `safe_to_execute=false`。

发布前检查：

```sh
osstack release doctor --json
```

## 6. 下一步建议

在发布凭证补齐前，建议继续做本地可验证的 P1：

1. 继续给 `osstack proof validate` 增加更多 negative/malformed vectors；当前 proof/compliance 的结构级证据检查已抽成可复用 validator，proof view/compliance render 会把 malformed manifest、verify、policy、agent runtime、governance、worktree、knowledge evidence 标成 `MISSING`，release plan 已输出 proof validate 命令并支持 `--workspace` 自动 proof 检查和显式 `--proof-dir` 覆盖，release doctor 已支持显式 `--proof-dir` 和最新 proof dir 自动发现。
2. 继续补更多 negative/malformed vectors，覆盖边界格式、旧版本兼容字段、外部 proof 目录导入场景。
3. 继续强化 release doctor、Knowledge Cloud deploy preflight、npm publish preflight；当前 release doctor 已能识别 Version Packages PR #5 的 `CLEAN / MERGEABLE` 状态，检查 NPM publish assets、Knowledge Cloud deploy assets 和 single-binary release assets，显示 Knowledge Cloud Deploy workflow 最近一次 validation run，通过 `--output` 生成 Markdown 发布行动清单，并通过 `release plan` 生成验证/发布/部署命令 runbook。

授权解除后，立即转入 P0：

1. 修复 GitHub Actions billing/spending limit。
2. rerun PR #26 CI 并合并。
3. 配置 `NPM_TOKEN` 与 `FLY_API_TOKEN`。
4. 部署 Knowledge Cloud。
5. npm publish。
