# Firstmate→OSStack 纯净分支：补回计划

日期：2026-10-30。分支 `codex/firstmate-pure-baseline`，起点 `ce543535`（PR271 合入，10-27 13:45:44 上海时间；与 `codex/firstmate-upgrade-plan` 4199d9aa 文件树相同）。
对照主线：`origin/main` = `6555adfb`（PR314）。来源调查：`/Volumes/AIMATE_WORK/tmp/osstack/runtime/pstack-separation-boundary-20261030/pstack-boundary-audit.md`。

## 原则

1. 只按**非 docs 路径**移植，不用 `cherry-pick -m 1` 整个合并提交——那样会把 joint/pstack 的设计与证据文档一起带进来。
   做法：`git diff <M>^1 <M> -- <路径…> | git apply --3way`，然后单独提交，提交信息写明来源 PR 与合并提交。
2. 每批结束跑 `pnpm build && pnpm typecheck` 以及受影响包的测试；全部完成后跑 `pnpm test`。
3. 依赖 `@osstack/protocol/joint`、`osstack-methods-skill/`、`skill-registry` source-snapshot/adoption/compiler 或 `config.methods` 的内容一律不移植。
4. 按主线合入顺序移植同一文件的多次修改（如 `daemon.ts` 277→278→279，`stack.ts` 308→309），避免冲突。

## 逐 PR 分类（ce543535..6555adfb，首父链 42 个合并）

| 处置 | PR / 合并提交 | 内容 | 说明 |
|---|---|---|---|
| **A 补回 · Firstmate** | #275 `a5fef9c4` | `protocol/behavior-capability.ts` + test + index 导出 + changeset | 只依赖 zod |
| **A 补回 · Firstmate** | #276 `28d116f3` | `core/behavior-registry.ts` + test + index | 行为注册加载/校验 |
| **A 补回 · Firstmate** | #282 `ede5aadc` | behavior-registry 审计加固 | 名为 joint，实际只改 behavior-registry |
| **A 补回 · 通用** | #277 `4924d224` | `cli/daemon.ts` 会话发送收据 + test | |
| **A 补回 · 通用** | #278 `0f6dc137` | daemon 启动清理 + test | |
| **A 补回 · 通用** | #279 `d3fa7ef6` | daemon 终端边界 + test | |
| **A 补回 · 通用** | #308 `a250ad88` | `github/stack.ts` StatusContext 状态解析 | |
| **A 补回 · 通用** | #309 `e4643324` | `github/stack.ts` CheckRun 异常状态保守处理 | |
| **A 补回 · 通用** | #289 `64b203c3` | `cli/skills-command.ts` check 失败退出码 + tests | 宿主技能检查，与 pstack 无关 |
| **A 补回 · 测试稳定性** | #299 `7d3fc2bf`（仅 `packages/cli/src/upgrade-native.test.ts`） | 升级测试准备阶段移入 beforeEach、独立超时 | PR 其余部分是方法包 |
| **A 补回 · 测试稳定性** | #300 `e26f6d2c`（仅 `packages/core/src/state/attention-observer.test.ts`） | 修复分页依赖哈希顺序的不稳定断言 | PR 其余部分是方法包 |
| **B 拆分后补回** | #291 `9debb0f9` | 取：`skill-registry/watcher.ts`+test（输出排空修复）、`scripts/prepare-node-headers.mjs`+test、`scripts/lib/scratch.mjs` 改动、对应 changeset 与 CI 中 node headers 步骤 | 不取：`skills-check-verification.mjs`、`smoke-skills-check*`（方法包验证旅程）；移植前逐个确认 `scratch.mjs`/`ci.yml` hunk 不引用方法脚本 |
| **B 待定 · 通用候选** | #307 `de43f47c`、#310 `01ec1852` | `github/pr-candidate-snapshot.ts`、`pr-stack-candidate.ts` + `scripts/report-*` | 库代码本身通用（有界 PR/栈快照），但起因是 pr-readiness 方法；若 Firstmate 交付环节需要 PR 就绪判断则补回，不取 `osstack-methods-skill/` 改动 |
| **B 待定 · 通用候选** | #312 `dcac6ffb`（仅 `skill-registry/manifest.ts`+test） | SkillSource 增 `subdir`/`package_version`，schema 改 `.strict()` | `.strict()` 会拒绝未知字段，是行为变化；只有需要“外部技能包作为可选来源”时再补 |
| **C 不补回 · joint 合同** | #272 `baf88ea3`、#273 `69859eec`、#280 `e9a9656a`、#281 `8fed8313`、#283 `697d0b9c`、#285 `bc061aeb` | `protocol/joint*`、schemas、fixtures、`skill-registry/source-snapshot`、`.osstack/neat.yaml` | Firstmate×pstack 联合合同 |
| **C 不补回 · joint 恢复规格** | #274 `baee1f6a`、#284 `3192b424`、#286 `fd9cac81` | operator/broker recovery 离线规格测试与 fixtures | 全部 import `@osstack/protocol/joint`，无运行时入口。Firstmate 的恢复能力应在本分支按 OSStack 自身状态模型重新实现 |
| **C 不补回 · pstack 方法包** | #288、#290、#292–#298、#301–#306、#311、#313、#314 | `osstack-methods-skill/`、导出/旅程/投影/材料/特性图/健康/来源采用/bug_fix 编译/`method-context` 接线 | pstack 留在核心之外 |

