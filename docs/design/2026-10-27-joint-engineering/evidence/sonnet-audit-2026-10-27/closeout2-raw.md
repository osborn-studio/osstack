CLOSEOUT_BEGIN

**判定：PASS_WITH_CONCERNS**

CO01–CO10 的主体矛盾已关闭。本轮没有发现阻止 J01/J11/J12 开工的硬矛盾，只有 3 处需要继续小改的文档级缺陷。我未运行任何命令，只依据输入文本判断。

## CO01–CO10 逐条结论

- **CO01 关闭。** 后态四列表、`prior_resolution` 独立读取，以及 legacy 只允许 `preserve_unknown`，都自洽。`proven_stopped` 不合成 applied，也不释放 unknown 费用预留。残留的 JADR13 编号冲突见 CF02。
- **CO02 关闭。** `openRecoveryDb(plan)`、普通 open 在迁移前拦截、逐迁移 `schema_spec→recovery→scoped` 在 gate 图中成立，无环。
  - 未来实施条件：
    - 普通 open 读取 hold 表前，要兼容 schema<47 的库（表不存在）。
    - `runMigrations` 末尾"必须等于 CURRENT"的断言，在 recovery 目标版本下要放行。
- **CO03 关闭。** legacy 的显式 null、subject↔target↔phase 约束、broker proof 身份，都有正反 fixture。
- **CO04 关闭。**
  - 根 ID 在签发前从 `scope/idempotency_key/permit_id` 派生，无摘要环。
  - 消费发生在 `GraphRunStore.create` 的同一事务内，`graph_actions` 是唯一槽位账本，permit 只能收窄 policy。
  - 财务上限可缺省，并与 profile 交叉核验。
  - 未来实施条件：
    - 现有 `openDb` 使用 `synchronous=NORMAL`，而规格要求 FULL。J08 须在 Graph 连接上设置并读回 FULL，否则按 ADR-08 禁用自动继续。
    - `idempotency_key` 须在 permit 签发前冻结。
    - `trial_permit_consumptions` 里的 `phase/revision` 字段名易与 Attention phase 混淆，实施时应更名。
- **CO05 关闭，有 CF03。** role 摘要已改名并定义输入，域目录完整，原始 JSON 解析归 J01，Profile v2 已含 start 相关字段。
- **CO06 关闭。** 64KiB 总额的分配算术成立（3×12288+28672=65536）。registration 是原子私有文件，未终态保全，恢复权限不走过期执行许可。
- **CO07 部分关闭。**
  - 已关闭：
    - 原 gate 的 full wrapper 与 component 分离。
    - producer 传递闭包已检查。
    - 114 条 case 有消费边。
    - 12 项延期理由明确。
  - 残留：release 级消费边缺失，见 CF01。
- **CO08 关闭，依赖 CF01 收尾。**
  - opt-in 与 default 已拆分。
  - E1 `continue|safety_only` 只用于 opt-in，J32 才能触发 default。
  - `merge_after` 已声明为条件顺序。
- **CO09 关闭。** unassigned→assigned→frozen→executed 生命周期、冻结早于候选、合法冻结元数据可通过、未冻结执行被拒，均有校验。
  - 未来实施条件：J23.harness 的实现人员必须登记进相关 oracle 的 `implementation_principals`，并按主体级别（principal）检查独立性。当前只有角色名不同。
- **CO10 关闭。** 历史统计按约定保留，最新数字已写入 validation。

## 本轮需继续修改的缺陷

**CF01（P2）原 `legacy_release_requirements` 没有任何 gate 消费**
- 位置：`execution-gates.json` 的 `J27.default_enable.requires`（只有 `J27.scoped`、`J32.scoped`），以及 `legacy_release_requirements.S2_default_enable`。
- 最小反例：
  - 所有 component gate 通过。
  - `legacy:R05.qualifier_protocol`（即 `J10.protocol`）、`legacy:V03.host_measurement`、`legacy:V06.trust_operations`、`legacy:E01/E02` 这些 full wrapper 全部未满足。
  - 但 `J27.default_enable` 仍可满足：`J10.scoped` 不依赖 `J10.protocol`，也没有任何 gate 依赖 `legacy:V06.trust_operations`，这些 wrapper 是无人消费的末端节点。
  - 原 `S2_default_enable` 明确要求 R05、V03、V06.trust_operations。
- 修复：
  - `J27.default_enable.requires` 增加 S2_default_enable 对应的 `legacy:*` 节点。
  - `J27.scoped` 对 S2_opt_in 只加不经 `legacy:I04.compat_recovery` 的节点。因为 `legacy:C03.budget_storage` 依赖 I04 全量，和 JADR12 的 local 例外冲突，要么写明 local 变体，要么用 `J13.recovery` 替代。
  - 校验器增加一条检查：每个 release 集合都映射到某个 gate 的传递闭包，并加负例测试。

**CF02（P2）JADR13 编号冲突，且旧文仍写"消费与派发 CAS 同事务"**
- 位置：
  - `architecture.md` §7：JADR13 是"试验许可 root run，消费与派发 CAS 同事务"。
  - `closeout-specifications.md` §1、`closeout-dispositions.json`、`work-packages.json`（J12 outputs）：JADR13 是"hold 受控处置/resolved_stopped"。
- 后果：引用 "JADR13" 有两种含义，且 architecture 的旧表述与 CO04 的"在 `GraphRunStore.create` 事务内消费"相反。
- 修复：
  - 把恢复后态决定改为新编号 JADR15，并同步 J12 outputs 和 JA 文本。
  - 把 architecture.md 的 JADR13 改成"许可消费与 `GraphRunStore.create` 同事务；内部 action 沿用 graph_actions admission"。

**CF03（P3）support_profile 摘要向量用了目录之外的域**
- 位置：`fixtures/digest-vectors.json` 的 `domain-support_profile_digest`。
- 问题：该向量用 `osstack.joint.trial-profile.v1`，而 `digest-catalog.json` 规定 `osstack.joint.support-profile.v2`。J01 若按目录实现，会与固定向量对不上。
- 校验器目前不检查向量 domain 是否属于目录。
- 修复：
  - 向量改用目录里的域，并重算 `preimage_utf8_hex` 和 `sha256`。
  - 校验器增加"向量 domain ∈ 目录"的检查。
  - 补一个 `role_required_artifacts_digest` 的正向量。

## 其余仅列为未来实施条件

- 以下均是 J01/J11/J25 的冻结项，或产品验收项，不是新缺陷：
  - 完整产品 schema/SQL。
  - 现场主体身份。
  - 阈值。
  - 71 tests/100 fixtures/120 gate/23 向量所对应的产品互操作验证。
- O01–O06 保持 open，按阶段阻断，处理方式正确。
- 未核验项：J12 对真实旧库的恢复行为、`GraphRunStore` 扩展的并发行为、各 oracle 的实际人员分配。证据不足，不声称有 bug。

CLOSEOUT_END