# Graph / Jev 剩余工作与技术债审计

审计日期：2026-09-21。代码基准：`codex/graph-decision-development`，`e3ce5fd`。
范围：9月21日 Graph executable plan v2 与 Jev decision advisor plan 的增量承诺；不是整个 OSStack 的逐行技术债审计。原方案位于 `/Volumes/AIMATE_WORK/Developer/CodeX/osstack/docs/handoffs/`。本报告以本地源码及交付记录为证，没有重新运行测试、调用付费模型或核验远端发布状态。

## 结论与计数口径

原方案有 **25 个工作包：Graph 20 个（P00–P18，P09拆a/b），Jev 5个**。按整项验收范围保守计算：**2项已实现、9项部分实现、14项尚未交付其计划新增范围，即23项尚未关闭**。这是工作包数量，不是23个同等大小的用户功能，也不能换算成完成百分比。现有旧Graph能力不因新工作包未完成而被算作不存在。

另列 **8组技术债/工程欠账**，其中多项与上述23项重叠，不能相加成31项。X01/X02及通用拓扑等后续探索不计入25项必做队列。

当前用户可用增量主要是 `osstack decision init/advise/status`：支持手选失败描述和候选skill，默认离线只校验，显式live路径已有实现但没有真实Jev质量评测。Graph新能力主要仍是实验底层模块；尚无新的真实多文件写手闭环。

## 原方案逐项核对

状态含义：已实现=本地实现及相关验证已有证据，不代表发布；部分=有实质代码但整项验收未关闭；待交付=本轮未找到该项新增能力的完整交付证据。

| 项目 | 状态 | 已有内容与剩余缺口 |
|---|---|---|
| P00 基线与事实 | 部分 | README与历史fixture已有更新；新版完整基线、支持矩阵及统一关闭记录仍需收口 |
| P01 故障状态锁定 | 部分 | 既有故障套件、调用/apply/evidence进程崩溃测试已有；新增真实applier及全链故障矩阵未完成 |
| P02 历史resolver | 已实现 | 冻结v4 compiler/registry、identity选择、未知版本拒绝、golden与checkpoint验证已有 |
| P03 profile/path/input协议 | 部分 | 严格changeset、路径政策、manifest/binding已有；生产profile认证、live tree/inode及真实token上界证明未完成 |
| P04 invocation/apply账本 | 部分 | 调用账本、apply intent/receipt/quarantine、私有证据存储已有；真实applier接线、未知结果核对及完整预算验收待收口 |
| P05 单次proposal adapter | 部分 | 单次provider client与host调用服务已有；原方案完整host证明及adapter生命周期接线仍欠缺，不按整项完成计 |
| P06 host应用与freeze门 | 待交付 | 缺真实Git多文件applier、物理写入journal、目标树校验及未提交禁止freeze的完整接线 |
| P07 reviewer完整性 | 待交付 | 缺新profile累计跨文件ReviewerInputManifest、上下文不足明确拒绝的端到端证明 |
| P08 M1整合与canary | 待交付 | 新compiler/profile身份、生产注册与三文件daemon闭环尚未交付 |
| P09a M1恢复窗口 | 部分 | apply receipt与quarantine恢复底座已有；真实工作区crash/ACK/清理和证据核对闭环未完成 |
| P09b 恢复扩展 | 待交付 | 新场景registry与epoch/attempt/多代际组合覆盖未交付；旧窄场景恢复仍在 |
| P10 子调用账本泛化 | 待交付 | 当前受约束单次调用尚未扩展到多轮预算与未知结果核算 |
| P11 多轮与工具 | 待交付 | 新版本有界read/list/search、最多三次模型调用尚未交付 |
| P12 语料与离线runner | 待交付 | 新Graph任务冻结语料、独立hidden scorer及离线runner未交付 |
| P13 init/admit | 待交付 | 新配置生成与CAS准入入口未交付；不否认旧Graph已有入口 |
| P14 events/cost RPC | 待交付 | 新鉴权事件分页/follow与observed/charged/outstanding/unknown成本投影未交付 |
| P15 有限预算实测 | 待交付 | 没有新多文件写手的真实成功率、成本与错误ready统计 |
| P16 PR共享底层抽取 | 待交付 | 既有improvement交付不等于新的共享净室/transport抽取已完成 |
| P17 Graph发布store | 待交付 | 新Graph独立publication ledger及lost-ACK核对未交付 |
| P18 deliver入口 | 待交付 | 新Graph draft PR的preview/grant/dispatch/reconcile闭环未交付 |
| J01 契约与标注 | 部分 | 纯契约已有；300例分组拆分、标注rubric、冻结语料与留出集未完成 |
| J02 TypeSafe client | 已实现 | 固定模型、deadline、响应上限、无自动重试、fake transport测试已有；此项不包含模型效果证明 |
| J03 失败分类shadow | 部分 | 独立预算/store、手动失败分类已有；Loop失败完成事件的异步观察接线未完成 |
| J04 skill/失败建议UI | 部分 | CLI建议输出已有；自动候选来源、上下文来源解释及Hermes实际调用链未收口 |
| J05 routing canary | 待交付 | 合格候选重查、task revision CAS、事务性consumed记录及下游收益对照未交付 |

Graph小计：1已实现、6部分、13待交付。Jev小计：1已实现、3部分、1待交付。

## 8组工程欠账

