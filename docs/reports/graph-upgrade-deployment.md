# OSStack PR #225 部署记录 — 2026-09-20

**已合并并完成关闭 Graph 新准入的部署；内部启用验收未通过，G29 仍在进行，29/30。**

## 已验证

- PR #225 最终提交 `daf5fe4` 于 2026-09-20 获独立 GitHub 审批，合并 main 为 `d2483d19d3a1bfd740be9412010aab2c93a44889`。
- PR CI [35552112794](https://github.com/osborn-studio/osstack/actions/runs/35552112794) 与 main CI [35560813025](https://github.com/osborn-studio/osstack/actions/runs/35560813025) 均成功；PR 全仓 3,974 项通过、3 项显式跳过，Node 20.6/22.23.1 检查通过。收费 DeepSeek CI job 按配置跳过。
- 完整 serving home、旧安装与 LaunchAgent 备份位于 `/Volumes/AIMATE_WORK/Backups/osstack/20260920-d2483d1`。服务停止后核对 DB 内容哈希；socket 不作为数据备份，已关闭连接清理的 WAL/SHM 不伪造为历史文件。
- 真实 serving DB 从 schema 22 升至 37；原有 51 张表没有丢记录，完整性与外键检查通过，旧 session/Loop/stats RPC 正常。旧未完结历史未强行清账。
- 当前安装目录 `/Users/osborn/.local/share/osstack/releases/d2483d1`；全局 `osstack` shim 已指向此安装。CLI 包版本仍为 0.19.0，以源码提交与 tarball 哈希识别本次内部构建。
- 已用完整 owner-only 配置验证 `GRAPH_ADMISSION_DISABLED`，关闭时零新增 run。真实 launchd 服务存活、未 draining；未修改 OStag 独立安装。

## 生产试点结果与当前阻塞

仅授权 `/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-internal-beta` 的固定任务，交付方式 `artifact_only`，有明确期限与预算。凭据从现有 0600 文件加载，不放入 plist、Git 或报告。

1. 外置盘 Python 启动脚本被 macOS 后台访问权限拒绝。安装运行文件移到系统盘标准目录后成功启动；未改变系统隐私权限。
2. launchd 默认资源限制使 worker 导入超过 11 秒，触发 10 秒启动期限。诊断服务改为 `ProcessType=Interactive` 后 ready 约 1.25 秒；已对正式 LaunchAgent 应用并更新 drift baseline，未扩大超时或安全门槛。前两次失败均没有 action 或模型费用，证据保留。
3. 正式试点 `0b20f90b-1174-44ca-b237-15a0972ab3f5` 已完成 workspace、DeepSeek 实现、冻结 candidate、评审工作区准备。已核算 **1,832 tokens**。验证工作区准备阶段未完成，进入 `reconciliation_required`；受支持的 `graph.reconcile` 接受取消意图后仍为 **`cancel_pending`**。
4. `e0.prepare_review` 约 70 秒后 confirmed；`e0.prepare_tests` 为 failed / not-started，恢复检查仍要求该 effect 的证据。没有改写 SQL、强行解锁、清除运行记录或换 key 再发模型任务。
5. **Graph 新准入当前关闭，内部 beta 不标为验收成功。** 原始副本未被应用候选变更，冻结 artifact、回执、核对记录均保留。普通服务保持可用，升级/回滚应继续尊重未完成核对的保护。

## 后续修复边界

需要定位生产验证工作区准备期间的 worker/检查点/准入链路中断，并用已有证据完成受支持的核对流程，再复验内部启用。不能把“耗时约 70 秒”直接当作根因，也不能以 worker 进程退出或缺少 admission 行推断没有遗留资源。

已做反证：真实 child 的首个动作等待 35 秒仍能完成，现有 worker client 对 action 不使用 30 秒 RPC timer；所以没有把未证实的“扩大 action timeout”方案写入生产。诊断临时测试变更已撤回，修复分支 `codex/graph-runtime-release-followup` 目前没有代码修复提交。

另一个未关闭项是 macOS 公共 [Release 35560813059](https://github.com/osborn-studio/osstack/actions/runs/35560813059)：contained-command 测试夹具传入非 canonical 的临时路径，触发 `CONTAINED_ROOT_CHANGED`；使用 canonical TMPDIR 的 31 项通过。公共 npm 发布与该 CI 修复未完成，不把内部源码安装冒充 npm 发布。安装器尚未持久化本次 ProcessType 修正，后续 `serve --install` 前应补上对应源代码与验证。

## 证据与操作

私有操作证据位于 `/Volumes/AIMATE_WORK/tmp/g225-deploy`：`disabled-verification.json`、`qos-restart-verification.json`、`canary-result.json`、`reconcile-result.json`、`final-serving-state.json`、`reconciliation-inventory.json`、两个启动失败记录和 launchd 对比诊断。数据库副本仅用于只读诊断，不作为生产恢复证明或上传材料。

当前关闭新准入的配置为 `/Users/osborn/.osstack/graph-host.json` 中 `admissionEnabled:false`。保持原 registration 身份字段；不要在未核对完成时重新安装或恢复旧数据库。完整回滚边界见 [Graph 运行手册](../runbooks/graph-runtime.md)。
