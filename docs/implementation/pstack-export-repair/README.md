# Claude 导出器历史缺陷实际修复任务

本轮实际完成一项有界历史缺陷修复：Claude CLI 使用 OSStack 方法入口、逐条运行真实导出器、创建行为测试得到 RED、修改一行源码，再用同一测试和输入得到 GREEN。方法阅读覆盖仍有缺口，因此不能称整个宿主方法协议完全通过。

## 范围与绑定

使用已合并 main `493caa4e46e616b1d7e9e1c87ed0a5775eae3ad1` 的14方法材料，历史缺陷版本 `4611fd6de998868e09fef042dc142bb52efaa6dd` 的真实导出器源码。该缺陷此前已有修复，不是本轮新发现的生产缺陷。本轮未增加方法、修改当前产品源码或创建产品PR。旧 packet 任务中 Claude 未修复的结果保持不变。

三位子代理分别负责固定执行适配器、Claude 宿主执行、独立冻结判据和隐藏输入。主入口负责派发、实际 Sonnet 审计、账本与证据收口。独立校验者是同一代理系统中的工作者，不是另一个已认证 oracle principal。

## 实际执行

root 于2026-10-29T06:01:41.942439Z签发本次guard，哈希 `a942fad094b8d356c158fd40c5722cb4e343131f42853fca4377c316b1645d9f`。实际一个用户输入轮次、600秒上限、零重试；CLI报告内部31个turn，不能与用户输入轮次数混用。CLI报告模型 `claude-sonnet-5-5`，不等于独立服务商身份认证。

| Claude本人执行 | 原始源码 | 修改后源码 |
|---|---|---|
| 缺陷输入实际导出 | exit0，错误接受 | exit1，明确link_missing_or_escape，未创建输出 |
| 合法完整包 | exit0 | exit0 |
| 合法代码示例 | exit0 | exit0 |
| 新行为回归测试 | 2通过、1断言失败 | 相同测试3通过 |

八条Bash均是冻结的单条helper命令，没有权限拒绝。事件顺序为：三条原始检查→写测试→真正行为RED→Edit源码→三条候选检查→同测试GREEN。缺失测试文件、导入或权限失败没有冒充行为RED。修复仅在围栏匹配前移除行末CR，保持原始文本长度和偏移计算。

- 原始库SHA256：`0d0b401c2e8f692728d836f4575be35f784a3795a121b3616452ed2e9cdeeec2`。
- Claude候选库：`54708dbccb77ad6368b0b3ec5a10d8be738ea9fb358417e30f63e9410fec6c0f`。
- RED与GREEN测试SHA256相同：`019bab8761c0951d62b35ad91d3da4588c96409dec48177a35e5566ebbb25757`。

## 独立验收与限制

独立隐藏输入及判据在模型输出前冻结，协调者复验与上表Claude本人操作分别记录。最终独立结果见下方补充及归档。

实际观察到 native Skill(osstack-mode) 调用。bug-fix材料读取完整；evidence.md为64行，仅有前60行Read，缺少61–64行的后续读取。因此只能主张实际原生调用与部分材料送达，不能主张所有必读材料完整消费、方法收益因果关系或普遍修复能力。模型自己对CR原因的部分推断也明确披露，不能重写成它直接观察了字节。

CLI使用现有认证；harness没有读取、复制、哈希凭据或转储环境，但这不证明CLI内部认证隔离。工具权限、固定输入及前后目录核对不是OS读写/网络围栏。模型生成的JS测试是任意可执行代码；限制Bash入口不等于限制JS内部所有系统调用。本轮未声称通用沙箱或全后代清理。

预检中的两次缺测试失败、首次读取已清理旧helper路径失败、独立发现criteria本体未直接列入falseguard的检查失败均保留。root在派发前追加criteria和最终supplement直接哈希绑定；未修改旧冻结记录。没有模型重试、结果截断后重评分或删除失败。

## 验收和账本

本轮支持PS01/PS08/PS20的有限实际使用证据，PS09仅关联既有维护闭环；不新增方法数，不把活动结束当整项能力完成。J01/J11及其他正式门槛不变。Sonnet静态审计、独立复验和文档检查分别列证，不代替实际宿主执行。

