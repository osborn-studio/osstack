# G05–G07 证据索引

最终代码及边界见 [本批报告](../2026-09-13-graph-kernel-completion.md)。G07 实验通过不等于生产内核准入；C2 partial-abort 汇合问题未关闭。

| 证据 | 文件 |
|---|---|
| 实际 OSStack 三张编码任务 | G05/G06/G07-input.json、-result.json、-LOOP-STATE.json、-STATE.md；controller.mjs.txt |
| 最终 OSStack 验收 | acceptance-result.json、acceptance-STATE.md、acceptance-LOOP-STATE.json、acceptance-controller.mjs.txt |
| 最终源码绑定 | accepted-source-sha256.json |
| 最终全量测试/构建/类型/Schema/启动/静态检查 | accepted-workspace-tests.txt、accepted-build.txt、accepted-typecheck.txt、accepted-schemas.txt、accepted-startup.txt、accepted-lint.txt、accepted-diff.txt |
| 最终八进程 Saver 与已知反例 | accepted-saver.json；每阶段含 assertions、observations、退出与清理证据 |
| 最终 Node20/22/20.6 检查 | final-runtime-compat.json；对应 final-node* 日志 |
| 包依赖/入口/运行时 | G06-closure.json、G06-load-summary.json、final-package-surface.json、final-pack.txt、final-frozen-lock.txt、node-runtimes.json、node-floor-smoke.json、sqlite-runtime-compat.json |
| Claude 两轮审查 | claude-g05-review.md、claude-final-review.md；相应 metadata 与可用 prompt；review-adjudication.md |
| 复现与回归 | G05-review-red/green.txt、G07-codec-red/green.txt、G07-byte-accessor-red.txt、G07-config-projection-red.json、codec-getter-reproduction.json、final-review-*-red/green.txt |
| Schema 独立验证 | schema-validator-audit.json、schema-audit.mjs.txt、schema-ref-check.json |
| 卡片执行者阶段记录 | G05/G06/G07-executor.md；G07-validation-summary.json / G07-source-hashes.json 是执行者快照，不代表主管后续改动的最终字节 |
| 文本格式规范化 | archive-normalization.json；原始临时文件未改，JSON 未格式清洗 |

控制器中绝对路径是此次真实运行位置，不是产品可移植配置。未归档原始事件流、数据库、Node 安装包、node_modules、打包二进制或密钥。Loop 元数据的 changed_files 是工作区快照，commit_hash 是当时 HEAD；最终提交以 accepted-source-sha256.json 为准。正式运行不能将归档控制器中的临时 home 直接当作新的隔离 fixture。
