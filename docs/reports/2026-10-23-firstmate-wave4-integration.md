# Firstmate Wave 4：受限分诊与本地承诺账本

此批基于 Wave 3，接入真实 daemon/CLI；不是公共消息投递或线上部署。迁移 43 为分诊预算及未知终止隔离；44 为本地承诺账本和不可变历史。

## 实现与真实入口验证

- `attention triage` 显式启用、显式 model、无工具、单全局在途、每 scope 最多 5 次/小时和每次成本上限。默认关闭不初始化 provider。未知子进程终止不能报告成功，也不自动解除隔离。
- 默认生产 provider 从 `@osstack/agents` 导出加载的真实 daemon 测试已覆盖；无凭据返回 `not_authenticated`，没有付费模型调用。这不是 live 模型资格。
- `follow-up create/list/draft/resolve` 接入实际 RPC：只支持 default tenant、canonical repo、来源身份和版本绑定。草稿未发送，`fulfilled_local` 仅表示本地来源条件成立；对外投递为 unsupported。
- 实际服务重启后保留分诊预算与隔离；late result 不访问关闭 DB、不回答决定、不标记已读、不发消息。22 个服务/真实 daemon 定向测试通过；完整资格另行记录。

## Haiku 独立挑战及处置

原始输入/输出与源码摘要在 [root-audit](2026-10-23-firstmate-wave4-evidence/root-audit/)。请求 CLI model `claude-haiku-5-5`，返回 metadata 同名；不据此证明底层模型权重。静态审计不替代运行测试。

首轮仅 P1 是默认 provider 缺少实际入口验证，新增真实 daemon 无凭据测试后，第二轮明确撤回，剩余无确认 P0/P1。另以先红后绿测试修复关闭分诊后看不到 quarantine、模型 C1 控制字符未经转义的问题。

保留的 P2/资格边界：没有全局每小时金额上限；没有自动 quarantine 解除；宿主 stop 返回不代表子进程物理退出；旧 ControlledSessionAdapter 的终止行为不是本批改造范围；服务构造暂时失败仍需重启；RPC `ok:true` 的 fallback 必须读取 result.state；注入测试 provider 的结束事实只是测试合同，生产 provider 自己确认 child exit。真实 provider/parent exit 资格待补。

Follow-up 使用 daemon 原有 DB/write 权限和同步事务，独立于 Attention 是否启用；不需要伪造 Attention owner。triage 唯一 active_slot 由 DDL UNIQUE 约束保障，即使竞争写入也不能有两条活动记录；SQLite 锁失败保持失败而不是绕过预算。

## 完整验收

当前最终源码完整 build/typecheck/test/lint/schema/inventory/startup 已进入 OSStack 原生资格任务；结果完成后补入，不把定向测试当全套通过。最终 PR、CI 和独立人工批准分别记录。

## Final full qualification

On source `580bd9df`, all eight stages passed with 5064 tests passed and 3 intentionally skipped across 22 packages. Native task `firstmate-wave4-final-source-qualification` completed with zero verifier issues. [PR #241 full evidence](2026-10-23-firstmate-pr241-final-qualification/) includes the initial failed fixture run and its 133-test repair validation. This supersedes earlier pending validation; actual provider/network qualification and exact-head remote CI are separate.
