# Firstmate→OSStack 路线图静态设计审计

**审计对象**：候选 `76cb3578…`，上游 `af1c6817…`。
**方法**：只读所供材料，未执行任何命令。凡写"验证器行为"之处均来自读代码，未运行。
**范围外**：`pilot-scenarios.json`、`2026-10-25-session-adoption-pilot.md`、恢复回执、OSStack 源码本体未提供。涉及这些的结论标为"待证据"。

## 1. 结论

**REVISE_REQUIRED。这是静态设计结论，不是运行时资格，也不是对未来实现的认证。**

- 无 P0，有 7 个 P1。
- "50 包 / 8 完成 / 4 阻断 / 38 计划"的算术我按两份 JSON 手工点数是一致的。
- 但"8 个范围内完成"没有绑定到当前代码和候选（A01、A02）。
- 依赖图把"硬前置"和"范围资格"混成同一种边，12 个包被环境阻断的 D07/D08 间接卡住（A03）。
- S2 之前缺预算、存储、完成证明、未知义务恢复四个责任人（A04、A06）。
- 迁移不可逆与回滚顺序冲突，发布权限阻断没有早期责任人（A05、A07）。
- 验证器只证明"JSON 自洽"，不证明所报状态（A08–A12）。

## 2. 发现表

状态说明："已证实"表示可由所供文本直接得出；"待证据"表示需外部事实才能定论。

### P1

