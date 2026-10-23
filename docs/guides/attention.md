# Attention：任务状态与决策

`osstack attention status` 提供单次只读快照。它不会启动 daemon、迁移数据库或承诺后台接管。

```sh
OSSTACK_HOME=/absolute/isolated/home osstack attention status \
  --db /absolute/isolated/home/state.db --task TASK_ID \
  --repo /absolute/repository --default-tenant --json
```

开发 checkout 只能使用显式隔离 home，禁止打开默认或 reserved home。

- task 与 run 都限定默认租户；session 额外核对持久 repo_path。无法绑定的记录计入 omitted。
- 普通 run 没有仓库路径证据，结果明确 `repo_binding=unverified`。
- `process_liveness=unknown` 与 `coverage=not_monitored` 是单次读取的边界；持久终态不会因此消失。
- 数据库中的 accepted 消息可能仍在途，也可能结果不确定；不要换 ID 重发。
- 只显示 latest turn，不能据此断言没有历史未决事项。每集合最多100条，用 `--after-run`、`--after-session` 继续读取；后续调用是新的快照。
- 损坏决策、缺失绑定和截断均显式披露；不支持的 schema 失败退出，不降级为可写连接。

后续后台观察和回答能力按 Firstmate 能力借鉴设计的阶段门禁接入。本指南只列出实际已实现的入口。
