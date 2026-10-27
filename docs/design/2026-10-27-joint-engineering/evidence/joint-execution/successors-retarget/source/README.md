# J02a 来源检查：main 重定向与复验

基线 main：`69859eecfcc84af9d6eff755ed41243ca5f51f95`，已包含 #273、#275、#277、#280。最终代码候选：`26e7e02d4cdc931aa6d2b852d1b83cedc74238ef`。原 stacked base 的证据仍保留，不能自动继承为本次验证。

状态：本地最终全仓 6194 通过、5 跳过、0 失败；22 个包全部完成。构建、类型检查、lint、清单检查均通过。Sonnet 5.5 最终静态审计 PASS，无 P0/P1/P2。转 Ready 后由用户使用 gilberthello 独立审批合并，GitHub CI 按最终 PR head 单独观察。

本次对齐最新共享契约，证明 source_inspection 不能冒充方法、许可、恢复证明或闭包快照。来源读取改为两次有界 Git batch 调用：先检查所有大小，再校验二进制 framing、Git 对象 ID 与原始字节哈希。补充公开包入口、恶意路径、513 文件/大树、二进制与空对象、敏感来源标识检查；不增加 runtime consumer。

来源包定向验证 37 项通过。512 文件重复对象夹具曾测得约 134 ms（原逐文件实现约 7–8 s）；这是固定本机夹具，不是通用吞吐/SLA。最终版本以归档全仓日志为准。固定来源重放保持 pstack 200 个文件、Firstmate harness-adapters 21 个文件及既定摘要不变；不代表完整 Firstmate 或采用依赖闭包。

Sonnet 5.5 广泛审计及收口 PASS；所有原始意见保留。最后的防护测试已用真实 Git 夹具纠正，并用删除防护/恢复防护变异检查证明可区分。完整本轮意见及最终复审以 evidence 中原文为准。

J02b 仍负责接收端 schema/digest 验证、来源认证、license ref 约定映射、分型注册及采用依赖闭包。树对象解释信任 Git/store；独立验证覆盖 commit/blob 字节及 manifest 摘要，不提供生产资格。同步 API 仅用于受控 worker/child，初始支持范围为 POSIX。

## 证据与复现

[审计处置](audit-dispositions.md)；`evidence/` 保留每轮完整提示、文件 SHA256、原始 JSON/Markdown 和主机验证日志。日志/输入以 gzip 保留，manifest 同时记录原始和归档字节哈希。

最终验证使用 Node 22、冻结 lockfile、独立 OSSTACK_HOME/OSSTACK_SCRATCH_ROOT：`pnpm build`、`pnpm typecheck:check`、`pnpm lint`、`node scripts/generate-inventory.mjs --check`、`pnpm test`。另检验联合 schema 漂移、Python 摘要、changeset、相关包的实际打包与来源重放。中途被审计修订替代的测试不算最终候选通过。

合并计划：#274 保存本批中央联合账本，#281 保存来源包及独立证据；共享文件没有并行覆盖。已做 Git merge-tree 冲突检查，其结果不等于联合 runtime 资格。建议先 #274 后 #281；合并时以当前 head 的必需 CI 和用户审批为准。
