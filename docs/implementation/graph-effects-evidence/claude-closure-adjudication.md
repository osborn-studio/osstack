# Claude Fable 5.1 最终复核处理

实际 CLI 模型为 `claude-fable-5-1`，非模拟人格。设计、实现、闭环三轮提示、原始 JSON、解析意见和实现快照均归档。模型结论不替代测试。

闭环复核确认三项实现意见已关闭、无阻断项，同意在结果持久化失败后保留不确定工作区的锁与实际容量。两项非阻断备注也在父级最终提交前处理：

1. 配额聚合改用 `octet_length(column)`，保持 UTF-8 字节计数，避免 `length(CAST(column AS BLOB))` 的载荷读取。精确运行环境为 better-sqlite3 12.10.0 / SQLite 3.53.1；本地查询 `octet_length('中文🙂')` 返回 10，新增多字节超额整笔回滚测试。SQLite [官方说明](https://www.sqlite.org/lang_corefunc.html#octet_length)确认表列字节长度可从元数据取得。仍需遍历有界行，未宣称消除所有事务延迟，G28 保持 pending。
2. `markRunning` 的同执行引用重放与不同执行引用冲突均不能被归为未调用安全失败：保留准入并标 unknown，等待可信对账。两个回归分别验证零次本调用 invoke、unknown、retry_safe=0 和仍占用 writer。首次针对不同引用的夹具捕获了冲突分支遗漏，修复后两路通过。

这两项最终增量由本地全库测试再次验收；不声称 Claude 读取了闭环快照之后的代码。类型声明的 Biome 修正只补显式 ReturnType，未改变运行行为。
