# osstack 发布就绪证据与上线阻塞记录

> 日期：2026-06-22
> 分支：`codex/releasing-operator-docs`
> 本地验证 HEAD：`9fda27b ci: split macos release candidate smoke`

## 1. 结论

本分支已经把 osstack 升级方案中的核心可交付能力推进到“本地发布候选”状态：

- CLI、Loop、Knowledge Cloud、官方知识库、证据包、安装后 smoke 均已具备自动化验证。
- npm tarball 安装后的真实用户入口已经跑通，包括 `osstack --version`、`doctor`、`loop doctor`、`serve --install --no-load`、`deliver --worktree`、`report`、`scorecard`、`proof`、`knowledge eval`、`knowledge sources`、`osstack-knowledge-cloud --help`。
- portable CLI bundle 与 Bun single executable release archive candidate 已有自动化 smoke，可作为 npm 主路径之外的分发基础；本地 ad-hoc signing、SPDX SBOM、archive 解包运行已验证，CI/release workflow 已接入候选 artifact 生成，tag/workflow_dispatch 的 GitHub Release 上传路径已接入 dry-run smoke；发布级 single executable 仍需 Developer ID 签名、公证、跨机器验证、远端实际运行。
- 官方知识库已经从“借鉴 UmaDev 的 MIT 知识内容”升级为 osstack 自有官方知识包表达，包含来源治理、checksum、provenance 与检索评测。
- Knowledge Cloud 已具备本地服务 smoke、Docker/Fly/Render/GitHub Actions 部署资产 smoke。

尚未完成的部分不是代码验证，而是外部发布链路：

- GitHub push/PR 已恢复，Version Packages PR #5 当前为 `CLEAN / MERGEABLE`。
- GitHub Actions 当前被账户 billing/spending-limit 卡住，runner 在执行任何 step 前失败；PR #26 已记录本地验证证据，修复 billing 后需要 rerun CI；`release doctor` 已能自动识别该 blocker。
- npm 发布仍需要仓库 secret `NPM_TOKEN`。
- Knowledge Cloud `deploy=true` 仍需要仓库 secret `FLY_API_TOKEN`。

## 2. 已完成能力清单

| 领域 | 当前状态 | 证据 |
|---|---:|---|
| CLI 产品入口 | 已完成 | `osstack --version`、顶层 help、`loop --help`、`guide`、`examples --json` 在 npm 安装 smoke 中验证 |
| Product Entry / Deliver | 已完成安装后 smoke | `pnpm smoke:npm-install` 从 tarball 安装 CLI 后，在临时 git repo 跑 `osstack deliver --worktree --auto-agent --json`，验证 L4 report、proof manifest、verify pass、worktree merged evidence |
| Loop Engineering | 已完成本地闭环 | `pnpm smoke:loop` 通过；CLI 支持 `--loop` 读取 loop artifact，并校验 loop_id 防止误用 |
| Evidence / Proof | 已完成本地链路 | `report --loop`、`scorecard --loop`、`proof --loop` 在 npm 安装 smoke 中生成 markdown、manifest、zip |
| Knowledge Packs | 已完成官方包化 | 6 个 official packs 可加载、可列 source、可做 retrieval eval |
| Knowledge Cloud | 已完成本地服务与部署资产 | 本地服务 smoke 返回 6 official packs、1 private pack，并验证 sync/search/private/feedback；部署资产 smoke 检查 Dockerfile、Fly、Render、GitHub Actions |
| macOS launchd 安装 | 已完成安全 smoke | `serve --install --no-load`、`serve --status --no-load`、`serve --uninstall --no-load` 使用临时目录验证 |
| Portable CLI 分发 | 已完成过渡 smoke | `pnpm smoke:portable-cli` 验证 workspace tarballs 可安装进 portable prefix，并输出 single executable 候选工具状态 |
| Bun 单文件分发 | 已完成本地 release archive candidate smoke，已接 CI/release artifact | `pnpm build:single-binary` 生成 binary/manifest/checksum；`pnpm sbom:single-binary` 生成 SPDX 2.3 SBOM；`pnpm smoke:bun-single-binary` 验证 `--version`、`help`、`loop doctor --json`、sha256；`pnpm smoke:single-binary-signing` 验证 ad-hoc codesign；`pnpm smoke:single-binary-release-pack` 验证 tarball 可解包运行；release workflow 上传 candidate artifact |
| 测试体系 | 已完成当前门禁 | lint、build、test、smoke 全部通过 |
| 云端上线 | 未完成 | 需要修复 Actions billing、配置 `FLY_API_TOKEN`，然后运行 Knowledge Cloud `deploy=true` |
| npm 发布 | 未完成 | PR #5 已 `CLEAN / MERGEABLE`，但合并前必须配置 `NPM_TOKEN` |

