# G29：真实 OSStack 内部任务试点

2026-09-20，使用授权的 DeepSeek API、`deepseek-v4-pro`，在 OSStack 的独立完整 Git clone 中修复 `scripts/graph-test-env.mjs`：`assertIsolatedHome` 必须拒绝文件系统根目录及其别名。只交付候选产物，未修改原仓库该文件，未合并或部署。

## 实际结果

- run `a9775889-c8f7-4344-9e41-83ffadec6deb`：workspace → implement → freeze → 并行准备/独立 review 与隔离 tests → join → **ready**。7 个动作全部 confirmed，幂等重放稳定。
- candidate：`acd66520fc0e1dab5b795a043a0fa28ff787817d`；artifact SHA256：`d0e852447341f88ce447b044d0b3888fc02ecf20e7f7cf0982b977ae30f4f075`。
- 实际模型编写，另一次独立模型调用审查。验收先核对允许的一行差异，再导入候选执行行为检查，避免任意模型生成脚本直接获得主机执行权。验收进程移除 API 凭据环境变量。
- 负对照：将原始有缺陷文件交给真实独立 reviewer，返回 `changes_requested`，带独立停止回执。没有把模型“通过”当作测试证据。
- 实际取消已准入的推理请求：run `ad44b01e-109a-4049-a6d6-16dfef941b35` 停在 `cancel_pending`，writer 为 unknown，未启动 freeze，保留准入和费用预留。HTTP 取消不能证明远端推理停止。

成功链从 16:27:31Z 至整批试点结束 16:29:49Z。成功图确认消耗 2,943 tokens；负对照 1,191 tokens（976 input / 215 output）；取消请求保留 32,768 tokens 预留，真实费用未知，**不计作免费或零成本**。这些是提供商 usage 和账本数量，不是账单结算金额。

## 试点发现并修复的问题

首次运行失败被保留：逐文件启动 `git hash-object` / `cat-file` 在真实仓库上耗时过高，freeze 179,139ms、验证工作区准备约 245 秒。改为受限的 `fast-import` 和 `cat-file --batch` 后，同一实际任务 freeze 13,213ms，review workspace 准备 22,382ms、test workspace 准备 40,734ms。未放宽工作区准备超时来掩盖问题。

批量读取保持原始字节、对象身份、长度边界、256 MiB 内容上限及 100,000 文件上限。Fable 独立复核指出协议 framing 不能挤占合法内容上限；修复后真实 Git 边界回归通过，最终审查 accept。详细性能说明见[性能报告](graph-runtime-performance.md)。

## 复现与保留

运行方式和 owner-only 配置见[使用指南](../guides/graph-runtime.md)；停止、核对、备份和禁用准入见[运行手册](../runbooks/graph-runtime.md)。脚本为 `scripts/verify-graph-internal-pilot.mjs`，输入真实凭据时只通过受保护环境，不把 key 写进参数、证据或 Git。

本机完整试点 home 保存在 `/Volumes/AIMATE_WORK/tmp/g30-final/pilot-batch/pilot-l3u7di`，其中含尚未确认的取消请求，不能删除锁来强制释放。证据归档包含[最终试点 JSON](../implementation/graph-upgrade-final-evidence/internal-pilot-batch.json)、[动作耗时](../implementation/graph-upgrade-final-evidence/pilot-timing.json)及首次失败记录。最终发布门槛统一见[收口报告](graph-upgrade-completion.md)。

本次证明内部单仓库、受控模板、有限预算、artifact-only 流程可运行；不是任意工具执行、无人值守生产发布或所有故障自动恢复的证明。
