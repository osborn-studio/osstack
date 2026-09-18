# G25 第九阶段：受控容器独立隔离证明与 G15 同步复核

源码 `407e21695fe1f476e4cf345bc6ceeaa26550ca85`。新增每次受控容器调用的独立隔离回执和删除回执复核闭包，已在真实 Linux 容器与 G15 事务内验证。**仍是限定准入；G00–G24 完成，25/30，G25 in_progress。**

## 实现与可信边界

- `ContainedCommandExecutor` 在实际 Docker inspect 核验精确 container ID、nonce、image、working directory 和既有无宿主挂载/无网络/非特权/只读 rootfs 策略后，原子持久化 `isolated.json`。它与 `stopped.json` 分开，前者证明该调用的隔离策略，后者记录精确 DELETE ACK 与移除。
- `captureQuiescence(invocationId)` 必须具备两份严格绑定、顺序正确的回执，再向固定 Linux daemon 重新确认该 ID 的 404。返回冻结的 executor/isolation refs、`scope=contained-invocation` 和受信宿主闭包，不接受模型的 stopped 布尔值作为输入。
- 同步 recheck 复验当前 grant 和同一组私有 journal；不在 G15 数据库事务中等待 Docker。前提是现有受信 daemon/admin 和宿主私有 journal，精确 Docker ID 的已确认删除不可自行复活；不覆盖恶意管理员或恢复 Docker 数据目录的越界操作。
- `reopenGraphContainedTests` 捕获完整 executor/worker inventory 和绑定 journal，闭包仅在已有事务内运行 `assertExecutorInventory`。无 run revision 变化的 admission release、其他动作、回执或 grant 漂移都拒绝。同步 journal 读取使用 O_NOFOLLOW/O_NONBLOCK、fstat regular-file 检查与有界读取。
- 闭包只证明该容器调用与其宿主访问隔离；不是图级 workspace 安全，也不涵盖其他 producer。实际 G15 测试宿主使用固定、无后代程序和唯一 contained action，组合 direct-worker exit 与该闭包。缺业务 envelope 时提交 unknown，绝不因已删除而宣称 applied 或释放 admission。
- 旧调用若只有 stopped.json，原 confirmStopped 行为保留；新 capture 拒绝。已删除容器无法补做历史隔离观察，不从404反推。普通 GraphDelivery cancel/takeover 的完整证明仍待接入。

## 验收

实际 OSStack Loop `G25-contained-proof-bridge-2`：执行1、跳过0、success，12 项真实 Linux 专项与5项 verifier通过。同文件另54项未选中，不计为通过。包含新 Node 进程读取原 SQLite/journal、重新连接 daemon并创建/同步复验闭包；真实 G15 提交与事务内撤权、隔离回执丢失、release drift拒绝。隔离/删除证明引用相互独立，workspace ref 不再在这个限定测试中复用 worker exit。

固定seed 250927/250928矩阵 **579 次执行**通过（loop112、agents47、core79、cli337和并发复跑4），源码和构建产物哈希一致。最终 Loop 对已通过的同一份矩阵重新核验完整源文件集合及每个 source/dist 哈希后复用，未把旧源码的结果当作新版本准入。typecheck、schema freshness、CLI startup、whitespace均通过。未声称全库/Node20/22兼容完成。

真实 Kimi K3 (`kimi-code/k3`) approved，4 项判断通过，审查与验收源码哈希一致；真实daemon待验证意见已由后续实际运行解决。目录组件替换TOCTOU仍在受信宿主私有journal/admin边界内，未声称O_NOFOLLOW封闭全部父目录路径。具体 findings 和裁决在证据中。没有把 configured model/readiness 当作审查结论。

首次CLI专项65通过/1失败：G15成功提交推进revision后，测试继续用旧fence查询动作；修正为只读核对已存行，没有更改生产逻辑，完整66项通过。首次真实Linux运行11通过/1测试超时：5秒集成测试时限不足；仅将外部真实测试harness时限设为有界30秒，生产deadline不变。随后12项通过；首轮Loop失败记录保留，新任务编号完成最终验收。矩阵对应源码始终未变，因此复用前再次逐文件核验哈希。

[机器证据、首次失败和复跑脚本](../implementation/graph-contained-proof-evidence/admission.json)。专用Colima osstack-graph-test已核验零容器并停止，默认Docker context保持colima；其他虚拟机未操作。使用显式隔离OSSTACK_HOME/TMPDIR，未访问serving DB，未merge/push/deploy。

## 下一步

由可信descriptor/candidate manifest构建全部实际action注册；非容器host action/opaque adapter的独立停止证据及整个workspace隔离；把这些证明接入GraphDelivery真实取消/接管。随后业务envelope对账、精确资源与admission释放、ACK丢失与跨代恢复、artifact锁，再进入G26–G29。不能将此闭包推广成整个图的安全证明。
