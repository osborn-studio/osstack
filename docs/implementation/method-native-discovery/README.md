# OSStack 方法包：原生发现与读取实测

#291、#292 已合入 `ca95aba1c186d9c3a9e70a45143b7a277db84404`。本轮验证项目技能包能否被真实宿主发现并选用，不将材料提示词模拟视作原生集成。测试对象为已合并的方法包，产品源码没有改动。

## 当前证据与范围

| 范围 | 实际观察 | 判定边界 |
|---|---|---|
| Codex CLI 0.160.1 原生目录 | 隔离 app-server：无包组 0 个目标技能，有包组准确列出 4 个目标技能 | 目录进程与执行进程分开，不能宣称同进程目录遥测 |
| Codex CLI 实际读取 | 两次真实执行均退出 0；有包组读取 `osstack-help`、`osstack-mode` 及 evidence/maintain-verification 材料；无包组不虚称使用技能 | 同提示词有包/无包；193/286 词；没有运行产品验证驱动 |
| Codex 模型 | 隔离认证 `model/list` 唯一默认 `gpt-6.1-sol` 被明确请求 | exec 流没有实际解析模型标识，记为 `not_attested` |
| Claude CLI 2.1.291 初始预检 | 隔离认证成功；SDK initialize 控制响应两组均列出 53 个内建 commands、0 个目标技能；未发用户回合 | 仅本次预检阻塞，不能推出 Claude 不支持项目技能；SDK commands 不是冻结标准所要求的 system/init 技能观测 |
| 工作区不变性 | 已保留的普通文件内容哈希一致 | 原 harness 漏记 `.git`、文件类型和长度，缺少完整 before；不能补造历史证据或把 posthoc 清单当 before |
| 合并后全仓回归 | fresh install/build 后 `pnpm test`：7144 通过、5 跳过、0 失败，退出 0 | 实际测试 HEAD `4d6bb58d446da32a3044d5375baa7f2f935eddf2`；该全仓测试不覆盖之后的文档改动，产品路径相等另由 Git 差异核对；最终文档/导出检查及发布 CI 单独记录，不重标旧测试 |

独立标准在任何新模型响应前冻结。Codex 的原生目录、选择和材料读取可单独成立，但不变性和模型观测仍须逐项保留判定；本批不签发完整宿主资格。初始失败和证据缺口保留，不通过事后降低标准取得 PASS。

## 后续判定约束

原生目录发现不等于全部四个入口已经消费；显式要求使用 help 不证明隐式路由；方法建议不等于实际 doctor→drive→observe→cleanup 旅程。单次有包/无包观察不能建立因果收益或宿主等价。Codex App、Claude 其他运行方式、J01/J11 正式门槛均未由本轮验收。

Exporter 的 `host_discovery_verified: false` 是导出器能力边界，不能因外部实验改为 true。已有作者、许可证、来源和历史不变。

## Claude 初始化诊断

在不发送用户回合、不启用工具的两次初始化对照中，固定私有 HOME、认证方式、empty MCP、禁 hooks 和项目材料，只改变 `restricted`：开启时 53 个 commands、0 个目标技能；关闭时 57 个 commands、4 个目标技能。两进程退出 0，私有认证环境已清理。这支持本次环境中的配置门槛解释，不等于实际 Skill 消费通过。后续实际回合使用独立修订协议，先复核受限的文件读取权限并冻结标准，不能将诊断改写为原预检成功。


## Claude v2 实际调用

使用新建的两组工作区，在响应前冻结原标准、同一提示词、runner、配置、原生可调用名称集合和全部导出文件。配置保留只读工具、原生工作目录读取边界和明确的例外目录拒绝规则；不宣称 OS 级隔离或穷尽隐藏的宿主能力。总计仅 4 次实验模型调用（Codex 2、Claude 2），均无重试；初始化诊断没有模型回合。

Claude v2 的同进程 `system/init.skills` 分别记录 0/4 个目标技能。实际 `Skill(osstack-help)` 成功展开正文，随后原生 Read 返回 evidence 和 maintain-verification 两份参考材料。无包组明确表示没有使用该技能。最终回答分别 329/345 个空白分隔词，均低于冻结的 350 词上限；init、assistant 和 modelUsage 均标识 `claude-sonnet-5-5`。两进程自然退出 0，含 `.git` 的完整前后清单一致。

这些结果支持当前版本和配置下的显式 help 选择及材料读取，不证明其他三个入口已消费或验证驱动已执行。Codex v1 的完整前态缺口仍保留，不能用 Claude v2 的通过补认。最终分项判定与清理记录随独立报告和原始归档交付。


## 证据归档与清理

全部实验自有工作区和私有认证目录已删除；精确导出材料、原始模型及工具事件、失败预检、修订协议、事前冻结标准和独立评分保留。原始回合记录未被清理结果覆盖。完整测试日志的公开副本仅替换本地 HOME 前缀，原始日志及其摘要仍保留；广范围管理看板和供应商实现片段不进入公开归档。

归档及逐成员哈希见 [manifest.json](manifest.json) 和 [evidence.tar.gz](evidence.tar.gz)。清理证明限于本次拥有的进程退出及文件路径，不宣称整个后代进程树或整机副作用证明。


独立最终判定：Claude v2 无包组 `passed_negative_control`，有包组 `passed_named_discovery_and_read`，均限当前 CLI、配置与显式 help 请求。参见 [v2 评分](v2-graded-results.md) 和 [v1 有限结论](v1-graded-results.md)。原标准及 v1 原始证据没有被后续结果改写。


## 发布时的证据解释

Codex v1 整体仍为 `inconclusive_observability`。除完整前态遗漏外，catalog helper 的 PID/起止时间没有捕获，指纹仅覆盖 Node launcher、未单独绑定 vendor 可执行文件，实际解析模型未暴露；已观察到的执行是 shell `cat` 读取导出路径，并非被原始流证实的原生 Skill 调用。

Claude initialize 的 `control_response` 为账号身份脱敏后重新序列化的记录；模型、工具事件原始行保留，不能把整个 JSONL 文件笼统称为逐字原始 wire。材料和评分文件是原归档的命名副本，逐字摘要与存在性另在发布核对中验证。归档清单由 Git 提交绑定，不自包含自己的摘要。

凭据隔离指使用私有配置目录与临时认证副本/进程内 token，仍复用操作者已有认证；没有证明独立账号、默认 Keychain 全写入审计或 refresh-token 未轮换。扫描只报告已检查文件未发现所用模式或已知值，不证明不存在任意秘密。公开原始事件保留环境路径、用户名和宿主限额元数据；测试日志的 HOME 替换不是全面匿名化。

原 source acceptance review 只复核当时的来源及范围，未声称审过最终 README。最终文案由本轮 Sonnet 审计和限定修订复审单独绑定。


[候选源/导出核对](candidate-source-proof.json)明确 whole-tree 与产品路径的区别；[工件保留与替代说明](artifact-dispositions.md)列出初始/最终配置及公开排除项；[CLI 帮助依据](public-help-evidence.json)不是行为测试；[Sonnet 审计及处置](audit.md)保留初审原文。
