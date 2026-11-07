# N9 runtime 分支交接

日期：2026-11-07。分支：`codex/bridge-production-runtime`。PR base 必须是 `main`；本地起点为 `origin/main` `a9b1a60515db0a10e604c1df9ee693c5c907d713`。原 `codex/bridge-production` 分支保留。本节点没有推送、创建 PR、修改 Bot 设置或部署服务。

## 范围与依赖

N9 完成真实 App A/W13 修订发布装配、受控 live 周期、回执启动屏障、pending check 重试、基线与精确提交范围对账，以及取消范围修复。常规 live 启动仍有阶段 5 验收门；准备分支不等于解除上线门。

本分支包含 #418 与 #419 的源码依赖，直到它们进入 `main` 后，N9 对 `main` 的 diff 才会自然收缩。所有 PR 仍以 `main` 为 base，不把 N9 PR 开到依赖分支。

| 组 | 选取的原始提交（依赖顺序） |
|---|---|
| #418 | `e35c8e1d`、`acb008fe`、`1cf0efcb`、`54c62208`、`2da03590` |
| #419 | `c32740a9`、`10fbec9d`、`4165f46f`、`f992783c`、`fecbed0f`、`af32ba38` |
| N9 | `4da09d92`、`ba3cc487`、`57314dc2`、`85f85119`、`c85598c2`、`2afd66b5`、`bcd20732`、`8bcba635`、`cbb6b7e5`、`d8964643` |

选取过程没有冲突。N9 最后一项在本分支对应 `c486bd69`。源码来自原 `gpt-6.1-sol` 提交；本轮只组装分支和保存报告，没有重写运行逻辑。

N10 属性测试、TLA/变异工具、沙箱驱动、额外 graph deadline/loop fixture 测试没有混入。#418 的 `2da03590` 是明确要求保留的 graph 撤权取消测试依赖，不是 N10 的 deadline 测试。已有 `.cursor` 验证技能没有改动或回退。交接文档 `4a274364`、`4e85d653` 留给独立 docs 节点。

## 与最终候选的源码对照

对照候选 `78abb868`，所有 `packages/**/src` 中的非测试、非 fixture TypeScript 源码都相同，除了 `d8964643` 规定的三个文件：

- `contained-mission-bridge-assembly.ts`
- `contained-mission-bridge-production.ts`
- `contained-mission-bridge-receipt-adapter.ts`

这三个文件的 `git diff 78abb868 HEAD` 与 `git show --format= d8964643` 的对应文件 diff **逐字节相等**。候选的 CLI `package.json` 多出的 `fast-check` 开发依赖属于 N10，未纳入 N9；N9 没有修改该 manifest。

## 本轮静态检查

| 检查 | 结果 |
|---|---|
| `git diff --check origin/main...HEAD` | pass |
| `node scripts/check-changeset-coverage.mjs --base a9b1a60515db0a10e604c1df9ee693c5c907d713` | pass；CLI/Core 两个 release-sensitive package 有 changeset |
| `node scripts/generate-inventory.mjs --check` | pass；inventory fresh |
| 对 diff 中 TypeScript 文件执行 `pnpm exec biome check` | 0 errors；1 条已有 `useOptionalChain` 风格 warning，位于 check retry 的 child 检查。未为消除 warning 改写已审源码 |
| `git merge-tree --write-tree HEAD 5cd15888c38dbdc8c0724fc1e4a5b4ac07ae4803`（#420 `codex/loop-fixture-cleanup`） | pass，无冲突；试算 tree `03463efdaf4ce5b4fe359a3aa405a96a0d13e521` |
| 排除项扫描 | 没有 `.cursor`、N10 property/TLA/driver、额外 graph deadline 或 loop 源文件改动 |

这里的 merge tree 是不更新工作区/分支的静态试算。曾把旧 `codex/bridge-phase5-verification` 误作 #420 做过一次试算，产生旧 runtime 重复内容冲突；它不是 #420，不作为兼容性结论，也没有应用该试算 tree。上述结果使用已确认的真实 #420 head。

本轮没有运行 typecheck、build、全仓或长测试，以免与主会话的串行验收竞争。启动耗时也没有用旧 dist 重新测量。正式集成测试结果由主会话另行记录。

## d896 取消范围复审

复审仅覆盖 `d8964643` 的输入 diff。GLM-5.3 静态审阅结论为 **No introduced P1/P2**；确认单次调用的 composite signal 与服务级 stop 两种取消方向正确，conditional P2 已关闭。模型没有执行测试；不能把模型对回归代码的阅读写成实际运行结果。

可复核摘要只保存输入与 response 的内容哈希，不提交原始会话、用量或其他 metadata：

| 内容 | SHA-256 |
|---|---|
| `production-cancel-review.diff` 原始字节 | `cf2ac9365bae0af051fae4e67cbf34981effa45dfb913eecbf2803e9eea6a36b` |
| JSON `response` 字符串解码后 UTF-8 字节 | `29b06d0394f25fa249761249eadfaa5e929c5792087399f5f93fcce32ed50d0b` |

实际执行证据另列：原实现 worktree 在修复过程中运行 service wiring、receipt adapter、真实子进程取消三个测试文件，43 项通过；最终把真实 factory fixture 改为 `enabled=true` 后，取消一次恢复、再次恢复、启动/扫描 live 与 stopped 服务、停止后拒绝恢复的回归又单独通过。原修复还通过 CLI typecheck、针对文件的 Biome 和 diff check。这些是修复时的运行记录，不是本轮 N9 分支重新执行的结果。

## 待发布 PR 草案

标题：`feat(bridge): complete fenced runtime assembly and receipt recovery`

正文：

> 修订 Mission 在重启后先对账可能已经发生的发布，再启动 live 观察与 check 重试。生产装配使用 App A/W13 栅栏、签名授权、精确提交范围与按调用取消的只读效果；尚未通过阶段 5 验收前，常规 live 启动继续拒绝。
>
> merge after #418
>
> merge after #419
>
> PR base: main。源码暂含上述依赖，依赖合并后 diff 自然收缩。N10 属性/TLA/沙箱驱动和 Bot 交接文档另行交付。本轮静态检查通过，#420 合并试算无冲突；本轮未重跑全仓测试。d896 已完成独立静态复审，实际测试证据与模型审阅分别记录在本报告。

主会话审阅此分支后再决定推送和创建 PR；本报告没有执行这些动作。