| ID | 状态 | 文件与已核对行 | 证据与失败场景 | 建议 | 验证 |
|---|---|---|---|---|---|
| A01 | 已证实 | `work-packages.json:76-86`（D01 模式，`scope_profile` L84、`evidence_refs` L85，C01–D06 同形）；`README.md:14,120,141`；`board-receipt.md:7,9-60`；`validate-roadmap.py:60,73-79`；`2026-10-26-session-pilot-delivery.json:5-7,269`；`source-additions.json:188-418` | RD-01 要求当前记录携带 `candidate_sha, evidence_digest, observed_at, qualification`，但 8 个完成项只有 scope 加文件路径。看板回执没有候选。证据报告的候选是 `64daf4af`，与固定 main `c1cfccf` 不同。`engineering.ts`、`engineering-store.ts`、`engineering-ddl.ts`、`engineering-dispatch.ts`、`engineering-host.ts`（README:120）不在 ADD-023..051 锚点里。等价性只靠"不可变恢复回执"，不在本目录。后续改动可让这些文件漂移而"完成"仍显示 PASS。 | 每个完成项加 `delivery_evidence{candidate_sha, 引用文件的 git blob 哈希, evidence_sha256, observed_at, ci_run_ids, qualification}`。把 5 个 engineering 文件锚定到 main。 | `git diff --stat 64daf4af c1cfccf -- <5 文件>` 为空，或重跑 live 证据。验证器负例：换证据文件内容、改 blob 哈希，都必须失败。 |
| A02 | 已证实 | `delivery.json:7,206,359-366,369`；`debt.md:86`；`README.md:14,18`；`validation.md:14` | `evidence_refs` 指向的快照写着 `integrated_into_main:false`、`all_layers_integrated:false`、#266 为 Draft OPEN。README:14 写"#266 已合入"。README:18 把"13 项冒烟自测"（delivery.json:206，属 `64daf4af`/macOS）放进讲 main CI 的句子。validation.md:14 的 5,952/5 没有 SHA。按完成项跟随引用的读者或自动化看到的是相反事实。 | 把 `historical_ref` 与 `current_ref` 分字段。新增带 SHA 的当前观察文件。每个数字标 SHA + runner。 | 验证器拒绝"所引报告 integration 字段与所报状态矛盾且未标 `historical:true`"。`gh run view 40332791896 --json headSha` 对上 `c1cfccf`。 |
| A03 | 已证实 | `work-items.json:131-139,280-289,342-352`；`work-packages.json:142-165,350-359`；`README.md:169,195,203` | I01 硬依赖 D08（partial_blocked）。因此 I01–I04、X04、X06、X07、V02–V06 共 12 个包（占 24%）按边都不可启动。README:169 只在散文里说"对应范围证据满足对应依赖"，JSON 没有该语义，M01 也承认没有依赖门禁（README:203）。另有语义环：D07 的验收包含 WD-28/43 等真实宿主证据（L152），而这类证据正是 V03（S6）的产出，V03 又依赖 D08→D07。验证器只查边环，看不到这个环。 | 依赖改为类型化边 `{id, needs: contract\|wired\|host_qualified\|default_enabled, scope}`。把 D07 拆为 D07a（本地，已完成）和 D07b（真实宿主 WD 集，并入 V03，并不再作为 I01 前置）。 | 验证器按范围算"可启动集"。测试：D07b 不可用时 I01 在 `contract` 级仍可启动，在 `host_qualified` 级不可。 |
| A04 | 已证实 | `work-packages.json:246,264,488-516`（DEBT02 slice=S4 在 L501）；`capability-map.json:198`；`runtime-contract-v2.md:203-205` | 全图只有 E04→DEBT03 一条 DEBT 边。DEBT01、DEBT02 无人依赖，FM-14 只把它们当覆盖。S2（E02 controller_once）会产生新的未知义务和仓库锁。ADR-16 规定未知 hold 无限期阻断升级且没有受支持放行通道。DEBT02 排到 S4。场景：S2 在授权消费与执行器句柄之间崩溃，用户仓库被锁，只有手改库一条路。 | DEBT02 设为 E02、C05 的硬前置，也作为 I04 前置。DEBT01 设为 E02 的前置。 | 故障注入：在"授权消费"与"句柄落盘"之间 kill -9。断言：状态为 unknown、仓库锁保留、cancel 可达、操作员凭精确身份可恢复且不重发。 |
| A05 | 已证实 | `runtime-contract-v2.md:201-203`；`README.md:118,151,165`；`work-packages.json:408-417`（X03 目标为新存储文件） | ADR-16：schema 47 之后旧二进制拒绝打开，npm 回退"不是受支持回退"。README:151 却写"兼容读取先上线"，没有任何包交付。S1（影子）的 C03/C04/X03 已需要新 migration，回滚演练在 S6（I04）。一个坏的 S1/S2 发布无法降级。 | 在 S1 之前插一个"N-1 读 N"兼容读取发布，加 migration 台账 `min_compatible_binary`。影子数据放加性表且默认关闭。 | 矩阵测试：旧二进制打开 N+1 库时，只读 status、query、cancel 可用，所有写被拒，提示明确。 |
| A06 | 已证实 | `README.md:91,120,143,161`；`design.md:113-123,151,201`；`runtime-contract-v2.md:19,121-125,134`；`work-packages.json:188-196,269-277,305-313` | S2 缺 5 类责任人：(i) Mission 级累计预算账本，README:91 只陈述策略，首次出现在 E05（S3）；(ii) MissionPlan/ExecutorBinding/ActionIntent 的存储，C03 是纯状态机，README:120 又禁止第二套存储；(iii) goal_dispatch 的 CompletionProof，归属 I03（S5）；(iv) ADR-05/11 的 dispatch phase 只针对"答复续跑"（ADR-11 L134），没有 `start_executor` 的定义；(v) ADR-02 要"精确 argv/effect digest"（L19），RD-02 又禁止拼 CLI（README:143），没有 typed effect digest 的定义。此外 `run_approval/run_clarify/contract_approval` 的 resolver（design.md:123）在试点后无包。"限定可信本地 profile"（README:161）也无定义，而 design.md:201 要求写模式有隔离。 | 新增 C08（预算账本）、C09（plan/binding/intent 存储与 migration）、ADR-17（start_executor 派发相位与 effect digest）、`trusted_local_profile`（签名的仓库标识 + envelope 白名单）。补三类决定的 resolver 包。 | 见第 6 节 T1、T2、T4、T8。 |
| A07 | 已证实 | `README.md:18,167,197`；`runtime-contract-v2.md:105-115`；`work-packages.json:40-48,341-349,350-359,378-387`；`validation.md:36` | 每个切片声称"限定支持组合默认启用"，但资格签发只有 R02（只读加载器，S0）。ADR-09 的 CI verifier、host qualifier、信任根运维没有任何包。V02（变异与故障注入）排在 S6，晚于所有带权限的切片。V06 的 Actions 权限阻断没有 S6 之前的责任人，S1 合入后无法发布。 | 加 REL0（发布通道修复，S0）和 QUAL0（签发流水线与信任根，默认启用前）。V02 改为每切片增量，入切片出口。 | 切片出口清单：缺 REL0、QUAL0、本切片 V02 子集则不得宣称默认启用。 |