## 主线之外的待合入修复（PR315/316 候选，均未进 main）

| 处置 | 提交 | 内容 |
|---|---|---|
| **A 补回 · 通用** | `bcb596cd` fix(agents): pass explicit Codex writable directories | `agents/adapters/codex-cli.ts`+test+changeset |
| **A 补回 · 通用** | `cd30b6cc` fix(loop): preserve exact paths in diff discovery | `loop/discover.ts`+test+changeset（长路径/特殊路径） |

两者来自 `origin/codex/pstack-loop-long-path-delivery`，非 docs 改动只有这 6 个文件。用 `git cherry-pick <sha>` 即可（单父提交，不带 docs）；同分支其余 `docs(pstack)` 提交不取。

## 执行批次

**批 1 — Firstmate 行为合同与注册**：#275 → #276 → #282。验证：`pnpm --filter @osstack/protocol test`、`pnpm --filter @osstack/core test`。
**批 2 — 会话/daemon**：#277 → #278 → #279。验证：`pnpm --filter @osstack/cli test -- session-send-receipt`。
**批 3 — GitHub 状态**：#308 → #309。验证：`pnpm --filter @osstack/github test`。
**批 4 — 宿主技能与测试稳定性**：#289、#299/#300 测试文件、#291 拆分部分。验证：cli、core、skill-registry 测试。
**批 5 — 主线外修复**：`bcb596cd`、`cd30b6cc`。验证：agents、loop 测试。
**批 6 — 收尾**：`pnpm build && pnpm typecheck && pnpm test`；CLI 启动预算（`node scripts/bench-cli-startup.mjs`）；确认 `git grep -n "protocol/joint\|osstack-methods-skill\|method-context"` 在非 docs 路径为空。
**B 类**：批 6 后按 Firstmate 能力映射逐项决定，不预先移植。

每个移植提交的信息格式：

```
fix(cli): backport session send receipt (#277)

Backported from 4924d224 (non-docs paths only) onto the Firstmate baseline.
```

## 已知风险

- 主线在这些 PR 之间可能有其它合并改了同一文件的上下文；`--3way` 失败时以主线最终版本为准手工合并，并在提交信息说明。
- changeset 文件按原样带入；若发布版本号与主线分叉，发布前需统一处理。
- 本分支从此与 main 分叉。之后 main 上新的通用修复不会自动出现，需要定期按本表同样方法筛选。
- 本计划只覆盖“补回”；Firstmate 剩余能力（goal_dispatch、隔离、监督、恢复、交付）按固定版本 `af1c6817…` 另做能力映射。

## 执行结果（2026-10-30）

批 1–5 已完成，14 个提交（`c46698d0`..`e6d679e4`），全部 `git apply` 无冲突。#291 只取 watcher、`scripts/lib/scratch.mjs`、`prepare-node-headers` 及其 CI 步骤。B 类 #307/#310/#312 未移植。

批 6 验证（本机 Node v26.5.0）：

- `pnpm build`、`pnpm typecheck`：通过。
- CLI 启动预算：`--version` 中位 36ms（预算 150），`--help` 中位 163ms（预算 500）。
- 非 docs 路径 `git grep "protocol/joint|osstack-methods-skill|method-context"`：无结果。
- `pnpm -r test`：22 个包中 19 个全绿；共 4 个失败，均与移植无关：
  - `github/delivery.test.ts`、`cli/guarded-git-runtime.test.ts` 各 1 个：`stripTypeScriptTypes({mode:"transform"})` 在 Node 26 已不支持；CI 用 Node 22，origin/main 同样代码。
  - `loop/executor.test.ts` 2 个（process group EPERM/ESRCH fixture 超时）：把 `discover.ts` 还原为 ce543535 后仍失败，executor 文件与 origin/main 相同，是本机既有问题。
