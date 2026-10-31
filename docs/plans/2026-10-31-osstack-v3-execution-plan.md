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
| W11 | 设计：受限单执行器 Mission 路径（S2 核心，T0/T1 写入代理或强制沙箱、受限验证） | S-A | `docs/design` | W4、W8 | 待做 |
| W12 | 分支治理第二轮：逐个核对未合并分支，列清单交用户确认后删除；AGENTS.md 增加分支生命周期规则 | S-A | — | W1–W4 合并后 | 清单待确认（`docs/plans/2026-10-31-branch-governance-round-2.md`） |

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
