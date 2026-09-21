# Graph Engineering 研究验证记录

对应主报告：`../2026-09-11-graph-engineering-research.md`。记录日期：2026-09-11。

## 快照

- 目标仓库：https://github.com/DEEP-JLU/Awesome-Graph-Engineering
- 本地：`/Volumes/AIMATE_WORK/Developer/CodeX/Awesome-Graph-Engineering`
- 目标 commit：`d30a601e5ded64a595985e182b2b962519122ed3`
- OSStack commit：`59eafa0c8f008a36a9769630cb1119319985b9f6`
- 研究开始时已有未提交的 `AGENTS.md` 修改，保留未动。

## 记录

| 文件 | 内容 | 证明范围 |
|---|---|---|
| catalog-summary.json | 目标仓库文件及 README 列表项统计 | 非去重论文数量 |
| workspace-dependency-probe.py | 只读工作区依赖提取脚本 | 不运行 OSStack、不打开 DB |
| workspace-dependency-probe.json | 21 节点／45 边和两个传递闭包 | 包级声明关系，不是 symbol/test 覆盖图 |
| workspace-dependency-typed-probe.json | 保留 manifest 依赖类别与分类闭包 | 44 条 dependencies、1 条 devDependencies |
| source-anchors.json | 25 个源码锚点与文件 SHA-256 | 源码与固定 commit 一致，行号存在 |
| core-tests.txt | Kanban、memory、router 现有测试 | 69 项通过 |
| state-tests.txt | autonomy、dependency store 现有测试 | 11 项通过 |
| claude-round1.md | Fable 5.1 首轮原始审阅 | 模型意见，不是测试证据；取舍见联合审阅记录 |
| claude-round1-metadata.json | 实際响应模型与调用状态 | modelUsage 包含 claude-fable-5-1，is_error=false |

第二轮审阅的回复 `claude-round2.md` 与元数据 `claude-round2-metadata.json` 也保存在此目录，最终取舍见联合审阅记录。

## 复现命令

从 OSStack 仓库根目录执行，先选一个专用临时目录作为 `OSSTACK_HOME`。测试自身通过临时数据库隔离。

```sh
OSSTACK_HOME=/tmp/osstack-graph-research-20260911/state-home pnpm --filter @osstack/core exec vitest run src/kanban/kanban.test.ts src/state/memory.test.ts src/orchestrator/router.test.ts
OSSTACK_HOME=/tmp/osstack-graph-research-20260911/state-home pnpm --filter @osstack/core exec vitest run src/state/autonomy-runs.test.ts src/state/dependency-obligation-store.test.ts
python3 docs/reports/2026-09-11-graph-engineering-evidence/workspace-dependency-probe.py /Volumes/AIMATE_WORK/Developer/CodeX/osstack
```

静态提取顺序可能与首次 JSON 边顺序不同；集合、节点与闭包已重跑比较一致。后续代码版本改变时，结果可能变化。

这些验证没有测量集成后的收益。没有运行第三方图框架或修改默认／保留 OSSTACK_HOME 的控制面数据库，也没有修改生产运行代码。
