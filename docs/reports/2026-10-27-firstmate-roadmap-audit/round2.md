# Firstmate→OSStack 路线图第二轮静态审计（Candidate ec1cde6）

## 1. STATIC DESIGN verdict：**PASS_WITH_CONCERNS**

剩余 **P0 = 0，P1 = 0**。P2 共 6 项（B01–B05、B07），P3 共 3 项（B06、B08、B09）。

这是对规划设计的结论，不是对运行时的认证。

- **已交付范围：** 只有 D01–D06、C01、C02 是 `adopt_session` 的本地试点实现，且 `runtime_qualification=false`。
- **仅为设计：** ADR-17、AT-01–19、FM-xx-NEG 和 17 个里程碑全部 planned。
- **我的执行范围：** 我没有执行任何命令。21/21 单测、148 个来源锚点、旧验证器 74 锚点和 git 等价都是主持者日志。来源哈希不证明测试真实执行。

B01–B05 应在 S2 opt-in 门禁评审前关闭，不阻止本路线图作为规划被接受。

## 2. A01–A26 处置

**设计接受，无实质残留（A07、A09、A10、A14、A16、A18、A19、A20、A21、A22、A23、A24、A25、A26）**

- A07：R05 / V03 / V06 的分工与默认启用门槛已写明（`delivery-gates.json:145-151`）。
- A09、A10：owner / unblock / missing_evidence 字段与路径、SHA 约束已落实。
- A14：RD-DIV-04 已登记。
- A16、A20–A22：取消扇出、有界升级、forge 回读、远端受限入口均已成文。
- A18、A23：抽取隔离与出站过滤已成文。
- A19：差异登记已完成；review 字段明说"Human implementation review pending"，诚实。
- A24：诊断保留设为 `V03.diagnostic_retention`；LIVE01 根因仍是外部未知，没有被说成已恢复。
- A25、A26：只作为建议处理，没有强加。

**接受，但残留见 B 项**

| A 项 | 残留 |
|---|---|
| A01、A02 | B07 |
| A03 | B03：里程碑图无环。`I01.local_contract→D08.local_journey→D07.local_fixture` 不含 host_qualified；`D07.host→V03.host_measurement→R05` 无 D08 回路。该性质只靠单测，不在验证器里 |
| A04 | B02 |
| A05 | B01 |
| A06 | B03、B04 |
| A08、A11、A12 | B08 |
| A13 | B05 |
| A15 | B06 |
| A17 | B09 |

**同意主持者拒绝 A05 的"旧二进制只读 cancel"。** cancel 是写操作，旧程序不理解新语义。ADR-16 与以下四处一致、无矛盾：`README.md:153`、`audit-revision.md:49`、`work-packages.json:361`、`audit-contracts.json:66`。

同意 A04 的部分采纳：DEBT01 的便利性清理不是 S2 前置，安全失败合同才是。

## 3. 剩余可操作发现

### B01 · P2 · 引入新 schema 的里程碑没有指向 `I04.compat_recovery` 的边

- **位置：**
  - `delivery-gates.json:33-38`：`C03.budget_storage.requires=[]`
  - `delivery-gates.json:56-62`：`I04.compat_recovery.requires=[]`
  - `delivery-gates.json:146`：`before_new_schema` 只是列表
  - `validate-roadmap.py:129-130`：只检查 ID 存在
  - `work-packages.json:469-470`：X03 新存储不在任何里程碑里
- **反例：**
  - S1 发布 migration 48（Mission 计划、预算表、容量存储），`I04.compat_recovery` 仍 planned，验证器 PASS。
  - `audit-revision.md:49` 的"当前 schema 的恢复构建"含义不明：47 版构建读不了 48，除非早已发布前向读取器。
  - 混合舰队中仍运行 47 旧二进制的 home 照常拒绝 48。
  - migration 自身启动失败时，"关闭新派发 + 前向修复"无从谈起。
- **修复：**
  - 里程碑加 `introduces_schema`，验证器要求其闭包含 `I04.compat_recovery`。
  - 明确恢复构建 = 目标 schema 构建，带派发总开关与读 / 对账 / 授权取消，并在 N+1 夹具库上验证。
  - 增加 migration 前置检查和 migration 失败的恢复用例。

### B02 · P2 · S2 的 unknown 恢复在可信本地 profile 下可能无解

- **位置：**
  - `audit-contracts.json:10`（AT-01）
  - `work-packages.json:271`（E01 profile 字段）
  - `work-packages.json:570`（DEBT02 要静默证据）
  - `audit-revision.md:29,47`
  - `runtime-contract-v2.md:87-89,203-205`
