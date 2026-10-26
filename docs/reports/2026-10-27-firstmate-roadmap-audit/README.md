# Firstmate 路线图：Sonnet 5.5 审计与挑战

日期：2026-10-27（Asia/Shanghai）。对象：PR #271 的升级路线图、24 项能力映射、50 个工作包和证据报告；#270 已合入 main。本次是设计审计及报告修订，不是未来控制器实现或生产资格认证。

实际调用 `/opt/homebrew/bin/claude` 2.1.291，先确认已登录，再探测并使用 **`claude-sonnet-5-5`**，没有换用其他模型。两者均由 CLI 返回的 modelUsage 确认。审查禁用工具、MCP、hooks、slash commands 及会话持久化；材料从文件送入 stdin，未给嵌套模型写代码、运行命令或访问控制面数据库的能力。

第一轮原始结论为 **REVISE_REQUIRED：0 个 P0、7 个 P1、19 个 P2/P3**。模型没有运行测试；它对验证器行为的判断来自读代码。主持者随后复现了五个可绕过检查的负例，并修订设计和验证器。复审结果将在实际返回后追加；当前不预写 PASS。

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
