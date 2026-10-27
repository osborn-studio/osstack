# 联合执行与交接

目标不变：吸收 Firstmate 的持续负责、监督和恢复能力，以及 pstack 的调查、设计、验证与工程方法，形成 OSStack 的统一能力。不能以完成基础设施代替两条端到端旅程。

## 单一负责人

唯一主入口为本会话 `01a178ed-616a-7bb1-8d20-13f4c1019245`。Firstmate 主会话完成现有批次后交接，不再自行领取新包。A/B 执行会话的已提交成果由其集成候选保全。历史审计输入和规划表保持冻结；当前状态只在执行账本及对应 OSStack 卡片维护。

Git/GitHub 保存提交、CI、评审和合并事实。OSStack 保存执行、阻塞与证据引用。执行账本是可随仓库恢复的检查点，不是第二套运行时调度器。若看板和 GitHub 冲突，先核验候选 SHA 并纠正投影，不能凭卡片颜色宣告完成。

## 每批推进规则

1. 获取最新 main、前置 PR 的准确 head/base、评审及 CI；保存观察时间。
2. 检查功能依赖、共享文件顺序、开放未知与实际支持范围。
3. 一次推进一个有限实现切片；使用独立 worktree。
4. 在相同候选上完成测试、构建、类型检查和相关场景；运行 Claude CLI Sonnet 5.5 审计，保存完整输入输出及逐项处置。
5. 开小 PR；待合并前置采用明确的 stacked base 与 Draft。前置合并后重定向并重新验证。
6. 将 PR、提交、证据、未验证项、下一步写回 OSStack 与本账本。完成一个切片不等于完成整个 Jxx 或来源能力。

OSStack 管理端使用已安装、固定版本。测试端使用独立 OSSTACK_HOME。当前只承诺有证据的进度管理，不承诺自动恢复本 Codex 桌面会话或自动完成整个项目。

## 当前切片与后续依赖

J02a 已提交 [Draft PR #281](https://github.com/osborn-studio/osstack/pull/281)：只读、离线、固定 Git 对象的来源检查器。依赖 J01 #273 固定候选，不修改方法授权、恢复入口或主控。

J02b 留给分型注册、行为/方法映射、实际采用依赖闭包和旧 manifest 接线；J02a 不提前把整个 J02 或 R03/R04 标为完成。J03 驱动夹具与 J12 真实恢复仍保留其独立验收门槛。

J02a 必须验证：脏工作区不影响结果、精确 commit 重放一致、缺对象/摘要漂移失败、路径与大小边界拒绝、符号链接和子模块拒绝、不执行上游文件、不隐式获取网络对象。SourcePin 的 repository 是调用方已验证的来源标识，本地 Git 配置不能自行提供身份认证。

## 冻结设计与当前实现

设计基线的 48 个来源能力、69 项原任务、32 个工作包与 124 个阶段节点全部保留。当前修订的设计校验包含 69 个未来验收场景、100 个 schema 例子与 227 个来源锚点；文档结构校验不代表全部来源本轮重新抓取，也不代表产品验收。

J01 实现采用 opt-in 的 `@osstack/protocol/joint`，当前实现合同以 #273 为准；设计中的原 schema 保留供追溯。J11 是恢复 DDL 与测试规格，J12 尚待实现。候选迁移号不构成生产编号预留。

## 审计补充的交接约束

若主入口会话不可用，执行状态转为 owner_unavailable，停止新派发，由用户指定接替会话。接替者必须重读账本、当前 main 和未合并 PR；不凭失联自动取消或释放未知执行。

Firstmate 本批移交范围固定为 #275–#279，集成分支 codex/firstmate-batch1-integration，最终代码候选 20b4a81dfcffd80b4919643be362dcfcefad7cf5；之后 dd0f8d09687c6d77394771f61102c9685ec33b2c 只更新导出清单。准确 PR heads 由执行账本记录。交接完成须同时保留发送方报告和本会话接收记录。

J02a 的合同基线固定为 #273 head fad0dd45377255a2d3dfceb08fb28c1524b88ead。源码/契约变化后，旧测试结果不能自动继承。实现者为 Codex；审计者为 Claude CLI Sonnet 5.5。模型审计不能满足 GitHub 所需的独立批准，也不构成运行资格签发。

切片在未合并时只能为 candidate。只有合并提交得到对应 CI/验收证据后才记为 done；真实环境资格另行记录。J02a 推进 J09 bug-fix 方法旅程的来源可重放性，不交付整个旅程。

Source inspection 输出必须携带并摘要绑定 dependency_resolution=not_performed、repository_identity=caller_asserted 及 expected_digest_checked。本切片不导出可脱离上下文的 SourceSnapshot，不将空依赖数组当作依赖闭包完成。J02b 在闭包验证后才构造可供采用的快照。

## 操作入口与恢复检查点

当前管理实例为交接中指定的已安装 OSStack 0.22.1，安装入口指纹保存在 execution-ledger.json。使用现有管理 socket 的 kanban.board / kanban.comment / kanban.move；不要让开发 checkout 打开管理库。精确 home/socket 与重启步骤见 evidence/joint-execution/firstmate/joint-handoff.md。

联合看板名为 joint-firstmate-pstack。每个 Jxx 对应的 card_id 已记录。依赖和验收规则仍由 work-packages.json / execution-gates.json 给出，当前看板 API 不自动执行这些门槛。不能用 kanban.move(done) 代替验收。

执行账本可离线检查：python3 docs/design/2026-10-27-joint-engineering/validate-execution.py。它检查节点、依赖、PR引用、前置候选漂移、交接哈希和完成证据字段；它不会查询实时 GitHub、执行验收或恢复数据库。7个负例/正例测试验证这些局部防错规则。

管理库位于 scratch 根内，不能当作唯一持久副本。每批结束都将联合/原看板 JSON、事件回执、提交、CI观察、测试与审计绑定提交到 Git；重要证据有压缩前后哈希。若管理库被清理，先用版本化导出重建进度记录并核对当前 GitHub；不能把恢复卡片当成恢复任何执行锁、会话或生产状态。本批使用 SQLite backup 做一致性本地备份，没有复制正在写入的单独 DB 文件来假装完整备份。

## 本批验收检查点

最终产品代码 `32bd1bd287a7125fcc71c7312392ec5a3af2413b` 本地全仓库 6161 项通过、5 项跳过；构建、类型检查、lint、清单检查均成功。Sonnet 5.5 最终静态审计 PASS，无具体 P0/P1/P2，原始多轮意见及处置保留。#281 的后续提交只包含文档和证据。GitHub CI 状态单独观察，不能用本地结果代替。

pstack 完整 pstack 子目录 200 个文件及 Firstmate harness-adapters 子目录 21 个文件已按固定 commit 和预期摘要实际重放。这没有验证 Firstmate 全部能力或采用依赖闭包。

下批先处理共享契约链 #272 → #273，随后重定向并重验 #274 / #281。Firstmate 交接链为 #275 → #276 与 #277 → #278 → #279。J02b 在确认 J01 合同与 J02a 检查输出后，推进分型注册、R03/R04 映射及实际采用依赖闭包；保留 J03、J12 各自的依赖和验收。不得绕过尚未完成的独立评审。

#280 早期 CI 揭示历史归档日志被全局 *.log 忽略、冻结输入保留源位置相对链接的问题。已显式纳入原始日志；只对 evidence/inputs/pstack-revision2-*.md 这组冻结引用适用仓库已有的归档规则，所有当前文档仍参加完整链接审计。
