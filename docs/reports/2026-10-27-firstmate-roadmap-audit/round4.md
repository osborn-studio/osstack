# 终审：最终定向关闭检查（候选 6dd4a1b）

**STATIC DESIGN verdict：PASS_WITH_CONCERNS。剩余 P0 = 0，P1 = 0。六项修正均未被我驳回。**

我没有使用工具，也没有执行任何命令。34 项测试、148 个来源锚点和各 digest 都来自宿主日志，我没有复核。`work-packages.json` 我只看到 R05、E01、DEBT02 三项，其余结论只基于所供给的摘录。

## C01–C06 处置

| ID | 判定 | 依据 |
|---|---|---|
| C01 | **关闭** | 依赖链为 `C03/X03.schema_spec`（contract，无前置）→ `I04.recovery_home/broker`（同一 `schema_change_id` 加 `receipt_binding`）→ `I04.compat_recovery` → `C03.budget_storage` / `X03.broker_storage`。图中无环，规格冻结先于恢复构建，恢复构建先于 migration，原先“N+1 夹具由依赖 I04 的 C03 产生”的循环已消除。验证器第 135 和 139 行强制目标 ID 一致，`test_schema_target_cannot_reuse_other_recovery` 覆盖。符号 ID 不是数据库版本，这点文字已明示，我接受。 |
| C02 | **关闭** | 文字改为“待 DEBT02 交付”，并写明当前没有受支持的放行接口，与 ADR-16 一致。AT-09 owners 加入 DEBT02，并禁止用桩。DEBT02 验收明确覆盖 `attention_dispatch_holds`。`I04.recovery_*` 依赖 DEBT02，验证器第 140 行和对应负例都在。 |
| C03 | **关闭** | 验证器第 136–137 行对所有 `host_qualified` 节点（V03 自身除外）要求闭包含 R05 和 V03。E01 现在直接依赖二者，D07/D08 经 V03 间接含 R05。`test_host_qualification_requires_measurement` 覆盖。我选择接受“加验证器规则”，不要求改名 wired。 |
| C04 | **作为设计义务关闭，没有机制** | R05 验收和 §8 规定候选审查必须从实际 migration diff 反查 `introduces_schema` 和冻结规格。验证器不做这件事，但上轮评审已说明不要求现在实现。当前不是安全缺口，其效力取决于未来 R05/M01 是否真的交付。 |
| C05 | **关闭** | `observed_at` 已从快照中删除，快照只靠文件摘要和 Git 候选界定。README、validation.md、audit-revision 三处都有“仅 `c1cfccf` 的仅文档后代有效”的声明。验证器第 183 行的树比较以 `.` 为路径，覆盖根构建配置。 |
| C06 | **作为义务关闭，fail-closed** | JSON 里仍只有 S2、S3、S5 的 opt-in 集合。R05 验收和 §8 规定其余切片发布前必须登记集合，缺集合则拒绝启用。这与上轮建议一致。 |

## 修正引入或残留的具体问题（均为 P3，不阻塞）

**R1. DEBT02 与 broker 恢复的依赖边名不副实。**
- B05 称“孤儿租约恢复纳入 DEBT02”，`I04.recovery_broker` 也依赖 DEBT02。
- 但 DEBT02 的完整条目里，`acceptance_add` 只覆盖未知执行义务和 `attention_dispatch_holds`，`proposed_targets` 只有 `engineering-host.ts` 和 `engineering-store.ts`，没有 broker lease。
- 后果：DEBT02 可以通过，而孤儿 lease 仍没有处置路径。lease 会继续被占用，所以是 fail-safe，但这条依赖边是形式上的。
- 建议：给 DEBT02 验收补充 broker 孤儿租约，或为它另设 owner 和里程碑。

**R2. DEBT02 的存储与 migration 排序未表态。**
- 现在 I04 依赖 DEBT02，而 DEBT02 要保存“可重放回执”和 operator 审计，目标文件是 `engineering-store.ts`。
- 如果这需要新表，它就是一个未标记的 migration，同时又不能依赖 I04（I04 反过来依赖它），形成环。
- 也就是说，C04 的 R05 反查会拦下它，但设计没有给出出路。结果是死锁式的 fail-closed，不会造成放行。
- 建议：在 DEBT02 契约冻结前声明它只复用现有 schema，或把存储拆成带 `schema_spec` 的独立里程碑。

**R3. 验证器覆盖的小缺口。**
- `receipt_binding` 的字段集合只是数据，验证器不检查。
- 第 139 行“恢复缺目标 schema 规格”的规则没有对应负例测试。
- 在规划阶段可接受，但实施前应补。

**R4. 过度耦合与文字对齐（信息性，非缺陷）。**
- `I04.compat_recovery` 同时要求 home 和 broker 恢复，因此 C03 也要等 `X03.schema_spec`。这很保守，只是拖慢进度。
- E01 变为 `host_qualified` 后，S2 opt-in 经闭包就需要 V03 测量，比 audit-revision §2 对 opt-in 与 default 的叙述更严。建议文字对齐，方向是 fail-safe。

## 外部资格限制（本结论均不能替代）

- 34 测试、148 锚点、digest、CI 日志、候选 6dd4a1b 的树身份都未经我复核。
- 验证器和测试文件不在快照哈希范围内，只能发现内部不一致，不能防止作者同时修改它们。
- 实际 schema 编号、DDL 和夹具摘要尚未冻结，`engineering-goal-storage-v1` 和 `host-resource-broker-v1` 仍是符号 ID。
- DEBT02 的 operator 恢复、I04 恢复构建、R05 签发协议、V03 宿主测量和 V06 信任根运维都只是计划，没有交付，新里程碑全部 planned。
- 以下条件均未满足，模型意见不能代替：物理断电、恶意同 UID 隔离、进程域终止、受控 Claude 故障、远端与非默认租户、长期运行、LIVE01 根因、forge sandbox、发布通道权限、tasks-axi/quota-axi 固定版本、RD-DIV 人工评审。

**结论：** 作为冻结规划快照可以合入。建议在 DEBT02 契约冻结和 `C03.budget_storage` 首个 migration 评审之前，先解决 R1 和 R2。
