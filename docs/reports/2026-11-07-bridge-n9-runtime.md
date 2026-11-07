# N9 runtime 分支交接

日期：2026-11-07。分支：`codex/bridge-production-runtime`。PR base 为 `main`，当前已合入 `origin/main` `9e2eaf9cc6f83528d48753ab32ea4ca7517130e0`。本轮验证的 source head 为 `152a3320`；后续报告提交不改变运行源码。原 `codex/bridge-production` 分支保留。本节点没有推送、创建 PR、修改 Bot 设置或部署服务。

## 范围与依赖

N9 完成真实 App A/W13 修订发布装配、受控 live 周期、回执启动屏障、pending check 重试、基线与精确提交范围对账，以及取消范围修复。常规 live 启动仍有阶段 5 验收门；准备分支不等于解除上线门。

#418 已由 `dc0f833d`、#419 已由 `80e00ba6`、#420 已由 `9e2eaf9c` 合入 `main`。N9 不再有等待 #418/#419 合并的边；PR 正文不再使用 `merge after`。当前 diff 已相对新 main 收缩，loop fixture 与先前依赖变更不再算 N9 新改动。

| 组 | 选取的原始提交（依赖顺序） |
|---|---|
| 已进入 main 的 #418/#419 | 原先选取的 check retry 与 live 周期依赖；现在以 main 合并结果为基线 |
| N9 | `4da09d92`、`ba3cc487`、`57314dc2`、`85f85119`、`c85598c2`、`2afd66b5`、`bcd20732`、`8bcba635`、`cbb6b7e5`、`d8964643` |
| 回执并发收敛 | 独立 CLI 测试 `7bb61703`（本分支 `09f0a5e8`）与实现 `1f099d65` |

首次选取过程没有冲突。本轮先 fast-forward 到回执收敛分支，再 merge 新 main。五处内容冲突均来自旧依赖与 N9 扩展重叠：保留 N9 的 ledger audit hook、完整 live 测试和带 location 的回执 API。新 main 的 loop fixture 变更正常保留。源码来自原 `gpt-6.1-sol` 提交，没有借合并重写运行逻辑。

N10 属性测试、TLA/变异工具、沙箱驱动和额外 graph deadline 测试没有混入。相对当前 main 没有 `.cursor`、`packages/loop`、`scripts` 或 CLI manifest 改动；原验证技能没有回退。Bot 交接文档留在独立 docs 节点。

## 与最终候选的源码对照

首次冻结 `287864a5` 已核对：其 runtime 非测试 TypeScript 与候选 `78abb868` 的差异，逐字节等于 `d8964643` 的三个文件 patch。本轮在该基础上增加已复现的回执并发修复 `1f099d65`；合入 main 后，运行源码相对 `1f099d65` 没有变化。N10 的 `fast-check` 开发依赖没有纳入 N9。

## 当前 source head 的完整定向验证

以下测试均在合入新 main 后执行，`--maxWorkers=1`，没有使用 `-t` 过滤：

- CLI 14 文件：publication、revision runner、recovery boundaries、production、ledger、service wiring、receipt adapter、真实 read process、live、stopped scan、read limiter、grant、ports、App bridge。**419/419 通过**；其中 publication **149/149**，没有 skip。
- Core：`engineering-revision-chain-store.test.ts`、`revision-chain.test.ts`。**108/108 通过**。
- Merger 静态 import-closure 隔离：**9/9 通过**。

没有运行所有 22 个 package 的测试，也没有真实 GitHub 沙箱执行。这是当前 N9 的定向运行结果，不把原先的 61 passed / 91 skipped 当作本轮全量 publication 验证。

## 本轮检查

| 检查 | 结果 |
|---|---|
| `git diff --check origin/main...HEAD` | pass |
| `node scripts/check-changeset-coverage.mjs --base 9e2eaf9c` | pass；CLI/Core 两个 release-sensitive package 有 changeset |
| `node scripts/generate-inventory.mjs --check` | pass；inventory fresh |
| 对 diff 中 TypeScript 文件执行 `pnpm exec biome check` | 0 errors；1 条已有 `useOptionalChain` 风格 warning，位于 check retry 的 child 检查。未为消除 warning 改写已审源码 |
| Core / CLI typecheck | pass |
| CLI build | pass；使用本轮源码生成新 dist |
| 启动静态 import graph | esbuild metafile 的 eager closure 只有 `cli-entry.ts`、`version.ts` 和 `node:fs/path/url`；无 `@osstack/*` 或 bridge eager import。`write:false`，没有产生额外构建文件 |
| 新 dist 启动预算 | `--version` 中位 35ms（预算 150ms），`--help` 中位 97ms（预算 500ms）；各 5 次，使用独立 smoke home，未打开正式 DB |
| 排除项扫描 | 相对新 main 没有 `.cursor`、N10 property/TLA/driver、额外 graph deadline、loop 或 CLI manifest 改动 |

#420 现已进入 main，不再需要把旧分支试算当作合并前置。产品 gate 仍为 `BRIDGE_LIVE_NOT_IMPLEMENTED:acceptance_required:5-F:5-G`；测试、构建或准备 PR 没有打开该 gate。

## d896 取消范围复审