- **反例：**
  - 授权已消费、守护进程在执行器句柄落盘前被杀，Loop 已启动并写 worktree。
  - AT-01 要求"允许安全取消"，但没有句柄就无从取消。
  - 同 UID profile 依 ADR-07 不能证明静默，DEBT02 因此无法处置。
  - ADR-16 的 hold 又阻断托管升级，而 I04 的"前向修复"恰好需要升级。
  - 结果是仓库永久隔离，且没有定义的出口。设计承认可无限保留，但 `I04.compat_recovery` 验收没有"存在 hold 时如何升级"的用例。
- **修复：**
  - 执行器 run id 由 `effect_id` 确定性派生，并在外部调用前持久化。
  - E01 准入 profile 必须声明"按 effect_id 幂等启动 / 查询 / 取消"，或声明宿主容纳域。否则该 profile 不得自动 start。
  - AT-01 拆成"查询可解"和"不可解则隔离且范围有界"两条。
  - `I04.compat_recovery` 增加"存在 hold 时的升级与修复路径"。

### B03 · P2 · 范围里程碑图与完整包图之间的缺口

- **位置：**
  - `work-packages.json:279-281`
  - `audit-revision.md:35`
  - `delivery-gates.json:112-118,147,149`
- **反例：**
  - **缺边：** E02 在完整依赖图上不可达 C06 或 X01。`audit-revision.md:35` 要求 C06 承担三类 resolver、X01 使人工 steering 令旧授权失效，但 E02 完成时两者都不必存在。
  - **单点复用：** `V02.slice_faults` 的 scope 是无类型的 `current_slice`，且只有一个节点。S1 通过一次，就同时满足 S2 opt-in 和后续 default-enable。
  - **清单不累加：** `every_default_enable` 不包含 `S2_opt_in`（C03 / C04 / I03 / I04 / DEBT01-02）。只按该列表计算就绪度，可在缺这些的情况下判定可默认启用。
- **修复：**
  - 加 `C06.start_resolver`、`X01.plan_invalidation` 里程碑，并让 E02 指向它们。
  - V02 里程碑按切片参数化。
  - 默认启用清单定义为 opt-in 清单的超集，验证器检查。

### B04 · P2 · AT-08 少测了 ADR-17 摘要字段，规范只存在于散文

- **位置：**
  - `audit-contracts.json:59`
  - `audit-revision.md:31`
  - `work-packages.json:351`
- **反例：**
  - AT-08 列 9 类变更，ADR-17 绑定 15 个字段。
  - AT-08 缺 `mission_id`、`mission_revision`、`contract_digest`、`executor_version`、`nonce`、`expiry`。
  - 一个摘要里漏掉 `executor_version` 的实现仍能通过 AT-08，授权可跨执行器版本消费，违背 `README.md:153`"进行中任务固定执行器版本"。
  - 规范化负例（重复键、非有限数、absent 与 null）有描述但无任何 AT。
  - `candidate_sha` 在 start 时指起始 HEAD，在完成时指交付候选，术语未分。
- **修复：**
  - 抽出机器可读的字段清单，AT-08 逐字段变异，验证器断言集合相等。
  - 拆为 `base_head_sha` 与 `delivered_candidate_sha`。
  - 增加规范化负例。

### B05 · P2 · host resource broker 的跨存储协议与孤儿租约

- **位置：**
  - `audit-revision.md:41`
  - `work-packages.json:470,570`
  - `audit-contracts.json:41-43`（AT-05）
- **反例：**
  - broker 与 home 的 SQLite 是两个存储，租约获取与 `committed` 无法同事务。
  - 获取租约后、`committed` 前 home 崩溃或被备份回滚，会留下孤儿租约。
  - 设计规定"未知使用者保留占用"，所以设备永久被占。
  - DEBT02 只覆盖 home 内义务，没有 broker 租约的操作员释放路径。
  - 未写 broker 宕机时是否 fail-closed。
  - 同 UID 下 home B 能否释放 home A 的租约也未写。
- **修复：**
  - 定义 `pending→held→released` 状态机和 home 所有权记录。
  - 启动时对账 pending 与 committed。
  - 增加 broker 不可用即拒绝派发、home 身份认证、操作员释放（沿用 DEBT02 证据标准）。
  - AT-05 增加孤儿租约和 broker 宕机用例。
  - broker schema 纳入 I04 兼容范围。

### B06 · P3 · 预算预留的生命周期未测

- **位置：**
  - `audit-contracts.json:31`（AT-04）
  - `work-packages.json:221`
  - `audit-revision.md:45`
