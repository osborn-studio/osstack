# G25 冻结候选的容器测试与 Graph 汇合验收

状态：本轮限定阶段已实现；**G00–G24 完成，25/30；G25 仍在实施中**。本报告不代表任意崩溃恢复、公开 CLI 容器配置或生产发布准入。

源码提交：`dc89a1a6851694887e7dde5a49850dc62b1ab668`。机器证据：[admission.json](../implementation/graph-contained-candidate-evidence/admission.json)。

## 本轮交付

真实路径现在是：冻结 candidate → 从 Git blob 导出精确内容 → 固定构建配方生成镜像 → Graph 动作准入 → G04 单次调用 → 容器命令 → 确认删除作用域 → 持久验证回执 → 完整 join → ready / repair / stop。

`GraphDeliveryOptions.containedTests` 是可信 host 的显式选择项。它传入固定本地基础镜像 ID、专用 Docker Unix socket/daemon ID、私有 journalRoot，以及独立的 stop/read 当前权限检查。未选择时继续使用原有 shell 验证。没有新加公共 RPC、CLI 参数或模型可选执行器。

### 候选内容与镜像

- 在 G10 准备租约内恢复并核验 artifact；从准确 revision 的 Git 对象导出每个 regular blob，重算 blob SHA，禁用 Git replacement/config/hooks。对宿主工作副本的后续改动不能改变已经上传的快照。
- 只接受 1–10,000 个普通文件（100644/100755），总计最多 32MiB。拒绝 symlink、gitlink、路径穿越、非法 UTF-8、控制字符、重复路径和父文件冲突；USTAR name/prefix 分别限 100/155 字节。
- 主机生成 tar 与唯一候选目录，Dockerfile 只有固定的 `FROM <local sha256>`、`COPY`、`WORKDIR`。候选自己的 Dockerfile/.dockerignore 只是候选数据。基础镜像必须已经在指定 daemon，拒绝 ONBUILD 和声明卷；不传 registry 凭据。
- 使用 Docker API v1.47 的经典构建后端；逐行检查错误和 image ID，再检查 daemon、镜像标签及工作目录。没有 RUN 步骤。构建配方/内容摘要与基础镜像、最终镜像、目录和 daemon 一起进入回执。
- 此处信任主机注册的基础镜像、Docker daemon/admin 与私有日志存储；不是对恶意 Docker 管理员的隔离机制。构建 API 的 `pull=false` 不是 daemon 网络防火墙；本轮未宣称不可信管理员并发移除基础镜像时仍保证构建 daemon 零联网。

### 执行身份与结果

主机从实际已运行账本取得 effectKey；broker 提供 scope、run、generation 和实际 invocation。绑定同时包括 candidate revision、artifact digest、镜像回执和固定验收命令。其规范 JSON 在 Docker create 之前以 fsync/不可覆盖发布写入 `binding.json`；`launch.json` 的 specDigest 将该绑定、镜像、命令、工作目录与真实完整 container ID 连接起来。

容器保留既有隔离：非 root、只读根、无宿主挂载、无网络、no-new-privileges、能力清空、PID/内存/CPU/日志限额。执行目录改为镜像中的候选目录，临时输出只能使用已有 `/tmp`。测试依赖必须在可信基础镜像中；本轮不安装依赖、不允许项目内写构建输出、不支持需要外部服务的测试。

Graph 使用独立 `contained` 结果；不会伪造 POSIX process-group 证明。持久化校验实际调用的私有观察记录、候选内容摘要、effectKey、generation、invocation、镜像、目录以及 Docker removal receipt。加载时重算绑定/spec/receipt 摘要，join 使用对应执行类型的真实 exitCode。日志过长时只保留带摘要/原长度的预览。

- 0 或登记在 passExitCodes 的非零码（本轮测试 42）：确认测试通过。
- 登记在 failExitCodes 的码（1）：确认测试不通过，允许进入既有质量修复路由。
- 未登记码（7）或已证实停止的取消：非自动重试的基础设施失败，不生成 passed=false 冒充质量结果。
- 删除 ACK 丢失、停止无法证明或结果发布失败：保持 unknown/held，重放不产生第二个容器。
- G04 取消确认等待当前执行的删除流程后，再读取物理停止证明；外层仍有有界取消期限。Promise 完成不等于停止证明。

## 验证与审查

真实 OSStack Loop `G25-contained-candidate-acceptance-1`：executed=1、skipped=0、outcome=success；22 个包、3,332 项测试，9 项 verifier 全通过。固定 seed 250919/250920 故障矩阵 445 次测试执行，源码与构建产物哈希前后一致。另含既有 6 项容器故障探针和本轮 12 项真实候选/完整交付链测试；独立二进制探针也通过。全部测试套件运行于 macOS，容器执行于专用 Linux daemon。

真实容器测试使用任务专用 Colima profile `osstack-graph-test`，Linux daemon 独立于宿主 macOS。六项 broker 测试验证候选执行、0/1/42/7 分类、身份替换拒绝、取消与禁止重放；六项 GraphDelivery 测试验证两种并行完成顺序、跨代修复、显式分支重试、有限失败和 epoch 上限。后六项使用有限 writer/reviewer 测试适配器，Graph worker、SQLite/Functional 检查点、broker、Docker tests 与 join 均走实际实现。它们不等同于真实 LLM 内部试点或整个测试套件的 Linux 兼容证明。

完整交付链测试曾发现 join 仍只读取 shell 退出码；修复后六项全部重跑通过。最早几次测试失败还包括新测试错误查询 DB 列、审查输入使用绝对 evidence_ref；原始失败日志保留。Kimi 设计审查提出的旧接口缺口已接入实际实现；不把建议中“已证实停止的未登记退出仍必须保持 unknown”作为新协议，当前将其记录为非重试基础设施失败。

实际 Kimi K3 两次源码审查均为 approved；最终五项判断全部 pass、findings 仅 info，reported model_id 为 kimi-code/k3。设计审查与最早边界拒绝均保留，不计为通过的审查。第一轮 info 声称 blob 使用 UTF-8 解码；源码 execFileSync 未设置 encoding，返回 Buffer，独立真实容器探针对 `00ff800d0a` 的字节校验通过，因此该备注已驳回。输入路径要求合法 UTF-8 与文件内容允许二进制是两件事。另一个 retag 备注也不表示 tag 能替换本实现固定的 image ID；实际信任边界是 daemon/admin。见 [二进制探针](../implementation/graph-contained-candidate-evidence/binary-probe/result.json)。

验收后停止本任务专用 VM，实际测试容器清零；保留受控构建缓存。没有操作其他 profile、默认控制面 DB，没有合并、推送或部署。

## 剩余范围

1. 新 supervisor 的 Graph worker 真实停止证明，与全部已准入执行器的枚举/核验。
2. 从持久 binding/launch/stop 记录重建执行身份，对账业务结果，接入 G15 和精确资源释放。Docker removal 只能证明物理停止，不能单独证明测试成功。
3. 创建到 launch、删除到 receipt 等缺失回执窗口仍关闭，不按标签/年龄清理或重放。
4. artifact 锁的受控管理恢复、F01–F12 所有要求的子窗口及真实内部试点。完成这些后才能结束 G25，继续 G26–G29。

Docker 接口参考：[Engine API v1.47](https://docs.docker.com/reference/api/engine/version/v1.47/)。本轮读取其 OpenAPI 中 `/build`、image/container inspect 与 archive 输入约定；本地保留参考快照摘要，不依赖模型记忆确定 API。
