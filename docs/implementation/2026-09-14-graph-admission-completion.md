# G08–G10 / C3 实施验收

**G08–G10 已完成，C3 通过；累计 11/30。下一轮为 G11–G13 / C4。生产 Graph 运行时仍未完成。**

实施工作区：`/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation`；分支：`codex/graph-runtime-foundation`。G08/G09 代码提交：`b3f77fc`；G10 代码提交：`055e217f7d4d29e0a93278544efb3b7b5b6f7beb`。基线：`b95cc11`。

## 已实现的能力

- **G08**：迁移 25；图 run/请求身份、完整 scope、不可变程序/输入摘要、worker generation、租约历史及 CAS。重复请求返回原结果；内容、程序、owner、generation 或 revision 不匹配时拒绝。
- **G09**：从实际 Git common directory 计算仓库身份；同仓库多 worktree、多 HOME、多进程共用写锁。带 token 的续约、释放和代际检查，原子发布锁记录，保守处理崩溃和未知 owner。
- **G10**：共享健康/授权/并发/仓库锁准入；接入 daemon、受管 Loop、本地 Git Loop、session/collaborator 和受信任的进程内 Graph 入口。策略同时约束主仓库和当前 worktree；写目标不匹配明确拒绝。

G10 超出原任务卡的单一模块规模，按四个子步骤实施：G10a 共享准入与租约生命周期；G10b daemon/Graph/Loop 集成；G10c 前台 CLI、session 与旧执行路径兼容；G10d 真实进程/跨实例/故障验证。它们仍归属于原 G10，不额外增加 30 项总数。

## 验收边界

这里交付的是执行基础。Graph worker、动作账本、checkpoint broker、自动恢复、完整工程图和 graph run CLI 尚未交付。StateGraph 的 partial-abort 汇合反例仍阻止其生产使用；已准入路线仍为 Functional API + sync。

未知外部执行会保留锁和占用的写容量；不会把取消请求、terminal event 或 daemon 退出当成停机证据。不能确认停止时不自动重发。当前需按[离线恢复边界](graph-admission-evidence/recovery-boundary.md)处理；自动恢复属于 G14/G15。

## 证据说明

初期 G08/G09/G10 通过真实 OSStack Loop + CodexCliAdapter 实施；原始子执行日志所在系统临时目录后来已不存在。保留的 executor handoff 是历史自述，不冒充仍可读取的原始证据。最终验收重新由实际 LoopEngine 驱动，使用外置盘独立 OSSTACK_HOME，并归档输出、状态和源文件摘要。

此前 Node 20.6/20.20/22.22 的 native SQLite 冒烟运行结果已在会话中观察到通过，但其原始临时日志未保留；不把它们列为本次可复核的最终兼容性证据。最终运行时及精确测试数以归档验收记录为准，G27 仍负责正式支持矩阵。

Claude Fable 5.1 的设计挑战、实现审查及后续复核单独记录；模型审查不是测试结果，也不是自动合并授权。

## 最终验证

- 真实 OSStack Loop 的第二次验收成功：全库 **2,737 项测试 / 22 个包**通过，六条独立验证命令全部通过。第一次验收保留为失败记录：测试错误假设并发 RPC 完成 Git 身份解析的先后顺序；修正为验证三次唯一启动、最多两个活跃 writer、队列释放后继续执行。
- workspace strict typecheck、protocol schema freshness、G07/C2 内核回归通过。C2 探针 42 个实验、56 个断言、96 个进程、26 次实际 SIGKILL；它输出的 `admitted:false` 是不自行宣布生产准入，不能误读为整个工程图已可运行。
- CLI 启动实测中位数：`--version` **40 ms**（预算 150 ms）；`--help` **146 ms**（预算 500 ms）。
- 审查后两处额外加固：顺序复用 LoopEngine 时清除旧的 effects-started 标记；释放锁等待续约后再次检查 retained。额外 **10 项 Loop 生命周期测试、6 项准入测试**通过，并重新 build Loop/CLI、通过全库 typecheck。上述 2,737 不冒充包含新增的第十项 Loop 测试。
- 新真实 daemon 测试覆盖：terminal 后生产者仍运行时继续持锁、真实子进程取消确认、未知 producer 跨实例拒绝、本地 CLI checkpoint/report 前的冲突拒绝，以及读写请求的目标目录语义。

[机器可读验收记录](graph-admission-evidence/admission.json)、[实际 Loop 结果](graph-admission-evidence/acceptance-result.json)、[最终源文件摘要](graph-admission-evidence/source-hashes.json)、[Claude 闭环审查](graph-admission-evidence/claude-closure.md)。

## 下一轮

按[接续上下文](2026-09-14-graph-admission-next-context.md)推进 G11 动作账本/预算、G12 受控 broker、G13 daemon checkpoint。此次没有 merge、push、部署或改动原工作区的源代码。
