# Graph 升级解阻与下一轮执行上下文

日期：2026-09-18。用户要求调用 **Claude CLI Fable 5.1** 协助解决长期停在 25/30 的问题。本轮实际调用 `claude-fable-5-1`，没有用其他模型冒充。

## 为什么卡住

G25 累积了进程、容器、journal、文件读取等必要但局部的加固，未把它们收敛为真实用户可以使用的恢复入口。测试用有限 agent 实现 `confirmStopped`，内置 Claude Code/Codex CLI/Kimi Code adapter 却不实现它；因此既有成功夹具不能证明真实后端可用。同时，公开 RPC/CLI 尚无 reconcile 入口。继续只加内部 helper 的测试不能跨过这两个产品阻塞。

## 本轮有界交付

- G25-A：缺少停止确认的 writer/reviewer 在新 run reservation 前返回 `EXECUTOR_UNSUPPORTED`；直接 delivery 和 broker 注册也拒绝。实际 invocation 仍逐次验证停止证据。
- G26-A：动态 `graph-host.json.admissionEnabled` 开关。false 拒绝新 reservation；已受理任务继续，读取、结果、原请求重试、取消、授权 live quality resume 保留。默认缺省 true，文档示例默认 false。
- 新错误经 RPC/CLI 明确返回，退出码 1，`retryable:false`、`nextAction:stop`。不会把确定拒绝误报为未知提交。

验收证据见 [本轮报告](../reports/graph-admission-unblock-validation.md)。父任务仍为 25/30；G25 与 G26 均实施中，未声称真实后端已可试点。

## 接下来按产品路径交付，禁止重新无限扩展 G25

| 切片 | 交付边界 | 必须通过的验收 |
| --- | --- | --- |
| G25-B：一个真实后端的执行范围与停止证明 | 选定一个明确受支持的 writer/reviewer 组合，复用现有 agent/Loop/权限链；先声明可隔离的副作用范围，再实现真实生命周期。仅 PID/PGID 消失不满足任意后代/远端效果停止。 | 真实临时仓库运行到 ready；取消确实停止其受支持范围内所有工作；不支持的 scope/后端仍在执行前拒绝。检查默认只读 sandbox，不能将只读 writer 当作可写成功。 |
| G25-C：公开对账入口与现有 G15 接通 | CLI/RPC 身份、scope、幂等、revision fence；消费已有 stop/inventory/workspace 独立证据。读取恢复报告不能自行授权释放。 | 全新 host 可查询并对账；缺证据返回 unknown/保持 holds；已证明停止才能落库决策和精确释放；并发旧 owner、失联 host、崩溃中间代不误接管。不得把找不到进程内 supervisor 等同 host 已死亡。 |
| G25-D：业务故障矩阵关闭 | 把 G25 原始 F01–F12 每行绑定到真实业务测试、命令与日志；补 host 丢失、workspace/逃逸后代、注册失败、artifact 临时锁等原验收缺口。 | 固定 seed 重复；旧 worker 不污染新 candidate；confirmed/cached RETURN/join 次数分开断言；未证明停止的路径始终 fail closed。只有原验收逐项有证据才关闭 G25。 |
| G26-B：兼容与回滚剩余项 | 可与 G25-B/C 的实现交错推进；已有准入开关先落地。验收依赖 G25 保持不变。 | 旧 Loop/session/explain、共享仓库租约、不兼容 checkpoint、备份恢复保留未知动作；关闭准入时公开 reconcile 仍可用（依赖 G25-C）。 |

每张切片超过一轮或约 5 个生产源码文件时，先按真实用户行为拆子卡。新增审查发现必须归属上述具体验收项或单独 backlog；不能以发现任何新加固点为由无限延期下一条产品路径。以上是实施排序，不删除原 G25 验收、不降低 G15 的物理证明标准。

G27 的发行构建/运行时准备、G28 性能基线可在代码接口稳定后准备；最终验收依赖仍保留。G29 真实内部试点必须等待受支持后端与恢复限制被验证，不能拿有限 fake agent 或普通 Claude 审查调用冒充试点。

## Claude 建议的采纳与保留

采纳：先拒绝不支持的 executor；动态关闭新准入但保留旧 run；明确公开 reconcile 缺口；将 G25 收敛为有限交付。

未直接采纳：用进程组 ESRCH 证明任意后代/远端副作用停止、用没有导入 child_process 证明不会产生后代、用 worker exit 或 workspace retained 标签代替独立执行器/workspace quiescence。它们都不足以满足现有 contract。可在明确隔离边界后实现窄范围 profile，不能直接添加总是返回 true 的确认回调。

## 工作区与保护边界

实施分支 `codex/graph-runtime-foundation`，路径 `/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation`。所有开发运行使用独立 OSSTACK_HOME。原 checkout 的用户 AGENTS.md 和研究资料不动；仅基线一致的自有计划与新证据镜像。不要 merge/push/deploy 或迁移服务中的数据库。
