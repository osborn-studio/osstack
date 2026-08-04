---
probe_session_id: probe_9bce3f19-3a7b-4a46-b745-0b6a1e9d2a62
probe_schema_version: 1
probe_revision: 12
source_sha256: 8eec7615133e3aa81b9cdd5e85c8c266f14b17bb44e494e97c5541dbb877b084
---

# Probe ledger: probe_9bce3f19-3a7b-4a46-b745-0b6a1e9d2a62

- State: active
- Required disposed: 4/19
- Completion: 21.05%

| Item | Quadrant | State | Category | Disposition |
|---|---|---|---|---|
| pi_a927f10e-c1ce-4403-9b59-f6aee4a3cd09 | KU | open | interface | — |
| pi_c9a182f2-219f-45e5-957d-e966c162befa | KU | open | security | — |
| pi_e1a3e352-a443-453c-95dc-3160a4df1323 | KU | open | rollback | — |
| pi_fc3f64f6-24c3-4571-b80c-9ddb6b28d328 | KU | open | migration | — |
| pi_2f6f5426-ea23-4a2c-8c7e-ae7e22606829 | KK | resolved | acceptance | 全新安装以安装记录和 CLI/daemon 版本一致性为证；doctor 以无阻塞项的 JSON 结果为证；Neat 以修复前后快照、ReportV2、事务回执和复扫结果为证；Probe 以 ledger、render manifest 及 live/fresh-home gate 一致性为证；安全边界以文件哈希、写入白名单、凭证哨兵和日志扫描结果为证。 |
| pi_80e6f846-af58-4f49-a9c2-da98b0605ba6 | KK | resolved | test_data | Use synthetic fixtures and redacted structural samples by default. Never copy real records; retain only schema, hashes, and aggregate scale or distribution metadata. Credential fixtures must use obviously fake sentinel values. Reject any fixture containing secrets or personal identifiers before persistence, logs, reports, or rendered artifacts. |
| pi_8fd996c0-71cb-453e-b790-d7eab9c18e7f | KK | resolved | data_model | 采用以下不可轻易反转的数据模型约束：<br><br>1. append-only 事件记录是审计事实来源；readiness、指标与其他派生视图必须从事件确定性重建，禁止手改 SQLite、ledger 或派生视图。<br>2. SQLite 是活动会话权威；`ledger.json` 是可移植机器交付权威，`ledger.md` 是由摘要绑定的人类审阅面，`render-manifest.json` 绑定全部输出。<br>3. session ID、单调 revision 与 idempotency key 不可重写；已有会话的每次写入都必须使用 `if_revision` 条件更新，并保持事件、快照和投影在同一事务中。<br>4. SQLite migration 只增不删；破坏 portable schema 的变更必须发布新 schema，并保留 v1 reader 至少一个 minor release。<br>5. 仓库工件是某个不可变 exported revision 的快照；继续访谈后必须由 CLI 重新 render，不能从手改 Markdown 反向恢复状态。 |
| pi_d6d1260a-89da-46e2-9e49-771bcc554219 | KK | resolved | acceptance | 全新安装后，CLI 与 daemon 版本一致，doctor 全部通过；Neat 能发现并安全修复知识卫生问题；Probe 能生成可审计产物；全过程不得发生未授权写入或泄露凭证。 |
| pi_69331705-7cfa-461d-ace5-0bde7d022320 | KU | open | security | — |
| pi_26850ba8-a334-4fb2-aa66-614750e2e3a5 | KU | open | acceptance | — |
| pi_4fc9a85a-fd43-47ef-afd0-789692d8f6dd | KU | open | acceptance | — |
| pi_04ac9b46-7149-47b8-9bb0-d2463da6da62 | KU | open | failure_mode | — |
| pi_2c273b8b-1c67-4abb-af2c-404f36d7fc81 | KU | open | user | — |
| pi_429e73cb-011a-4668-b1aa-84beac1b27f6 | KU | open | dependency | — |
| pi_a158ed39-52be-439c-9836-2483b2c5f4a6 | KU | open | outcome | — |
| pi_d59be9ff-36f0-48fe-a266-ca761e63e3c0 | KU | open | user_flow | — |
| pi_2307f4b2-071a-4eda-b6a0-241a794dc158 | KU | open | scope | — |
| pi_43aedae3-4262-4054-bed7-cf85b30094d7 | KU | open | acceptance | — |
| pi_692bb7be-d35c-4228-b014-01d877415fac | KU | open | performance | — |
| pi_f705a3f7-1bf5-4b75-a30f-e97c424bf621 | KU | open | environment | — |
| pi_b75a2846-6492-44e1-aa77-621259615a2e | UK | open | tacit_convention | — |
| pi_01b5b6d1-4838-44f9-ba13-38c668a0dcf2 | KU | open | observability | — |
| pi_078df6bf-3a6a-408c-989a-d212f008160c | KU | open | performance | — |
| pi_1a91de90-5edb-41c9-92e9-ba56d1c3d723 | KU | open | failure_mode | — |
