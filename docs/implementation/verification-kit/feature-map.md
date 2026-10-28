# 回答一个已有问题，并确认没有重复应用

状态：候选 `7a6137e5c8140b3469b298058c3ae5dc2ab21cdf` 已实际通过本页确定性路径；清理后证据与 manifest 核对通过。精确审计、运行和未覆盖范围见 [交付记录](delivery.json)。

| 项目 | 内容 |
|---|---|
| 用户行为 | 观察已有任务的问题，提交回答，确认动作已应用；重复同一请求不再次应用 |
| 入口 | `node scripts/smoke-engineering-decision.mjs`；真实编译 CLI，不调用私有 mock API 代替用户命令 |
| 前置 | Node、pnpm 锁定依赖和 `pnpm build`；可用的隔离 scratch 目录；不需要生产凭据 |
| Launch | 确定性免费 Adapter、独立 daemon、专属 home/相对 socket；不复用管理实例 |
| Doctor | 检查当前依赖及构建；缺失时报告失败，不能创建现场或启动 CLI/daemon |
| Drive | watch → adopt → observe → defer → observe → decide → reconcile；同幂等键重放 |
| Evidence | 命令观察、applied 回执、replay、单次 invocation、drain、来源/构建摘要和环境；不保存凭据 |
| Cleanup | 只停止自己启动的进程；确认停止后清理现场；证据目录独立保留。停止不确定时保留现场并报告失败 |
| 业务判据 | `observed_turn`、`applied`、重放不增加 invocation，drain 无剩余执行/图/attention lease |
| 总体判据 | 业务判据、证据成功写入和清理均成功；业务 applied 与 cleanup 失败分别记录 |
| 不覆盖 | 真实 Provider、宿主接续、非默认租户、远端、断电、敌对同 UID、进程域 fencing、完整功能地图 |

## 维护规则

修改 CLI 命令、回执、fixture、进程清理、构建方式或依赖时，重新检查本页来源并实际运行。缺依赖、权限、数据时记录 blocked；不得删除路径、换成 mock 或放宽断言让结果变绿。候选变化后，旧证据只属于旧候选。

`--dry-run` 的无副作用承诺必须由目录和进程观察验证，不能依据参数名判定。正式验证记录必须区分 command exit、业务结果、清理结果和未验证范围。此地图只有一个功能，首次成功不代表其他用户路径通过。

来源：`scripts/smoke-engineering-decision.mjs`、`scripts/fixtures/engineering-crash-host.ts`、`packages/cli/src/engineering-command.ts`。吸收来源及许可见共用方法包的来源声明。

## 可复制入口

在仓库根目录执行，先设置专属 `OSSTACK_SCRATCH_ROOT`（不要设为仓库或卷根目录）：

```sh
node scripts/smoke-engineering-decision.mjs --doctor
node scripts/smoke-engineering-decision.mjs --dry-run
node scripts/smoke-engineering-decision.mjs
```

默认运行会报告独立保留的 evidence 目录。需要指定位置时，追加 `--evidence-dir /absolute/path/to/new-directory`；父目录必须存在，目标目录必须不存在。读取其中 `receipt.json`、`run.json`、`observations.ndjson`、`cleanup.json` 与 `manifest.json`，逐文件复算 manifest 中的 SHA-256。证据可复查不代表来源获得独立认证。
