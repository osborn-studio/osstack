我将不使用任何工具，直接基于给出的三份源码做对抗式审查。以下按 P1/P2 给出具体位置、复现与最小修复；G03/G04 未实现的部分不计为 G01/G02 缺陷。

先说结论：生命周期清理（timeout/graceTimer/外部 listener）、late result 快照、微任务饥饿下的 `Date.now()` 兜底、`wait()` 的 waiter 自删这几条我逐路径推演后没有发现问题。真正的缺陷集中在三处：宽限期双时钟不一致导致的无界等待、invoke 前取消被错误归为 unconfirmed、协议中止不触发子 signal。

## P1

**P1-1 宽限期用了两个时钟，graceTimer 触发后仍可能产生无界 `wait()`**

- 位置：`packages/loop/src/executor.ts`，`AdapterCancellation.request()` 与 `wait()`。
- 问题：`deadline` 取自 `Date.now()`（墙钟，ms 截断），`graceTimer` 走 libuv 单调钟（ms 截断）。定时器可以在墙钟 `Date.now() >= deadline` 成立之前最多约 1ms 触发。触发时它把当前 waiters 全部 expire，但**之后注册的 wait 只剩 `Date.now() >= deadline` 这一道守卫**。流被 expire 后，同一轮微任务内 catch 到 finally 到 `finish()` 到 `wait(this.confirmation)`，此时墙钟检查可能仍为 false，而 graceTimer 已经用完。若 `confirmStopped` 悬挂，`finish()` 永远不返回，`active` 不置 false，timeout 定时器和外部 listener 也不清理。
- 复现：真实定时器（不要 `vi.useFakeTimers`，假定时器把 `Date.now` 和 `setTimeout` 绑到同一时钟，因此现有 67 个用例看不到）。adapter 的 `next()` 返回永不 settle 的 promise，`confirmStopped` 返回 `new Promise(() => {})`，`cancellationGraceMs: 20`，invoke 开始后外部 abort。循环跑 50 次，会有相当比例挂到 vitest 超时。
- 最小修复：定时器触发即视为过期，不再依赖墙钟比较。

```ts
private expired = false;
// request():
this.graceTimer = setTimeout(() => {
  this.expired = true;
  for (const expire of this.waiters) expire();
}, boundedGrace);
// wait():
if (this.expired || Date.now() >= this.deadline) expire();
// confirmation .then():
if (this.active && !this.expired && proof?.stopped === true && ...)
```

**P1-2 invoke 前的取消被映射为 `cancellation_unconfirmed`，与 preabort 路径矛盾**

- 位置：`executePlan` 顶部 preabort 分支返回 `stop_confirmed: true, evidence: "not_started"`；但 `AdapterCancellation.request()` 在 `invocationStarted === false` 时不做任何确认，`isAvailable()` 或 `import()` 期间的 timeout/外部 abort 最终落为 `failed + cancellation_unconfirmed`。测试 `bounds a hanging availability probe` 正好把这个行为固定了下来。
- 问题：`checkBeforeInvoke()` 在每个 await 之后都会执行，一旦 abort，`invoke()` 在这条路径上**不可能**被调用。executor 对“没有任何外部工作”这一事实是确定的，却输出“需要对账、不可安全重试”。按你给的 G04 规则，一个探针慢了 120s 的任务会被永久判定为不可重试，实际上它一次都没跑过。
- 前提假设：`isAvailable()` 按 base.ts 契约是无副作用探针，`import()` 亦然。
- 最小修复：在 `finish()` 的 try 之前补一段，把未 invoke 的取消记为已确认，outcome 自然变为 `cancelled`。

```ts
if (this.record !== undefined && !this.invocationStarted && !this.record.stop_confirmed) {
  this.record = { ...this.record, stop_confirmed: true,
    confirmed_at: new Date().toISOString(), evidence: "not_invoked" };
}
```

需同步改两处断言：`bounds a hanging availability probe` 改为期望 `outcome: "cancelled"`、`evidence: "not_invoked"`；`does not invoke when availability aborts just before returning` 现有断言可保持。

**P1-3 协议中止不触发子 signal，adapter 的工作可能继续运行**

