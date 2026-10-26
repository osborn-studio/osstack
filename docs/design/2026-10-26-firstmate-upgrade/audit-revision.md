# 审计修订合同 / Audit revision

日期：2026-10-27（Asia/Shanghai）。状态：待实施的设计约束。依据：Claude Code CLI 实际模型 `claude-sonnet-5-5` 第一轮审计 A01–A26；原文见[审计报告](../../reports/2026-10-27-firstmate-roadmap-audit/README.md)。本文件不是功能交付、人工批准或宿主资格证明。

## 1. 完成证据与历史记录

`current-evidence.json` 将当前本地实现范围绑定到 `c1cfccf18df97fa4b8bc2ed1752071feda9c3670`、CI run 40332791896、五个工程模块摘要及历史报告摘要。历史 `64daf4af` 与当前基线的 `packages/ scripts/ package.json pnpm-lock.yaml` 差异为空；验证器重新检查，而非仅信任声明。真实 Provider 记录仍属于历史候选，不能从代码等价推导跨环境资格。

八项 done 只指 `adopt_session` 的本地实现。D07/D08/V03/V06 的完整验收仍 blocked。中断且丢失诊断的 LIVE01 关联 V03，不能被 done 覆盖。`review-snapshot.json` 是供审查的完整性快照，能够检测不一致修改；作者若同时改代码、所有摘要和证据仍需要独立审查，摘要不是信任根或证明测试真实运行的签名。

`board-receipt.md` 保留初次导入事实；`board-projection.json` 使用稳定 card ID 关联修订，记录是否已写入版本化评论。原卡正文是历史版本。当前 RPC 不支持原子正文更新或依赖门禁；M01 才实现正式接口。三项 DEBT 保留 canonical_card，不能把两个看板的投影计为六项债务。

## 2. 分层依赖与交付顺序

原 `work-items.json` 的依赖仍是整个工作包完成的要求。不能把 D08 本地路径完成当作整个 D08 资格完成。新 `delivery-gates.json` 定义可以单独审查、交付和绑定证据的里程碑：`contract / wired / host_qualified / default_enabled`。所有新里程碑初始为 planned；不能因为继承了老代码就自动置为通过。

- I01.local_contract 只要求 D08.local_journey，后者要求 D07.local_fixture；不依赖远端/物理断电认证。
- D07.host_qualification 要求 V03.host_measurement。V03 的宿主测量里程碑不依赖整个 D08，因而没有“D08 等 V03、V03 等 D08”的语义环。
- C03.budget_storage、C04.start_dispatch、I03.local_proof、I04.compat_recovery、DEBT02.recovery_contract 是 S2 opt-in 前置。DEBT01.safe_failure 要先证明不会错误解锁，其便利性清理优化可后续交付。
- V02.slice_faults 随每个切片交付；V06.release_channel 在 S0 处理。真实环境缺失只阻断相关支持组合，不能阻止纯契约和模拟测试开发，也不能被模拟替代。
- 默认启用前要求 R05 的 verifier/签发协议、V03 的精确支持组合测量、V06 的独立信任根/轮换/撤销操作及相应变异测试。资格必须绑定当前候选、协议、宿主和 adapter，且可撤销。

每个里程碑须在实施 PR 中给出独立范围、依赖证据、候选和回执。当前工具只校验规划图，不执行调度或声明哪些代码可部署。原 50 个工作包保留，不机械扩成 150 个 PR；先合协议/迁移，再并行 adapter，直接面向 main。

## 3. ADR-17 提案：开始执行的身份与相位

这是新的 `goal_dispatch` 设计，尚未实现；不改变已有 Session 答复 continuation 语义。

C03 在现有 engineering store/DDL 中增加版本化 MissionPlan、ExecutorBinding、ActionIntent 与预算 reservation。C04 负责 effect broker；E01 负责 adapter 准入。`start_executor` 经 `proposed → admitted → committed → acknowledged`；无法确认执行结果为 `unknown`，不能回写为未执行。外部调用前先持久化 committed 的唯一 effect 身份并单次消费授权；崩溃后按同一身份对账，不能换 ID 重发。

授权绑定 `actor, tenant, repository_identity, mission_id, mission_revision, plan_revision, binding_generation, candidate_sha, contract_digest, executor_version, method, canonical_typed_parameters, budget_reservation_id, nonce, expiry`。哈希采用带版本/domain separator 的确定性 JSON 编码：只允许 schema 内字段、排序对象键、拒绝重复键/非有限数字，明确 absent 与 null，限制字符串长度并避免隐式数值转换。凭据用受信引用，不把秘密放入可导出摘要。方法及参数 schema 升级即改变 digest。typed service method 不需要构造 shell argv；如 adapter 确实执行子进程，最终固定 argv/env allowlist 也属于宿主核对的 effect 内容。

取消在 action commit 前线性化则不派发；commit 后只能 stop_requested，必须等待精确进程身份的停止/静默证据。Mission 并行取消逐步保存结果；任何 unknown 仍保留预算、资源和对账义务。不能让一个已停步骤抹去其他在执行步骤。

C06 承担 run_approval/run_clarify/contract_approval resolver。回答问题、授权具体副作用、开始执行是不同操作。新输入/人工 steering/候选变化使旧计划与授权失效。不能观测人工 steering 的 adapter 明确不支持，或将观察置为 unknown 并阻断依赖旧观察的自动派发。

