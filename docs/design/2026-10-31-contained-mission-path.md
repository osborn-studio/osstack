# 受限单执行器 Mission 路径（W11 设计）

日期：2026-10-31。状态：v2，已按 Codex（gpt-6.1-sol，medium，只读）审计修订（见 §13）。
上位文档：[v3 设计](2026-10-30-osstack-dual-loop-factory.md)（§2 交付证据、§5 第 4 步）、[运行模型](2026-10-30-firstmate-upstream-delta/operating-model.md)（§1 T0/T1/T2、§2 执行器边界）、[v3 执行计划](../plans/2026-10-31-osstack-v3-execution-plan.md)（W11）。本文只设计，不改代码；实现按 §11 拆成多个 PR。

## 1. 目标与范围

**用户得到什么：** 给一个仓库和一个工程目标，OSStack 在本机隔离的 worktree 里派发一个执行器，执行器只**提议**改动，由主机侧代理在写前分类后写入；改动在无网络容器中按固定命令验证，通过后向 GitHub 开一个 PR 并附带机器可读的交付证据。越界、验证失败或状态不明时停下来，把决定交给用户（Attention）。这是 v3 路线图 S2“单仓库本地交付”的核心。

**本期范围：** 一个仓库、一个执行器、一个 worktree、一个 PR。交付止于“PR 已开”，**不合并、不本地落地、不发布**。首版只有**代理模式**（§5.2）。

**不做：** 执行器直接写 worktree 的沙箱模式（推迟到容器化执行器，§5.6）；多执行器与路由（S3）；外循环反馈的消费（只按 v3 §2 产出证据）；远端执行；Claude Code 等无法在只读约束下运行的执行器（§5.4）；改变现有“采纳会话”Mission 的行为。

## 2. 现状（main `08a6690e`，迁移 49）

逐项核对代码的结论：**今天的 Mission 只能“采纳一个已有的可恢复会话并替它发送一轮回复”，没有 worktree、沙箱、验证和交付。** 需要的零件大多已存在，但分散在 Loop、Graph 与 guarded delivery 中。

| 零件 | 位置 | 现状 | 对本设计的意义 |
|---|---|---|---|
| Mission 账本 | `packages/core/src/state/engineering-ddl.ts`（迁移 47） | `engineering_missions` 的 `session_id`、`source_instance_id` 为 NOT NULL，`completion_level` CHECK 只允许 `'observed_turn'`；无 worktree/分支/执行器列；`failed` 没有写入方；`EngineeringStore` 用位置式 INSERT，活跃扫描与 `refresh` 默认每行都对应一个会话 | 装不下新类型；改表要重建（§4.1） |
| 事件流 | 同上，`engineering_events` | `kind` 为开放 TEXT；`payload_json` 限 32768 **字符**；`mission_id` 外键指向 `engineering_missions` | 事件形状可复用；外键决定了事件表跟着 Mission 表走 |
| 迁移执行 | `packages/core/src/state/db.ts` | 连接打开即 `foreign_keys = ON`；每个迁移在 `BEGIN` 内执行（事务内无法关闭外键）；表谱系从所有迁移 SQL 的 `CREATE TABLE` 推导，注释写明 schema 只增不删 | 重建表会同时撞上外键与谱系两处合同 |
| 升级门禁 | `packages/cli/src/engineering-upgrade-guard.ts` | 只统计 `attention_dispatch_phases` 中未证明完成或未派发的会话派发 | 新路径必须加入自己的 hold |
| 派发许可 | `packages/core/src/state/engineering-store.ts` | 进程内 `WeakSet` 中的冻结对象，单次消费、随 owner generation 失效、提交前重做 preflight；持久侧绑定 `session_messages` | 思路复用，表结构不复用 |
| 守护进程宿主 | `packages/cli/src/engineering-host.ts`、`daemon.ts` | `OSSTACK_ENGINEERING=1` 且有授权文件时启用；每秒 `tick()` 做 `recover()` 与 `refresh`；派发前先取得会话准入 | 新路径挂在同一宿主与 tick 上 |
| 执行器适配器 | `packages/agents/src/base.ts`、`session.ts`、`adapters/*` | `invoke`/`startSession`/`resumeSession` + `AbortSignal`；合同要求停止证明覆盖全部后代进程，但只有 `bounded-messages`、`contained-command` 实现 `confirmStopped`；`codex-cli` 取消时只对直接子进程发 SIGTERM，助手消息截断到 4000 字符；只有 `codex-cli` 有沙箱参数，`CODEX_HOME` 可指定登录目录 | 首期只有 `codex-cli` 候选，但需要新的补丁通道与进程组停止（§5） |
| worktree | `packages/agents/src/worktree.ts` | `createWorktree` 记录 `startCommit`、禁用 hooks；`commitWorktreeChanges` 用 `git add -A`（会执行仓库配置的 clean 过滤器），并以 HEAD≠`startCommit` 判断执行器自行提交；`cleanupWorktree` 有 D6 保全；`mergeWorktree` 是显式 opt-in 的快进落地（D7） | 复用创建与保全；提交改用加固的底层命令（§6.4）；**不调用** `mergeWorktree` |
| 受限执行 | `packages/cli/src/graph-contained-tests.ts`、`graph-contained-recovery.ts`、`packages/agents/src/contained-command.ts` | 从 git 对象导出候选文件、建 Docker 镜像；容器 uid 65534、无网络、只读根、`CapDrop ALL`、无挂载、64 pids、128 MiB；命令是单个字符串，经 `/bin/sh -c` 运行，超时硬上限 120 秒；`graph-contained-tests.ts` 在运行时引用 Graph 函数，恢复依赖 Graph 准入与 fence；`ContainedCommandExecutor` 本身不依赖 Graph | 验证复用受限执行本身，但需先抽出中性接口（§7.1） |
| 交付 | `packages/github/src/delivery.ts` | `openPullRequestToGitHub` 推送并开 PR 后返回，注释要求调用方“已持有发布权限与写入租约”；`deliverToGitHub` 会等 CI 并**合并**；子进程环境为白名单，但仍使用主机的 git/gh 凭证 | 只用前者，且由本设计提供它要求的权限与租约（§8） |
| 路径与规模规则 | `packages/autonomy/src/risk.ts`、`packages/loop/src/review-boundary.ts` | 前者有写前（`classifyPreflightRisk`）与写后（`classifyPostDiffRisk`）两种路径风险分级；后者有禁写路径、单文件 1 MB / 总 5 MB 上限与扩展名白名单；无行数上限 | 分类器合并其规则（§6.1） |
| 策略门禁 | `packages/cli/src/policy-gate.ts` | 只读 `.osstack/policy.yaml`：observe 模式或配置非法即拒；不看路径 | Mission 启动与每次写入前照常调用；读取主仓库的规范副本而非 worktree 中的副本 |

