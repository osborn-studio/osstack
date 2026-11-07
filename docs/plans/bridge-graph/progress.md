# 执行进度

续做时先读 [graph.md](graph.md) 与本文件，从“下一步”继续。

## 图

- **已完成（已合并）：** 阶段 0–4（#368–#394 之前各 PR）、5-A（#393）、W13 设计（#383）、W13-B（#385）、App E M-A（#384）、M-B（#390）、TLA+ 模型（#387）、P-13（#388）、阶段 6 规格（#389）、链存储修复（#391）、运行手册（#392）。
- **进行中：** N2 #395、N3 #396、N4 #397（已合入含修复的 `main`，等 CI 与合并）；N5 已提交，等 N2。N1 #394 已合并。
- **阻塞：** N11（宿主 Docker）、N13（Grok Bots 运营者）、N14（仓库管理员）。

## 产物

| 节点 | 位置 |
|---|---|
| N1 | PR #394，分支 `feat/bridge-observability` |
| N2 | PR #395，分支 `feat/w13-host-process-store` |
| N3 | PR #396，分支 `feat/bridge-merger-service` |
| N4 | PR #397，分支 `feat/bridge-revision-child` |
| N5 | 分支 `feat/w13-local-writes`（未开 PR） |

## 失败与重试记录（失败也记，便于对比）

| 节点 | 尝试 | 结果 | 处理 |
|---|---|---|---|
| P-13 | 真实运行 1、2 | 分类器把 GitHub 的 “Bypassed rule violations” 当成拒绝 | 修分类器并加测试；第 3 次通过 |
| TLA+ | 不加约束的运行 | 2 100 万 / 1 500 万状态仍未结束 | 加 `FocusPublish` 约束，13 秒找到反例 |
| W13-B | Linux CI 第 1 次 | 替换标记测试在 Linux 复用 inode；T7 依赖 macOS `lsof` | 保持旧 inode 打开；T7 只在 macOS 跑 |
| W13-B | Linux CI 第 2 次 | `graph-recovery-crash` 测试读到未写完的 JSON | 与本 PR 无关，重跑通过；测试本身的竞态未修 |
| #391 + #393 | 合并后的 `main` | 两条 grant-store 测试失败 | 在 #394 对齐测试（6b58ba7b） |
| #383 | CI 第 1 次 | 文档链接指向未合并文件 | 改为路径加 PR 号 |

## 决定

- 2026-11-07：采用门控节点图推进剩余工作（graph.md §7）。
- 已由用户决定：迁移号 52/53/54；阶段 5 默认值；授权用主机签名；W13 恢复不杀进程；P-13 只在沙箱。

## 待定

- `OSSTACK_BRIDGE=0` 是否也停止 App A 首轮发布（运行手册发现）。
- App E 设计 §8 其余决定；阶段 6 规格 §13 八项；W13 设计 §10 其余决定。
- 确认 App A、C、D 的 bot 用户 id。
- `graph-recovery-crash.integration.test.ts` 的读文件竞态是否单独修。

## 下一步

1. 按合并顺序 N2 → N3 → N5 → N4：每合并一个，把下一个合入 `origin/main` 并解决冲突。
2. N2 合并后开 N5 的 PR。
3. N5 合并后启动 N6（W13-C2）；N3 合并后启动 N12（M-D）。
