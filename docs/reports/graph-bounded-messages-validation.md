# G25-B1 受控 Messages 编程后端验收

日期：2026-09-20。代码提交：`d443eeb1125e1bb0d5814fda3a065f1c81ac2868`。分支：`codex/graph-runtime-foundation`。

**结论：新增一个真实可调用 API 的 writer/reviewer 后端，并打通宿主配置到实际 Graph 执行链路；276 项相关测试、构建和静态检查通过，Claude CLI Fable 5.1 复审 accept。测试中的 provider 返回是 fixture；没有宣称已完成真实 API 试点或 G25 父卡。**

## 本轮交付

`@osstack/agents` 新增惰性工厂 `createBoundedMessagesAdapter`。固定 Anthropic HTTPS Messages 端点、无工具、无自动重试、不跟随重定向、不读取 CLI 用户配置或隐式凭据。writer 输出单文件结构化替换，宿主校验后同步执行；reviewer 是另一个 adapter 身份，独立请求中仅包含冻结候选源文件及验收目标。

首版限定 1–16 个现有文件，writer 各文件及替换内容不超过 4 KiB，每次至多替换一个文件。写入前重新核验权限、取消、规范路径、旧内容 hash、inode/device/mode；临时文件写入与 fsync、权限保留、原子 rename、目录 fsync 均完成后才返回实现完成。禁止 shell、新建/删除文件、隐含文件发现、隐藏路径、符号链接、硬链接和二进制文件。它是专用租约下的受控宿主操作，假设无恶意同 UID 进程，不是任意主机程序的 OS sandbox。

owner-only `graph-host.json` 的可选 `registration.boundedMessages` 登记 model、files、acceptance；只接受新固定 writer/reviewer ID，不把这些角色加入通用 router。daemon 异步按需加载后端；旧配置兼容，配置改变仍使原绑定失效。实际修改点主要在 agents 的新后端、Graph 本地注册和 daemon 懒加载；没有改变默认控制面数据库、checkpoint schema 或恢复权限。

停止证据只覆盖这个窄范围：未发送请求；固定供应商完整、符合已知 status/type 的请求拒绝；或者完整匹配的 text-only 推理响应与已结束的同步本地操作。证据绑定 run、workspace、request 和 response digest。断线、5xx、超时、身份不匹配、工具活动、截断响应均不能确认停止。取消后不再写文件；发送后的断线仍保留锁，不将 abort、Promise 完成或 CLI PID 消失当证明。已观察到的 paid usage 在输出解析失败和截断时仍计入事件。

## 验证证据

使用真实 `LoopEngine.runOnce`，显式设置专用 `OSSTACK_HOME` 和短 `TMPDIR`。任务 `G25-bounded-messages-1` 执行 1、跳过 0、迭代 1、outcome `success`。其测试命令实际执行三个 Vitest 批次，而非模拟 Loop 成功。

| 范围 | 通过数 | 验证内容 |
|---|---:|---|
| Agents | 46 | 真实原子文件替换、模式保留、边界拒绝、权限撤回、关闭迭代器、HTTP 拒绝、断线/超时、输出限额、usage、完整 Hermes schema |
| CLI / Graph | 89 | 新后端到 ready、负面 review 暂停、未知推理保留锁、owner config 登记/变更、实际 daemon+CLI；现有 broker、准入、RPC、reconcile、shutdown 回归 |
| Loop | 141 | 原候选单次实现与执行器终态/取消兼容 |
| **合计** | **276** | **零失败** |

Graph 与 daemon 测试实际创建临时 git 源仓库、候选 clone、Graph worker、动作账本、冻结产物、review 分支、验收命令与 join；writer 后的候选内容是 `1\n`，原仓库仍为 `0\n`。负面 review 进入 `waiting_input` 并可取消；断线进入 `reconciliation_required`，public reconcile 保持 `cancel_pending / delivery_unknown`，没有重复调用 writer。只有 HTTP 模型响应由 fixture 提供。

