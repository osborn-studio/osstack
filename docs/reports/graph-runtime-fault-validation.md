# G25 故障验收：最终映射与历史基础


## 2026-09-20 最终验收映射

本轮以原任务卡的安全行为收口：证据充分的受控动作可恢复；未知 executor、缺失退出证明、残留 artifact 锁继续 held。不会把 PID 消失、租约过期或“没有看到效果”转换成 `not_applied`。Fable 5.1 已复核这个范围，拒绝为消除 held 而增加无证据的人工释放入口。当前总门槛状态见[最终报告](graph-upgrade-completion.md)；下方 9 月 15 日内容是历史证据。

| 故障窗口 | 最终回归证据（packages 下） | 必须保持的行为 |
|---|---|---|
| F01 终态/迟到输出 | loop/src/executor.test.ts | 无 done、冲突、abort 后成功不产生候选 |
| F02 intent 后执行不明 | graph-action-broker、graph-recovery-crash、graph-contained-recovery | 独立 host 重开账本，unknown 不重发 |
| F03 效果后 ledger 前 | graph-chain.integration、graph-bounded-recovery | 持久停止/内容证据与原锁核对，不宣称物理恰好一次 |
| F04 confirmed 后 checkpoint 前 | graph-chain.integration | 函数可重入查询已确认结果，物理动作不重复 |
| F05 pending writes / RETURN / barrier | graph/functional-runtime、remote-saver；core/state/graph-checkpoints；graph-chain.integration | 已持久 RETURN 不重入；效果确认和函数重入计数分开，逻辑 join 一次 |
| F06 旧 generation | graph-checkpoint-service、graph-action-broker-boundary | put、putWrites、action 及缓存返回全部受 fence 约束 |
| F07 迟到旧 writer | core/graph/artifact-store | 真实 SIGKILL 和迟到写入不能污染冻结候选/恢复目录；残留锁不自动删除 |
| F08 撤权/过期/scope | graph-review-findings、graph-concurrency.integration | 下一动作不启动，resume 必须符合当前权限 |
| F09 并发与换 attempt | graph-concurrency.integration、graph-unstarted-recovery、graph-recovery-crash | SQLite 多连接/多进程准入；相同 key 去重，不同输入冲突，unknown 不绕过 |
| F10 汇合与旧 epoch | graph-verification、graph-verification-join | 同候选、同 epoch、join 一次；格式失败和业务失败分路 |
| F11 cancel/timeout/后代 | graph-worker-exit-proof、graph-contained-recovery、agents/contained-command、graph-chain、graph-concurrency | 真实 PID/PGID/启动身份与独立执行器证明；worker 退出不等于所有副作用停止 |
| F12 旧格式/禁用/备份 | graph-compatibility.integration、graph-admission、graph-reconcile-rpc、graph-rpc、autonomy/repo-lock | 禁用后仍可读/取消/核对；恢复未知动作不重发；旧 writer 不偷保留锁 |

表内 CLI 简称对应 `packages/cli/src/<name>.test.ts`。脚本 `scripts/verify-graph-runtime.mjs` 保存固定 seed、逐测试输出、源码及 dist 哈希；它本身仍只是诊断运行器。准入结论还依赖真实平台、独立审查、性能与内部试点，不能只根据 coverage 文件列表推出。

额外修复：`recovery_policy:reconcile` 持久锁阻止默认/显式 stale recovery；真实已发布 0.17.0 获取入口也不能夺锁。升级/回滚在停止和备份前检查未终结图与保留准入，drain 期间拒绝新图。旧 checkpoint 格式拒绝，真实 SQLite 备份重开保持未知动作和原账本。具体结果见[兼容矩阵](../implementation/graph-runtime-compatibility.md)。

最终 seed 250920/250921 矩阵通过：autonomy 20、graph 21、Loop 112、agents 47、core 81、CLI 394，另重复 CLI 并发 4 次，共 679 次执行；源码与 dist 前后哈希未变。[最终矩阵与绑定哈希](../implementation/graph-upgrade-final-evidence/faults.json)保留逐文件原始结果。该结果为 main 整合前代码；整合后的迁移/环境参数变更由独立平台和全仓 CI 补充验证。

