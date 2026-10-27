# STATIC DESIGN 终审（候选 9d33811）

## 1. 结论

**PASS_WITH_CONCERNS。剩余 P0 = 0，P1 = 0。** 我另发现 2 个 P2、4 个 P3 的新增或残留问题。它们都不阻塞本次作为冻结规划快照合入，但 C01、C02 应在 `C03.budget_storage` 首个 migration 评审前关闭。

我没有执行任何命令或测试，也没有取回 CI 日志。以下内容来自主持者日志，我没有复核：
- 31/31 单测
- 148 个来源锚点
- Git 等价检查

我只核对了一项：把 `current-evidence.json:88-109` 的 22 行汇总相加，得到 5950 passed / 7 skipped / 0 failed，与 `counts` 一致。这只是算术核对，不证明日志真实，`log_sha256` 在仓库内无法复验。

## 2. B01–B09 处置

| ID | 判定 | 说明 |
|---|---|---|
| B01 | 基本关闭，残留 C01、C04 | `introduces_schema` 与验证器闭包规则（`validate-roadmap.py:131-133`）已落实。缺口是该门槛不绑定目标 schema 版本，且该标记靠作者自报。 |
| B02 | 基本关闭，残留 C02 | effect_id 派生身份、不可恢复的 profile 禁止自动 start、hold 下不迁移的恢复入口都已成文。残留是"现有 operator 合同"这一措辞与 ADR-16 矛盾。 |
| B03 | 关闭 | E02 闭包由验证器强制包含 C06、X01、E01（`validate-roadmap.py:141`）。V02 已按切片拆分，S2 默认集合是 opt-in 的超集（`validate-roadmap.py:137`）。S1/S4/S6 的 opt-in 集合缺失见 C06，是 P3。 |
| B04 | 关闭 | 15 个字段，机器清单与 AT-08 逐字段变异集合由验证器核对（`validate-roadmap.py:143-144`）。`base_head_sha` 与 `delivered_candidate_sha` 已分开。 |
| B05 | 关闭 | 两阶段租约按同一 effect_id 对账。broker 不可用即拒绝准入，释放需认证 owner，schema 纳入 I04 门槛（`X03.broker_storage`）。 |
| B06 | 关闭 | 整数向量、CAS、`effect_id+reservation_id` 单次释放键，以及 unknown 结算的证据要求都已写明（`audit-contracts.json:390-394`）。 |
| B07 | 关闭，残留 C05 | CI 计数、全树等价和快照覆盖都已落实。残留是快照时间戳不一致，以及等价检查没有声明有效期。 |
| B08 | 接受 | 我接受"不实现 achieved 生命周期"的取舍。验证器的相位单调规则已落地（`validate-roadmap.py:134-135`）。残留 C03：host_qualified 相位没有对应的反向规则。 |
| B09 | 关闭 | `external_dependencies` 状态与 R03 前置边已由验证器强制。ADD-072/073/074 只挂在工作包层（`supplemental_work_source_refs`），未挂到 FM-18/FM-20，属追溯颗粒度问题，非阻塞。 |

## 3. 残留可操作问题

### C01 · P2 · `I04.compat_recovery` 不绑定目标 schema，且有启动顺序缺口

位置：
- `delivery-gates.json:57-63`（I04 `requires=[]`，scope 为无参数的 `schema_recovery`）
- `delivery-gates.json:32-40`（C03）
- `delivery-gates.json:137-145`（X03）
- `validate-roadmap.py:131-133`
- `audit-revision.md:79`

反例一（版本绑定）：
1. C03 引入 schema N+1，I04 以 N+1 夹具验收并标记 achieved。
2. S3 的 X03 引入 N+2。
3. X03 的闭包含 `I04.compat_recovery`，验证器 PASS。
4. 但该恢复构建从未理解 N+2。

反例二（循环）：`audit-revision.md:79` 要求恢复构建在"N+1 夹具"上验证，而 N+1 的定义由依赖 I04 的 C03 产生。设计里没有"N+1 schema 规格/夹具冻结"这一前置，也没有 owner。

建议：
- 让 `introduces_schema` 的里程碑声明 `target_schema`。
- 让 I04 的验收回执按 target_schema 参数化，类似 V02 的 `S1:`…`S6:` 前缀。
- 新增一个只含 DDL 规格与夹具的 contract 级里程碑，作为 I04 与 C03/X03 共同的前置。

### C02 · P2 · hold 的处置路径依赖了不存在的"现有 operator 合同"

位置：
- `audit-revision.md:81`（"由现有 operator 合同处置"）
- `runtime-contract-v2.md:203,205`（明确写"没有受支持的 operator 放行通道"）
- `audit-contracts.json:65-69`（AT-09 owners 只有 I04，末句却要求"proof-based operator disposition"）
- `delivery-gates.json:57-63`（I04 不依赖 DEBT02）

问题：处置能力实际由尚未交付的 DEBT02 提供，而 DEBT02 的验收只提到"未知执行义务"（`work-packages.json:570`），没有明说覆盖试点遗留的 `attention_dispatch_holds`。

