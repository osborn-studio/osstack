# 升级实施计划的独立审查

2026-09-13，Claude Fable 5.1 基于 30 张任务卡做一次禁工具的可执行性挑战。原始输入与答复保留在本目录，不能把答复当成实现验收。

已采纳并落实：

1. G13/G16 明确迁移文件责任；v1 固定同库独立 graph_* 表，G08→G11→G13→G16 串行 DDL。
2. G05 定义 worker 动作协议，G14 明确 IPC action client，G19 增加 G14 依赖。
3. G04 只返回 implementation_complete；G16 freeze 后才能返回 candidate_ready，避免自动 commit/merge 混入。
4. G14/G17 在最小纵向链阶段贯通取消；G23 暴露既有底层能力，不拖到 CLI 阶段才补取消。
5. G00 增加现有命令复核。审查中提到的 daemon-policy-gate/session-rpc/RPC latency/发行脚本与 schema scripts 实际已存在，重新验证结果见 verified-existing-references.json；没有将它们误改成新增任务。

补充判断：G05–G07 可在 G00 后独立推进，早点验证 Saver 风险；OSBot 的独立试点不依赖工程 Graph。没有采纳“OSBot 一律不得接入任何已有接口”的绝对限制；已有 session 接口需单独验证，新的 graph v1 集成等待 G24。

最终计划：[详细实施计划](../2026-09-13-osstack-graph-upgrade.md)。全部实施任务仍为 pending；本轮只校验文档、依赖、引用与模型记录，没有执行新运行时测试。
