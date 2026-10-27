CLOSEOUT_BEGIN

**判定：PASS_WITH_CONCERNS**

本次只核对 CF01–03 的修订及其改动处。我未执行任何命令，也没有重新计算哈希，只依据输入文本判断。未发现需要 REVISE 的具体矛盾。

## 逐条结论

**CF01 关闭。**
- `release_bindings.J27.scoped` 的 12 个 producer 与校验器 `local_project` 对 `S2_opt_in` 的投影一致：`I04.compat_recovery` 换成 `J13.recovery` 和 `J12.scoped`，C03/C04/E02 换成 `local:` 变体。这 12 项都在 `J27.scoped.requires` 中。
- `J27.default_enable.requires` 已包含 `legacy:R05.qualifier_protocol`、`legacy:V03.host_measurement`、`legacy:V06.trust_operations`。
- `J27.scoped` 的闭包不含 J32，也不含 `J27.full_original_completion`。后者合取 32 个 `legacy_full` 和全部 legacy producer，且不是 local opt-in 的前提。
- 我没有发现环：`legacy:V06.trust_operations` 依赖 `J27.scoped`，而 `J27.scoped` 不依赖它。
- 原 `legacy:*` wrapper 仍要求完整 I04，没有被悄悄放宽。

**CF02 关闭。**
- `architecture.md` 的 JADR13 现在指试验 root run，并写明"许可消费与 `GraphRunStore.create` 同事务"，与 `closeout-specifications.md` §3 和 `audit-specifications.md` §3 一致。
- JADR15 专指恢复后态，`closeout-specifications.md` §1 和 `work-packages.json` 的 J12 outputs 都使用该编号。
- 校验器检查 JADR 编号不重复且包含 JADR15。

**CF03 关闭。**
- `domain-support_profile_digest` 的 preimage 十六进制解码后为 `...support-profile.v2`，与目录一致。
- `role_required_artifacts_digest` 的正向量已补入，域与目录相同。
- 我数出 24 个合法向量，与 validation 的记录一致，另有 5 个非法输入。
- 校验器已检查"向量域 ∈ 目录"和"字段对应域一致"，并有两个对应负例。
- 向量哈希本身我无法在此重算，信任 JS 参考实现的核对记录。

## 残留的小问题（非阻塞）

1. `validation.md` 引用 `revision3-design-checks.json`、`revision3-validator-tests.log`、`revision3-digest-check.json`，而输入中的证据文件名是 `final-*`。请确认文件名对应。
2. 负例覆盖不对称：`J27.scoped` 删除 `local:E02` 有测试，但 `J27.default_enable` 删除 R05/V03/V06.trust_operations 没有专门负例。校验器逻辑会拒绝这种情况，只是缺少回归测试。
3. 输入没有包含 `closeout-dispositions.json`、JA51/52 文本和 Firstmate addendum，所以"这些位置不再把 JADR13 用作恢复后态"我无法核验。

## 仍需未来实施验证的条件

- 普通打开路径在读取 hold 表之前，要兼容 schema<47 的库。
- 恢复模式的版本断言以显式的 `recovery_target_version` 为准，不使用普通的 CURRENT。
- Graph 连接设置并读回 `synchronous=FULL`，并实现 `createAndConsumeTrial`。
- `idempotency_key` 在 permit 签发前冻结。
- `consumption_state` 与 `consumption_revision` 的字段不与 Attention phase 混用。
- 每个迁移在 rebase 后，用各自的 (source_schema, target_schema, ddl_digest, fixture_digest, schema_spec_digest, candidate_sha, recovery_build_digest) 单独做恢复验证。
- 真实旧 hold 的恢复，以及 `resolved_stopped` 的故障注入。
- 产品 TS 对 24 个向量的互操作验证。
- oracle 的主体身份登记，包括 J23.harness 的实现人员。
- E1 阈值在 J25.protocol 冻结。
- 启用 S3/S5 或 broker 之前，补上对应的 release 绑定，并通过完整 I04 gate。
- O01–O06 保持 open，并按阶段阻断。
- 以上均为设计检查，不是产品正确性证明。

CLOSEOUT_END