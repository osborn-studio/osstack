先说结论性的重新评估：我之前的"除 checkpoint_id 全量重放外没有公开路径"的说法是错的。Functional API 是文档化的公开路径。机制在已见源码里是清楚的：每个 task 调用经 `call()` 变成一个 PUSH 任务，返回值由单个 ChannelWrite 写入 RETURN 通道并作为 pending write 持久化；`invoke(null)` 时 entrypoint 整体重跑，但同 id 的任务直接拿缓存写入而不进入函数体。join 在 Functional 下只是 orchestration 里的一次 `await`，绕开了 StateGraph 那个 AND 边 barrier 与 versions_seen 的失败模式。parent 的 smoke 结果与这个机制一致。

下面是对当前快照的对抗性审查，共 6 条。标签含义：探针缺陷 = 现在的断言会给假阳性或不成立；C2 前必补 = 不补就不能做判定；M1 义务 = 探针不需要实现但结论必须写明。

## 发现

**1. 探针缺陷：`immediate` 窗口没有证明"缓存 RETURN 不重入"，且各窗口缺少正向的重入期望表。**
种子阶段 completed 是否真的执行并落盘 RETURN，没有任何断言。`partialSummary` 只识别 StateGraph 的 `results` 通道，对 Functional 的 `__return__` 写入永远输出 outputError=false、notificationMissing=false，所以 before.wire 在 Functional 行里是无效证据。父进程只检查恢复后 `completedWrapper === 1`，这无法区分"种子已缓存、恢复未重入"和"种子被同胞错误先中止、根本没跑、恢复跑了一次"。此外被排除的三个窗口没有断言 wrapper 应为 2，也就是"kill 在确认之后、RETURN 之前会合法重入函数体但只查账本"这条核心不变量根本没被断言。
复现：把 completed 改成 `async () => { await new Promise(r => setTimeout(r, 10)); ... }`，让 flaky 的 immediate 错误先中止 runner。种子里 completedWrapper 可能为 0 或被记成 AbortError，恢复后仍是 1，断言照样通过。
最小修复：
```js
// 父进程 check 内
const seed = entry.processes[0].report;
assert.equal(seed.counts.completedWrapper, 1);
const expect = { 'effect-confirmed-crash': 2, 'before-return-write-crash': 2, 'unknown-effect-crash': 2 };
assert.equal(recovered.counts.completedWrapper, expect[spec.window] ?? 1);
// partialSummary 增加 functional 分支：按 w[1] === '__return__' 分别记录
// completed/flaky/join 三个任务是否有 RETURN、是否有 __error__，
// 种子后断言 completed 有 RETURN、flaky 只有 __error__。
```

**2. C2 前必补：恢复过程自身的 kill 窗口缺失；`repair` 阶段是死代码且与 Functional API 不兼容。**
主循环只有 `run('seed')` 和 `run('recover')`，`repair-before`、`repair-after` 从不出现在 specs 里。而且 repair 里的 `updateState(config, {}, 'completed')` 对 entrypoint 图会失败：这个 Pregel 只有一个节点 `c2-static`，asNode 为任务名不是合法节点。真正缺的是第三代进程证据。最关键的未观察行为：flaky 首次失败后同一 taskId 下已有 ERROR 写入，恢复时成功的 RETURN 以同一 taskId 写入。MemorySaver 通过 WRITES_IDX_MAP 让二者共存，但恢复进程在写完 RETURN、还没写 join RETURN 时被杀，第三个进程是把 flaky 判为缓存还是再次重跑，本探针没有任何观察。
复现：种子用 `immediate`；恢复进程安装 afterWrites，在 `__return__` 值 results 为 `['recovered']` 落盘后 SIGKILL；再起 recover2。
最小修复：
```js
// spec 增加 killPhase: 'recover'，主循环
run('seed'); run('recover', 'SIGKILL'); run('recover2');
// recover2 断言 result full、recoveredBody===1、joinedBody===1，
// flakyAttempts 取观察值 2 或 3 写死并记录到 evidence。
// 删除 repair 分支，或限定 spec.api==='state'。
```

**3. 探针缺陷：`recovered` 效应的去重从未被断言，abort 后的迟到写入未被观察，且缺"abort 后 kill"变体。**
`timeout` 与 `cancel-uncooperative` 的种子在 invoke 已拒绝后还让 flaky 跑完 `ledger.execute('recovered')` 并确认。恢复时 flaky 没有缓存 RETURN，必然重入函数体，此时账本去重是唯一防线，但恢复阶段没有 `recoveredBody === 1`，也没有 `flakyAttempts === 2`。同时没有断言 abort 后 journal 中 flaky 任务只有 `__error__`：若引擎在 commit 之后又把迟到的 RETURN 持久化，恢复会静默复用一个已被取消任务的结果，探针照样全绿。现有的 cancel-uncooperative 让 body 完整跑到确认，是良性变体；真正对应 M1 的"拒绝后强杀"没有覆盖。
复现：在 cancel-uncooperative 的 recover 报告里查看 counts，会发现 recoveredBody 与 flakyAttempts 都没进入任何 assert。
最小修复：
```js
// recover 阶段所有非 unknown 窗口
assert.equal(counts.recoveredBody, 1);
if (['timeout', 'cancel', 'cancel-uncooperative'].includes(spec.window)) assert.equal(counts.flakyAttempts, 2);
// 种子结束后：断言 before.pendingWrites 中 flaky 的 taskId 没有 __return__。
// 新窗口 cancel-then-kill：flaky 收到 abort 后调用
//   ledger.execute('recovered', () => killAt(home, spec.window))
// recover 期望 rejects /reconcile/，recoveredBody===1，joinedBody===0。
```

