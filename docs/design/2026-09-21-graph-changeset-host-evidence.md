# Graph changeset host 调用与私有证据：P05b

日期：2026-09-21。基线：`55934b2`。状态：内部 host 服务和持久化链已实现，尚未注册到生产 GraphRpc/CLI executor；真实多文件 applier 仍属下一阶段。

## 交付边界

`GraphChangesetInvocationHost` 将已保留预算、已持有物理 admission 的 implement/repair action，连接到上一批的单次模型提案客户端。它拥有请求/响应证据持久化及 ledger 写入流程，但不创建 workspace、不写候选代码、不释放 admission。

这不是“新增一个模型名字就支持多文件”：真实授权验证、token 上限证明、物理工作区 lease 必须由调用方的同步 `verify` 提供；本轮测试中的 verify 明确为 fixture，不冒充生产 tokenizer 或 grant verifier。生产注册必须在这些具体实现及 applier 完成后进行。

## 新增模块

- core `graph/invocation-evidence.ts`：`GraphInvocationEvidenceStore`，独立子路径 `@osstack/core/graph-invocation-evidence`，不加入 core 根入口的 eager import。
- cli `graph-changeset-invocation.ts`：可信进程内调用服务。没有公开 RPC、CLI 开关或默认路由改动。
- core `GraphActionStore.recordRejectedInvocation`：非 proposal 终止响应和 nonretryable failed outcome 的原子事务。
- agents client：终止结果提供受限原始响应 Base64，供 host 存入私有存储；共享 `changesetResponseDigest`，避免两层复制摘要算法。

## 写入与调用顺序

1. 验证调用者初始 fence、action，生成冻结的精确请求。
2. 确认 SQLite 为 WAL 且 synchronous=FULL/EXTRA；不满足就拒绝。不会悄悄改变共享 daemon 设置。
3. host 验证 profile/grant、owner 固定 endpoint/model、真实 workspace lease、对最终请求字节成立的输入 token 上限；客户端 reservation 不得超过 action 已保留额度。
4. 私有 request 证据文件写完并 fsync，临时目录 fsync，原子发布并 fsync 根目录。
5. 单次调用门禁中重新读取请求证据，执行最终同步授权，刷新当前时间，再 `beginInvocation`。只有 changed=true 可发 HTTP。
6. 接收一个合法 provider 终止响应后，先持久化原始 response，再持久化 provider-terminal receipt；两者均绑定 scope/run/effect/generation/requestDigest。
7. proposal 写入 `recordInvocationResponse`，action 保持 running、预算仍保留，等待真实 applier。cannot_complete/rejected 由 `recordRejectedInvocation` 一次事务写入响应和 failed outcome。
8. 只针对明确的 REVISION_CONFLICT 最多重试三次 ledger 写入，刷新 revision/time，固定原 scope、identity、generation、owner；绝不重发 HTTP。其他错误保留证据和未决状态。

授权和磁盘操作都在 SQLite 事务之外；BEGIN IMMEDIATE 内仍只有同步 SQL。最终授权完成后再次取时间，避免慢授权导致已过截止时间的请求被发送。

## 存储契约

root 和其父目录必须由 host 控制，位于 producer 不可访问的区域。root 为 0700；每个发布目录 0700，evidence.json 为 0600。拒绝 symlink、额外 hardlink、错误 owner/mode、根目录 inode 替换。它不是对恶意同 UID 主机进程的 sandbox。

每条证据的 binding 包含版本、GraphScope、runId、effectKey、generation、requestDigest、kind(request/response/terminal)。文件名由 binding 摘要派生；返回引用同时包含 binding 摘要及完整 envelope 摘要。read 必须提供期望 binding 并校验引用、内容、canonical JSON 和 Base64 往返一致性。同一 binding 的不同内容永远冲突。

单条原始证据最多 512 KiB，封装最多 710000 字节；response 客户端另有 65536 字节上限。读取使用固定容量 buffer 并检查前后 fstat，避免文件增长导致无界读取。不会输出工作区内容或 provider 错误正文到错误码中。

发布方式是私有临时目录内写 evidence.json、fsync 文件及临时目录，然后 rename 整个目录。已发布目录非空，POSIX rename 不会覆盖它。遇到已有目录会校验内容；已有目录丢失 evidence.json 属于损坏，不能当作空槽覆盖。

在 rename 前 SIGKILL：仅留下未发布的临时目录；lookup 看不到证据，且还未获得 HTTP 门禁。在 rename 后 SIGKILL：证据文件仍只有一个链接，重新打开可正常读取。临时目录不会被自动扫除；后续清理必须有独立保留策略，不能把 GC 当恢复权限。

没有使用“硬链接发布后删除临时链接”的设计：审计发现其崩溃窗口会留下 nlink=2，导致严格读取器拒绝完整证据。已改为上述目录原子发布并增加实际子进程 SIGKILL 测试。

## 停止、预算和恢复语义

provider_terminal 只说明受约束的 provider 调用终止，并不证明物理 workspace 已释放。服务没有任何 admission.released 调用。即使 cannot_complete 已是 failed，持有的 admission 也保留给可信 host 清理/核验。

proposal 的实际 usage 保存在私有 terminal receipt，ledger 继续保留先前预算，直到 apply 完成再结算。client 会拒绝任何 input/output 上界超限，host 还验证 reservation>=输入上界+输出上界，所以有效 proposal 不能偷偷超过保留额度。超限响应进入 rejected/failed，core 保守计费并置 accountingBlocked。无法安全表示的 usage 总和保留为 null，保留容量并阻止继续计费。

HTTP 超时、断连、取消、响应落盘失败或 ledger 失败不会产生 retrySafe。服务尽力将同请求的运行中 action 记为 unknown/cancel_pending，并返回已有证据引用；若 DB 不可用或原 lease/generation 已失效，则保留 running/已有状态，返回需核对结果，不能声称未知状态已成功落盘。

重复调用收到 not_authorized 不会把另一个正在执行的相同 effect 改成 unknown。effectKey 有意不包含 generation；旧 effect 保留原始 generation，beginInvocation 拒绝 action/run generation 不匹配。新的逻辑 retry 必须按原 ledger 规则增加 logicalAttempt；不能通过 generation 变更覆盖请求。

lookup/read 只用于读取证据，不构成恢复、重新发请求或解除 quarantine 的授权。本轮尚未提供从 unknown 自动恢复到 failed/applied 的入口。

## 持久性与限制

新服务明确要求 WAL FULL/EXTRA，证据文件与目录均显式同步；不支持的同步操作直接失败。既有 daemon 默认 NORMAL 没有被修改，生产接入需单独配置并验证同步策略。

SIGKILL 覆盖是进程崩溃证据，不是物理断电认证；操作系统、文件系统和硬件是否兑现同步承诺仍是部署环境验收项。证据存储必须随控制平面一起备份，丢失证据不能据此释放账务容量。

## 下一步

1. 完成真实 profile/grant/token-bound verifier 与 host enrollment；提供长调用期间 lease 续期和停机管理，保持原 generation 绑定。
2. 真实 Git 多文件 applier：物理路径/inode/preimage 核验、journal、目标树核验、beginApply/completeApply 接线及每个文件写窗口的故障注入。
3. 将保留的 provider 证据接入可信恢复流程，明确管理员弃置隔离 workspace、账务处置及新审计事件；不覆盖原有 immutable receipt。
4. 完成后才激活 GraphRpc/CLI 路由和付费 canary。