### P2

| ID | 状态 | 文件与已核对行 | 证据与失败场景 | 建议 | 验证 |
|---|---|---|---|---|---|
| A08 | 已证实 | `validate-roadmap.py:41,50-51,95-96,97-109,111-117`；`capability-map.json:6`；`source-additions.json:109-179,420-515` | 只钉了 plan 与 registry 的哈希（L50-51）。`sources.json` 未钉，且来源的 path 与 sha256 可同时改：改 SRC-004 的 path 并配套 hash，`--verify-sources` 仍 PASS。该开关默认关，关时仍打印 `result: PASS`。方向只查"能力→来源"，不查来源孤儿：ADD-013、018、019、020、052–063 共 16 个锚点（含全部 12 个上游测试）未被任何 FM/X 引用。 | 钉 `sources.json` 与 `semantic-divergences.json` 的 sha256。CI 强制 `--verify-sources`。孤儿检查：来源必须被引用，或标 `inventory_only`。 | 负例：改 SRC path+hash 失败；新增未引用 ADD 失败。 |
| A09 | 已证实 | `validate-roadmap.py:60,73,76-77,117`；`board-receipt.md:5,7`；`README.md:20`；`implementation-plan.md:77`；`README.md:195` | 完成集合硬编码在验证器里。blocked 与 planned 的数量、"4 个阻断"、看板回执从未被读取。`work-packages.json` 一改，回执的 manifest 哈希静默过期。继承规则"blocked 必须有责任人和解除条件"只被检查为"blocker 字符串非空"，条目没有 owner 字段。D08 在依赖 V00 仍 planned 时是 partial_blocked，也没有"完成⇒依赖完成"规则。 | 加 `owner`、`unblock_condition`、`missing_evidence` 字段。断言计数。重算 work-packages 的 sha256 并与回执比对。 | 负例：D07 改 planned、改 JSON 不改回执、blocker 无 owner，都应失败。 |
| A10 | 已证实（读码，未执行） | `validate-roadmap.py:48-49,78-79,95,115` | `HERE / ref` 接受绝对路径和 `..`，也跟随 symlink（`evidence_refs`、`base_plan`、`manifests`）。`git show f"{commit}:{path}"` 不校验 commit 格式，也没有 `--`。以 `-` 开头的 commit（如 `--output=…`）可能被 git 当选项（待实验确认）。边界：输入是仓库内容，暴露面是对不可信 PR 跑 `--verify-sources` 的 CI。 | `resolve()` 后要求在仓库根内，拒绝 symlink。`commit` 必须匹配 `^[0-9a-f]{40}$`。 | 负例夹具：绝对路径、`..`、`--output=/tmp/x`。 |
| A11 | 已证实 | `validate-roadmap.py:67-69,97,106-109`；`capability-map.json:7,20`；`README.md:183` | 形状只做真值检查，没有类型。`negative_cases` 是自由文本，没有场景 ID，而 README:183 承诺 R04 会生成。覆盖只检查"存在映射"：`cross_cutting_work` 预先覆盖 14 个包，把 FM-x 随意映射到 X08 也 PASS。 | JSON Schema 加类型。每个负例带 `scenario_ids`。校验每个 FM 至少有 1 个旅程和 1 个场景。 | 负例：空 trigger、无关映射、未知场景 ID。 |
| A12 | 已证实 | `validation.md:9`；`README.md:22-27` | 声称"五种变异均被拒绝"，目录里没有夹具、测试或 CI 接线，无法复现。 | 提交 `fixtures/negative/*.json` 与 `test_validate_roadmap.py`。CI 用 `python3 -I` 运行。 | 在干净 checkout 上全部负例为 FAIL，基线为 PASS。 |
| A13 | 已证实 | `README.md:149`；`work-packages.json:408-417`；`firstmate bin/fm-project-capacity-lib.sh:19-22,38-59,61-68` | 上游对同机所有本地 home 按同一仓库锁路径计占位，配置在 root home，并在发布记录前持锁。OSStack 的 X03 存储是单 home 的 `engineering-capacity.ts`，RD-05 又禁止共享库。同机两个 home 各自预留同一设备，会超卖。 | 增加机器级租约（仓库/设备标识键，flock 目录），X03 验收加双 home 用例。 | 两个独立 home 的 daemon 同时预留，第 N+1 个必须延后。 |
| A14 | 已证实 | `firstmate bin/fm-project-capacity-lib.sh:48-51`；`work-packages.json:415`；`semantic-divergences.json:6-70`；`README.md:147` | 上游 PR-ready 释放占位，且"回到工作后不再计数"，这是已知超卖。X03 同时要求"PR-ready 让位"与"无超卖"，且没有登记差异。 | 恢复工作时重新准入，或保留占位至合并。登记 DIV-04。 | 测试：PR-ready 后让位，评审返工，重新准入失败时必须排队而非超额。 |
| A15 | 已证实 | `work-packages.json:425`；`README.md:91,149`；`runtime-contract-v2.md:123` | X04 要求 charter 固定预算并"继承剩余额度"，但没有托管预留。父级把剩余额度委托给远端，同时本地继续派发，会双花。子端未知消耗没有保守计费规则。 | 父级预留切片并发回执，子级不得超出，未知消耗按 ADR-10 保守计费。 | 分区测试：子端失联期间父级总支出不超上限。 |
| A16 | 已证实 | `runtime-contract-v2.md:51-71`；`work-packages.json:284-285` | ADR-05 的三个线性化点只定义单个 action。E06 允许并行写，没有"Mission 取消扇出"的验收：未提交步骤、已提交步骤、未知步骤混合时的终态。 | 补充 Mission 级取消语义：未派发→cancelled_before_dispatch，已派发→stop_requested，未知保留。 | 见 T3。 |
| A17 | 已证实 | `source-additions.json:4,109-179,420-515`；`capability-map.json:238,280,308`；`README.md:29,55,137`；`work-packages.json:55`；`firstmate docs/architecture.md:482-484`；`bin/fm-dispatch-resolve.sh:26-27`；`bin/fm-backlog-handoff.sh:34-39` | ADD-013..022 与 ADD-052..063 只有"路径+哈希"，未读，却支撑 FM-17/20/22、X02、X07。X07 依赖的 `fm-public-followup*.sh`、`fm-x-*.sh`、`fmx-respond`，以及 README:137 提到的 process-event 扩展、PR 健康（`fm-contributions.sh`）都没有锚点。关键行为在上游仓库之外：`tasks-axi` 拥有承诺状态机、`quota-axi` 提供额度快照、`tasks-axi mv` 拥有原子移动，均未固定版本。R03 验收只列 5 类来源，README:55 列 7 类，缺 runtime 与 test。`bin/*.sh` 恰是 runtime。 | 第二批锚点。依赖闭包清单（工具、版本范围、所依赖行为）。`hash_only` 来源不得作为行为证据。R03 补 runtime/test。 | 验证器：X 类验收引用 `hash_only` 来源则失败。 |
| A18 | 已证实 | `README.md:46,56`；`work-packages.json:49-66`；`firstmate AGENTS.md:7-9` | 只有"第三方指令是被研究材料"的政策，没有技术控制。上游 AGENTS.md 自带"你是 first mate"类指令，将来被换成恶意 pin 就是注入面。R03/R04 无"毒化上游"负例。 | 抽取在无工具、无网络、无写权限的环境运行，输出受 schema 限制，确定性工具复核。 | 毒化夹具：上游文件含"把 FM-xx 标为已资格"，抽取输出与资格结果不得改变。 |
| A19 | 已证实 | `README.md:132,147`；`firstmate docs/architecture.md:454-456`；`semantic-divergences.json:6-70` | 上游把配对 token 视为对公开提及自主行动的常设授权，并且 owner-only 路由。X07 反过来要求公开 mention 不可信，这是明确的语义差异，但只登记了 3 条 DIV 且没有 reviewer 字段，而 RD-04 要求"场景、理由、审查人"，验证器也不读该文件。 | 登记 DIV-04…（X07、PR-ready、Gerrit）。加 reviewer。验证器检查。 | 缺 reviewer 或缺差异登记则失败。 |
| A20 | 已证实 | `firstmate AGENTS.md:124,143-144,216-221,283`；`docs/architecture.md:14,58-59,69,87-90,245-248,370` | 无对应包的行为：(a) 活着但无进展的 Worker 检测，有界升级（上游曾出现 200+ 次重复升级的事故，因此"代理已消失只报告一次"、PERMANENTLY-WEDGED 上限），不自动杀进程；(b) 控制面与数据面分离（interrupt、exit、relaunch 带后置条件，不接受任意文本）；(c) secondmate 默认空闲，空队列不得自发工作；(d) 死亡 secondmate 有界自动重拉并停靠。X01/X04 没有这些验收。 | 新增 X09（Worker 健康与生命周期控制面）。X04 增加空闲默认与重拉次数上限。 | 见 T13、T14。 |
| A21 | 已证实 | `firstmate docs/architecture.md:415-421,430`；`AGENTS.md:244`；`work-packages.json:305-313,405-406` | I03 与 X02 的验收没有：合并绑定已验证 head、"从未上报的必需检查"按失败而非"缺席"处理、auto-merge 与队列、forge 命令退出码不可信而以回读为准（上游 Forgejo 路径明说其 exit 会把 HTTP 失败报成功）。"实施者不得回答自己的 finding"也未列为负例。 | 加入这些验收。 | 见 T12。 |
| A22 | 已证实 | `firstmate docs/remote-secondmates.md:59-60,273-276,406-409,602-609,680-683`；`bin/fm-backlog-handoff.sh:22-24,327-351`；`work-packages.json:425-426,455` | 远端边界缺：入口只接受编码 argv 的受信脚本，无通用远端执行/写入面；readiness doctor 与"绝不自动安装"；macOS Aqua 会话/钥匙串前提；公开回复承诺同文件系统，远端路由不能承载；移交已绑定公开承诺的任务会使绑定过期。X04 与 X07 都在 S5，却没有"带承诺的任务不得移交远端"的规则。 | 加入这些验收与禁止项。 | 见 T15。 |
| A23 | 已证实 | `firstmate bin/fm-dispatch-resolve.sh:16-34,36-44`；`bin/fm-tool-update-check.sh:29-36,414-418`；`work-packages.json:273-277,435,465-466` | 路由器会把任务文本发给外部服务，上游有 never-send 清单和额度/runway 门槛；E05/X05 没有出站过滤与额度输入。X08 复制"对 PATH 上每个副本执行 `--version`"，等于执行任意 PATH 二进制，没有环境与沙箱约束。 | E05 加出站过滤与额度准入。X08 的探测在最小环境和超时内运行，并排除可写目录。 | 见 T16。 |
| A24 | 已证实 | `delivery.json:157`；`debt.md:34,46`；`work-packages.json:357` | 一次真实试验在 `needs_reconciliation` 被中止，诊断丢失，原因未知。D04/D06 仍记为 `local_pilot_complete`。追查被放进 S6 的 V03，而 V03 受 D08 阻断。 | S0 加 DIAG01：带诊断留存的重跑。 | 重跑并保留源状态；原因明确或被标为不可复现。 |

