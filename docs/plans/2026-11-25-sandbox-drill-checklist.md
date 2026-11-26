# 沙箱真实演练：负责人准备清单

日期：2026-11-25。基线：`main` `091b9cd5`。状态：**清单，没有执行任何一步**。

目标：按 [自循环升级方案](2026-11-16-osstack-self-loop-upgrade.md) U4 的验收，在沙箱仓库 `osborn-studio/osstack-bridge-sandbox` 里跑通一次真实链路：

> 一次真实的 `verify-*` 失败 → 可信结果被主机读到 → 登记一条 Mission → 一次受控修复 → 新 head 复验通过 → 审批、合并、关单。另跑四个负向用例：来源不可信、旧 head、重复结果、无法复现，各自停住并有原因。

本清单只汇总顺序和每一步由谁做。细节以这些文档为准：
[验证程序运行手册](../runbooks/bridge-verification-harness.md)、
[发布程序运行手册](../runbooks/bridge-verification-publisher.md)、
[桥接运行手册](../runbooks/bridge.md) §6.2–§6.4、
[B9 运行时设计](../design/2026-11-24-verification-publisher-runtime.md)、
[同 PR 受控修订](../design/2026-11-06-bridge-same-pr-revision.md) §5.6–§5.7、
[阶段 5 验收记录](../reports/bridge-phase5-verification/current-v2-status.md)。

## 0. 一个必须先知道的门

主机侧的本地失败修复路线（[桥接运行手册](../runbooks/bridge.md) §6.2）只在 `OSSTACK_BRIDGE=1`（live 桥接）下工作。**这个值目前在代码里启动即拒绝**：`parseBridgeMode` 调用 `assertLiveBridgeAcceptance()`，固定抛出 `BRIDGE_LIVE_NOT_IMPLEMENTED:acceptance_required:5-F:5-G`（`packages/cli/src/contained-mission-rpc.ts:111-124`）。注释写明：只有带着 5-F 和 5-G 验收证据、经过评审的代码改动才能打开它。

- **5-G（沙箱端到端）**：2026-11-08 第 4 次运行通过，13/13 场景，`qualified:true`（[记录](../reports/bridge-phase5-verification/current-v2-status.md)）。但那之后主机代码改了很多（U3、U4b、U5、T6 等），这份证据是否还算数，要由你决定。
- **5-F（故障注入、变异、属性测试、live TLA 模型）**：门槛在 [同 PR 受控修订](../design/2026-11-06-bridge-same-pr-revision.md) §5.6 末尾。2026-11-25 核对结论：**在当前 main 上不完整，不能用来开门。**
  - TLC 四个配置无反例、14 个模型变异体都有反例、1 万次属性测试通过、19 个源码变异体全部被杀，证据都在 [报告目录](../reports/bridge-phase5-verification/)，但都是 2026-11-07 的。`pending-tlc.json` 为空，没有挂起的 TLC。
  - 之后合并的改动（U4b 的本地失败路线、版本 2 授权、#530、U5 R2/R2b、U3 T6）改了 9 个变异目标文件中的 6 个，属性测试绑定哈希的两个文件也变了，所以变异和属性证据已和 main 不符。
  - [`gaps.md`](../reports/bridge-phase5-verification/gaps.md) 仍有未关的故障注入项：评审冲突交错的变异（F2）、外部推送三个边界的逐一映射（F3）、`host.recover()` 与 `revisionRecovery()` 之间崩溃的独立断言（F8），以及 F1、F4、F6、F9 只写着“测试存在、需重跑”。
  - TLA 模型没有覆盖本地失败路线和版本 2 授权续期；规格 README 还记着一个未关的缺口（finding 10）。
  - 补齐的工作全部是本机运行，不需要 Docker、GitHub 或真实密钥：在当前 main 上重跑 19 个变异体和两组 1 万次属性测试并重新绑定哈希；补上 F2、F3、F8 的测试与变异，记录 F1、F4、F6、F9 的定向重跑；决定 TLA 模型是否要扩展到新路径（要的话还需本机 Java 和 `tla2tools.jar` v1.7.4）；最后一次完整门禁，再写开门的代码改动。