## 3. 端到端流程

```
osstack mission start …         用户显式授权：Mission 规格（T1）+ 有界发布（T2，单独列出）
  → 认领工作区（仓库+分支、worktree 两个唯一认领）、createWorktree     workspace_ready
  → 资格自检（主机侧探针，§5.5）
  → 执行器 start：只读沙箱、隔离的 HOME/CODEX_HOME、独立进程组      executing
  → 执行器进程组退出（停止证据）；读取补丁文件（无损通道）
  → 写前分类 → 主机侧代理应用 → 加固的底层提交                     candidate_ready（固定 head）
  → 受限验证（Docker，固定命令）                                   verifying → verified | verify_failed
       失败且修复轮次未用完：send 失败摘要，回到 executing
  → 签发一次性发布许可 → openPullRequestToGitHub                   delivering → pr_opened（终态）
  越界 / 状态不明 → awaiting_decision 或 needs_reconciliation（§4.4 的决定表）
```

不变量：

1. **执行器从不写文件、从不提交、从不接触交付凭证。** 文件写入、提交、推送、开 PR 都由主机侧完成。
2. **写入时没有执行器进程在运行。** 补丁只在执行器进程组被证明退出后应用；工作区租约覆盖“分类→应用→提交”全过程。
3. **验证与交付绑定同一个候选。** 候选 = (head、tree、diff 摘要)；之后任何变化使验证与证据作废，只能重新验证。
4. **规格一次授权，越界即停；发布是单独列出的有界 T2 授权。**
5. **有 intent 无 receipt 不是“没发生”；停止未证实不是“已停止”。**

## 4. 账本

### 4.1 迁移 50：只增表（决定）

**选择：新建三张表，不改 `engineering_missions`。**

