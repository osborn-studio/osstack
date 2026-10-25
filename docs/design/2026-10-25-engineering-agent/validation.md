# 本次交付与验证记录

日期：2026-10-25。范围：详细设计、机器可读注册表、原始行为核验。**没有新增生产主控运行时；没有宣称等待决策端到端试点已经完成。**

## 已交付

- 架构设计：单一入口、持久 Mission、确定性控制器、模型规划、执行器选择、权限、恢复、完成证明与默认用户流程。
- 24 项行为注册表及严格 JSON Schema。每项记录原始来源、现有实现、集成缺口、依赖、验收与禁用状态。
- 74 个固定版本源码/测试引用及 SHA-256。深读的契约与仅核实路径的映射明确区分。
- 等待决策纵向试点：接口、类型、状态轴、事务、竞态、故障、自动移植和回退。
- 66 个机器可读的待实施场景，37 个有依赖和验收的工作包。
- 原始材料清单、专家方法、独立验证工具、改写后的题目与完整任务说明。

## 本次实际执行

| 检查 | 结果 | 证据与限制 |
|---|---|---|
| JSON Schema 与编号完整性 | 通过，24 项 | [设计检查回执](https://github.com/osborn-studio/osstack/blob/cf3bc68c71c336b59d0b3735b24bcd22209813b0/docs/design/2026-10-25-engineering-agent/evidence/design-validation.json) |
| 能力依赖与工作包依赖 | 通过，无循环、无未知依赖 | 37 项工作仍为 planned，不是已导入任务 |
| 原始 Git 对象与 SHA-256 | 74/74 一致 | [来源清单](sources.json)；不等于所有文件完成语义审计 |
| Claude Code 设计审计 | 4 轮成功返回指定模型 | 最后定向复核无剩余 P0/P1；权限 P2 及实际验证仍待完成，见 [审计报告](audit-report.md) |
| 注册表非法样本 | 5/5 拒绝 | 重复 ID、未知依赖、循环依赖、错误启用、缺失来源 |
| Firstmate 决策键原始测试 | exit 0；23 条 `ok -` | [原始日志](https://github.com/osborn-studio/osstack/blob/cf3bc68c71c336b59d0b3735b24bcd22209813b0/docs/design/2026-10-25-engineering-agent/evidence/fm-classify-decision-key.test.sh.log) |
| Firstmate 未决问题展示测试 | exit 0；9 条 `ok -` | [原始日志](https://github.com/osborn-studio/osstack/blob/cf3bc68c71c336b59d0b3735b24bcd22209813b0/docs/design/2026-10-25-engineering-agent/evidence/fm-wake-drain-open-decisions.test.sh.log) |
| Firstmate 回答关闭测试 | exit 0；24 条 `ok -` | [原始日志](https://github.com/osborn-studio/osstack/blob/cf3bc68c71c336b59d0b3735b24bcd22209813b0/docs/design/2026-10-25-engineering-agent/evidence/fm-send-resolve-key.test.sh.log) |

三组上游测试共 56 条通过断言。它们在初版设计时运行固定 Firstmate 提交中的真实脚本，使用其测试 fixture 和隔离临时目录；本次 Claude 审计沿用这些明确标注的原始日志，没有把它们计作新跑的测试。它们验证上游原始行为，不验证 OSStack 的新主控。日志中的 `WAKE_ACK_REQUIRED` 是测试输出，不是本设计的待执行操作。

本次新增 Claude Code CLI Fable 5.1 四轮挑战审计（末轮为定向复核），实际请求与服务返回的模型标识均为 `claude-fable-5-1`。执行记录、原始意见、源码核验与修订结论见 [审计报告](audit-report.md)。模型意见不能替代运行时测试。

本设计检查命令：

```sh
python3 docs/design/2026-10-25-engineering-agent/validate-design.py --verify-sources
```

原始测试命令（在固定 Firstmate 克隆中，TMPDIR 指向 scratch 下本次测试目录）：

```sh
bash tests/fm-classify-decision-key.test.sh
bash tests/fm-wake-drain-open-decisions.test.sh
bash tests/fm-send-resolve-key.test.sh
```

[上游测试索引](https://github.com/osborn-studio/osstack/blob/cf3bc68c71c336b59d0b3735b24bcd22209813b0/docs/design/2026-10-25-engineering-agent/evidence/upstream-results.json) 保存初版设计期间的原始日志摘要。没有复用历史报告中的 81 条或全仓测试数量；本次修订重新运行设计一致性与固定源码摘要检查。

## 本次未执行、不得算作通过

- 新工程主控的端到端运行。该运行时尚未实现。
- 新协议在真实 Claude/Codex Session 中的回答、继续、重启和取消。
- Loop/Graph 自动路由与真实候选交付。
- TLC、fast-check、Stryker 的新运行时验证；这里交付的是使用方法与验收要求。
- 对此新设计运行 OSStack 全套测试。没有更改生产 TypeScript；旧版本测试通过不能认证新架构。
- 真实远端、macOS/Linux 后台服务、权限隔离、物理断电、长时稳定性与独立用户实验。

## 工作区与发布状态

新增内容集中在本目录。没有修改已有生产源码，没有创建 PR、合并或发布。原工作区的 107 条既有修改未由本次设计操作处理；新增目录使状态条目增加 1。

下一项运行时交付应按 [实施计划](implementation-plan.md) 从最小 Mission 存储与等待决策事务开始；注册表协议可并行推进，不阻塞第一个已有 Session 的采纳试点。把实际通过的事实写入新的候选证据包。不能直接把当前 JSON 的 `runtime_enabled` 改为 true 作为上线动作。
