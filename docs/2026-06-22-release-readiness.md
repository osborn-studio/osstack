# osstack 发布就绪证据与上线阻塞记录

> 日期：2026-06-22  
> 分支：`codex/osstack-report-foundation`  
> 本地验证 HEAD：`b4487bb ci: smoke launchd install after npm install`

## 1. 结论

本分支已经把 osstack 升级方案中的核心可交付能力推进到“本地发布候选”状态：

- CLI、Loop、Knowledge Cloud、官方知识库、证据包、安装后 smoke 均已具备自动化验证。
- npm tarball 安装后的真实用户入口已经跑通，包括 `osstack --version`、`doctor`、`loop doctor`、`serve --install --no-load`、`report`、`scorecard`、`proof`、`knowledge eval`、`knowledge sources`、`osstack-knowledge-cloud --help`。
- portable CLI bundle 与 Bun single executable 已有自动化 smoke，可作为 npm 主路径之外的分发基础；发布级 single executable 仍需签名、公证、checksum、跨机器验证。
- 官方知识库已经从“借鉴 UmaDev 的 MIT 知识内容”升级为 osstack 自有官方知识包表达，包含来源治理、checksum、provenance 与检索评测。
- Knowledge Cloud 已具备本地服务 smoke、Docker/Fly/Render/GitHub Actions 部署资产 smoke。

尚未完成的部分不是代码验证，而是外部发布链路：

- GitHub push 被当前 `gh` OAuth token 缺少 `workflow` scope 阻塞。
- 因为无法 push，PR、GitHub Actions、Knowledge Cloud 真实云端部署、npm 发布流程还不能启动。

## 2. 已完成能力清单

| 领域 | 当前状态 | 证据 |
|---|---:|---|
| CLI 产品入口 | 已完成 | `osstack --version`、顶层 help、`loop --help`、`guide`、`examples --json` 在 npm 安装 smoke 中验证 |
| Loop Engineering | 已完成本地闭环 | `pnpm smoke:loop` 通过；CLI 支持 `--loop` 读取 loop artifact，并校验 loop_id 防止误用 |
| Evidence / Proof | 已完成本地链路 | `report --loop`、`scorecard --loop`、`proof --loop` 在 npm 安装 smoke 中生成 markdown、manifest、zip |
| Knowledge Packs | 已完成官方包化 | 6 个 official packs 可加载、可列 source、可做 retrieval eval |
| Knowledge Cloud | 已完成本地服务与部署资产 | 本地服务 smoke 返回 6 official packs、1 private pack，并验证 sync/search/private/feedback；部署资产 smoke 检查 Dockerfile、Fly、Render、GitHub Actions |
| macOS launchd 安装 | 已完成安全 smoke | `serve --install --no-load`、`serve --status --no-load`、`serve --uninstall --no-load` 使用临时目录验证 |
| Portable CLI 分发 | 已完成过渡 smoke | `pnpm smoke:portable-cli` 验证 workspace tarballs 可安装进 portable prefix，并输出 single executable 候选工具状态 |
| Bun 单文件分发 | 已完成本地 smoke | `pnpm smoke:bun-single-binary` 生成临时 single executable，验证 `--version`、`help`、`loop doctor --json` |
| 测试体系 | 已完成当前门禁 | lint、build、test、smoke 全部通过 |
| 云端上线 | 未完成 | push 被 GitHub OAuth `workflow` scope 阻塞 |
| npm 发布 | 未完成 | 需要 push/PR/CI 通过后再走 release |

## 3. 本轮验证命令

以下命令均在本地分支 `codex/osstack-report-foundation` 上执行。

