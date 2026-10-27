# 下一批最小执行切片：独立只读核对

核对旧基线 `8fed83136611948ee068801ab5cc1fd471f90078` 与当前 `origin/main = 28d116f3f8c15f64bebb314308adf320d8380b2b`。读取 Git 对象，不使用工作区未提交文档作为规范。核对结论：**J01/J11 契约、冻结设计与验收要求未因本次 main 推进改变；下一批应先补清门槛/候选证据，同时准备三个互不抢共享文件的切片。不能将已合并 PR 等价为门槛 PASS。**

本报告只提出派发建议。没有修改产品、设计、账本或 PR，没有执行 runtime 验收。对应 JSON 保存实际原始条目、文件摘要和冲突边，可用于主入口复核。

## 1. 增量事实与原始依据

以下路径 `git diff --name-only 8fed8313..28d116f3` 结果为空：

- `packages/protocol/`，包含所有 `joint-*`、`method-binding` 及 R01 `behavior-capability`。
- `packages/core/fixtures/operator-recovery/`。
- `packages/core/src/state/operator-recovery-spec.test.ts`。
- `docs/design/operator-recovery-schema.md`。
- `docs/design/2026-10-27-joint-engineering/` 全目录。

整个提交范围实际改变的是 R02 behavior evaluator、Session cleanup 以及相应文档/证据。它没有补上 Method admission、operator recovery host 或正式 gate 签发。对 `packages/cli/src`、`packages/core/src`、`packages/loop/src` 搜索 `verifyBindingAgainst|trialBudgetIssues|verifyRecoveryProofEnvelopes|RecoveryReceipt|MethodProposal`，仅找到恢复规格测试调用，未找到这些新 Joint helper 的真实运行入口消费者。此检索证明的是这些标识符的接线现状，不声称排除了其他既有安全机制。

原始规范均以 `28d116f3` 为准：

- `docs/design/2026-10-27-joint-engineering/work-packages.json`：J01/J02/J03/J11/J12 的 owner、路径、依赖、阶段。
- 同目录 `execution-gates.json`：124 个阶段节点、schema 单写者队列和 oracle 生命周期。
- 同目录 `acceptance-cases.json`：13 个相关 case 的精确 given/when/then、变异及证据要求。
- 同目录 `unknowns.json`：O03、O06 的明确阻断阶段。
- 同目录 `execution-ledger.json`：历史切片证明，并非最新完整组件验收结果。

`#271` 独立查询为 MERGED，merge commit `ce543535be9b1ef96a8c4fb14d13ea8483444051`，合并于 `2026-10-27T05:45:45Z`。这可作为 O06 的事实输入；还需记录下一候选的接口影响判断，不能只改 O06 状态。

对先前 `subagent-terminal/next-gates.md` 的具体校正：**JA01 原始 when 是“请求 task local_verified”，不是 implementation_verified。** 必须按原词义和实际任务状态机建立映射，不能凭重述换掉验收目标。

## 2. 门槛与真实缺口

| 组件 | 原始门槛 | 不能复用成 PASS 的原因 | 最小新增证据 |
|---|---|---|---|
| J01 | `J01.scoped`：JA01、JA02、JA59 | JA01/JA02 是 integration；所有 oracle 仍 unassigned，缺作者/保管人/安全复核人及冻结摘要；纯 schema 和全仓计数不执行真实完成/admission 入口 | JA01 原 Session 与 task 独立记录、错误完成变异；JA02 原 admission 错 repo/scope 的拒绝和 adapter 调用零；JA59 固定 TS/Python 向量及错域/规范字节反例 |
| J11 | `J11.scoped` 依赖 J01.scoped：JA20、JA47 | 恢复 DDL 与14个规格测试提供实现证据；缺正式 case/oracle/candidate 绑定；O03 未闭环 | JA20 home/broker schema 生产者与迁移闭包、反向依赖变异；JA47 每个 subject variant 的必需字段删除矩阵、精确预期错误 |
| J02 | `J02.scoped` 依赖 J01.scoped：JA03、JA04 | J02a 明确 `dependency_resolution:not_performed`；不是采用闭包或分型注册 | 修改源 blob/采用依赖需重评，未采用项变化不撤销；v1旧规则回归与v2恶意路径/未知字段拒绝，进程/文件观察证明无 hook |
| J03 | `J03.scoped` 依赖 J01.scoped：JA05、JA06、JA44 | 现有发送回执/cleanup 不是命名 driver 与持久动作资源账本 | 原 host receipt 与实际回复；dry-run 文件/DB/进程零变化；相同 key 同输入复用、异输入拒绝、无重复外部动作 |
| J12 | `J12.bootstrap_preflight` 依赖 J11.scoped；`J12.scoped` 再依赖 bootstrap | 内存事务与结构校验不等于文件 WAL/FULL 崩溃、旧写者 fence、迁移前 hold 守卫或操作员授权 | JA52 专用白名单单步迁移故障轨迹；JA21/JA51 精确 subject/owner/generation/proof、CAS 与裁决后态；full recovery 仍另需 J17.recovery |

