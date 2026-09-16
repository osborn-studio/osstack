# Kimi K3 审查裁决

审查通过 OSStack KimiCodeAdapter 调用已登录的 Kimi CLI 0.29.1，显式 model `kimi-code/k3`、osstack-reviewer no-tool profile。原始 input、events 和 result 留存；实际 identity 以 terminal review.runtime_identity 为准。设计审查和最终源码审查分别记录，不以 readiness 或配置充当完成证明。

## 设计审查：changes_requested

1. **采纳 / 已修复**：core 的 not_started 原先只在 launch 存在时检查持久回执，缺少 launch 会绕过证据检查。增加强制拒绝，修改旧 synthetic 正例为拒绝回归，保存 red 与 green。真实 durable no-child 正例仍通过。
2. **补充材料与真实测试**：设计包没有提供完整 manager，故 Kimi 无法看到既有 register 后、spawn 前 checkAuthority。该检查本来存在；最终包提供完整文件。新增 no-child 后旧 host 存活时接管及其旧启动拒绝；另将旧 host 真正 SIGSTOP 在 consume-before-spawn，证明此时不能接管，杀死后也不把无记录推断成 no-child。
3. **采纳 / 限制实现**：只允许第一代、整个 run 从无准入动作和调度记录；实际 spawn-before-durable-identity 崩溃必须 held。executor/workspace 引用仅表明从无准入，不证明任何历史 executor 已停止。
4. **采纳 / 显式检查**：helper 检查 graph_action_admissions，并检查 actions、checkpoints、writes、requests 五表，而不只依赖外键或 G15 最后 held 检查。
5. **保持现状**：proof.verifiedAt 在异步验证后刷新属于既有 G15；同步事务内复核物理前提与权限，因此没有把旧证据刷新当成新事实。此条为 info，未扩大无必要重构。
6. **完成实现后复审**：最终包提供实际新 helper、runtime 接缝、core、测试/故障夹具、矩阵脚本，以及完整既有 manager/journal/reconciler。提供已通过的30个core测试与21个新增测试；全库结果当时尚未完成，未提前声称通过。

## 最终源码审查

最终 verdict **approved**，proof / races 两项 judgments 都为 pass，结论 No blockers；实际 runtime_identity 为 provider=kimi、model_id=kimi-code/k3、evidence_source=reported。仅针对本批限定实现，不代表完整 G25 获准入。

- warning：建议将整个 run 的五表 absence 检查下沉到 GraphRecoveryStore。当前 helper 在事务内检查；通用 core 支持其他代际和独立可信 supervisor，不应未经另外设计就把首次启动专用规则扩展给所有恢复类型。本批保留可信 verifier 边界，未来新增 verifier 必须单独审查，不能只传字符串 ref。
- info：executor/workspace evidence ref 是绑定 snapshot digest 的标签，不是独立物理证明；真正证据来自同步事务内重跑检查。报告已准确说明。
- info：审查输入时全库验收尚未完成；后续附真实 Loop 全库与矩阵结果，不把21个测试当作全库通过。

## 实际测试与初次失败

- recovery-red.txt：新 API 尚未实现时的3个失败。
- core-gate-red.txt：证明缺少 durable launch 的旧行为被错误接受；green 为修复后30个core恢复测试通过。
- recovery-green2.txt：一个测试使用真实 worker heartbeat 前的 stale revision，未到目标断言；改用真实最新 revision，15个helper测试通过。
- crash-first.txt：两个字符串断言将实际换行与字面反斜杠混淆；修正测试断言后6个真实子进程测试通过。未改产品行为掩盖失败。
- 最终全库和矩阵另由真实 OSStack Loop 执行，以 acceptance-result.json 和 matrix.json 为准。模型审查本身不执行这些测试。
