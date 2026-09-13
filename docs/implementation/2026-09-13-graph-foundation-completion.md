# OSStack Graph 基础实施验收：G00–G04

2026-09-13。**G00–G04 已实现并验收，完成 5/30 项。M0 的 G05–G07 及后续 M1–M3 尚未开始。** 当前交付的是可靠的单次实现基础，不是完整可执行图产品。

实际代码工作区：`/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation`，分支 `codex/graph-runtime-foundation`。代码验收提交：`de4a3bbebc48fc119d9aca41d547d60da773e8a2`。原始检出 `osstack` 的用户 AGENTS.md 和代码未改；计划与接续材料另行同步到原路径。未合并、推送或部署。

[完整计划](2026-09-13-osstack-graph-upgrade.md) · [机器任务清单](2026-09-13-osstack-graph-upgrade.tasks.json) · [验收数据和源文件哈希](graph-foundation-evidence/acceptance-summary.json)

## 1. 已获得的能力

| 任务 | 实际交付 | 关键结果 |
|---|---|---|
| G00 | 隔离工作区、显式临时 OSSTACK_HOME、原生依赖/迁移/性能基线、夹具 | 测试不连接默认或保留控制面 DB；不动原检出代码 |
| G01 | adapter 流终态检查和稳定失败分类 | 无 done 不再伪成功；非法 payload、冲突终态、终态后工作均失败 |
| G02 | 外部取消、内部超时、有限等待、独立停止证据 | 请求取消与确认停止分开；晚到 done 不能覆盖未知状态 |
| G03 | POSIX 命令进程组 TERM→宽限→KILL，以及组消失/leader 退出确认 | 管道关闭或 shell 退出不再被误当作子孙进程全部结束 |
| G04 | `executeCandidateImplementation` 公共入口；明确 legacy 路径 | 一次授权、一次实现；实现完成不自动评审、冻结、commit 或 merge |

主要实现见 [candidate-execution.ts](/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation/packages/loop/src/candidate-execution.ts)、[executor.ts](/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation/packages/loop/src/executor.ts)、[loop-engine.ts](/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation/packages/loop/src/loop-engine.ts) 和 [adapter 契约](/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation/packages/agents/src/base.ts)。

新增入口接收已选择的 ExecutionPlan、注册工作区引用和必需的可信授权回调。调用前复制并冻结 plan/command/workspace，先把实际执行 repo_path 规范到工作区，再把同一范围交给授权方；拒绝不一致路径和非法输入。授权等待期间取消会阻止执行，迟到授权或拒绝均不会触发额外实现。

返回状态为 `implementation_complete / failed / cancelled / execution_unconfirmed / authorization_denied / invalid_input`，附准确执行证据和工作区引用。`implementation_complete` 仅表示本次实现执行完成：还没有冻结候选、独立评审或测试质量门，不能冒充 `candidate_ready` 或整个任务成功。真实演示在临时 Git 仓库写入一个文件，验证授权只调用一次、HEAD 不变、不生成 Loop 状态或任务队列，命令退出和停止证据成立；见 [演示源码](graph-foundation-evidence/candidate-demo.mjs) 与 [实际输出](graph-foundation-evidence/accepted-demo.json)。

旧 Loop 仍负责选 agent、治理准入、角色区分、验证和既有交付生命周期。新增停止门：若实现无法确认停止，立即升级处理，保留工作区和证据，不再调用 verifier、清理、下一次实现或下一任务。停止标记使用 CompletedTask 的结构化 `implementation_unconfirmed`，重启时仍生效；模型摘要里写同名文字不能触发这个标记。未新增通用 resume/reconciled 开关来绕过停止。

## 2. 如何使用了 OSStack 和 Claude

本次不是仅借用 OSStack 的名字编写代码。G01→G04 由真实 `LoopEngine` 调用 `CodexCliAdapter` 编码，逐卡执行定向验证；每张卡的结果均记录一个发现任务、一个执行任务、一次成功迭代。监督会话负责审查、复现实验、修正以及本地提交。

| 阶段 | 可审计证据 |
|---|---|
| 基线与控制器代码来源 | [G00 基线](graph-baseline.md)、[编译运行时哈希](graph-foundation-evidence/controller-runtime-hashes.json) |
| G01 | [状态](graph-foundation-evidence/G01-STATE.md)、[执行者 RED/GREEN](graph-foundation-evidence/G01-executor.md) |
| G02 | [状态](graph-foundation-evidence/G02-STATE.md)、[执行者 RED/GREEN](graph-foundation-evidence/G02-executor.md) |
| G03 | [状态](graph-foundation-evidence/G03-STATE.md)、[执行者 RED/GREEN](graph-foundation-evidence/G03-executor.md) |
| G04 | [状态](graph-foundation-evidence/G04-STATE.md)、[输入](graph-foundation-evidence/G04-input.json)、[执行者 RED/GREEN](graph-foundation-evidence/G04-executor.md) |
| 最终验收 | [STATE.md](graph-foundation-evidence/acceptance-STATE.md)、[完整结果](graph-foundation-evidence/acceptance-result.json)、[控制器快照](graph-foundation-evidence/acceptance.mjs.txt) |

