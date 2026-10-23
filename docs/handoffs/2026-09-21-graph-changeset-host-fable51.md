# P05b host 调用证据链交付与审计

日期：2026-09-21；基线 `55934b2`；分支 `codex/graph-decision-development`。

[实现契约、持久化顺序与后续工作](../design/2026-09-21-graph-changeset-host-evidence.md)

## 本批结果

新增私有调用证据存储与内部 host 调用服务，连接“请求证据 → 单次调用 gate → HTTP → 响应/终止证据 → ledger”。非 proposal 响应及失败结算改为原子事务，避免两个数据库提交之间留下半完成账务状态。

没有注册生产 GraphRpc/CLI executor；没有真实 Git 多文件 applier；真实 token 上限证明与 profile/grant/物理 lease verifier 仍需由生产 enrollment 完成。本轮验证不使用真实模型 provider；Claude CLI 审计本身按用户要求实际调用 Fable。

## Claude Fable 5.1 审计

CLI 显式使用 `--model claude-fable-5-1 --effort medium`，关闭 slash commands 和工具，stdin 为临时源码文档。结果同时有辅助 Haiku 和主模型 modelUsage，确认主模型实际执行。

首轮结果：is_error=false。完整 JSON SHA256：`295867c460c599e9fdd0f8ac1b8e84262315e5064d6bc0cfadf7a6d7c783f2b4`。原始结果保存在本机任务临时审计目录，摘要用于本机核对，不承诺临时文件永久保留。

| 审计意见 | 处理与证据 |
|---|---|
| 硬链接发布窗口遗留 nlink=2，完整证据无法读取 | 采纳；改为文件/目录同步后的目录原子 rename，3 个真实 SIGKILL 窗口及并发发布测试 |
| 拒绝响应与失败结算分开提交 | 采纳；新增 recordRejectedInvocation，一次 fenced transaction，故障注入证明响应和 outcome 一起回滚 |
| 无关 revision 更新导致已知响应降为 unknown | 采纳；只对 REVISION_CONFLICT 做最多 3 次 DB 写入重试，固定 generation/owner，HTTP 不重试 |
| proposal 可能超过 ledger reservation | 未复现；client 已拒绝输入/输出 token 上界超限，host 又要求 reservation 覆盖两者之和；超额/usage 溢出测试验证失败和 accountingBlocked |
| proposal 的 actual usage 不立刻结算到 action | 保留设计；apply 前继续持有 reservation，实际 usage 在持久化 terminal receipt，不能提前释放容量 |
| client 在 true gate 后返回 not_authorized | 按实际 client 控制流不可达；重复调用不能把另一活动请求误标 unknown；修正其他 claimed 异常的错误分类 |
| 重复摘要实现和宽松 Base64 decode | 采纳；共享摘要函数并检查 Base64 往返一致性 |
| effectKey 不含 generation 可能覆盖请求 | 不采纳；这是既有协议的明确设计，旧 action 保留 generation，beginInvocation 拒绝代际不匹配，重试增加 logicalAttempt |
| lookup 把根目录丢失当普通 absence | 采纳；单独检查 root，已发布目录缺文件属于损坏，不能覆盖 |
| 异步/foreign authority Promise 可能未处理拒绝 | 收紧；精确 undefined 才授权，其他值由 Promise.resolve 捕获异步拒绝且不发请求 |

另由本地测试发现并修复：慢 verifier 后仍沿用旧时间会越过原 deadline；已将最终时间刷新移至验证后。新增私有目录已有证据文件丢失时禁止覆盖的防御测试。

## 验证与限制

Node 22.22.1，独立 worktree，开发 CLI 仅使用临时 OSSTACK_HOME。

- core state + invocation evidence：35 文件，471/471。
- agents 全包：24 文件，351/351。
- CLI host/broker/daemon broker：原 75 项通过，新增 foreign Promise 用例后 host 文件 23/23；不同测试总数为 **898**，不重复累加重跑。
- core、agents 构建及 CLI strict typecheck 通过；变更 TS Biome、inventory、git diff --check 通过。
- startup：version 中位 51 ms（预算150，范围49–53）；help 中位128 ms（预算500，范围118–317），各5次，隔离 OSSTACK_HOME。
- agents 首轮与其他大套件并行时，旧 adapter-conformance 用例触及 5秒超时；保留原阈值、maxWorkers=2 重跑全包通过，该用例约1.6秒。未修改或跳过原测试。
- 新功能经历 RED→GREEN，包括无接口、原始 response bytes、慢授权时间、半提交拒绝结算、revision 竞争、损坏目录覆盖等。

私有证据存储与 WAL FULL/EXTRA 要求已实现；进程 SIGKILL 不证明物理断电。production 默认仍未启用新服务。已有 response/terminal 证据的 unknown 恢复入口尚待实现，不能自动释放物理 admission。

## 第二轮复核有效性记录

第二轮 CLI 返回 is_error=false，且有 Fable modelUsage，但 result 只有准备读取 markUncertain 的工具调用文本，没有最终审计结论。不能把 API 成功或 modelUsage 当作审核通过。本轮工具已禁用，该文本未执行。结果 JSON SHA256：`d4dd17030967a0bf0d38c5e7ae94d5a93b9190f50f9c1be589655d34e7f5b642`。

已补全 markUncertain/persistOutcome 等上下文，重发限字、无工具、单轮复核，并限制输出及调用费用。

限字复核已完成：显式 `claude-fable-5-1`、effort=low、max-turns=1、输出上限3000、费用上限1美元，is_error=false。返回明确的最终结论为限定 host port 范围内没有 blocker，同时声明没有重跑测试。JSON SHA256：`8957e5676852ff4898994c4b2a1742fd138a490d4e86bde1d3e2b828419146fd`。该源码意见不等同于生产激活或合并授权；实际测试结果由本地工具独立验证。