| 命令 | 结果 | 关键输出 |
|---|---:|---|
| `pnpm lint` | 通过 | `Checked 161 files ... No fixes applied.` |
| `pnpm -r build` | 通过 | 15 of 16 workspace projects build succeeded |
| `pnpm test` | 通过 | CLI 136 tests、Loop 58 tests、Core 71 tests 等全部通过 |
| `pnpm smoke:knowledge-cloud:deploy` | 通过 | 检查 `Dockerfile.knowledge-cloud`、Fly、Render、GitHub Actions 部署资产 |
| `pnpm smoke:knowledge-cloud` | 通过 | health=`osstack-knowledge-cloud`，packs=`6`，private_packs=`1`，sync_packs=`6`，top_result=`proof-checksum-pack`，private_result=`private-release-approval`，feedback=`sent` |
| `pnpm smoke:npm-install` | 通过 | 15 个 tarballs；安装后 CLI、launchd dry-run、evidence、knowledge eval、Knowledge Cloud load、sync cache、cloud outage local fallback 全部验证 |
| `pnpm smoke:portable-cli` | 通过 | build `@osstack/cli`，生成临时 portable bundle，执行 `--version`、`help`、`loop doctor --json`，并报告 Node SEA/Bun/pkg/nexe/postject 候选状态 |
| `pnpm smoke:bun-single-binary` | 通过 | Bun 1.3.13 编译 672 modules 成约 67MB 单文件；`--version` 输出 `osstack 0.1.0`，`loop doctor` 通过 |
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

`pnpm smoke:bun-single-binary` 已经证明 osstack CLI 可以生成本地 single executable。它覆盖：

- build `@osstack/cli`。
- 读取 `packages/cli/package.json` 版本号，并通过 `OSSTACK_VERSION` 编译期注入。
- 使用 Bun `build --compile --env inline` 生成临时单文件可执行文件。
- 执行 `osstack --version`，确认版本号不是 fallback `0.0.0`。
- 执行 `osstack help`，确认产品命令与证据命令暴露。
- 执行 `osstack loop doctor --workspace <tmp> --json`，确认单文件能在真实 workspace 上运行。

当前 smoke 产物还不是发布资产。上线前仍需要：

- 固定目标平台矩阵，先以 macOS arm64 为主。
- 生成 checksum/SBOM。
- 做 macOS codesign/notarization。
- 在干净机器上验证 `--version`、`doctor`、`serve --install --no-load`、`loop doctor`。
- 将产物挂到 GitHub Release 或官网下载路径。

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

当前 push 阻塞不是代码问题，而是 GitHub OAuth scope 问题。

执行：

```sh
git push -u origin codex/osstack-report-foundation
```

失败原因：

```text
refusing to allow an OAuth App to create or update workflow .github/workflows/ci.yml without workflow scope
```

当前 `gh auth status` 显示 token scopes 只有：

```text
gist, read:org, repo
```

缺少：

```text
workflow
```

需要先执行：

```sh
gh auth refresh -h github.com -s workflow
```

授权完成后再执行：

```sh
git push -u origin codex/osstack-report-foundation
gh pr create --draft --base main --head codex/osstack-report-foundation
```

## 10. 推荐上线步骤

### Step 1：恢复 GitHub push 能力

执行：

```sh
gh auth refresh -h github.com -s workflow
git push -u origin codex/osstack-report-foundation
```

验收：

- 分支成功出现在 GitHub。
- `.github/workflows/ci.yml` 与 `.github/workflows/knowledge-cloud-deploy.yml` 被远端接受。

### Step 2：创建 Draft PR

执行：

```sh
gh pr create --draft --base main --head codex/osstack-report-foundation \
  --title "Upgrade osstack product foundation and knowledge cloud" \
  --body "Adds Loop evidence flows, official knowledge packs, Knowledge Cloud deploy assets, npm install smoke coverage, and release readiness evidence."
```

验收：

- PR 创建成功。
- CI 开始运行。
- PR 描述包含本地验证结果与上线阻塞解除后的部署计划。

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

1. 先解除 GitHub push 阻塞，把当前成果进入 PR/CI。
2. 再真实部署 Knowledge Cloud，拿到 URL。
3. 再做 TUI / Live Workbench，因为 UI 需要稳定后端能力支撑。
4. 最后强化合规包装，让 osstack 的知识库与证据包可以进入团队/商业使用场景。