## 3. 本轮验证命令

以下命令均在本地分支 `codex/releasing-operator-docs` 上执行。

| 命令 | 结果 | 关键输出 |
|---|---:|---|
| `pnpm lint` | 通过 | `Checked 161 files ... No fixes applied.` |
| `pnpm -r build` | 通过 | 15 of 16 workspace projects build succeeded |
| `pnpm test` | 通过 | CLI 136 tests、Loop 58 tests、Core 71 tests 等全部通过 |
| `pnpm smoke:knowledge-cloud:deploy` | 通过 | 检查 `Dockerfile.knowledge-cloud`、Fly、Render、GitHub Actions 部署资产 |
| `pnpm smoke:knowledge-cloud` | 通过 | health=`osstack-knowledge-cloud`，packs=`6`，private_packs=`1`，sync_packs=`6`，top_result=`proof-checksum-pack`，private_result=`private-release-approval`，feedback=`sent` |
| `pnpm smoke:npm-install` | 通过 | 15 个 tarballs；安装后 CLI、launchd dry-run、evidence、knowledge eval、Knowledge Cloud load、sync cache、cloud outage local fallback 全部验证 |
| `pnpm smoke:portable-cli` | 通过 | build `@osstack/cli`，生成临时 portable bundle，执行 `--version`、`help`、`loop doctor --json`，并报告 Node SEA/Bun/pkg/nexe/postject 候选状态 |
| `pnpm build:single-binary -- --output-dir <tmp> --json` | 通过 | 生成 `osstack-0.1.0-darwin-arm64`、manifest、`sha256sums.txt`；manifest 明确 `signed=false`、`notarized=false` |
| `pnpm smoke:bun-single-binary` | 通过 | Bun 1.3.13 编译 672 modules 成约 67MB 单文件；`--version` 输出 `osstack 0.1.0`，`loop doctor` 通过，并校验 manifest/checksum |
| `pnpm smoke:single-binary-signing` | 通过 | 生成 release candidate，ad-hoc `codesign`，`codesign --verify` 通过；manifest 记录 `signed=true`、`ad_hoc=true`、`notarized=false` |
| `pnpm smoke:single-binary-release-pack` | 通过 | 生成 `.tar.gz` archive、archive manifest、SPDX SBOM，校验 archive sha256，解包后 `osstack --version` 输出 `osstack 0.1.0`，manifest 记录 `github_release_uploaded=false` |
| `pnpm smoke:single-binary-release-publish` | 通过 | dry-run 验证 GitHub Release upload 输入：archive、archive manifest、sha256sums、SPDX SBOM；不访问 GitHub，不修改 upload 状态 |
| `.github/workflows/ci.yml` daily quality gate | 已拆到 Ubuntu，待远端 CI 运行 | lint、build、typecheck、test、Knowledge Cloud smoke、deploy asset smoke、deliver proof、npm install smoke |
| `.github/workflows/macos-release-candidate.yml` | 已新增，待远端 CI 运行 | macOS runner setup Bun 后执行 `pnpm smoke:single-binary-release-pack` |
| `.github/workflows/release.yml` single binary artifact step | 已接入，待远端 CI 运行 | 生成 signed ad-hoc archive candidate 并用 `actions/upload-artifact` 上传 14 天留存 artifact |
| `.github/workflows/single-binary-release.yml` formal upload path | 已接入，待远端 CI 运行 | tag `v*` 或手动触发；dry-run 可验证，非 dry-run 使用 `gh release upload` 上传正式 GitHub Release assets |
| `pnpm smoke:deliver-proof` | 通过 | 临时 git repo 跑 `deliver -> report -> scorecard -> proof -> compliance render -> pr dry-run`，证明 L4 evidence 与合规视图可从 proof dir 串起来 |
| `pnpm smoke:loop` | 通过 | `[smoke] ok workspace=...` |
| `node packages/cli/dist/bin.js knowledge eval --official --fixtures knowledge-evals/retrieval/osstack-core.json --json` | 通过 | total=`30`，passed=`30`，failed=`0`，top_k=`3` |