**4. Functional 特有风险与时序证明缺口，同时是 M1 义务：任务身份不含参数、不含程序哈希。**
按 `_prepareSingleTask` 的 PUSH 分支，taskId 为 checkpoint.id、ns、step、任务名、PUSH、父路径、调用序号的 uuid5，参数不参与。缓存 RETURN 只按"名字加第几次调用"返回。探针恢复时用完全相同的程序，所以它无法揭示"程序、版本、输入绑定"不是引擎提供的。`functional-entry.test.ts` 里"Call order is part of the persisted program identity"是期望，不是引擎保证。推论一：任何 updateState 或对同 thread 再次 `invoke(input)` 都会产生新 checkpoint id，旧 pending writes 的 taskId 全部失配，所有任务重入，只剩账本兜底。推论二：fixture 的 run 键是 spec.name，同 thread 第二次 invoke(input) 会把新一轮的效应误判为已确认。
复现：join-return-crash 之后，恢复进程把 `j(results)` 改成 `j(['x'])`，仍返回缓存的 `{ results: ['joined'] }` 不重算；把 `bp` 提到 `ap` 之前，completed 的序号变为 1，缓存 miss 而重入，靠账本救回。
最小修复：把上述两个负控制作为独立实验记录进 evidence，作为 G08 与 G18 的正当性证据。M1 义务：resume 前由 OSStack 校验 program hash、version、input hash 与 thread 的绑定；Functional 路径禁止 updateState；run id 必须每次 invoke(input) 唯一，且 thread 不得跨 run 复用。

**5. 探针缺陷：序列化证据链未闭合，可能让引擎错误伪装成注入错误或丢失错误分类。**
JournalSaver 对 putWrites 参数做 CheckpointCodec 往返，但引擎传入的 ERROR 写入值是真实的 Error、AbortError 和 timeout 错误实例，journal 单测只用了 plain 的 `{name, message}` 对象。若 codec 拒绝 Error 实例，`append` 抛错，在 durability async 下 putWrites 的 rejection 会被延后到运行结束才浮现，kill 窗口时序失真；若 codec 把 Error 静默降为空对象，evidence 里 AbortError、timeout、reconcile 的分类就丢了，第 3 条需要的错误类型断言无从做起。`append` 失败时 records 是否保留、以及 supervisor 要求的 method 白名单与 args 形状校验，都还没做。
复现：在 journal 单测里写入 `new Error('x')`、`Object.assign(new Error('t'), { name: 'TimeoutError' })`，以及 `put` 的 versions 参数为 undefined，读回比对。
最小修复：
```js
// graph-c2-runtime.mjs append()
if (!['put', 'putWrites', 'deleteThread'].includes(method)) throw new Error('unsupported method');
let frozen;
try { frozen = codec.decode(codec.encode({ method, args })); }
catch (e) { persist(join(dirname(this.file), 'codec-failure.wire'), { method, error: String(e) }); throw e; }
// 单测补 Error 实例与 undefined 可选参数的 roundtrip 断言。
```

**6. 探针缺陷：durability 维度几乎不产生证据，且默认 evidence 路径硬编码本机临时目录。**
所有 kill 窗口都在 saver 钩子内触发，JournalSaver 又同步落盘，所以 async 行与 sync 行在探针内时序等价，唯一差异是 loop 是否 await，而 kill 已在 hook 内发生。矩阵没有覆盖"async 下 put 已调用但尚未 flush 时进程死亡"，也没有 exit 模式。如果 M1 打算用 async 或 exit，本轮 C2 结论不迁移。另外默认路径写死为 `/var/folders/97/.../osstack-graph-c2-ijsk2plt/evidence`，违反 AGENTS.md 不提交本机路径的要求。
最小修复：C2 判定显式固定 durability 为 sync，并从矩阵删掉 async 行，或增加一个真正的 async 差异窗口：JournalSaver 把 persist 推迟到 setImmediate，在 loop put 已返回但未落盘时 kill。默认路径改为：
```js
const evidence = resolve(process.env.GRAPH_C2_EVIDENCE ?? join(tmpdir(), 'osstack-graph-c2', 'evidence'));
```

## 决策建议

基于已见的 func/index.js、pregel/call.js 与 parent smoke，没有发现阻断"有界确定性静态 GraphSpec 编译为固定顺序 task 调用"通过 C2 的引擎缺陷。但当前快照即使全绿也不构成 C2 证据：第 1、3 条是假阳性，第 2、4 条的缺失会让 M1 设计建立在未验证假设上。建议顺序是先修 1、3、5、6，再补 2、4，用 sync 矩阵一次全绿后再做 C2 判定。这不涉及生产就绪，M1 仍需 worker 强杀与确认退出、fencing、broker 拒绝新动作、attempt 计数的账本身份，以及 reconcile 之后的再恢复路径。
