# 执行图检查表

每行一条要求。判定只取 pass、fail、unresolved。证据写到能直接打开的位置（PR、文件、命令）。没有证据的标“缺证据”。节点见 [graph.md](graph.md)。

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
| N8 | CI 通过 | unresolved | #411 |
| N9 | D7：只写 closed 与观测；关闭时同事务作废预留 | pass | #412；ZCode 第 1 轮 P1 已修 |
| N9 | D9、回执恢复、扫描服务、live 对账器、`OSSTACK_BRIDGE=1` | unresolved | 分支上或未开始（progress.md） |
| N10 | TLA+ 穷举：三个主配置无错，14 个变异全被捉到 | pass | #413 README |
| N10 | 故障注入、变异测试、TLA+ README 列出的覆盖缺口 | unresolved | 未开始 |
| N12 | M-D 沙箱场景录制 | pass | #403 |
| N11 | 宿主 Docker 可用 | unresolved | 外部条件 |
| N13 | Grok 平台能力 U-1…U-11 已核实 | unresolved | 阶段 6 规格 §0；需运营者 |
| N14 | `main-quality` 在主仓库读回与文件一致 | unresolved | 需仓库管理员 |
