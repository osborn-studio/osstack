# 执行进度

续做时先读 [graph.md](graph.md) 与本文件，从“下一步”继续。

## 图

- **已完成（已合并）：** N1–N7、N12，以及 #398 图、#400 AGENTS.md、#401 开关、#402 测试竞态、#405 阶段 5 补充决定、#407 测试超时、#408 D8、#409 T17。
- **PR 已开：** N8 5-D（#411）、N9 的 D7 核心扫描（#412）、N10 的 TLA+ 模型更新（#413）。
- **分支上（未开 PR）：**
  - D9 同子恢复（`feat/bridge-resume-child`，基于 #411）：store 的 `resumeChild`、`resumeLanded`，runner 入口的 `acknowledgeAdvance`；评审中。
  - 停止链扫描服务（`feat/bridge-stopped-scan-service`，基于 #411 + #412）：评审中。
  - 回执恢复（`feat/bridge-receipt-recovery`，基于 #411）：`deliverRevision` 第 0 步与要求证据的 `reconcileReceipt`；等 D9 的 `resumeLanded`，之后补全 K1–K6 崩溃矩阵。
- **未开始：** N9 的 live 对账器与 `OSSTACK_BRIDGE=1`；N10 的故障注入与变异测试。
- **阻塞：** N11（宿主 Docker）、N13（Grok Bots 运营者）、N14（仓库管理员）。

## 产物

| 节点 | 位置 |
|---|---|
| N1–N7、N12 | #394、#395、#396、#397、#399、#406、#410、#403（+ #404） |
| N8 | #411，分支 `feat/bridge-fence-dispatch` |
| N9 | #412（D7 核心）；分支 `feat/bridge-resume-child`、`feat/bridge-stopped-scan-service`、`feat/bridge-receipt-recovery` |
| N10 | #413（TLA+），分支 `docs/bridge-tla-release-split` |

## 失败与重试记录（失败也记，便于对比）

| 节点 | 尝试 | 结果 | 处理 |
|---|---|---|---|
| P-13 | 真实运行 1、2 | 分类器把 GitHub 的 “Bypassed rule violations” 当成拒绝 | 修分类器并加测试；第 3 次通过 |
| TLA+ | 不加约束的运行 | 2 100 万 / 1 500 万状态仍未结束 | 加 `FocusPublish` 约束，13 秒找到反例 |
| W13-B | Linux CI 第 1 次 | 替换标记测试在 Linux 复用 inode；T7 依赖 macOS `lsof` | 保持旧 inode 打开；T7 只在 macOS 跑 |
| W13-B | Linux CI 第 2 次 | `graph-recovery-crash` 测试读到未写完的 JSON | 与本 PR 无关，重跑通过；测试本身的竞态未修 |
| #391 + #393 | 合并后的 `main` | 两条 grant-store 测试失败 | 在 #394 对齐测试（6b58ba7b） |
| #383 | CI 第 1 次 | 文档链接指向未合并文件 | 改为路径加 PR 号 |
| D8 | Codex 沙箱内门禁 | 无网络，`pnpm install` 失败 | 主会话在沙箱外重跑全部门禁 |
| D8 / 5-C | 构建 | 旧 `tsbuildinfo` 让 protocol 不生成 `index.d.ts` | 删除 `*.tsbuildinfo` 与 protocol `dist` 后重建 |
| 5-C | CLI 全量（负载高） | 4 条测试 5 秒超时，每次不同 | `--testTimeout=30000` 通过；#407 把默认值提到 20 秒 |
| 5-C | ZCode 第 2 轮 | `project_token_timeout` | 重试一次通过 |
| 5-C | ZCode 第 2 轮 P2 | 称 GitHub compare 新到旧排序 | 用 8 个提交实测为旧到新，推翻 |
| T17 | Codex 沙箱 | 不能绑定 localhost，测试跳过 | 主会话在沙箱外运行，34 项通过 |
| TLA+ | 穷举 TLC 前两次 | zsh 不拆分 `$J`（`timeout` 找不到命令）；PATH 缺 `timeout` | 改用 bash 脚本与数组 |
| TLA+ | 穷举第 1、2 次 | `PendingBaseSafety`、`WriteAheadIntent` 反例 | 均为模型错误，已修；第 2 个成为 5-E 实现规则 |
| D9 | 第 1 轮后 CLI | 三条 5-B runner 测试失败（R2 让链停在 `awaiting_decision`） | 第 2 轮在 runner 入口接 `acknowledgeAdvance` |
| P3 跟进 | graph 恢复测试的 90 秒轮询 | 原本已有 120 秒超时，问题不存在 | 丢弃改动 |

## 决定

- 2026-11-07：采用门控节点图推进剩余工作（graph.md §7）。
- 已由用户决定：迁移号 52/53/54/55；阶段 5 默认值；授权用主机签名；W13 恢复不杀进程；P-13 只在沙箱；`OSSTACK_BRIDGE=0` 也停止 App A（#401）；阶段 5 补充决定 R1–R5 均为 (a)（#405）。
- 2026-11-07：分工改为 Opus 5.5 调度与设计、Codex `gpt-6-sol` 写代码、ZCode GLM-5.3 验证。

## 待定

- App E 设计 §8 其余决定；阶段 6 规格 §13 八项；W13 设计 §10 其余决定。
- 确认 App A、C、D 的 bot 用户 id。
- `graph-recovery-crash.integration.test.ts` 的读文件竞态是否单独修。
- 给 `listStoppedLive` 加部分索引需要新迁移（#412 延后）。

## 下一步

1. D9、扫描服务评审通过后提交并开 PR（基于 #411；#411 合并后合入 `origin/main`）。
2. 回执恢复合入 D9 后补 `resumeLanded` 路径与 K1–K6 崩溃矩阵，再评审。
3. 建 N9 的 live 对账器与 `OSSTACK_BRIDGE=1`，接通修订端口；随后 N10 的故障注入与变异测试（含 TLA+ README 列出的 5-F 覆盖缺口）。