## 4. npm 安装后 smoke 覆盖范围

`pnpm smoke:npm-install` 是当前最接近真实用户安装路径的验证。它覆盖：

- 从 workspace build 所有包并 pack 出 tarballs。
- 在临时 prefix 下安装 CLI。
- 执行 `osstack --version`，确认安装后的二进制可用。
- 执行 `serve --install --no-load`，确认 launchd plist 可生成且不会触碰用户真实 LaunchAgents。
- 执行 `serve --status --no-load` 与 `serve --uninstall --no-load`，确认安装生命周期可逆。
- 执行产品 doctor 与 loop doctor。
- 在临时 git repo 中执行安装后的 `osstack deliver --worktree --auto-agent --json`。
- 校验 deliver 生成 L4 report、proof manifest、`verify-results.json` pass、`worktree-status.json` merged evidence。
- 检查 `loop --help` 暴露 `--proof`、`--knowledge`。
- 检查 `examples --json` 至少包含 6 个工作流，并覆盖 deliver/proof 入口。
- 检查 `guide` 中包含 doctor 与 proof view 引导。
- 构造临时 `LOOP-STATE.json`，验证 `report --loop`、`scorecard --loop`、`proof --loop` 生成证据产物。
- 运行官方知识库 retrieval eval，结果为 `30/30`。
- 检查 `knowledge sources --internal --official` 能返回 6 个带 provenance 的 official packs。
- 检查 `osstack-knowledge-cloud --help`。
- 检查 Knowledge Cloud 能加载 6 个 official packs，且 private packs 为 0。
- 用安装后的 CLI 从临时 Knowledge Cloud sync 6 个 official packs 到 cache，再用不可用 cloud URL 搜索，确认 fail-open 到 local cache 且命中 `proof-checksum-pack`。

## 5. Portable CLI 分发 smoke 覆盖范围

`pnpm smoke:portable-cli` 是 single executable 之前的过渡分发验证。它覆盖：

- build `@osstack/cli`。
- 将 workspace packages 打成 tarballs。
- 用 `npm install -g --prefix <bundle>` 安装到临时 portable prefix，生成 `bin/osstack` 和 `lib/node_modules`。
- 执行 `osstack --version`，验证 entrypoint 可启动。
- 执行 `osstack help`，验证产品命令暴露。
- 执行 `osstack loop doctor --workspace <tmp> --json`，验证 runtime 在 portable 目录外的真实 workspace 可运行。
- 输出 Node SEA、Bun、pkg、nexe、postject 的可用状态，作为后续单文件二进制方案评估输入。

这不是 macOS arm64 single executable，不应替代最终的单文件验收。它的价值是先证明当前 CLI 产物可以脱离 monorepo 运行，并给非 npm 分发提供一条低风险备用路径。

## 6. Bun 单文件 smoke 覆盖范围

`pnpm build:single-binary` 与 `pnpm smoke:bun-single-binary` 已经证明 osstack CLI 可以生成本地 single executable release candidate。它覆盖：

