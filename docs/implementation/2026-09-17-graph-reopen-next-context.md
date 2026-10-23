# G25 接续：从单动作容器重建进入整图停止与 G15 对账

**G00–G24 完成，25/30；G25 in_progress，G26–G29 未开始。** 第五阶段报告：[按账本重建容器执行身份](../reports/graph-contained-reopen-validation.md)。

## 工作区与约束

- 实施工作区 `/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation`，分支 `codex/graph-runtime-foundation`；本轮源码提交 `fd6687665bb01b68b09bf96a44c1356e8f3c2452`。
- 原 `/Volumes/AIMATE_WORK/Developer/CodeX/osstack` 仅镜像本任务文档；保留用户 AGENTS.md 与其他改动，不提交原 checkout。
- 用户指定真实 Kimi K3 审查，使用 `KimiCodeAdapter` + no-tool review profile，确认 runtime identity `kimi-code/k3`，不切回 Claude。
- 使用真实 OSStack Loop、独立 OSSTACK_HOME/TMPDIR、新 taskId、sources=[]、skipCompletedTasks=false。不要访问默认/保留控制 DB。
- 不自动合并、推送、部署。专用 Colima profile `osstack-graph-test` 测后停止；默认 Docker context 不变。只处理精确测试容器 ID，不做标签/年龄批量清理。

## 本轮可复用入口

- core `GraphRecoveryStore.inspectAdmission(fence,effectKey)`：原子读取 snapshot + historical admission owner；允许 expired fence 的管理读取，但不授权任何恢复动作。
- CLI `reopenGraphContainedTests(db, options, request)`：host-only、单 action。request = fence/effectKey + 可信 manifest binding/command/contentDigest；options = 固定 daemon/base image/socket/private journal + 当前同步 read/stop grants。
- 以 executionRef 找 invocation → canonical binding.json → specDigest/launch.json → 独立停止/删除回执。只暴露 identity/confirmStopped/stop；没有 execute、settle 或 release。
- 每个异步边界重新检查当前 grants、完整 snapshot/admission 和 journal。若 G15 提交导致 run revision 或 action 状态改变，旧 handle 会拒绝；release reverify 必须用新 snapshot 重开，不能强行刷新旧 handle 或忽略 fence。
- 故障矩阵已纳入新测试。全部证据与可复跑 harness 在 `docs/implementation/graph-contained-reopen-evidence/`；模板内临时路径需要换到新的独立目录。

## 下一轮明确起点

1. 先设计可信旧 worker stop verifier，检查 `GraphProcessJournal` 的 immutable launched/exited 事件、binding、pid、confirmedAt 与该代 lease 的一致性。真实 parent-observed exited 与当前 `/proc` leader absence 是不同证据；后者不足以证明任意后代停止。未观察退出的崩溃窗口暂保持 held。
2. 用 host registration 枚举全部未释放 admission，按执行器种类分流。新 helper 可以重建 contained tests，但不能替代 opaque writer/reviewer 的独立停止证明；没有 admission 或 launch 的窗口也不能当作没执行。
3. 为 G15 注册实际 verifier：先停/核验 worker，再核验所有 executors/workspace 隔离，最后用已完整发布的可信验证 envelope 或账本结果核验业务 outcome。物理删除与业务 applied/not_applied 分开；缺结果仍 unknown。
4. 精确资源 release + DB admission release + takeover 按已有 G15 顺序处理；补 release ACK 丢失、跨代旧 action、并发 stop、权限撤销与完整故障窗口。不要开放通用公开 resume。
5. artifact 锁管理恢复、G25 未完成子窗口仍是后续必做；之后进入 G26 兼容、G27 发行/Node、G28 性能和 G29 真实内部试点。

## 已验证和限制

实际 OSStack Loop `G25-contained-reopen-acceptance-1` 完成 22 个包、3,368 项测试，9/10 项 verifier 通过；唯一失败是本轮 harness 漏建 real-evidence 目录，10 个真实容器链用例写报告时 ENOENT。补建目录后，新 Loop `G25-contained-reopen-recheck-1` 重跑 12 项受影响的真实测试，执行 1、跳过 0、outcome=success，2 项 verifier（恢复测试、既有证据哈希核验）通过。第一次 escalated 记录原样保留，没有改写为成功，也没有无理由重跑已通过的全套测试。固定 seed 250921/250922 故障矩阵共 481 次测试执行，1069 个源文件及构建产物哈希前后一致并在补验时再次核对。本轮共满足原定 10 类验证，包含既有 6 项真实容器故障检查、12 项候选/完整 GraphDelivery 容器链检查、3 项新恢复检查；另有独立的账本绑定 SIGKILL 场景。

新的 SIGKILL 探针杀的是容器执行宿主，不是对所有 Graph worker/executor 的整图证明。完整 GraphDelivery 中 writer/reviewer 仍是有限测试适配器，不是真实 LLM 试点。并发 stop 不合并请求，竞争者保守失败，不得据此释放未知动作。

## 复跑准备

复制 evidence 中的 harness 到新独立临时目录并改 root/out、Loop ID。先核验专用 Linux daemon 和本地基础镜像，生成 `candidate-config.json` = `{socketPath,daemonId,baseImageId}`；既有 executor probe 的 `config.json` 把 baseImageId 字段改成 imageId。构建后运行 `build-child.mjs` 生成独立 Node 入口。

**必须先创建 `<out>/real-evidence`。** 首轮验收恰好漏了该目录，产品断言之后写报告 ENOENT，导致 Loop escalated；补目录后使用新 `recheck.mjs` 成功，不应重写第一次历史。新复跑可在启动 harness 前显式 `mkdir -p` 所需目录。`retained-evidence.mjs` 是本轮针对既有固定哈希证据的补验，不能拿旧哈希批准新源码。