| 编号 | 欠账与证据 | 影响与关闭标准 |
|---|---|---|
| D1 | 生产持久性配置不一致：`packages/core/src/state/db.ts`默认WAL NORMAL，新host要求FULL/EXTRA | 直接接线会被拒；明确配置/连接生命周期，测试现有daemon及性能，不能简单全局改pragma后宣称完成 |
| D2 | `graph-bounded-recovery.ts`、`graph-preparation-recovery.ts`、`graph-stopped-verification-recovery.ts`仍含2/5/7动作数量及部分generation=1约束 | 限制拓扑、重试与epoch扩展；建立带身份/lease/receipt证明的场景规则，不能只把数字换成计划长度 |
| D3 | 已持久化response/terminal的unknown缺可信恢复入口；partial workspace缺完整处置闭环 | 故障后安全阻塞但可能长期无法继续；区分provider结算、物理停止、工作区弃置和预算处置，保留不可变记录 |
| D4 | 私有证据存储没有完整retention/GC/联合备份恢复策略，崩溃临时目录不会自动扫除 | 文件正文占空间且含私有数据；按引用与状态保留，禁止GC删除仍承担去重/核对责任的证据 |
| D5 | Jev sticky lock与unknown hold恢复主要靠人工；费率/模型精确pin缺升级迁移流程 | 运维负担及升级阻塞；旧账本可读、模型/费率版本兼容、可证明的核对流程；不能自动清空hold或删除去重记录 |
| D6 | 测试存在对机器负载敏感的Git/进程集成超时；最近898项是选定范围，非全仓总验收 | 发布前需稳定环境跑规定回归、保留失败原因与范围；性能优化不得缓存过时授权/文件证据或抬高阈值掩盖问题 |
| D7 | 多批handoff的“尚未实现”是当时快照，旧报告P04–P09未实现已被后续部分覆盖 | 容易误判进度；维护单一状态索引，历史报告保留基准SHA和历史性质，不把旧结论当当前事实 |
| D8 | Jev语义复现依赖用户自行保存脱敏输入，store只留摘要和结果；无统一样本来源/标注/重放规范 | 无法仅凭digest复核建议好坏；评测层建立受控脱敏artifact与保留规则，不把全部生产日志自动上传 |

以上并非8个已证实漏洞。D1是接入阻塞，D2是既有实现的扩展债，D3–D5/D8是运维与复现欠账，D6/D7是验证和文档债。新的applier、工具、PR交付属于未开发功能，不借“技术债”名义重复计数。

## 建议的执行顺序与验收

1. **M1接入条件与真实applier（大）**：真实profile/grant/token-bound verifier、lease续期/停机、D1配置；真实Git create/replace/delete，live preimage/inode/大小写别名检查，journal和目标树receipt。每个写入/同步/ACK窗口杀进程，未完成应用永不freeze。
2. **完整review与daemon闭环（大）**：implementation+test+doc三文件任务，累计diff完整进入独立review，隔离tests，合法链才ready；越界、撤销、取消、损坏receipt不得ready。完成P07/P08及最小P09a。
3. **恢复与诊断（大）**：D2/D3、P14及P13最小入口；操作员可理解unknown/held/quarantine并按证据处置。避免先开启功能再补诊断。
4. **Jev独立试点（中，可与Graph并行）**：先语料、标注、规则对照，再脱敏失败shadow；获实际预算与数据范围授权后才live。无key/超时不影响主任务。没有收益就不推进J05。
5. **离线评测与有限实测（中至大）**：P12/P15；逐题报告成功、错误ready、成本、延迟与不确定性。关闭新准入后旧run仍可查询/核对。
6. **产品化交付（大）**：P16–P18，独立发布权限、净室、push/PR lost-ACK与重复caller验证，通过后才考虑真实draft PR试点。
7. **多轮工具（大，按M1数据决定优先级）**：P09b/P10/P11；第二次请求余额不足应零HTTP，第二轮unknown继续hold。不要同时扩拓扑、接新agent框架并做路由自动化。

“大/中”表示依赖和故障矩阵复杂度，不是日历工期承诺。M1真实applier、review和恢复尚未闭环，剩余工作不能描述成只差接几个接口。先以一个三文件真实daemon闭环为下一次可验收交付点。

## 不应当作当前技术债的范围限制

- 无shell、有限文件数/字节、ASCII及隐藏路径限制是当前实验协议边界；突破需新版本和证据。
- unknown不自动重发、quarantine不直接恢复ready、预算不随意释放是安全语义；欠的是可信核对和运维入口。
- X01隔离agentic实验、X02大产物流式优化、K分支/通用IR、Deep Agents/OpenHands整合是后续候选，不是当前必须补齐的缺陷。
- 上下文排序、任务队列/人工接管提示、证据报告助手是Jev用例储备，未作为五PR内独立验收项，不混入25项计数。

## 主要证据

- `docs/guides/decision-advisor.md`：离线不产生预测、手动输入、无Loop自动调用、账本和恢复限制。
- `docs/handoffs/2026-09-21-graph-multifile-foundations.md`：P02/P03及历史兼容测试；后续状态以更新交付为准。
- `docs/handoffs/2026-09-21-graph-invocation-ledger-opus5.md`、`2026-09-21-graph-apply-ledger-opus5.md`：P04底座。
- `docs/handoffs/2026-09-21-graph-changeset-client-fable51.md`、`2026-09-21-graph-changeset-host-fable51.md`：P05实验调用链，明确没有生产注册/真实applier。
- `docs/design/2026-09-21-graph-changeset-host-evidence.md`：真实verifier、GC、unknown恢复、同步策略等待办。
- `packages/cli/src/bin.ts`已懒加载decision命令；生产源文件检索未发现对新`graph-changeset-invocation`服务的接入。

Claude此前限定源码审查没有blocker，不表示上述整体功能完成；历史测试通过数也不表示已经真实调用Jev或发布产品。
