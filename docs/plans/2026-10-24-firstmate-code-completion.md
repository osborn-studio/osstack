# Firstmate 24 项能力剩余代码收口计划

日期：2026-10-24（Asia/Shanghai）。基线为 PR #243 的 `1c343aad`，依赖前七个未合并 PR；本轮不合并、不部署、不修改用户真实 home。原交付账本仍是能力编号依据。

## 验收口径

实现完成必须同时有：可调用的生产入口、宿主授权与范围验证、故障反例、实际本地文件/进程/数据库或 HTTP 边界验证、独立 CLI 静态挑战，以及集成全量检查。假 transport 只验证边界，不证明外部账户/平台资格。真实环境缺失单列，不能用它掩盖尚未写出的代码。

最多三个子代理并行，分别在隐藏 worktree 开发；主线程负责 daemon/bin、共享协议、迁移与统一验收。先完成 scout/lesson、delivery、upgrade，再轮转到 sources/viewer/remote/Graph。公共入口由主线程接线并测试，组件完成不直接计为能力完成。

## OSStack 原生任务

每项使用 `loop enqueue` 建立任务；子代理产出后以 LoopEngine 执行固定源码的实际资格命令并由独立 verifier 核查退出码/结果。失败保留，新尝试独立记录。任务表不是完成证明。

|任务|原能力编号|交付与验收|
|---|---|---|
|`firstmate-close-scout`|12|Host-enforced read-only investigation and explicit promotion through fresh guarded delivery admission|
|`firstmate-close-lesson`|20|Authoritative failure-repair-success evidence bridge to create-only lesson draft|
|`firstmate-close-delivery`|22,23|Production GitHub transport, exact receipt lookup, private host registry and explicit issuer approval|
|`firstmate-close-upgrade`|24|Concrete pinned installer and per-home stop/start/build proof with explicit unknown reconciliation|
|`firstmate-close-paired-routing`|7,21|Bounded no-tools paired held-out model evaluation with source labels hidden, cost and uncertainty evidence|
|`firstmate-close-source-events`|15,18,19|Host-pinned event/snapshot protocol with generation, sequence/gap checks and scoped read ledger|
|`firstmate-close-source-context`|18,20|Explicit host-approved source-to-context loader through actual prompt budget and provenance receipts|
|`firstmate-close-viewer-backends`|16|Pinned tmux/cmux viewer launchers and bounded read-only log view with no worker control authority|
|`firstmate-close-remote-actions`|15,17|Separate scoped short-lived remote cancel authorization, durable idempotent receipt and unknown reconciliation|
|`firstmate-close-graph-checks`|13,23|Multiple registered checks bound to frozen artifact and durable contract completion receipt|
|`firstmate-close-supervision-qualification`|2,3,5,6,14|Active mixed Graph supervision load, stop/restart/generation tests, observer budget and Loop overhead measurements|
|`firstmate-close-final-ledger`|1,4,8,9,10,11|Reconcile all 24 rows against executable entries, inherited invariants and separate real-environment qualification|

## 关键约束与真实环境项目

- 调查只用宿主固定只读工具；promotion 必须重新绑定当前 base/policy，重新通过正常执行准入。失败修复经验不得接受用户 JSON 的 passed 字段作权威事实。
- 公共发送先持久消费精确单次授权，POST 不自动重试；未知结果用同一精确主体/内容/关联标识查询。开发测试不向真实账户发消息。
- 升级固定版本/build/checksum 与完整 consumer 清单，不恢复旧数据库；未知副作用先对账，禁止隐式重放。仅 scratch 安装/进程可用于开发测试。
- 远程观测与动作独立授权；断线不等于停止，取消请求不等于已停止。远程主机/真实密钥更换与多平台需独立实机资格。
- 来源插件是数据，不能授予执行/审批权；generation、sequence、freshness、gap 均显式。只有宿主固定注册且显式配置的来源可以进入上下文。
- 模型评估不将标签送给 provider；同一 holdout 成对运行，报告样本量、错误、token、价格依据与不确定性，不能自动改默认路由。
- tmux/cmux 后端只能创建观察器；pane ID 复用不得导致 worker 操作。未安装后端必须明确 unsupported，不能伪装成功。
- 所有真实外部 provider、SSH、launchd/多 home、物理断电与跨平台资格在最终账本单列。

最终逐项复核原 24 行，区分代码完成、集成本地通过、外部资格缺失；不声称没有证据的 24/24 上线。