- **反例：**
  - `cancelled_before_dispatch` 与授权过期各释放一次，同一预留被释放两次，余额虚增，累计超支。
  - "调用 / 时间 / 预留额度"是向量，换算和扣减单位未定义。
  - "未知子额度不回收"没有说明何时、凭什么解冻，可能永久占用父额度。
- **修复：**
  - 预留状态机 `reserved→committed→settled|released`，以 `effect_id` 做单次释放键。
  - AT-04 增加重复释放、过期与提交竞态、单位向量。
  - 未知子额度只能凭操作员证据解冻。

### B07 · P2 · 证据的候选绑定是组合式的，部分只在散文里

- **位置：**
  - `current-evidence.json:20-26,42-47`
  - `README.md:18`
  - `review-snapshot.json:4-11`
  - `validate-roadmap.py:133,143-147`
- **反例：**
  - CI 记录只有 `conclusion` 和 `headSha`，"5,950 / 7 / 0"只在 README 散文里，机器不持有。
  - README、`audit-revision.md` 和 `board-projection.json` 不在快照哈希范围内，规范性文字可改而不报错。
  - 等价性只比对 `packages scripts package.json pnpm-lock.yaml`。供给材料未显示 tsconfig、pnpm-workspace、vitest 配置等根级配置是否覆盖。若存在且被改动，路径 diff 为空而"等价"仍成立。
  - `git diff` 对工作树不含未跟踪文件。
- **修复：**
  - 把计数和 job 摘要写入 `current-evidence.json`，README 引用它或删去数字。
  - 等价比较范围扩到除 `docs/` 外的整棵树，或列出被排除路径及理由。
  - 快照覆盖规范性文档。

### B08 · P3 · 验证器自身的残余绕过

- **位置：**
  - `validate-roadmap.py:89,124`
  - `test_validate_roadmap.py:132-138`
- **反例：**
  - 所有里程碑和 AT 必须等于 `planned`，没有"已达成"的可表示状态。第一次真实完成就必须修改验证器，而它正是检测虚假完成的控制点。
  - "contract 级闭包不含 host_qualified"只是单测里对数据的断言，不是验证器规则。给 `I01.local_contract` 加一条 `D07.host_qualification` 依赖，CLI 验证器仍 PASS。
  - 没有针对 `current-evidence` 变异、`code_files` 哈希、等价性、`--verify-sources` 的负例测试。
- **修复：**
  - 里程碑加带候选 / 摘要 / 回执的 `achieved` 结构，验证器据此校验。
  - 把相位单调规则移入验证器。
  - 补上述负例。

### B09 · P3 · 外部依赖与新增来源没有进入依赖和追溯

- **位置：**
  - `audit-contracts.json:168-183,184`
  - `work-packages.json:311,514`
  - `capability-map.json:326-338`
- **反例：**
  - tasks-axi / quota-axi 的 `external_dependencies` 验证器从不读取，可被改成 `qualified` 并写入虚构版本而不报错。
  - E05（额度）和 X07（公开承诺）没有指向 R03 的边，依赖未固定也能"完成"。
  - ADD-069/070 只出现在全局 `supplement_source_refs`，FM-22 / X07 的来源映射仍指向 ADD-004 和 ADD-015（后者是 inventory-only）。
- **修复：**
  - 验证器校验 `external_dependencies` 状态。
  - E05、X07 加 R03 里程碑边。
  - 把 ADD-069/070 挂到 FM-22 和 X07。

## 4. 最强的存活反例与外部证据缺口

**最强反例是 B02 与 ADR-16 的叠加。**

1. S2 可信本地 profile 下，守护进程在授权消费与句柄落盘之间被杀。
2. 此时无法取消，也无法证明静默。
3. ADR-16 的 hold 阻断托管升级，而 B01 的"前向修复"恰好依赖升级。
4. 设计目前只有"保留隔离"，没有已验收的出口。

这不会造成不安全的重发，是 fail-safe。但它违背 S2 出口里的"停止 / 恢复"承诺，所以放在 P2 而不是 P1。

**仍不可得的外部证据**
- GitHub CI 40332791896 的实际 headSha 与日志，我没有取回。
- git 等价是主持者执行，不是我执行。
- Linux / macOS 受控 Provider（Claude、Codex）的真实宿主证据。
- 物理断电、进程域终止、同 UID 恶意隔离。
- 远端与非默认租户。
- 各 forge 的 sandbox 合并 / 发布回执。
- 发布通道权限（V06）。
- LIVE01 中断丢诊断的根因。
- tasks-axi / quota-axi 的固定版本。
- 差异登记的人工实现评审。

模型一致意见不能替代上述任何一项。
