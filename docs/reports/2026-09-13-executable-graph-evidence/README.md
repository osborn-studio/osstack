# 可执行图研究证据

日期：2026-09-13。用于支持研究与选型；不是 OSStack 生产集成验收。

## 文件

- `upstream-metadata.json`：9 个仓库的名称、许可元数据、活动时间和 HEAD。Mastra 的 NOASSERTION 需结合实际 LICENSE.md 解读。
- `local-checkouts.json`：实际读取的本地 checkout 与 commit，包括 OSStack `b476bcc`。
- `package.json` / `package-lock.json`：离线探针使用的真实发布包与完整锁定依赖。未安装进 OSStack monorepo。
- `semantic-probes.mjs` / `results.json`：10 项函数节点实验。
- `durable-probes.mjs` / `durable-results.json`：SQLite 跨进程恢复与 SIGKILL 重放窗口实验。
- `stdout.txt` / `stderr.txt` / `durable-stdout.txt` / `durable-stderr.txt`：原始运行日志。
- `import-cost.json`：各 5 次新进程模块加载测量；文件系统缓存已热，不能当端到端性能排名。
- `reproduction.json`：使用最终可移植锁文件在另一全新目录 npm ci、构建原生依赖、再次运行 10+2 项探针的成功记录。
- `validation.json`：文档链接、代码围栏、JSON 和复现记录的最终检查。
- `playbook-mock.txt`：知识抽取/校验/合并/检索示例的无密钥输出。
- `claude-roundN-context.md`：送给 Claude Fable 5.1 的更新上下文与评审问题。
- `claude-roundN.md` / `claude-roundN-metadata.json`：评审文字与模型使用记录。第一轮独立判断，第二轮逐项挑战，第三轮检查最终设计。

## 重现探针

在**新建的临时目录**复制本目录中的 `package.json`、`package-lock.json` 和两个 `.mjs`，执行：

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm rebuild better-sqlite3
node semantic-probes.mjs
node durable-probes.mjs
```

根据 npm 版本，原生 better-sqlite3 可能需要允许其构建脚本或可用的本机编译环境。本次在 Node 26.5.0/macOS arm64 上验证 native binding 可加载。不要将这里的依赖安装到 OSStack 的 package.json，也不要将实验数据库指向 `~/.osstack`。

`durable-probes.mjs` 创建全新临时目录，仅对自己启动的实验子进程发送 SIGKILL；模拟的外部动作只是追加该临时目录下的日志文件。它不运行 OSStack、git、真实 agent 或外部模型。

通过断言的含义：

- 10/10 语义探针：预期行为已复现，包含 ADK 空输出仍汇合的负面案例。
- 2/2 持久化探针：跨进程恢复成功；动作后 checkpoint 前崩溃会重复外部动作的风险已复现。
- 不意味着故障风险已经修复，也不意味着权限、取消、fencing、隔离、最低 Node 20 或性能预算已通过。

最初一次语义脚本误把 LangGraph 的 START 常量用于 ADK。修正为 ADK 的字面量 `START` 后重跑全部 10 项；最终保留源代码与输出对应同一版本。框架日志另存，结果 JSON 由文件写入生成，避免日志混入 JSON。

初次使用 `/tmp` npm prefix 产生了指向 macOS `/private/tmp` 的重复锁条目；最终锁文件补齐 package 身份并清理非相对安装条目，重新经 npm 解析，然后在全新目录安装并重跑两组探针成功。证据目录保存的是该可移植锁文件。

## 来源与评审边界

开源项目事实来自官方资料、固定源码、npm 元数据及上述实验。Claude 评审使用 `claude-fable-5-1`，禁工具、禁嵌套 skill，模型基于所提供的上下文进行挑战；其发言不是新的独立外部来源。元数据中可能包含 CLI 的 Haiku 辅助调用，不能把它误当作本次主评审模型。

所有原始输出按研究快照保存。最终采纳、修正与未验收项请看上级目录的评审纪要和研究报告，而非直接将第一轮建议当作最终设计。
