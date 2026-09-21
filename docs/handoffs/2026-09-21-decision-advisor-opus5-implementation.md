# OSStack 开发交付：Jev 建议 CLI 与 Claude Opus 5 共审

日期：2026-09-21。基线：`15564acfee737aa945cc5bf561b7a5a0d8645ac1`。
分支：`codex/graph-decision-development`。原 checkout 中的未提交内容未改动。

## 当前交付范围

已实现第一条可使用的 Jev 建议链路：严格输入 → 固定问题和模型 → 默认离线校验 → 显式 live 请求 → 私有持久预算 → 结果校验与幂等重放。支持失败分类、有限候选技能推荐。见 [使用指南](../guides/decision-advisor.md)。

这不是整个 Graph 多文件路线的完成声明。没有接入 Loop 自动观察、任务路由、Graph 授权或多文件写手；没有迁移生产数据库，没有使用用户 Jev key，没有真实 Jev 准确率、延迟或账单结论，没有发布 npm 或推送 PR。

## 代码与证据

- `packages/core/src/policy/decision-advice.ts`：纯契约、固定问题、不可变请求、模型/问题/费率/作用域/任务 revision 绑定的 digest、严格结果解析与整数费用。
- `packages/agents/src/decisions/typesafe-client.ts`：原生 fetch、固定域名、无自动重试/重定向、1500ms 全请求期限、64KiB 流式响应上限、UTF-8 严格解码、通用脱敏错误。
- `packages/cli/src/decision-store.ts`：本地私有账本、发送前 fsync 记录与父目录、独占写锁、成功按实际用量结算、不确定结果保留全额 hold、同 digest 不重发。
- `packages/cli/src/decision-command.ts`：`init / advise / status`；默认 dry-run 不联网、不写账本、不打开控制面 DB。
- `scripts/smoke-decision-advice.mjs`：真实 CLI 子进程、假 provider，六进程争用、成功重放、SIGKILL、遗留锁、人工安全解锁后 unknown 不重发。
- 新增纯契约/客户端/CLI/持久化测试：23 项通过；输入、输出、持久化每层均有拒绝路径。
- Core 553、Agents 283 项回归通过（之后增加的针对性测试另行通过）。首次默认并行回归出现已有 DB/清理用例超时，限制 Vitest 为两个 worker 后通过，没有放宽超时时间或改生产逻辑。
- CLI typecheck、构建通过；CLI 全量 150 文件通过、1 文件失败、3 文件跳过：1576 tests 通过、6 项 disk_free 保护失败、3 项跳过；随后单独复跑失败的 loop-cli.test.ts，39/39通过。未修改磁盘保护阈值或既有测试。全量测试原命令退出非零，不能描述为一次全绿。
- 启动基准：`--version` 中位数 60ms（预算150ms），`--help` 161ms（预算500ms），各5次，使用独立 OSSTACK_HOME。

## Opus 5 共审：哪些采纳，哪些挑战

真实调用使用 `claude -p --model claude-opus-5`；工具与 slash commands 禁用。运行结果的 modelUsage 包含 `claude-opus-5`，另有 CLI 辅助 Haiku 用量。原始设计审查、实现审查及复核内容附后。模型没有执行 shell、修改文件或读取凭证。

| 审查意见 | 处置与原因 |
|---|---|
| 成功请求永久占最大预算会让试验过早耗尽 | 采纳：成功按 input_tokens 结算；unknown 仍保留 65536 tokens / 2753 microUSD |
| status 被 crash-left lock 挡住 | 采纳：status 只读 best-effort；准入仍在写锁内重新计数 |
| 401/422 等状态可以证明没有计费，应删记录释放额度 | 不采纳：官方 HTTP 文档没有提供这一计费保证；删除去重屏障会扩大重发风险。错误凭证也可能造成 hold，用前核对 key |
| invalid_request 可能在发送前发生 | CLI 在创建账本记录前验证输入、完整 body 中的 key 和 client 配置；内部 send 注入接口仍保守持留，没有把任意 callback 的口头结果视为账单证据 |
| finally 应吞掉 rmdir/fsync 错误 | 不采纳：隐藏存储/锁失败会误报成功；活跃过程中手工删锁不在可信操作范围。已区分 EEXIST 与其他锁创建错误 |
| tmpfs 重启丢账本 | 采纳：拒绝 tmpfs；支持的本地 FS 见指南。磁盘损坏、删除账本和掉电仍不能宣称强恢复 |
| 输入错误一律 OPERATION_FAILED 无法诊断 | 采纳：仅报告 Zod issue 路径与 code，不输出值、供应商响应体或密钥 |
| key JSON 转义导致漏检 | 采纳：比较转义后的精确 key；不擅自假定供应商规定了20字符最短长度 |
| 一次 read 可能短读 | 采纳：有界循环读取，不使用可能在文件增长时无限分配的 readFile |
| 输出 token 也应计入费用 | 费用建议不采纳：官方当前输出免费。采纳审计数据保留，记录 outputTokens |
| 费率/模型升级导致旧账本不兼容 | v1 保持精确 pin、拒绝不一致；后续升级必须同时提供历史读兼容或显式迁移，不把改常量当作完整升级 |
| 提供自动 unlock / 手动释放 unknown 额度 | 暂不提供：解锁需先证实所有写进程退出；释放额度需独立 provider 证据。指南给出保留去重记录的人工 rmdir 流程，不承诺任意 unknown 可自动恢复 |
| Opus 认为原型键防护已经完整 | 本端测试反证：Zod3 会丢弃 probabilities.__proto__，原检查会接受它；已在原始对象 own keys 上核对允许列表，RED/GREEN 回归通过 |

