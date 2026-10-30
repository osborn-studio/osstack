# PR311 终态 CI 独立日志核验

本次输入快照显示 **5 项适用 SUCCESS，Paid DeepSeek SKIPPED**。run `41014856944`，PR head `f70f40265ddfb1e419d6b8f5145d46c71060b9bc`。实际 check job checkout 为合成 merge `7aec62e116a37788b283e0634f4e0163f9755c81`，日志明确将该 head 合入 `01ec1852ffcf0cff4f1e4a0632b1ae3a8ddc1211`；不把 head 与实测 checkout 混为同一 SHA（原日志 3746–3749 行）。

`check/Test` 仅取每包唯一 `Tests` 汇总，**22 包、7259 passed / 7 skipped / 0 failed**，总计 7266。没有累加 Test Files、四个 matrix 或后续定向 suites。原日志包含 literal `^[[...m`，parser 同时去除该可见转义及 ANSI；本独立 parser 首次执行成功，无独立解析失败。父目录既有解析失败原件未改。

| 定向步骤 | 总数 | 通过 | 跳过 | 失败 |
|---|---:|---:|---:|---:|
| Method export contracts | 94 | 93 | 1 | 0 |
| Relevant feature-map selection contracts | 40 | 40 | 0 | 0 |
| Method material pagination contracts | 14 | 14 | 0 | 0 |
| Method verification journey contracts | 43 | 43 | 0 | 0 |
| Skills map maintenance contracts | 24 | 24 | 0 | 0 |
| Model evidence projection contracts | 88 | 88 | 0 | 0 |
| Session adoption decision smoke (local fixture) | 27 | 27 | 0 | 0 |
| Skills check verification (local Git fixtures) | 25 | 25 | 0 | 0 |

Exporter 唯一 skip 是全局 Codex home 不存在，因此没有创建该目录来测试拒绝写入（原日志 8484 行）。这不是 94 项全部通过。

## 实际旅程与证据投影

- 默认旅程：healthy / missing-ref，产品退出 0 / 1，产品状态 healthy / failed；driver 均 0、verification passed。日志顶层 status passed，formal_gate_pass false。
- full 旅程：healthy / missing-ref / drift / mixed / empty，产品退出 0 / 1 / 2 / 1 / 0，产品状态 healthy / failed / drift / failed / empty；driver 均 0、verification passed。默认与 full 各行日志均报告 cleanup passed、fixture_removed true。
- map maintenance：consistent / exit_code 0；五行 matches true；map before/after 摘要相同、unchanged true；内部 full journey passed，产品五退出及 driver 结果与上表一致，failure null、subsequent_failures 空。
- 默认与 full 投影各实际输出 projected 后 valid，两回执各自 packet_sha256 相等；input_opened_read_only true、original_evidence_revalidated false、formal_gate_pass false。命令及原行号保存在 projection-receipts.json。

这些是完整 CI 日志中实际输出及步骤成功状态的核验。没有下载 artifact，未对 runner 文件、manifest 成员或 fixture 不存在事实重新验真；日志中的 hash 相等不能称本机重算 artifact hash。没有产品/全仓/模型重跑、源码审计或 PR/账本写入。PR-before 是下载时 Draft/OPEN 快照，不宣称后续状态，也不签完整 W18/A35/A48/C0。

原始输入三文件的字节数/SHA-256 在 input-hashes.json，逐包与定向原文行号在 package-summaries.json、targeted.json；parser、raw parser stdout/stderr 与独立提取 JSON 随 manifest 一并封存。