| 表 | 作用 | 关键约束 |
|---|---|---|
| `engineering_contained_missions` | contained Mission 本体：`mission_id`、`scope_id`、`owner_principal_id`、`spec_digest`、`spec_json`、`state`、`revision`、`expected_head`（下一轮执行前应有的 HEAD）、`candidate_head`、`candidate_tree`、`candidate_diff_digest`、`verify_attempts`、`repair_cycles`、`supersedes`、时间戳 | `state` CHECK（§4.3）；`spec_digest`、`spec_json` 写入后不可变（触发器）；`revision` 单调 |
| `engineering_contained_events` | 与 `engineering_events` 同列同上限，`mission_id` 外键指向上表 | `payload_json` ≤ 32768 字符；超出部分见 §8.3 |
| `engineering_workspace_claims` | 工作区认领：`claim_id`、`mission_id`、`repo_identity`（主仓库 realpath + 设备号/inode）、`branch`、`worktree_identity`、`state`（`active`/`released`）、`released_at`、`release_reason` | 部分唯一索引 `(repo_identity, branch) WHERE state='active'`、`(worktree_identity) WHERE state='active'`（谓词只用本表列，SQLite 可实现）；`active`→`released` 单向 |

**为什么不重建 `engineering_missions`（v1 的方案，已撤回）：** 迁移在 `BEGIN` 内运行且外键始终开启，事务内无法按 SQLite 的标准做法关闭外键再重建；表谱系从 `CREATE TABLE` 推导，重建用的临时表会永久留在期望表里；多张子表（waits、events、requests、interactions、dispatch phases、completions）引用该表；现有 store 的位置式 INSERT、活跃扫描与 `refresh` 都假定每行有会话，contained 行会被误路由。只增表同时避开这四个问题，现有 adopted Mission 完全不变。

**与运行模型的差异（显式修订）：** 运行模型 §1 写“收据写入该 Mission 的 `engineering_events`，不新增存储”。本设计保留其实质（收据属于该 Mission、同一事件形状、同一上限、同一账本库），但 contained Mission 的事件写入同形的 `engineering_contained_events`。Attention、读模型与 `osstack stats` 对两类事件按 `mission_kind` 合并展示。

**认领的释放：** Mission 到达终态且 worktree 已移除或已交给分支治理时释放；`stop_unknown` 与 `needs_reconciliation` 期间不释放；释放与 Mission 状态转换在同一事务内。

**迁移门禁：** 升级与读模型两个限定区间各加一行，各自审查（D1 规则）；`engineeringUpgradeHolds` 增加 contained 的 hold：任何非终态 Mission、任何无 receipt 的 intent、任何未释放的认领都计为 hold；`stop_unknown` 永远计为 hold。测试覆盖：新建 50、49→50 升级（带已有 adopted Mission 与派发行）、重开 50、hold 计数。

### 4.2 Mission 规格（授权对象）

规格在 `mission start` 时确定，规范 JSON 后取摘要，之后不可变：

| 字段 | 说明 |
|---|---|
| `repo` | 主仓库身份（realpath + 设备号/inode）、远端名、`repository`（owner/name） |
| `base` | base 分支名与解析出的 `start_commit`（完整 SHA） |
| `goal` | 交给执行器的目标文本（只作提示，不作权限） |
| `executor` | 适配器 ID、二进制路径与摘要、实测版本、`containment_mode: "proxy"` |
| `allowed_paths` | 允许写入的路径 glob（缺省为整个仓库减去保护集合） |
| `caps` | T0 累计上限（§6.3），可收紧不可放宽 |
| `verify` | 验证命令（argv 数组）、基础镜像 ID、超时（≤ 120 秒） |
| `publication` | 有界发布授权：远端、`repository`、base、分支名、`draft`（缺省 true）、PR 数量 = 1 |
| `max_repair_cycles` | 缺省 2（§7.4） |
| `supersedes` | 被替代的 Mission ID（可空，§7.4） |

授权分两部分展示并分别记录：**Mission 规格**（T1：同一规格内的写入不再询问）与**有界发布**（T2：远端写入，运行模型 §1 要求显式授权）。用户可以只批准前者，此时到达 `verified` 后进入 `awaiting_decision`，再单独批准发布。两者都经过 principal 与 scope 权限检查和策略门禁，在 Attention 中留下记录。

### 4.3 状态机

```
authorized → workspace_ready → executing → candidate_ready → verifying
verifying → verified → delivering → pr_opened                 （成功终态）
verifying → verify_failed → executing                          （repair_cycles < max）
verify_failed → awaiting_decision                              （轮次用完）
verified → awaiting_decision                                   （未预先批准发布）
任意非终态 → awaiting_decision                                 （T2 越界、资格自检失败）
任意非终态 → needs_reconciliation                              （intent 无 receipt）
任意非终态 → stop_unknown                                      （执行器或容器停止未证实）
任意非终态 → cancel_requested → cancelled                      （需停止证据）
```

终态：`pr_opened`、`cancelled`、`abandoned`、`failed`（主机侧不可恢复错误）。终态不删除分支，保全沿用 D6。每个转换在同一事务中比较并交换 `revision` 并写一条事件。

