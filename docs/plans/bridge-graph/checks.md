# 执行图检查表

每行一条要求。判定只取 pass、fail、unresolved。证据写到能直接打开的位置（PR、文件、命令）。没有证据的标“缺证据”。节点见 [graph.md](graph.md)。最新状态与历史范围以 [progress.md](progress.md) 为准；沙箱 PASS 不打开生产门。

## 收尾清单（来自 graph.md §0 的“完成”定义）

| 要求 | 判定 | 证据 |
|---|---|---|
| N1–N15 全部 pass | unresolved | 见下表 |
| 阶段 7：主仓库连续 5 条链无异常 | unresolved | 缺证据（N15 未开始） |
| 阶段 7：设计 §6 指标能用 `osstack stats` 读出 | unresolved | N1 提供计数类指标；每轮耗时、对账周期耗时需阶段 5 数据（#394 描述） |
| 无 unresolved 的要求，fail 都已修复或声明 | unresolved | 本表 |

## 节点检查

| 节点 | 要求 | 判定 | 证据 |
|---|---|---|---|
| N1 | 链事件只含白名单字段，`stats` 只读且永不使 `stats` 失败 | pass | #394 描述；`bridge-chain-events.test.ts`、`bridge-stats.test.ts` |
| N1 | 合入 #391 + #393 后的两条 grant-store 测试修复 | pass | #394 提交 6b58ba7b；core 1217 项通过 |
| N1 | CI 通过 | pass | #394 已合并 |
| N2 | 迁移 54 连续注册，升级门含表与 14 个触发器 | pass | #395；Codex 无 P1/P2 |
| N2 | CI 通过 | pass | #395 已合并 |
| N3 | 影子合并不铸令牌、不写、只 GET | pass | #396 负向集成测试 |
| N3 | Codex 第 2 轮两条 P2（`cycle_after`、重启重置轮询） | pass | 迁移 55（#404） |
| N3 | CI 通过 | pass | #396 已合并 |
| N4 | 子 Mission 不能发布；派发一事务 | pass | #397 |
| N4 | 验证容器启动前的链复查有直接测试 | unresolved | 需要 Docker 路径（#397 描述） |
| N4 | CI 通过 | pass | #397 已合并 |
| N5 | 每个本地写入都经过门；恢复不发信号 | pass | #399 |
| N6 | 远端写入都经过门；T17 经 HTTPS 代理真实推送 | pass | #406、#409 |
| N7 | `publishRevision`：意图先行、租约推送、按远端 head 分类、D4/D10 一事务 | pass | #410；ZCode 三轮 |
| N7 | D8：待推送且 base 变化时停链 | pass | #408 |
| N8 | 栅栏在释放时复查链、子、意图、预留、认领与授权，且失败即拒绝 | pass | #411；ZCode 两轮无 P1/P2 |
| N8 | CI 通过 | pass | #411 已合并 |
| N9 | D7：只写 closed 与观测；关闭时同事务作废预留 | pass | #412；ZCode 第 1 轮 P1 已修 |
| N9 | D9 与停止链扫描服务已合入 main | pass | #414、#416；基线 `b7815b6c` |
| N9 | 评审反馈定位已合入 main | pass | #417，合并 `a9b1a605` |
| N9 | 手动 check 与 live 观测的合并 | pass | #418/#419 已进入 main `9e2eaf9c`；历史 head/CI 待定记录保留于 progress.md |
| N9 | 回执恢复、production factory、pending scheduler、exact ledger 独立 PR 门 | pass | #422 用户合并 main `d89cd4a5`；正常生产 acceptance lock 关闭 |
| N9 | token 后复查与 deferred receipt 审阅修复 | pass | 随 #422 合并；invocation-scope 修复获历史 GLM 静态复审；不替代人审或正式批准 |
| N10 | 历史 #413：三个主配置无错、14 个模型变异被捉到 | pass | #413 README；仅证明该历史快照，不是本轮 Phase 5 模型验收 |
| N10 | Phase 5 故障、源变异、properties 的最终快照归档 | pass | phase5 报告与 final-property-runs.json、final-source-mutants.json；分别绑定来源，不声称第四轮重跑 |
| N10 | Phase 5 broad TLC 完整穷举 | pass | model-checks.json：main 69,290,566 distinct；rounds 95,121,536；queue 0、exit 0；模型边界保留 |
| N9/N10 | 已记录 candidate 全仓门 | pass | source `7f657613`：22 包、8,905 pass/6 skip；本轮 reporter delta 另有 484 Node pass，不声称重跑全仓 |
| 辅助 | loop 进程夹具合并 | pass | #420 已进入 main `9e2eaf9c`；本地最终 loop 116/116，历史失败保留 |
| N12 | M-D 沙箱场景录制 | pass | #403 |
| N11 | 宿主 Docker 与真实 preflight | pass | 真实 driver 的 `--preflight --run revision-5g-20261107` 已通过；私有记录 `/Volumes/AIMATE_WORK/tmp/osstack/revision-sandbox-preflight.json`；输出明确 `qualified:false` |
| N11 | 实际 v2 5-G A/B、越权与 timeline 一致性 | pass | 第四轮 13/13，driver `c6c3dd93` / installed `81205698`；[第四轮证据](../../reports/bridge-phase5-verification/fourth-run-v2.md)，独立 68 GET；前三失败保留 |
| N13 | 共享云电脑 gh 流程可替代 App C/D 迁移 | unresolved | 不能替代；App 身份、安装权限、U-1…U-11 仍须分别提供证据 |
| N13 | Grok 平台能力 U-1…U-11 已核实 | unresolved | 阶段 6 规格 §0；需运营者 |
| N14 | `main-quality` 在主仓库读回与文件一致 | unresolved | 需仓库管理员 |
| N11 | 第四轮 host 停止与待决账本 | pass | 69 host stopped、14 mission stop_obligation=0；两个 T2/revocation 待决状态保留，ledger_settled=false；不声称全清 |
| N11 | 第四轮五个 Sol scope 审阅 | pass | rounds/containment/inventory 与 release-delta/timeline-delta；原 retention gaps 由冻结 snapshot 与完整 raw GET 解答 |
| N11 | 第四轮 GLM post-run 静态复审 | pass | SCOPED PASS，无未解决实质发现；仅 strict-allowlist projection/retained artifact 静态一致性、无执行/真实性/完整项目声明；input hash 见 current-v2-status.md |
| 交付 | 五片 main-base PR 的新 head CI、人审与合并 | unresolved | #425 CI 已报告全通过；#426–#429 draft/base main；按 #425 → #426 → #427 → #428 → #429，未声称合并 |