- build `@osstack/cli`。
- 读取 `packages/cli/package.json` 版本号，并通过 `OSSTACK_VERSION` 编译期注入。
- 使用 Bun `build --compile --env inline` 生成 `osstack-<version>-<platform>-<arch>`。
- 生成 `sha256sums.txt` 与 `*.manifest.json`。
- 生成 `*.sbom.spdx.json`，记录 CLI package、binary、release manifest、checksum 文件及 SHA-256。
- 执行 `osstack --version`，确认版本号不是 fallback `0.0.0`。
- 执行 `osstack help`，确认产品命令与证据命令暴露。
- 执行 `osstack loop doctor --workspace <tmp> --json`，确认单文件能在真实 workspace 上运行。
- 校验 binary SHA-256 与 manifest/checksum 文件一致。
- 校验 manifest 不声称本地构建已经签名或公证。
- `pnpm smoke:single-binary-signing` 会对 release candidate 做 ad-hoc codesign，运行 `codesign --verify`，并更新 manifest/checksum。
- `pnpm smoke:single-binary-release-pack` 会把 binary、manifest、checksum、SPDX SBOM 打成 `.tar.gz`，校验 archive SHA-256，解包后运行 `osstack --version`。
- `pnpm smoke:single-binary-release-publish` 会 dry-run 验证正式 GitHub Release 上传所需资产，不访问 GitHub、不修改 manifest upload 状态。
- `scripts/notarize-single-binary.mjs` 已新增，会把 Developer ID 签名后的命令行工具打成临时 zip，用 `xcrun notarytool submit --wait` 送交 Apple 公证，再用 `spctl --assess` 校验，并把 manifest 更新为 `notarized=true`。
- `.github/workflows/single-binary-release.yml` 已支持 tag `v*` 和手动触发；手动 dry-run 只校验资产，非 dry-run 会要求 Apple notarization 与 Developer ID 证书相关 secrets，导入临时 keychain 后重新签名、公证、重打包，再使用 `gh release upload`。
- `release doctor --target single-binary` 可单独检查 single-binary release 资产、Apple signing secrets 与 workflow 状态；`--target all` 也会包含该检查。覆盖 build/sign/notarize/SBOM/package/publish 脚本、release pack/publish smoke、tag/manual workflow、dry-run upload、`GH_TOKEN`、workflow artifact 留存，以及 `Single Binary Release` workflow 是否 active/最近 validation 是否成功。

当前产物是本地 release candidate，还不是可公开发布资产。上线前仍需要：

- 固定目标平台矩阵，先以 macOS arm64 为主。
- 配置 `APPLE_ID`、`APPLE_TEAM_ID`、`APPLE_APP_SPECIFIC_PASSWORD`、`DEVELOPER_ID_APPLICATION`、`MACOS_CERTIFICATE_P12`、`MACOS_CERTIFICATE_PASSWORD` repository secrets，并在远端 workflow 真实跑通 Developer ID codesign/notarization。
- 在干净机器上验证 `--version`、`doctor`、`serve --install --no-load`、`loop doctor`。
- 在远端执行 single-binary release workflow 并确认 GitHub Release assets 真实可下载；当前本地和 workflow artifact 只是候选包留存。

## 7. Knowledge Cloud 当前成熟度

当前 Knowledge Cloud 已经达到“可部署资产齐备、本地服务通过”的阶段：

- 有独立 package：`@osstack/knowledge-cloud`。
- 有 CLI/bin：`osstack-knowledge-cloud`。
- 有 health/search/pack loading 的服务测试。
- 有本地 smoke：启动服务、查询 health、加载 6 个 official packs、加载 1 个 team/private pack、验证 `/v1/sync`、验证 `/v1/private-packs`、验证 official/private 搜索、验证 `/v1/feedback`。
- 有部署资产 smoke：
  - `Dockerfile.knowledge-cloud`
  - `deploy/knowledge-cloud/fly.toml`
  - `deploy/knowledge-cloud/render.yaml`
  - `.github/workflows/knowledge-cloud-deploy.yml`
- `release doctor --target knowledge-cloud` 会静态检查部署资产是否完整：Dockerfile、Fly/Render healthcheck、feedback JSONL 持久化路径、workflow smoke、Docker build、`FLY_API_TOKEN` gate 与 Fly deploy 命令。

仍需上线后补齐：

