# 候选执行的停止请求与观察基线

状态：首片已实现并通过本地完整验证，待 GitHub 审核与合并。基于 main `32146c40cf179d16a87768fa921d606adf61dbca`，承接[下一阶段计划](../design/2026-09-09-autonomy-next-implementation-plan.md)。这是 R0 / P1a 的第一片，不是一次授权到 PR、完整中断恢复或已证明有效的自改进。

## 行为

- 新 `claim` 都持久化逻辑 worker UUID 和代次，调用者必须把返回的 worker 传给 `recordWorktree` / `complete`。worker 是并发一致性标识，不是认证凭据或进程身份证明。
- `improve stop --execution <id> --reason <text>` 默认预览；`--yes` 写入停止请求，使旧代次失效。停止先提交时阻止终态和 worktree 登记写入；完成先提交时保留原结果。重复停止不改写首个原因或时间。
- 执行器检查阶段边界和 adapter 事件。已经开始的模型调用、shell 或验证批次可能继续运行；不承诺立即取消、杀进程或回收 worktree。返回的 `process_termination_confirmed` 明确为 false。
- 停止或不确定执行保留 claimed/running 占用，阻止新 attempt 盲目重跑。原状态加 stop 字段表示未决，不等于成功或已停写。停止来源区分 operator 和 system_indeterminate。
- 无成功完成回执的 builder、抛出执行异常的阶段，以及非零命令或失败 adapter 回执的验证，保留未决占用。命令旧回执不能充分区分信号退出与普通错误，因此普通非零 gate 也暂时保守处理；这项误拦截待结构化退出证据完善。
- `improve baseline [--proposal <id>]` 从一个查询快照导出全部匹配尝试与绑定请求，不用分页前 100 条算统计。四个状态桶互斥；stop_requests 是其中的重叠标签。费用和手工 go 次数未采集，返回 null；候选通过不等于交付或有效性证明。

示例（使用已安装且升级后的 CLI；开发 checkout 必须先指定独立、非保留的 OSSTACK_HOME）：

```sh
osstack improve status --execution attempt-1
osstack improve stop --execution attempt-1 --reason 'inspect uncertain worker'
osstack improve stop --execution attempt-1 --reason 'inspect uncertain worker' --yes
osstack improve baseline --proposal proposal-1 > baseline.json
```

JSON 快照的 sha256 绑定除 sha256 本身以外的全部字段，使用递归排序对象键的规范 JSON，数组保留顺序。它能检测内容变化，不能证明指标有效、数据可信或实验因果收益。request 包含原先冻结的 base、模型路由与验收配置；旧数据缺失的信息不会被编造补齐。该导出没有启用新的付费模型运行或后台观测。

## 升级与剩余边界

新增 migration 26；不修改 migration 25。迁移保留已有 active/terminal 记录，新列和 SQLite trigger 阻止停止后旧式结果写入。需要先 drain 旧进程、备份 DB 并协调升级 core/CLI；旧二进制不能直接回退读取新 schema。测试只使用临时 DB，未迁移正式 serving home。

API 兼容范围：既有无 owner 记录保持可读可更新；新记录不能再省略 owner 更新。旧客户端需使用 `claim(...).execution.worker`。当前仍只有可信本地操作员控制面；能任意写 DB 的程序不受此标识认证保护。

没有恢复或强制释放命令，也没有 lease 超时抢占。用户停止后只能查看证据并保留现场；P1b 必须先有真实 worker 停写／隔离证据才提供恢复。候选工件（包括 manifest）本身不是授权或已完成证明，消费方必须核对执行状态与绑定摘要。

## 验证

本地验证结果：

- `pnpm build`、`pnpm typecheck:check` 通过。
- 使用独立临时 OSSTACK_HOME 运行 `pnpm test`：290 个测试文件、2,542 个测试全部通过。
- `pnpm lint` 通过，无新增问题；仅有原先 `upgrade.ts` 的两条可选链警告。
- `node scripts/generate-inventory.mjs --check` 通过。
- `node scripts/bench-cli-startup.mjs`：version 中位 31ms、help 中位 84ms，低于本地 150ms / 500ms 预算。
- `git diff --check` 与新增文档相对链接检查通过。

新增行为采用先失败后实现的测试流程。定向测试覆盖新旧调用混用、停止/完成两种先后次序、重启持久化、原 SQL 写路径、迁移 25→26、重复停止、builder/reviewer 中停止、未决执行重放，以及超过默认列表上限的完整基线。

[两轮 Fable 设计挑战与取舍](2026-09-09-execution-control-fable-review.md)。
