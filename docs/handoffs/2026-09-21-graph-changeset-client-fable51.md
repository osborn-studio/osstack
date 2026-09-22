# P05a 交付与 Claude Fable 5.1 审计记录

日期：2026-09-21。分支：`codex/graph-decision-development`。本批基线：`4e3fa77`。

## 结论与范围

解除上一轮 CLI HTTP 500 造成的外部审计等待，完成实验性多文件提案客户端及真实 SQLite 门禁联动验证。未注册生产 executor，没有实现或启用真实文件 applier。本轮未向真实 Anthropic/DeepSeek/TypeSafe provider 发测试请求；Claude CLI 审计本身确实调用了用户指定模型。

[详细设计、host 接线契约和后续验收](../design/2026-09-21-graph-changeset-proposal-client.md)

## 审计证据

执行方式：Claude CLI print + `--model claude-fable-5-1 --effort medium --output-format json --disable-slash-commands --tools "" --safe-mode --strict-mcp-config --no-session-persistence`。通过临时文件 stdin 传入聚焦源码；审计没有编辑权限和工具调用权限。结果既有 CLI 辅助 Haiku 条目，也有明确的 `claude-fable-5-1` modelUsage，不能把辅助模型当作主模型调用证据。

| 轮次 | 主审计模型 | is_error | 完整 JSON 结果 SHA256 |
|---|---|---|---|
| review | claude-fable-5-1 | false | `b6a37821e7d5ee88f7f5575af52a36a3cfed7ebf3b0d7f8a63852a6bac6d79b5` |
| client | claude-fable-5-1 | false | `3f97a235b07247e3ff948f474d92238270b461733e0bab5396b8d3ac2531f798` |
| final | claude-fable-5-1 | false | `b18911915d00e5f735ae6f213ad2c5e117786a06ff3b33a63376a5fad7359de6` |

原始 CLI JSON 在本机任务临时审计目录，未提交完整会话日志；上述摘要用于本机核对，不保证临时文件永久保留。这里保存决定与依据。

1. **review**：局部 recovery 片段审计。提出两项疑似漏洞和未来接线缺口。
2. **client**：补充完整上下文与新客户端源码/测试。Fable 撤回 admission re-arm、failed project 两项判断，承认 inspectAdmission 已存在。建议处理空内容拒绝、错误脱敏、资源上限并补充取消/usage 测试。
3. **final**：复核修订后的客户端和 codec 源码。限定实验范围内未发现剩余明确正确性阻塞；明确未执行测试，不能代表生产接线审查通过。

采纳并验证：空 content opt-in；固定校验错误码；单客户端最多一个未完成传输；cache usage、超预算、取消与重入边界。另由本地审查发现并修复 UTF-8 解码丢失 BOM 导致响应摘要不再反映原始字节的问题。

未采纳：摘要相同即可解除 quarantine；未证明的 token 字节上界。模型 ID 不匹配仍为 unknown，只支持 host 固定精确 model；alias/fallback 留待专门设计。

## 验证结果

Node 22.22.1，隔离开发 worktree。无默认 OSSTACK_HOME 数据库访问。

- agents 全包：24 文件，350/350。
- core state：34 文件，452/452，含 invocation/apply SIGKILL 测试及新增两项 recovery 复现。
- 合计 **802 个不同测试**；fixture 类型修正后的 SQLite 联动重跑不重复计数。
- agents build（严格 TypeScript 编译）通过；core typecheck 通过。
- 7 个变更 TS 文件 Biome 通过；inventory freshness、git diff --check 通过。
- 构建后从 agents 包上下文导入新实验子路径成功。首次在根目录测试导入失败，因为根包没有该 workspace 依赖；并非子路径导出缺失。
- 新增测试经历 RED→GREEN：缺少接口、超预算/BOM、空 content、错误码及挂起请求边界。
- 首轮构建发现测试 program 字面量类型推宽，补 `as const` 后重新构建通过；未以测试通过代替类型检查。

## 后续工作，不是本轮已完成能力

1. 生产 host 授权与 token 上限证明、request/response artifact、停止凭证接线；联动测试 gate 明确是 fixture。
2. 付费请求 gate 的掉电持久性策略；WAL NORMAL 的进程崩溃测试不证明掉电保证。
3. 真实 Git 多文件 journal/applier、路径/inode 复核、物理树验证、跨 run quarantine 管理。
4. 通过以上验证后再做 owner enrollment、CLI/registry 激活及付费 canary。

这些是下一阶段开发工作，不再是等待 Claude 审计返回的外部阻塞。旧单文件写手保持兼容，未用扩大 capability 声明冒充多文件实现。
