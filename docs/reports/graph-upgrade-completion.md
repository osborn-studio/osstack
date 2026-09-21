# OSStack Graph 升级：集成验收与分阶段发布

2026-09-20。**G00–G28 已完成研发验收（29/30）；G29 的真实内部试点与手册已完成，最终发布检查、独立审批及部署尚待收口。** 当前没有五个未开发的核心功能。PR #225 的迁移与执行器冲突已解决，不能把尚未通过的整条 CI 或部署计作完成。

## 已实现的能力

有界单仓库目标 → 单次实现 → 不可变 candidate/产物 → 并行独立审查与隔离测试 → 严格汇合、有限修复/重试、明确停止。复用现有 Agent、Loop、权限与规范仓库锁。账本/checkpoint、generation fence、准入撤销、取消、受控执行器核对均已实现；unknown 保留锁与预算，不自动重发。

真实 DeepSeek 在 OSStack clone 上完成代码修复并达到 ready；独立 reviewer 拒绝负对照；取消真实推理后保留未知结果及预算。见[试点报告](graph-runtime-pilot.md)。本轮修复了旧入口回收 graph 保留锁、升级遗漏图执行、真实仓库产物导出/恢复过慢等问题。

## 与 main 的整合

已整合 main `dc2a26f`，源码提交 `fec0b18`。保留 main 迁移 25–27 的 SQL，Graph 顺延为 28–37。纯旧 Graph 试验 DB 和混合历史在应用 DDL 前被拒绝；冻结的旧 DDL、WAL 崩溃、只读与当前版本重启均有回归。不能重置 `user_version`。

Loop 同时保留 main 的显式环境参数、`inheritEnv` 语义与 Graph 的进程组取消证明。实际 Claude CLI Fable 5.1 先要求加强迁移辨识，修复后给出 accept；附带的重启回归建议也已实现。这是独立代码审查，不能代替 GitHub 人工审批。

## 验证证据

| 项目 | 结果 |
|---|---|
| 整合前实际 OSStack Loop | 22 包、3,727 项测试及 4 个 verifier 通过 |
| 最终故障矩阵 | seeds 250920/250921，679 次执行通过，源码及 dist 哈希前后不变 |
| 最终性能 | RPC p95 1.452ms；Loop 开销 0.460866%；31 MiB fingerprint p95 21.267ms；尾延迟保留为债务 |
| Node 20.6 | 原 294 项通过；整合最终迁移/DB 45 项通过；GitHub 对应 runtime job 通过 |
| Linux arm64 Node 22.23.1 | 最终 389/389 通过；消除专用 VM 的两套时钟同步冲突后复跑 |
| GitHub CI / 源码 fec0b18 | Node 20.6、22.23.1 runtime jobs、全仓 3,974 项通过、3 项显式 opt-in 跳过；类型、构建、inventory 与启动预算通过。发布 plan smoke 暴露真实 npm bootstrap 查询泄漏，测试夹具已修复，本机 smoke 通过；registry-skew 对新包无历史版本的处理也已修复，22 项自检和真实混合安装通过，整条 CI 待复跑 |
| 本机整合全仓诊断 | 3,955 通过、6 个 CLI 限时/状态等待失败、3 个显式 opt-in 跳过；原始失败保留，不宣称该次全绿。GitHub 同源码全仓测试已通过 |
| 安装包关闭准入演练 | 独立 prefix、真实 daemon/native SQLite、旧 session/Loop/stats RPC 通过，Graph 返回 `GRAPH_ADMISSION_DISABLED`，新增 run 为零 |
| 线上 DB 副本演练 | 使用实际安装包迁移 schema 22→37，51 张原有表的记录数保持，完整性通过；未改变线上 DB |

整合证据见[集成验收目录](../implementation/graph-integration-evidence/README.md)，既有故障/性能/真实试点见[最终验收目录](../implementation/graph-upgrade-final-evidence/README.md)。本机单独复验为 95 通过、8 失败，仍不计为通过；同源码 GitHub 全仓结果独立列出。不同平台、重叠增量和历史测试数不相加冒充不同测试总数。

## 剩余发布工作

G29 只剩最终发布收口。GitHub 的完整 check job 要依次执行全仓测试和原有 npm/交付 smoke；整合后全仓测试约 14 分钟，整条作业的时间预算单独设为 35 分钟，单个测试和启动性能阈值不变。仍须取得该最终提交的检查结果和独立审批，再合并 main。

用户已指定首个启用仓库为 **OSStack 的独立工作副本**。合并后：停止新增图准入 → 备份实际 serving home → 以合并提交的安装包部署 → 验证旧功能与写入健康 → 只对该内部副本启用有限授权、固定任务、`artifact_only` 模板。线上部署和内部启用完成前不宣称已发布。公共 npm 发布还需为新增 `@osstack/graph` 完成首次发布；此次内部部署使用已验证的全套本地 tarball，不代表公共 npm 已就绪。

## 尚存技术债

1. **主线程尾延迟，中优先级**：最终 workspace fingerprint 仍在 SQLite 事务内同步读/哈希。RPC p95 合格，最大值仍达约 776ms；后续需要在维持 TOCTOU 防护的前提下缩短阻塞。
2. **异常资源运维，中优先级**：未证明停止的远程推理、opaque executor 与 artifact 残留锁需保留证据并人工处理。需要更好的观测和证据充分的回收工具，不能增加无证明的强制成功按钮。
3. **大产物内存，中优先级**：批量 Git 避免逐文件创建进程，但 buffer/bundle 峰值仍随大小增长。当前限制为 256 MiB、100000 文件；扩容前需流式实现和 RSS 基准。
4. **验收运行成本，中优先级**：全仓测试与历史证据较重，本机竞争负载可触发短测试期限。后续可拆分 CI 作业并改善诊断；不能忽略失败或盲目扩大单测超时。

迁移编号冲突已关闭。以上是本次确认的债务，不代表全仓没有其他问题。

## v1 产品边界

Bun 单文件不支持 graph；SHA-256/shallow/submodule 等未支持仓库格式显式拒绝。任意动态拓扑、多仓库蜂群、无证据恢复以及自动 merge/deploy 不属于本轮 v1。操作与回滚边界见[运行手册](../runbooks/graph-runtime.md)。
