# Graph 解阻：执行前支持检查与新图准入开关

日期：2026-09-18。源码提交：`f263062731f678f6835ac76546227fcd85f54b43`。结论：G25-A 与 G26-A 的有界实现已交付；G25/G26 父卡和真实内部试点尚未完成。

## 根因与纠偏

25/30 长期不变的直接原因有两类：真实 CLI adapter 不具备 Graph 要求的 `confirmStopped`，公开入口缺少崩溃后的 reconcile；同时，G25 在内部恢复组件上不断追加局部加固，没有按最终产品路径收敛。此前有限测试 adapter 的成功不等于内置 Claude/Codex/Kimi 能执行完整图。

本轮实际检查内置 adapter，三者均无停止确认方法（见 [能力探测](../implementation/graph-admission-unblock-evidence/builtin-stop-capabilities.json)）。本轮没有用调用审查模型来冒充 Graph 真实后端试点。

## 实际改动

1. 新 run 在持久 reservation 之前检查 writer/reviewer 停止确认能力；不支持时返回 `EXECUTOR_UNSUPPORTED`。直接 `GraphDelivery` 构造、broker adapter 注册同时检查。不会先启动真实 agent 再因天生缺失的能力滞留 unknown。
2. `graph-host.json` 顶层 `admissionEnabled:false` 动态拒绝新 reservation，返回 `GRAPH_ADMISSION_DISABLED`；缺省保持 true。配置继续要求 owner-only，开关不改变 immutable binding。
3. cutoff 是已提交 reservation。已经受理的 queued/live run 继续；合法原请求重试、查询、结果、取消、live quality resume 保留其原授权检查。开关不释放未知效果，也不替代取消命令。
4. 两个错误在 CLI 返回 exit 1、`retryable:false`、`nextAction:stop`；协议与生成 schema 同步。新 callback 必须同步且严格返回 true，不接受 Promise、truthy 字符串/数值或 undefined。

没有新增生产依赖、没有迁移服务数据库。实现仅改动 5 个生产 TypeScript 文件；生成 schema、测试、文档另计。旧 Loop/session 的 adapter 接口没有改动。

## Claude CLI Fable 5.1 审查

用户本轮指定 Fable 5.1；实际使用 `/opt/homebrew/bin/claude` 2.1.261，`--model claude-fable-5-1`。两轮咨询和一次最终代码审查全部完成、无工具权限拒绝。consult 仅 Read/Grep/Glob；focused/review 无工具，禁用 slash commands 和 MCP，不开放执行或编辑。CLI 的 usage 还记录了辅助 Haiku 调用，主审查模型为 Fable；没有把其他模型结果标作 Fable。

- [第一轮原文](../implementation/graph-admission-unblock-evidence/consult-response.md)：建议补公开 reconcile、真实停止生命周期及有限 G25 退出条件。
- [第二轮原文](../implementation/graph-admission-unblock-evidence/focused-response.md)：建议先执行前拒绝，再做真实后端；新准入开关可独立启动 G26。
- [代码审查原文](../implementation/graph-admission-unblock-evidence/review-response.md)：结论为 **“Accept as the bounded slice. No blockers were introduced.”**

主代理复核：采纳执行前拒绝和动态准入开关；不采纳仅进程组 ESRCH、worker exit、workspace retained 标签即可证明任意后代/外部效果停止的建议。保持现有 G15 证明标准。

代码审查指出的两个测试缺口已补上：truthy 非布尔 gate 返回值、旧配置省略开关的默认值。review 对“关闭开关发生在观察 writer 之后”的描述不符合提交源码：该测试先 await 新 reservation，立即关闭，再等待 writer，因此已覆盖 reservation 与 deferred launch 之间的切换。fixture 确实共用原 adapter 对象，且新增显式 identity 断言。无须依据误读重复改生产代码。

审查保留的非阻塞问题：authorize 和 admission 各读取一次 owner 配置；并发 owner 替换可能使已受理 run 在启动时因绑定变化失败，效果前仍再次校验。配置文件解析错误的通用公共错误分类为既有行为，后续可改善操作提示，不据此宣称本轮实现完整恢复。

## 验证范围

- `pnpm build` 通过。
- 实际 OSStack Loop 第一轮执行 1、跳过 0，结果 success：10 个图相关测试文件 127 项、旧 CLI Loop/session/explain 56 项、LoopEngine 31 项、protocol 220 项，共 **434 项通过**。
- 同一 Loop 的全仓 typecheck、schema freshness、启动预算、diff whitespace 均通过。启动中位数 version 28ms / help 80ms，分别低于 150ms / 500ms。
- Fable 审查后只增强 admission 测试；最终 Loop 执行 1、跳过 0、success，重跑该文件 10 项全部通过，并复核第一轮结果与生产/schema 哈希，避免把旧结果用于变化后的生产代码。最终结果和计数见 [验收记录](../implementation/graph-admission-unblock-evidence/admission.json)。

此处是相关测试集，不是声称全仓 `pnpm test` 或完整 F01–F12 新矩阵通过。此前 585 次旧矩阵没有计入本轮新源码的验收。

原始模型结果、测试 JSON、Loop 状态、命令日志和源码哈希保存在 [证据目录](../implementation/graph-admission-unblock-evidence/admission.json)。前两轮咨询 prompt 临时文件在提取响应时被覆盖；原始返回对象和 usage 保留，最终代码审查 prompt 另存本地并记录 hash，不声称前两轮输入原文完整保留。

## 下一步与完成标准

父任务仍为 **25/30**；G26 从 pending 改为 in_progress，最终验收依赖 G25 不变。剩余按 [G25-B/C/D 与 G26-B](../implementation/2026-09-18-graph-unblock-next-context.md) 推进：一个真实受支持后端的停止边界、公开对账与独立证据、原始故障矩阵关闭、旧模式/回滚剩余验收。内置 CLI adapter 当前明确拒绝新图，不能用于 G29 试点。没有通过缩减原验收要求来增加已完成计数。
