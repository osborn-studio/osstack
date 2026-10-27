# Firstmate 路线图：Sonnet 5.5 审计与挑战

**最终状态：DONE_WITH_CONCERNS。四次实际 Sonnet 5.5 调用完成，最终静态设计结论 PASS_WITH_CONCERNS，P0/P1 均为 0；仍有 3 项 P3 和 1 项信息性建议未关闭，已归入现有工作包。**

日期：2026-10-27（Asia/Shanghai）。对象：PR #271 的升级路线图、24 项能力映射、50 个工作包和证据报告；#270 已合入 main。本次是设计审计及报告修订，不是未来控制器实现或生产资格认证。

实际调用 `/opt/homebrew/bin/claude` 2.1.291，先确认已登录，再探测并使用 **`claude-sonnet-5-5`**，没有换用其他模型。两者均由 CLI 返回的 modelUsage 确认。审查禁用工具、MCP、hooks、slash commands 及会话持久化；材料从文件送入 stdin，未给嵌套模型写代码、运行命令或访问控制面数据库的能力。

第一轮原始结论为 **REVISE_REQUIRED：0 个 P0、7 个 P1、19 个 P2/P3**。模型没有运行测试；它对验证器行为的判断来自读代码。主持者随后复现了五个可绕过检查的负例，并修订设计和验证器。第二轮返回 PASS_WITH_CONCERNS：0 个 P0/P1，另有 6 个 P2 与 3 个 P3。主持者继续修订其设计边界与机器检查；第三轮只复核这些修改。

- [第一轮原文](round1.md)：保留模型原始意见，不用主持者摘要替代。
- [第一轮 CLI 原始结果](round1.json)：实际模型、调用结果与用量。
- [第一轮输入清单](round1-input-manifest.json)：候选、固定来源、输入文件摘要与 prompt SHA-256。
- [修订后的设计约束](../../design/2026-10-26-firstmate-upgrade/audit-revision.md)、[分层门槛](../../design/2026-10-26-firstmate-upgrade/delivery-gates.json)、[反例及差异](../../design/2026-10-26-firstmate-upgrade/audit-contracts.json)。

## 逐项处置（主持者判断，非 Claude 原话）

“采纳”表示设计或文档工具已修改，不表示该未来 feature 已实现。所有 AT 场景和新里程碑仍 planned。