所以真实演练之前，必须先有一个“打开 live 桥接门”的节点，而它需要你的批准。见 §4 决定 1。

## 1. 代码侧还要完成的（由会话做，不需要你动手）

| 项 | 状态 | 说明 |
|---|---|---|
| B9-4 验证程序核心 | 本地已提交，门禁在跑 | 合并后开 B9-5 |
| B9-5 端口与入口 | 本地已提交 | 合并后开 B9-6 |
| B9-6 验证程序运行手册与演练计划 | 本地已提交 | 本清单 §2、§3 的细节来源 |
| W13-E1 执行器看门进程 | 门禁在跑 | 防止 daemon 崩溃后执行器继续跑。演练前最好合并 |
| 核对 5-F 证据 | 未做 | 见 §0 |
| 打开 live 桥接门的代码改动 | 未做，需要你批准 | 见 §4 决定 1 |

## 2. 云端准备（你来做）

来源：验证程序运行手册 §2–§4，发布程序运行手册 §2–§5。

- [ ] 一台云机器，除了 Grok Bot 的系统用户外，再建两个系统用户：**发布程序用户**和**验证程序用户**。两者互相读不到对方的家目录，Bot 用户两个都读不到。
- [ ] 验证程序用户装 **rootless Docker**。这台机器上不装、不用 root 权限的 Docker（你 2026-11-25 确认）。记下 rootless daemon 的 id。
- [ ] 建一个组，只有发布程序用户在里面；投递目录归验证程序用户，组为这个组，权限 `2750`（你 2026-11-25 确认请求文件为 `0640`）。
- [ ] 两个程序各自从同一个固定提交的仓库检出，执行 `pnpm install --frozen-lockfile` 和 `pnpm build`；检出目录不能被验证程序用户写。
- [ ] 安装验证 profile 文件，并把它的基础镜像拉进验证程序用户的 Docker。
- [ ] 写验证程序配置文件和发布程序的放行清单（allowlist）。两边的 `profile_id`、`profile_digest`、`trusted_source` 必须一致。
- [ ] **验证 App**：只安装在选定仓库上，沙箱仓库被选中；权限只有 Checks 读写和 Metadata 只读；不订阅事件，webhook 关闭。读回安装 id。
- [ ] **为验证 App 生成第二把私钥，亲手放到发布程序用户下**，权限 `0600`。这把钥匙不经过仓库、聊天、模型或主机。
- [ ] 在 Grok 侧读回 Watcher routine：监听和巡检已开、时区、Mission 的 PR 没有被作者规则排除。
- [ ] 这一节结束后，按验证程序运行手册 §3.1 的检查做一次：发布程序用户能读、不能写投递目录；Bot 用户列不出投递目录。

## 3. 主机（Mac mini）准备（你来做，或明确授权会话做）

来源：桥接运行手册 §6.2–§6.4，发布程序运行手册 §2，[AGENTS.md](../../AGENTS.md) 的控制面纪律。

- [ ] 用**独立的** `OSSTACK_HOME` 跑演练用的 daemon，不碰 `~/.osstack` 和正在服务的 home。
- [ ] 在这个 home 下填好主机私有的生产者策略文件 `bridge/verification-producers.json`（`0600`），里面的验证 App id 只写在这里。
- [ ] 桥接配置 `apps.json`、`rulesets.json` 指向沙箱仓库；App A（Mission 写入）私钥在 `~/.config/osstack-bridge/apps/`。
- [ ] 真实 Codex 执行器配置（`OSSTACK_CONTAINED_CODEX_*`）。
- [ ] 主机验证用的 Docker：本地失败路线的复验在主机容器里跑。**这一步也是在 Docker 里运行，需要你明确同意。**
- [ ] 开关：`OSSTACK_BRIDGE=1`（要先等 §0 的门打开）、`OSSTACK_LOCAL_FAILURE_REPAIR=1`；不配置任何自动合并路径（这条路线要求如此）。
- [ ] 一个工程凭据，带这个沙箱 scope 的读、写、operator 权限。
- [ ] 签发一次 live 修订授权（`mission grant-revisions`，本机私钥签名、终端确认）。

