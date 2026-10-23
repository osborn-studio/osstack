# G21 完整代码交付模板验收报告

本批目标是把已验收组件接成真实执行流程：创建隔离写工作区 → G04 单次实现 → freeze → 分别准备 review/tests 工作区 → 并行验证 → host 汇合 → ready / 修复下一轮 / 停止。ready 只返回候选包。

## 设计与实施

G21 实际跨越多个组件，因此拆为三个实施子项，主任务在全部验证后才计为完成：G21a 持久化 epoch 许可与可信动态注册；G21b 完整 Functional 模板、准备动作与 host driver；G21c 真实集成、权限/故障反例与执行回执。

编译器升级为 code-delivery-functional-v4，每轮静态图含 workspace、implement/repair、freeze、两项 prepare、review、tests、join。固定注册表成本用于真实动作预留和下一轮预算判定。准备工作区也经过动作账本；首次 main 与 retry-N 槽由已编译上限决定，worker 不能分配尝试编号。

使用现有 Functional interrupt 表示质量汇合边界。host 从最新账本、独立回执与产物重新验证；实际 worker stop、执行器 stop 与 Promise drain 分别确认。需要修复时，经过 G15 交接再恢复同一 Functional checkpoint；完整汇合记录同时提供 review 与 tests 反馈。没有新建第二套节点状态机。

迁移 32 增加不可变 epoch 许可；每次新轮次要求上一轮已发布的有效负向汇合、当前最新分支、预算足够且没有未知动作和未释放 admission。旧 epoch 在 broker 和核心动作存储都会被拒绝。coordinator 固定自身 owner/generation，仅接受自己成功的 G15 交接结果；最终状态写入使用汇合验证的同一 revision。

执行回执绑定实际 effectKey、attempt、generation、owner 与物理工作区，摘要命名、限制 128KiB、同步落盘并拒绝覆盖/符号链接读取。未知效果保留资源，不自动重发；review/tests 诊断沿用 C6 有界回执。

## 审查中修复的反例

- 重试准备与第一次准备共享 nodeId、不同 slot；按 nodeId 查最新记录会读错旧回执。改为精确 slot 绑定。
- host 只读取最新 owner 会让旧 host 继承替换者权限。改为保留自身权限绑定并测试实际执行期间撤销/更换 owner。
- 评审未知时返回 reconcile 却仍显示 running。改为在仍有权限时投影 reconciliation_required，保留动作和 admission。
- 调用者替换 options/callback/adapter 会改变异步执行。改为启动前捕获；新增变更注入测试。
- 不采用 Claude 首次审查关于失败汇合必然冲突的建议：源码只发布所有分支 confirmed 的完整汇合；格式失败不发表该记录。

## 验证与证据

验收源 `ab988b32649c9eef084e997bb92d31c0108436fc`，分支 `codex/graph-runtime-foundation`。**G00–G21 完成，22/30；M0/M1 完成，M2 实施中；C7 尚未通过。**

真实 OSStack Loop `G21-final-acceptance-2`：1 executed、0 skipped、success；22 个包、**3201 项测试通过**。六项检查 typecheck、schema freshness、G07 saver probe、C2 Functional probe、startup、whitespace 均 exit 0；全库 build 与 18 个改动 TS 的 Biome 通过。CLI --version 中位 26ms / 150ms，--help 76ms / 500ms。

真实交付路径：直接成功 7 次动作；修复后成功 14 次动作、worker generation 2、两个 immutable join；重试成功 9 次动作；格式失败达到上限 9 次动作且不发表完成 join；负向质量达 epoch 上限 7 次动作并停止。两种完成顺序有明确观察断言。9 项异常测试包含未知 writer/reviewer、token 超额、配置替换、owner 更换/撤权、重试准备准入失败、setup 失败与真实心跳续租。核心 epoch 10 项、动态注册 5 项、回执 4 项、模板成本/槽 7 项也通过；C5/C6 既有链与汇合恢复回归保留。

Claude Fable 5.1 完成两轮真实审查；其第三次最终回审返回额度错误，**没有 Claude 最终通过结论**。采纳的问题已用反例修复，另一个真实 OSStack Loop 中的 Codex 只读审查给出 PASS，无本批剩余 P1/P2；该审查不替代测试，也不冒充 Claude。详见 [审查裁决](graph-delivery-evidence/review-adjudication.md)、[准入记录](graph-delivery-evidence/admission.json)、[全部证据](graph-delivery-evidence/README.md)。

补充修复：重试工作区未准入时，原先可能返回 retry_required 却标记 failed；已真实复现并统一为 stop/retry_dispatch_incomplete。runtime setup 纳入 finally，未取得所有权不得修改原有运行；初始许可要求覆盖后续 compiler 家族版本。

主要源码：[host 编排](/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation/packages/cli/src/graph-delivery.ts)、[模板与预算](/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation/packages/graph/src/templates/code-delivery-v1.ts)、[epoch 存储](/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation/packages/core/src/state/graph-verification.ts)。源码在独立实施 worktree；原 checkout 仅镜像报告和任务文档。

## 使用边界与下一步

这是可信 host 的内部执行入口，尚无 G22/G23 面向用户的 graph run/status/cancel/resume。G21 的修复恢复发生在同一 host 实例，经真实子进程交接；全新 daemon 进程重启后的自动装配与故障恢复矩阵仍需 G23/G25 完成。集成测试使用真实 Git、进程、G04/G10、SQLite 和确定性模型适配器；不宣称已完成 live provider 隔离或真实内部试点。

same-UID 不是操作系统沙箱；WAL NORMAL 不保证断电持久性；G27 发行兼容、G28 性能与 G29 真实试点仍待验收。未 merge、push、deploy，未自动完成业务 task FSM。下一批 G22–G24，之后才评定 C7。

下一轮见 [G22–G24 接续上下文](2026-09-15-graph-delivery-next-context.md)。
