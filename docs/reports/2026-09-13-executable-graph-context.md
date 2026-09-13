# OSStack Graph 后续工作的更新上下文

日期：2026-09-13。用途：给下一次实现任务或跨模型评审提供准确起点。

产品定位后续更新：用户明确 OSStack 长期聚焦公司/个人内部编程强化；OStag 承担组织协作与业务治理，新增 OSBot 为本地服务器上的持续数字同事。见 [三产品更新 Context](2026-09-13-os-products-context.md)。本文件中的工程图实施任务仍有效，不据此把 OSStack 扩大成通用业务 agent 平台。

详细实施已拆为 [G00–G29 任务卡](../implementation/2026-09-13-osstack-graph-upgrade.md)，当前均未开始。最新细化：单次实现只返回 implementation_complete；freeze 持久化 commit/产物后才返回 candidate_ready。v1 选用同一控制面 SQLite 内的独立 graph_* 表，迁移按 G08→G11→G13→G16 串行；worker 动作客户端和贯通取消必须在 M1 验证。

## 用户目标

需要 Google 式真实可执行图编排：显式节点 I/O、并行汇合、条件路由、失败处理、停止规则，并复用 OSStack agent、Loop 与权限。不是继续扩大关系检索，也不是先建知识图谱。用户希望与 Claude Fable 5.1 互相挑战，并评估 OSStack 升级与独立 osgraph 产品。

## 当前事实

- OSStack 检查基线 `b476bcc`，工作分支 `codex/graph-readonly-pilot`；现有 `graph explain` 只读。此前 pilot 测试不证明任何执行图语义。
- Awesome 已克隆至 `/Volumes/AIMATE_WORK/Developer/CodeX/Awesome-Graph-Engineering`，是资源索引；playbook 的 Python 示例是知识处理；GraphGen 是图驱动数据生产。
- Google ADK **JS 2.0.0 已真实发布并可运行 Workflow**；不可再称此能力 Python-only。该类此次运行仍提示 experimental。
- LangGraph.js 1.4.15 被选为首个待实施内核；不是已完成 OSStack 集成。无需绑定 LangSmith 或替换现有模型客户端。
- 独立探针 10+2 项通过各自断言；包括风险复现：ADK 缺输出仍汇合；LangGraph 恢复重执行中断前代码；外部动作后 SIGKILL 导致重复动作。
- 实验环境 Node 26.5.0；Node 20、真实 adapter、取消、受控 saver、fencing、租户与性能集成尚未验证。

## 收敛方案

先做 OSStack 内 `@osstack/graph` 模块与 `osstack graph` 命令；不启动独立控制面产品。首条代码交付图：一次实现 → 冻结 commit/导出产物 → 并行独立评审+隔离测试 → 同 run/epoch/revision 汇合 → ready、有限 repair、分支重试或停止。最多三轮静态展开；初版单 writer；ready 不自动发布。

graph worker 独立进程，避免模块加载阻塞 daemon。复用一个受控 broker。checkpoint 权威负责图调度和数据；ledger 权威负责动作、权限、结果与资源；展示状态才是投影。不能把两种状态混写，也不能说 checkpoint 全可从动作 ledger 重建。

动作 intent 先落账本再执行。重放复用稳定 effectKey，key 不含 generation；unknown/cancel_pending 阻止盲目重发。新真实尝试须前次状态可判定且有授权预算。禁止承诺非幂等 provider 物理恰好一次。

fencing 同时约束 saver `put` 和 `putWrites`，以及 broker 新动作。它不阻止已启动的旧进程写文件，因此各代/各写动作隔离 worktree；旧进程未确认退出不能复用其目录。每动作启动重验 grant/policy/expiry。

## 必须先补的 OSStack 接缝

1. `AgentAdapter` 实际只有 `invoke(task, signal)`；注释里的 cancel 方法不存在。Loop executor 没外部 signal。
2. executor 默认 completed；无 done 的流可能被当作成功，必须修终态契约。
3. Loop cycle 顺序任务，末尾写 LOOP-STATE.json，不可充当图检查点。
4. private runTask 自动 commit/ff-only merge/cleanup，不能直接包成图节点。提炼一次候选执行，成果落稳后再回收；图评审模式不重复内置评审，也不绕过治理。
5. daemon 门控和写锁需提炼共享服务；图路径可信解析 repo scope，不接受模型填写的 repo_id 决定锁范围。

## 下一步执行依据

以 [实施计划](../design/2026-09-13-executable-graph-plan.md) 的 P0 → P1 → P2 顺序推进，先把受控执行与故障窗口跑通，再开放真实写入 beta。具体测试矩阵已经列出。当前任务交付研究与方案，没有实现生产图运行时。

现有未提交的 `AGENTS.md` 修改属于用户，不覆盖或混入提交。开发 CLI / DB 检查必须显式使用临时 `OSSTACK_HOME`，禁止打开默认或保留 serving home。不要把研究用 npm 依赖或临时数据库拷入产品依赖树。

完整证据：[研究报告](2026-09-13-executable-graph-research.md)、[三轮评审纪要](2026-09-13-executable-graph-claude-review.md)、[证据说明](2026-09-13-executable-graph-evidence/README.md)。Claude 原始各轮上下文和答复在证据目录，最终决策不能只根据第一轮答复。