| ID / 优先级 | 处置 | 修改、核对与剩余边界 |
|---|---|---|
| A01 / P1 | 采纳 | 新增 current-evidence：历史报告摘要、五个工程模块摘要、精确 CI 候选。实际 Git 比较 `64daf4af → c1cfccf` 的生产目录无变化；每次验证重查，保留八项本地范围完成。 |
| A02 / P1 | 采纳 | 旧 delivery 保持历史原状；当前 integration 与 CI 单独观察。README 分开列 Linux main CI 与 macOS 历史 smoke；旧全套测试绑定 `844e068` 设计树。 |
| A03 / P1 | 采纳 | delivery-gates 将 local contract 与 host qualification 分开。I01 的局部契约不依赖完整宿主资格；原工作包完整依赖不删除。测试证明局部闭包不含 host_qualified，宿主闭包保留测量要求。 |
| A04 / P1 | 部分采纳 | DEBT02 提前到 S2 并成为 E02/C05 前置；I04 也依赖它。DEBT01 安全失败合同提前，便利性优化不是强制解锁通行证。无法证明静默时合法结果仍是保留 unknown/隔离，不承诺全部可释放。 |
| A05 / P1 | 部分采纳，拒绝具体建议 | 接受“迁移前缺恢复责任”的挑战；I04.compat_recovery 提前。拒绝旧版程序打开新版库及“只读 cancel”：违背 ADR-16，cancel 是写。使用当前 schema 恢复构建、关闭新派发和前向修复。 |
| A06 / P1 | 采纳 | C03 存储/累计预算、C04 开始派发及 typed digest、C06 三类 resolver、E01 profile、I03.local_proof 明确归属；ADR-17 提案补提交/取消/unknown 语义，不新增第二套存储。 |
| A07 / P1 | 采纳 | R05 负责 verifier/签发协议，V03 测量，V06 信任根/撤销及 S0 发布通道；V02 按切片先验收。默认启用门槛显式列出，当前没有任何默认启用资格。 |
| A08 / P2 | 部分采纳 | 固定全部四份原 JSON 清单；补 inventory_only 与结构/来源检查结果区分。本次重放 148 个来源锚点，持续 CI 强制来源验证仍属于 R05，未伪称已经接线。摘要不能防恶意作者同时替换所有信任材料。 |
| A09 / P2 | 采纳 | owner、unblock_condition、missing_evidence；工作清单/状态摘要与看板投影交叉检查。当前 RPC 的正文更新和依赖门禁仍未实现，修订通过版本化评论同步并另存回执。 |
| A10 / P2 | 采纳边界修复 | 限制仓库内相对文件、拒绝逃逸 symlink；源对象必须 40 位 SHA，路径禁止逃逸/选项形状。未声称验证了 Git 命令执行漏洞；只是消除未约束输入。 |
| A11 / P2 | 采纳 | 类型与必填项检查；独立反例 ID；cross_cutting 固定 R/V/M 范围，E03 不能靠移入公共列表掩盖映射缺失。完整运行时 schema 仍由 R01 实现。 |
| A12 / P2 | 采纳 | 提交可执行 unittest 负例；修复前六项中五项失败，修复后扩充验证。测试当前验证器，不能算未来执行器功能通过。 |
| A13 / P2 | 采纳 | X03 增加跨 home 的 host resource broker 与双 home 竞争验收；独立业务数据库不共享物理资源的派发权。 |
| A14 / P2 | 采纳 | PR-ready 释放后返工重新准入，RD-DIV-04 与 AT-06 明确差异。 |
| A15 / P2 | 采纳 | 父子预算 escrow，unknown 子额度不得再次使用；区分可强制准入预算与无法硬约束的 Provider 实际费用。 |
| A16 / P2 | 采纳 | E06 的 Mission 取消逐步骤扇出，不把 committed/unknown 抹成未执行。 |
| A17 / P2 | 部分采纳 | 补读并固定公开承诺/X/贡献追踪/process-event/stow 关键原文；tasks-axi/quota-axi 依赖版本 unresolved 明示。完整来源闭包是 R03/R04 后续交付，不能把清单哈希当行为已认证。 |
| A18 / P2 | 采纳 | 抽取工具隔离、只允许模型端点、结构化输出与独立确定性验证；毒化材料作为规划反例。 |
| A19 / P2 | 采纳 | 新增配对 token、容量重准入、Gerrit 差异和审查记录；原三条冻结 DIV 不改写。记录模型挑战与主持者采纳，不冒充人工审批。 |
| A20 / P2 | 采纳 | X01/I01 接有界 Worker 健康升级、typed 生命周期；X04 接默认空闲及有界重拉。不另增 X09，避免同一职责重复计数。 |
| A21 / P2 | 采纳 | X02/I03 精确 head、缺必需检查拒绝、队列重验、成功回读、独立批准；加入 AT-12。 |
| A22 / P2 | 采纳 | X04 固定受信远端入口、doctor 不自动安装、Aqua/keychain 前提；X07 在移交协议认证前禁止带公开承诺远端 handoff。 |
| A23 / P2 | 部分采纳 | 补出站过滤、额度新鲜度和安全版本探测；现路线图没有实际执行任意 PATH 副本的生产实现，不把该设计风险误报成已证实运行时漏洞。 |
| A24 / P2 | 部分采纳 | V00/V03 在 S0 准备诊断留存，LIVE01 保持环境阻断和原卡关联。没有重跑物理/Provider 故障，也不把本地代码完成撤回为未实现。 |
| A25 / P3 | 部分采纳 | PR 拆分只是建议审查边界，不是 150 个 PR 配额；X05 落点具体化。保留三张债务投影与 canonical_card，不合并或删除历史卡；LIVE01 归 V03，避免重复新增。 |
| A26 / P3 | 采纳 | R03 明确 Git bundle/许可归档、来源维护者及人工候选扫描节奏；未创建自动化，也未声称归档服务已实现。 |

## 本次验证与真实环境边界

验证器负例、固定 Git 对象、历史/当前代码等价、文档链接及原冻结设计由主持者执行。模型仅静态审计。完整生产测试沿用已绑定的原记录；本次没有改生产 packages/scripts/依赖，不把历史全套测试说成本次重新执行。

未验证项继续保留：物理断电、恶意同 UID 隔离、残留进程域停止、受控 Claude 故障、远端和非默认租户、长期运行、LIVE01 丢诊断原因、公开渠道/工具安装支持组合、发布通道权限。模型意见一致也不能证明这些已通过。

## English summary

The actual model was `claude-sonnet-5-5`. Round one returned REVISE_REQUIRED with seven P1 findings. The host verified the claims, fixed the roadmap and validator, and rejected the unsafe suggestion that an old binary could perform a “read-only” cancellation on a newer database. Raw model reports are preserved separately from host dispositions. This review does not certify future features or production environments.

## 第二轮及追加处置

实际模型仍是 `claude-sonnet-5-5`，候选 `ec1cde6caab2e7603dd455b6e87bfdb23227827c`。[第二轮原文](round2.md)、[CLI 结果](round2.json)、[输入清单](round2-input-manifest.json) 完整保留。模型明确同意拒绝“旧二进制只读 cancel”，并认可七项 P1 的设计修订。