### 4.4 决定表（v1 问题：“继续”可绕过验证或授权）

每种停下的原因只提供固定选项，且任何选项都**不能直接回到 `verified` 或 `delivering`**：

| 原因 | 可选决定 | 结果状态 |
|---|---|---|
| T2 越界（保护集合、删除、`allowed_paths` 外、修改验证会执行的代码） | 放弃；或以**新规格**重新授权 | `abandoned`；或创建 `supersedes` 本 Mission 的新 Mission（继承修复轮次与 worktree 认领的移交） |
| 修复轮次用完 | 放弃；或批准一个额外修复轮次（计入 `repair_cycles`，有总上限） | `abandoned`；或 `executing` |
| 资格自检失败 | 放弃 | `abandoned` |
| `needs_reconciliation` | 主机重新计算 worktree 状态后：丢弃未提交改动（重置到 `expected_head`）；或把当前 worktree 作为新候选 | `executing` 或 `candidate_ready`（必须重新验证） |
| `stop_unknown` | 只能等待停止证据（§9）；之后按 `needs_reconciliation` 处理；或放弃（worktree 冻结保留） | 无证据时不可离开，只能 `abandoned` 且认领不释放 |
| 未预先批准发布 | 批准有界发布；或放弃 | `delivering`（重新签发许可，§8.1）或 `abandoned` |

### 4.5 事件种类

| kind | payload 要点 |
|---|---|
| `contained_authorized` | `spec_digest`、两部分授权的记录 |
| `workspace_claimed` / `workspace_created` / `workspace_released` | 认领身份、`worktree_path`、`branch`、`start_commit` |
| `qualification_probe` | 探针结果（§5.5） |
| `executor_started` / `executor_stopped` | 版本、进程组 ID、停止证据 |
| `t0_intent` | `operation_id`、worktree 身份、`head_before`、计划路径与分类 |
| `write_rejected` / `tier_escalated` | 路径与原因 |
| `candidate_committed` | `operation_id`、`head_commit`、`tree_id`、`diff_digest`、累计统计 |
| `verify_intent` / `verify_receipt` | 绑定（§7.2）与结果 |
| `t0_receipt` | 运行模型 §1 全部字段：`operation_id`、worktree、`head_before`、`head_after`、`diff_digest`、`files`、`verify_command`、`verify_exit` |
| `publication_permit` / `delivery_intent` / `delivery_evidence` | §8 |
| `stop_requested` / `stop_unknown` | 沿用已有含义 |

`t0_intent` 一直保持打开，直到该次写入所在候选的验证结束，再写 `t0_receipt`；`operation_id` 把 intent、候选、验证、receipt 串起来。

## 5. 执行器

### 5.1 适配器契约

| 动作 | 现有接口 | 本路径的用法 |
|---|---|---|
| `start` | `startSession`，无会话能力时 `invoke` | 首轮：目标 + 边界说明 + 补丁输出格式 |
| `send` | `resumeSession` | 修复轮：验证失败摘要（退出码与截断输出，不含可执行指令） |
| `observe` | 事件流 | 只用于状态投影；**补丁不经事件流**（§5.3） |
| `stop` | `AbortSignal` + 停止证据 | 杀进程组并证明进程组为空（§9） |

能力声明增加 Mission 专用的只读描述：`containment: ["proxy"]`、`patch_channel`、`stop_proof: "process_group"`、`version`。声明本身不授予任何档位，是否可用由 §5.5 的主机侧探针决定。

### 5.2 代理模式

执行器以只读沙箱运行（`codex-cli` 的 `-s read-only -C <worktree>`），不加任何可写目录。它只输出一个统一 diff。主机侧在执行器进程组退出后：读取补丁 → 解析与拒绝（§6.3）→ 在工作区租约下应用（§6.4）→ 提交。

### 5.3 补丁通道（v1 问题：会话消息截断到 4000 字符）

补丁不走助手消息。由执行器 CLI 进程本身（在沙箱之外，由主机启动）把最终输出写入主机指定的文件：`codex exec` 的“最终消息写入文件”选项（需按固定版本核实名称与行为）。主机侧检查：文件大小 ≤ 256 KiB、完整（以约定的结束标记收尾）、UTF-8 合法；任一不满足即拒绝，不尝试解析残缺补丁。若固定版本没有这样的通道，`codex-cli` 不合格。

### 5.4 首期候选

