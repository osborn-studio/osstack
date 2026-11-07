# osstack × Grok Bots 接通：执行图

日期：2026-11-07。上位文档：[实施方案](../2026-11-02-osstack-grok-bridge-implementation.md)、[阶段 5 附录](../../design/2026-11-06-bridge-same-pr-revision.md)、[W13 设计](../../design/2026-11-06-w13-host-git-survival.md)、[App E 设计](../../design/2026-11-06-bridge-shadow-merger.md)、[阶段 6 规格](../../design/2026-11-06-bridge-phase6-operator.md)、[运行手册](../../runbooks/bridge.md)。
配套：[checks.md](checks.md)（每条要求的判定与证据）、[progress.md](progress.md)（当前状态与下一步）。

## 0. 任务与“完成”的定义

**任务：** 让 osstack 与 Grok Bots 自动互相联系：Mission PR 由 App A 发布、App B 发证据、Grok Bots（App C/D）评审与验证；收到合格的要求修改后，osstack 在同一 PR 上受控修订；App E 先影子评估合并；最后在主仓库对单个 scope 打开 `OSSTACK_BRIDGE=1`。

**完成（terminated）= 下列全部成立，或达到执行上限：**
1. 第 3 节的每个节点在 [checks.md](checks.md) 中为 pass，证据指向已保存的文件、PR 或运行记录。
2. 阶段 7 验收：主仓库连续 5 条链无异常，设计 §6 指标能用 `osstack stats` 读出。
3. 没有标为 unresolved 的要求；所有 fail 已修复或明确声明并由用户接受。

**执行上限：** 每个节点最多 3 次修正（见 §5）；任何发布、部署、改仓库设置、改 GitHub App 安装都先停下问用户；合并 `main` 只由人做。

## 1. 基线

基线是 2026-11-07 的 `main`（阶段 0–4、5-A、W13-B、M-A、M-B 已合并）。每个节点开工前从当时的 `origin/main` 建 worktree；改变系统前先跑一次该节点涉及包的测试作为对照。

## 2. 节点规则

- 一个节点 = 一个 PR，一个产物，一组检查（§4）。
- 节点只读它需要的文件；简报写明要读的文件和章节，不给整个目录。
- 只在一个节点使用另一个节点的产物时画边；没有边的节点并行。
- 确定性判断（合并冲突、迁移号连续、导出清单、changeset 覆盖、启动依赖图、泄漏扫描、测试）用代码做，不交给模型；模型只做评审（Codex）和设计。
- 角色：设计节点用 Opus 5.5；代码节点用 Sonnet 5.5；验证用 Codex CLI `gpt-6-astra`（medium，只读）。编排、提交、开 PR、解决冲突由主会话做。

## 3. 节点与边

状态：✅ 已合并 · 🟡 PR 已开 · 🔵 已提交待开 PR · ⬜ 未开始 · ⛔ 被外部条件阻塞。

| 节点 | 产物 | 依赖（边） | 状态 |
|---|---|---|---|
| N1 观测：链事件 + stats bridge 段 | #394 | — | ✅ |
| N2 W13-A 进程登记 + 迁移 54 | #395 | — | 🟡 |
| N3 App E M-C 影子合并服务 | #396 | — | 🟡 |
| N4 阶段 5 5-B 修订子 Mission | #397 | — | 🟡 |
| N5 W13-C1 本地写入与恢复 | `feat/w13-local-writes` | N2 | 🔵 |
| N6 W13-C2 远端写入（push、pr create）走门 | 待建 | N5 | ⬜ |
| N7 阶段 5 5-C `publishRevision` | 待建 | N4、N6 | ⬜ |
| N8 阶段 5 5-D 栅栏中的链检查、按 `publish_target` 分派 | 待建 | N7 | ⬜ |
| N9 阶段 5 5-E 恢复、live 对账器、`OSSTACK_BRIDGE=1` | 待建 | N8、N1 | ⬜ |
| N10 阶段 5 5-F 故障注入、变异、TLA 对照 | 待建 | N9 | ⬜ |
| N11 阶段 5 5-G 沙箱端到端 | 待建 | N10 | ⛔ 需要宿主 Docker 运行 |
| N12 App E M-D 沙箱场景录制 | 待建 | N3 | ⬜ |
| N13 阶段 6 Grok Bots 改用 App C/D | 平台侧 | — | ⛔ Grok Bots 运营者；U-1…U-11 未核实 |
| N14 `main-quality` ruleset 套到主仓库 | 人执行 | N13 | ⛔ 仓库管理员（改设置需用户） |
| N15 阶段 7 主仓库上线 | 运行记录 | N9、N11、N13、N14 | ⬜ |

