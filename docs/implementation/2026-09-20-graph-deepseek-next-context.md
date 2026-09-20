# DeepSeek 真实试跑通过后的接续上下文

日期：2026-09-20。实施工作区 `/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation`，分支 `codex/graph-runtime-foundation`，已验收代码提交 `e1aa11722182c2bfbf12ead60356c1b83749aba5`。原 checkout 仅同步本任务文档，不修改或提交用户的其他工作。

**G25-B 已在受控范围完成真实 DeepSeek API 验收，凭据不再阻塞。下一轮直接推进 G25-C2 外部动作恢复，再完成 G25-D 原始故障矩阵；G26-B 兼容验收可独立推进。** 不要重新回到 API 配置、重复模型探测或泛化 recovery helper。

## 本轮完成

- DeepSeek provider profile、owner 配置及固定 writer/reviewer 角色接入；Anthropic 默认兼容。provider/model/endpoint 绑定不可变授权摘要，密钥不进入 JSON 配置或 RPC。
- 真实 daemon、健康准入、公共 Graph RPC、实际 Git 工作区贯通 writer → freeze → reviewer/tests → join → ready，7 个动作 confirmed。重复请求稳定，原始仓库不变。
- 独立真实 reviewer 拒绝原始缺陷；真实取消保留 unknown writer 的精确 admission、预算和工作区约束，没有候选冻结。退出后只读核验通过。
- OSStack Loop `G25-deepseek-1`：317 项相关测试通过（83 agents、93 CLI、141 Loop），全工作区 build/typecheck、schema 与启动预算通过。Claude CLI Fable 5.1 后端及脚本最终 accept。

详见 [验收报告](../reports/graph-deepseek-live-validation.md)、[机器任务清单](2026-09-13-osstack-graph-upgrade.tasks.json)、[使用指南](../guides/graph-delegation.md)。父卡仍 **25/30**；G25/G26 实施中。G25-B 的完成仅覆盖 4 KiB/单文件受控后端，尚不是通用多文件编程或 G29 真实内部产品试点。

## 凭据与复现

用户已在本机终端输入凭据，私有文件为 `/Users/osborn/.config/osstack/credentials/deepseek.env`（0600，父目录 0700）。仅在需要运行已授权试点的 shell 内关闭 tracing 后 source；不得 cat、打印、提交或把密钥传入模型审查。DeepSeek 环境变量名为 `DEEPSEEK_API_KEY`、`DEEPSEEK_BASE_URL`。

鉴权查询已验证 `https://api.deepseek.com`、`deepseek-v4-pro` 可用，不必重新询问用户。daemon 读取 owner 配置中的 baseUrl；`scripts/verify-bounded-deepseek.mjs` 将私有环境地址写入它创建的隔离配置。使用明确、全新、非保留的 OSSTACK_HOME 和短 TMPDIR，绝不对默认 `~/.osstack` 运行开发版 CLI。

最终原始本地试跑目录 `/Volumes/AIMATE_WORK/tmp/g25-deepseek/live-home/pilot-58GdTU`；成功报告已归档到 `graph-deepseek-live-evidence/live-pilot-final.json`。其中取消试跑保留的 unknown hold 是证据，不要为了清理状态强制释放或重新派发。

## 后续验收顺序

1. **G25-C2：已准入外部动作的恢复。** 基于现有 public reconcile 与 G15 精确结算接口，把独立执行器停止证据、工作区状态、可信业务 outcome 绑定到同一 effectKey/attempt/候选与授权。区分可证明已停且结果确定的动作、未发送动作及不透明 unknown 动作；不承诺恢复所有远端推理。必须覆盖 daemon 重启和旧授权失效，证明不会重复执行或错误释放。
2. **G25-D：完整故障矩阵。** 将原计划 F01–F12、artifact 锁等逐项映射真实业务窗口和证据；复用已有有效覆盖，仅补未覆盖项。当前成功、拒绝、取消三条试跑不能替代完整矩阵。
3. **G26-B：兼容与备份恢复。** 完成旧 checkpoint 拒绝、兼容入口、恢复后未知动作保留等原计划验收；不依赖再次接入 API。
4. **G27/G28/G29** 按原依赖执行构建版本矩阵、性能及真实内部任务。内部试点必须超出本轮 toy increment 仓库，并满足实际长时运行要求。

## 不可放宽的边界

- abort、超时、请求断线、CLI 退出、TTL 或 Promise 完成均不是远端已停止证明；unknown 不自动重试，不自动清账、释放或转 cancelled。
- 适配器停止记录仅在内存中，重启后不能伪造旧证明；容量上限 4096 不通过逐出旧记录允许 ID 复用。
- cancel 测试的 chargedTokens=0 仅表示未获可信 usage，不能称零成本。保留的 reservation 不是已经结算的费用。
- reviewer 只读独立请求，writer 仍受文件名单、4 KiB、单次原子替换、实时权限及租约约束。owner URL 可配置不等于模型或 RPC 可覆盖 endpoint。
- 模型审查是补充；必须保留实际测试和故障证据，不能凭 accept 文本把父卡标完成。Fable 曾引用过时 DeepSeek 限制，后续继续核验有效发现。