阶段不能混写：O06 阻 **implementation_start**；O03 阻 **J11.complete / J12.merge**。`execution-gates.json` 把 scoped 节点标为 scoped_acceptance，并没有写成“一切代码编写前必须 scoped PASS”。另一方面 work-package `depends_on` / `entry_gate` 仍须遵守，不能借这个差别自授 merge 或接线权。建议主入口明确派发中的“可写离线候选、禁止资格/启用”边界，并先用新 main + #271 接口核对解决当前切片的 O06。

J01 输出为 opt-in 协议，JA01/JA02 却需要后续运行接线，存在验收粒度和调度的冲突。可选择：

1. 保留现门槛，给 J01 明确补入真实完成/admission 最小接线的 owner/路径，先执行现 JA01/JA02；这会接触 J08/controller 责任，须先确定边界。
2. 提交独立设计修订提案，将纯组件证据与真实集成义务分层。`J01.contracts` 目前不存在，只能作为提案；保留 JA01/JA02 和 release 消费边，经正式审计后才能使用新 gate。

不推荐把 JA01/JA02 换成 schema-only，或在证据未执行时给现 `J01.scoped` 打 PASS。此次报告不选择或实施任何门槛变更。

## 3. 最小可派发切片

以下编号仅是建议任务名，不是新增正式 gate。

| 切片 / owner | 最小工作与写集合 | 现在可做什么 | 产品实施与合入界限 |
|---|---|---|---|
| N0 基线与门槛决议 / integration-owner | 将实际 main/#271、组件粒度决议、owner/候选/oracle 分配记录到独立 checkpoint；若需修门槛，单独 proposal PR 统一修改 work-packages/execution-gates/acceptance 映射及验证器 | 可立即只读核对与形成可审计提案；只由主入口写中央账本/设计 | 未决前不能发新 gate；不能把 frozen JSON 的 planned/not_run 当当前资格 |
| N1 J01 最小闭环 / contract-owner + 独立 verification-owner | 先独立冻结 JA59 向量 oracle 与 JA01/JA02 原入口观测规格；组件 tests 限 `packages/protocol/src/joint-*.test.ts` 与专用 evidence 子目录 | 可立即写 scratch oracle/反例、评估现实现；按真实现状记录未接线 | 补测试/严格 helper 可进入独立候选；若实现真实完成/admission，先扩写路径清单并与 J08/完成入口 owner 协调，不能偷偷归入纯协议 PR |
| N2 J02b-1 离线采用闭包 / source-owner | 建议新 `packages/skill-registry/src/adopted-source-closure.ts` + 邻接测试；输入 inspections + 明确 adopted edges；输出闭包 SourcePin/typed refs；不读取默认 home、不安装、不 active promotion | O06 重新核对后，可准备无运行接线的产品候选与 fixture；同时独立冻结 JA03 预期变化表 | 对每个实际依赖绑定 bytes/repo/commit/subdir/license；缺边/循环/冲突拒绝。不能把 J02a inspection 直接当已资格 SourceSnapshot。J02.scoped/采用发布须满足原门槛或已审核分层决议 |
| N3 J02b-2 v1/v2 分型入口 / source-owner | `packages/skill-registry/src/manifest.ts` + 新 v2 parser/测试；保持 v1 原行为；显式映射 R01 Behavior 来源与 J01 SourcePin，保留两套摘要语义 | N2 确定接口后可做独立产品候选；不得并行抢同 manifest | 此切片不等于 R03/R04 的24+8行为映射验收；若消费 R02 必须选择已审计修复提交而不是仅依赖旧 PR 合并状态 |
| N4 JP-03a Session driver / verification-owner | `scripts/method-control.mjs`、`scripts/lib/method-control-driver.mjs`、`scripts/fixtures/session-answer-receipt.json` 及专用动作/资源记录夹具；所有副作用仅显式隔离 home | 现在可设计动作表、oracle、dry-run/ownership/幂等离线夹具；O06和接口锁定后可实现脚本产品候选 | 首次真实 host 驱动必须读取原 receipt，不用模拟成功替代。若需改 `packages/cli/src/daemon.ts`，回交 Session owner，与 #279 串行。bug-fix driver JP-03b 留后续 |
| N5 J11 规格资格收口 / state-owner + independent verification-owner | 现有 `packages/core/fixtures/operator-recovery/*`、`operator-recovery-spec.test.ts`；JA20 DAG正负例与JA47逐字段矩阵 | 可立即准备/冻结新 oracle 和精确候选；在协议/状态实现未变前复用文件摘要作一致性输入，不复用旧候选签发新资格 | J11 gate/complete 依前置与 O03；如重新 freeze 只能有一个 state-owner 候选。不要一边冻结 schema 一边让 J12 改迁移号 |
| N6 J12-a bootstrap-only / state-owner | 先限定 `db.ts`、`migrations.ts`、`schema.ts`、新 `operator-recovery.ts` 与邻接文件故障测试；只有确需外部 guard 时改 `engineering-upgrade-guard.ts` | 现在可做文件级 crash计划、白名单DDL/旧hold/旧writer夹具预检；不能签发bootstrap资格 | J11 scope/队列确认后可实现独立产品候选；合入必须解决O03、冻结当时实际N→N+1。必须普通openDb迁移前拒hold、专用模式白名单一步、kill前中后旧行不变；不先接命令执行面 |
| N7 J12-b 精确裁决 / state-owner + host-owner | 新 `packages/cli/src/operator-recovery-host.ts`、core recovery/engineering-store/graph-recovery；独立 request/subject CAS 与证明来源校验 | 当前仅规格和反例准备 | 在N6/相应home格式明确后实现；JA21/JA51逐格运行。broker未就绪只能保留明确home-only范围，不能完成J12.full_recovery |