- 真实云端 URL。
- 生产环境 secrets。
- GitHub Actions 实际运行记录。
- 可观测性仪表盘与告警。
- 正式知识包版本发布与回滚流程。

## 8. 官方知识库当前成熟度

官方知识库已经不再只是直接复刻外部项目资料，而是被加工为 osstack 官方知识包：

- 6 个 official packs 可通过 `knowledge sources --internal --official` 列出。
- 每个 official pack manifest 包含结构化 `source_provenance`。
- 测试会校验 source file SHA-256 与仓库文件匹配。
- retrieval eval 使用 `knowledge-evals/retrieval/osstack-core.json`，当前结果为 `30/30`。

这满足当前“UmaDev MIT 知识库变成 osstack 自己的云端知识库”的第一阶段要求：

- 内容进入 osstack 自有 pack 结构。
- 来源被记录和校验。
- 检索能力可量化。
- Knowledge Cloud 可以统一服务化加载。

后续应继续做内容层加工：

- 将外部痕迹进一步降到 provenance 与 license 层，不在用户可见说明中强调 UmaDev。
- 将知识块改写为 osstack 的产品语言、工作流语言、CLI 语言。
- 对每个 pack 建立 owner、version、release note、quality score。
- 在云端增加私有包、团队包、用户包隔离。

## 9. GitHub / 上线阻塞

GitHub push、PR、workflow 定义已恢复。当前发布阻塞不是代码问题，而是账户级 Actions 与生产发布凭证尚未配置：

- GitHub Actions runner 启动前失败：`recent account payments have failed or your spending limit needs to be increased`。
- npm publish 需要仓库 secret `NPM_TOKEN`。
- Knowledge Cloud `deploy=true` 需要仓库 secret `FLY_API_TOKEN`。
- 本机人工发布/排障还需要 `npm login` 与 `flyctl auth login`。
- `release doctor` 会输出 `github_actions` error；`release plan` 会把修复 Billing / spending limit 放入 blockers 和 operator commands。

发布前执行：

```sh
osstack release doctor --json
```

当前 `release doctor` 会额外检查发布列车状态：

- `npm_publish_assets`：检查 `@osstack/cli` package 元数据、changeset 与 release workflow 的 publish/provenance/`NPM_TOKEN`/安装 smoke 约束，失败时会阻止 `npm_publish` ready。
- `version_packages_pr`：识别 `changeset-release/main` 的 Version Packages PR，输出 PR number、URL、draft 状态和 `merge_state`。当前真实状态为 PR #5 `CLEAN / MERGEABLE`，CI run `27957659115` 已成功；仍需等 `NPM_TOKEN` 配好后再合并。
- `knowledge_cloud_deploy_assets`：检查 Knowledge Cloud Dockerfile、Fly/Render 配置和 GitHub Actions deploy workflow 的关键部署约束，失败时会阻止 `knowledge_cloud_deploy` ready。
- `knowledge_cloud_workflow`：识别 `Knowledge Cloud Deploy` workflow 是否存在、是否 active，以及最近一次验证 run 的状态。当前最近一次 validation run 为 success，但 `deploy=true` 仍需要 `FLY_API_TOKEN`。
- `single_binary_release_assets`：在 `--target single-binary` 或 `--target all` 时检查单文件 GitHub Release 资产链路，包括公证脚本和 workflow 的 Apple/Developer ID gate，失败时会阻止对应发布行动计划。
- `single_binary_workflow`：识别 `Single Binary Release` workflow 是否存在、是否 active，以及最近一次 dry-run / release run 的状态。

也可以输出 Markdown handoff artifact：

```sh
osstack release doctor --output release-readiness.md --json
```

该报告包含 readiness summary、检查表、检查详情和 next steps，适合贴到 PR、发布群或 CI artifact。

需要把状态转换成可执行 runbook 时，使用：

```sh
osstack release plan --target all --output release-plan.md --json
```

如果要固定某个已审核 proof pack，不依赖 workspace 下的自动发现结果，可以显式传入：

