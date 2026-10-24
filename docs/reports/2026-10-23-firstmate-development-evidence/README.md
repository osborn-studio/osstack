# Firstmate 开发证据

入口：[开发报告](../2026-10-23-firstmate-development.md) · [指南](../../guides/attention.md)。这里是实际本地开发与验证记录，不是生产部署证明。

- [queue-index.json](queue-index.json)：25 个原计划任务 + 1 个最终审计修复验收，共 26 个成功 gate；保存父失败任务和 native retry 关系。各 `*-loop.json` 为原生回执，不以手工状态替代。
- [final-checks.json](final-checks.json) / `final-*.log`：最终全仓 build、typecheck、test、schema、启动预算、工作区和暂存 diff 检查；[test-counts.json](test-counts.json)记录 2,520 个通过测试。
- [source-manifest.json](source-manifest.json)：最终受测工作区源码 SHA256。测试基于当前含用户既有 WIP 的工作区，不是 clean-checkout 或发布构建证明；core index 的既有 scratch export 不纳入本次提交。
- [runtime-pilot.json](runtime-pilot.json)：真实隔离 daemon + Unix RPC + Claude Code Stop hook。100 subject / 1,000 历史 turn；吞吐是短时补扫，不能外推长期 soak。
- [harness-hooks.jsonl](harness-hooks.jsonl)与[harness-cancel.json](harness-cancel.json)：真实 2.1.291 事件；SIGINT 没有 Stop 事件。没有离线 watchdog 承诺。
- [baseline.json](baseline.json)、[initial-status.txt](initial-status.txt)：开发开始的来源状态。`pre-wave4-final-*` 保存追加修复前的一次完整验证，不能替代最终结果。
- [research-plan-before-implementation.txt](research-plan-before-implementation.txt)：研究结束时计划原文，逐字 hash 匹配旧研究目录的 artifact-manifest。现行计划增加实施状态，因此旧研究清单与检查脚本是历史快照，不能用于宣称当前生产源码仍与研究基线一致。

## 独立静态审计

Sonnet wave1–3 按先前要求执行；随后遵循最新指令，Haiku wave1–5 审计与补证。每轮 `*-context.md` 是冻结输入，`*.json` 是原始 CLI 输出，`*.md` 是 raw.result 原文，`*.stderr.txt` 是诊断。未编辑原始意见。最终[wave4](haiku-wave4.md)排除 C1–C4，[wave5](haiku-wave5.md)补核 schema/路径并保留非阻断限制。提示词中的非项目枚举名称误述已在开发报告明确纠正，没有修改旧输入。

真实命令使用 `claude --print --model claude-haiku-5-5 --output-format json --tools ''`，配合禁用 hooks/plugins/auto-memory 的临时 settings、空 MCP、`--setting-sources ''` 与 `--no-session-persistence`；输入经 stdin。回执 `modelUsage` 与 `is_error` 可核对；stderr 的 unrecognized_model 也保留。这证明请求和工具响应，不能独立认证供应商映射。审计没有运行测试或替用户审批发布。

## 可重放材料

`pilot.py`、`gates.py`、`gates-native-retry.py`、`final-checks.py` 记录本机实际流程，包含绝对路径；移植时先替换为显式隔离 home/scratch，不能指向默认控制面。不要直接在已完成任务上覆盖历史回执。`finalize.py` 是本次证据整理脚本，`artifact-manifest.json` 绑定归档文件；其自身不纳入自身 hash。

归档说明：源码摘录和审计 context 保留原始行尾空格；`.gitattributes` 仅对这些冻结输入关闭 whitespace lint，不改写其 bytes/hash。产品源码和手写文档仍执行正常检查。
