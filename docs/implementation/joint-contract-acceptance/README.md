# JP-01c 组件回归交付

基线为 `3192b424174e5eb977d640cc0418e67c6b1461d1`；最终受测、受审代码为 `74ec436d28f3f134451d45e35536c5747a7f1cba`。本目录是其后添加的证据归档，不能把归档提交号冒充原始受审号。

本批只修改两个 protocol 测试文件，新增固定测试样例和独立语言的 Python 严格解析/摘要校验程序。产品实现、原 `reference-vectors.json`、联合设计、门槛状态及中央账本均未修改。

## 已验证范围

- JA59 相关回归：63 组原始输入（20 合法、43 非法）、20 个摘要域、18 个声明的 helper；验证 UTF-8、重复键、数值/Unicode、域分隔、ASCII/UTF-8 排序以及大小/深度边界。
- JA70 相关回归：32 类组件、323 个顶层必需字段删除，以及类型/版本/未知字段、固定规范字节摘要和 14 项 Binding/Proposal/Recipe 身份或角色替换。10 个 optional/conditional 条目中有 9 个实际字段删除，另一个是字段原本缺省的正控制；不夸大为 10 个有效删除变异。
- 最终代码的 547 项定向测试、完整 protocol 的 21 个文件/1,012 项测试、protocol typecheck、Python `-I -O` 均通过。20 个实际源码变异全部被断言捕获；未变异正控制通过。全仓测试由主线程统一管理，本代理未运行全仓测试。
- 实际 Claude CLI `claude-sonnet-5-5` 首轮 REVISE，确认问题修订后第二轮 PASS；两个原始意见完整保留。第二轮仅认可本次有限组件回归，不认可任何 gate 或真实主机资格。
- 另一代理独立通过 27 项 TS/25 项 Python 观察、32 类 schema 字段与固定摘要核对、46 项精选作者测试，并用两种源码变异同时挑战作者测试与独立输入。

## 重要边界

这不是正式 JA59、JA70 或 `J01.contracts` 通过证明。固定预期与实现由同一模型会话编写；原预冻结及审计后的 v2/v3 修订分别保留。独立复核是在候选存在之后开展，也不证明可信 principal 或正式前瞻 oracle。嵌套联合状态、完整错误路径矩阵、主机授权、完成证据和运行时验收均未因此完成。

Python 是独立语言的 wire/canonical/hash 实现，不是第二套完整 Zod 语义验证器。所有“覆盖”均以上述具体测试边界为限。第二轮 10 项非阻断建议保留在 [逐项处置](round2-disposition.md)，后续任务可据此继续补强。

## 原始证据

- [交付清单](delivery.json)、[执行命令/退出码/摘要](validation.json)、[变异结果](mutation-results.json)、[完整交接](handoff.md)
- [首轮原始审计](audit-round1.md)、[首轮处置](audit-disposition.md)、[第二轮原始审计](audit-round2.md)、[独立复核](independent-review.md)
- [作者原始证据包](author-evidence.tar.gz)：191 个原始载荷及内置 manifest，包含完整输入、输出、失败、预冻结、执行脚本和真实 Vitest JSON。隔离变异副本可由固定 Git 对象与 `mutate.py` 重建；未打包 node_modules 或运行 home。
- [独立复核原始证据包](contract-independent-evidence.tar.gz)：原包逐字节保存，先核对 SHA-256 和所有成员的安全路径。
- [逐文件清单](evidence-manifest.json)、[压缩包校验值](archive-checksums.json)

首轮隔离运行因外部 setup 路径未加载而执行了 0 项测试，修复测试环境后重跑；审计后 v2 的新顺序断言发现单元素测试样例不能证明顺序，保留失败并在 v3 加入第二个固定元素。这些是测试环境/样例问题，不计为产品缺陷或通过证据。