- 位置：`executeAdapterPlan` 的 catch/finally。`AdapterProtocolError`（`invalid_done_payload`、`duplicate_done`、`conflicting_terminal`、`event_after_terminal`）以及 `next.value` 畸形导致的 TypeError，都是在迭代器仍存活时抛出的。finally 只 fire-and-forget 调用 `return()`，`controller.abort` 从未执行，adapter 拿到的 signal 保持 `aborted === false`。
- 问题：base.ts 把 AbortSignal 定义为唯一契约性的停止通道，`return()` 不在契约内。对以 signal 为准清理子进程的 adapter，executor 已返回终态 `failed`，但工作还在跑。这些 failure_code 看起来是可重试的分类，重试会产生并发的重复执行。这与 G03/G04 无关，是 G02“中止即停止请求”的缺口。
- 复现：async generator 先 `yield done(completed)`，再 `yield progress`，然后在 signal 上挂 abort 监听并 `await` 一个 10s 的定时器模拟工作。executor 立即返回 `event_after_terminal`，监听器永不触发，10s 工作照常完成。
- 最小修复：新增一个不写 evidence 的 `abandon()`，在 finally 里先 abort 再 `return()`，保证 adapter 的 finally 块看到已中止的 signal。`source` 联合类型和 `record` 均不改动。

```ts
abandon(reason: unknown): void {
  if (!this.signal.aborted) this.controller.abort(reason);
}
// finally:
if (iterator !== undefined && !streamClosed) {
  cancellation.abandon(caught ?? new Error("executor abandoned stream"));
  const unfinished = iterator;
  void Promise.resolve().then(() => unfinished.return?.()).catch(() => undefined);
}
```

`caught` 为 catch 块保存下来的错误。是否在此路径上也调用 `confirmStopped` 并等待宽限，留给后续决定，这里不扩大。

## P2

**P2-1 取消请求之前已收到的 `done` 被覆盖为 unconfirmed**

- 位置：`executeAdapterPlan` 末尾 “Cancellation wins over every late status” 的覆盖逻辑。
- 问题：adapter 已 `yield done(completed)`，只是关闭迭代器的最后一次 `next()` 慢或悬挂。timeout 到来后，outcome 变成 `failed + cancellation_unconfirmed`，`result_summary` 也被丢弃。这个 done 发生在请求之前，不是 late status，而是确定的终态结果。
- 复现：generator `yield done(completed, "result")` 后 `await new Promise(() => {})`；`timeoutMs: 50, cancellationGraceMs: 20`。
- 最小修复：executor 接受 done 时置 `cancellation.terminalReached = true`；`request()` 记录 `requestedAfterTerminal = this.terminalReached`。覆盖块加条件 `if (evidence !== undefined && !cancellation.requestedAfterTerminal)`，否则保留 payload 的 outcome/summary，仍附带 `cancellation` 供审计。G04 只看 `failure_code === "cancellation_unconfirmed"`，不受影响。

**P2-2 `timeoutMs` 非有限或超过 2^31-1 时被 Node 压成 1ms**

- 位置：`AdapterCancellation` 构造函数的 `setTimeout`。宽限做了 `Number.isFinite` 校验，timeout 没有。
- 复现：`timeoutMs: Infinity` 配合一个 5ms 完成的 adapter，结果为 `source: "timeout"` 且进程打出 TimeoutOverflowWarning。
- 最小修复：

```ts
const raw = options.timeoutMs ?? 120_000;
const timeoutMs = Number.isFinite(raw) ? Math.min(Math.max(1, raw), 2_147_483_647) : 120_000;
```

`runShellCommand` 有同样问题，属 G03 改动面，这里只记录。

**P2-3 畸形事件对象与 executor 内部异常落为无 failure_code 的 failed**

- 位置：循环内 `event.type` 访问、`errorPayload(event.payload).message`。`next.value` 为 null 或 payload 缺失时抛 TypeError，summary 是 “Cannot read properties of null”，没有稳定分类，与 adapter 主动 throw 无法区分。
- 最小修复：进入循环先做形状校验并抛 `AdapterProtocolError("invalid_event", ...)`。这需要给 `failure_code` 联合加一个成员，属小改动；若不想改类型，至少在 summary 前加固定前缀 `executor:` 便于 G04 区分。

## 测试缺口与说明

- 现有取消用例全部在假定时器下运行，P1-1 只在真实定时器下可见。建议加一个真实定时器用例：`next()` 悬挂加 `confirmStopped` 悬挂，断言在 `cancellationGraceMs` 内返回且 `vi.getTimerCount()` 为 0。
- 缺少“协议错误后子 signal 已中止”的断言（P1-3）。
- 缺少“done 在取消前到达则保留结果”的用例（P2-1）。
- 缺少 `timeoutMs: Infinity` 用例（P2-2）。

明确不计入本轮缺陷：本地命令路径在运行中忽略外部 signal（G03 范围）；async generator 在 `next()` 悬挂时 `return()` 会被排队、finally 块不执行，这是语言语义而非 executor 问题；`done` 后的 usage 事件放行属既定设计。