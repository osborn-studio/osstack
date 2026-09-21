# G25 接续：完整代际与连续 no-child 接管已落地

**25/30；G25 in_progress，G26–G29 pending。** 最新源码 `096a03f0db825d508a2004477fbc55f548005698`。[报告](../reports/graph-worker-coverage-validation.md)，[证据](graph-worker-coverage-evidence/admission.json)。

## 工作区

实施 `/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation`，分支 `codex/graph-runtime-foundation`。原 checkout 仅镜像本任务文档，不提交/覆盖用户 AGENTS.md。真实 Kimi K3 审查；真实 OSStack Loop、新 taskId、sources=[]、skipCompletedTasks=false、显式独立 OSSTACK_HOME/TMPDIR。无默认/保留 DB；不自动合并、推送或部署。

## 已有能力

- `GraphExecutorInventory.workers` 枚举全部 lease，含无动作中间代，进入完整 digest；连续性/数量/current owner 校验。最终 G15 事务内 `assertExecutorInventory` 可复验。
- `verifyJournaledGraphWorkerNotStarted` 位于 graph-worker-exit-proof.ts，同步、严格 no-child journal、时序与身份核验，不把没有进程/过期/intent-only当作停止。`verifyJournaledGraphWorkerExit` 保留 stopped-only 语义。
- sweep 对每代尝试 exit/no-child；任何 unproven 阻止容器访问。仍是诊断/精确清理，无恢复权限，workspace/descendants unproven。
- 实际 `recoverUnstartedGraphWorker` 不再限第一代，但仅在每代 no-child 且全 run 无任何动作/admission/checkpoint/write/request 时接管。私有 G15 注册闭包最终事务重新读 inventory、所有代的证明和 absence。确实启动过的历史代即使已退出也拒绝此路径。
- 112 focused、556 矩阵执行、5 verifier、Kimi K3 approved。测试有真实 OS 子进程及关闭重开 SQLite/全部宿主服务。本轮未运行真实 Docker。

## 下一步

1. 实际 host/adapter 持久停止/no-start 证据及独立 workspace 隔离证明。此次 no-child 仅针对 graph worker；不要误认为 writer/reviewer adapter 已解决。未登记后代仍需覆盖。
2. 从可信 descriptor/candidate manifest 构建注册，接入 G15 的实际 executor/workspace 同步最终复验。不能把 sweep JSON 当 attestation。GraphDelivery cancel workspaceEvidenceRef 仍复用 worker exit；takeover executorEvidenceRef 仍用 join ref，尚待修复。
3. 用完整可信业务 envelope/ledger 核验 applied/not_applied/unknown；物理删除不等于业务成功。按 G15 精确资源 release→DB admission release→接管，覆盖 ACK 丢失、跨代动作、撤权与并发停止。
4. artifact stale lock、余下 F01–F12，然后 G26–G29。

## 复跑

临时 harness `/Volumes/AIMATE_WORK/tmp/g25-worker-coverage`，持久版本在 evidence 目录。复制后更换 root/out/taskId，先 build，再执行 acceptance.mjs；保留首次失败证据。check.mjs 的 focused 与 matrix 不应带 G25_CONTAINED_CONFIG。专用 Colima osstack-graph-test 此轮未启动（前轮已停止），无需触碰其他虚拟机。
