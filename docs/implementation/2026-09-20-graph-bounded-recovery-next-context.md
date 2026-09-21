# 首轮受控 writer 恢复完成后的接续上下文

日期：2026-09-20。工作区 `/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation`，分支 `codex/graph-runtime-foundation`。源码提交、测试和模型审查见 [验收报告](../reports/graph-bounded-recovery-validation.md) 与 [机器任务清单](2026-09-13-osstack-graph-upgrade.tasks.json)。原 checkout 只镜像本任务文档，不能提交其其他用户修改。

本轮完成 G25-C2 的“已停止 writer，账本或释放 ACK 丢失，worker 已有可信退出日志，原 host 随后退出”切片。公开 graph.reconcile 能复核宿主恢复日志、原始 delivery 回执、完整两动作库存、候选原始指纹和精确旧锁，经 G15 提交 applied、释放原 token 并投影 cancelled。不会再次调用模型，不恢复为 ready，不启动后续节点。

关键代码：`graph-bounded-recovery-journal.ts`、`graph-bounded-recovery.ts`，通过现有 `graph-delivery.ts` 和 `graph-rpc.ts` 接通。子进程夹具为 `scripts/fixtures/graph-bounded-settlement-crash.ts`，测试 `graph-bounded-recovery.test.ts`。DeepSeek HTTP 是确定性 fixture；上一轮的实际付费 API 试跑仍是独立证据，不把两者混为一谈。

父卡仍 **25/30**；本轮不是新的无入口 helper，而是已贯通公开 RPC 的实际结算与释放。G25-C2 的剩余工作必须针对尚未验收的具体窗口，不再重复本轮已证明的路径。

## 下一步

1. **优先补原 G25-D 证据矩阵。** 对照原计划 F01–F12，列出已具备的测试和缺口，以现有业务链路补缺。不要再次扩大通用恢复框架而无法关闭验收项。
2. **明确并实现 C2 剩余突然崩溃窗口。** 原 host 未记录 worker 退出时，本轮故意保留占用。须审计真实 worker 的 IPC、文件系统和外部执行能力，再决定可否引入“孤立 worker 已失去动作权限”证明，或需要独立 supervisor 记录退出；不应把这个状态直接命名 stopped。任何新证明必须限制能使用的 G15 决定，并验证旧 host/旧 worker 不会重启执行。现有 host PID ESRCH 仅证明原宿主当前不存在，不证明任意子孙或远端推理停止。
3. **G26-B 可独立推进。** 完成旧 checkpoint 拒绝、备份恢复未知占用保留与旧入口兼容，避免继续以 G25 未完成为理由停下兼容实现。
4. G27 构建/版本矩阵、G28 性能、G29 真实内部任务按原依赖继续。注意本轮同步指纹读在恢复事务中持有写锁，需纳入恢复操作性能测量。

## 已固定的恢复边界

- generation 1 / epoch 0 / template 4，仅 workspace + implement 两个动作，前者已确认且释放；后者是具有完整终态证据的受控 API writer。后续模板不能通过同名节点自动获得旧恢复权限。
- 私有独立 clone 的原始文件及 Git 元数据指纹，最多 32 MiB / 10000 项，仅跳过宿主 writer-locks；不支持软链接、共享硬链接或特殊文件。无有效日志时执行可继续，但恢复保持拒绝。
- 原 host PID 必须不存在；活着、暂停、重用 PID 和 EPERM 都不构成死亡。还必须有真实 worker 退出日志。任意缺证据、文件变化或撤权均保留占用。
- 释放重试需要当前授权及可信旧决定。后来取得的 token 不能删除；原 token 已不在时，只确认已停止旧动作的释放，不执行任何重发。
- 旧请求 key 在中间 revision 已变化后只返回现状；明确重试应获取新 status，提交新 key/current revision。新 generation 不在本恢复范围。
- API 断线/超时未知动作仍不自动释放、重试或扣成零成本；之前真实 DeepSeek pilot 的 unknown hold 不要清除。

继续使用 OSStack Loop 做实际验收，并用 Claude CLI Fable 5.1 只读审查。凭据已在仓库外私有文件中，只有明确需要真实付费试跑时才注入；无需再次向用户索要，也不要把凭据交给审查模型。
