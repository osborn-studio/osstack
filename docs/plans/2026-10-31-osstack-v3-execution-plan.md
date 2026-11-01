# OSStack v3 执行计划：工作包、负责人与合并顺序

日期：2026-10-31。依据：[v3 设计](../design/2026-10-30-osstack-dual-loop-factory.md)、[运行模型](../design/2026-10-30-firstmate-upstream-delta/operating-model.md)。

## 规则

- 两个 Claude 会话并行开发：**S-A**（本计划的编写会话）与 **S-M**（主线会话）。每个工作包只有一个负责人；两个会话不同时修改同一文件集合。
- 每个工作包一个分支、一个面向 `main` 的 PR（有依赖时叠放，PR 描述写明依赖）。worktree 放在 `~/Developer/CodeX/.worktrees/osstack/<task>`，用完删除。
- 每个 PR 开出前：`pnpm build`、`pnpm typecheck:check`、`pnpm lint`（0 错误）、`node scripts/generate-inventory.mjs --check`、受影响包测试、`node scripts/bench-cli-startup.mjs`；再由 Codex（gpt-6.1-sol，medium）评审，负责人逐条核实后修复或在 PR 中写明驳回理由。
- 已知本机失败（Node 26）：github `delivery.test`、cli `guarded-git-runtime.test` 各 1 个（D10）。CI 用 Node 22。
- 本地 `git reset`/`checkout` 恢复被追踪的 `packages/knowledge/dist` 后，先删 `packages/knowledge/tsconfig.tsbuildinfo` 再构建（D3 未修前的临时做法）。
- 用户审批并合并 PR；任何会话都不合并 `main`、不开自动合并。

## 工作包

