# G22–G24：图执行用户入口与委托契约

**G22–G24 本地验收通过，C7 通过；25/30，M0–M2 完成，M3 待实施。** 源码提交 `7da1be9ef70770bbdea5c52f6453764f6b4ba317`；完整发布准入仍须 G25–G29。

## 实际交付

- **G22**：保留 graph explain，新增离线 validate 与经过 daemon 的 run/status/result。固定模板、预算、类型映射都在 validate 中检查，不打开控制面 DB。真实构建 CLI 在保留目录/哨兵 DB 上验证过无 DB/文件变更。公开状态包含 run id、阶段、候选、账本预算和稳定错误。
- **G23**：cancel 先保存意图，再走真实 worker/G04 executor/G15 停止链。resume 严格绑定 interrupt、revision、原输入、scope 和当前授权；质量 join 中断能实际换代执行下一 repair epoch。授权请求返回原域，模型文本/布尔值不能授予权限。read/cancel 可以独立保留，执行授权过期后仍能查询、取消与核验停止证据。
- **G24**：submit/status/cancel/result 的 v1 外部契约保留 source、parentRunId、inputDigest、结果引用与 delivery_unknown。用真实 Unix socket 和模拟 OSBot/OStag 身份验证重复提交、来源隔离与结果引用；未认证身份拒绝。这里只交付 OSStack 契约，没有新增 OSBot/OStag 产品或公网服务。

使用方法和 host 配置见 [委托指南](../guides/graph-delegation.md)。入口是 `graph validate --spec FILE`、`graph run/cancel/resume --request FILE`、`graph status/result --run ID --scope FILE`。JSON 文件遵循 protocol schema。请求超时或确认回包无效时，应重投原 key 和输入；不得换新 key 再启动。

## 持久性与权限

迁移33只增加 public delivery descriptor/结果/interrupt 存储；descriptor 不可修改，执行状态仍由现有 ledger、checkpoint、join 和 GraphRunStore 管理。原 scope/key/inputDigest 与 descriptor 在同一事务中持久注册，然后异步构造一次性 driver；同 key 重投、新 service 重投都不会重新 launch。缺少 descriptor 的旧内部 run 不可被公开入口冒领。

本地 owner-only 配置和 Unix socket 为明确授权入口；配置将引用绑定到仓库、任务、agent、测试命令和 grant。调用者传来的 scope/product 只是待检查的数据。源仓库实时策略始终是权限依据；clone 的物理路径不能取代它。ready 与候选、不可变 join 引用同事务发布。Token 计数以十进制字符串保留精度，恢复不重置原预算或时间。

取消请求与确认分开。review/tests 的已证明停止取消记录不可重试失败；无法证明停止仍保持 unknown/held。优雅关闭等待实际数据库使用者退出，bounded stop 不等于可关闭 SQLite。这里保留原有 G04/G10/G15 执行、准入与对账机制。

## 真实协作与纠错

实施、修复、两轮独立审查和最终验收均通过实际 OSStack Loop 发起，执行/跳过计数与原始事件保留在证据目录。coding/review actor 的 `git diff --check` 不是全库验收。

Claude Fable 5.1 本批实际调用返回额度限制，未产出有效审查或签核。独立 Codex 初审 REQUEST_CHANGES，复审 PASS；没有把它冒充 Claude。初审发现的源策略、关闭数据库、验证节点取消、无效回包四项问题均已修复，详见 [审查裁决](graph-public-evidence/review-adjudication.md)和[复审](graph-public-evidence/reviewer-final-report.md)。

新增问题曾有 5 fail/1 pass 的真实反例；修复过程中组合回归暴露 G21 已完成质量在 late abort 下的错误分类，收窄后 98/98 通过。首次全库 Loop 在代码修复期间读到了新旧模块混合状态，实际失败，完整保留为 superseded；最终验收以冻结后的源码哈希为准。

## 验证与准入

真实 Loop `G22-G24-final-acceptance-2`：executed 1 / skipped 0 / success。

- 全库 **3236 项测试 / 22 个包通过**，无失败。
- 六项 verifier 全部 exit0：typecheck、schema freshness、实际 saver kernel、Functional 恢复探针、CLI startup budget、git diff --check。
- 全库 build 通过；最终源码与冻结哈希、复审哈希及上述提交逐项一致。
- 核心改动 Biome 检查通过；graph-chain 旧测试有四处原有 any warning，本批新增部分无该警告。

完整原始记录见 [准入证据](graph-public-evidence/admission.json)、[Loop 结果](graph-public-evidence/acceptance-result.json)及相邻日志。C7 是固定模板和本地用户面的限定准入，productionReady 为 false。

## 未完成边界

本批是受限本地准入，不代表 beta 发布。G25–G29 仍须执行。

- 新 daemon 可以查询并重投原状态，但没有 live supervisor 的恢复请求会拒绝。不能用旧 stopped:true 或租约过期推断现在可接管。等待中的质量中断仍要求原 lease 存活（当前最多五分钟）；超时拒绝，不偷偷续租/换 owner。独立 crash 恢复属于 G25。
- 本地 config 只提供显式 owner 身份。OSBot/OStag 测试是可信 resolver 下的模拟调用者，生产远程认证仍需后续 connector。
- 未证明真实 provider 的完整长期运行、跨平台发行、任意故障恢复或性能试点。same-UID 不是 OS sandbox，WAL NORMAL 不是断电保证。同步 Git I/O、完整历史 bundle 等约束沿用 G21，性能留 G28。
- 若本地 I/O 永久挂起，优雅关闭可能等待；不能为准时返回而关闭仍被使用的 DB。强制退出后的未知效果保留，须对账。

下一轮 [G25 交接](2026-09-15-graph-public-next-context.md)从实际故障与并发窗口开始，随后做兼容回滚、发行、性能和内部真实试点。
