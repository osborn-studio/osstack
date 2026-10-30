# C0/W17：既有工具的冷读使用与输入恢复

本批只补已有固定五案例工具的使用教程和实际使用证据。#310 已由 gilberthello 合并；实际 main `01ec1852ffcf0cff4f1e4a0632b1ae3a8ddc1211` 与其发布候选树完全一致。用户明确要求先不进入 Firstmate 深运行时，本批遵守该顺序。

## 范围

[教程](../../verification/method-control-tutorial.md) 在 root 预先安装并构建的隔离 checkout 中使用既有维护入口。预先书写的判据（SHA1830eb1f）按root记录先于本次执行；cold-freeze未包含criteria哈希，先后顺序没有独立事件时间戳证明；作者只写教程，新的协作子代理请求 `fork_turns=none`，派发内容为教程、任务输入和环境路径，实际接收的完整上下文未经外部审计。该 API 请求不等于操作系统隔离，也不证明独立主体或原生宿主资格。

输入由协调者按冻结判据故意删去一行，模拟无效地图；这是输入恢复练习，不是新发现的产品缺陷。恢复限定为修正自有地图副本、使用同一 CLI 和新输出目录；不改产品、不放宽负例、不覆盖首次错误。

## 当前结果

真实调用在 2026-10-30 完成：首次返回 `2 / blocked / map_case_set`，未创建输出目录；执行者从教程公开五行契约判断缺少 `empty`，仅向自有副本补入该行。第二次同入口、新输出返回 `0 / consistent`，`execution_path=runJourney`，地图运行期间未变。

| 案例 | 实际产品退出码 | 实际产品状态 | 独立于产品状态的案例验证 |
| --- | --- | --- | --- |
| healthy | 0 | healthy | passed，driver 0 |
| missing-ref | 1 | failed | passed，driver 0 |
| drift | 2 | drift | passed，driver 0 |
| mixed | 1 | failed | passed，driver 0 |
| empty | 0 | empty | passed，driver 0 |

独立复核确认五项 fixture 现时已不存在，case manifest 共145成员与 journey manifest 32成员哈希/大小相符；五份binding相同，1065项source与2352项build记录均与当前文件匹配。产品负例的退出1/2保持原含义，`empty`不代表来源健康。首次错误、原输入、修正理由和两次命令均保留，未重跑额外产品实验。root 对1493个已跟踪产品/脚本/清单文件在执行前后比较，字节无变化；运行时四个 fresh knowledge/dist 文件相对 Git 初始脏，故不是干净提交树测试。

新代理请求无继承历史，但自记命令日志不是外部完整访问审计；不把“未记录越界读取”表述为强制隔离或已证明全上下文排他。

## 验收边界

原 A39 要求从教程调用需要倒推签名与模块。本教程针对已存在接口进行后验使用观察，不能证明首次接口冻结前的因果要求，也不能完成全部 W17/C0。W18 相关叶检索、W19 维护责任以及 C1 方法清单/版本/recipe 编译、C2 admission→执行→独立验证→local_verified 仍需按原范围推进。

没有增加方法、启用生产运行时或进入 Firstmate 深运行；现有阶段工具用户验收尚未发生。原 24PS/19W/48A 和 32J 正式验收不因本批自动升级。原作者 Lauren Tan/poteto 的来源和 MIT 许可保持。

## 分轴复核结果与限制

冻结的CU01–10中，8项在记录范围通过；CU01“排他冷上下文”为 unknown，CU08“全局资源观察”为 limited。因此没有总判为完整冷验收通过。

冷代理用Python subprocess执行教程命令，没有逐字跑全部shell示例。自记脚本明确承认记录00前曾查看同一教程，日志不是全部工具/阅读事件。它所称“独立留存检查”实际是自己的自检：核过145个案例成员，顶层仅查可读；本次独立代理另外核完32个顶层manifest成员及source/build，并不追认冷代理做过这些核验。原报告不改写。

自记执行继承环境，仅记录必要子集，外层没有强制超时；600秒只是任务约定。没有OS读写/网络围栏、管理home全局审计、独立principal认证或全后代终止证明。独立checker首次argv切片下标错误及修正版一起保留，属于核验脚本错误，未修改产品或重跑实际使用流程。

241项设计文档验证已通过；本批没有重跑全仓产品测试，不将#310历史CI重标为此次测试。教程及本记录发布在控制分支，待下一实施批次吸收入main；不产生额外审批PR。

## 静态审计处置

实际 Sonnet 5.5 首轮 `PASS_WITH_CONCERNS`，六项措辞/材料披露意见原件保留。已补新shell变量恢复提示，并明确执行是Python等价调用；**实际运行的教程为SHA92700fcf版本**，后加提示未重跑，保存为author/tested-tutorial.md。任务prompt预告了输入拒绝后的恢复步骤；本次结论限于这一引导及缺少一行的情况。工作区同时有六中央文档修改和两个未跟踪文档目录，1493文件比较不含文档。cold可从git status看见这些路径，criteria位于获授目录上级；不读取仅靠任务约定。完整上下文排他性保持unknown。

首轮审计未获journey实现，故提出doctor依据不足；实际源码method-verification-journey.mjs循环doctor/drive，每次doctor先要求ready、executed=false及输出目录不存在；后补源码和原命令记录供限定复核。未直接以默认canonical示例驱动，也未执行可选投影，不宣称这些教程分支本轮实测。原A39状态不自动升级；预写判据由另一协作代理完成，不等同独立身份认证。原先执行后的产品快照早于代理最后的只读自检，随后补一次代理停写后的比较，原记录保留。

## 最终审计边界

两次实际Sonnet静态审计均保留为 `PASS_WITH_CONCERNS`，没有改记无保留PASS。限定复核后，root进一步收紧判据冻结/“冷”的措辞；这里“冷”只指请求`fork_turns=none`，不表示排他上下文。逐项结论保存在归档`independent/graded-results.json`。被测HEAD为`c83983186c8b4bb06b94f185c654093fd1c3fabc`（控制分支与main合并），不声称其整树等于main；相同的是已合并main与PR310发布树，root实际Git命令输出见`root-closure/git-proof.json`。

最终教程的改动diff与旧/新哈希保存在`root-closure`，仅补shell说明、doctor调用层次、前后快照措辞和可选分支未执行标记，没有重跑产品。首次静态输入已经包含维护入口源码；第二次复核未再携带它，导致“仅靠自报”的材料缺口意见，原文保留。journey中旧的two-case projection提示仍在；当前projector源已提供full分支（原PR305已交付），本次另保存源码供核对，并不将历史执行冒充此次投影实测。最终文档澄清未经第三次模型审计，所有尚有限制照记。

## 原件与复核入口

[完整原件归档](evidence/raw-verification.tar.gz) SHA256 `64f9c081d1a370627fb6798918299a40b23f568eb91ee39801c31a847ebe35e7`；[逐成员清单](evidence/raw-manifest.json) SHA256 `ae63264d7e4f96575310511c6b86d57ff426c45202e084e342c0a1d0918f5716`。334成员含310文件，文件payload 5,010,452字节；root逐type/mode/size/hash核对。包括冻结准则、原/修正地图、自记脚本和错误、独立复核及其脚本原失误、两轮模型输入/响应/模型用量、安装构建与前后字节绑定。哈希证明这些保留字节一致，不认证来源或主体。

[独立归档回执](evidence/archive-check/receipt.md)：334成员逐项与原文件一致，回执SHA256 `903d55e49e287d9dd4417f1c69018a4d3be05826fbf03b6d533efd83d98cd420`。原分轴和两轮concerns不变。
