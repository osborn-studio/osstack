# 迟到回执读取的并发收敛修复

日期：2026-11-07。独立修复分支 `codex/bridge-receipt-convergence` 从冻结 N9 `287864a5` 建立，先选取独立 CLI 测试提交 `7bb61703`（本分支对应 `09f0a5e8`）。没有移动 N9 的分支 head，没有改 CLI 所有的新测试或原报告，也没有运行沙箱 execute、构建全仓或触碰正式 DB。

## 已证实的缺陷

两个独立 recovery 实例都先读取 pending 意图。A 停在远端读取，B 确认回执并把链/子 Mission 完成；A 的 matching 或 missing 结果迟到后，仍按旧状态尝试结算。正常环境重跑独立 CLI 三项测试，修复前为 **2 failed / 1 passed**：迟到调用抛 `SQLITE_CONSTRAINT_TRIGGER / intent_transition_denied`。

数据库终态约束成功阻止了确认意图被覆盖；相关事务回滚后，原测试的持久状态断言仍通过。因此，真实 P2 是迟到恢复调用异常、不能正常收敛，不是已证明发生了数据覆盖。修复不放宽数据库约束。

## 修复边界

- `recoverRevision` 在异步回执/PR 读取的成功与错误返回处重读意图状态。另一个调用已完成结算时，旧结果返回 blocked，不再操作链或子。
- pending 页的调用方在异步恢复返回后再次检查 pending，覆盖两个 Promise continuation 之间的结算窗口。
- uncertain、refusal 和 read-back 的事务内写入也核对当前状态；已完成的回执、子和链不被迟到结果改写。
- 显式 `reconcileReceipt` 与手动 uncertain 对账同样识别迟到的成功、缺失或网络错误。没有并发结算时，真实读取失败仍抛出；不是吞掉所有异常。
- 带 signal 的恢复仍先判断取消，保留调用者的原取消原因。owner fence、确认事务及 SQLite 终态触发器保持不变。

## 本次正常依赖环境与验证

本工作树使用常规安装的 `better-sqlite3` **12.10.0 JS 包**与其 `build/Release/better_sqlite3.node`，没有采用独立 CLI 早期复现的 12.11.1 native 替换。Node 为 `v26.5.0`；native 文件 SHA-256 为 `661b20e6839aaeb09692713eca557ba8036f13a817ff0f410a571cdc693cd90b`。只读依赖检查通过内存 SQLite `select 1`，没有打开 serving home。这里记录加载位置/版本/哈希，不声称本轮重新编译过 native 依赖。

标准工作区 Vitest 命令，没有 scratch source-alias 配置：

```sh
pnpm --filter @osstack/cli exec vitest run src/contained-mission-bridge-recovery-boundaries.test.ts
```

同一命令修复前 **2 failed / 1 passed**，修复后 **3 passed**。独立 CLI 所有的测试文件没有被修复方修改。

在原 publication 测试文件增加了显式对账和手动 uncertain 对账的 matching/missing/error 迟到结果，以及确认后的迟到 refusal 回归。它们使用真实 Mission FSM、SQLite 和 W13 stopped 记录。缺失/错误事实仍未结算时的原测试继续检验拒绝路径。

针对 receipt/startup/landed/refusal 的旧回归、独立并发回归和新用例一起运行：**61 passed / 91 skipped**，两个测试文件。CLI typecheck、针对两个改动 TypeScript 文件的 Biome、diff check 和 inventory freshness 均通过。本报告不把未执行的全仓、Linux 或真实 GitHub 操作计为通过。该修复仍需独立审阅后再由主会话决定集成；本分支没有推送或部署。
