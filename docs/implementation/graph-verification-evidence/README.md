# C6 验收证据

已通过限定 C6；源码 `00571bb862f27d9ab8e2e502d33e588196d62fee`，3160 项全库测试、22 个测试包，实际 Loop 1 executed / 0 skipped / success，六项 verifier 全部通过。

- [准入与限制](admission.json)
- [实际 Loop 结果](acceptance-result.json)、[全库测试](accepted-full-tests.txt)、[源摘要](source-hashes.json)
- [真实 worker 恢复摘要](worker-replay-proof.json)：SQLite 与 shell 日志读取，临时目录保留可复查；只有一条 join、命令一次。
- [actor 执行摘要](actor-summary.json)：轻量 diff-only gate 不代表全库验收。
- [Claude 裁定](claude-adjudication.md)、[真实模型调用](claude-models.json)；四轮原始 prompt/JSON/Markdown 全部保留。
- [完整构建](build-final.txt)、[25 个源文件 Biome](biome-final.txt)、typecheck/schema/G07/C2/startup 日志。

RED/GREEN 文件名是历史运行标签，部分 early-green 日志仍含失败；最终结论只以 admission、acceptance-result 和 accepted-* 为准。失败日志保留实际产品反例和夹具修正过程：工作区防改写/会话隔离、retry grant 撤回、输出长度，以及旧收据注入被 SQLite immutable trigger 拒绝。没有把夹具初始错误算作产品缺陷。

原始临时工作区 `/Volumes/AIMATE_WORK/tmp/gc6` 保留实际候选仓库、SQLite、收据；这里仅归档文本证据，不提交数据库、socket 或本机控制面配置。完整 code-delivery-v1 与生产准入仍待后续任务。

原始日志的空白字节保持不变；目录内 `.gitattributes` 仅对原始日志禁用 whitespace 提示，沿用 C5 做法，不排除源码或计划文档检查。