编码控制器用原基线的编译运行时管理隔离工作区；最终验收改用已升级的编译运行时。最终验收仅一个任务、一轮实现、6 条 verifier 命令全部通过。验收发生在代码提交之前，结果中的历史 HEAD `3722e22` 指前一提交，不是最终源码身份；[SHA-256 清单](graph-foundation-evidence/acceptance-summary.json) 固定实际接受的 9 个 TypeScript 文件，已逐一与 `de4a3bb` 提交核对。

过程中发现控制器配置错误：legacy `inputTasks` 只是追加输入，不能关闭默认 Git diff/queue 扫描。第一次最终验收因此重复运行确定性的验证命令，已中止；最终控制器显式设置 `sources: []`，成功记录一个发现/执行任务。那次重复运行没有调用编码 agent、merge 或部署；不作为最终验收。保存的 [编码控制器快照](graph-foundation-evidence/run-card.mjs.txt) 已补此配置，属于后续修正版，不冒充最初逐卡执行时的原始脚本。

Claude CLI 实际调用 `claude-fable-5-1` 做两轮独立审查（无工具、无 hooks、无 MCP），模型元数据保留于 [第一轮](graph-foundation-evidence/claude-g01-g02-metadata.json) 和 [最终轮](graph-foundation-evidence/claude-final-metadata.json)。这是审查与挑战，不声称 Claude 对最终修改后的代码再次签字。

## 3. 审查发现如何处理

| 审查发现 | 处理与验证 |
|---|---|
| 取消宽限依赖墙钟，过期后仍可能等待；流事件等待器累积 | 单调时间和显式 expired 标记；等待订阅结束即解除；有限取消验证 |
| 非法流退出没有中止实际 invocation | 发出 abort，有限等待停止证据；保留原协议错误与停止不确定性 |
| 已结束的 availability probe 被误标为未知 | 区分已结束的 preflight 与仍挂起的 probe；确实未调用且 probe 已结束时有未启动证明 |
| 同一 plan 重试复用 run ID，可能误用旧停止证据 | 每次执行生成独立随机 run ID；重复 plan 的两次执行身份不再相同 |
| 模型 summary 可伪造停止字符串 | 使用引擎写入的结构化标记；模型文字不作为控制信号 |
| 父进程 SIGINT/SIGTERM/exit 留下受控命令 | 有限 TERM/KILL 清理窗口、退出时同步尽力 KILL、清理监听器，保留宿主已注册的信号处理逻辑 |
| 正常退出的后代进程需要短暂自然收尾 | 提供有限自然 drain，再按需清理；避免把正常短尾任务直接杀掉 |
| 授权看到的 repo_path 与实际执行路径不同；非法输入泄漏异常 | 冻结前绑定实际路径；NUL 等无效值在执行前拒绝，意外执行异常返回 unknown |
| Windows 不支持本实现的进程控制 | 启动前拒绝，并记录未启动已确认；不误报曾发起不可知执行 |

最终轮先新增 11 个失败复现，再修复到全绿；另有 4 个兼容测试覆盖已结束的 timeout probe、自然收尾、监听器释放和宿主信号处理。[RED](graph-foundation-evidence/final-review-red.txt)、[GREEN](graph-foundation-evidence/final-review-green.txt)、[最终信号处理定向验证](graph-foundation-evidence/shutdown-tests.txt) 均保留，最终全仓测试在最后一次信号处理修正之后执行。

未采纳“先出现 done 后挂起也保留成功”的建议：done 后仍可能出现非法工作或执行尚未停止，必须继续受终态/取消证据约束。仍挂起的 availability probe 也不能仅凭未调用 invoke 宣称全部停止。完整意见与裁决见 [第一轮审查](graph-foundation-evidence/claude-g01-g02-review.md)、[最终审查](graph-foundation-evidence/claude-final-review.md)、[处理记录](graph-foundation-evidence/g02-review-followup.md)。

## 4. 验证结果与复现

环境：macOS arm64，Node 26.5.0，pnpm 11.4.0，临时 OSSTACK_HOME；未连接生产 DB。

