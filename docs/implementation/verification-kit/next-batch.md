# 下一小批：来源检查失败不能返回成功

只读预检发现候选：`packages/cli/src/skills-command.ts` 遇到 `checkSource` 的 `ok:false` 只打印 unreachable，最后只按 drifted 数返回退出码，因此所有检查失败仍可能返回0。已在当前构建、隔离 home 与 file:// 自有仓库实际复现：不存在 ref 输出 unreachable/no_matching_ref，仍退出0；存在且blessed一致的正控制输出up-to-date并退出0。预期在运行前固定，源与build摘要前后未变。原始材料保存在本批 scratch 的 next-baseline，下一批须绑定其正式修复候选。

1. 用 scratch 内真实本地 Git 仓库和 `file://` origin，显式隔离 home、Git 配置与凭据，运行实际编译 CLI `skills check`，目标ref不存在。预先固定断言：无法完成检查必须非零；先保留基线实际退出码。
2. 仅在实际复现后修复相邻 CLI 实现与测试。建议退出语义：任何检查失败为1，只有漂移为2，全部成功且无漂移为0；混合时失败优先，摘要保留两类数量。最终须验证现有调用者兼容性。
3. 相同 fixture、相同命令、相同不存在ref复验。GREEN 是回归断言成立，来源检查本身仍如实失败，不通过改变输入让其成功。
4. 正控制覆盖真实存在且blessed一致、真实漂移、混合失败与漂移、空来源。保留 baseline/candidate/build 字节与原始输出。
5. Codex/Claude 可各自显式读取相同材料执行只读调查；仅有完整宿主记录时更新其实际消费单元，模型名不代替独立身份。

写边界：产品实现与相邻测试一位owner；新的专用真实验证脚本/fixture另一位owner；主入口独占证据/账本/PR。不能把本批engineering decision路径当成skills check的证明。该候选不需要新增MethodBinding、数据库迁移或授权入口。正式派工前再次核对最新main、活跃任务与实际RED。
