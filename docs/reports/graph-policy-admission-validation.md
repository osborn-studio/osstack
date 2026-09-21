# Graph 权限检查输出保全修复

2026-09-21。生产部署 SHA 为 `e6f0658`，新准入关闭。此文记录 follow-up 修复，不宣称已部署或 G29 完成。

## 触发与行为

真实生产试点已完成实现、候选冻结和 reviewer accept，测试启动前被 `POLICY_DENIED` 拒绝。四个对应仓库路径在空闲时重新授权均通过。单独复现了相关机制：启动 `git rev-parse --show-toplevel` 并配置 Node `execFile` 的 5000ms timeout，主线程停顿 6000ms 后，子进程退出码 0、stdout 却为空；内建 timeout 在处理已排队的输出之前销毁了流。候选验证同步读取/哈希期间存在同类主线程停顿窗口。

仅三个只读 Git 查询（common-dir、top-level、worktrees）共用新 helper；保留参数数组、禁用 shell、过滤 GIT_* 环境、禁用全局/系统配置、64 KiB 输出上限与 5 秒进程期限，并统一 LC_ALL=C。超时判断移到一次 I/O poll 之后，仍存活的进程发送 SIGKILL；已结束进程的输出正常排空。额外的 250ms 输出关闭上限处理继承管道：强制关闭时必须拒绝，不能把截断输出当成功。仓库真实路径、共同 Git 目录和策略撤销检查均保留。

## 回归与发布检查

- 核心 31 项通过：8 项仓库身份/子进程回归（真实 6 秒停顿、输出溢出、真正挂起 Git、退出后继承管道）和 23 项历史迁移辨识。
- 全仓构建与类型检查通过。模块新增代码的增量加载约 3.33ms；node:child_process 在旧仓库身份模块中已加载，不增加新的重量依赖。
- 公共 Release 的两个 macOS fixture 传入 /tmp 别名，原先 73/73 失败；新 fixture 在创建根目录时 canonicalize，保留生产反替换检查。72 项 recovery 回归在首次修正后通过。真实 Git freeze 单独运行 4.85 秒，负载下 8.30 秒，因此该集成测试观察预算设为 15 秒，不修改产品期限。
- 历史 migration fixture 改为事务构造初始状态，避免大量 DDL 各自 fsync；实际被测 openDb/runMigrations 与崩溃/WAL断言不变。
- 新 macOS PR job 通过 /tmp 路径跑针对性回归；原 required check 使用 always() 和显式结果断言依赖它，避免依赖失败时仅 skip 被当成通过。
- 主机繁忙时的 CLI 回归仍出现其他既有 5 秒测试超时，原始失败保留；不将失败计为通过。完整本地测试与最终 PR CI 另行记录。

隔离真实试点第一轮在克隆阶段触发观察器 15 秒 RPC timeout；已确认没有模型调用，正常关闭 daemon 后为 cancelled。第二轮仅将私有观察器等待上限改为生产验收使用的 90 秒；原 600 秒图期限、最大动作数和 token 预算不变。最终结果待记录。

私有证据在 `/Volumes/AIMATE_WORK/tmp/g226-deploy`；不上传数据库、凭据或完整主机运行记录。G29 最终关闭仍需要审批合并后的生产试点，不能由单测或隔离试点代替。
