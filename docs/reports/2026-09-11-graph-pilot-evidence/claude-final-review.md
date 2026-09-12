未使用工具，仅依据贴出的三个文件复核；bin.ts 与 AGENTS.md 改动未提供，无法核实注册方式是否为 lazy import，但这不构成本次结论的阻塞。

## 剩余阻塞

无。未发现新的正确性或安全缺陷。一个验证缺口需要你确认：你只引用了"prior 849 passed"，新增的 WAL、symlink、嵌套 reserved 等用例本轮是否实际跑绿未说明。特别是 WAL 用例依赖 core `openDb` 使用 WAL journal 模式，否则 `hash(state.db-wal)` 会 ENOENT。请以本轮实际测试输出作为合并依据。

## 逐项状态

| # | 发现 | 状态 |
|---|---|---|
| 1 | guard home 推导不向上遍历 | 已解决。`guardDatabasePath` 对每个祖先检查默认 home 与 reserved 标记，并对叶目录再校验；symlink 与嵌套 backup 两条测试均断言拒绝且目录清单不变 |
| 2 | WAL 只读副作用未测 | 已解决（试点范围）。持有写连接、读到已提交 WAL 行、主文件与 -wal 哈希不变、user_version 不变。chmod 555 无 shm 场景未测，docs 第 5 条已如实声明 |
| 3 | 安装态无法分析离线副本 | 已解决。docs 增加运行环境矩阵，allowlist 保持严格属有意选择 |
| 4 | 校验顺序 | 已解决。`readState` 在 `new Database` 之前执行；损坏 DB + `{}` 状态用例证明抛 Loop 错误而不触库 |
| 5 | run_match 基于截断集且在事务外 | 未改，可接受。命名与 limitations 已诚实说明；Loop 现在先读，将来可在事务内精确查询 |
| 6 | 位置截断静默 | 已解决。`loop.locations` 按位置给出 total/returned/truncated，测试覆盖 in_progress 0/1 |
| 7 | 计数条件不对称 | 已解决。统一为 `addMatch`，100 条不截断、101 条截断均有测试 |
| 8 | 原始 SQLite 错误 | 部分解决。已包装为明确前缀，未读 user_version，对实验命令足够 |
| 9 | 关系查询全表扫描 | 已解决。改为 task_cards 双向 UNION，且基于完整范围而非截断投影 |
| 10 | checkoutRoot 依赖布局 | 未改，信息级。fail-closed，dist 端到端仍无单元测试 |
| 11 | 文本渲染 | 无需改动 |

## 补充确认

- `readState` 用 `O_NONBLOCK` 打开并 `fstat` 检查常规文件，FIFO 和指向目录的 symlink 会被拒绝且不阻塞；大小先查后读，超界双重检查正确。
- 租户 `IS @tenant` 在 NULL 与显式值两种情况均有测试，链接两端同时限定 board/tenant，fixture 中三种越界卡片均被排除。
- 参数化查询下 `t' OR 1=1 --` 只会得到"scope"错误。
- `--default-tenant` 与 `--tenant` 互斥、重复 flag、未知参数均返回 1；`explain --help --json` 现在按未知参数拒绝，行为已被 parseArgs 固定，可接受。
- docs 明确"独立 Loop 任务不自动登记，命令要求 DB 已登记任务"，与代码行为一致。

结论：在"实验性、只读、显式作用域"的定位下可以合并，前提是提交本轮新增用例的实际通过输出。
