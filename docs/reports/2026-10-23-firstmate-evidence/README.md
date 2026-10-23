# Firstmate 研究与审计证据

研究日期：2026-10-23。本目录记录实际输入、输出及验证范围；设计文档中的未来能力不视为已实现。

入口：[研究报告](../2026-10-23-firstmate-analysis.md) · [设计](../../design/2026-10-23-firstmate-capability-adoption.md) · [实施计划](../../plans/2026-10-23-firstmate-adoption-plan.md) · [审计处置](../2026-10-23-firstmate-claude-audit.md)。

## 来源固定

- [firstmate-source-manifest.json](firstmate-source-manifest.json)：原仓库URL、固定SHA、浅克隆与完整tracked regular file清单/大小/行数/hash。
- [osstack-source-manifest.json](osstack-source-manifest.json)：OSStack实际HEAD/分支与19个重点文件hash；包括研究前已有修改后的文件内容。
- [osstack-initial-status.txt](osstack-initial-status.txt)：起始工作区状态，保留原用户变更。
- [source-index.json](source-index.json)：40个有编号的源码/文档证据，F01–F16为firstmate，O01–O24为OSStack；每项有路径、行号、完整文件hash和链接。
- [source-excerpts.md](source-excerpts.md)：第一轮使用的带行号摘录；[第二轮补充](source-excerpts-round2-addendum.md)补充实际发送路径、schema、supervisor包、只读DB入口；[第三轮补充](source-excerpts-round3-addendum.md)核实租户迁移、grant游标、额外清理调用点和Codex resume。
- [firstmate-LICENSE.txt](firstmate-LICENSE.txt)：与Firstmate原始摘录一起保留的MIT许可。OSStack源码摘录来自当前本地工作区；firstmate固定URL指向上游，不指向浮动main。

## 实际测试

[upstream-tests.log](upstream-tests.log)保存上游原始测试输出；[upstream-validation.json](upstream-validation.json)记录3组suite的exit、81条成功断言、无gate skip、216个Shell语法检查结果。

这些测试在单独scratch TMPDIR执行，没有安装Firstmate内置skills或启动其真实worker/daemon/远程home。未运行其余274个行为测试文件，也没有在OSStack上实现或测试本方案。

## Claude Code 审计

实际CLI：`/opt/homebrew/bin/claude`，版本2.1.291。请求模型`claude-fable-5-1`；[model-probe.json](model-probe.json)和各轮原始返回中的modelUsage可核对实际模型标识。

| 轮次 | 冻结输入 | 原始JSON | 提取原文 |
| --- | --- | --- | --- |
| 1 | [context](claude-round1-context.md) | [raw](claude-round1.json) | [report](claude-round1.md) |
| 2 | [context](claude-round2-context.md) | [raw](claude-round2.json) | [report](claude-round2.md) |
| 3 | [context](claude-round3-context.md) | [raw](claude-round3.json) | [report](claude-round3.md) |

每轮`.stderr.txt`保留标准错误。原始JSON与提取原文不作编辑；作者接受/部分接受/驳回记录在单独的审计处置文档。后续设计修订不回写旧输入，因此模型意见只绑定当轮的具体内容。

调用约束：`-p --model claude-fable-5-1 --output-format json --disable-slash-commands --tools '' --safe-mode --setting-sources '' --strict-mcp-config --no-session-persistence`，另外传入关闭hooks/plugins/autoMemory的专用settings及空MCP配置。输入经stdin传入，输出重定向本目录；运行目录为`/Volumes/AIMATE_WORK/tmp/osstack/smoke/firstmate-research-20261023`。未使用会话恢复，也未赋予模型修改文件或执行命令的能力。

模型只看到供给的材料，不是独立完整代码审计；CLI自报费用如有记录也不替代实际账单。

## 最终一致性验证

[validate-research.py](validate-research.py)仅验证本次材料：JSON可解析、报告相对链接存在、Markdown代码围栏成对、来源hash不漂移、各轮原文与raw.result一致、Firstmate checkout干净、关键OSStack源码保持基线。它不执行产品代码、不打开数据库、不联网。运行结果保存[final-validation.json](final-validation.json)；[artifact-manifest.json](artifact-manifest.json)绑定最终文档和审计输入输出hash。

有意保留的边界：浅克隆没有全部历史；来源文件若在研究后变化，应重新生成新基线并复审，而不是覆盖这份证据。性能目标、恢复能力、真实harness兼容性都留给未来实施验收。
