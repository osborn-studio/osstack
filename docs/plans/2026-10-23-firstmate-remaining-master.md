# Firstmate 后续开发总计划与交付账本

起点：PR #237 最终整合提交 `2d33db37`（尚待完整当前提交资格与独立人工批准）。旧研究的 24 项是能力地图；目前 8 项本地实现、12 项部分覆盖、4 项未新增，不用计划数量换算完成比例。

## 详细设计

- [产品集成：控制台、契约、受限分诊、路由评估、上下文、lesson](2026-10-23-firstmate-remaining-integration.md)
- [可靠性：单飞监督、通知吞吐、事件补读、公平性、恢复与性能](2026-10-23-firstmate-remaining-reliability.md)
- [扩展：worker 视图、发布范围、home 盘点、承诺账本与远程协议](2026-10-23-firstmate-remaining-extensions.md)

三份方案均有真实源码落点、接口、依赖、对抗验收与回退。方案完成不等于实现完成。

## 分批执行

| 批次 | 可独立闭环的产物 | 依赖与验收 |
|---|---|---|
| 1 | 主 Cockpit 的只读 Attention 摘要；监督单飞与可等待停止；真实路由器 golden 评估 | #237 通过；分别测试 disabled/stale/跨 repo、停止竞态/晚到结果、显式路由覆盖/风险角色；主线程集中装配入口 |
| 2 | 通知有界批处理；run event 有界分页与补读；daily 统一摘要 | 第 1 批服务生命周期稳定；迁移编号串行；不引入执行权限 |
| 3 | V2 交付契约及实际 guarded delivery 接线；实际 prompt 上下文证明；执行证据转 lesson | 分清 base/candidate、可信 checks/review、只读 scout；不接受外部 passed 布尔当证明 |
| 4 | 显式无工具分诊、持久预算；可见 worker 只读视图；home 盘点；本地 obligation 账本 | 首轮默认为本地、显式选择；不打开公开消息或远程控制权限 |
| 5 | Graph 契约/context；公平调度、恢复诊断与性能资格；真实模型成对路由评估 | 保存精确候选与模型请求证据；真实模型收益未知时保持 shadow |
| 6 | 远程只读投影、viewer 后端、公开 transport、多 home 升级协调 | 独立身份、断线 unknown、未知投递不重试；有实际 host/transport 才能取得端到端资格 |

并发上限为主线程 + 3 位 subagent。隔离 worktree 下开发，单代理独占一个功能文件集；daemon/bin、migration、public schema 和集成验证由主线程统一接线。PR #237 未合并时后续 PR 明确依赖其 feature 分支，不能把后续代码直接混入 #237 或声称已上线。

## OSStack 管理和完成门槛

任务通过 `osstack loop enqueue` 写入独立 scratch 工作区，记录 task id、先决条件、源码提交、反例测试和审计文件。执行/验证回执用 Loop 产生；失败保留并用原生 retry 建新尝试，不改旧失败为成功。

每批执行：设计锁定 → 子代理代码及定向测试 → 主线程集成 → Haiku 5.5 独立静态挑战 → 修复确证阻断 → 完整 build/typecheck/test/lint/schema/inventory/startup → exact-head CI → PR ready。GitHub 独立批准仍单独需要；不自动合并或部署。

对远程主机、公共 transport、特殊终端后端等未配置的真实环境，仅交付可测试的本地接口不算完整能力资格；必须在能力表保留“部分/未验证”，绝不以模型审计替代真实运行。

## 第一批实现冻结补充（Haiku 设计挑战后的处置）

这节为统一排程与接口裁决；三份分轨方案是完整路线图，不各自启动三个代理。**首批仅 Cockpit、监督生命周期、确定性路由三条，最多 3 个子代理**。依赖基线固定为 `2d33db37cebb2e37036625c555c602c6e305cffe`；只有该提交的 #237 资格完成后才开源码实现。后续 contract V2 由主线程统一拥有 schema，B0 与 P1 发布范围在同一个设计中冻结，不分代理各写一份。

### Cockpit 摘要口径

- 数据范围为本地同 UID 现有控制面、默认租户、显式 canonical workspace。首次实现不提供未授权跨租户全库汇总。行列表、分页总数和各分类总数使用完全相同的 repo/tenant 条件；无 workspace 的全局模式必须显式标为本地 overview，不能套用“当前仓库”文案。
- “未监控”仅指所选 workspace 下**已有 scope 的已发现但未 admitted subject**；未绑定的任意仓库不在分母。所选 workspace 完全没有 scope 时状态为 not_watched，不报告健康的零待办。
- 单事务一致性只覆盖 Attention 区块；整个 dashboard 不宣称统一事务。服务停用、来源过期、旧 schema 都有显式状态，不用 0 表示未知。
- 首批只显示事实、只读 drill-down，不添加自动 answer、abandon、cancel action。用户文本做终端控制字节与 HTML 转义。p95 是待测目标，不是预先宣称已达标。

### 监督生命周期合同

- 每个异步 reader 接受 AbortSignal；宿主有独立 deadline（默认 1 秒，测试可注入更短值）。超时/拒绝/坏 payload 分别记 unknown 原因，之后继续其它来源，不能让一个来源拖住整个 pass。
- stop 先将 stopping/epoch 围栏置位、清 timer 并 abort reader，再等待服务内 pass/drain 退出。超时不代表底层 OS IO 已物理结束；晚到 promise 只能丢弃结果。对尚未真正 settle 的同一 reader 不再开启新物理读取，避免超时后无限积累 IO。
- 每次投影提交前同步检查 stopping、epoch、binding 和 generation；检查至已有 fenced SQLite write 之间没有 await。daemon 必须 await supervision.stop 后才关闭 DB，这个集成校验在**同一 PR**由主线程完成，不延后承诺。
- 验收分别覆盖 reject、期限到达、永不 settle、stop 后迟到；证明所有其它来源继续进展，重复 start/dirty 不增加并发扫描，DB close 后零读取/写入。真实底层 IO 清理和多平台资格独立报告。

### 确定性路由评估合同

- 首批不实现模型意图分类器。golden 直接给出 routeCapability 所需 capability、policy、可用 adapter 集合、成本/角色约束与显式 agent override；测试 harness 调用真实 routeCapability 或既有 resolveLoopProfileRouting，比较选中 adapter、required role、拒绝原因及 override。
- 不创建 provider/adapter invoke；spy 验证模型调用为 0。缺失 case、重复 ID、非法期望、空数据集或无结果均为 incomplete。报告 dataset hash、case 数量与逐例差异，不接受外部 supplied_predictions 充当真实运行结果。
- 该数据集是人工可审阅的回归矩阵，不声称独立 holdout、泛化准确率或模型 token 节约；标签理由随 fixture 提交供独立 PR reviewer 复核。真实模型成对实验放第 5 批，届时另定标签复核、holdout 安全样本数、置信区间、seed、采样参数和重复批次。

### 后续共同边界

V2 契约须同时包含 publication_scope（none/draft_pr/push 等严格枚举及目标 repo/ref）和 merge_authority（引用既有审批策略，字段本身不授予权限）；最终字段以真实既有风险与发布 API 为准。R2 重试去重只对本地幂等 artifact sender 作保证，不能直接复用于公共发送。Haiku 仅是独立调用的静态挑战，原始输入/输出留档，不冒充独立实机验证。