## 4. 需要你决定的事

1. **打开 live 桥接门。** 选项：(a) 先核对 5-F，若完整，就由会话写一个只允许沙箱 scope 使用 `OSSTACK_BRIDGE=1` 的代码改动，把 5-G 记录和 5-F 证据写进 PR，你评审后合并；(b) 认为 11-08 之后改动太多，先在当前代码上重跑一次 5-G（同样要用 Docker 和 App 私钥），再做 (a)；(c) 暂不打开，演练只做到“主机读到可信结果”为止（§5 的第 1–7 步）。我的建议：先做 (c) 的前半段，用它验证云端两程序和主机读取；同时核对 5-F，再决定 (a) 还是 (b)。
2. **允许在 Docker 里运行。** 你之前说过“先不跑”。云端验证程序（rootless）和主机复验各需要一次单独的同意。
3. **演练用哪个 PR 和哪种失败。** 需要一个沙箱 PR，它的 `verify-*` 会真实失败、且失败能在受信 CI 里复现。我可以先写一个只改沙箱仓库的提案，等你同意再建。
4. **合并由谁做。** 本地失败路线的 PR 不会被 App E 自动合并（桥接运行手册 §6.1），由人审阅后手动合并。U4 验收里的“合并”这一步是你来点。

## 5. 演练顺序（每一步都要你单独批准；只在沙箱仓库）

第 1–11 步来自验证程序运行手册 §9；第 12 步之后来自桥接运行手册 §6.2–§6.4。遇到第一个意外结果就停，不改账本、不改 check run、不换输入重跑。

| # | 步骤 | 谁 | 需要的前置 |
|---|---|---|---|
| 0 | 只读准备：两程序的提交和 `dist/bin.js` 的 SHA-256；各用户之间的读取都被拒；`docker info` 显示 rootless | 你，或授权会话在云端执行 | §2 |
| 1–2 | 验证程序跑一个打开的沙箱 PR；记录容器停止回执 | 云端 | 决定 2 |
| 3–6 | 发布程序发布结果；GitHub 接受 App 令牌；check run 由验证 App 写出、内容与账本一致 | 云端 | 第二把私钥 |
| 7 | 主机读取器接受该结果（生产者证明、策略、来源账本） | 主机，只读 | §3 前四项 |
| 8–10 | 负向：同一 head 重复（`already_verified`）；关闭的 PR、不存在的 PR；冒充的 check run 被主机拒绝 | 云端 + 主机 | — |
| 11 | Watcher 触发：从推送到发布结果的延迟 | 云端 | Watcher 已读回 |
| 12 | 主机按失败结果登记、诊断、派发一个修复子 Mission | 主机 | **决定 1 已打开门**、§3 全部 |
| 13 | 你在主机上审阅候选并执行 `mission approve-local-failure-repair --mission ID --candidate SHA`（15 分钟内有效） | 你 | — |
| 14 | 主机以 App A 身份推送一个快进提交，读回确认 | 主机 | — |
| 15 | 复验：验证程序和发布程序对新 head 再跑一次，主机复验通过 | 云端 + 主机 | 决定 2 |
| 16 | 你审阅后手动合并 PR，链关单 | 你 | 决定 4 |
| 17 | 其余负向：来源不可信、旧 head、无法复现，各自停住并记录原因 | 主机 | — |

## 6. 不在本清单里的

- 任何生产仓库。生产试点另行审批（方案 U8）。
- 放开多轮修复、扩大文件白名单（U8，需先有连续合格链的数据）。
- 定时巡检入口（U4 第 2 项）：首发只做影子观察，等本次演练通过后再议。