## 2026-09-15 阶段报告

日期：2026-09-15。**本批是 G25 的第一阶段，G25 尚未完成；任务总进度仍为 25/30。** 本批源码 `4590fcb494e1fff991138f77c687b47fa7544c5f` 已通过本地限定验收。

## 本批交付

1. 在已有 `graph_worker_launches` 启动意图之上，增加迁移34的不可变进程事件日志。保持原有进程组和 live-child 信号行为。实际子进程启动后、发送 init 之前，记录 PID、实际 PGID、OS 启动身份；注册失败、未创建子进程、退出未确认及真实退出分别记录。
2. `GraphRuntime.observeWorkerProcess` 从持久日志和当前 OS 观察生成诊断。新 host 无需原 supervisor 的内存即可检查旧启动记录，但接口不发信号、不释放资源、不重放动作，也不授予恢复权限。Linux 使用 boot id 与 `/proc` start ticks；macOS 的粗粒度启动时间只用于诊断，身份判断保留 unknown。
3. 已消耗启动权的 generation，不能仅因没有动作或 checkpoint 就声明 `not_started`。G15 要求匹配身份、时间和引用的持久 no-child 回执，且不能有矛盾的启动/退出事件。
4. 数据库关闭屏障等待真实 `finalExit` 事件，因为晚到的退出观察也要写日志。超时返回 `exit_unconfirmed` 不等于数据库使用结束。
5. 增加双连接提交、四个独立进程 SQLite 准入竞争、撤权后并发取消、resume/cancel revision 竞争和两个固定 seed。真实冻结进程被 SIGKILL 后，残留锁保留；旧目录中的迟到进程写入不能修改已导出的候选及其新恢复目录。

真实崩溃 fixture 杀死 supervisor 后，让原 worker、同组后代和脱离进程组的后代继续存在。新 host 只能返回观察与 held；即使随后杀死 leader，也不能把后代或外部执行器判定为停止。这是拒绝错误接管的证据，不是已完成安全接管的证据。

## Claude Opus 5 协作与裁决

用户已明确授权使用 Claude Opus 5。实际 CLI 使用 `--model claude-opus-5`，响应 modelUsage 确认主模型；设计审查原始响应随本批证据保留。模型用量中还可能包含 CLI 内部的辅助模型，不将它们称作主审模型。

采纳设计审查中的启动前后窗口、PID 重用、子进程与执行器区分、持久 no-child 和真实崩溃测试要求。未直接采用 FIFO 作为停止证明：后代可关闭或不继承 fd，FIFO 无写者仍不能证明所有执行器停止。也没有仅凭审查中的措辞扩大修改仓库锁；现有仓库锁释放还要求匹配 owner 和独立 quiescence 回调，裸 PID 判断并非唯一释放依据。

首轮代码复审 REQUEST_CHANGES，已逐条裁决：

- 实际修复退出日志失败被已 settled Promise 吞掉的问题，新增 `journalError` 随实际退出回执返回；保留物理退出事实。
- 撤回新增 detached 启动行为，记录实际 PGID，避免诊断改动扩大存活进程的行为差异。
- 验证脚本自动构建，绑定源码和实际 dist 哈希，要求每个指定文件存在断言。
- `spawnFailed` 原有 `child?.pid` guard 已阻止 post-spawn error 被分类为 no-child；新增真实 kill-error 回归反证此路径。实际 runtime 日志经过 G15 的集成测试也验证了 canonicalizer 一致性。
- CLI 是 tsup 单入口打包，未被入口引用的测试 helper 不进入发布产物；数据库生命周期屏障保持等真实退出，不能以超时关闭仍在使用的 DB。

固定 seed 的首轮矩阵另发现命令取消竞态：外层 adapter 的 50ms 宽限短于内层 TERM/KILL 窗口。新增 150ms 正常退出的真实命令先稳定失败，修复后通过；外层命令宽限改为内层两个 1s 窗口加 500ms 观察/交接余量，仍要求实际停止回执。未知 adapter 的保护不变。

