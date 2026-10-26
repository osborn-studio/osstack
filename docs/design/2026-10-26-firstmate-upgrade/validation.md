# Roadmap verification / 路线图验证

日期：2026-10-26。验证对象：以 main `c1cfccf18df97fa4b8bc2ed1752071feda9c3670` 为基线的设计文件；未修改生产源码。以下是设计一致性和基线回归证据，不是新功能的实现或环境资格。

| 检查 | 结果 |
|---|---|
| 原设计及 74 个固定来源哈希 | PASS；24 项能力、37 项计划与原场景保持原状 |
| 新路线图校验 | PASS；24 项能力、50 个工作包、无未知依赖或循环、无孤立工作包 |
| 验证器负例 | 循环依赖、虚假启用、虚假完成、缺失能力和未知来源五种变异均被拒绝；文档本地链接无缺失 |
| 新来源身份 | 63 个附加锚点的固定 Git 对象与 SHA-256 一致；含当前 main 的模块锚点 |
| 来源检查边界 | 哈希不是语义认证；仅选定契约片段已读取，上游测试未在本次设计中执行 |
| `pnpm build` | PASS |
| `pnpm typecheck:check` | PASS |
| `pnpm test` | PASS；22 个包、5,952 passed、5 条件跳过、0 failed；本机 macOS / Node 22 |
| 看板登记 | 50 张卡；38 todo、8 done、4 blocked；第二次导入创建 0 张，回读一致 |
| 原工作区 | 原有修改保留；使用独立 worktree、scratch 与管理 home |
| 模型审查 | 本次没有另跑 Claude 审查；不把历史审计计为本次设计的复审 |

本机测试数字与基线 Linux CI 的 5,950 passed / 7 skipped 不同，源于平台条件测试，不合并成一个统计。新增路线图没有让任何未来 feature 测试变成已通过。

重放检查：

```sh
python3 docs/design/2026-10-26-firstmate-upgrade/validate-roadmap.py \
  --verify-sources --firstmate-repo /path/to/firstmate
python3 docs/design/2026-10-25-engineering-agent/validate-design.py \
  --verify-sources --firstmate-repo /path/to/firstmate
```

旧验证器需要 Python `jsonschema >= 4`；新验证器只使用标准库。两者只读 Git 和设计文件，不打开数据库。新验证器检查记录 ID、继承哈希、依赖图、范围、来源身份及能力覆盖，不声称验证未来运行时 JSON 协议或功能正确性。

OSStack 看板是 `firstmate-upgrade-roadmap`。卡片回执见 [board-receipt.md](board-receipt.md)。当前导入使用现有 RPC 和外部单写者锁，依赖写在正文；服务端原子 upsert 和原生依赖门禁仍由 M01 实现。三张 DEBT 卡是原债务的路线图投影，不是新增三项债务。

真实环境待验：物理断电、恶意同 UID 隔离、残留子进程终止证明、受控 Claude 故障、远端及非默认租户、长期运行、完整用户对照。WD-19/28/32/33/41/43 保持未获得完整资格；旧试验中断且诊断丢失仍待追查。新 X 系列真实 provider/终端/公开渠道组合也未认证，默认禁用。

发布门禁另有已观察到的外部阻断：Actions 无权创建版本 PR。完成设计与任务登记不解除此限制，也不构成 npm 发布、服务升级或生产部署。

## English

The original frozen design is preserved. The new roadmap links all 24 capabilities to 50 work packages and checks their dependencies and pinned sources. The baseline build, type check and full local test suite pass. The board contains 38 planned packages, eight completed local-pilot packages and four packages with qualification or release blockers. No new controller, provider qualification or default activation is delivered by this design change.
