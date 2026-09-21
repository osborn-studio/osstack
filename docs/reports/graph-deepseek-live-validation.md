# DeepSeek bounded backend：真实执行验收

日期：2026-09-20。代码提交：`e1aa11722182c2bfbf12ead60356c1b83749aba5`。分支：`codex/graph-runtime-foundation`。

G25-B 的受控后端真实 API 验收通过。DeepSeek 凭据阻塞已解除；父任务仍为 **25/30**，G25 尚有 C2 外部动作恢复、D 原始故障矩阵，不能将本次小型试跑等同完整产品验收或 G29 内部试点。

## 实际执行结果

使用 `deepseek-v4-pro` 与 `https://api.deepseek.com`，运行真实 CLI daemon、公共 Graph RPC、健康检查、隔离数据库及临时 Git 仓库。没有模拟 provider 响应。鉴权后的模型列表查询返回 HTTP 200；用户输入地址中的 `api,deepseek.com` 已仅针对该明确拼写错误修正。密钥保存在仓库外私有凭据目录，未写入代码、配置示例或验收证据。

- 成功运行 `098f02d5-ebf4-49e4-905f-13f8bc7d9fc4`：工作区、实现、冻结、准备 review、准备 tests、review、tests 共 7 个动作均 confirmed。review 为 accept，tests 通过，两个分支绑定同一候选，持久化 join 为 complete，最终 ready；重复请求返回同一 run。原始仓库保持不变。
- 候选 `ac601da872b118792a22c9867d6669907271da13` 将 `return value;` 修正为 `return value + 1;`。成功链路记录 writer/reviewer 合计 701 tokens。
- 独立真实 reviewer 检查原始缺陷，返回 changes_requested，准确指出未加一；记录输入 254、输出 116 tokens，合计 370。
- 另一次真实 writer 在执行中取消后为 unknown，Graph 为 cancel_pending。精确 effectKey 的 admission 未释放，预留 32768 tokens，候选不变且没有 freeze。daemon 正常退出后，通过只读数据库复核同一 hold 仍存在。账本 chargedTokens 为 0 表示尚无可信使用量，**不表示远端免费、未执行或已经停止**。
- 最终试跑 daemon 正常退出，退出码 0。

完整结果见 [live-pilot-final.json](../implementation/graph-deepseek-live-evidence/live-pilot-final.json)，退出后核验见 [final-post-stop-check.json](../implementation/graph-deepseek-live-evidence/final-post-stop-check.json)。

## 实现范围与验证

Anthropic 与 DeepSeek 共享受控适配器，DeepSeek 使用无工具、非流式、关闭 thinking 的 JSON 请求。provider、model、baseUrl 与角色绑定进入 owner 配置及授权摘要；密钥仅从匹配 provider 的 daemon 环境读取。DeepSeek baseUrl 来自 owner 配置，试跑脚本负责将私有环境变量复制到该配置。

writer 每次最多替换一个已登记的现有 UTF-8 文件，文件输入及输出各不超过 4 KiB，最多登记 16 个文件。写前检查权限、取消、路径、原内容摘要及文件身份，原子替换并 fsync。禁止工具调用、新建、删除、隐藏路径、符号链接、硬链接和二进制。试跑的固定验收命令只读取并校验有限源码形式，不执行模型生成的任意代码。这是专用工作区租约下的受控宿主写入，信任不存在恶意同 UID 写入者，不构成操作系统沙箱。

完整匹配的终态响应或明确请求拒绝可形成停止证据；超时、断线、5xx、取消请求本身均不能证明远端停止。内存停止记录不能跨进程重启重建旧证据。

OSStack Loop `G25-deepseek-1` 实际执行 1 次、跳过 0 次、1 次迭代成功：

| 检查 | 结果 |
| --- | --- |
| Agents 聚焦测试 | 83 通过 |
| CLI 聚焦测试 | 93 通过 |
| Loop 聚焦测试 | 141 通过 |
| 合计 | 317 通过，0 失败 |
| 全工作区 build、typecheck:check | 通过 |
| 协议 schema 新鲜度、diff 空白检查 | 通过 |
| CLI 启动中位数 | version 29 ms，help 81 ms |

本轮没有运行全仓 `pnpm test`，没有创建 PR、合并或发布。执行记录见 [admission.json](../implementation/graph-deepseek-live-evidence/admission.json) 与 [Loop 状态](../implementation/graph-deepseek-live-evidence/LOOP-STATE.json)。

## 审查与失败记录

Claude CLI `claude-fable-5-1` 进行了只读审查，最终后端和试跑脚本均 accept。有效发现已修正：裸 `?`/`#` URL 后缀、nullable tool_calls 兼容、精确取消 hold 断言、各节点及 join 断言、等待预算、写报告前 URL 校验、拒绝结果先保存、取消 revision conflict 的有限重试。

审查中“8192 是最大输出”和“aborted 未文档化”的判断不符合当时官方文档，已提供来源并挑战，未据此加入错误限制。官方资料：[Chat Completion API](https://api-docs.deepseek.com/api/create-chat-completion/)、[错误码](https://api-docs.deepseek.com/quick_start/error_codes/)、[模型与价格说明](https://api-docs.deepseek.com/quick_start/pricing/)。实际可用模型另外通过鉴权 API 核验。

保留了早期失败试跑：第一次错误使用 CLI `--workspace`，第二次尚未满足真实健康准入；均在物理 API 调用前失败。修正为正确 cwd、等待实际健康检查与明确的有限本地试跑电源策略后通过，没有绕过健康门禁。该电源策略不代表已经满足长期 soak 条件。

最终审查见 [Fable 结论](../implementation/graph-deepseek-live-evidence/fable-harness-response.md)。证据目录含初次失败及最终成功记录、测试输出、审查文本及 [SHA-256 清单](../implementation/graph-deepseek-live-evidence/manifest.json)，未复制原始 daemon 日志、数据库或凭据。实际密钥的字节扫描未发现源代码或证据包含该密钥。

下一步按 [接续上下文](../implementation/2026-09-20-graph-deepseek-next-context.md) 推进 G25-C2、G25-D，并继续 G26-B；不再将凭据接入列为阻塞。