官方接口形状复核：[TypeSafe API](https://docs.typesafe.ai/api)；费率依据：[Models](https://docs.typesafe.ai/models)。没有把 HTTP 状态当作计费证明，也没有把 confidence 当成正确率。

## 下一阶段执行顺序（未完成项）

1. Jev pilot：冻结并人工标注中英文/歧义/注入样本；先无费用校验输入，真实调用仅在用户提供凭证并启动 live 后进行。最大1000次/$1/10M输入 tokens 是每个 store 的实验上限，不是账户总上限。
2. Shadow 接入：单独准备用户选择的脱敏失败快照；避免上传整日志或在每个 Loop tick 联网；先落独立 advisory 记录，不改变原授权字段。使用当前 store 与 client，不另建含义冲突的计费账本。
3. Graph M1：先固定旧 v1 compiler/registry 兼容与恢复场景，再实现 host 管理的 bounded-changeset、逐调用持留、apply receipt 和3文件 daemon 闭环。Jev 不阻塞也不授权这一主线。
4. Graph M2：M1 apply/ACK/取消/崩溃证据闭环通过后，增加有限 read/list/search；不在单调用额度里暗藏多轮请求。
5. 升级门槛：独立 review + 真实测试 + 未知结果仍阻断 ready；不以额外模型意见代替停止或文件应用证据。

## Opus 5 第一轮：设计审查原文

以下是原文；有争议观点以以上处置表为准。

# 独立审计：Jev 建议层首个垂直闭环

结论：方案可实现，但有三处**内部不一致**必须在写代码前定死，否则第一周就会卡住。

## A. 预算算术与 1000 次上限冲突（最高优先级）

65536 × 0.042 / 1e6 = 2752.512 microUSD，ceil 2753 正确。但"按上限持留" + "实际 usage 晚到只记录"意味着 hold 永不回收：USD1 总预算只够 **363 次 dispatch**，永远到不了计划里的 1000 次。必须二选一：(1) 接受 363 并改文档；(2) 增加显式 `settle` 命令，用回收的实际 usage 把 hold 降到实付——这是账本操作，与"不影响路由"不矛盾，两者是不同维度。不要把这个歧义留给实现者临场发挥。

同时定清楚：**dry-run 是否占预算**。若 dry-run 也写 reserved 文件，测试本身会耗光额度；建议 dry-run 只产出 canonical bytes + digest，零预算、零文件（或写入独立的 `dry/` 子目录且不计入总额）。

## B. 锁语义自相矛盾

"文件锁防双 dispatch" 与 "崩溃留锁不自动破锁" 无法同时由 `flock`/`fcntl` 满足——macOS 上进程死亡内核自动释放，恰好丢掉你要的粘性；`O_EXCL` lockfile 能粘住但无活性检测。正确结论：**锁只是优化，幂等的真正来源是以 digest 命名的 dispatched 记录**——重启后先读记录，存在即拒绝重发、标为待人工核对。lockfile 内写 pid+hostname+boot id+时间戳仅供人工判断。另外 store 落在 NFS/网络盘时两种锁都不可靠，启动时应探测并拒绝。

写序必须是：reserved 文件 fsync → **父目录 fsync** → dispatched 文件 fsync → 目录 fsync → 才发 HTTP。先写后发会产生"幻影 dispatched"（崩在 HTTP 之前），这是保守方向，可接受，但要承认它需要人工 settle。临时文件必须与目标同目录（跨文件系统 rename 非原子），且大量实现会漏掉父目录 fsync——rename 的原子性不等于持久性。

## C. HTTP abort ≠ 未计费，但要区分两档

必须区分"**可证明未发出**"（DNS 失败、connect refused、序列化失败）→ 释放 hold；与"**已发出、结果未知**"（超时、abort、socket reset、读 body 中断）→ hold 永久保留、status=`unavailable`、cost=unknown。不要把两者都记成 unknown，否则每个网络抖动都不可逆地啃掉预算。特别注意：`fetch()` resolve 只代表响应头到达，此时**一定已计费**，即使随后 body 读取超时。

## D. 冻结请求：digest 必须是字节，不是对象

唯一安全实现：读 input FILE 的**原始字节**→canonicalize 一次→得到 `Uint8Array`→对这段字节取 digest→`body` 直接传这段字节（显式 `Content-Type`，绝不把对象交给 fetch 再序列化一次）。否则 key 顺序、数字格式（`-0`、`1e21`）、Unicode 规范化（NFC/NFD）任一差异都会让"签名的东西"和"发出去的东西"不是同一个。同理不要在 digest 之后重新读文件（TOCTOU）。落盘的 artifact 应是这段字节本身，而非重新渲染。`Object.freeze` 是浅的，不要依赖它。

## E. fake fetch 必须能真正触发 deadline

两个常见陷阱：(1) 用 `AbortSignal.timeout()` —— vitest fake timers 不 patch 它，超时测试会变成真实等待或根本不触发；改用手写 `AbortController` + `setTimeout`，可控时钟。(2) fake 立即 resolve，deadline 分支永远没被执行过。fake 必须**尊重 signal** 并以 `AbortError` reject，且测试要覆盖"头已到、body 永不结束"这一档——deadline 必须横跨读 body 全程，`finally` 里清 timer，否则测试进程挂住、未处理 reject 跨用例泄漏。

## F. 原型键与响应解析

`probabilities: Record<string, number>` 是原型污染入口。用**白名单而非黑名单**：只接受本次代码提供的 option id，其余一律拒绝（不是忽略）；容器用 `Object.create(null)` 或 `Map`。`JSON.parse` 本身建 own `__proto__`，危险发生在下游 `{...obj}`/`Object.assign`。同时拒绝：重复 key（静默 last-wins）、NaN/Infinity、负零、sum≠1（用绝对容差如 1e-6，别用 `===`）、model 不等于 `jev-1.13.0`、出现任何权限样式字段。abstain 必须是合法 option 而非缺失。

## G. 字节界限与 UTF-8

界限必须按**读到的字节数**，不能信 `Content-Length`（chunked 时缺失、且可撒谎），更不能用 JS 字符串 `.length`（UTF-16 单位：中文 3 字节算 1，emoji 4 字节算 2，中文响应可超界 3 倍）。做法：逐 chunk 累加 `byteLength`，超限立即 abort **并 `body.cancel()`**（否则 socket 泄漏），最后一次性 `TextDecoder({fatal:true})` 解码——逐 chunk 不带 `{stream:true}` 解码会在多字节边界产生 U+FFFD，悄悄改变内容。输入侧同理用 `TextEncoder` 量字节。注意你无法本地算 token，所以 65536 上限只能靠 400 兜底，这没问题（保守持留已覆盖），但别假装能本地校验。

## H. store 路径归属

`mkdir` 的 mode 会被 umask 削减、**不会**在已存在目录上收紧。必须：`lstat`（不是 `stat`）→ 拒绝 symlink → `realpath` 后复验 → `uid === process.getuid()` → 拒绝 group/world 可写 → 文件 open 后显式 `chmod 0o600`。ID 拼路径前强制 `^[0-9a-f]{64}$`。macOS 家目录大小写不敏感，lock 路径要规范化。`getuid` 在 Windows 为 undefined，要么显式不支持要么另写分支。

另：`TYPESAFE_API_KEY` 只在 `--live` 读取还不够——要保证它不出现在 canonical bytes、artifact、错误信息和 stack 里；并对 input 文件做一次"疑似密钥"拒绝（而非脱敏）。

## 五项最重要测试

1. **默认零出网**：在模块边界把 `globalThis.fetch` 换成"一调用即 fail 测试"的 spy，跑完整 `decision advise` 默认路径；断言未调用、无预算变动、且产出的 canonical digest 与 `--live` 路径将要发送的 digest 逐字节相等。
2. **崩溃一致性与并发双发**：在 dispatched 落盘后、HTTP 前强杀；重启后断言拒绝重发并标人工核对。再起 N 个进程同 digest 并发，断言恰好一次 dispatch、预算恰好扣一次（预算由扫描 store 求和得出，不是读改写单个 json）。
3. **deadline 全程覆盖**：可控时钟 + 尊重 signal 的 fake，分别测"永不响应"与"头已到 body 永不结束"；断言按 deadline abort、timer 清理、记为 unavailable/unknown、hold 保留、无未处理 reject。
4. **字节界限 + UTF-8**：超限的中文/emoji body 且多字节序列跨 chunk 边界；断言在字节阈值处 abort、`body.cancel()` 被调用、无 U+FFFD、非法 UTF-8 被 `fatal` 拒绝。
5. **敌意响应解析**：`__proto__`/`constructor` 键、未知 option id、重复键、NaN/Infinity、sum 0.97、model drift、混入 approve 字段；断言全部 typed 拒绝，且 `({} as any).polluted === undefined`。

不建议在首期加任何新功能；上面 A、B 两项是设计层缺口，其余都是实现纪律。

## Opus 5 第二轮：实现审查原文

以下评审仅基于你粘贴的源码文本（未使用工具，未读 `bin.ts` / `packages/agents/package.json`，这两处的改动无法核对）。

---

# 高危

## H1. 可证明未计费的失败同样扣满 hold，且 digest 被永久毒化 —— 错误 API key 会静默烧掉整个预算

**文件**：`packages/cli/src/decision-store.ts`（`runStoredDecision`）+ `packages/agents/src/decisions/typesafe-client.ts`

**触发条件**：`TYPESAFE_API_KEY` 过期/写错 → `advise` 返回 `{status:"unavailable", reason:"http_error", httpStatus:401}`。`runStoredDecision` 在 `send` 之前已落盘 `dispatched`，随后写 `unknown`，保留全额 hold。

具体爆炸半径（按默认值算）：

- 每条 unknown 占 `2753` µUSD + `65536` tokens + 1 个 call slot。
- token 维度先触顶：`10_000_000 / 65_536 = 152` 次之后 `DECISION_BUDGET_EXHAUSTED`（µUSD 维度为 363 次）。
- 即 **修好 key 之前最多 152 个任务被打上 unknown，实际花费 $0，之后整个 store 永久耗尽**；且这 152 个 digest 因 `existing` 早返回，**key 修复后永远拿不到建议**（输入没变 → digest 没变）。唯一"恢复"手段是删掉整个 store 目录，而那会一并丢掉真正已派发调用的去重屏障。

同一路径还有一个更硬的矛盾：`reason:"invalid_request"` 是在 `fetcher` 被调用**之前**返回的（`buildDecisionRequest` 重建校验失败或 `payload.includes(key)`），即 **可证明未派发**，却同样被记为 unknown 并扣满 hold。这与"native fetch 无法证明 pre-dispatch 失败所以一律保守持有"的前提不成立——这一类是能证明的。虽然 CLI 侧已提前拦了 key 混入 state 的情况，但 `runStoredDecision` 是导出 API，程序化调用者会直接踩到。

**最小修复**：把"未计费可证明"的分支从 hold 语义里摘出来，只需在 `runStoredDecision` 里加一个白名单判定：

```ts
const notDispatched = result.status === "unavailable"
  && (result.reason === "invalid_request"
      || (result.reason === "http_error" && [400, 401, 403, 404, 422].includes(result.httpStatus!)));
if (notDispatched) { await unlink(join(store, filename)); await syncDirectory(store); throw Error("DECISION_NOT_DISPATCHED"); }
```

（保留 `timeout` / `network_error` / 5xx / 429 / `invalid_response` 的保守持有不变。）若不愿在锁内做 unlink，退一步的等价修复是新增 `status:"rejected"`，在 `readStatus` 的两个 reduce 中计 0，并让 `runStoredDecision` 对 `rejected` 记录允许重发。

---

## H2. `status` 也抢写锁 → 粘滞锁的恢复流程自相矛盾，且 CLI 无解锁入口

**文件**：`packages/cli/src/decision-store.ts`（`decisionStoreStatus`）+ `packages/cli/src/decision-command.ts`

**触发条件**：进程崩溃留下 `.lock` 后，运维按既定流程"先人工核对再删锁"，但核对手段 `osstack decision status --store DIR` 走的是 `locked(store, () => readStatus(store))`，`mkdir` EEXIST → `DECISION_STORE_BUSY`。CLI 没有任何 `unlock` / `--read-only` 子命令，于是**唯一能查账的命令被它要恢复的那把锁挡住**。次要影响：一次正常的 `--live` 调用进行中，另一个终端跑 `status` 也会假性失败。

`readStatus` 是纯读（`open` + `readdir`，无写），加锁并无正确性必要；它已经靠 `recordSchema` 与文件名 `digest` 交叉校验来抵御撕裂读，最坏情况是读到一条刚被 rename 覆盖的旧/新版本，对只读报表无害。

**最小修复**：

```ts
export async function decisionStoreStatus(path: string) {
  const store = await checkedStore(path);
  return readStatus(store);   // 只读不加锁
}
```

并补一个 `decision unlock --store DIR`（`rmdir(join(store, ".lock"))` + `syncDirectory`），在 HELP 里写明"仅在确认无其他进程运行后使用"。

---

# 中危

## M2. `locked` 的 `finally` 会吞掉/覆盖真实结果

**文件**：`packages/cli/src/decision-store.ts`

```ts
finally { await rmdir(join(store, ".lock")); await syncDirectory(store); }
```

**触发条件**：运维在一次长调用过程中手动删了 `.lock`（或 store 被并发 `rm -rf`）→ `rmdir` 抛 ENOENT。此时 `runStoredDecision` 已经成功完成并落盘了 answered 记录，但异常从 `finally` 逃出，CLI 打印 `DECISION_OPERATION_FAILED` / exit 1。**一次真实计费的成功调用被报告为失败**。若 `operation()` 本身抛错，原始错误还会被 `rmdir` 的错误完全覆盖，丢失诊断信息。

同一函数另一处：`catch { throw Error("DECISION_STORE_BUSY") }` 把 `mkdir` 的 ENOENT（store 不存在）、EACCES、ENOSPC 全部折叠成 "BUSY"，运维会照着"等一等再试"的错误方向排查。

**最小修复**：

```ts
catch (error) {
  throw Error((error as NodeJS.ErrnoException)?.code === "EEXIST" ? "DECISION_STORE_BUSY" : "DECISION_STORE_UNAVAILABLE");
}
...
finally { await rmdir(join(store, ".lock")).catch(() => {}); await syncDirectory(store).catch(() => {}); }
```

## M3. `statfs` 白名单既漏掉常见本地 FS，又放行了非持久的 tmpfs

**文件**：`packages/cli/src/decision-store.ts`（`checkedStore`）

**触发条件**：

- **漏报**：在 xfs（`0x58465342`，RHEL/Fedora 默认根文件系统）、zfs（`0x2fc12fc1`）、f2fs 上，`init` 与所有后续命令一律 `DECISION_STORE_LOCAL_FS_REQUIRED`。更糟的是 `initializeDecisionStore` 先 `mkdir` 再 `checkedStore`，失败后会**留下一个空目录**，重试同路径变成 EEXIST → `DECISION_OPERATION_FAILED`，错误信息完全指不到真因。
- **误放行**：`0x01021994`（tmpfs/ramfs）在白名单里。tmpfs 重启即空，这直接打穿"durable dispatched records then prevent retries"这条核心不变式——重启后所有 hold 与去重屏障消失，已派发的调用会被重发并二次计费。Linux 上 `tmpdir()` 常常就是 `/tmp`，也就是说**测试跑的正是那条破坏持久性前提的路径**。

**最小修复**：白名单补 `0x58465342`（xfs）、`0x2fc12fc1`（zfs）、`0xf2f52010`（f2fs）；把 tmpfs 从生产白名单移出，改成仅在显式 `allowVolatile: true`（测试注入）时接受；并把 `initializeDecisionStore` 改成先 `checkedStore(dirname(path))` 校验父目录所在 FS，或在 `checkedStore` 抛错时 `rmdir` 掉刚建的空目录。

## M4. `model` / `rateCard` 的 `z.literal` 硬钉会让调价日所有存量 store 直接变砖

**文件**：`packages/cli/src/decision-store.ts`（`configSchema`）

**触发条件**：官方调价 → `DECISION_RATE_CARD` 常量更新 → 所有已存在 store 的 `config.json` 里旧字符串与 `z.literal(DECISION_RATE_CARD)` 不匹配 → `readStatus` 抛 ZodError → CLI 统一映射成 `DECISION_OPERATION_FAILED`。**status 读不了、in-flight 的 `dispatched` / `unknown` hold 读不了、去重屏障读不了**，运维唯一可行动作是删库重建，于是崩溃前已派发的 digest 会被重发。错误文案里没有任何一个字提示"是因为费率常量变了"。

**最小修复**：读写不对称——读侧接受历史费率集合，写侧只允许当前值：

```ts
const KNOWN_RATE_CARDS = [DECISION_RATE_CARD] as const;   // 调价时在此追加旧值
const configSchema = budgetSchema.extend({
  schemaVersion: z.literal(1), model: z.literal(DECISION_MODEL),
  rateCard: z.enum(KNOWN_RATE_CARDS),
}).strict();
```

并在 `runStoredDecision` 里对 `current.config.rateCard !== DECISION_RATE_CARD` 抛明确的 `DECISION_RATE_CARD_STALE`（拒绝新调用，但保留查账能力）。

## M5. 所有 ZodError 被压成 `DECISION_OPERATION_FAILED`，输入排错无路可走

**文件**：`packages/cli/src/decision-command.ts`

```ts
const message = error instanceof Error && /^DECISION_[A-Z_]+$/.test(error.message) ? error.message : "DECISION_OPERATION_FAILED";
```

**触发条件**：`--input` 文件里 `taskRevision` 写成字符串、`state` 超 8192 字节、`candidates` 有重复 id ——统统只回一个 `{"error":"DECISION_OPERATION_FAILED"}`，exit 1。用户对着一个 32KB 的 JSON 无从下手。这不是安全问题（不泄露值），但对一个"人工显式调用"的实验 CLI 是实打实的可用性阻塞。

**最小修复**：只输出 issue 的 `path` 和 `code`，不输出 `received` / 值：

```ts
if (error instanceof z.ZodError) {
  write(JSON.stringify({ error: "DECISION_INPUT_INVALID",
    issues: error.issues.map(i => ({ path: i.path.join("."), code: i.code })) }));
  return 1;
}
```

---

# 低危

## L1. 输出 token 完全不计量，且被永久丢弃

**文件**：`packages/cli/src/decision-store.ts`（`recordSchema` / `readStatus`）

`parseDecisionAnswer` 解析出了 `outputTokens`，`final` 却只写 `inputTokens`，`recordSchema` 又是 `.strict()`，因此结算成本 `decisionCostMicroUSD(record.inputTokens)` 单边只算输入。若钉住的费率覆盖总 token（或输出另有定价），schema 允许 `output_tokens` 高达 65 536，单次最多少计 2 753 µUSD，理论上实际花费可达预算上限的两倍。实践中 choice 型回答输出只有几十 token，账差约个位数 µUSD——所以定为低危；但**数据被丢弃后无法事后补算**，这才是要现在修的理由。

**最小修复**：`recordSchema` 增加 `outputTokens: z.number().int().min(0).max(65_536).optional()`（纳入 answered 的 refine 必填约束），`final` 里带上，结算改为 `decisionCostMicroUSD(record.inputTokens! + record.outputTokens!)`。

## L2. 凭证泄漏自检既会漏判也会误判

**文件**：`packages/agents/src/decisions/typesafe-client.ts` / `packages/cli/src/decision-command.ts`

`payload.includes(key)` 与 `JSON.stringify(request.input).includes(apiKey)` 都是拿**原始 key** 去匹配 **JSON 转义后的文本**。key 若含 `"`、`\` 或控制字符（配置校验只拒空白符），转义后字面量对不上 → **漏判，凭证照发**。另一头没有最小长度约束，一个 3 字符的 key 会让几乎所有 state 触发 `DECISION_INPUT_INVALID` → **误判，功能不可用**。

**最小修复**：

```ts
if (!key || key.length < 20 || /\s/.test(key) || ...) throw Error("DECISION_CLIENT_CONFIG_INVALID");
const escaped = JSON.stringify(key).slice(1, -1);
if (payload.includes(key) || payload.includes(escaped)) throw Error();
```

## L3. 单次 `read()` 假定不会短读

**文件**：`packages/cli/src/decision-store.ts`（`readPrivate`）、`packages/cli/src/decision-command.ts`（`readInput`）

`file.read(bytes, 0, bytes.length, 0)` 只调一次。POSIX 允许常规文件短读（如被信号打断），`readInput` 的 64 KiB 缓冲更容易碰上。一旦短读，`JSON.parse` 失败：在 `readPrivate` 上表现为整个 ledger 突然 `DECISION_OPERATION_FAILED`，且是间歇性不可复现的。

**最小修复**：两处都改用 `await file.readFile()`（`stat.size` 上限检查已在前面做过），或循环读到 `bytesRead === 0`。

## L4. macOS 上 `fsync` 不等于落盘

**文件**：`packages/cli/src/decision-store.ts`（`writePrivate` / `syncDirectory`）

主力平台是 darwin，而 macOS 的 `fsync(2)` 只把数据交给驱动器、不刷写缓存，需要 `fcntl(F_FULLFSYNC)`。因此"派发前 dispatched 记录已持久"在**掉电**场景下不成立（进程崩溃场景成立，这是当前主要威胁模型，故低危）。Node 没有暴露 `F_FULLFSYNC`。

**最小修复**：不要改代码，在 HELP 与 handoff 文档里显式写明"崩溃安全，掉电不保证；掉电后须人工与 provider 对账"，避免不变式被下游当成强保证引用。

---

# 阻塞本次实验性交付的遗漏

1. **无 `unlock` 子命令**（见 H2）。粘滞锁的书面恢复流程当前在 CLI 内无法执行闭环。
2. **无 `reconcile` / `settle` 子命令**。`status` 会报 `unknown` 计数，但没有任何方式在运维对着 provider 账单核实之后释放那笔 hold。结合 H1，store 只能被删掉重建——而重建会丢失去重屏障。这是 hold 语义能否被接受的前提条件。
3. **`bin.ts` 接线与 `packages/agents/package.json` 的 `./decision-advisor` export map 未提供**，无法核对 `@osstack/core/decision-advice` / `@osstack/agents/decision-advisor` 两个子路径导出是否存在、是否被 `sideEffects` / `exports` 正确覆盖。CLI 里是 `await import()`，路径写错在运行时才炸，且会被 M5 压成 `DECISION_OPERATION_FAILED`。
4. **测试缺口**（除你已列出的子进程崩溃/并发之外）：
   - `parseDecisionAnswer` 的 `some(p => p > winner + 1e-6)` 分支完全没覆盖（构造 sum=1 但非 winner 概率更高的分布）。
   - `--live` 全链路无任何用例：没有覆盖 exit code 2（unknown）、没有覆盖 answered 落盘。
   - `decision-command.test.ts` 里 "requires explicit live store and key" 名不副实：`required(flags,"--store")` 在 key 检查之前抛出，用例只断言 exit 1，所以 **`DECISION_API_KEY_REQUIRED` 这条分支从未被执行过**。
   - `readStatus` 的 `DECISION_STORE_CORRUPT`（杂散文件名、`digest` 与文件名不符）与 `.write-*` 临时文件跳过逻辑无覆盖。
   - `initializeDecisionStore` 对已存在目录的 EEXIST 拒绝行为无覆盖（这是"不会静默重置预算"的关键断言）。
5. **HELP 文本与 hold 语义不一致**。"Unknown outcomes never retry" 写了，但没写"unknown 会永久占用全额预算且该 digest 永不可重试"。按默认值，152 次 unknown 就会让 store 彻底耗尽。这句必须进 HELP，否则用户第一次配错 key 就会踩 H1 且无从理解。

---

# 需要你确认的两项（我无法在不用工具的前提下判定）

- **zod 主版本**：`z.record(probability)` 单参形式与 `z.number().safe()` 都是 zod v3 API。若 workspace 已升到 v4，前者需写成 `z.record(z.string(), probability)`，后者已移除。若是 v3 则无问题。
- **`budgetSchema` 里的魔数 `2753` / `65536`** 是从 `DECISION_CALL_HOLD_MICRO_USD` 与 `DECISION_MAX_INPUT_TOKENS` 手抄的。费率或上下文窗口一改，两者静默失同步：下界偏低会让 store 通过校验却连一次调用都付不起（每次都 `DECISION_BUDGET_EXHAUSTED`）。最小修复是直接引用常量：`.min(Number(DECISION_CALL_HOLD_MICRO_USD))` / `.min(DECISION_MAX_INPUT_TOKENS)`。

---

**没有发现的问题**（避免你在这些方向上浪费时间）：digest 与 body 的绑定、候选排序后的重放同一性、`__proto__` / `constructor` / `abstain` 的 id 注入、`Object.fromEntries` 的原型污染、`decisionCostMicroUSD` 的 bigint 向上取整、预算累加的浮点安全范围、`client.advise` 以裸函数引用传递时的 `this`（闭包实现，安全）、`Promise.race` 下 operation 后续 rejection 的 unhandled 风险（race 已挂 handler）、以及 `parseDecisionAnswer` 对选项集合/分布/model drift 的 fail-closed 行为。这几处写得是对的。

## Opus 5 第三轮：复核原文

Read-only review of the pasted sources; no tools run this turn, so everything below is from the text you provided plus your own reported results.

## Blockers

**1. The CLI package's test suite is not green.** Your report: "CLI full ongoing environmental `disk_free` failures under investigation." `packages/cli/src/bin.ts` is modified and the four new CLI files are untracked (`git status`). Until the `disk_free` failures are root-caused, the claim "builds/typecheck/tests pass" holds for core and agents only — `packages/cli` is the package that actually ships `decision`, and it is the one you cannot currently assert is clean. Not a code defect I can see in the pasted files; it is an unfinished verification step.

That is the only remaining item I'd call a blocker.

## Conditions on any live run (not defects, but they bound the verdict)

**Zero live-provider validation.** No real call has ever hit `https://api.typesafe.ai/v1/systemone`. `scripts/smoke-decision-advice.mjs` echoes the request's own criteria back (`probabilities: Object.fromEntries(Object.keys(request.questions.decision.criteria)...)`), so it validates plumbing, not the provider contract. A real shape/endpoint mismatch surfaces as `invalid_response` → `runStoredDecision` writes `status: "unknown"`, retains the full 2753 µUSD hold, never retries. Recovery is a fresh `init` on a new directory (budgets are per-store), not repair of the old one. First live run should use a throwaway store with `--max-calls 2`.

## Non-blocking findings

**`.DS_Store` bricks a store on darwin.** `readStatus`: `if (!/^[a-f0-9]{64}\.json$/.test(name)) throw Error("DECISION_STORE_CORRUPT")`. The skip list is only `config.json`, `.lock`, `.write-*`. Opening `$PWD/.decision-experiment` in Finder (same UID, 0700 is no obstacle) adds `.DS_Store` and every subsequent `advise`/`status` fails closed permanently. `docs/guides/decision-advisor.md` recovery section covers only `rmdir .lock`. Recommend skipping known OS artifacts or documenting their removal as distinct from "never remove digest records."

**macOS `statfs` type allow-list is fragile.** `checkedStore` gates on `[0x1a, 0x11, ...].includes(fs.type)`. On Darwin `f_type` is a VFS-table index, not a stable magic number the way Linux magics are; 0x1a/0x11 are observed values, not a contract. Fails closed (`DECISION_STORE_LOCAL_FS_REQUIRED`), so it's an availability risk on the primary platform, not a safety one. Also: the doc line "tmpfs is rejected" is Linux-specific — macOS `/tmp` is APFS and will be *accepted* despite being auto-cleaned.

**Cross-`zod` `instanceof` is unverified.** `decision-command.ts` tests `error instanceof z.ZodError` against the CLI's `zod`; `buildDecisionRequest`/`parseDecisionAnswer` throw from core's Zod 3 instance. `packages/cli/package.json` was not in the material I was given. If the majors differ, core-origin validation errors fall through to `DECISION_OPERATION_FAILED`. Exit code is 1 either way and no input text leaks on either path (you return only `{path, code}`), so this is diagnostic fidelity, not correctness — but it is worth confirming.

**Temp-file leak on write failure.** `writePrivate` closes the handle in the first `finally`; if `file.writeFile`/`file.sync` throws (e.g. ENOSPC), control never reaches the second `try`, so `.write-<uuid>` is orphaned. `readStatus` skips `/^\.write-[a-f0-9-]+$/`, so it's inert garbage, not corruption.

**Un-documented init half-failure.** `initializeDecisionStore` removes the directory only when `checkedStore` rejects. If `locked(...)`/`writePrivate` fails afterward, the directory survives without `config.json`, `mkdir` exclusivity blocks re-init, and every operation then fails on the missing config. The recovery doc has no procedure for this state.

## Things I checked and found correct

`__proto__` guard reads `Object.keys` on the pre-Zod object before the allow-list compare, and `identifier`'s leading-char class makes `__proto__`/`constructor`/`prototype` unreachable as criteria keys, so `probabilities[choice]` can never resolve through the prototype. Candidate sort precedes digest computation. Cost math: `(65536*42+999)/1000 = 2753`, matching the doc and the smoke assertion. `maxMicroUSD`/`maxInputTokens` minimums guarantee at least one affordable call. Hold is written and fsynced before any provider I/O; `send` failure and `unavailable` both settle to `unknown` with the full hold; `existing` is returned without re-dispatch. Escaped-key comparison is escaped-on-escaped and therefore consistent. The reconstructed `parseDecisionAnswer` call in `runStoredDecision` re-parses a frozen input safely because Zod returns fresh objects.

## Verdict

**Ship-able for experimental, human-invoked CLI use — after the `disk_free` failures are root-caused.** Not for production routing, and nothing here changes that: there is no measured accuracy, latency, or abstention data, and the guide correctly says so.

Do not treat the current state as verified end-to-end. Two gates before anyone runs `--live`: resolve the CLI suite, and burn the first live calls on a disposable store. On my side this was a text-only read — I ran no build, no tests, and no provider calls.

## 第三轮之后的补充处置

- `.DS_Store` 精确名称忽略，其余不明文件仍拒绝；增加测试。
- 临时文件清理覆盖 write/sync 失败，避免正常异常留下 `.write-*`。
- 已补充 init 半失败处理、Darwin 文件系统编号与自动清理临时目录的边界说明。
- CLI 与 core 均使用 Zod3，invalid taskRevision 路径测试通过；agents 的 Zod4 不参与这一捕获。
- 保留安全 failureReason/HTTP 状态帮助诊断（含401测试），不输出远程错误正文，不据此释放 hold。
- 已修复 Graph 中英文 README/quickstart 发布说明：npm CLI/Graph 0.20.0 已发布，GitHub 是包名 release tag，不是 v0.20.0。新 decision 命令清楚标注 source preview，生成的命令清单已更新。
- 复核原文是文本审阅，不是模型亲自运行的测试；完整 CLI 重跑的最终结果见下节。


## 最终验证与本地提交

2026-09-21 最后一次完整 CLI 回归（`pnpm --filter @osstack/cli exec vitest run --maxWorkers=2`）退出0：**151 test files / 1583 tests 通过，3 files / 3 tests按现有配置跳过**，496.44秒。此前6项错误均来自既有 `local-execution.ts → runAutonomyHealth → disk_free` 保护，失败文件39项单独复跑与最终整套复跑均通过。没有改保护阈值、禁用保护或删除测试。首次失败时的精确空闲字节未留存；随后直接 statfs 测得临时文件所在卷13.97GiB可用，故不伪称测得当时具体值。

- `pnpm --filter @osstack/core exec vitest run --maxWorkers=2`：553 passed；后加的原型键负例 RED/GREEN 单独通过。
- `pnpm --filter @osstack/agents exec vitest run --maxWorkers=2`：283 passed；后加的转义 key 用例单独通过。
- 新增专属测试最终共23项：core6、agents7、CLI10，全部通过。
- `pnpm smoke:decision-advice`：依赖闭包构建 + 真实CLI子进程故障/并发冒烟通过；最后的 CLI 源码变更之后再次构建和冒烟也通过。
- CLI typecheck、改动文件 Biome 检查、`git diff --check` 通过。命令清单由 `scripts/generate-inventory.mjs` 生成（48个顶层命令）。
- Opus 第三轮唯一阻塞是 CLI 验证尚未完成；上述最终结果补齐了该验证。此判断由本端基于实际工具结果做出，不将本端测试冒称 Opus 亲自执行。

源代码提交：

1. `6d7fa2e` — core 非权威建议契约。
2. `ef8d5d9` — TypeSafe 有界客户端、契约加固与测试。
3. `f264829` — CLI、私有预算账本、故障测试、用法与发布文档修正。

本次只创建本地提交；没有推送分支、创建PR、发布npm或改生产home。后续 Graph M1/M2 与 Loop shadow 仍按“下一阶段执行顺序”推进，不在本次完成范围内。