| ID | 内容 | 负责人 | 主要文件 | 依赖 | 状态 |
|---|---|---|---|---|---|
| W1a | 测试隔离清除 `OSSTACK_SOCKET`（D2）、runner 换 macos-15（D4）、Loop 迟到任务测试去竞态 | S-A | `packages/cli/src/test-setup-hermetic-home*`、`.github/workflows/*`、`packages/loop/src/loop-engine.test.ts` | — | PR 待开 |
| W1b | 补回 main 缺失的提交：Codex 可写目录、diff 精确路径、changeset | S-A | `packages/agents/src/adapters/codex-cli*`、`packages/loop/src/discover*` | — | PR 待开 |
| W1c | L1-0：删除 joint 恢复规格测试与夹具（钉死 schema 47 并预留迁移 48） | S-A | `packages/core/fixtures/*-recovery`、`*-recovery-spec.test.ts` | — | PR 待开 |
| W1d | 逾期提醒（迁移 48） | S-A | `packages/core/src/state/attention-*`、迁移与门禁、`supervision-service.ts` | W1c | PR 待开 |
| W2 | 监督接管即停（#320 移植） | S-A | `packages/cli/src/supervision-service.ts`、`supervision-parity.test.ts` | W1d | 待做 |
| W3 | 回归简报（迁移 49，#322 移植；手工解决 `upgrade-native.test.ts`） | S-A | attention、迁移与门禁、daemon RPC、attention CLI | W2 | 待做 |
| W4 | 交付保全（#321 移植）+ D6（执行器自提交后分支被删）+ D7（Loop 本地落地快进当前分支；工厂模式禁止本地落地） | **S-M** | `packages/agents/src/worktree.ts`、`packages/loop/src/loop-engine.ts`、`packages/github/src/delivery*` | W1b | 待做 |
| W5 | D5：daemon 读取 `takenOver` 并上报；扫描错误计数进 `osstack stats` | S-A | `packages/cli/src/daemon.ts`、stats | W3 | 待做 |
| W6 | D10：两个 Node 26 测试改为当前 Node 支持的方式 | **S-M** | `packages/github/src/delivery.test.ts`、`packages/cli/src/guarded-git-runtime.test.ts` | — | 待做 |
| W7 | D3：停止追踪 `packages/knowledge/dist`，补消费者前的构建步骤 | **S-M** | `packages/knowledge`、`.gitignore`、`scripts/prepare-npm-package.mjs`、相关脚本 | — | 待做 |
| W8 | D1：迁移机械部分派生（期望表由迁移 SQL 推导、worker 模块清单共享辅助、版本断言引用常量；两个限定区间保持独立） | S-A | `upgrade-native-port.ts`、graph worker 测试、`db.ts` | W3 | 待做 |
| W9 | L1a：通用合同（`SourcePin`、`SourceSnapshot`、规范摘要）迁出 `protocol/joint`，迁移消费者 | **S-M** | `packages/protocol`、`packages/skill-registry` | W4 | 待做 |
| W10 | L1b：移除 pstack 方法包及其构建/CI 消费者；保留 `execution-context` | **S-M** | `packages/cli/src/method-context*`、`tsup.config.ts`、`osstack-methods-skill/`、相关 `scripts/` 与 CI 步骤 | W9 | 待做 |
| W11 | 设计：受限单执行器 Mission 路径（S2 核心，T0/T1 写入代理或强制沙箱、受限验证） | **S-M** | `docs/design/2026-10-31-contained-mission-path.md` | W4、W8 | 设计已合并（#341）；M0–M8 已全部合并（最后两项为 #353 M7、#354 M8）；后续工作见 W13、W14 |
| W12 | 分支治理第二轮：逐个核对未合并分支，列清单交用户确认后删除；AGENTS.md 增加分支生命周期规则 | S-A | — | W1–W4 合并后 | 已合并（#339）；A、B、C 三组已按用户确认删除；规则见 AGENTS.md |
| W13 | Mission 残余风险：主机 git 子进程（如 `update-ref`）在守护进程崩溃后可能存活，恢复不等待它，新 owner 丢弃改动后它仍可能移动分支（见设计 §9 实现说明 M8）。主机 git 的 pgid 记入账本或启动日志；`recover()` 在结算 `executing` 与 `needs_reconciliation` 前确认这些进程组已空，否则 `stop_unknown`。验收：恢复演练中一个持有的 git 子进程使 Mission 停在 `stop_unknown`，进程退出后才可结算 | **S-M** | `packages/agents/src/contained-workspace/hardened-git.ts`、`plumbing.ts`、`packages/cli/src/contained-mission-host.ts`、`contained-mission-recovery.test.ts` | W11 | 待做 |
| W14 | 受限验证的受信任依赖布局（设计 §7.3 方案 B）：按 `pnpm-lock.yaml` 摘要在 Mission 之外预先构建基础镜像（固定位置的依赖树）与主机自带的引导步骤，把候选目录与依赖树连接；镜像 ID、锁文件摘要与引导步骤摘要记入验证绑定。验收（§12“依赖”）：一个真实的 `pnpm --filter <包> test` 在无网络容器、不放宽现有限制的情况下通过 | **S-M** | `packages/agents/src/contained-image.ts`、`packages/cli/src/contained-verification.ts`、基础镜像构建脚本 | W11 | 待做；首次真实端到端演练前可先用不需要依赖的验证命令（方案 A） |
| W15 | 发布：0.23.0 中 Trusted Publishing 的发布 PUT 对部分包返回 404（graph 每次、protocol 一次），而 `release.yml` 的信任配置正确；#359 已加有界重试，但 9 个包最终仍由用户的 npm 登录手工发布。排查 npm 侧原因（包级信任映射、包创建时间、OIDC 令牌受众或速率），并把“交互式手工发布”写成 RELEASING.md 中的正式后备流程（前置检查、按发布顺序、发布后核对版本与 dist-tag）。验收：RELEASING.md 有可照做的手工后备步骤（无论原因是否找到）；排查结论单独记录，若找到原因，下一次发布全部经 OIDC 成功 | S-A | `scripts/publish-packages-safely.mjs`、`.github/workflows/release.yml`、`RELEASING.md` | — | 待做 |
| W16 | `osstack upgrade` 不识别 launchd plist 固定在私有发布目录（`~/.local/share/osstack/releases/<版本>/launch-daemon.py`）的部署：它升级全局安装后重启仍固定旧版本的守护进程，健康检查失败并回滚。改为支持该布局（按新版本准备发布目录并改写 plist），或在任何写入之前识别该布局并拒绝、给出手工步骤。验收：两种 plist 布局各有测试；固定布局下要么升级成功且守护进程报告新版本，要么在不改动任何文件的情况下以明确错误退出 | S-A | `packages/cli/src/upgrade.ts`、`upgrade.test.ts` | — | 待做 |
| W17 | `osstack upgrade --help` 会执行真实升级而不是打印帮助。验收：`--help`、`-h` 以及带其他参数时的 `--help` 只打印帮助、退出码 0、不触碰安装、守护进程或日志；有测试覆盖 | S-A | `packages/cli/src/upgrade.ts`、`bin.ts`、`upgrade.test.ts` | — | 待做 |
| W18 | 0.23.0 部署时本机 npm 11.17.0 未运行依赖的安装脚本，`better-sqlite3` 没有被编译，传入 `--allow-scripts=better-sqlite3,protobufjs` 后才正常（npm 正在把阻止安装脚本改为默认行为）。升级与安装路径（`osstack upgrade`、安装文档、npm 安装烟测）都要传入该参数，并在完成前验证原生模块可加载（例如打开一个临时数据库），失败则回滚或报错。验收：安装烟测在显式阻止未授权安装脚本的 npm 配置下运行，不需要额外手工步骤即通过，并断言原生模块已加载 | S-A | `packages/cli/src/upgrade.ts`、`scripts/smoke-npm-install.mjs`、安装文档 | — | 待做 |

## 合并顺序（用户执行）

1. W1a（独立）
2. W1b（独立）
3. W1c → W1d（W1d 叠在 W1c 上）
4. v3 设计与本计划文档 PR
5. W2 → W3
6. W4、W6、W7（S-M，彼此独立，可任意顺序）
7. W5、W8
8. W9 → W10
每个 PR 合并后，原 draft PR（#318–#322）中对应内容关闭，分支删除。

## 交接

S-M 从 W4 开始：基于最新 `main` 建分支 `codex/land-delivery-preservation`，移植 `origin/codex/firstmate-delivery-preservation` 中 `78950748`、`898dd61b`、`96dc9cbf`、`8830938d`、`5470f7c3`、`41b95c7e`（不取 inventory 提交，重新生成），再在同一 PR 内或叠放 PR 中完成 D6、D7。D7 的验收：工厂模式下 Loop 成功后不调用本地落地；本地落地只在显式 opt-in 下可用，且固定目标分支与已接受提交。
