# J11 恢复规格：main 重定向与复验

基线 main：`69859eecfcc84af9d6eff755ed41243ca5f51f95`，已包含 #273、#275、#277、#280。最终代码候选：`7ea45584ce0de01860571100beb5daed4ff83f31`。原 stacked base 的证据仍保留，不能自动继承为本次验证。

状态：本地最终全仓 6174 通过、5 跳过、0 失败；22 个包全部完成。构建、类型检查、lint、清单检查均通过。Sonnet 5.5 最终静态审计 PASS，无 P0/P1/P2。转 Ready 后由用户使用 gilberthello 独立审批合并，GitHub CI 按最终 PR head 单独观察。

本次对齐严格 kind 解码、六项证明上下文、主机加载证明与收据关联；SQL 补强阶段/决策及内部 home 一致性。重新冻结 47→48 候选 DDL 与完整 catalog，更新独立 Python schema 摘要向量。freeze 工具固定仓库根目录，拒绝基线漂移和未跟踪状态源码，强制构建后再加载迁移器。

14 项恢复规格测试通过，包含 40 组 Attention 阶段/决策组合、变异检查、收据与 MigrationSpec/独立候选身份关联、证明上下文拒绝后零写入。嵌套目录调用 freeze 时的未跟踪源码拒绝探针通过。

Sonnet 5.5 第 6 轮静态审计 PASS，无 P0/P1/P2；所有先前 REVISE、输入与逐项处置完整保留。模型审计与执行测试分开记录。

J11 不注册迁移，不打开服务控制面，不实现 J12 恢复入口。当前数据库仍为 47；48 是候选号码。权限、真实归属、当前状态 CAS、WAL/FULL 进程崩溃、供应商 containment 和 broker 恢复仍按 J12/J17 验收。

## 证据与复现

[审计处置](audit-dispositions.md)；`evidence/` 保留每轮完整提示、文件 SHA256、原始 JSON/Markdown 和主机验证日志。日志/输入以 gzip 保留，manifest 同时记录原始和归档字节哈希。

最终验证使用 Node 22、冻结 lockfile、独立 OSSTACK_HOME/OSSTACK_SCRATCH_ROOT：`pnpm build`、`pnpm typecheck:check`、`pnpm lint`、`node scripts/generate-inventory.mjs --check`、`pnpm test`。另检验联合 schema 漂移、Python 摘要、changeset、相关包的实际打包与来源重放。中途被审计修订替代的测试不算最终候选通过。

合并计划：#274 保存本批中央联合账本，#281 保存来源包及独立证据；共享文件没有并行覆盖。已做 Git merge-tree 冲突检查，其结果不等于联合 runtime 资格。建议先 #274 后 #281；合并时以当前 head 的必需 CI 和用户审批为准。