| 验证 | 结果 | 原始输出 |
|---|---|---|
| `pnpm build` | 全工作区通过 | [build](graph-foundation-evidence/accepted-build.txt) |
| `pnpm -r --no-bail --workspace-concurrency=1 test --maxWorkers=2` | 21 个包，2,567 个测试通过；Loop 381、agents 138、CLI 850 | [完整测试](graph-foundation-evidence/accepted-workspace-tests.txt) |
| `pnpm typecheck:check`（此前已全量 build） | 全工作区通过 | [typecheck](graph-foundation-evidence/accepted-typecheck.txt) |
| `node --test scripts/graph-test-env.test.mjs` | 1 个隔离夹具测试通过 | [fixture](graph-foundation-evidence/accepted-fixture.txt) |
| `node scripts/bench-cli-startup.mjs` | version 中位 29ms / 150ms 预算；help 76ms / 500ms，各 5 次 | [性能](graph-foundation-evidence/accepted-startup.txt) |
| 9 个修改 TS 文件 Biome + `git diff --check` | 通过 | [lint](graph-foundation-evidence/accepted-lint.txt)、[diff](graph-foundation-evidence/accepted-diff.txt) |
| 已编译公共 API + 真实临时 Git 仓库 | 一次实现、无 commit/Loop 状态写入、命令组停止已确认 | [demo](graph-foundation-evidence/accepted-demo.json) |

归档日志仅规整行尾空白，保留测试输出内容；未规整的输出仍在本次临时 evidence 目录。21 个包及数量可在 [机器验收摘要](graph-foundation-evidence/acceptance-summary.json) 逐项核对。控制测试并发是为避免已记录的基线 adapter-conformance 5 秒超时，不是跳过测试。首次全仓测试另发现复制进来的历史研究 context 有 32 个失效 Markdown 链接；已修正路径或固定到已核实的 GitHub commit，没有关闭文档检查；[链接修复记录](graph-foundation-evidence/link-repairs.json)。原始 context 可从基线文档提交 `e2edc68` 查看。

在实施工作区复现主要检查，所有命令均经临时 home 包装：

```sh
cd /Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation
node scripts/graph-test-env.mjs -- pnpm build
node scripts/graph-test-env.mjs -- pnpm -r --no-bail --workspace-concurrency=1 test --maxWorkers=2
node scripts/graph-test-env.mjs -- pnpm typecheck:check
node scripts/graph-test-env.mjs -- node scripts/bench-cli-startup.mjs
node scripts/graph-test-env.mjs -- node docs/implementation/graph-foundation-evidence/candidate-demo.mjs
```

控制器快照保留本次机器的绝对路径，供审计参考；重跑必须建立自己的显式 home/evidence 路径，不能把快照直接当作通用发行脚本。

## 5. 本批边界与下一轮

- `authorize` 是可信集成方提供的回调；本次不实现持久工作区注册、撤权检查、动作账本或原子 broker。图数据本身不是权限。G09–G12 必须接到真实控制面权威。
- 可选 `AgentAdapter.confirmStopped(runId)` 建立了证据接口，但尚未为所有生产 adapter 实现真实停止观察器。缺少证据时取消返回未知；AbortSignal、iterator 关闭或迟到 done 不能代替停止证明。
- POSIX 保证只覆盖本层拥有的进程组。主动脱离组的进程、父进程被 SIGKILL、同步 JS 永久阻塞不在本批证明范围。Windows 命令路径启动前拒绝；未做 Linux/Node 22 实机认证。
- 因异常存活后代而被迫清理的执行，仍保守阻止自动重试；有界自然收尾减少误判。未知执行保留状态和工作区，没有假造“安全恢复”。持久 ledger/reconciliation 属于 M1，尤其 G11/G15。
- 没有 graph worker、检查点、并行汇合、条件路由、图级预算/恢复、graph run CLI。RPC p95 和 Loop tick 占比未实测，不能把 CLI 启动预算冒充这两项。

下一批严格按 **G05→G06→G07**：

1. **G05**：protocol JSON/Zod 3 边界，GraphSpec、结果、预算与 WorkerActionRequest/Response；明确稳定 digest、idempotency、revision 和身份校验责任。
2. **G06**：独立 `@osstack/graph` 包，轻入口与 worker 入口分离；确认 LangGraph 候选和锁定依赖；验证加载成本及发行方式。
3. **G07**：真实跨进程 Saver/序列化实验，覆盖 pending writes、父子 checkpoint、版本与恢复；失败先处理，不跳过内核准入。

继续前读本报告和 [机器任务清单](2026-09-13-osstack-graph-upgrade.tasks.json)，确认实施分支和最新用户改动。使用 OSStack 时设置 `sources: []` 后只传本批指定任务；每张卡保存输入、STATE、result 和验证证据。G05–G07 通过才能宣称 M0 完成；OSBot/OStag 的功能和部署仍在各自产品任务中处理。