| 适配器 | 只读运行 | 补丁通道 | 结论 |
|---|---|---|---|
| `codex-cli` | `-s read-only` | 待核实（§5.3） | **唯一候选**，资格由探针决定 |
| `claude-code` | 无 OSStack 可强制的只读边界（只有默认权限或 `bypassPermissions`） | — | 不合格 |
| `claude-cli`、`opencode-cli`、`deepseek-command` | 无沙箱参数 | — | 不合格 |
| `zcode-cli` | 硬编码 `--mode yolo` | — | 不合格 |
| `contained-command` | 命令来自构造参数 | — | 用于验证，不作为执行器 |

### 5.5 资格探针（v1 问题：让执行器自己去试写不可信）

探针由主机运行，不经模型：用规格中固定的执行器二进制，以与 Mission 完全相同的沙箱参数启动其沙箱包装入口（Codex 提供的“在沙箱中运行命令”的调试入口，需按固定版本核实），执行一个主机自带的小程序，尝试：写 worktree 内文件、写 worktree 外的金丝雀路径、写主仓库 `.git/` 下的随机文件、发起一个本机回环之外的网络连接。只读模式下四项都必须失败，且主机观察到 worktree 与金丝雀路径均未变化。同时记录生效的配置（参数、版本、二进制摘要）。任一不符或没有可调用的沙箱入口：不合格，Mission 进入 `awaiting_decision`，不降级运行。二进制摘要或版本变化都需重新探针并重新授权。

### 5.6 环境与凭证隔离（v1 问题：保留真实 HOME）

- 执行器以独立的进程组启动；`HOME` 与 `CODEX_HOME` 指向 scratch 根 `runtime/` 下每个 Mission 一个的目录，其中只放该执行器登录所需的最小文件（复制，不链接）。
- 环境为白名单：剥离 `OSSTACK_*` 控制面变量、`GH_*`/`GITHUB_*`、`SSH_AUTH_SOCK`、`*_TOKEN`、`*_API_KEY`（执行器自身所需的按适配器逐个列出）与 `OSSTACK_AUTOAPPROVE`。
- **残余风险（如实记录）：** macOS 上 Codex 的只读沙箱限制写与网络，但不限制按绝对路径读取，执行器仍可能读到真实 `~/.ssh`、`~/.config/gh` 等文件并把内容放进补丁或发给其模型服务。缓解：补丁在应用前做密钥扫描（命中即 T2）；PR 由人审阅后才合并。根治需要容器化执行器（只挂载 worktree 副本，登录信息经窄通道注入），列为后续工作；在此之前不开放沙箱模式。

## 6. 写入分类与主机侧应用

### 6.1 分类器

在 `packages/governance` 中实现纯函数 `classifyMissionPatch(spec, baseline, patch)`，规则合并 `autonomy/src/risk.ts` 的写前与写后路径分级、`loop/src/review-boundary.ts` 的禁写路径与大小上限、运行模型 §1 的保护集合，以及密钥扫描。策略文件从主仓库的规范副本读取，不读 worktree 中可能被提议修改的副本。

### 6.2 保护集合

运行模型 §1 的初版，另加：执行器与工具配置（`.codex/`、`.claude/`、`.cursor/`、`.mcp.json`、`.vscode/`、`.idea/`）；Git 行为文件（`.gitattributes`、`.gitmodules`、任何 `.git*` 路径）。保护集合规范化后取摘要记入规格；保护集合本身的修改是 T2。

### 6.3 档位判定

| 判定 | 条件 | 结果 |
|---|---|---|
| 拒绝 | 符号链接、硬链接、改名、模式变化、二进制补丁、子模块、被忽略路径、worktree 外路径、`..` 逃逸、路径中任一组件是符号链接 | `write_rejected`，不写入；执行器在下一轮收到原因 |
| T2 | 触及保护集合；删除已跟踪文件；`allowed_paths` 外；改动 `package.json` scripts、测试运行配置或验证代码；密钥扫描命中 | 停止，`tier_escalated`，`awaiting_decision` |
| T1 | 累计超出 T0 上限但仍在规格内 | 继续，记录档位变化 |
| T0 | 其余 | 写前登记、应用、待验证后出收据 |

T0 累计上限（相对 `start_commit`，执行器无法重置基线）初值：≤ 10 个文件、≤ 400 行增删、单文件 ≤ 1 MB、总 ≤ 5 MB。

### 6.4 应用与提交（v1 问题：竞态与仓库可控的 git 行为）

