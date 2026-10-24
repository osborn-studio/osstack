# Firstmate 借鉴第一批审计

基于静态阅读。你提供的验证输出只覆盖 4 个文件：`daemon-lock-ownership`、`daemon-drain-recovery`、`daemon-loop-recovery-preservation`、`daemon-loop`。`attention-read-model.test.ts`、protocol 测试和 typecheck 没有在输出里出现，所以 attention 部分没有通过证据。

**结论：未发现 P0。有 3 个 P1，建议修完再整合。**

## P1（整合前必须处理）

### P1-1　startDaemon 失败清理不是异常安全的，且清理范围未证实
- **文件**：`daemon.ts` startDaemon 的 `catch`
- **触发（可证实）**：`collaborator?.stop()`、某个 daily session 的 `done`（`allSettled` 除外）或 `db.close()` 抛错。
- **后果**：
  - `releaseLock()` 和 `shutdownOtel()` 被跳过，原始错误被清理错误掩盖。
  - 同进程的 `held` 集合和内核锁一直保留。
  - 之后同进程重试（测试、嵌入、supervisor）只会得到 `DaemonAlreadyRunningError(自己的 pid)`。
- **触发（需确认）**：catch 里只处理了 collaborator、daily session 和主 db。从 diff 看不到下面这些，如果它们在失败点之前已创建，就是泄漏：
  - `server` 声明在 try 内，catch 访问不到。如果 `listen` 回调里有 `reject` 路径，失败后 socket 仍在监听，而锁已释放。第二个 daemon 可以启动，旧实例继续用已关闭的 db 响应。
  - `readConcurrency` 对应的只读连接池。
  - 健康检查和时钟跳变探测的定时器（输出里有 "clock jump" 日志），它们会在 `db.close()` 之后继续使用关闭的连接。
  - `createDaemonContext` 内部在 `failedContext = ctx` 之前失败时的半初始化资源。
- **建议**：
  - 让 `releaseLock` 在 `finally` 里按层执行，先 `try { 清理 } finally { try { await shutdownOtel() } finally { releaseLock() } }`。
  - 复用正常 `close()` 的同一条关闭路径，不要再维护一份子集。
  - 把 `server` 提升到 try 外，失败时关闭并 unlink socket。
- **测试**：
  - 让 `stop()` 抛错，断言 `acquireDaemonLock` 随后仍可成功。
  - 占用 socket 路径制造 `listen` 失败，断言锁可重取，且 `process._getActiveHandles()` 没有残留。
  - 加一个在 `ctx` 创建之后、`listen` 之前注入失败的用例。

### P1-2　attention 分页游标契约有歧义
- **文件**：`attention-read-model.ts` 的 `readAttentionStatus` 和 `next_after`
- **触发**：runs 与 sessions 各用一个独立游标，`null` 同时表示“已耗尽”和“从头开始”。
  - 例如 sessions 还有下一页、runs 已耗尽，`next_after = {run:null, session:X}`。按字面使用这个游标时，runs 会从第一页重新返回。
  - 反过来，sessions 会重复返回。
  - CLI 还拒绝空值，所以无法表达“runs 已读完”。
- **后果**：字面消费者拿到重复数据。这个契约在 `schema_version:1` 里，S1 接入后再改代价很高。
- **建议**：
  - 用一个绑定 scope 的不透明复合游标，包含 `{scope_id, run_done, run_after, session_done, session_after}`。
  - 或者分别提供 `run_exhausted` 和 `session_exhausted`。
  - 游标应校验长度，并校验是否属于当前 scope。
- **测试**：
  - 分别构造 runs 105 / sessions 3 和 runs 3 / sessions 105，逐页跟随 `next_after`，断言无重复、无遗漏。
  - 补上 sessions 超过 100 条的用例，现有测试只覆盖 runs。

### P1-3　`owner:"system"` 是无证据的断言
- **文件**：`readStoredWait`
- **触发**：存在 `active` grant 且游标匹配，就返回 `owner:"system"`。
- **后果**：
  - 持久事实证明不了“系统会处理”，因为 `coverage` 是 `not_monitored`，live 进程是 unknown。
  - 过期但未被 `beginCheck` 或 `recover` 扫描到的 active grant 同样返回 `system`。
  - 这会压低人工关注，而 `awaiting_decision` 的 human 归属被 grant 分支覆盖了。
