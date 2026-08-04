# Technical decision delta

- Probe session: probe_9bce3f19-3a7b-4a46-b745-0b6a1e9d2a62
- Revision: 12

## Which data model choices would be costly to reverse after implementation begins?

采用以下不可轻易反转的数据模型约束：

1. append-only 事件记录是审计事实来源；readiness、指标与其他派生视图必须从事件确定性重建，禁止手改 SQLite、ledger 或派生视图。
2. SQLite 是活动会话权威；`ledger.json` 是可移植机器交付权威，`ledger.md` 是由摘要绑定的人类审阅面，`render-manifest.json` 绑定全部输出。
3. session ID、单调 revision 与 idempotency key 不可重写；已有会话的每次写入都必须使用 `if_revision` 条件更新，并保持事件、快照和投影在同一事务中。
4. SQLite migration 只增不删；破坏 portable schema 的变更必须发布新 schema，并保留 v1 reader 至少一个 minor release。
5. 仓库工件是某个不可变 exported revision 的快照；继续访谈后必须由 CLI 重新 render，不能从手改 Markdown 反向恢复状态。

Destination: docs/2026-07-17-probe-four-quadrant-elicitation-design.md (applied)