- **工作区租约：** 主机在“分类→应用→提交”期间持有该 Mission 的工作区租约（绑定 owner generation 与认领）；租约期间不启动执行器、不运行验证。执行器进程组已被证明为空（不变量 2），所以不存在并发的文件写入者。
- **逐文件安全写入：** 对每个目标路径逐级 `lstat`，任一组件是符号链接或不在 worktree 内即拒绝；写到同目录临时文件，`fsync` 后 `rename`；写完重新读取并比对哈希。
- **加固的 git：** 主机侧所有 git 调用（创建、提交、推送）使用同一个加固运行器：`GIT_CONFIG_NOSYSTEM=1`、`GIT_CONFIG_GLOBAL=/dev/null`、`GIT_NO_REPLACE_OBJECTS=1`、剥离其余 `GIT_*`，并以 `-c core.hooksPath=/dev/null -c core.fsmonitor=false -c core.attributesFile=/dev/null` 运行。提交不用 `git add`：用 `hash-object -w --no-filters` 写入每个文件、`update-index --cacheinfo`、`write-tree`、`commit-tree`，最后 `update-ref <branch> <new> <expected_head>`，旧值不符即失败。这条路径不执行任何过滤器或钩子。
- **执行器提交检测：** 每轮执行前记录 `expected_head`；执行器退出后 HEAD 必须仍等于它（只读模式下本不可能变化，变化即视为资格失效，进入 `awaiting_decision`）。累计分类仍以 `start_commit` 为基线。

## 7. 受限验证

### 7.1 复用方式（v1 问题：低估了与 Graph 的耦合）

`graph-contained-tests.ts` 在运行时引用 Graph 函数，恢复依赖 Graph 准入与 fence。实现时先抽出三个中性接口，Graph 与 Mission 各自实现适配：

- **绑定：** `{ owner_kind, owner_id, spec_digest, epoch, candidate, artifact_digest, acceptance_ref }`；Graph 的 `VerificationBinding` 映射到它（`GraphScope` 身份对象映射到 `owner_id`），Mission 直接填写（§7.2）。
- **执行：** 导出候选、建镜像、运行、记录移除回执——即现有受限执行本身，不复制代码。
- **恢复：** 以持久的调用 ID 与 owner fence 重开日志；Graph 用 `GraphRunFence`，Mission 用（owner generation、Mission `revision`、`verify_attempts`）。日志放在守护进程 home 的证据根下。

### 7.2 绑定取值

| 字段 | Mission 中的取值 |
|---|---|
| `owner_kind` / `owner_id` | `contained_mission` / `mission_id` |
| `spec_digest` | 规格摘要 |
| `epoch` | `verify_attempts` |
| `candidate` | `candidate_head` 与 `candidate_tree` |
| `artifact_digest` | `candidate_diff_digest` |
| `acceptance_ref` | 验证 argv 的规范摘要 |

### 7.3 命令、依赖与时限

- 规格中的命令是 argv 数组；主机按 POSIX 规则逐项加引号拼成现有运行器接受的单个字符串，摘要按 argv 计算并同时记录拼出的字符串，保证与现有回执兼容。
- 容器无网络，依赖在基础镜像中：基础镜像按 `pnpm-lock.yaml` 摘要预先构建并固定镜像 ID；锁文件属于保护集合，候选不会改变依赖。基础镜像的构建在 Mission 之外。
- 首版保留 120 秒硬上限，不扩展。
- Docker 不可用：Mission 停在 `candidate_ready` 并进入 `awaiting_decision`，**不在宿主机上直接运行验证命令**。

### 7.4 验证次数与修复轮次（v1 问题：两个概念混用）

- `verify_attempts`：每次运行验证加一，作为 `epoch`；不设单独上限。
- `repair_cycles`：每次因验证失败而把失败摘要 `send` 给执行器时加一，与状态转换在同一事务内原子递增；重启后从账本读取；到达 `max_repair_cycles` 后不再自动开始新一轮。
- 替代 Mission（`supersedes`）继承被替代者的 `repair_cycles`；同一 PR 的外循环往返计数（v3 §2）将来复用同一字段。

## 8. 交付与证据

### 8.1 发布许可（v1 问题：开 PR 的辅助函数假定调用方已持有权限与租约）

到达 `verified` 且有界发布已获批准时，主机签发一个进程内、单次使用的发布许可，绑定：owner generation、`spec_digest`、`candidate_head`、`candidate_tree`、最近一次成功且未取消的 `verify_receipt`、执行器进程组为空的停止证据、工作区租约。调用 `openPullRequestToGitHub` 前与其返回后各检查一次绑定仍成立；任何一项变化都撤销许可，Mission 回到 `candidate_ready`（候选变化）或进入决定（其他）。推送使用该函数自带的固定提交推送，经 §6.4 的加固 git 运行，不另写推送步骤。永不调用 `deliverToGitHub` 或 `mergeWorktree`。

