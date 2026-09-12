我没有使用工具，以下结论仅基于你贴出的四个文件；bin.ts 未提供，无法核实。

## 总体判断

只读打开、显式租户 `IS` 匹配、链接两端同时限定 board/tenant、101 条截断哨兵、Loop 文件有界读取，这些核心边界是正确的，测试覆盖了主要泄漏路径。真正的风险集中在 guard 接入方式和 WAL 场景未验证，不在数据查询逻辑。

## 发现

**1. 中（若 DB 不在 home 根目录则为高）：guard 的 home 推导与真实布局耦合，且无测试。** 引入的问题。

```ts
assertDbAccessAllowed({ checkoutRoot: dirname(fileURLToPath(import.meta.url)), osstackHome: dirname(dbPath) });
```

guard 只在 `home` 恰好等于默认 home 或恰好含 `control-plane-reserved.json` 时拒绝，不向上遍历祖先目录（这是既有 guard 的设计限制）。试点把 `dirname(dbPath)` 当作 home，如果 core 的 state.db 实际位于 home 的子目录，两个检查都不会触发。请核实 core 默认 DB 路径。缓解因素：`readonly: true` 使迁移不可能，实际损害是违反 AGENTS.md 规则并可能在源目录产生 WAL/SHM 文件，不是损坏。七组测试没有任何一条断言 guard 拒绝。

**2. 中：只读 WAL 打开的副作用与竞争未测试。** 引入的问题，设计文档只部分承认。SQLite 3.22 起，只读连接在 `-wal`/`-shm` 不存在且目录可写时会创建它们；目录不可写且 shm 不存在时打开失败。fixture 执行了 `wal_checkpoint(TRUNCATE)` 并关闭，所以"DB 不变"只验证了主文件、无 WAL、无并发写者的最简单情况。生产中对活跃 daemon 的 DB 读取才是真实场景，完全没有覆盖。

**3. 中：安装态 shim 无法分析离线副本。** 设计张力，不是 bug。已声明角色的 checkout 走 `allowed.includes(home)`，`/tmp/copy` 不在 allowlist 会被拒绝。设计文档推荐的"离线副本"流程只能从未声明的 dev checkout 执行，而 dev checkout 又被禁止读活库。可接受，但应在设计文档写明使用矩阵。

**4. 低：校验顺序与验收案例 5 不符。** 引入的问题。DB 先打开并读完，之后才 `realpathSync(statePath)` 和读取 Loop 文件。无效/超大 Loop 文件仍然会触发一次只读 DB 打开（含第 2 条的 shm 副作用）。建议先读并校验 Loop 文件，再开库。

**5. 低：`run_match` 基于截断后的返回集，且在事务外计算。** 命名 `not_in_returned_runs` 和 limitations 已诚实说明，逻辑一致。但如果先读 Loop 文件（见第 4 条），可在同一事务内对每个 completed 记录的 run_id 做一次 scoped 精确查询，去掉这个含糊。

**6. 低：Loop 匹配截断按位置顺序静默丢弃。** completed_tasks 达到 101 条后，in_progress/pending/deferred 一条也不进入 matches，输出只有全局 `results_truncated`，无法看出哪个位置被丢。建议按位置分别报告。

**7. 低：Loop 匹配计数条件不对称。** 第一个循环用 `matches.length > LIMIT` 跳过，后两个用 `<= LIMIT` 允许，结果都停在 101，行为正确但可读性差，容易在后续改动中出错。统一为一个 helper。

**8. 低：schema 不匹配时抛原始 SQLite 错误。** 缺列时用户看到 `no such column`，退出 1，安全但不友好。如果 core 用 `user_version` 记录迁移版本，开库后先读它并给出明确错误。

**9. 低：关系查询无法用索引。** `p.task_id=@task OR c.task_id=@task` 导致全表扫描 links，期间持有读快照，会阻止 WAL checkpoint 完成。试点规模可接受，扩展前需拆成两个 UNION 查询。

**10. 信息：guard checkoutRoot 依赖打包布局。** 若 tsup 把 graph-command 输出到与 bin.js 不同的目录，安装态 shim 找不到 control-plane.json，退化为 undeclared 从而拒绝稳定 home。这是 fail-closed，安全，但验收案例 8 的 dist 端到端没有在单元测试中体现。

**11. 信息：文本渲染安全。** `JSON.stringify` 转义了 0x1B 和所有 < 0x20 控制符，终端注入无风险。U+202E 等双向覆盖字符不转义，只是显示欺骗，可忽略。

## 既有 guard 问题（非本次引入）

- home 粒度、不向上查找 reserved 标记，子目录内的 DB 逃逸检查。
- 纯路径模型，硬链接和副本天然在模型之外，这是设计取舍。
- 角色文件只在模块自身目录查找，依赖构建产物布局。

## 建议补充测试

1. 在 fixture 目录写入 `control-plane-reserved.json`，断言抛出 `refusing to open`，且不产生任何新文件。
2. 保留未 checkpoint 的 WAL 并持有一个写连接，运行 explain，断言能读到 WAL 中的行，主文件字节不变，事后列出目录文件清单对比。
3. 目录 chmod 555 且无 `-shm` 的 WAL DB，记录期望行为（失败或成功），把结论写进设计文档。
4. Loop 文件无效时断言 DB 目录未新增 `-shm`/`-wal`。
5. `run_match` 为 `not_in_returned_runs` 的用例：插入 101 个 run，Loop 记录引用最旧的那个。
6. pending 与 deferred_tasks 匹配用例，断言 `authorization`/`reason` 出现、prompt 不出现。
7. 相对路径、指向目录的 symlink、FIFO 作为 `--state`，断言拒绝且不阻塞。
8. blocked_reason 含 `\n` 和 ESC，断言文本输出行数固定且不含原始 0x1B。
9. 同一输入连跑两次，去掉 `observed_at` 后深度相等。
10. `explain --help --json` 当前返回 1，决定是否接受并固定。
11. 构建后对 dist 运行一次真实 CLI，同时验证角色文件查找目录与 bin.js 一致。
