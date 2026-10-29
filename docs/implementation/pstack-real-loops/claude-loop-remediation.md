# Claude 实际修复闭环：最小修正建议

本次只读核验，不运行宿主、不改产品、不改变原试验结论。基线方法为 main `1bf1f6caa0ac0ae7b05c3caa9bb44d7ce6517dd0`。下列证据路径均相对本轮原始归档中的 `host/`（与 scratch 原件对应）；本建议本身没有启动新实验。

## 事实与归因

`runs/claude/evidence/run.jsonl` 第 16 行唯一产品执行尝试是：

```text
for l in incident control-a control-b; do /usr/bin/python3 tools/run-node.py check $l before-$l; echo "exit $?"; done; /usr/bin/python3 tools/run-node.py test regression-red; echo $?
```

第 18 行因 dontAsk 权限拒绝。没有一次原子 helper 调用，没有新测试文件或源码修复；最终报告如实称未复现，但把复合命令被拒概括成需要放开 helper，并提议在未写回归测试前运行 regression-red。这两点不能作为配置缺失的证据。CLI 进程 exit0 / result subtype success 只表示生成了最终回答，任务未完成。

最终 `runs/claude/state/settings.json` 已明确允许 `Bash(/usr/bin/python3 tools/run-node.py *)`，以及两个指定源码/测试文件、results 的 Edit/Write。请求给了逐条 helper 命令，但未明确禁止组合，也没有在四行示例之间显式插入“先创建行为回归测试”一步。实际选择的 for/echo/分号组合不是给定的单条命令。**观察支持命令选择与任务步骤表达问题，不支持产品源码缺陷；原子命令在本次 Claude 权限层能否通过仍未实测。** 不能仅用字符串前缀比较冒充原生权限判定。

helper 静态已有完整能力：`check` 只接受 incident/control-a/control-b；`test` 只执行模型新建的固定测试文件；固定 Node22、清洁产品环境、10 秒/每流 1 MiB、唯一结果目录、原始退出码与前后哈希记录。用既有 Write/Edit 创建测试和最小修复后，重复这些原子入口即可覆盖完整闭环，无需新增脚本能力。`control/helper-preflight.json` 证明协调者单独运行三个 baseline check 成功；缺失测试返回 1 只证明“文件不存在会失败”，不能算行为回归 RED，更不能证明 Claude 工具权限成功。

## 最小改进，不扩大权限

优先只修改下一次独立任务协议，不先增加方法，不扩大 allow。保留 helper、settings、工具和输入/写边界；另行冻结该任务预算，不继承本轮剩余额度。明确每个 Bash 调用只能含一条完整给定 helper 命令；不加 for、变量、echo、`;`、`&&`、管道或重定向。退出码和证据位置已由工具/helper 提供。用 Read/Edit/Write 读写已授权文件，不通过额外 shell 改写测试。给出四阶段：

1. 分别调用三个 before checks，读各自结果；incident 错误接受的 exit0 是待修现象，不把它本身叫断言失败。
2. **先创建**真实行为回归测试，再单独执行 `test regression-red`。RED 必须是正确行为断言失败；缺文件、导入错误或权限拒绝均不合格。保存原源码哈希与失败。
3. 仅修授权源码。不得改 inputs、helper 或为了变绿放宽测试。保留测试字节与两控制项。
4. 分别调用三个 after checks 和 `test regression-green`，使用新 label。原始 incident 应拒绝，两控制应接受，原回归测试应通过。读取真实回执并检查写范围/输入哈希。

下一协议不预授权拒绝后的fallback或重发。第一条实际原子命令若被拒，记录完整被拒命令并结束该turn；不换解释器、编码或路径规避，不申请泛化Bash权限。本轮失败不重跑，不追溯变更原预算或标准。

main 的 `bug-fix.md` 已要求先复现、最小修复和同路径复验；`evidence.md` 已区分 harness、行为、未运行，并要求定向读取。无需新增方法。若任务说明改进有效，再考虑在 `host-usage.md` 增加一小段“窄执行入口应逐条原样调用；复合命令拒绝不等于原子入口未授权”的一般说明。本次不改该文件。此前一次 29.7 KB 全量 cat 触发 persisted-output，也支持沿用现有定向读取规则；不要把正文截断误当已完整读取。

## 静态正负矩阵与后续验收

以下是下一试验应保留的边界，不是已运行的权限测试。

| 调用/动作 | 期望及判断层 |
|---|---|
| `/usr/bin/python3 tools/run-node.py check incident before-incident` | 请求与 allow 对应；仍须观察实际宿主执行 |
| Write 指定回归文件，然后原子 `... test regression-red` | 允许目标内写；须真实行为断言 RED |
| 修指定源码，然后原子 `... check control-a after-control-a` 等 | 维持同输入、fresh label；逐条收集结果 |
| 本轮 for/echo/分号组合 | 不作为受支持调用；保留原拒绝 |
| 直接 node、python -c、改 helper、网络/安装 | 不增加授权；不作为失败恢复方案 |
| helper 未知 case 或重复 label | helper 拒绝，不覆盖既有证据 |

后续先冻结任务/配置/helper 哈希和上述阶段判据。把第一条真实原子调用作为原生权限预检，不能以协调者直接运行替代。它如果仍被拒，则任务接口建议未解决原生执行问题，按准确拒绝归因，不继续宣称闭环。若可执行，则至少检查 8 次真实 helper 回执、源码/测试时间顺序、行为 RED→GREEN、三输入不变、两控制、限定写入和原始失败保留。语义修复还需独立复验，不依赖模型自报或最终措辞。当前试验不重跑、不补认；本方案也不是通用 shell 沙箱、网络隔离或模型成功率证明。

## 精确证据绑定

- 原始流 `runs/claude/evidence/run.jsonl`：`1227d79e2826aca0b38cf18109c1dc722ab40aa12a5755c465bdb4a4672f13e2`。
- 请求 `runs/claude/workspace/inputs/request.txt`：`fc6b5a87640467b137400da241678817c11941a71c28443ad91afec3c5496503`。
- helper `runs/claude/workspace/tools/run-node.py`：`8e88a68a5a7b89bfb37a8e8e87e6defd423dfcdb68b6d0408b62818c54a922c7`。
- 设置 `runs/claude/state/settings.json`：`3385072a40f3db212497da8d5338ff5554afdb7421e8576019f68a8a75141c66`。
- 直接预检 `control/helper-preflight.json`：`af12b0cf7fb9e51c0f12f2595ab8219cbd668a48c2b1fdd011f82a3397344841`。

后续限定：选择不同缺陷，先冻结并注明历史/新发现性质。第一条原子命令就是本轮原生权限可行性预检；拒绝即结束该turn，不预授权fallback或重发。只衡量这一任务接口能否执行，不比较模型优劣或宣称方法收益。本文原始日志行号为1起算，独立报告事件index为0起算。