### 8.2 证据内容与 base

v3 §2 的交付证据：仓库与 PR 编号、head 与 base SHA、证据 schema 版本、验证命令与结果、迁移变化、受保护路径变化（二者应为无）、`mission_id`、证据摘要。候选字段沿用 `protocol` 中 `DeliveryVerificationReceiptV2` 的 `{base_head, head, tree_id, diff_digest}` 形状。base 记录两个值：`start_commit`（候选的父提交）与开 PR 时观察到的远端 base 头；二者不同时如实记录，PR 仍以规格中的 base 开出，本期不自动 rebase。

### 8.3 存储

权威副本写入 `delivery_evidence` 事件。超出 32768 字符的内容按内容寻址写入守护进程 home 的证据根（沿用 `delivery-contract-host.ts` 的持久记录方式），事件中只放摘要与引用，读取时校验摘要。PR 描述只放展示副本与摘要。开 PR 后 Mission 到达 `pr_opened`，Attention 发一条通知（不是决定），合并仍由用户人工完成。

## 9. 停止与恢复

- **停止证据：** 执行器在独立进程组中启动；停止时向进程组发信号，证据是进程组为空（与 Loop 执行器的进程组处理同一做法）。只有拿到证据才写 `executor_stopped`。容器的停止证据沿用容器移除回执。
- **重启恢复：** `recover()` 列出所有非终态 contained Mission：
  - `executing` 且无 `executor_stopped`：检查记录的进程组；为空则补写证据后进入 `needs_reconciliation`；不能证明为空则 `stop_unknown`。
  - 有 `t0_intent` / `verify_intent` / `delivery_intent` 而无对应结果：`needs_reconciliation`；`delivery_intent` 无结果时先在远端查找同分支 PR，查到则补记证据，查不到才进入决定。
  - `verifying`：用中性恢复接口确认容器已移除；不能确认则 `stop_unknown`。
- **`stop_unknown`：** worktree 冻结（不写入、不验证、不交付），认领不释放，升级门禁计为 hold；用户不能用确认代替停止证据。
- **取消：** `cancel_requested` → 停止并取得证据 → 保全 worktree 与分支 → `cancelled`；取不到证据则 `stop_unknown`。
- owner generation 变化时，旧 generation 的进程内许可全部失效；新 owner 只能从账本恢复。

## 10. 与已有部件的关系

- 现有 adopted Mission、`EngineeringStore` 与会话派发路径不改动。contained 路径有自己的 store 类与 RPC（`mission.*`），共享 `EngineeringHost` 的宿主与 tick，以及 Attention 的决定与投递。
- Loop 的 `localLanding`、`mergeWorktree` 不被调用；Loop 引擎不参与本路径（本路径的执行器是外部 CLI，验证是受限容器）。

## 11. 实施拆分

每项一个面向 `main` 的 PR：

| 序号 | 内容 | 主要文件 |
|---|---|---|
| M0 | 实测核实：Codex 固定版本的补丁文件通道、沙箱包装入口、只读模式的网络限制、仓库内配置是否影响沙箱（结果写回本文 §5） | 文档 |
| M1 | 迁移 50 三张表、contained store（具名列）、升级 hold、两个限定区间 | `packages/core/src/state/engineering-contained-*`、`migrations.ts`、`engineering-upgrade-guard.ts` |
| M2 | 分类器、保护集合、密钥扫描（纯函数） | `packages/governance` |
| M3 | 加固 git 运行器与底层提交；逐文件安全写入 | `packages/agents/src/worktree.ts` 或新模块 |
| M4 | `codex-cli` 的代理模式：只读参数、补丁通道、隔离 HOME、进程组与停止证据、资格探针 | `packages/agents/src/adapters/codex-cli.ts` |
| M5 | 受限验证中性接口抽取，Graph 改用适配器，Mission 绑定 | `packages/cli/src/graph-contained-*`、`packages/agents/src/contained-command.ts` |
| M6 | 宿主编排与 CLI：`osstack mission start|status|cancel|decide`、RPC、tick 推进、决定表 | `packages/cli/src/engineering-host.ts`、`daemon.ts`、新命令文件 |
| M7 | 发布许可、开 PR、证据存储、Attention 通知 | `packages/cli`、`packages/github` |
| M8 | 中断与重启演练（§12 的恢复项） | 各包测试 |