| ID | 主持者处置 |
|---|---|
| B01 | introduces_schema 的依赖闭包必须含目标 schema 恢复构建；C03/X03 已关联，补迁移启动失败场景。 |
| B02 | effect_id 派生身份先持久化；不可查询/取消且无容纳域的 profile 禁止自动 start。未知 hold 不绕过升级限制；预置禁迁移恢复入口，证据不足继续隔离。 |
| B03 | E02 补 C06/X01 依赖；V02 分 S1–S6；S2 默认启用集合必须包含全部 opt-in 要求，后续切片累加。 |
| B04 | 机器字段清单及 AT-08 逐字段变异集合一致；补规范化反例，区分 base_head_sha / delivered_candidate_sha。 |
| B05 | broker pending/held/released 与 home intent 按 effect_id 对账；不可用拒绝准入，认证释放，孤儿恢复沿用 DEBT02，schema 受 I04 限制。 |
| B06 | 预算单位向量、CAS、单次释放账本键及 unknown 结算证据明确化；增加重复释放和过期竞争验收。 |
| B07 | 取回 CI check job 原日志，逐包汇总 5,950/7/0；等价范围扩至除 docs/根 README 外全树及未跟踪生产文件；快照覆盖规范文档与看板投影。 |
| B08 | 将 contract→host_qualified 禁止规则移入验证器，增加候选/代码摘要/等价/实际 Git 来源负例。未把冻结规划工具改造成 achieved 签发器：后续 R05/M01 使用独立交付记录，需另行审计和候选证据；当前 planned 不原地改写历史。 |
| B09 | 验证外部依赖 unresolved 状态；E05/X07 加 R03 前置与里程碑，FM-22/X07 关联 ADD-069/070 原文。 |

这些是设计、验证器及证据修改；broker、预算、恢复构建等仍没有作为新生产实现交付。

## 第三轮与收尾修订

候选 `9d33811b50bb2830e274149d9450fac10488171b` 的[第三轮原文](round3.md)结论仍为 **PASS_WITH_CONCERNS，P0/P1 均为 0**；另有 2 项 P2、4 项 P3，模型说明不阻止冻结规划合入。[CLI 结果](round3.json)和[输入清单](round3-input-manifest.json)保留原样。

主持者随后处置 C01–C06：新增只冻结 DDL/夹具的规格里程碑及分别绑定目标 schema 的恢复验收；将“现有 operator 合同”改为“待 DEBT02 交付”，并明确覆盖旧 attention_dispatch_holds；宿主资格必须依赖独立测量；R05 审查 migration diff 与每切片完整 opt-in 集合；删除快照滞后时间戳，并声明本验证器只适用于固定基线的仅文档后代。没有因此宣称新的 operator 接口已经实现。第四次调用只复核这六项收尾修订。

## 最终定向复核与未关闭事项

[第四轮原文](round4.md)对候选 `6dd4a1b016927c3225a765719db111c0b8d23813` 的 C01–C06 修正均未驳回，结论 **PASS_WITH_CONCERNS，P0/P1 为 0**。[CLI 原始结果](round4.json)、[输入清单](round4-input-manifest.json)及[四轮元数据](audit-metadata.json)可核对实际模型和候选。前三轮为广泛审计与复审，第四轮仅定向检查收尾修订，不重复声称整套运行时被复核。

仍未关闭的 [R1–R4](followups.json) 属于现有工作包的设计收尾：

- R1 / P3：DEBT02 需要明确覆盖 broker 孤儿租约的验收。
- R2 / P3：在冻结 DEBT02 合同和首个 C03 migration 前，确定 operator 回执的存储方式，避免与 I04 形成迁移依赖环。
- R3 / P3：后续交付记录验证器须检查 recovery receipt 字段集，并补缺 schema-spec 的负例。
- R4 / 信息性：评估 home/broker 恢复聚合的保守耦合，保持文字与实际宿主资格前置一致。

这些事项没有被标记为已修复，不新增四个 feature，也不提高任何运行时资格。Sonnet 认为它们不阻塞冻结规划合入；R1/R2 必须在对应合同/迁移实施前解决。

本次可执行验证：**34 项验证器测试通过，148 个来源锚点核对通过**；原 24 能力、37 任务、66 场景及 ADR-01–16 保持冻结。[宿主验证记录](final-host-verification.json)、[测试输出](validator-tests-final.log)、[来源输出](source-validation-final.log)独立于模型意见。34 包含正例及负例；另有 43 个行为场景只是 planned。实际 CI check 日志已取回并逐包汇总，原 main 基线为 5,950 passed / 7 skipped / 0 failed；本次没有本地重跑生产全套测试，也没有生产代码改动。PR 最终提交的 CI 状态另以 GitHub 为准。

看板仍为 50 张原卡：38 todo、8 本地范围 done、4 blocked。修订和未关闭事项用版本化评论挂回原卡；当前接口没有原子正文更新，不把评论同步称作已实现 M01。

复现审计材料：每轮 request 文本保留实际审查问题，input-manifest 列出固定提交或宿主观察的路径/摘要，raw JSON 保留完整模型结果。完整输入拼装文件保存在本机审计 scratch 中；仓库未复制数百 KB 的重复上游源码，也未提交认证信息。哈希不是独立签名，审查及回执真实性仍需要 GitHub/测试执行者等外部证据。

Final English verdict: PASS_WITH_CONCERNS, no remaining P0/P1 design blockers. Three P3 follow-ups and one informational note remain open. The four calls used the actual requested model. This is a roadmap review, not proof that Firstmate is fully integrated or qualified for production.