边上的合并顺序（共享文件：`index.ts`、导出清单、runner/command/rpc）：N1 → N2 → N3 → N5 → N4。后合并者合入 `origin/main` 后解决冲突。

```
N1 ─────────────────────────────┐
N2 ─▶ N5 ─▶ N6 ─┐               │
N4 ─────────────┴▶ N7 ─▶ N8 ─▶ N9 ─▶ N10 ─▶ N11 ─┐
N3 ─▶ N12                                         ├▶ N15
N13 ─▶ N14 ───────────────────────────────────────┘
```

可并行的就绪节点：N6 等 N5；N12 等 N3。N13 由外部推进。

## 4. 每个节点的门（按顺序，只凭证据打开）

1. **确定性检查**（代码，不靠模型）：受影响包 `typecheck`；受影响包的定向测试；`node scripts/generate-inventory.mjs --check`；`node scripts/check-changeset-coverage.mjs`（提交后跑）；`pnpm exec biome check .` 无错误；`node scripts/bench-cli-startup.mjs` 在预算内且启动依赖图不变；文档节点跑 `packages/governance` 的 `osstack-config.test.ts`；与其他未合并分支 `git merge-tree` 试合并；夹具泄漏扫描（登录名、真实 id、`http`、`@`）。
2. **节点报告**：子代理给出文件、测试数、命令结果、偏差、延后项。
3. **模型评审**：Codex `gpt-6-astra` 两轮；每条发现核对代码后接受或附理由拒绝。
4. **CI**：GitHub Actions 在 PR head 上通过。

一个门失败不重跑整张图，只退回产生它的节点。

## 5. 两条返回路径

- **修正：** 门失败 → 退回该节点，附原因、证据和范围“只修这个节点”。每个节点最多 3 次；第 3 次仍失败就标 unresolved 并停下问用户。不靠重跑门来“刷”通过。
- **学习：** 被接受的结果写成规则（§6），下一次执行从这里开始。

## 6. 已学到的规则

1. 各自通过 CI 的两个 PR 合在一起可能让 `main` 失败（#391 + #393）。开 PR 前对所有未合并分支 `git merge-tree` 试合并，并在合并结果上跑 core 全量测试。
2. CI 是 Linux：只在 macOS 成立的真实进程测试用 `skipIf(process.platform !== 'darwin')`（#385）。
3. 文档里的相对链接只能指向已在 `main` 上的文件；指向未合并文件写成路径加 PR 号（#383）。
4. 迁移号按合并顺序连续：52 App E、53 阶段 5、54 W13；先写 DDL 不注册，等前一个合并再注册（W13-A）。
5. `check-changeset-coverage` 只看已提交的改动；提交前显示 0 个包是正常的。
6. 生成的 `docs/inventory/PUBLIC_EXPORTS.md` 冲突时取一边后重新生成，不手工合并。
7. 只暂存明确的路径，不用 `git add -A`（claude-mem 会改 AGENTS.md）；`git commit` 单独一次 Bash 调用（PreToolUse 钩子会误判组合命令）。
8. 机器很忙时启动耗时不可信：比较启动静态依赖图（文件数与字节数），不比较毫秒。
9. 沙箱写入每次都会留下删不掉的 Mission 分支：真实运行最多 3 次，先只做 preflight。
10. 夹具与报告只放白名单字段；正文只留盐化摘要；真实 id 只放在仓库外的私有映射。

## 7. 本图改动记录

| 日期 | 改动 | 原因 |
|---|---|---|
| 2026-11-07 | 建立本图，节点 N1–N15 | 用户要求按“门控节点图”方式推进剩余工作 |
| 2026-11-07 | 用户批准本图；N1（#394）已合并 | 按 cap1 “写好后等待批准” |