M0 先做，结论可能使 `codex-cli` 不合格，届时本路径以容器化执行器为前提重排。M1–M5 互不依赖；M6 依赖 M1–M5；M7 依赖 M6。新 CLI 命令懒加载，不进 `cli-entry.ts` 的启动路径。

## 12. 验收

- **账本：** 新建 50、49→50 升级（带已有 adopted Mission 与派发行）与重开 50 均通过谱系检查；adopted Mission 行为不变；同一仓库+分支或同一 worktree 不能有两个活跃认领；非终态 contained Mission 与未释放认领计入升级 hold。
- **资格：** 主机探针在只读模式下写 worktree、写 worktree 外、写 `.git/`、外连网络均失败；版本或二进制摘要变化触发重新探针。
- **补丁：** 超过 256 KiB、缺结束标记或非 UTF-8 的补丁被拒绝；符号链接、改名、二进制、被忽略路径、worktree 外路径、经由符号链接组件的路径在写前被拒；删除已跟踪文件、保护集合内一行改动、密钥命中均升为 T2。
- **应用：** 应用期间无执行器进程；带 clean 过滤器与钩子的仓库配置在提交时不被执行；`update-ref` 旧值不符时提交失败。
- **验证：** 在无网络容器中针对固定候选运行；候选变化使验证失效；Docker 不可用时不在宿主机运行；修复轮次用完后不自动继续。
- **交付：** 只开 PR、不合并；未批准有界发布时停在决定；发布许可在候选、验证或停止证据变化时被撤销；证据摘要与账本一致。
- **决定：** 任何决定都不能把 Mission 直接送回 `verified` 或 `delivering`；越界后扩大范围只能通过新规格。
- **恢复：** 崩溃于写入、验证、交付任一 intent 之后，重启后进入 `needs_reconciliation`；进程组不能证明为空时进入 `stop_unknown` 并保持 hold；交付 intent 无结果时先查远端 PR。
- **环境：** 执行器环境中没有 GitHub 凭证、SSH agent 与 OSStack 控制面变量，`HOME` 与 `CODEX_HOME` 为每 Mission 的隔离目录。

## 13. 开放问题与评审记录

开放问题（M0 实测确认）：

1. Codex 固定版本是否提供把最终消息写入文件的选项、可调用的沙箱包装入口，只读模式是否同时限制网络，仓库内配置是否会改变沙箱级别。任一缺失都影响 §5 的资格。
2. 基础镜像的构建与刷新方式，以及 pnpm workspace 在只读根文件系统下运行测试是否需要额外的 tmpfs。
3. 读取侧的残余风险（§5.6）在容器化执行器到位前是否可接受；若不可接受，本路径以容器化执行器为前置条件。
4. `draft` 缺省值：无人值守的结果默认 draft；是否改为 ready 由用户决定。

**评审记录。** v1 由 Codex（gpt-6.1-sol，medium，只读）对照代码审计：14 个 P1、7 个 P2、1 个 P3，结论“需修改：受限、迁移、恢复与发布门禁需要具体修复”。Claude 逐条核对代码（`db.ts` 事务内迁移与外键、表谱系推导、`engineering-upgrade-guard.ts` 只看会话派发、`codex-cli.ts` 4000 字符截断与只对直接子进程发 SIGTERM、`contained-command.ts` 的 `/bin/sh -c` 与 120 秒上限、`delivery.ts` 对调用方权限的假定）后全部采纳，主要修订：

- 首版只保留代理模式，执行器只读；资格改为主机侧探针；补丁改走无损文件通道；凭证与 HOME 隔离，并如实记录读取侧残余风险。
- 主机侧提交改用加固 git 与底层命令，不执行过滤器与钩子；工作区租约与“写入时无执行器进程”的不变量取代 v1 中“没有竞态”的断言。
- 迁移 50 由“重建 `engineering_missions`”改为只增三张表，避开事务内外键、表谱系与现有 store 误路由；升级门禁加入 contained hold；工作区唯一性改为本表内的认领。
- 新增决定表，禁止任何决定直接回到 `verified`/`delivering`；停止未证实时冻结并保持 hold。
- 发布改为单独列出的有界 T2 授权与一次性发布许可；删除已跟踪文件升为 T2；T0 收据补齐 worktree 与验证字段并在验证后关闭。
- 区分验证次数与修复轮次；执行器提交检测改用每轮的 `expected_head`；验证 argv 与现有字符串运行器的兼容方式、受限执行的中性接口、base 观察与大证据存储均已明确。
- 修正事实：`risk.ts` 同时有写前与写后分级；事件 payload 上限是 32768 字符而非字节。