- **建议**：
  - `grant_coverage_unknown` 的 owner 应为 `unknown`。
  - 解析 `body_json` 的 `expires_at` 和预算，输出 `grant_expired_unswept` 之类的 reason，owner 为 human。
  - 解析失败时输出 `grant_unreadable`。
- **测试**：构造“过期 active grant + 匹配游标”，断言 owner 不是 `system`。

## P2（建议本批修，不阻断）

1. **一行坏数据让整个状态入口失败**（`attention-read-model.ts` 的 `AttentionStatus.parse`）
   - 触发：任一行的 `state` 超过 80 字符、`session_id` 超过 512、`version` ≤ 0、`phase/outcome` 超长或 `updated_at` 非有限值，抛出原始 `ZodError`。
   - 后果：整个任务不可读，且错误没有归入 `unsupported_source`。
   - 建议：逐行校验。坏行计入 `omitted_corrupt`，并加 `corrupt_row:<id>` 到 limitations。
   - 测试：插入超长 `state` 或 `version=0`，断言其余行仍可读。

2. **`SQLITE_BUSY` 被报成 `unsupported_source`，扩展错误码也没处理**（同文件的 catch，以及 `daemon-lock.ts` 的 `["SQLITE_BUSY","SQLITE_LOCKED"]`）
   - 触发：rollback 日志模式下 daemon 迁移或写入占用 EXCLUSIVE，读侧超时 1s。
   - 建议：
     - 单独返回可重试的 `source_busy`。
     - 用 `startsWith("SQLITE_BUSY")` 匹配扩展码。
     - `new Database` 的构造异常也要纳入同一分类，目前它在 try 之外。

3. **“只读、不写”的测试证明不了不写**
   - 触发：只哈希主库文件。WAL 模式下主库本来就不变，而只读连接可能创建 `-shm`。
   - 建议：对整个目录做 before/after 快照（文件名、大小、mtime），并分别覆盖 WAL 和 DELETE 两种库。

4. **`scope_id` 不含 `repo_path`**（`attentionHash([dbPath, taskId, null])`）
   - 后果：同一 task、不同 repo 得到相同 `scope_id`，但会话集不同。游标也没有绑定 scope。
   - 建议：纳入 repo 的 realpath。

5. **未知状态默认当作“已解决”**（`readStoredWait`）
   - 触发：`session_messages.state` 不在 `accepted/failed` 内，或 `agent_sessions.state` 出现未知值，就落到 `none`。
   - 建议：已知已解决状态用白名单，其余一律 `unknown_state` 并标为不确定。
   - 另外，同时存在 `failed` 和 `accepted` 时只报最早的一条，应报计数或优先 `accepted`。

6. **`checkoutRoot` 的语义存疑**（`guardAttentionDatabase`）
   - `dirname(realpath(import.meta.url))` 得到的是 `src` 或 `dist` 目录，不是仓库根或安装根。
   - 如果 `assertDbAccessAllowed` 按“DB 不得位于 checkout 内”判断，仓库根下其他位置的库不会被拦。我没有看到该函数，请确认。

7. **锁文件的符号链接检查有缺口**（`acquireDaemonLock`）
   - 触发：`existsSync(path)` 会跟随链接，悬空 symlink 返回 false，检查被跳过，SQLite 随后会通过链接创建文件。`pidFile` 用 `writeFileSync` 同样会跟随 symlink，没有 lstat 检查。
   - 前提：攻击者需要对状态目录有写权限，所以只是 P2。
   - 建议：
     - 改为 `try { lstatSync } catch(ENOENT)`，并检查 `nlink===1`。
     - pid 文件用 `openSync(O_NOFOLLOW|O_CREAT, 0o600)` 写入。
   - 测试：悬空 symlink 和 pid 文件 symlink 两个用例。

8. **锁文件被删除后可双 daemon**
   - 触发：持锁期间有人 `rm` 掉 `.lock.db`（报错文案虽已警告），新进程会在新 inode 上取到锁。
   - 建议：取锁后记录 `{dev,ino}`，并在 daemon 现有的健康检查周期里复查，不一致就进入 drain。
   - 此外，`journal_mode=DELETE` 的返回值没有校验，应确认等于 `delete`。

9. **release 在异常下会残留 `held`**
   - `db.close()` 抛错会跳过 `held.delete(path)`。应把 `held.delete` 放进 `finally`。

10. **文件系统白名单失败时信息不足**
    - 抛出的 `daemon_lock_unsupported_filesystem` 不含 fs type。
    - 你的开发路径在 `/Volumes/...`，外接盘如果是 exFAT 或 NFS 会 fail closed，而且用户无从诊断。
    - 建议在报错里带上 type 的十六进制值和路径。

