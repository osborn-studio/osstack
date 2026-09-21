# OSStack Graph 部署记录 — 2026-09-21

**30/30，G00–G29 已完成内部 beta 验收。PR #228 已独立审批、合并并部署为 `e28927d`；正式单仓库 canary `98bdc953-01a3-48e0-8320-c91e243eb420` 达到 ready，7 个动作 confirmed、独立 review accept、实际测试通过、join complete，2965 tokens、零预留、零遗留准入。**

## PR #228 正式部署与生产验收

- 独立审批：`gilberthello` 于 2026-09-21T10:39:30Z 审批最终 head `38be28f7a1990d5995ecfc6518adebb73632de47`，10:39:37Z 合并为 `e28927daa1010313c28085a8237dbb0ef8f7d781`；merge tree 与审批版本一致。19 个安装包的 1096 个文件逐字节匹配，原第三方依赖保留。
- [最终 PR CI](https://github.com/osborn-studio/osstack/actions/runs/35586967593) 全仓 4027 项通过、3 项 opt-in 跳过；[main CI](https://github.com/osborn-studio/osstack/actions/runs/35589920681) 通过。实际 runtime 与已通过隔离 DeepSeek pilot 的 603ba36 相同。
- 新 release prefix `/Users/osborn/.local/share/osstack/releases/e28927d` 使用正常安装角色声明。只读核对旧 tests 停止证据、精确原 owner、revision 和无其他任务后，正常停止旧 LaunchAgent；完整备份 `/Volumes/AIMATE_WORK/Backups/osstack/20260921-e28927d` 的 69 表、schema37、完整性/外键及 DB 哈希均通过。
- 正式安装的维护入口将旧 `bef01154-cecd-4cc6-ac44-c2fdffdc531a` 投影为 cancelled，actionsUnchanged=true、upgradeHolds=0。原 tests=false、3100 tokens 和所有原动作保留；未重发模型、手工改 SQL 或删除不明锁。另有 G15 一致性备份 `graph-maintenance-ffVu6z/state.db`。
- 然后更新新 canary 的允许目录正例，保留原注册副本。关闭准入部署通过：旧 session/Loop/stats RPC、五个历史 run、所有原动作、schema37 与 autonomy readiness 均验证；新准入返回 GRAPH_ADMISSION_DISABLED，零新增 run。
- 仅对授权的 OSStack 独立副本启用，正式 run `98bdc953-01a3-48e0-8320-c91e243eb420` 达到 ready：7 confirmed、review accept、实际 tests pass、join complete，2965 tokens、零剩余预留、零保留准入、无未终结生产图。候选 `7ee7e5ecaa1c5d2cdae4ab8501eee297f66f30b5`，artifact `df19d6821800eda8705b37d4777bc6c60831db70642c90486682a7ff05fdaf41`。重复同 key 返回原 run，原仓库字节及 Git 状态不变。
- 正式 shim 与 Interactive/caffeinate LaunchAgent 已指向 e28927d；凭据继续从 owner-only 文件加载。当前仅一个受限注册，仍为 artifact_only，600 秒/196608 tokens；没有自动合并候选或扩展其他仓库。
- 公共 npm 未发布。[公共 Release](https://github.com/osborn-studio/osstack/actions/runs/35589920758) 的 macOS14/Node24 完整套件存在一项并发测试断言失败，本机定向复跑超时；这与已通过的 PR/main CI、正式 canary 分开记录，详情见[技术债](graph-upgrade-completion.md#尚存技术债)。

私有原始证据：`/Volumes/AIMATE_WORK/tmp/g228-deploy`。可提交的脱敏摘要为 [production-canary.json](../implementation/graph-upgrade-final-evidence/production-canary.json)。以下均为历史时点，当前状态以上述记录为准。

## PR #227 部署及新的收尾问题

- 最终 head `de20b51f0fb00aeee45f743693364a65dde75445` 经 `gilberthello` 独立审批，合并为 `45bac9abdb0841c4372d29a85904faae7642f285`，源码 tree 与已验收安装包相同。
- [PR CI 35577744887](https://github.com/osborn-studio/osstack/actions/runs/35577744887) 和 [main CI 35580081839](https://github.com/osborn-studio/osstack/actions/runs/35580081839) 全部通过。PR 全仓 22 包、4006 项通过、3 项显式跳过；Node 20.6/22.23.1、macOS fixtures 和安装检查通过。version 38ms、help 216ms。
- 停机完整备份到 `/Volumes/AIMATE_WORK/Backups/osstack/20260921-45bac9a`，69 表、schema 37、完整性/外键检查通过。正式 daemon 与全局 shim 指向 `/Users/osborn/.local/share/osstack/releases/45bac9a`。关闭准入验收通过，旧 RPC、4 个历史 run 和所有历史动作保留。
- 正式 canary `bef01154-cecd-4cc6-ac44-c2fdffdc531a` 七个动作全部 confirmed；review accept，实际测试 exit 1，stderr `Refusing default serving home`。私有验收代码把 `~/.osstack` 内的 cwd 当作允许目录，违反被测函数本来的保护。候选一行修改正确，但本次 tests=false 不能记为通过。
- 另有真实续租窗口：tests 锁在 09:00:09Z 取得、09:01:09Z 到期，约 41 秒的权限检查结束后才启动 20 秒续租，第一轮已晚于期限。tests 结果已确认，但释放被拒；没有 join，图进入 reconciliation_required。正常公开 reconcile 已记录取消意图，当前 cancel_pending/revision37。
- 本次费用 3100 tokens（writer 1832、review 1268），零剩余预留；tests 的一项 admission/锁保留。准入自动关闭，原仓库未应用候选。普通 daemon 健康，两个写并发槽有一个保留。没有手动改账或删锁。
- 续租修复从锁取得时启动，并在交付准入前检查续租、活性和取消。新的受控维护仅处理精确七动作已停止模式，先只读证明，再正常停止旧 daemon，离线按原 token 经 G15 取消收尾。修复尚未审批或部署，不能直接运行开发 checkout 访问正式 DB。
- 公共 [Release 35580081891](https://github.com/osborn-studio/osstack/actions/runs/35580081891) 的 macOS 测试已通过，创建版本 PR 时因 GitHub Actions 仓库权限不足而失败，未发布新 npm 包。

本轮私有证据在 `/Volumes/AIMATE_WORK/tmp/g227-deploy`。以下保留旧部署时点的历史记录，不代表当前服务状态。

## PR #226 历史部署


- PR #226 最终 head `ecb290a5ffe12d3095f01ead7098696add380402` 获 `gilberthello` 审批，合并 SHA `e6f0658efeef3074e8524ee24b1157ae9e17e3c7`；两个提交的源码 tree 均为 `60bdf4eb742ea653640691583956ecab244f6070`。已验收的 19 个 tarball 安装到 `/Users/osborn/.local/share/osstack/releases/e6f0658`，实际 daemon 进程路径与全局 shim 均核实。
- 新安装声明 `stable-serving`、允许实际 home、schema 37。维护入口先只读检查，再建立 SQLite 一致性备份并通过既有权限恢复旧运行 `0b20f90b-1174-44ca-b237-15a0972ab3f5`。结果为 `cancelled`，所有动作记录不变、原费用 1832 tokens 保留、`upgradeHolds=0`。没有 SQL 强制改账、删除锁或重复模型调用。
- 正常 drain 得到 `drained:true`、`graph_holds:0`，停止 LaunchAgent 后将完整 home 和旧 plist 备份到 `/Volumes/AIMATE_WORK/Backups/osstack/20260921-e6f0658`。69 张表计数记录、schema 37、完整性和外键检查通过。
- 关闭新准入部署验证通过：旧 session/Loop/stats RPC 可用，`graph.start` 返回 `GRAPH_ADMISSION_DISABLED` 且零新增 run，历史动作记录与停机备份相同，`autonomy.health.can_run_local=true`。保留 Interactive/caffeinate/owner-only 凭据加载与 plist drift baseline。
- 仅对授权独立副本开启一次试点：`44f72545-a950-4c27-a69f-ce91ee7eb7c8`。workspace、实现、冻结、两个验证工作区和独立 review 均 confirmed；review verdict `accept`。tests 在实际调用之前被拒绝，检查点为 `POLICY_DENIED`，图终态 `failed`。测试没有运行，因此不能宣称候选通过验收。
- 该次已记账 **2963 tokens**（writer 1832、review 1131），无剩余预留。候选 `434e298e349299191de8d86dfd947a8743e6685c`、artifact `1d99a4b801987f9fcffc596583fb4c824a6c3f6e5cbe0f66734b60211712d20f` 均保留。新准入已自动关闭；原独立副本保持未应用候选。
- 空闲时复查四个源码/候选目录的权限均通过。已单独复现 Node `execFile` 内建超时在主线程停顿后丢弃成功 Git 子进程输出：退出码为 0、stdout 却为空。修复和回归正在 follow-up 分支中验证，尚未部署该修复。不能把这一机制的复现替代新生产 canary。

私有证据：`/Volumes/AIMATE_WORK/tmp/g226-deploy` 中的 `maintenance-inspect.json`、`maintenance-apply.json`、`disabled-verification.json`、`process-verification.json`、`canary-result.json`、`policy-diagnostic.log`、`child-poll-proof.log`。维护前一致性备份另存于 `/Volumes/AIMATE_WORK/Backups/osstack/graph-maintenance-jMnWfa/state.db`。这些包含主机运行信息的原始证据不上传公共 Git。

## 2026-09-20 历史部署证据

以下为 PR #225 时点的历史记录，当前状态以上述更新为准。

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
