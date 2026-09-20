# OSStack Graph 升级：PR 就绪进展与未关闭事项

2026-09-20。用户要求先把当前成果提交 PR，再经审批合并和部署。本报告据此记录可评审的实际进展，**不宣称 30/30 或生产发布已完成**。任务卡仍有 G25–G29 五项待最终验收；它们主要是发布验证与运行保障，不是五个尚未开始的核心功能。

## 已实现并有证据的能力

有界单仓库目标 → 单次实现 → 不可变 candidate/产物 → 并行独立审查与隔离测试 → 严格汇合、有限修复/重试、明确停止。复用现有 Agent、Loop、权限与规范仓库锁。账本/checkpoint、generation fence、准入撤销、取消、受控执行器核对均已实现；unknown 不自动重发。

真实 DeepSeek 在 OSStack clone 上完成一项代码修复，达到 ready；独立 reviewer 拒绝负对照；取消真实推理后保留未知结果及预算。完整记录见[试点报告](graph-runtime-pilot.md)。本轮额外修复了旧入口回收 graph 保留锁、升级遗漏图执行、真实仓库 artifact 导出/恢复过慢等问题。

## 验证状态

| 项目 | 当前事实 |
|---|---|
| 全仓 build/test | 22 个包，3,727 项通过；1 个 opt-in 性能测试在常规测试中跳过，另走专用基准 |
| 实际 OSStack Loop 验收 | executed=1、skipped=0、outcome=success；4 个 verifier 全通过 |
| 类型/schema/启动/whitespace | 通过；version 29ms、help 83ms |
| Lint | 通过，有 6 条非阻断既有 warning；显式控制字符拒绝规则加说明性 suppression，行为未改变 |
| Node 20.6 / native SQLite | 294 项通过；最终变更另有 25 项通过（有重叠，不相加为不同测试数） |
| Linux Node 22 / native SQLite | 干净安装和构建完成；366 项中 363 通过、3 项超时，尚不能认定平台验收通过 |
| 故障矩阵 | 最终固定 seed / 重复运行正在执行，源码与 dist 哈希绑定 |
| 性能 | 首轮 RPC p95 与 Loop 开销通过；最终压力基准待收口 |
| 独立代码审查 | 实际 Claude Fable 5.1 对锁/升级/平台修改及 artifact 边界修复给出 accept；不是 GitHub 人工审批 |
| GitHub / 合并 | 分支在审查前落后 main 20 个提交；需整合、CI 和独立审批 |

证据在[验收目录](../implementation/graph-upgrade-final-evidence/README.md)。失败、超时和取消 unknown 均保留，未计作通过。

## 尚未正式完成的五张卡

| 卡 | 已做 | 尚欠 |
|---|---|---|
| G25 故障/并发 | 真实崩溃、进程身份、受控核对、F01–F12 对应回归 | 最终固定 seed 矩阵及证据汇总 |
| G26 兼容/回滚 | 禁用新准入保留读/取消/核对；SQLite 备份重开；旧 Loop 锁；升级 guard | 与 G25 联合签收，并对最新 main 回归 |
| G27 运行时/发行 | Node 20.6 通过；Bun graph 明确拒绝；旧发布锁测试 | Linux 三项超时排查复跑、最终发行/CI |
| G28 性能 | 真实仓库瓶颈已修；首轮预算与宿主隔离通过 | 加入大 fingerprint 压力的最终测量 |
| G29 内部试点/手册 | 真实任务、负对照、取消/费用证据及运行手册已完成 | 等前述门槛通过后正式宣告内部 beta |

## 已确认的技术债：五类（限本次 Graph 范围）

1. **集成与评审债，合并前处理**：长期分支积累 78 个提交、落后 main 20 个提交；大量逐轮证据使 PR 达到两千余文件。合并预检已发现两个冲突文件：`packages/core/src/state/migrations.ts` 与 `packages/loop/src/executor.ts`。双方迁移 25–27 重号是发布阻断，必须保留 main 已有迁移语义，并验证升级不会遗漏表或误读旧试验 DB。需要同步 main、明确阅读顺序并在最终提交上重新审查。文档证据保留不应掩盖真正的代码差异。
2. **测试环境可重复性，发布前处理**：并行虚拟机与磁盘压力曾引发 ENOSPC 和超时；隔离到外部磁盘、串行执行后全仓已通过，但 Linux 尚有三项超时需在健康环境确认。不能简单提高超时预算。
3. **主线程尾延迟，中优先级**：有界 workspace fingerprint 最终核对仍在 SQLite 事务内同步读/哈希；首轮 RPC p95 达标但有较长尾部。需要记录最终压力结果，并考虑保持 TOCTOU 防护前提下缩短事务/减少主线程工作。
4. **异常资源运维，中优先级**：未证明停止的远程推理、opaque executor 与 artifact 残留锁需要保留证据和人工处理。后续可增加证据充分的回收工具和可观测性；不能用“人工强制成功/未执行”绕过现有保护。
5. **大产物内存成本，中优先级**：batch Git 将进程数量大幅降低，但完整 buffer / bundle 的峰值内存仍随受限产物大小增长。现有 256 MiB、100000 文件限制明确；更大仓库需要流式实现与 RSS 基准，不能直接提高上限。

这是本次已确认事项清单，不是对全仓“只有五个问题”的保证。

## 明确产品边界，非本轮缺陷

Bun 单文件不支持 graph；SHA-256/shallow/submodule 等未支持仓库格式显式拒绝；任意动态拓扑、多仓库蜂群、无证据恢复，以及自动 merge/deploy 不在本轮 v1。需要这些能力时单独立项，不应无限追加到当前 30 张卡。

## 合并与部署路径

已创建 [Draft PR #225](https://github.com/osborn-studio/osstack/pull/225) 展示成果；当前 GitHub 状态为 CONFLICTING / REVIEW_REQUIRED。完成上述门槛及 main 整合后转正式评审。GitHub main 的 branch protection 要求一位审批者，且最后推送需要独立批准；不绕过、不冒充已审批。通过后合并，按现有部署方式备份和迁移，先关闭新 graph 准入验证旧功能，再只对内部指定仓库启用受控模板。未知动作尚存在时禁止盲目回退 DB。

部署目标、实际 serving home 和回滚版本必须与已有部署事实一致；本报告不授权随意选择另一台服务器。操作说明见[运行手册](../runbooks/graph-runtime.md)。