反例：I04.compat_recovery 以 AT-09 通过为由标记 achieved，但"处置"一步只能靠桩实现。S2 opt-in 之前不会暴露，但 C03 的 migration 会被放行，而已有 hold 的 home 仍无出口。这是 fail-safe，不会造成重发，但与 B02 声称的"已定义出口"不符。

建议：
- 把 `audit-revision.md:81` 改成"待 DEBT02 交付的 operator 合同"。
- AT-09 的 owners 加 DEBT02。
- DEBT02 验收明确列出"处置试点遗留 attention_dispatch_holds"，或另设 owner。

### C03 · P3 · `E01.recoverable_profile` 标为 host_qualified，却不依赖任何资格协议

位置：
- `delivery-gates.json:162-169`（phase `host_qualified`，`requires=[]`）
- `delivery-gates.json:237`（计入 S2_opt_in）
- `validate-roadmap.py:134-135`（只禁止 contract 级依赖 host 级，没有反向规则）

反例：E01 用 fake-adapter 的 CI 测试就能记为"host_qualified"，E02 与 S2 opt-in 随之放行，从未经 R05/V03。这与 ADR-09"CI 不能签发 host_verified"（`runtime-contract-v2.md:111`）冲突，也与 D07/D08 的 host 里程碑要求 V03 不一致。

建议二选一：
- 把 E01 重命名为 `wired`，scope 写 `trusted_local_profile`，并声明"不构成宿主资格"。
- 或增加验证器规则：所有 `host_qualified` 里程碑的闭包必须含 `R05.qualifier_protocol` 与 `V03.host_measurement`。

这一项不得被 V03 受阻所掩盖：V03 受阻只意味着 S2 opt-in 暂时只能基于 wired 级别的可信本地 profile。

### C04 · P3 · `introduces_schema` 靠作者自报，数据层缺失

位置：
- `delivery-gates.json:49-55`（I03.local_proof，`requires=[]`，持久化 CompletionProof 很可能需要新表）
- `delivery-gates.json:73-79`（DEBT02 operator 记录）
- `work-packages.json:481`（X04 outbox/receipt 无对应里程碑）

反例：I03.local_proof 先于 I04 发布 migration，验证器 PASS，因为它没有标记。

建议：把"含 migration 文件的 PR 必须映射到带标记的里程碑"写入 R05/M01 的候选绑定交付记录验收。不要求现在实现。

### C05 · P3 · 快照时间戳不一致，验证器未声明有效期

位置：
- `review-snapshot.json:3`（`observed_at` 为 00:07:44）早于 `board-projection.json:259`（00:09:44）。后者的文件摘要在 `review-snapshot.json:13`，也就是说被哈希的内容里包含一个比快照观察时间更晚的时间。
- `validate-roadmap.py:174-179` 要求当前整棵生产树与 `c1cfccf` 一致。
- `README.md:31` 与 `validation.md:24` 把它描述为通用检查命令，没有说明有效期。

反例：
- 时间戳：`refresh_snapshot`（`test_validate_roadmap.py:53-57`）刷新哈希不更新时间，因此该字段不可信。
- 有效期：main 上的第一个生产代码 PR 合入后，验证器和 `test_current_snapshot_passes` 都会失败。R05 若按原样接入 CI，会立即变红。

建议：
- 删除 `observed_at`，或增加"快照时间不早于内部各 observed_at"的检查。
- 在 README 与 validation.md 各加一句：验证器仅对 `c1cfccf` 的仅 docs 后代有效，之后由 R05 的候选绑定记录取代。

### C06 · P3 · S1/S4/S6 的 opt-in 集合缺失

位置：
- `delivery-gates.json:235-243`（只有 S2、S3、S5_public 三个 opt-in 集合）
- `delivery-gates.json:244-255`（`default_enable_rule` 为六个切片定义了故障里程碑）

问题：规则"所有对应切片的 opt-in 前置"对 S1/S4/S6 没有可引用的集合，也没有 owner。

建议：在 R05 验收中加一句"每个切片发布前必须在 `release_requirements` 登记 opt-in 集合"。不需要现在补全。

## 4. 资格边界（与本设计结论分开）

以下均**不可得**，任何模型意见都不能替代：
- 物理断电
- 恶意同 UID 隔离
- 进程域终止
- 受控 Claude/Codex 故障
- 远端与非默认租户
- 长期运行
- LIVE01 丢诊断根因
- 各 forge 的 sandbox 回执
- 发布通道权限
- tasks-axi/quota-axi 固定版本
- RD-DIV 的人工实现评审

另有两点属于已声明的局限，不构成阻塞：
- 验证器与测试文件本身不在快照哈希范围内，只能检测内部不一致，不能防止作者同时修改验证器。
- planned 状态不能原地升级，这是有意设计，achieved 记录由 R05/M01 交付。

## 5. 一句话

没有剩余阻塞问题。C01 与 C02 是 `C03.budget_storage` 首个 migration 的前置评审项，其余为非阻塞的文字和验证器补强。