复审仅覆盖 `d8964643` 的输入 diff。GLM-5.3 静态审阅结论为 **No introduced P1/P2**；确认单次调用的 composite signal 与服务级 stop 两种取消方向正确，conditional P2 已关闭。模型没有执行测试；不能把模型对回归代码的阅读写成实际运行结果。

可复核摘要只保存输入与 response 的内容哈希，不提交原始会话、用量或其他 metadata：

| 内容 | SHA-256 |
|---|---|
| `production-cancel-review.diff` 原始字节 | `cf2ac9365bae0af051fae4e67cbf34981effa45dfb913eecbf2803e9eea6a36b` |
| JSON `response` 字符串解码后 UTF-8 字节 | `29b06d0394f25fa249761249eadfaa5e929c5792087399f5f93fcce32ed50d0b` |

实际执行证据另列：原实现 worktree 在修复过程中运行 service wiring、receipt adapter、真实子进程取消三个测试文件，43 项通过；最终把真实 factory fixture 改为 `enabled=true` 后，对应取消/恢复回归又单独通过。这是 d896 修复时的历史记录。本轮完整重跑已把这些文件计入 419 项，不能把历史 43 项再加一遍。

`1f099d65` 回执并发收敛的独立复审由主会话另行归档；本报告不把 d896 的静态复审结论扩展到 1f。原 CLI 的两个 RED 和修复后的收敛证据见 `bridge-receipt-convergence-fix.md`，本轮三项并发边界测试也已包含在完整 419 项中。

## 待发布 PR 草案

标题：`feat(bridge): complete fenced runtime assembly and receipt recovery`

正文：

> 修订 Mission 在重启后先对账可能已经发生的发布，再启动 live 观察与 check 重试。生产装配使用 App A/W13 栅栏、签名授权、精确提交范围与按调用取消的只读效果；尚未通过阶段 5 验收前，常规 live 启动继续拒绝。
>
> PR base: main（9e2eaf9c）；#418/#419/#420 已合并，无剩余合并依赖。N10 属性/TLA/沙箱驱动和 Bot 交接文档另行交付。
>
> 验证：CLI 受影响 14 文件 419/419（publication 149/149），Core 108/108，import 隔离 9/9，均单 worker 无过滤；Core/CLI typecheck、CLI build、inventory、changeset coverage、diff check 通过。启动 eager graph 保持轻量；version/help 中位 35/97ms。未运行全仓或真实沙箱 execute。独立模型审阅与实际测试证据分别记录在本报告。

主会话审阅此分支后再决定推送和创建 PR；本报告没有执行这些动作。

## 后续锁等待边界修复（第二次回执收敛修正）

冻结 `824b7c4a` 后，独立 CLI 用真实子进程 SQLite writer 复现同一有效 owner
的并发恢复：B 已持有 `BEGIN IMMEDIATE`，A 在锁前读取 pending，等待写锁期间 B
完成确认；A 随后取得锁，原调用抛出 `confirm_route_changed`。数据库终态始终正确，
该问题是调用结果未收敛；没有证据把它描述为普通 daemon 新 owner 重叠。

独立测试原提交 `d64e23a7`，本分支为 `018b0a62`。本轮 source head
`1503f6acaaa30d9b6ad4bfc412b74a44c8b2cc2a` 增加恢复路径的事务内确认状态重读。
`RevisionChainStore.transaction` 在取得 IMMEDIATE 锁后先执行 owner fence，再运行
回调：若 receipt 已 confirmed，本轮恢复结束，保留已提交结果；否则继续原
`confirmRevisionPublication`。没有 catch 掩盖 route、owner 或取消错误，没有修改
core 触发器或放宽数据库约束。直接确认 API 与 landed/cancelled 路由规则不变。

本轮先运行新测试，真实 RED 为 `expected Error: confirm_route_changed to be
undefined`，随后修复为 GREEN。两组完整定向运行均使用 `pnpm --filter @osstack/cli
exec vitest run <files> --maxWorkers=1`，无 `-t`、无 skip：

- publication、revision、runner、service wiring、production、ledger、live、stopped
  scan、receipt adapter、原 recovery boundaries、新 recovery authority：11 文件
  **341/341**，其中 publication **149/149**。
- ports、grant、read process、read limiter：4 文件 **84/84**。

合计本轮 CLI **15 文件 425/425**。CLI typecheck、CLI build、两处 TypeScript
Biome 检查（0 warning）、diff check、changeset coverage（2 packages）及 inventory
fresh 均通过。没有重跑全仓。首次使用 package test 转发参数时误扩大 CLI 选取，
已 SIGINT 停止，未把该不完整运行计入上述结果。上文 Core 108、import 隔离9与
启动预算是 `152a3320` 上的既有验证，本轮未重复，不能称为新 source 的重跑。

`1f099d65` 的 GLM 静态复审由主会话确认通过，但该模型明确本锁边界不在其修复
范围；本报告不把那份审阅扩展为 `1503f6ac` 的批准。新补丁的独立审阅另行记录。
所有验收 gate 仍 CLOSED；没有沙箱 execute、推送、PR 或部署。

当前 PR 验证摘要应使用：CLI 15 文件425/425（含publication149/149、真实 SQLite
跨进程锁等待回归），CLI typecheck/build、Biome、inventory、changeset/diff pass；
历史 Core/import/startup 证据按上述 source 绑定单列。#418/#419/#420 已合并，
仍不需要 `merge after` 阻塞边。
