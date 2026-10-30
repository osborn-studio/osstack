# 固定 pstack 经现有 Loop 完成一张真实缺陷卡

截至 2026-10-30T12:06:17.067769+00:00，新任务 `pstack-loop-long-path-20261030` 已完成有限 assisted U1；原 `pstack-first-use-node26-20261030` 仍 BLOCKED、未重放。本次成功是实际使用证据，不是全 pstack/C2、U2/local_verified 或安装版发布。

## 用户得到什么

Loop 从 Git 差异发现任务时，原先把 `git diff --stat` 的显示标签当真实路径。219字符路径被截成 `.../ordinary-directory-abcdefghij/target.ts`，评审目标无法定位。模型经固定 pstack bug-fix 材料完成回归和修复：使用 `git diff --numstat -z` 的完整路径，行数仍为增删之和、优先级仍为 `min(changes*5,100)`；binary仍跳过。`context.diff_stat` 现在是原始 numstat 记录，rename记录的该字段不包含目标路径。没有发现内部字段解析消费者；rename/binary运行覆盖未扩展。

首用卡 `card_91b23635`，Loop `loop_26a8b127-8e45-4bc9-bfa1-a15a239726eb`，run `run_9fdeda2c-bc1f-4388-b999-dffafd387e17`，native thread `01a18ca6-600d-7c93-9926-3e100edbb289`。原生调用一次，约149.635秒。只改 `packages/loop/src/discover.ts` 与同目录测试。root另加changeset；实际候选源未改写。

## 先解决实际权限阻塞

Codex0.160.1二进制SHA09fa44fdc37a5fc70dc1ace31235f90468a2e193d0e85f7552eab068ea2582be。命名profile的首次语法错误在child前拒绝，原件保持BLOCKED；纠正进程级TOML后，第二个新目录无模型探针两写成功、外侧控制EPERM。随后独立新原生诊断通过已有CodexCliAdapter的显式task-scoped `writableRoots`/`--add-dir`：只运行一个授权Node命令，两标记35/38B准确、外侧拒绝。没有修改全局配置、HOME/CODEX_HOME或关闭sandbox。该观察只证明当前二进制/路径，不证明所有路径、并发置换、完整后代清理、认证或独立principal。

## 调用前冻结与实际顺序

来源固定cursor/plugins pstack0.15.36 commit `c742dd61706fbacc1b95f1a20b7b988cf096ce6c`，pstack tree `4719e1c4b4c43bac85d4206a8b41dd2899769c1c`，不追上游main；Lauren Tan/poteto/MIT保留。使用已采用材料的完整三角色正文32286/32303/32309B；来源和角色声明的认证边界沿原P2/P3保留。

独立四向量先冻结；root公共scanner真实基线确认路径缺陷。当前卡单task、新权限、逐条Read/产品命令、仅两文件可改、600s/一次调用、sources:[]、maxIterations1/useWorktreefalse。helper最初219长度说明误写212，在调用前改正并写全新v2目录，两个准备包和纠正记录均留存。最终freeze `be0956de50045d09c54b7332a9d436fae304ce008743e067f40be9246ed2885a`。

| 证据 | 实际结果 | 限定 |
|---|---|---|
| native RED | 新测试实际1fail/8filtered，完整路径断言失败 | 已运行测试，非环境失败 |
| native 修复后 | 同命令1pass；原优先级控制1pass；整文件9pass | 原始file_change序列支持，RED时无独立完整文件hash |
| host验证 | 两条注册命令通过，artifact gate通过 | gate列16项含初始4dist+10准备文件，并非模型新增16项 |
| 独立冻结公共scanner | 同4向量旧3fail1pass→新4pass | 不代表全部Git状态/所有文件编码 |
| 方法交付 | builder32286B逐字进入36405B实际argv；2持久收据 | AgentTask prompt，不是provider内部wire/理解认证 |
| 文件边界 | 9171tracked仅两授权源码变化；4初始dist未再变 | 不证明ignored/global files或OS文件级围栏 |
| root full | 22包7449pass/5skip/0fail | 精确commit `cd30b6ccddbd0e02d5607683a97c36d3ba96db11`；9172tracked字节同，初始freshdist脏 |
| 静态审计 | 实际Sonnet5.5 PASS_WITH_CONCERNS，无确认代码缺陷 | 未运行代码；原建议/未测分支保留 |

## 使用边界与下一步

实际调用复用公开LoopEngine、CodexCliAdapter和已有execution-context-host；host目前由匹配构建的CLI内部chunk导入，不能当稳定公共SDK。没有新scheduler、自动卡消费或安装版 `method bug-fix` 命令。仅builder真实模型执行；reviewer/verifier正文已准备，但此次验证是注册命令和独立工具。普通任务绑定与人工同卡证据有意义，但native卡task_id/tenant_id仍null，不冒称原生FK/自动投影。

当前可由维护者伴行重复这条路径；普通直接使用仍缺稳定入口/包装及依赖PR落地。具体见[用户路径与待补项](USER-PATH.md)。固定版本和原合同不变，旧Node26/P6失败不升级，32J与24PS计数不借活动成功升级。Firstmate深运行保持禁止。

PR315原CI41048799532在graph-review-findings取消状态失败：22包7445pass7skip1fail，后续所有脚本/smoke跳过。相关源码父/头同字节只是排除变更线索，不证明无产品问题；本地结果不替代远端失败，禁止盲重跑。CI原始log/metadata和后续单次诊断独立保留。

## 原始证据

`evidence/raw-verification.tar.gz` 与逐成员manifest保留：权限两失败/成功探针、新原生权限诊断、固定材料准备、最终freeze、完整native流、源码、真实RED/GREEN、独立前后结果、host回执、审计原文、full/构建日志及CI315原件。具体归档清单与排除项由出版manifest记录；未下载GitHubartifact，不声称重新hash远端artifact。原始生成数据库/Gitfixture元数据保留本地且以摘要绑定，未作为产品源码提交。

### CI315 单次诊断结果

单次受控诊断只运行一次，捕获两次cancel中一个被吞的DECISION_CONFLICT；最终cancelled、0持有admission、journal exited。该局部1pass/6filtered不修复或改写CI315失败；原失败仍需有限barrier交错验证。诊断6源码不变，临时测试已清理，期间root仅整合12项文档/changeset状态差异。 不得把该诊断称为Firstmate新运行能力或确认的原CI根因。

归档SHA `41375939d745385d3cf64831586e5aee266cc60bed02b65c37b11f19afde2e16`；manifest `eb8d2b541fe6d37c8a74057a9e1c6339c4660cae67040502c0f1b3345e6cae15`；688成员=460files+228dirs，10817650filebytes。root与独立逐type/mode/size/hash核通过；[独立收据](evidence/independent/receipt.md) SHA `8e41521360c5318e94337ed66795a74741dd7c5317f400794af881a6cd45f582`。两份各1519616B生成SQLite仅本地保留，以排除清单hash绑定。归档检查器初次把list型manifest当object的harness错误与纠正均保留，不是payload失败。