11. **恢复相关的毒丸**（`session-continuations.ts` 的 `recover`）
    - 触发：`listActive` → `requireGrant` → `ContinuationGrantBody.parse`，任一损坏或 schema 漂移的 grant 会抛错。
    - 后果：`recover()` 整体失败，daemon 无法启动，只能手工改库。
    - 建议：逐 grant `try/catch`，对解析失败的行用原生 SQL 标记 `blocked/corrupt_grant`，不要让整个恢复失败。
    - 测试：写入一条非法 `body_json` 后启动 daemon，断言可以启动，且该 grant 为 blocked。

12. **loop 中删除孤儿清理后的资源增长**
    - `loop-engine.ts` 把 before_cycle 和 after_cycle 的清理都删了。
    - 如果单 task 的 `cleanupWorktree` 在非重启场景下失败，长期运行的 loop 会持续累积 worktree 和分支，且没有回收路径。
    - 这符合“不能证明所有权就不删”的设计，但至少应记录到 `decisions` 和事件里，并有数量上限告警。
    - “如何显式恢复”属于后续批次，不算本批 bug。

## 建议（非 bug）

- `restoreDailySessions` 里的 `if (session.status === "running") session.done = runDailySession(...)` 已是死代码，应删除，或加注释说明。同样，startDaemon 失败清理里对 daily `done` 的等待现在也不会触发。
- `loop-engine.ts` 删除了清理后，`loopWorktreeBranchPrefix` 的 import 如果不再使用，开启 `noUnusedLocals` 会在 tsc 失败，vitest 不会发现。请跑 typecheck。
- 恢复路径测试只覆盖 loop 的 `running` / `stopping`。缺少以下用例：
  - daily session 的恢复。
  - 连续两次重启的幂等性，已经带 `recovery_required` 的 stopped 会话重启后保持不变。
  - 已有 `stopReason` 的非 running 会话保持原值。
  - `daemon-loop.test` 里 `readFile(tasks/restart.json)` 的断言太弱，replay 也不会改这个文件，真正起作用的是 `executed_task_count: 0`。
- 取锁与启动失败都缺测试：没有 `startDaemon` 失败后锁可重取的用例。
- 为 S1 做准备（不算本批 bug）：`attentionHash` 与核心 `canonical`（`session-continuations.ts`）对 `undefined` 值的处理不同。目前 zod 输出不含 undefined，所以两者一致，但应加一个等价性测试，保证 `decision_hash === decisionDigest`。

## 逐项回答你指定的审查点

- **scope**：task 和 run 的 `tenant_id IS NULL` 过滤正确。会话通过 `runs` 约束到同一 task，session 和 turn 按 `session_id` 过滤，没有发现越权。缺口是 `scope_id` 不含 repo（P2-4）。
- **分页**：keyset 自身（按主键 `>` 加 `LIMIT 101`）正确，问题在复合游标契约（P1-2）。
- **损坏 source**：decision 的损坏处理得当，限制 16KB 并记入 limitations。其他字段的损坏会拖垮整个调用（P2-1）。
- **accepted 未知状态**：`accepted_in_flight_or_uncertain` 与 owner `unknown` 的处理是对的，核心 `hasUnresolvedReceipt` 也是同一集合，所以 `accepted` 本身是一致的。问题在其他未知状态默认当作已解决（P2-5）。
- **SQLite 锁固定 inode**：持有 `BEGIN EXCLUSIVE` 到 close 的方案，本身有效。
  - 竞争者的 pragma 或 BEGIN 返回 BUSY，被正确映射。
  - release 先删 pid 再放锁，顺序正确。
  - 不 unlink 的约束靠文案维持，没有运行时防护（P2-8）。
  - 符号链接检查有缺口（P2-7）。
- **startup 异常清理**：见 P1-1。
- **恢复路径**：loop 和 daily 的 running/stopping 改为 stopped 加 `recovery_required` 是一致的，且不再 replay 或清理。continuation 的 `recover` 有毒丸（P2-11）。

## 判断

**本批暂不能继续整合。** 修复 P1-1、P1-2、P1-3 并补对应测试、跑 typecheck 后，即可整合；P2 可在 S1 前分批处理。P1-1 中“清理范围未证实”的部分，需要你贴出 `startDaemon` 中 server、定时器和 `readConcurrency` 的创建与 close 代码，我才能下结论。
