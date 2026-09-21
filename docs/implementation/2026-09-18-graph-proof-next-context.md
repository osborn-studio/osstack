# G25 接续：contained 证明闭包已验证

**25/30，G25 in_progress，G26–G29 pending。** 源码 `407e21695fe1f476e4cf345bc6ceeaa26550ca85`。[报告](../reports/graph-contained-proof-validation.md)，[证据](graph-contained-proof-evidence/admission.json)。

工作区 `/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation`，分支codex/graph-runtime-foundation。原checkout只镜像本任务文档，不提交/覆盖AGENTS。真实Kimi K3审查、真实OSStack Loop、新taskId、sources=[]、skipCompletedTasks=false和隔离OSSTACK_HOME/TMPDIR。不得访问默认或保留DB，不自动merge/push/deploy。

## 新接口

- agents ContainedCommandExecutor.captureQuiescence(id)：actual inspect后生成isolated.json，与stopped.json独立；capture先验两journal，再fresh daemon+404，返回冻结scope=contained-invocation、executorEvidenceRef、isolationEvidenceRef和sync recheck。仅单次容器调用，没有graph级授权。
- cli reopenGraphContainedTests.captureQuiescence()：加effectKey并要求recheck位于已有DB事务中，assert完整GraphExecutorInventory，重新读binding和两个agent journal以及当前grant。变更revision/admission/其他动作/worker清单即失效。G15改变snapshot后必须重新打开，不能沿用旧fence。
- 同步回执检查无Docker await，依赖受信Docker admin/私有journal下精确ID删除的单向性。不是防恶意管理员/daemon数据恢复的机制。
- 旧调用无isolated.json：confirmStopped仍可返回true，但新capture拒绝。已删除后不允许补伪造隔离历史。
- 实际G15测试只组合固定无后代fixture worker、唯一contained action，提交unknown并保持held；没有一般GraphDelivery全图恢复注册，不能照抄测试假设到生产。

## 下一段

1. 从可信descriptor/candidate manifest构建实际全量注册；非容器host action与opaque writer/reviewer的持久停止/no-start以及完整workspace隔离。其他后代仍需独立覆盖。
2. 用完整证据替换GraphDelivery cancel workspaceEvidenceRef=worker exit与takeover executorEvidenceRef=join的旧占位含义。新per-invocation closure不可当整个workspace proof。
3. 完整业务envelope核验applied/not_applied/unknown，按G15精确资源release→DB admission release→接管。动作物理停止不等于业务成功，ACK丢失/历史代/撤权不得绕过。
4. artifact锁与F01–F12余项，随后G26–G29。

## 验证/复跑

Loop G25-contained-proof-bridge-2：12真实Linux专项、5检查通过；矩阵579执行并以源码/dist哈希复核复用；Kimi K3 approved。原65/1测试旧revision失败和真实测试5秒timeout、首轮Loop结果保留。

harness临时目录 `/Volumes/AIMATE_WORK/tmp/g25-proof-bridge`，持久复制在evidence中。复跑更换out/root/taskId；先build，用scripts/verify-graph-runtime.mjs生成新的matrix.json，再build-child.mjs；核验专用Linuxdaemon/不可变base image后创建candidate-config.json。最终check.mjs matrix使用verify-current-matrix.mjs校验已通过的相同源码/dist矩阵，不会重新执行矩阵。real使用testTimeout30000与G25_REOPEN_CHILD。测试后只停止自己的osstack-graph-test profile，不改变默认context或其他VM。