独立最终结论：**LIMITED：实际修复闭环成立，必读材料协议未完整通过。** 模型所写同一测试在独立旧/新副本上再次RED/GREEN；6个预冻结隐藏输入在候选上全部符合预期。这8次协调者命令与模型8次helper分开记录。两合法控制前后manifest相同；10个已创建导出manifest的400个成员核验通过，其中包含旧缺陷输入的错误导出，文件一致性不代表输入有效。完整分轴结论见[独立验收](independent-result.md)，JSON原件哈希 `e8a85599aeb1b7849bf44c9aa515b429f3a61cde626e366e93cb367d4da84c49`。

## 审计补充证据

Sonnet 5.5首轮静态审计PASS，无确认阻断；提出的说明补充如下，原审计保留。evidence.md按Python splitlines为64行；按JavaScript split("\n")为65个元素，最后一个是文件末尾LF产生的空元素。未读取的是内容行61–64，而非五行正文。

修复和测试仅在实验工作区产生；测试依赖实验适配器tools/export-case.mjs，不能直接宣称已提交产品回归。最终回答321词，300词仅建议，不是硬门槛。complete_workspace_inventory_unchanged=false是预期的授权写入；独立核对证明仅library、new test及results变化。缺陷拒绝的原始stderr保存在归档host/runs/claude/workspace/results/export-after-incident/stderr。只讨论LF/CRLF及本轮冻结案例，不泛化至CR-only换行。

隐藏输入于2026-10-29T05:54:51.517081Z冻结（SHA256 `762e0f130a61938fa58ad9219742434ffcda4c9654ec1fe7a3b73937f6f29b06`）；old/fixed校准记录SHA `24e540cf347e8e41485bbc513d32acaa00f86928a810373e28e09b4d99662bbd`。实际guard直接绑定criteria与最终supplement，原件随归档保留。下表中的旧版/已知修复版是派发前校准，候选是派发后独立协调者复验，均不是额外Claude调用。

| 隐藏案例 | old预期/实际 | 已知fix预期/实际 | Claude候选预期/实际 |
|---|---|---|---|
| H01 | 0/0 | 1/1 | 1/1 |
| H02 | 0/0 | 1/1 | 1/1 |
| H03 | 0/0 | 0/0 | 0/0 |
| H04 | 0/0 | 0/0 | 0/0 |
| H05 | 1/1 | 1/1 | 1/1 |
| H06 | 0/0 | 0/0 | 0/0 |

## 原始证据保存

[evidence/raw-execution.tar.gz](evidence/raw-execution.tar.gz)包含实际Claude流、所有工具输入输出、源码/测试/输入快照、独立校准和复验以及准备失败。归档SHA256 `2b8e9bcfd274271fabb7356cfe38d6be2e4aae4c55a8ed14651aa289794298fc`；4614成员（3202文件、1411目录、1个作者拒绝案例symlink），文件载荷12,111,615字节。逐成员hash/长度/mode核验通过，symlink只保存链接本身、不跟随；Python缓存排除名单逐项保留。root另核总hash与5个关键原件。实际审计及后续清理回执独立保存，避免声称它们已包含在此前冻结归档内。

Sonnet 5.5实际两次静态审计：首轮PASS并给出说明修订，随后限定closure PASS。两次完整prompt/response/bindings保存在[evidence/raw-audits.tar.gz](evidence/raw-audits.tar.gz)，SHA256 `5769866ab282c94f52b0d8b64fc7c2c4b059d309f019fba2e6abc7841d888c9f`，24文件逐hash/bytes/mode复核。审计只核对所提供材料，未自行执行测试或重算哈希；真实重算与执行由前述协调者完成。审计初次组装使用错误文件路径、在0模型调用前失败的记录也保留。

上表数字均为退出码（0接受、1拒绝）；旧版commit为`4611fd6de998868e09fef042dc142bb52efaa6dd`，已知修复版为`a1cb1779d62107d2c4f101b98311f3ec39116ae1`。遗漏61–64行中61/63为空行，62/64为两段正文。guard直接绑定criteria与supplement；隐藏输入由独立记录冻结，不声称直接列入guard。

归档核验后仅删除本次owned Claude workspace，删除前1169项与run-after一致。清理回执SHA256 `dc095632173a8878ddc46c77d14e3d13fa3968e2ba982ed746553d5d91a6bae7`单独保存；raw/state/guard继续保留，不证明全后代清理。