`pnpm build`、`pnpm typecheck:check`、protocol `check:schemas`、`git diff --check` 均通过。CLI 启动中位数：version **29 ms**、help **84 ms**；新增惰性工厂入口导入 **0.41 ms**。未运行完整 `pnpm test`；本轮相关测试集和完整类型/构建检查见原始证据。

- [Loop 结果](../implementation/graph-bounded-messages-evidence/acceptance-result.json)与[状态](../implementation/graph-bounded-messages-evidence/STATE.md)
- [测试/检查脚本](../implementation/graph-bounded-messages-evidence/check.mjs)与[测试输出](../implementation/graph-bounded-messages-evidence/accepted-focused.txt)
- [结构化验收](../implementation/graph-bounded-messages-evidence/admission.json)与[证据 hash 清单](../implementation/graph-bounded-messages-evidence/manifest.json)

首次构建发现测试代码把 `AsyncIterable` 当作 iterator 使用，已改为通过 `Symbol.asyncIterator` 获取 iterator；重新完整构建和 Loop 类型检查通过。此前 Agents 缺少 capability 默认字段也在最终构建前补齐。没有将中间失败隐藏为一次全绿。

## Fable 审查处理

实际使用本机 Claude CLI 的 `claude-fable-5-1`，不是 Codex 冒充该模型。第一次无工具咨询输出了伪工具调用文本，明确判为无效，不计入审查。随后以 Read/Grep/Glob 模式审查源码；未授权修改，审查者没有运行测试。

| 初审意见 | 最终处理 |
|---|---|
| 完整 4xx 拒绝也永久保持未知 | 只对已知状态码/错误类型组合及完整 body 证明请求拒绝；5xx 和不匹配保持未知 |
| 首个 yield 后关闭 iterator 缺少未发送证明 | yield 移进 try；finally 记录未发送请求 |
| 大文件无法放入全文输出预算 | 将首版 writer 明确限制为 4 KiB 文件，拒绝超限输入，输出预算 32768 token |
| stop 证据未绑定 request、ID 可含控制字符 | 限制 ID 字符集，绑定 run/workspace/request/response digest |
| review 输出超出 Graph 8192 字节契约 | 提示与运行时均检查序列化 UTF-8 字节数 |
| 无法区分失败原因 | 只输出安全 BOUNDED 常量码，其余归为内部错误 |
| usage.final 缺 duration_ms | 补齐完整事件字段，并保留失败响应已消耗 token |

复审结论为 **accept**。[初审原文](../implementation/graph-bounded-messages-evidence/review-response.md)、[复审原文](../implementation/graph-bounded-messages-evidence/final-review-response.md)和对应 JSON 均保留。审查中的旁注称 daemon 失败 promise 会一直缓存，与现有 catch 清空逻辑不符，不采纳该旁注；它不影响本轮结论。

停止范围是基于固定 API 契约和无工具请求作出的工程推断，依赖供应商诚实报告该请求的完成/拒绝，并不是物理服务器停止证明。核对来源：[Messages API](https://platform.claude.com/docs/en/api/messages/create)、[stop reasons](https://platform.claude.com/docs/en/build-with-claude/handling-stop-reasons)、[错误类型](https://platform.claude.com/docs/en/api/errors)。

## 尚未完成

当前 shell 没有显式 `ANTHROPIC_API_KEY`；Claude CLI 可用于 Fable 审查，但该订阅登录未用于新后端。已询问用户现有注入方式；不要求在聊天中发送密钥。**G25-B2 的真实 API 小仓库试点待此凭据和有效 API model ID，不能把本轮 fixture 测试计为其完成。**

stop map 为内存证据，最多 4096 次且不复用 ID；重启不能确认旧 run。一般已发送未知效果的对账仍是 G25-C2；原 F01–F12 完整映射为 G25-D。G26-B、G27、G28、G29 仍按原计划推进，凭据缺失不阻塞其独立工作。父卡计数保持 25/30，新增已完成的 B1 只反映具体实现进展。

下一轮直接读[最新接续上下文](../implementation/2026-09-20-graph-bounded-backend-next-context.md)。