## N9/N10 历史确定性门命令（复现参考；不是当前执行指令）

先记录完整仓库身份、base/head SHA、干净 checkout 与工具版本。代码在无宿主凭证、无 App keys、无生产数据的隔离 disposable runner 中执行；读取 PR/CI 的连接留在 runner 外。worktree 仍使用 `~/Developer/CodeX/.worktrees/osstack/<task>`，所有临时内容落在 `/Volumes/AIMATE_WORK/tmp/osstack` 的规范子目录。以下 `VERIFY_BASE_SHA`/`VERIFY_HEAD_SHA` 必须由可信控制器设置为完整 SHA，不从 PR 正文拼接。

### 两个 PR 都要通过

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm build
pnpm typecheck:check
node scripts/generate-inventory.mjs --check
node scripts/check-changeset-coverage.mjs --self-test
node scripts/check-changeset-coverage.mjs --base "$VERIFY_BASE_SHA" --head "$VERIFY_HEAD_SHA"
OSSTACK_SCRATCH_ROOT=/Volumes/AIMATE_WORK/tmp/osstack pnpm --workspace-concurrency=1 -r test
OSSTACK_BENCH_VERSION_BUDGET_MS=250 OSSTACK_BENCH_HELP_BUDGET_MS=900 node scripts/bench-cli-startup.mjs
```

这是本节点必要门，不替代可信 `.github/workflows/ci.yml` 中 release facts、clean-typecheck、各类 offline fixture/release smoke 和矩阵；两个 PR 都含代码或脚本，不能套用 docs-only heavy-smoke 例外。启动预算保留原值，不能通过高负载失败后提高预算刷绿。每个命令保存 exit code 和独立 log；全仓按 workspace 串行，TLC 不并跑。

### N9 定向门

```sh
OSSTACK_SCRATCH_ROOT=/Volumes/AIMATE_WORK/tmp/osstack pnpm --filter @osstack/core exec vitest run src/state/engineering-revision-chain-store.test.ts --maxWorkers=1
OSSTACK_SCRATCH_ROOT=/Volumes/AIMATE_WORK/tmp/osstack pnpm --filter @osstack/cli exec vitest run src/contained-mission-revision-publication.test.ts src/contained-mission-revision.runner.test.ts src/contained-mission-bridge-ledger.test.ts src/contained-mission-bridge-production.test.ts src/contained-mission-bridge-process.test.ts src/contained-mission-bridge-receipt-adapter.test.ts src/contained-mission-service-wiring.test.ts src/contained-mission-ports.test.ts src/contained-mission-bridge.test.ts src/contained-mission-grant.test.ts src/contained-mission-bridge-live.test.ts src/contained-mission-bridge-read-limiter.test.ts src/contained-mission-bridge-stopped-scan.test.ts --maxWorkers=1
```

检查生成的 public-export inventory：core 方法沿既有入口公开；CLI factory 保持独立 lazy 构建入口；off/shadow 无 App 写入，恢复先于 timers，生产 acceptance lock 未移除。条件 P2 已有 `d8964643` 与对应回归，须保留其 invocation 绑定并在最终 N9/N10 head 上追加相关门；GLM 复审已通过，但不宣称用户 Reviewer 已给正式 CR。

### N10 定向与验收门

```sh
OSSTACK_PROPERTY_RUNS=10000 OSSTACK_PROPERTY_SEED=51007 OSSTACK_SCRATCH_ROOT=/Volumes/AIMATE_WORK/tmp/osstack pnpm --filter @osstack/core exec vitest run src/bridge/revision-chain.property.test.ts --maxWorkers=1
OSSTACK_PROPERTY_RUNS=10000 OSSTACK_PROPERTY_SEED=51007 OSSTACK_SCRATCH_ROOT=/Volumes/AIMATE_WORK/tmp/osstack pnpm --filter @osstack/cli exec vitest run src/contained-mission-revision.spec-property.test.ts --maxWorkers=1
OSSTACK_SCRATCH_ROOT=/Volumes/AIMATE_WORK/tmp/osstack pnpm --filter @osstack/cli exec vitest run src/contained-mission-revision-publication.test.ts src/graph-delegation.integration.test.ts --maxWorkers=1
node --test scripts/verify-bridge-phase5-mutations.test.mjs
node --test scripts/smoke-bridge-revision-sandbox.test.mjs
node --check scripts/smoke-bridge-revision-sandbox.mjs
```

以下是历史重型门复现命令。TLC、属性与变异已有源绑定完成记录；仅在相关源码变化或新失败要求时，由当前控制器选择受影响门，不按此历史清单重复执行：

```sh
OSSTACK_SCRATCH_ROOT=/Volumes/AIMATE_WORK/tmp/osstack node scripts/verify-bridge-phase5-mutations.mjs
OSSTACK_SCRATCH_ROOT=/Volumes/AIMATE_WORK/tmp/osstack node scripts/verify-bridge-phase5-tlc.mjs --bounded
OSSTACK_SCRATCH_ROOT=/Volumes/AIMATE_WORK/tmp/osstack node scripts/verify-bridge-phase5-tlc.mjs --main
OSSTACK_SCRATCH_ROOT=/Volumes/AIMATE_WORK/tmp/osstack node scripts/verify-bridge-phase5-tlc.mjs --mutants
```

TLC 的 `TLA2TOOLS_JAR` 必须指向已核实的 official jar，记录 jar digest、JDK、cfg、source SHA、完整退出码、最终 states/queue；通过要求穷举完成且 queue 为 0，不接受随机模拟替代。恢复 checkpoint 时保留原 cfg/module/工具绑定；如果模型或 cfg 改变则重新建立证据。源变异必须 19/19 killed，构建/导入/语法错误记 invalid；旧 survived 记录与后来修复后的独立 killed 记录都保留。

### 文档、边界与 merge-result 门

```sh
OSSTACK_SCRATCH_ROOT=/Volumes/AIMATE_WORK/tmp/osstack pnpm --filter @osstack/governance exec vitest run src/knowledge-hygiene/osstack-config.test.ts --maxWorkers=1
git diff --check "$VERIFY_BASE_SHA" "$VERIFY_HEAD_SHA"
git diff --quiet "$VERIFY_BASE_SHA" "$VERIFY_HEAD_SHA" -- .agents/skills/verify-osstack/SKILL.md .cursor/skills/verify-osstack
```

另外检查 `git log "$VERIFY_BASE_SHA..$VERIFY_HEAD_SHA" -- .agents/skills/verify-osstack/SKILL.md` 为空；只看 net diff 不够，因为 add/modify/delete 三个已撤销提交可以净零但仍被混入历史。核对实际 diff 路径属于 progress.md 对应节点清单。

轻量 `git merge-tree` 只回答文本/树冲突；它不证明两个独立 green PR 合起来能运行。在独立 hidden worktree 构造 main + #418 当前 head + #419 + N9，再加入 N10，记录精确 merge-result SHA，并运行相关定向、typecheck、inventory 与串行全仓门。更新 base 或任何 head 后旧 merge-result 证据即过时。不得把 merge/rebase 或测试结果直接写回 frozen final candidate。

N11 的真实 preflight 与 `--execute` 不属于普通无凭证 CI 门。第四轮已用完额外一次沙箱授权；无第五轮授权。N11 sandbox PASS 不批准部署、生产准入或 App C/D 迁移。