### P3

| ID | 状态 | 文件与已核对行 | 证据 | 建议 |
|---|---|---|---|---|
| A25 | 已证实 | `README.md:118`；`work-packages.json:434`；`board-receipt.md:7`；`delivery.json:53-70`；`docs/plans/…session-pilot-debt.md:21` | 每包拆 a/b/c，50 包约 150 个 PR，与"每 PR ≤5 个主要文件"并存。X05 目标是目录 `packages/agents/src`。DEBT01–03 在两个看板各有一张卡，卡号不同。LIVE01 不在这 50 个包里。 | 目标必须是具体文件，验证器检查存在。合并债务卡。把 LIVE01 并入 D07b/V03。 |
| A26 | 已证实 | `README.md:13,61`；`validate-roadmap.py:111-116`；`source-additions.json:4` | 来源复现依赖本地克隆里还存在该 commit，没有归档 bundle。没有上游变更检测节奏或负责人。 | R03 增加 `git bundle` 归档与每月候选扫描。 |

## 3. 覆盖挑战

映射存在不等于已实现。24 项中除下列外，没有发现超出上述发现的新孔。

| FM | 实际缺口 |
|---|---|
| FM-04/08/09 | goal_dispatch 的 `run_approval/run_clarify/contract_approval` resolver 无包（A06）。 |
| FM-05/07 | 活着但无进展的 Worker 检测与有界升级（A20）。 |
| FM-10/11 | 通知投递自身失败的主动告警缺失（上游 `architecture.md:239`）。 |
| FM-13 | CompletionProof 在 S5（A06）；合并守卫（A21）。 |
| FM-14 | worktree 槽位被他任务复用时的归属证明（上游 `architecture.md:445`）未映射。 |
| FM-15/21 | 出站过滤、额度准入（A23）。 |
| FM-16 | 控制面与数据面（A20）。 |
| FM-17 | A22。 |
| FM-18/20 | 扩展绑定与 stow 记忆文档只有哈希（A17）。 |
| FM-22/23 | 与上游授权语义不同未登记（A19）；forge 应为确认事实而非推断（上游 `architecture.md:405`），X02 未写。 |