S2 profile 必须精确列明用户/租户、仓库身份、允许方法、版本、隔离保证和剩余限制。同用户可信实验不声称抵御恶意同 UID 进程；需要恶意代码隔离的任务只能选择具有相应宿主证据的 profile，否则拒绝自动写入。

## 4. 资源、费用与恢复

X03 的 host resource broker 是共享物理资源的单一租约权威，各 home 的业务 SQLite 仍彼此独立。请求含规范仓库/设备身份、home/owner/binding 代数、资源数量、用途及精确释放证据。失联或 lease 到期不证明工作者停止；存在未知使用者就保留占用。两 home 并发预留一个设备必须只能准入一个。压力、电池和 reserve 信号必须检查新鲜度；停止/撤权使用独立优先通道。

PR-ready 可以释放安全检查点上的资源；返工必须重新准入。与 Firstmate 的“不重新计数”行为差异登记在 RD-DIV-04。worktree 槽位被复用后不能凭旧路径清理，必须核对当前所有者和候选。

C03 管 Mission 累计预算。父级预留后才委派子额度，本地可用余额立即扣减；未确认的子消耗保持预留。重新规划和引擎切换不产生新预算。可强制的调用/时间/预留额度与观察到的模型 token/费用分开；无法约束 Provider 实际费用时，明确 observed/unknown，不能承诺硬费用上限。

DEBT02 在 S2 之前交付操作员恢复合同：受信身份、精确 effect/进程、静默或无副作用证明、处置原因及可重放回执。无法证明时保留隔离并说明下一步证据，不提供“强制解锁并重发”。未知占用可能无限保留，这是安全边界；改进是可观察、可求证的恢复流程。

I04.compat_recovery 在任何新 migration 前验收：当前 schema 的恢复构建可读取/对账并在授权后取消，旧二进制仍拒绝新版库。关闭新派发是行为回退；不是降 schema。备份恢复仅适用于无迁移后外部副作用且所有旧写者已 fenced 的情况；否则保留新库并前向修复。拒绝 A05 提出的旧程序“只读 cancel”，因为取消写入状态。

## 5. 原生材料与新增边界

R03 的扫描分类包括 instruction/skill/hook/runtime/test/configuration/presentation。已固定的 74 个旧锚点不改写；新清单补工程模块及 public-followup、X connector、contributions、process-event 和 stow 原文。`inventory_only` 只是发现目录，不能当行为已证实。`contract_excerpt` 只说明读过契约片段，不表示执行过测试。完整闭包仍由 R03/R04 实现，未读材料明确保留。

上游 tasks-axi 的承诺状态机/原子 move 和 quota-axi 的额度观察没有在此仓库固定实现版本；列为 unresolved。不得虚构版本，不能认证依赖该外部行为的端到端等价性。R03 在未来实现前必须固定依赖或以独立契约明确替代。

抽取进程无工具、MCP、hooks、工作区写能力；网络仅允许声明的模型调用端点，禁止抓取原文内任意 URL。资格签发在另一受信流程。原文含“执行命令/自我认证”的内容只是数据，不能改变权限。毒化 fixture 验证此边界。

R03 保存固定 Git bundle、摘要和许可证，来源维护者每次升级前与每月人工检查差异；本修订没有创建定时任务，也没有自动更新上游。

X01/I01 负责活而无进展的 Worker：进展游标、时间窗、每 episode 一次提醒、有界升级、超限停靠。interrupt/exit/relaunch 是有后置条件的类型化控制操作。X04 子主管空闲时不能自发找任务，有界重拉失败后停靠。

X02/I03 把 forge 身份、精确 head、检查集合、独立批准和 merge queue 纳入完成合同。未出现的必需检查也阻断；成功退出码仍需权威回读，作者不能代替独立审核。S2 先交付 local proof，S5 再扩展 forge/公开承诺。

X04 远端入口仅允许固定受信脚本与编码参数，不暴露通用 exec/write。doctor 检查已安装版本与 Aqua/keychain 等条件，不自动安装。X07 绑定公开承诺的任务，在跨域原子移交未认证前禁止远端 handoff。公开 mention、媒体 URL、配对 token 均不能授予写或发布权限；媒体抓取另有出站目标、重定向、大小和类型限制。

E05/X05 调用路由模型前先执行出站过滤和额度准入。X08 只探测明确允许、身份固定的工具，最小环境、超时及输出限制；不遍历执行任意 PATH 副本。X06 必须保留未决问题，通知失败独立可见且有界重试。

## 6. 验证、保留项与 English summary

新增 AT-01–19 及 FM-01-NEG–FM-24-NEG 是规划场景，全部 planned。它们不是新增 43 条通过测试。验证器的 Python 负例才是本次可执行验证。旧 66 场景仍冻结保留。

V00/V03 在 S0 准备诊断保全与复验协议；LIVE01 的原因未明，不能写成已恢复。物理断电、恶意同 UID 隔离、残留进程域、受控 Claude 故障、远端/非默认租户和长期运行仍单列；本次模型审计不执行这些实验。发布通道权限须按既有保护规则解决。

The revision keeps 50 work packages and separates full-package completion from scoped prerequisite milestones. Before S2, implement cumulative budget storage, typed one-shot dispatch, local completion evidence, safe recovery and schema-compatible recovery builds. Shared host resources need one lease authority; remote budgets need reserved allocations. Historical evidence remains immutable. Planned scenarios, model review, local implementation, host qualification and default activation are separate facts.
