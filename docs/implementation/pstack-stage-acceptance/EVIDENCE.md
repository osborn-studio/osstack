# 对账证据与边界

本轮是源码/历史证据追溯，没有执行新的48项产品验收。固定main e4643324、候选8e830561、原上游99b609a7、新上游4dd1d058分别绑定。

[完整原件归档](evidence/raw-verification.tar.gz) SHA256 `6fc0e7a39ad2503f22ea6275aa6e60ed78ec72c5cf6f3a1a3a8b93047ec62642`；[成员清单](evidence/manifest.json) SHA256 `7a98dfd4de14acff7b037681cb2ba514338b75d744beb78b30e63e6bad17a7f4`。151成员：129文件、22目录、无symlink，10196188文件字节。Root逐成员type/mode/size/hash核验；两个上游pstack源码tar及其SHA包含在内，不含clone的.git，也未安装/执行来源代码。

归档保留三代理最初阶段建议、24PS分段判断、48A/19W原given/when/then、原12项修订与22+47审计索引、五类源码对照、root纠正及来源绑定。原48条逐字与main原文件比对；19W集合完整；原FAILED/LIMITED与历史SHA不变。早期S1–S4建议是历史建议，不能替代原C0–C3。

原B报告的W13措辞容易让人误以为必须持续watcher；补充明确W13/A27/A28可以按只读分类器单独验收。原C包W状态是范围判断，不能机械等同A状态最差值；A26排除了未合并frontier作为完成依据。冻结原文与后续修订同时保留。

## 实际Sonnet5.5静态审计

首次结果 **PASS_WITH_CORRECTIONS（仅报告准确性）**，七项修订后限定 **PASS（仅R1–R7闭环）**。完整prompt、response、stderr、input manifest、时间及CLI modelUsage/canonicalModel均在audit/与audit-closure/归档。不是模型自报摘要替代原文；也不是独立provider/principal认证或宿主效果测试。Sonnet未自行查看底层Git或运行代码，审计不能替代Root/独立代理的来源核验。

七项修正：W级汇总规则；W10/事件intake归属；W01/W02及冷调用者前置；限定local试验依赖；W13与W10关系；A26来源归属；历史69新增JA与114继承场景的分母区别。之后仅做非阻断措辞澄清：W16分轴、完整文件路径、历史未重跑限制；不把闭环PASS扩成最终整个产品PASS。

原77文档/100合同/24摘要是历史设计检查；本轮241文档检查也只是报告/账本校验。产品full与新host实验未因本次对账而重跑。当前工具阶段仍待用户验收，原32J formal gate保持false。

[独立归档核验](evidence/archive-independent/report.json)逐成员确认151项，并核48A/19W唯一性、两上游tar摘要、两审计输入/response绑定；这是字节与来源校验，不是产品验收。报告SHA256 `5440aa7ab5887b78142d1756b77075fe5242869352da81903b4dcc7a099a3293`。
