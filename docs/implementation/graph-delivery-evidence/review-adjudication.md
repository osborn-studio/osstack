# G21 审查裁决

## 实际参与与限制

Claude Fable 5.1 两轮有效审查：design 与 implementation 的原始 JSON 均 is_error:false，modelUsage 包含 claude-fable-5-1。第三次最终回审原始 JSON is_error:true，明确返回 Fable 额度用尽，modelUsage 为空；不认定为已运行或通过的审查。不改用其他模型冒充 Fable，也未尝试购买或消耗账户重置。

通过真实 OSStack Loop 另执行 Codex 只读审查（G21-readonly-review）；结论 PASS，无本批范围内剩余 P1/P2。它没有运行测试，其引用的历史测试日志不替代最终验收。其报告把 Claude 额度错误写为 HTTP 429，但原始 JSON 未提供 HTTP 状态；该编号未经证实，本报告仅采用额度错误本身。

## 采纳与验证

- 动态注册与持久化 epoch 授权：固定编译节点、host append-only 注册、核心与 broker 双层 epoch 许可、G15 实际交接；真实 repair 用例与旧 epoch 拒绝测试。
- 准备工作区计入账本和预算，独立 nodeId，精确 slot/attempt 绑定回执。修复了按 nodeId 查最新记录误读首次准备回执的实际失败。
- host 权限固定 owner/generation，只有自身成功的 G15 结果能换代；同一验证 snapshot revision 投影终态。真实 reviewer 执行中注入 owner 变更/撤权，旧 host 不得写入替换者状态。
- 参数、回调和 adapter 方法在异步工作前捕获；回执摘要命名、精确 effect/workspace 绑定、fsync 与读取校验。可变输入、回执篡改/符号链接/容量测试通过。
- 长任务租约：当前代码 start 配置 leaseDurationMs:60000，先 stop/drain 再评估 join；续租实际测试缩短剩余租约并让真实 G04 writer 保持执行，验证心跳延长租约且最终 ready。它不是完整 G28 长时间性能试点。
- retry_required 与 failed 的矛盾：注入 retry-2 准备准入失败，在 retry-admission-red.txt 真实复现；修复为 stop/retry_dispatch_incomplete，adversarial-green.txt 验证无重复评审、无 held、tests 正常完成。
- setup 放入 finally，未取得所有权的 claim 失败不投影已有运行；增加关闭 runtime 的测试。
- 初始许可要求覆盖 code-delivery-functional- 家族，增加 v4/v999 测试；缺失 lease 回执采用明确错误。

## 不采纳或澄清

- “失败重试必然导致不可变 join 冲突”不成立：join.ts 只有所有分支 confirmed 才 complete。失败是 blocked，join service 不发表；保留该规则。
- 不把通用 checkpoint 服务变成只允许 confirmed 的 saver，也不向 saver RPC 塞入 join 调度。编译器 action task 自己拒绝非 confirmed；质量边界使用正式 Functional interrupt。
- “replacement 在 actions.retry 之前安装”不符合代码：先成功分配重试账本行，再替换该尝试的执行工作区。普通 worker 不获得重试分配权；失败准备仍有自己的账本记录。
- 普通 pre-admission legacy 失败被 broker.response 转为 POLICY_DENIED / retryable:false，并不会进入评审重试环。仍加入非 verification evidenceRef 的防御性退出，避免今后误读。
- 并行准备复用 G10 的同源队列，不是同时写同一目录；两个验证 repo 独立。迁移外键引用现有 receipt_ref 主键，真实 repair 插入已验证。

G22/G23 用户入口和新 host 恢复装配、G25 任意 daemon 崩溃矩阵、G27 发行、G28 性能与 G29 实际试点保持未完成；不以本批有限集成代替。
