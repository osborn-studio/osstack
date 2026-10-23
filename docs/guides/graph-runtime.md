# OSStack executable Graph

OSStack 在现有 agent、Loop 和权限之上执行固定 `code-delivery-v1` 图。`graph explain` 仍是只读关系诊断；`graph run` 才会提交执行任务。结果只发布候选 artifact，不自动合并、推送或部署。

流程：独立 writer clone → 实现 → 确认停止 → 冻结不可变 candidate → 分别准备 review/test clone → 并行评审和验收 → 按同一个 candidate 汇合。业务缺陷进入受预算限制的修复 epoch；格式错误、授权失效、未知副作用不会伪装成业务失败后无限重试。

每个节点的输入输出受 v1 schema 约束；持久 action ledger 负责副作用去重，Functional + sync checkpoint 负责调度恢复。缓存 RETURN 与已确认的副作用不同：函数可能重入查询账本，但不重发已确认动作，也不承诺外部世界物理恰好一次。

## 支持范围

- Node 包/工作区安装，Graph 最低 Node 20.6.0；构建工具 pnpm 11 需要较新的 Node（CI 使用 22.23.1）。SQLite 必须匹配运行 Node 的 ABI。
- Bun 单文件保留已有命令，但明确拒绝 Graph 执行；可继续 `graph explain` 和离线 `graph validate`。
- 有限 bounded messages writer/reviewer 支持 Anthropic 与 DeepSeek。当前 writer 每次替换一个已登记 UTF-8 文件，最大 4 KiB；不运行模型生成的 shell。其他 adapter 必须实现可靠 `confirmStopped`，否则执行前拒绝。
- SHA-1、完整历史、无 submodule/sparse omission 的仓库；候选原始内容和 bundle 各最多 256 MiB。Git 对象批量读写保留原始二进制、符号链接和执行位，不运行 checkout filters/hooks。
- owner-only 本地注册和 socket；没有新增公网 API。未知结果隔离保留，不能凭 PID 消失、TTL 或模型声称“完成”释放写锁。

## 使用

首次运行请先阅读[完整上手与参数手册](graph-quickstart.md)，包括可复制的隔离练习、host 配置、预算和状态处理。


先按[操作手册](../runbooks/graph-runtime.md)配置独立 `OSSTACK_HOME` 和 owner-only `graph-host.json`。没有注册就不能运行。`admissionEnabled:false` 只关闭新准入；已有任务的查询、取消和对账保留。

```sh
node packages/cli/dist/bin.js graph validate --spec /absolute/spec.json --json
node packages/cli/dist/bin.js graph run --request /absolute/start.json --json
node packages/cli/dist/bin.js graph status --run RUN_ID --scope /absolute/scope.json --json
node packages/cli/dist/bin.js graph result --run RUN_ID --scope /absolute/scope.json --json
node packages/cli/dist/bin.js graph cancel --request /absolute/cancel.json --json
node packages/cli/dist/bin.js graph reconcile --request /absolute/cancel.json --json
```

所有命令继承显式隔离 `OSSTACK_HOME`。退出码 0 只表示请求已确认，需检查业务状态；2 是 `delivery_unknown`，重试同一请求及 idempotencyKey；不能换 key 猜测重发。遇到 revision conflict 先刷新 status。`ready` 绑定精确 candidate、评审、测试和 join receipt。

完整验收结果见[收口报告](../reports/graph-upgrade-completion.md)。
