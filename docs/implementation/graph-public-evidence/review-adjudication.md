# G22–G24 审查裁决

本批实际调用 Claude Fable 5.1 返回额度限制，`is_error:true`、`modelUsage:{}`。没有有效的新 Claude 审查，也没有把 Codex 审查冒充 Claude。`claude-design-response.json` 保留原始结果。独立审查使用真实 OSStack Loop + CodexCliAdapter；`reviewer-report.md` 初审为 REQUEST_CHANGES。

## 四项发现

1. **源仓库策略撤销未传入克隆：接受。** 原实现只检查物理执行工作区。现在可信 repositoryPath 单独成为 policyRoot，由 daemon 注入 broker，执行前同时检查源策略和候选的额外限制；availability 与 reviewer identity 的异步等待后再次校验。`graph-review-findings.test.ts` 用实际 clone、SQLite、G04/G10 覆盖源策略在 workspace 创建后撤销，以及策略未跟踪/比 base 更新。不能由 caller 指定 policyRoot。
2. **有后台数据库使用者时提前关闭 DB：接受。** 取消/停止返回的是有界观察，不能充当 DB 生命周期屏障。GraphRuntime 跟踪 action 和 checkpoint Promise，close 后可等待全部 DB 使用者退出；GraphDelivery 委托这一屏障。GraphRpcService.close 幂等地记录取消、等待 driver/数据库使用者，即使取消本身出错也进入 finally 等待。daemon 对实验 runtime 同样等待。实际 prelaunch mkdir 被阻塞、时间推进超过旧 15 秒窗口时，close 必须仍挂起；真实 child 的 host action 在 bounded stop 后继续读 DB 的测试也验证屏障。无限挂起的本地 I/O 可以拖延优雅关闭；不能用超时虚构安全关闭，强制退出留待 G25 对账。
3. **review/tests 已确认取消误记 unknown：接受。** 执行撤权后，停止证据的结算使用当前 cancel 授权；独立身份核验使用保留的 read 身份权限，不重新要求 execute。确认停止的取消产生持久、不可重试的失败，不产生通过的质量结果。命令确认等待真实进程组停止回执；无停止证明仍持有准入且保留 unknown。新测试覆盖 reviewer、真实 shell tests、无法确认 reviewer 停止三个分支。
4. **无效 mutation 回包被当作拒绝：接受，初审采样期间 parent 已修复。** 发送后失联、结构错误或结果绑定不符均返回 `delivery_unknown`，保留原 scope/key/inputDigest，提示重投同一请求。仅明确的服务器拒绝或发送前校验失败返回 exit 1。7 项 CLI 测试包含无效回包；只读 status 的不匹配仍作为响应错误。

## 修复中捕获的回归

首次新问题测试为 5 fail/1 pass，随后六项新测试通过。首次组合回归 97/98 通过：过宽的 `!signal.aborted` 完成判断使 G21 的准备准入失败场景改变了已完成质量的含义。收窄后单项与完整 98 项组合回归通过。原始 red、intermediate、final 日志均保留。

首次全库 Loop 在复审修复期间读取了混合源码：缓存的旧 runtime 没有新增 drain 方法，旧身份核验仍要求 execute，而测试文件已更新。它实际以失败/escalated 结束，不计为验收成功。`superseded-acceptance-1/` 保留原始结果。最终准入只使用源码冻结后的新 Loop 与源码哈希核对。

第二轮独立审查及最终验收结果见 completion 报告和 admission.json；本文件不替代验收门。