**X01–X08**

| X | 缺口 |
|---|---|
| X01 | 用户直接在 Worker 终端里输入的检测方式未定义。没有检测能力的 adapter 应降级为 unknown 并使计划失效。 |
| X02 | 合并成功以回读为准（A21）。 |
| X03 | A13、A14；上游 reserve 标志、电池、压力信标过期规则未映射。 |
| X04 | A15、A20、A22。 |
| X05 | A23。 |
| X06 | 通知失败告警；Calm 的长度启发式不得影响待决问题（J04 已有负例，需落成 fixture）。 |
| X07 | A19、A22；上游"媒体 URL 由响应代理抓取"的注入面未处理。 |
| X08 | A23。 |

## 4. 已被现有文本覆盖或有争议的关切

- **未知投递不得重发**：已由 ADR-04、05、06、11 与 README:89 覆盖，我不再重复提出。DEBT03 另管"已应用回执被清理失败覆盖"。
- **away 扩权**：DIV-03（semantic-divergences.json）与 RD-04（README:147）。
- **可复制的 doorbell 字符串**：RD-03（README:145）已拒绝。上游自己承认该缺陷（`fm-operational-input.sh:22-26`）。
- **注册表不能授权**：design.md §8 与 README §4。
- **哈希不是语义认证**：source-additions.json:4、validation.md:11,30、README:29 已明说。我的 A08 针对的是"自证"，不是这条边界。
- **看板无依赖门禁**：README:203 已披露，A09/A03 针对的是它缺少替代。
- **模型审查未复跑**：validation.md:17 已诚实披露。
- **Calm 不是兼容义务**：README:135 已声明。

