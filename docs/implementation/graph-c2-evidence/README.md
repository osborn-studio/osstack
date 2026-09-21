# C2 证据索引

当前结论见 [验收报告](../2026-09-13-graph-c2-completion.md)和 [admission.json](admission.json)。C2 仅准入 Functional + sync 供 M1 集成，生产运行时未实现，StateGraph 反例仍有效。

- **执行来源：** `controller.mjs.txt`、`executor-prompt.txt`、`executor-events.jsonl`、`result.json`、`STATE.md`、`LOOP-STATE.json`。实际 OSStack LoopEngine 使用 CodexCliAdapter；捕获的工作区 changed_files 包含监督者并行改动，不能据此归因所有文件均由子执行者修改。
- **最终验收：** `acceptance.mjs.txt`、`acceptance-result.json`、`acceptance-STATE.md`、`accepted-*.txt`、`build-final.txt`。最终源码绑定见 `source-sha256.json`；工作开始时 commit 为 937c87d，验证时未提交，后以相同字节提交为 b230eb5。
- **最终矩阵：** `node26/summary.json`、`node26/experiments.json` 与所有 `*-cut.json`；保留每个进程退出后、下一阶段前的 checkpoint/RETURN/ledger/count。工作夹具已清理。
- **跨版本：** `runtime-final.json`、`runtime-final.py.txt`，`node20/`、`node20-floor/`、`node22/` 各自的 summary、experiments、测试日志和重点 sync 故障切面。全部源码稳定；早期变化中的通过结果不作为准入证据。
- **负例与 TDD：** `baseline-red.log.txt`、`functional-entry-red.txt`、`ledger-red.log.txt`、`journal-red.log.txt`、`journal-validation-red.log.txt`、`run-gate-red.log.txt`；对应 GREEN 由最终 helper/graph/矩阵日志支持。`unknown-before-run-gate.json` 保留修复前夹具行为。
- **独立监督者复现：** `parent-functional-smoke.json`、`parent-functional-cancel.json`、`parent-explicit-resume.json`、`parent-cache-identity.json` 及相应 `.mjs.txt`。这些初始探针不是最终完整准入矩阵。
- **模型挑战：** `claude-design-review.md`、`claude-functional-review.md`、对应 prompts/metadata，以及 `review-adjudication.md`。真实调用含 claude-fable-5-1；Haiku 仅记录为辅助模型。
- **版本来源：** `registry-*.json`、`upstream-main.json`，读取时点 2026-09-13；精确依赖以代码 lockfile 为准。

`executor.md` 是实验执行者的报告，描述其临时原始证据目录，含未全部入库的探索日志；本目录以上列出的最终证据为主。`supervisor.md` 是实施时交换的约束记录。探针代码在仓库 `scripts/`，测试夹具位于 `scripts/fixtures/`。

这里保存解码后的 JSON 证据和有界日志，不保存控制面 DB、原始 journal.wire、node_modules 或运行时二进制。`.mjs.txt`/`.py.txt` 是实际控制器与探索脚本的审计快照，其中绝对路径记录当时环境；可移植复现应运行仓库正式 probe/helper/test 命令。文本日志归档时仅统一行尾空白及末尾换行，原始临时日志保留。
