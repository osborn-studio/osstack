# N0 审计与定向验证

代码候选 `380e2c618bd5060e2f556f5108fb229d169c932b`；这份归档的后续 commit 只增加审计证据，不改变门槛规格。

Claude CLI `claude-sonnet-5-5` 首轮给出 REVISE，保留原文和原始响应。确认问题已修订，第四轮给出 PASS。每轮输入、完整输出、源摘要和候选 SHA 均归档；gzip 文件解压后的摘要见 manifest。首轮与次轮候选不同，不将旧候选审计当作新候选验收。

定向验证：113 项设计测试，Python -O 同113项，128项账本验证器测试。独立代理14个预冻结变异、19个审计后回归（原J05前置反例明确退休，替换为拒绝E0耦合）均按预期拒绝。原始命令与输入字节的全量独立归档由主控另行保存，当前保留结果、运行命令、脚本、原始stdout/stderr和冻结oracle。

这些检查证明设计约束及其拒绝行为；不证明未来runtime、真实host授权、独立principal认证或任何产品gate完成。所有72个联合场景均未运行。全仓测试由主控在整合候选执行，结果不在本分支冒称。

完整审计原文：[首轮](round1-report.md)、[二审](round2-report.md)、[三审](round3-report.md)、[最终复审](round4-report.md)；处置：[首轮处置](round1-dispositions.json)、[二轮处置](round2-dispositions.json)、[三轮处置](round3-dispositions.json)。