N2/N4 的产品代码准备可以在独立工作树中并行形成 Draft，并保留未满足门槛；不是给原依赖图签发绕行许可。若主入口不接受上述预实施边界，应先完成 N0 决议再启动产品写入。**这里真正能立即推进且不触及任何门槛解释的是 N0/N1/N5 的证据定义与 N2/N4/N6 的纯预检。**

## 4. 最小文件写入冲突图

原 JSON 的路径分配是规划，并非实际 PR diff。例如 J11 写入 `operator-recovery-schema.sql` 的规划路径现已落实为 `packages/core/fixtures/operator-recovery/` 多文件，必须在下一 PR manifest 纠正实际写集合，不能盲用旧规划当锁。

| 冲突资源/路径 | 竞争 owner / 切片 | 最小调度方式 |
|---|---|---|
| `docs/design/2026-10-27-joint-engineering/{execution-ledger.json,execution.md,README.md}` 与冻结设计修订 | 全部 worker 都想报进度；integration-owner 唯一写者 | worker 只交独立 evidence 子目录/patch；主入口一次合并 checkpoint，避免每个功能 PR 带全套中央账本 |
| `packages/protocol/src/joint-*`、实际 public exports、协议 fixture vectors | N1 / N5 使用相同恢复契约，N2要消费SourcePin | contract-owner 独占契约写；N5只测/读，若需改契约交N1；N2先按已冻结接口，避免自行统一R01/J01 codec |
| `packages/skill-registry/src/manifest.ts`、registry exports | N2 / N3，同source-owner | N2先新纯模块，N3再接manifest；共享 exports 最后单次整合，不两分支交替改 |
| `scripts/lib/method-control-driver.mjs` 与资源动作定义 | JP-03a / 后续 JP-03b | 先确定单registry，03b消费；不各建一套driver协议 |
| `packages/cli/src/daemon.ts`、Session lifecycle tests | N4如需 host改动 / #279 terminal-fence | N4默认只消费已有host；缺接口作为独立前置，交Session owner，避免driver PR夹带终态修复 |
| `control_plane_schema`：`db.ts,migrations.ts,schema.ts` | N5/N6；未来J08/J10/J13/J17/J21/J22 | 原 `state-owner-schema-queue`：一次一个候选，最新main分配编号、核谱系、重跑；即使J11只是spec仍占该逻辑资源 |
| `packages/core/src/state/engineering-store.ts` | N7/J12 与 J13 controller-owner | state-owner定持久结构，controller消费；相应迁移合入后再rebase调用方 |

按机器规划计算的全部相关冲突边共14条，保存在 JSON。这里额外指出 public export/中央账本/daemon 的实际集成冲突；它们不全在旧 write_paths 中，正是每个 PR 需要实际 manifest 的原因。

## 5. 推荐派发顺序

主入口先维持 #276 修复证据、#278/#279 收口和真实 forge 状态；不要以增加 PR 数量为目标抢共享文件。随后同时派三条小队列：

1. contract/verification：N0 + N1 的新 oracle、候选定义和 gate粒度提案；主入口裁定后才写正式设计。
2. source/verification：N2 离线闭包规格/夹具 → 独立纯模块候选；另一个 owner 审查“未采用变化不撤销”的反例，随后N3。
3. state/verification：N5 receipt字段/DAG原始验收 → N6 file-backed预检；schema队列只留一名写者。

N4 可在 source 或 state 队列等待依赖时填充执行槽，先脚本及独立home观测，不改daemon。每个交付固定输入SHA、base SHA、实际写集合、测试命令、退出码、原始日志和未满足case，主入口统一判定 Ready。任何 runtime_enabled、完整里程碑完成、default-enable、生产资格仍不得由本调查或纯模块测试推导。
