总体判断：探针在其声明范围内（同步单写者文件门面、独立进程、模拟 JSON 边界）对“兄弟节点已完成写入跨进程保留、join 仅执行一次、interrupt/resume 跨进程”的证明是成立的：计数文件在磁盘、barrier 未提交时 `flaky` 会死锁触发超时而非假通过、absence 阶段提供了阴性对照。`memory-canary` 断言恒真，不增加证明力但也无害。以下为可行动的缺陷，按严重度排序。

1. **中 · 生产契约（G05）** `worker_action_response` 允许 `state:"failed"` 搭配 `ACTION_OUTCOME_UNKNOWN`/`CANCEL_UNCONFIRMED`（`nextAction:"reconcile"`）。“确定失败”状态与“结果未知”错误码矛盾，消费方按 state 重分配 attempt 会造成重复副作用。
   复现：`WorkerActionResponse.safeParse({ ...response, outcome: { state: "failed", error: unknownError } }).success === true`。
   修正：`superRefine` 中对 `outcome.state === "failed"` 追加 `expectedCodes` 反向检查，排除这两个 code。

2. **中 · 探针局限，兼 M1 设计提示（probe）** `list()` 是唯一未经 `identity()` 归一化的公开方法，原始 `config`/`options` 直接进 codec，而 codec 按设计拒绝显式 `undefined`。公开签名 `list(config | undefined, options)` 被破坏，`graph.getStateHistory`（`list` 的主要调用方）未被探针覆盖。
   复现：`saver.list(undefined)` 或 `saver.list(config('x'), { limit: undefined })` → `CHECKPOINT_CODEC_INVALID: unsupported value`。
   修正：`list` 内构造仅含已定义字段的 `{ configurable: { thread_id?, checkpoint_ns?, checkpoint_id? } }` 与去 `undefined` 的 options；探针增加 `getStateHistory` 断言。M1 适配器需同样在 encode 前归一化。

3. **中低 · 证据可信度（probe/G06）** 版本号在 `package.json`、`GRAPH_KERNEL`、探针 `result.versions` 三处硬编码，无一致性断言；探针报告写死 `1.4.15`，即使 pnpm 实际解析到其他版本，evidence 仍显示“已固定”。
   修正：探针读取 `requireGraph('@langchain/langgraph/package.json').version` 等实际版本写入报告，并 `assert.equal` 于 `GRAPH_KERNEL`。

4. **低 · 包隔离（G06/G07）** `checkpoint-codec` 不在 `exports` 中却随 `files:["dist"]` 发布，探针以相对 `dist` 路径绕过 exports 加载，即 codec 对包消费者不可达、对 tarball 却可见。`./worker` 入口未导出 `interrupt`/`Command`/`BaseCheckpointSaver`，探针证明的 interrupt/resume 流程无法经声明的 SDK 入口表达。
   修正：新增无 SDK 运行时依赖的 `./codec` 子路径（codec 仅 type-import langgraph-checkpoint，不会污染轻量入口），并补齐 `./worker` 导出。

5. **低 · 生产契约（G05）** `Id` 正则仅排除 `\u0000-\u001f`，放行 DEL（`\u007f`）与 C1 控制字符 `\u0080-\u009f`，与注释“拒绝 ASCII 控制字符”不符。不构成 scope 绕过（`canonical` 精确比较），但标识在日志/终端中可被伪装。
   复现：`tenantId: "a\u007fb"` 通过 `GraphScope.parse`。
   修正：字符类改为 `[^\s\u0000-\u001f\u007f-\u009f]`。

6. **低 · 编解码非规范输入（G07）** `decode` 字节路径 `TextDecoder` 默认剥离 BOM，`EF BB BF` 前缀 wire 被接受；字符串路径中 U+FEFF 则被 `JSON.parse` 拒绝。同一值存在两种被接受的字节表示，若 M1 对存储字节做完整性哈希会产生歧义。
   复现：`codec.decode(Buffer.concat([Buffer.from([0xef,0xbb,0xbf]), codec.encode(1)]))` 返回 `1`。
   修正：`new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })`。

未发现新的 G05 认证/scope/generation 绕过，也未在 codec 中发现已知 typed-array 自有 getter 之外的代码执行路径；`-0` 归一化、key 排序/去重、预解析深度与 token 上限、hex 分配前长度检查均与声明一致。
