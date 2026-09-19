# G25 接续：binding reader 已补齐

**25/30；G25 in_progress，G26–G29 pending。** 源码 `1ca7d09bec024ba3a807adc8e9c5fdef9dd0c393`。[报告](../reports/graph-binding-reader-validation.md)，[证据](graph-binding-reader-evidence/admission.json)。此前[单次容器证明上下文](2026-09-18-graph-proof-next-context.md)继续有效。

工作区 `/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation`，分支 `codex/graph-runtime-foundation`。原checkout仅镜像本任务文档，保护AGENTS及用户改动。继续真实Kimi K3审查、真实OSStack Loop及隔离OSSTACK_HOME/TMPDIR；不自动merge/push/deploy。

## 本轮

CLI readBinding增加O_NONBLOCK与实际64KiB读取上限，补充6项测试。真实FIFO子进程复现旧代码3秒挂起，新代码200ms拒绝。Kimi初审指出增长测试不具区分力，现已补强：旧reader2失败、新reader全72通过。

Loop1新矩阵585次通过；Loop2完整72与5检查通过。最终仅测试文件相对矩阵版本变化，verify-matrix.mjs逐项验证生产源码/dist不变及审查后的测试哈希；不能称所有source hash相同。两轮Kimi均approved，最终意见见证据。

## 下一段（仍未实现）

1. 从可信descriptor/candidate manifest构建完整实际注册；持久化非容器host action、opaque writer/reviewer的独立停止/no-start证据，覆盖worker后代和整个workspace。
2. GraphDelivery cancel仍将workspace ref指向worker exit，takeover仍复用join作为executor ref；本轮没有改变这些路径。不得把单容器proof或binding读取安全推广为整图证明。
3. 业务envelope核验applied/not_applied/unknown；精确物理资源释放→DB admission释放→接管，覆盖ACK丢失、历史代与撤权。
4. artifact锁及剩余F01–F12，随后G26–G29。

原始harness：`/Volumes/AIMATE_WORK/tmp/g25-binding-read`；最终测试与Loop：`/Volumes/AIMATE_WORK/tmp/g25-binding-read-final`。记录型harness含固定路径/任务ID，复跑须使用新隔离目录、任务ID和当前源码矩阵，不可盲目覆盖旧证据。真实Docker profile本轮未启动。
