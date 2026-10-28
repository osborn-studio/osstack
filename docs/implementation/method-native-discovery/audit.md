# Sonnet 5.5 发布审计处置

实际 Claude CLI `claude-sonnet-5-5` 初审 `7f3d7a0e5310db61c61e4494110d736d7de0b57f`，结论 REVISE。初审确认 Claude 真实目录、Skill 展开、两份引用、模型、计数、冻结顺序和失败保留；未签发 runtime/J01 资格。

| 初审项 | 处置 |
|---|---|
| R1 测试与候选范围 | 明确全仓测试只绑定 4d6bb58d，排除后续文档；补完整 Git diff 范围和新双宿主导出逐字核对，另跑当前文档/导出检查 |
| R2 CLI 模式依据 | 增加实际版本/help 的摘要及 13 词摘录，区分帮助文本、局部源码解释与运行观测 |
| R3 Codex 表述过强 | 改为 shell cat 读取；显式列整体 inconclusive、H1/H2 和实际模型未知，不声称原生 Skill 事件 |
| R4 缺失/替代工件 | 纳入真实保留的旧 settings；列 prepared→final 只新增 53 项 Skill deny；列三份本地保留厂商摘录的 hash，公开包不承诺独立重放所有本机检查器 |
| R5 初始化记录性质 | README 明确 control_response 账号脱敏并重序列化，不将整个 JSONL 称作逐字 wire |
| R6 可能死链 | 核实命名副本原本已存在且逐字等于归档；补存在性及两份 hash。未发现所假设的实际缺链 |

其他范围说明：命名副本、清单由 Git 提交绑定；目录名和限额元数据属于保留的环境观测，HOME 替换不代表全面匿名；认证复用操作者账号，不证明独立身份或 refresh-token 无轮换；原 source acceptance 只审当时来源范围，不冒充最终文案审查。最终归档启发式扫描另记，不能证明不存在任意秘密。

原始意见与绑定见 [audit-first.tar.gz](audit-first.tar.gz) 和 [audit-first.json](audit-first.json)。原始提示词保留在本地并绑定 SHA；公开包不重新分发其中的厂商源码摘录。限定修订复审尚待执行，不提前标 PASS。
