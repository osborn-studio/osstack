# G25 接续：从候选容器回执接入崩溃对账

**25/30；G25 in_progress，G26–G29 未开始。** 本轮已完成冻结候选 → 容器 tests → Graph join 的可信 host 显式路径；报告：[候选容器验证](../reports/graph-contained-candidate-validation.md)。

## 工作区与执行约束

- 源码：`/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation`，分支 `codex/graph-runtime-foundation`；源码提交 `dc89a1a6851694887e7dde5a49850dc62b1ab668`。
- 原 `/Volumes/AIMATE_WORK/Developer/CodeX/osstack` 只镜像本任务文档；保留用户 AGENTS.md 和其他改动，不提交原 checkout。
- 审查使用实际 `kimi-code/k3` + no-tool KimiCodeAdapter，核实 reported runtime identity。不要自动切回 Claude。
- 继续实际 OSStack Loop 验收，独立 OSSTACK_HOME/state、新 taskId、sources=[]、skipCompletedTasks=false；绝不在开发 CLI 打开默认或保留 home。
- 不自动合并、推送、部署。当前没有生产准入。

## 已完成

`@osstack/agents` 新增延迟加载 `prepareContainedImage`；32MiB/10,000 普通文件的精确 Git blob 快照，固定本地基础镜像，无 ONBUILD/卷，host Dockerfile 仅 FROM/COPY/WORKDIR。只读候选镜像，无 host mount、执行网络或安装依赖。基础镜像需预置测试依赖；symlink/gitlink/项目内写构建输出暂不支持。

`GraphVerificationOptions.containedTests` 和 `GraphDeliveryOptions.containedTests` 为显式 trusted host 配置。broker 的 contained 分支仍复用 G04，当前真实 effectKey/generation/invocation 绑定候选/镜像/command。完整 canonical identity 在 Docker create 前写入 invocation journal 的 `binding.json`；后续 `launch.json` 固定 container ID；`stopped.json` 只证明物理删除。

Graph evidence/store/join 已支持独立 contained 结果及摘要验证。实际私有调用观察阻止伪造 persist；允许 pass 42/fail 1，未登记 7 或确认停止的取消是非自动重试基础设施失败。ACK 丢失保持 unknown/held/禁止重放。默认 shell 路径兼容。

真实 OSStack Loop `G25-contained-candidate-acceptance-1`：executed=1、skipped=0、outcome=success；22 个包、3,332 项测试，9 项 verifier 全通过。固定 seed 250919/250920 故障矩阵 445 次测试执行，源码与构建产物哈希前后一致。另含既有 6 项容器故障探针和本轮 12 项真实候选/完整交付链测试；独立二进制探针也通过。全部测试套件运行于 macOS，容器执行于专用 Linux daemon。

本轮六项真实 broker、六项完整 GraphDelivery 容器链测试都使用专用 Linux daemon。writer/reviewer 是有限测试适配器；不要把它们写成真实 LLM 试点。

## 下一轮明确起点

1. 梳理 `graph_action_admissions` + Graph action executionRef 到 journal invocation 的持久映射，并对 `binding.json` canonical data / digest、specDigest、launch/stop 链做 host-only 重建；不能仅按 Docker label 搜索恢复。
2. 新 supervisor 必须先证明旧 Graph worker 停止，再枚举和证明所有已准入执行器停止。当前 `registerContainedTests` 的私有观察 Map 只供活进程 settlement，不能用它冒充跨进程恢复能力。
3. G15 对账需分别判断物理停止与业务 outcome；只有完整可信验证 envelope/账本证据能证明测试结果。缺失业务结果不能从 removal receipt 推断 passed/failed。
4. 对账后做精确 admission/resource release，再允许 takeover。保留 opaque adapter unknown、泛用公开 resume 拒绝以及缺失回执窗口关闭。
5. 补 artifact 锁管理恢复与完整故障子窗口；完成 G25 后再推进 G26–G29。

## 复跑入口

证据目录含 `acceptance.mjs` / `acceptance-command.mjs` / `kimi-audit.mjs`。新一轮复制到独立 temp、替换路径/Loop ID，不覆盖本轮证据。

真实候选测试通过 `G25_CONTAINED_CONFIG` 指向 host JSON `{socketPath, daemonId, baseImageId}`；可用 `G25_CONTAINED_REPORT_DIR` 保存实际 envelope。运行 `graph-verification.test.ts` 的 contained/substitution 测试，以及完整 `graph-delivery.integration.test.ts`。后者检查正常、修复、重试和停止链。默认没有环境变量时使用原 shell/full tests 和 deterministic API fixtures。

专用 Colima profile `osstack-graph-test` 已停止、测试容器清零、保留构建缓存。显式复跑需只启动该 profile、核验 daemonID 与基础 image ID、使用其 Unix socket；不要操作其他 profile 或默认 Docker context，不自动拉镜像/清理标签匹配项。
