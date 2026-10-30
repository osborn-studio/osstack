# PR312 最终 CI 独立核验

只读核验 run **41030888483**：PR head `418ffe02929845e73ef56372c8920b51a64b772d`，5 个适用 job success，Paid DeepSeek semantic smoke skipped。完整 log/metadata 及获取命令均保留；此前进行中快照未修改。

CI checkout 实际为 synthetic merge `084b291bb466caac718c41273c3045348948a548`，日志将 head 合入 base `abcd9edf008568d3c3d869df4afd9143b079ee64`（3795–3798 行）。不将其写成直接测试 head 或本地逐树一致。

22 个唯一包：**7302 passed / 7 skipped / 0 failed**。source package 的 manifest46 + watcher6 + source-snapshot34 = 86；不含下一批 adoption candidate。health **45/45**；feature-map40/40；reader14/14；journey43/43；projection89/89；maintenance25/25。导出测试 **94 总数、93 通过、1 跳过**，跳过原因是 CI 无全局 Codex home，测试不主动创建该目录。其余单脚本结果见 script-results.json，均 fail0。

日志中的真实 local Git smoke：默认两例 product0/1，full 五例 product0/1/2/1/0，全部 driver0；预期负例不是回归。维护结果 consistent/0，五行匹配，map/tool 前后哈希不变。两种 projection 都 projected 后 check valid 且对应 packet hash 一致。startup 中位数 version38ms（预算250）、help212ms（预算900）。提取的完整 smoke 回执见 actual-smoke-receipts.json。

未下载 artifact，未重新核验其成员字节、现场清理或源码/构建文件；这些仍是 CI 回执声明。此核验不是宿主使用、模型效果或正式 gate 资格，不覆盖跳过的付费 smoke。未更改 PR/Ready/看板。
