# G25 第三阶段：可跨 supervisor 核验的容器命令执行器

日期：2026-09-16。**本批只准入显式启用的 contained image command；G25 仍为 in_progress，总进度25/30。** 尚未把此能力接入 Graph 的动作账本对账、资源释放和通用 G15 接管。

## 能力与边界

新增 `createContainedCommandExecutor` / `createContainedCommandAdapter` 两个延迟加载工厂，从 `@osstack/agents` 导出。host 明确提供 Unix socket、Docker daemon ID、固定 image SHA256、固定命令、精确业务绑定的 SHA256、私有本地 journalRoot，以及同步 `authorize(start|stop|read)`。不会读取默认 Docker context，也不会拉取镜像；未加入默认 adapter 路由或公开 CLI。

命令仅在 host 选定的镜像内运行，任务 prompt/context 不参与命令拼接。当前不把宿主 workspace 装进容器，也不声明已验证 candidate 内容；要测试真实候选代码，后续必须设计候选到镜像/快照的内容绑定。此次真实 Loop 单次执行实验只验证 adapter 接缝和物理停止。

容器配置固定：Linux private PID/IPC namespace、network=none、非 root、drop ALL capabilities、no-new-privileges、只读 root、无宿主 bind/volume/socket、受限 tmpfs、PID/内存/CPU/日志上限、restart=no、auto-remove=false。host 的 Docker socket 与 journal 是可信控制面能力，容器无权访问；此机制不防御恶意 Docker 管理员、伪造的宿主 journal 或内核漏洞。

## 停止证明

- 调用 ID 使用完整 SHA256 作为目录名；原子 mkdir 永久消耗该调用，父目录 fsync 后才 create，禁止重试创建同一调用。
- Docker create 之后、start 之前，持久发布包含完整 container ID、daemon ID、nonce、固定配置/业务绑定 digest 的 launch 记录。文件先写入临时文件并 fsync，再 hard-link 原子、不可覆盖发布，随后目录 fsync。
- 新 supervisor 必须从可信 journal 重建身份，检查实际配置与 pinned daemon，重新核验 stop 权限；仅对这个完整 ID 发出 force DELETE。
- 只有明确 DELETE 204、同 daemon 查询该 ID 为404，且停止回执持久发布，才能返回 stopped:true。每次 confirmStopped 都重新核查回执、daemon 和容器不存在。
- 删除容器而非仅 kill leader，是为了封闭旧 supervisor 的迟到 start。正常成功、取消和错误清理都遵循相同物理范围；停止证明不等于业务成功。
- create 到 launch 落库之间崩溃、DELETE 成功但回执未落库、API超时、损坏记录、错误 binding/daemon 均保持 unknown。该阶段不实现按 label/name 自动找回或删除 orphan；缺少回执的记录不能自行升级为 stopped。

Linux 的 PID namespace init 退出会终止其 namespace 中的其他进程，详见 [Linux pid_namespaces(7)](https://man7.org/linux/man-pages/man7/pid_namespaces.7.html)。API操作遵循 [Docker Engine v1.47](https://docs.docker.com/reference/api/engine/version/v1.47/)。作为实现原理参考，Moby v28 源码用 removal/dead 状态拒绝新启动并持久移除：[delete.go](https://github.com/moby/moby/blob/v28.0.0/daemon/delete.go)、[start.go](https://github.com/moby/moby/blob/v28.0.0/daemon/start.go)。本机实际测试版本为 Docker29.5.2，实测与上述参考源码版本分开记录。

## 实际测试

在专用 Colima profile `osstack-graph-test`（独立CPU/内存/磁盘，无宿主目录挂载，不切换默认context）使用 Linux6.8.0-117、Ubuntu24.04.4、Docker29.5.2，镜像固定为实测 image SHA256。

1. 真正调用现有 `executeCandidateImplementation`，固定镜像命令执行成功，独立新 executor 核验停止回执。
2. 命令启动独立 session 子进程，记录不同PGID/SID；杀死原 supervisor 后容器仍运行，新进程精确移除并核验，旧 ID 的 start 返回404。
3. 原 supervisor 暂停在 start 请求前；新 host 删除该容器，恢复旧 host 后不能重新启动或重新 create。
4. create 后未落 launch、DELETE 后未落回执两种真实进程崩溃保留 unknown，原 invocation ID 不可重放。
5. 实际 abort 停止运行范围并保留新 host 可核验的回执。
6. 另行重启专用 Docker daemon，之前回执仍可核验。此项是实际 daemon 重启实验，不是整库 Linux 兼容认证。

最终完整源码复审 **approved**，proof / authority两项judgment均通过，无阻断问题；实际runtime_identity为provider=kimi、model_id=kimi-code/k3、evidence_source=reported。剩余3条均为info：confirmStopped统一返回unknown、create到journal间隙的管理回收缺口，以及abort无法证明停止时继续保留unknown。

源码 `8d16b37be20187624fafd7bcc275329dc70bea98`。真实 OSStack Loop `G25-contained-executor-acceptance-1`：executed=1、skipped=0、outcome=success；22个包、3,307测试全部通过，8项verifier全部通过。固定seed矩阵共420次测试执行，seed250917/250918，源码与dist前后哈希一致。另有6项真实Linux容器检查全部通过；18项单元测试已纳入矩阵。

verifier为全库类型检查、schema freshness、Saver与Functional内核探针、CLI启动预算、故障回归矩阵、真实contained executor故障实验、diff whitespace。普通全库测试主机为Darwin/Node v26.5.0；Linux证据仅为该容器执行范围。

启动预算结果：

```text
ok   osstack --version (fast path): median 27ms over 5 runs (budget 150ms; min 26, max 28)
ok   osstack --help (full command surface): median 78ms over 5 runs (budget 500ms; min 77, max 88)
```

[机器验收](../implementation/graph-contained-executor-evidence/admission.json) · [真实Loop结果](../implementation/graph-contained-executor-evidence/acceptance-result.json) · [容器故障记录](../implementation/graph-contained-executor-evidence/real-final.json) · [审查裁决](../implementation/graph-contained-executor-evidence/review-adjudication.md)


验收后该专用VM已停止，测试容器清零；默认Docker context仍为原值。保留停止的profile与镜像供显式复跑，不在日常OSStack启动时自动开启。

## 剩余 G25 工作

- 将容器身份与 Graph 的精确 effect/run/generation、持久准入及 G15 对账绑定；独立证明 graph worker 已停止；业务 outcome、资源释放和接管仍需分别授权。
- 建立候选快照/镜像内容及测试证据绑定，不把任意镜像 exit0 当作当前仓库候选通过。
- 处理创建/删除回执丢失后的严格管理恢复；当前留存 unknown，不自动重建或删除未知对象。
- artifact 残留锁的受管恢复、完整 F01–F12 子窗口与三类计数；真实 Linux 全套兼容测试仍归 G27，不能用本批六项实验替代。
