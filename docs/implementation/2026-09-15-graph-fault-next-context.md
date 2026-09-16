# G25 接续：从持久进程诊断到独立执行器停止证明

本批源码 `4590fcb494e1fff991138f77c687b47fa7544c5f` 已通过本地限定验收：全库 3,268 测试、7 项 verifier；真实 Loop executed=1/skipped=0/success，实际 Claude Opus 5 两次源码复审 PASS。见 [故障验收报告](../reports/graph-runtime-fault-validation.md)。**G25 保持 in_progress，总进度 25/30；G26–G29 未开始。**

## 工作区与协作

- 实施：`/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation`，分支 `codex/graph-runtime-foundation`。
- 原 checkout `/Volumes/AIMATE_WORK/Developer/CodeX/osstack` 只镜像本任务拥有的文档；保留其 AGENTS 与用户改动。
- 用户最新明确授权使用 **Claude Opus 5**，无需继续等待 Fable 5.1 或 Opus 5.5。实际 CLI 指定 `--model claude-opus-5`，保留响应 modelUsage；遵循 `claude` 技能的只读审查限制。
- 继续使用真实 OSStack Loop：独立 home/state、新 taskId、`sources:[]`、显式 inputTasks、`skipCompletedTasks:false`，检查 executed/skipped/outcome。不要把 actor 的 `git diff --check` 当全库验收。
- 开发 CLI 一律显式独立 OSSTACK_HOME，禁止默认或保留服务 DB。不得自动 merge、push、部署。

## 本批代码

新增 `graph-process-identity.ts`、`graph-process-journal.ts`；迁移34 `graph_worker_process_events` 是不可变事件记录，关联既有 generation 启动意图。manager 通过可信同步回调在 init 前记录实际进程，在真实退出或未创建子进程时记录独立事件；重复启动拒绝不能为既有 generation 写伪造 no-child 记录。

`GraphRuntime.observeWorkerProcess(binding)` 是 host-only **诊断**：原始身份/历史观察和当前 leader 观察分开；executor 固定 unknown、recovery 固定 held。Linux boot/start ticks 与 macOS 粗粒度 lstart 不同，后者不证明 PID 连续性。没有数字 PID kill 接口，也没有公开恢复新入口。

`drainDatabaseUsers()` 除 action/checkpoint Promise 外还等待 `finalExit`，防止 late exit 的日志写入越过 DB 关闭。G15 `not_started` 在存在 consumed launch 时要求匹配的持久 no-child 回执，拒绝缺失、错 identity/owner/ref/time、与 launched 矛盾的事件。

新增故障/并发测试和 `scripts/verify-graph-runtime.mjs`。脚本首次运行关联矩阵，后续用相邻固定 seed 重跑并发；所有测试逐项通过、文件齐全、源码未变才返回成功。该报告不是完整 G25 准入。

## 下一步顺序

1. 明确可跨 supervisor 重建的 **executor** 身份与停止证明。仅 worker 的 PID/PGID/退出不够；对不能证明停止的 adapter 必须保持 unknown/held。先实现一个真实受控执行器路径，通过 G15 严格验证，而不是给所有 adapter 添加乐观默认值。
2. 补齐 macOS 更强身份方案并实际验证 Linux。不要把 mocked Linux identity 比较写成 Linux 实测，也不要把 FIFO 无写者当成所有后代停止。
3. 补实际公共 submit 提交/构造前、spawn/身份记录前崩溃窗口；确认失败后只保留不确定性，不用新幂等 key 或新 generation 绕过原动作。
4. 添加 artifact 残留锁的严格管理恢复，绑定原 owner、候选/动作/已提交对账结果；保留当前不按年龄清锁的安全性。
5. 完整 F01–F12 子窗口与固定 seed 故障矩阵，同一场景同时记录函数重入、confirmed 效果、logical join 计数，然后才能完成 G25。

新 runtime 的观察对象不能直接转换成 `GraphRecoveryProof.worker.stopped`。公开 GraphRpcService 在缺少 live supervisor 时仍拒绝 resume，这是有意保留的限制。

## 验证注意

嵌套 Codex workspace-write 环境可能禁止 Unix socket 监听；本批曾出现 13 个 daemon 用例的 EPERM。保留失败日志，用有既有 socket 权限的主执行环境运行完整验收，不能通过跳过 daemon 测试或放宽产品规则消除失败。最终验收前冻结源码，避免混用 Vitest 已加载的旧模块与新测试。