## 5. 最强反例

1. **S2 崩溃留下永久锁。** E02 消费一次性授权后，在拿到执行器句柄前进程被 kill。结果是 unknown 义务、仓库锁保留。DEBT02 在 S4，ADR-16 又规定升级被无限期阻断。用户只能手改库。
2. **两个 home 超卖同一设备。** 同机 home A、B 各有一个 X03 存储，都预留了唯一的测试设备，都准入。上游靠共享锁避免，本路线图 RD-05 禁止共享库且没有机器级租约。
3. **PR-ready 让位后返工超额。** Worker 提 PR 后释放占位，评审要求修改，Worker 恢复写入，此时占位已被其他任务占满。上游文档承认"不再计数"（`fm-project-capacity-lib.sh:50-51`），X03 却同时承诺无超卖。
4. **远端预算双花。** 父级把剩余额度 B 委托给远端子主管，同时本地继续派发。子端断线，其消耗未知，父级用同一 B 继续花。
5. **验证器放行假来源。** 改 SRC-004 的 path 与 sha256 为另一个真实 blob，再把 `evidence_refs` 指向仓库里任意存在的文件，`--verify-sources` 与默认模式都 PASS。

## 6. 缺失的验收测试

- **T1** 在 controller_once 授权消费与执行器句柄落盘之间 kill -9：无二次派发，锁保留，cancel 可达。
- **T2** start_executor 与 cancel 的竞争：cancel 先则不启动。派发先则报告 stop_requested 且保留 unknown，不得写"未执行"。
- **T3** Mission 取消扇出：N 个并行步骤分处未派发、已派发、未知三态，终态按步骤分别保留。
- **T4** 重规划、引擎切换、子任务、远端委托合计不超累计上限。未知费用按保守价计入。
- **T5** 双 home 同机设备预留。
- **T6** PR-ready 让位后返工，重新准入。
- **T7** 父子崩溃与乱序下，同一步骤不双派发。依赖集部分移交。
- **T8** 授权后改动服务调用参数，effect digest 不匹配则拒绝。
- **T9** 旧二进制打开新库：只读可用，写被拒。
- **T10** 验证器负例集：换证据、换 SRC path+hash、绝对路径与 `--output=`、blocked 无 owner、完成项依赖未完成、回执过期、无关映射。
- **T11** 毒化上游夹具。
- **T12** 合并：green 后 head 变化则拒绝。必需检查从未上报则拒绝。forge exit 为 0 但回读不是 merged 则不算落地。
- **T13** Worker 存活但长时间无进展：告警数有上限，之后只剩一个终态，不自动杀进程。代理消失只报告一次。
- **T14** secondmate 空队列时零自发工作。
- **T15** 伪造 mention、重放、媒体 URL 注入。带公开承诺的任务不得移交远端。
- **T16** 路由出站过滤命中则不发送。PATH 探测在最小环境与超时内执行。
- **T17** DIAG01 重跑并保留诊断。

