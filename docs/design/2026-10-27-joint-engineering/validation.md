# 联合设计修订 3：实际验证记录

日期：2026-10-27。这里只记录本轮实际运行的文档检查，不把规划场景标为产品通过。此前修订 1 的输入与结果保留在审计归档，旧 27 tests / 48 JA / 28 fixtures 属于旧候选。

| 本轮检查 | 实际结果 | 证明范围 |
|---|---|---|
| 文档校验器回归 | 77 tests passed | 包括删除旧场景/gate、弱化许可/摘要/材料约束、漏未知/迁移队列/语义断言等坏设计 |
| 设计/schema 检查 | 100 fixtures：18 合法形状、82 拒绝例 | JSON 结构与本地语义；不是授权、数据库或 Provider 证明 |
| 摘要规格 | 24 个正向量由 Python 文档校验器与 JavaScript 参考实现匹配；5 个非法输入由 Python 拒绝 | 文档字节规则；尚未验证产品 TS 实现互操作 |
| 来源身份 | 227 锚点、224 个不同固定 Git blob；pstack 200 个子树文件另验 hash | 来源身份与库存分类，不声称全部源码逐行重读 |
| 规划覆盖 | 48 来源能力、32 联合工作包、69 原任务、124 阶段 gate、53 语义断言 | 机器映射与结构完整性；语义仍须独立审查 |
| 原验收继承 | 66 Firstmate + 48 pstack 原场景逐项保留 | 原状态不变；同候选重新运行义务未解除 |
| 新验收规格 | 69 个 JA 场景全部 specified_not_run | 本轮运行时验收数量为 **0** |
| 工作区范围 | 3709 个受保护文件核对，无非预期变化 | 联合目录外仅 pstack 能力映射、Firstmate addendum 两份文档变化 |
| 模型审计 | Claude CLI 实际模型 Sonnet 5.5，完整 review + challenge，47 条意见逐项处置 | 模型意见不是生产正确性证明；最终复审状态见审计报告 |

证据：[设计与固定来源检查](evidence/sonnet-audit-2026-10-27/candidate-design-checks.json)、[首个候选53项测试日志](evidence/sonnet-audit-2026-10-27/candidate-validator-tests.log)、[摘要参考核对](evidence/sonnet-audit-2026-10-27/digest-reference-check.json)、[库存核对](evidence/sonnet-audit-2026-10-27/source-inventory-check.json)、[范围核对](evidence/sonnet-audit-2026-10-27/scope-check.json)。最终复审及后续修订的验证结果在 [claude-audit.md](claude-audit.md) 记录。

复现需要完整仓库（包括历史 pstack 报告及审计归档）、Python 3、jsonschema >=4；JavaScript 参考核对另需 Node：

```sh
PYTHONDONTWRITEBYTECODE=1 python3 docs/design/2026-10-27-joint-engineering/validate-design.py --verify-sources
PYTHONDONTWRITEBYTECODE=1 python3 docs/design/2026-10-27-joint-engineering/test_validate_design.py
node docs/design/2026-10-27-joint-engineering/test_digest_vectors.mjs
python3 docs/design/2026-10-27-joint-engineering/evidence/sonnet-audit-2026-10-27/validate-audit.py
```

未运行：产品 build/typecheck/Vitest、真实 Provider、真实 hold/迁移、复现驱动、故障/变异产品 harness、E0/E1/E2、冷用户试用、合并队列或发布。O01–O06 均保持 open，分别阻止对应实施/合并/试验/资格阶段。没有打开 OSStack 默认或服务数据库，没有提交产品 PR，没有发送跨会话消息。

修订3实际复验日志：revision3-design-checks.json、revision3-validator-tests.log、revision3-digest-check.json；均在 evidence/sonnet-audit-2026-10-27。新增验证包含原gate传递闭包、case消费边、单迁移证据、合法oracle冻结及主体身份、broker证明与费用上限。

最终文档验证：77 tests、100 fixtures（18合法/82拒绝）、124 stage gates、24正向量+5非法输入；见 [最终设计/来源检查](evidence/sonnet-audit-2026-10-27/final-design-checks.json)、[最终测试日志](evidence/sonnet-audit-2026-10-27/final-validator-tests.log)、[最终摘要核对](evidence/sonnet-audit-2026-10-27/final-digest-check.json)。这些结果覆盖修订后的文件，早期candidate/revision3日志保持各自历史数字。

最终针对性复审为 PASS_WITH_CONCERNS，CF01–03关闭。其非阻塞意见另核对：revision3与final两组日志都真实存在；补default-enable三个原资格门槛删除回归（总77个test方法，含3个子例）；历史CO处置中的JADR13保留原编号，最终映射到JADR15，当前JA51/52无错误ADR引用。产品实现尚未开始。