```sh
osstack release plan --target all --proof-dir release/osstack-proof-<run_id> --output release-plan.md --json
```

该计划会列出 blockers、validation commands、npm publish commands 和 Knowledge Cloud deploy commands；当传入 `--proof-dir` 时，release readiness 与 proof validate 命令都会绑定同一个证据目录。它不会执行发布动作，只生成上线步骤。

NPM 目标的 validation commands 会包含：

```sh
pnpm smoke:npm-install
```

Knowledge Cloud 目标的 validation commands 会包含：

```sh
pnpm smoke:knowledge-cloud:deploy
gh workflow run "Knowledge Cloud Deploy" --ref main -f deploy=false
```

`--target single-binary` 和 `--target all` 的 validation commands 还会包含：

```sh
pnpm smoke:single-binary-release-pack
pnpm smoke:single-binary-release-publish
gh workflow run "Single Binary Release" --ref main -f tag=v<version> -f dry_run=true
```

## 10. 推荐上线步骤

### Step 1：配置发布凭证

执行：

```sh
osstack release doctor --json
```

验收：

- `NPM_TOKEN` 显示 ready 后再合并 Version Packages PR。
- `FLY_API_TOKEN` 显示 ready 后再运行 Knowledge Cloud `deploy=true`。

### Step 2：修复 GitHub Actions billing 并 rerun PR #26

验收：

- GitHub Billing / spending limit 恢复正常。
- PR #26 CI runner 能启动并执行 steps。
- PR #26 CI 通过后合并。

### Step 3：等待 CI 并修复差异

验收：

- GitHub Actions 全绿。
- 本地 smoke 与 CI 结果一致。
- 如 CI 环境暴露 macOS/Linux 差异，优先修正 smoke 脚本的跨平台假设。

### Step 4：部署 Knowledge Cloud

根据选择的平台执行：

- Fly.io：使用 `deploy/knowledge-cloud/fly.toml`。
- Render：使用 `deploy/knowledge-cloud/render.yaml`。
- GitHub Actions：使用 `.github/workflows/knowledge-cloud-deploy.yml`。

验收：

- 获得生产 URL。
- `/health` 返回正常。
- official packs 数量为 6。
- search 返回预期 top result。
- 生产环境日志无启动错误。

### Step 5：发布 npm 包

验收：

- release workflow 或手动 release 流程完成。
- npm 上可安装 osstack CLI。
- 用真实 npm 安装路径复跑：

```sh
npm install -g @osstack/cli
osstack --version
osstack doctor
osstack knowledge eval --official --fixtures knowledge-evals/retrieval/osstack-core.json --json
```

### Step 6：上线后回归

上线后必须保留一份最终证据：

- PR URL。
- CI run URL。
- Knowledge Cloud URL。
- npm package URL。
- 本地与云端 smoke 输出摘要。
- 已知限制和下一阶段 backlog。

## 9. 下一阶段产品升级建议

本分支让 osstack 从“规划升级”进入“可验证产品骨架”。下一阶段应集中补齐三块：

| 方向 | 目标 | 验收 |
|---|---|---|
| TUI / Live Workbench | 把当前 CLI 能力变成更精致的操作台 | 能从任务、Loop、Evidence、Knowledge 四个视角进入同一工作流 |
| 云端知识库 | 把 official/private/team packs 服务化、权限化、版本化 | 支持 pack publish、search、provenance、eval、rollback |
| 合规包装 | 把 provenance、license、policy、audit 输出变成用户可理解资产 | 每个证据包都能说明来源、权限、风险、可复现性 |

优先级建议：

1. 先解除 GitHub Actions billing 阻塞，并合并 PR #26。
2. 配置 `NPM_TOKEN` 与 `FLY_API_TOKEN`。
3. 再真实部署 Knowledge Cloud，拿到 URL。
4. 再发布 npm package，并从 registry 复跑安装 smoke。
5. 再做 TUI / Live Workbench，因为 UI 需要稳定后端能力支撑。
6. 最后强化合规包装，让 osstack 的知识库与证据包可以进入团队/商业使用场景。
