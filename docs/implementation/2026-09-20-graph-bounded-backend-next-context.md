# G25-B：受控 writer/reviewer 已实现，真实 API 试点待接凭据

日期：2026-09-20。继续使用工作区 `/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation`、分支 `codex/graph-runtime-foundation`。原 checkout 仅同步本任务文档，不修改或提交其用户工作。

本轮主线已经从 recovery helper 转到真实执行后端。新增 `createBoundedMessagesAdapter`，直接使用 Anthropic Messages API，不通过 Claude CLI/SDK 子进程，不授予模型工具。writer 输出一个结构化替换提议，宿主校验后写入一个预登记文件；reviewer 是独立身份和独立无历史请求，只读冻结候选。复用原 AgentAdapter、Loop 单次实现、Graph broker、权限和工作区租约。

## 已实现且测试的 G25-B1

- 公共 owner config 的 `registration.boundedMessages` 可声明精确 model、文件名单和具体验收目标；writer/reviewer 必须选择新增固定 ID。配置不接受密钥、endpoint、shell 命令或 fetch；密钥只来自 daemon 环境中的显式 `ANTHROPIC_API_KEY`。
- writer 每次只替换一个现有 UTF-8 文件，输入和替换内容各不超过 4 KiB；最多登记 16 文件。不是通用多文件编程 agent。禁止新建/删除文件、隐藏路径、越界路径、符号链接、硬链接和二进制文件。
- 模型提议必须携带精确 path 和 before SHA-256。写前重新核验 live grant、取消信号、规范路径、内容、inode/device/mode；同步写临时文件、fsync、保留 mode、原子 rename、目录 fsync。
- 只在没有发送请求、收到完整可信的请求拒绝响应，或完整匹配的无工具 Messages 响应且本地操作结束时证明停止。证据绑定 run/workspace/request/response digest。一般断线、5xx、超时、工具活动或无可信完整响应保持未知，绝不靠 abort/Promise/CLI PID 释放锁。
- `graph.start → 实际克隆 → writer 写入 → freeze → reviewer + 验收命令 → join → ready` 已用实际 Graph worker、daemon、CLI、账本和临时 git 仓库验证，只有 provider 响应为 fixture。另验负面 review 的质量暂停，以及断线后 `graph.reconcile` 仍保留 pending/holds。
- 正常 paid usage、截断/输出解析失败时的 paid usage均保留。`usage.final` 符合 Hermes 完整事件 schema。
- Fable 5.1 首次咨询输出了不可执行的工具标记，不算审查；随后 read-only 实际审查提出 7 点，已修复，复审 `accept`。模型审查没有运行测试，不等同真实 provider 试点。

详细证据、最终命令和代码提交见[验收报告](../reports/graph-bounded-messages-validation.md)。配置片段与边界见[Graph 使用指南](../guides/graph-delegation.md#bounded-messages-writerreviewer-g25-b1)。

## 下一步（不要再退回泛化 helper）

1. **G25-B2 真实 API 验收**：向隔离 daemon 注入已有授权的 `ANTHROPIC_API_KEY`，选择确实可访问且返回 ID 匹配的 API model。当前进程没有此变量；Claude CLI 的订阅登录不等于 API 凭据。已向用户询问注入方式，未请求聊天粘贴密钥。保持首版 4 KiB/单文件范围，在真实临时仓库跑成功候选、独立 review、质量拒绝和取消/断线；关联真实 provider usage、Graph receipt、候选产物及停止结果。不能用本轮 fixture 或 Fable 文本审查替代。
2. **G25-C2**：已发送且失去终态的外部动作仍需要独立执行器/工作区证据与可信业务 outcome，通过 G15 精确结算/释放。当前 public no-child 对账不适用。新的内存 stop map 也不能在重启后重建旧证明；4096 次容量拒绝与此限制均已公开。
3. **G25-D**：将原 F01–F12、artifact 锁等剩余验收逐项绑定可复核业务窗口。**G26-B** 的兼容、旧 checkpoint 拒绝与备份恢复未知动作保持可独立推进；API 凭据不足不能成为这些工作的阻塞理由。
4. G27 构建/版本矩阵、G28 性能、G29 真实内部任务仍按原依赖验收；不因这个窄后端通过而提前宣称产品完成。

父卡仍为 **25/30**，G25/G26 实施中。新增 B1 是已实现可用接口与真实执行链路测试；G25-B 整体验收还缺 B2。停止契约信任的仅是固定供应商明确返回的一次无工具推理终态，加上受控宿主同步文件操作，并假设专用租约内不存在恶意同 UID 进程；不是任意 CLI 后代/远程工具的隔离证明。
