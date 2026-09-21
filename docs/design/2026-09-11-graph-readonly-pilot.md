# Graph Engineering 只读试点 G1

冻结范围：2026-09-11，实施前。依据 `docs/reports/2026-09-11-graph-engineering-research.md`。

## 用户问题与接口

“任务 T 在控制库、看板和指定 Loop 文件中各是什么状态？哪些卡片与它直接相关，哪些已有明确阻塞记录？”

`osstack graph explain --task T --db /absolute/private/state.db --board B --state /absolute/LOOP-STATE.json (--tenant ID | --default-tenant) [--json]`

这是实验性诊断命令。由 CLI 适配现有数据，暂不建立公共 graph 包、迁移、索引、daemon RPC 或调度路径。所有输入必填；不发现或打开默认数据库。数据库路径经 realpath 后遵守现有 control-plane guard；直接 readonly/fileMustExist 打开，禁止调用会迁移的 openDb。SQLite 可能使用 WAL/SHM 协调文件；离线副本适合要求零源文件接触的分析。

## 输出约束

- 控制库在同一个只读事务中读取；任务、运行、链接两端卡片均明确限定租户，卡片均限定看板。缺失 scoped task 直接失败，不披露其他租户数据。
- 返回任务事实、任务卡片、最近运行、直接相邻的有向卡片链接。链接只表示 stored relation；不代表执行依赖、传递影响或自动 blocked。
- 阻塞仅来自卡片已存储的 blocked 状态与原因。保留独立状态字段，不推导统一状态。
- Loop 文件限制 4 MiB，使用现有 LoopState schema 验证，返回文件 SHA-256、loop_id、updated_at 和匹配记录。文件没有租户/仓库身份，因此 task_id 匹配只属于 caller-supplied/unverified binding。完成记录的 run_id 可标注是否匹配本次 scoped runs，匹配仍不认证文件。
- 多个来源没有共同快照或时钟保证；差异只是待核实信号，不能推导历史或根因。显示明确的 limitations。
- 每个集合最多 100 条，读取 101 条判定截断，确定性排序；未找到 Loop task、截断均明确报告。空集不代表无影响。
- JSON 是 version 1 实验输出，文本用于快速诊断。错误退出 1，成功（可含截断）退出 0，消费者必须检查 coverage。

## 先验验收案例

1. 正常联查：DB task/runs + 卡片 + Loop 完成记录，保留出处并匹配 run_id。
2. DB done、Loop in_progress、卡片 blocked 同时存在：完整保留，不裁决；普通邻居仍 todo。
3. 跨 tenant、NULL tenant、跨 board、跨边界链接均不泄漏；缺失 scoped task 失败。
4. 成环链接安全返回直接邻接；不拓扑排序、不无限遍历。
5. 缺失 DB、缺表、无效/超大 Loop 文件失败，DB/schema 和状态文件内容不变，无自动建库。
6. >100 条卡片/运行/链接/Loop 记录明确 truncated；相同输入稳定输出（时间元数据除外）。
7. 未知/重复/冲突参数在打开数据库前拒绝；help 可直接查看。
8. 构建后命令对独立临时 DB 端到端运行；现有 CLI 启动预算不退化。

## 对照与停止条件

基线是分别查询现有 SQLite 表、读取 Loop JSON 并手工按 task_id/run_id 对照。固定 fixture 对照必须逐项相同；不把 SQL join 本身称为算法创新。该试点只验证信息完整性、边界和只读行为，不宣称节省人工时间、提升任务成功率。真实使用效果须另收集人工定位时间与错误率；未证明前不扩展为通用图引擎。

## 实施与审查后的补充（保持上述范围）

2026-09-11：先校验 Loop 文件再打开数据库；任意 `--db` 路径额外检查 default/reserved 祖先目录；关系查询以 task_cards 的两个索引方向 UNION 收集候选；Loop 增加每个数组位置的 total/returned/truncated，避免完成记录占满上限时隐藏正在进行记录的存在。

适用性核实：独立 Loop executor 不保证向控制库写入任务/运行。本试点只接受控制库已登记的 scoped task，Loop 文件仍属于调用者声明的关联。真实身份贯通是后续工作，不能由合成测试推导已完成。部署与离线副本的角色允许范围见 `docs/graph-pilot.md`。
