# C2 双向审查与处理

日期：2026-09-13。Claude Code 的两个独立只读审查均实际调用 `claude-fable-5-1`；modelUsage 同时含辅助 Haiku 调用，见各自 metadata。审查针对发送时的快照，并非对最终字节的签名；最终修订由主执行者检查并在 OSStack 验收循环内验证。

## 第一次设计挑战

[原审查](claude-design-review.md) 正确指出 updateState 可能重复 reducer/遗漏另一分支，固定 checkpoint_id 重放可恢复进度但会重进已完成函数。[独立复现](parent-explicit-resume.json) 确认：并发 2 的默认 null 恢复 join=0；精确 checkpoint 重放 join=1，但 completed 函数次数从 1 到 2。

其“只有全步重放、没有其他公开路线”的判断漏掉 Functional API。主执行者独立运行 entrypoint/task，得到 completed=1、flaky=2、join=1，并把反证和取消反例交回 Claude。第二次审查明确修正原结论，认为公开 Functional API 有条件可行；没有把模型意见当作正确性的替代证据。

## 第二次 Functional 审查

| 质疑 | 处理及证据 |
|---|---|
| wrapper=1 不充分，可能种子阶段根本未执行/未缓存 | 最终 probe 逐个 seed 检查 completedWrapper=1，读取公开 checkpoint 历史中的实际 RETURN。已持久 RETURN 的恢复保持 wrapper=1；效果已确认但 RETURN 缺失的恢复为 wrapper=2/effect=1。最终矩阵保存每阶段 `*-cut.json`。 |
| 缺恢复途中第二次强杀、join 确认/持久化之间窗口 | 增加 gated/ungated 两种三进程恢复，以及 join-effect-confirmed、final-checkpoint 前/后。ungated 切面明确证明 effect=1 而 join RETURN 尚未落盘，不能简单放宽函数计数。 |
| 取消/超时缺实际退出，recovered 效果计数不足 | 父进程在收到 abort 拒绝后 SIGKILL 子进程，等待 close 再恢复；检查晚到标记不存在。成功路径 recovered effect=1，取消/超时 wrapper=2；未决动作阻断整个夹具 run 新效果。保留不响应取消的负例。 |
| 任务缓存不绑定参数与程序顺序 | 主执行者独立[反例](parent-cache-identity.json)及 `packages/graph/src/functional-entry.test.ts` 验证：改参数仍返回旧结果；改调用顺序会重进函数。G08/G14/G18 必须固定并核对 executionModel、版本、input/spec/compiledProgramDigest；不允许用 updateState 改旧输入。 |
| ERROR 是 Error 实例，应该扩大 codec 类恢复 | 不采纳这一前提。固定版本 runner._commit 写普通 `{name,message}`，实际公开 tuple 也如此；任意 Error/undefined 继续拒绝。采纳 journal 方法白名单、参数校验、响应 wire round-trip、持久失败不复活的建议，七个 helper 测试覆盖这些行为及 ledger 信任/全 run 未决门。 |
| 同步文件 journal 不能证明 async RPC flush | 采纳：C2 仅准入 Functional + durability:sync 的后续集成；async 行是补充观察。G13 等待持久事务 ack，G14 固定 sync，G17 用真实 daemon/broker 重跑故障窗口。默认证据目录改为 mkdtemp，保证独立复验。 |

## 主执行者追加限制

`invoke` 拒绝与函数停止不是一件事：[取消反例](parent-functional-cancel.json) 顺序为 body-start → invoke-rejected → body-effect-after-delay。Worker 退出也不能证明 daemon 拥有的独立命令/agent 已退出。后续实现必须分别停止新动作、确认进程退出、对账未知效果、拒绝旧 generation。

早期 Node 20/22 复验期间源文件仍有变化，因此其通过结果不作为最终证据。最终 `runtime-final.json` 必须确认所有执行前后源码摘要相同。第一次最终复验启动 Vitest 时用了不存在的包内路径，属 harness 错误；修正为仓库根 Vitest 后重新执行，保留原错误日志。

本次不升级引擎、不引入私有 API、不删除 ERROR/pending writes，也不构建第二套节点调度器。StateGraph 反例不“转绿”：`--red-control` 继续退出 1；C2 的通过由限定执行模型的对应正例与故障矩阵支持。