## 7. 建议实施顺序

当前顺序在 S0 之后直接进入带权限的切片，不安全。建议：

1. **S0a** A01–A03、A08–A12（证据绑定与验证器加固）。同时做 REL0、DIAG01、第二批来源锚点。
2. **S0b** N-1 读 N 的兼容读取发布，加 migration 台账。
3. **S1** 影子主控：C03/C04/C06/X05、C08（预算账本）、C09（plan/binding/intent 存储）、机器级容量租约（X03）、DEBT02 的契约。每个切片带 V02 增量子集。
4. **S2** ADR-17、E01/E02/E04/X02、DEBT01/03、`trusted_local_profile`、最小 CompletionProof、C05。仅显式 opt-in。
5. **QUAL0** 之后才允许任何"默认启用"。
6. S3 起顺序同原计划，但 X09 与 A15、A22 的补充验收须在 X04/X07 之前就位。

**可选增强（不阻塞）**：A25、A26，Calm 的展示细节，上游既有报告复用以省成本，tmux/Herdr 视图。

## 8. 仍需外部证据

- `64daf4af` 与 `c1cfccf` 在 5 个 engineering 文件上的树等价证明，或在 main 上重跑 live 证据。
- 固定模型与版本的 Codex、Claude 真实宿主证据（Linux 与 macOS 各一）。
- 进程域终止、物理断电、恶意同 UID 隔离的实测。
- 非默认租户与远端宿主的实测。
- GitHub、GitLab、Gerrit、Forgejo 各自沙箱的合并与发布回执。
- `CI 40332791896` 的 headSha。
- 新验证器在干净 checkout 的负例运行记录。
- 独立用户对照实验（V00/V04）。

## 9. 本审计的局限

- 没有执行任何代码，包括验证器。A10 的 `--output` 注入是读码推断，未经实验。
- 我没有读到 `pilot-scenarios.json`、`session-adoption-pilot.md`、恢复回执、`sources.json` 的全部内容之外的材料，所以对"main 上 engineering-*.ts 是否与 `64daf4af` 一致"无法下结论，只能说它没有被绑定。
- 上游只读了所供的 12 份摘录，关于上游其余部分的行为我不作判断。