最终整批源码复审为 **PASS — bounded G25 diagnostic slice only**。随后处理两个非阻断意见：先将可选字段转换成合法 JSON 再 canonicalize，避免 `pid: undefined` 形成不可解析的不可变记录；PGID 测试允许合法的 unavailable/null。新增 JSON 回归先失败后通过。

首轮全库验收记录 3,265 通过、2 失败。失败来自两个旧 chain 用例：它们依赖原 50ms 窗口，假定忽略 TERM 的命令必然 unknown 且 broker 已立即排空。实际留存回执证明进程组在 KILL 后消失，账本正确 settled failed/retrySafe:false。用例改为等待实际 drainage，检查 stop_confirmed、PGID 与真实命令 PID、OS 消失和锁释放；fixture 安装 handler 后才发 started 标记，并 exec 命令以避免 shell 中间进程。opaque adapter 未证明停止时的 unknown/保留准入断言仍保留。最后改动另交 Opus 5 复核并获得 PASS，最终验收另起 taskId，原失败不计入通过结果。

原始失败及反证均保留，不把初审误报、建议或连通性测试当作已经实现的能力。

## 最终验收结果

- 实际 OSStack Loop `G25-foundation-acceptance-2`：executed=1、skipped=0、outcome=success；3,268 个测试全部通过，22 个包，另有 7 项 verifier 全部通过。
- verifier：全库类型检查、protocol schema freshness、Saver 内核实验、Functional C2 实验、CLI 启动预算、固定 seed 故障回归矩阵、diff whitespace。内核探针保留既有 StateGraph 反例，实验 passed 不等于生产 admitted。
- 最终矩阵：Loop 112、Core 65、CLI 200，再复跑并发 4，共 381 次测试执行；seed 250915/250916。源码与实际 dist 构建产物前后哈希一致。
- Claude Opus 5 整批复审与最后差异复审均为限定 PASS；模型只读源码，真实测试由本机 OSStack Loop 执行。JSON/PGID 两条建议已处理。
- CLI 启动中位数：`--version` 28ms（预算150ms）、`--help` 79ms（预算500ms），各测5次。
- 平台仅本机 `darwin` / `v26.5.0`；真实 Linux、新 supervisor 安全恢复和完整故障矩阵仍待后续。
- [机器验收记录](../implementation/graph-fault-foundation-evidence/admission.json)、[完整 Loop 结果](../implementation/graph-fault-foundation-evidence/acceptance2-result.json)、[矩阵及源码/产物哈希](../implementation/graph-fault-foundation-evidence/matrix2.json)、[审查裁决](../implementation/graph-fault-foundation-evidence/review-adjudication.md)。

## 可复跑验证

脚本会先构建工作区；使用显式、独立的开发 home：

```sh
OSSTACK_HOME=/absolute/isolated-test-home \
TMPDIR=/absolute/isolated-tmp \
node scripts/verify-graph-runtime.mjs \
  --seed 250915 --repeat 2 --output /absolute/evidence/graph-faults.json
```

该脚本运行关联 F01–F12 的既有及新增测试，保存逐测试 JSON、日志、seed、源码与构建产物哈希；第一次运行完整关联集合，后续轮次重复并发测试。测试文件遗漏、零测试、失败、跳过或运行中源码变化都不能得到通过结果。**coverage 表示关联回归集合，不表示每个故障子窗口及所有平台已获得准入。**

## 2026-09-15 当时的剩余项（历史记录）

- 新 supervisor 独立证明实际 executor 停止，并经 G15 完成受管恢复；opaque adapter 与脱离进程组的后代仍无法由本批观察接口证明停止。
- 更强的 macOS 进程身份与实际 Linux 平台验证。本机测试中的 Linux 身份比较不能代替 Linux 真机运行。
- 公共 submit 持久化后、构造前崩溃，以及 spawn 到身份记录之间的完整进程故障矩阵。
- 残留 artifact 锁的受管、可审计释放路径；本批仅证明不会自动删除残留锁。
- F01–F12 每个子窗口的完整映射，以及同一恢复场景下函数重入、确认效果、逻辑 join 三种计数。

以上是 2026-09-15 的阶段性判断。后续受控恢复、进程证明、真实试点与本轮最终验收见收口报告。任意崩溃自动恢复和生产发布仍不在已准入范围。
