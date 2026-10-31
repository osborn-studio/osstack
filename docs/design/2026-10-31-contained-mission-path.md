# 受限单执行器 Mission 路径（W11 设计）

日期：2026-10-31。状态：v1 设计，待 Codex（gpt-6.1-sol，medium）评审后修订（见 §12）。
上位文档：[v3 设计](2026-10-30-osstack-dual-loop-factory.md)（§2 交付证据、§5 第 4 步）、[运行模型](2026-10-30-firstmate-upstream-delta/operating-model.md)（§1 T0/T1/T2、§2 执行器边界）、[v3 执行计划](../plans/2026-10-31-osstack-v3-execution-plan.md)（W11）。本文只设计，不改代码；实现按 §10 拆成多个 PR。

## 1. 目标与范围

**用户得到什么：** 给一个仓库和一个工程目标，OSStack 在本机隔离的 worktree 里派发一个执行器去改代码，写入受代理或强制沙箱约束，在受限环境中跑固定的验证，通过后向 GitHub 开一个 PR 并附带机器可读的交付证据；超出边界、验证失败或状态不明时停下来，把决定交给用户（Attention）。这是 v3 路线图 S2“单仓库本地交付”的核心。

**本期范围：** 一个仓库、一个执行器、一个 worktree、一个 PR。交付止于“PR 已开”，**不合并、不本地落地、不发布**。

**不做：** 多执行器与路由（S3）；外循环反馈的消费（只按 v3 §2 产出证据）；远端执行；Claude Code 等没有强制沙箱的执行器（§5.3）；改变现有“采纳会话”Mission 的行为。

## 2. 现状（main `08a6690e`，迁移 49）

逐项核对代码的结论：**今天的 Mission 只能“采纳一个已有的可恢复会话并替它发送一轮回复”，没有 worktree、沙箱、验证和交付。** 需要的零件大多已存在，但分散在 Loop、Graph 与 guarded delivery 中，没有被 Mission 串起来。

| 零件 | 位置 | 现状 | 对本设计的意义 |
|---|---|---|---|
| Mission 账本 | `packages/core/src/state/engineering-ddl.ts`（迁移 47） | `engineering_missions` 的 `session_id`、`source_instance_id` 为 NOT NULL，`completion_level` CHECK 只允许 `'observed_turn'`，无 worktree/分支/执行器列；状态机围绕会话观察（`observing`→`awaiting_decision`→`answer_recorded`…）；`failed` 没有写入方 | 不能直接装下新类型的 Mission，需要迁移（§4） |
| 事件流 | 同上，`engineering_events` | `kind` 为开放 TEXT，`payload_json` ≤ 32 KiB，`mission_id` 外键指向 `engineering_missions` | intent/receipt、验证、交付证据都写这里；但前提是 Mission 行存在于 `engineering_missions` |
| 派发许可 | `packages/core/src/state/engineering-store.ts` | 许可是进程内 `WeakSet` 中的冻结对象 `{message_id, daemon_generation}`，单次消费；持久侧 `attention_dispatch_phases` 引用 `session_messages` | 绑定思路（单次、随 owner generation 失效、提交前重做 preflight）可复用；表结构绑定会话消息，不复用 |
| 守护进程宿主 | `packages/cli/src/engineering-host.ts`、`daemon.ts` | `OSSTACK_ENGINEERING=1` 且有授权文件时启用；每秒 `tick()` 做 `recover()` 与 `refresh`；派发走 `adapter.resumeSession`，300 秒期限 | 新路径挂在同一宿主与 tick 上，不另起进程 |
| 执行器适配器 | `packages/agents/src/base.ts`、`session.ts`、`adapters/*` | `invoke`/`startSession`/`resumeSession` + `AbortSignal`；只有 `bounded-messages`、`contained-command` 有 `confirmStopped`；只有 `codex-cli` 有沙箱参数（`read-only`/`workspace-write`/`danger-full-access`，`writableRoots` 仅限 workspace-write） | 首期只有 `codex-cli` 合格（§5.3） |
| worktree | `packages/agents/src/worktree.ts` | `createWorktree` 记录 `startCommit`、禁用 hooks；`commitWorktreeChanges` 能识别执行器自行提交；`cleanupWorktree` 在分支有未包含提交时保留（D6）；`mergeWorktree` 是显式 opt-in 的快进落地（D7） | 复用创建、提交与保全；**不调用** `mergeWorktree` |
| 受限执行 | `packages/cli/src/graph-contained-tests.ts`、`packages/agents/src/adapters/contained-command.ts` | 从 git 对象导出候选文件（校验 SHA、≤32 MiB、≤1 万文件，剥离 `GIT_*` 环境），构建 Docker 镜像；容器 uid 65534、无网络、只读根、`CapDrop ALL`、无挂载、64 pids、128 MiB、≤120 秒；`ContainedCommandExecutor` 无 Graph 依赖 | 验证直接复用这套受限执行本身（运行模型 §1） |
| 交付 | `packages/github/src/delivery.ts` | `openPullRequestToGitHub(input, {repository, headCommit, draft})` 只开 PR；`deliverToGitHub` 会等 CI 并**合并**；子进程环境为白名单 | 只用前者 |
| 路径与规模规则 | `packages/autonomy/src/risk.ts`、`packages/loop/src/review-boundary.ts` | 前者有按路径的风险分级与受保护策略路径；后者有禁写路径、单文件 1 MB / 总 5 MB 上限与扩展名白名单；均为写后检查，无行数上限 | 分类器复用其规则，但改为写前判定（§6） |
| 策略门禁 | `packages/cli/src/policy-gate.ts` | 只读 `.osstack/policy.yaml`：observe 模式或配置非法即拒；不看路径 | Mission 启动与每步写入前照常调用 |

## 3. 端到端流程

```
用户 osstack mission start …           （T1 授权：一次批准 Mission 规格）
  → 守护进程：创建 Mission + 工作区绑定      contained/authorized
  → createWorktree（基于固定 base commit）   workspace_ready
  → 容器化自检（§5.4 金丝雀）
  → 执行器 start（代理或沙箱模式）           executing
       每次写入：分类器 → 档位 → 写入/拒绝     t0_intent / t0_receipt
  → 执行器结束；OSStack 主机侧提交           candidate_ready（固定 head SHA）
  → 受限验证（Docker，固定命令）             verifying → verified | verify_failed
       失败且未超轮次：send 失败摘要，回到 executing
  → 推送分支、openPullRequestToGitHub      delivering → pr_opened（终态）
  任一越界 / 状态不明 → awaiting_decision 或 needs_reconciliation（Attention 决策）
```

关键不变量：

1. **执行器从不持有交付权与合并权。** 提交、推送、开 PR 都由主机侧完成；执行器环境中没有 GitHub 凭证。
2. **验证的对象是固定的提交。** 验证、证据与 PR 都绑定同一个 head SHA；之后工作区再变化，证据作废。
3. **规格一次授权，越界即停。** Mission 规格（§4.2）的摘要是授权对象；任何超出规格的动作都是 T2，需要单独决定。
4. **有 intent 无 receipt 不是“没发生”。** 恢复时进入 `needs_reconciliation`，交给用户。

## 4. 账本：Mission 类型与工作区绑定

### 4.1 迁移 50（决定）

**选择：重建 `engineering_missions`，增加 `mission_kind`，并新增一张工作区绑定表。** 理由：

- intent/receipt 必须写入该 Mission 的 `engineering_events`（运行模型 §1），而 `engineering_events.mission_id` 外键指向 `engineering_missions`。另建一套 Mission 表就得另建事件表，等于第二套账本，违反“不新增存储”。
- `session_id`、`source_instance_id` NOT NULL 与 `completion_level='observed_turn'` 是 CHECK/NOT NULL 约束，SQLite 只能重建表来放宽。

迁移 50 的内容：

- `engineering_missions` 重建：新增 `mission_kind TEXT NOT NULL CHECK(mission_kind IN ('adopted_session','contained'))`，已有行回填 `'adopted_session'`；`session_id`、`source_instance_id`、`source_generation` 改为可空，但用 CHECK 绑定：`adopted_session` 必须非空、`contained` 必须为空；`completion_level` 扩为 `IN ('observed_turn','contained_pr')` 并与 `mission_kind` 一一对应；`state` 的 CHECK 增加 contained 专用状态（§4.3），并用 CHECK 限定每种类型可用的状态集合。会话唯一活跃索引保持对 `adopted_session` 生效。
- 新表 `engineering_workspaces`（一 Mission 一行）：`mission_id`（PK，外键）、`repo_path`（realpath）、`base_ref`、`start_commit`、`worktree_path`、`branch`、`executor_id`、`executor_version`、`containment_mode`（`proxy`/`sandbox`）、`spec_digest`、`protected_set_digest`、`head_commit`（候选，可空）、`round`（验证往返计数）、`state_revision`。约束：活跃 Mission 中 `worktree_path` 唯一、`branch` 唯一；`start_commit`、`spec_digest` 写入后不可变（触发器）。需要唯一性与按列查询，符合运行模型 §3.3 的建表门槛。
- 重建须保留现有行、外键与触发器；按 D1 的派生规则更新升级与读模型两个限定区间（各自审查），升级门禁测试覆盖“迁移 49 的 home 带已有 adopted Mission 升到 50 后行为不变”。

**否决的方案：** (a) 只在 `engineering_events` 里记工作区信息——无法表达“一个 worktree 只属于一个活跃 Mission”；(b) 新建独立的 contained Mission 表与事件表——两套账本，Attention 与恢复要各接一次。

### 4.2 Mission 规格（授权对象）

规格在 `mission start` 时确定，规范 JSON 后取摘要存入 `spec_digest`，之后不可变：

| 字段 | 说明 |
|---|---|
| `repo` | 仓库 realpath 与远端（`remote`、`repository` owner/name） |
| `base` | base 分支名与解析出的 `start_commit`（完整 SHA） |
| `goal` | 交给执行器的目标文本（只作提示，不作权限） |
| `executor` | 适配器 ID、实测版本、`containment_mode` |
| `allowed_paths` | 允许写入的路径 glob（缺省为整个仓库减去保护集合） |
| `caps` | T0 累计上限（§6.3），可在默认值之下收紧，不能放宽 |
| `verify` | 验证命令（argv 数组，不经 shell）、基础镜像 ID、超时 |
| `delivery` | PR 标题模板、`draft`（缺省 true）、目标 base |
| `max_rounds` | 验证失败后的修复往返上限（缺省 2，与 v3 §2 一致） |

`mission start` 本身是一次 T1 授权：通过现有的 principal 与 scope 权限检查和策略门禁，并在 Attention 中留下一条已批准记录。之后同一规格内的步骤不再询问。

### 4.3 状态机（contained）

```
authorized → workspace_ready → executing → candidate_ready → verifying
verifying → verified → delivering → pr_opened            （成功终态）
verifying → verify_failed → executing                     （round < max_rounds）
verify_failed → awaiting_decision                         （超出轮次）
任意非终态 → awaiting_decision                            （T2 越界、执行器自行提交、金丝雀失败）
任意非终态 → needs_reconciliation                         （intent 无 receipt、执行器停止状态不明）
任意非终态 → cancel_requested → cancelled                 （用户取消；先停执行器再保全）
awaiting_decision / needs_reconciliation → 用户决定：继续（回到对应状态）| 放弃（abandoned）
```

终态：`pr_opened`、`cancelled`、`abandoned`、`failed`（主机侧不可恢复错误，如 worktree 创建失败）。任何终态都不删除分支：保全沿用 D6 规则，清理只在 PR 合并或关闭后由分支治理处理。

每个转换是对 `engineering_workspaces.state_revision` 与 Mission `revision` 的比较并交换，并在同一事务写一条 `engineering_events`。

### 4.4 事件种类

`engineering_events.kind` 是开放文本，新增以下种类（payload 均 ≤ 32 KiB，超出部分只存摘要）：

| kind | payload 要点 |
|---|---|
| `contained_authorized` | `spec_digest`、规格规范 JSON |
| `workspace_created` | `worktree_path`、`branch`、`start_commit` |
| `containment_probe` | 金丝雀结果（§5.4） |
| `executor_started` / `executor_ended` | 执行器 ID、版本、模式、开始时间、退出原因 |
| `t0_intent` / `t0_receipt` | 运行模型 §1 的字段：`head_before`、计划路径；`head_after`、`diff_digest`、`files`、档位 |
| `write_rejected` / `tier_escalated` | 被拒路径与原因（链接、改名、二进制、保护集合、越界、超限） |
| `candidate_committed` | `head_commit`、`tree_id`、`diff_digest`、累计统计 |
| `verify_intent` / `verify_receipt` | 绑定（§7.2）与结果：退出码、输出摘要、容器移除回执 |
| `delivery_intent` / `delivery_evidence` | v3 §2 的交付证据（§8） |
| `stop_requested` / `stop_unknown` | 沿用已有种类 |

## 5. 执行器与写入约束

### 5.1 适配器契约

按运行模型 §2，对 Mission 只使用四个动作，映射到现有接口：

| 动作 | 现有接口 | 本路径的用法 |
|---|---|---|
| `start` | `startSession(task, signal)`，无会话能力时用 `invoke` | 首轮：目标 + 规格中的边界说明 |
| `send` | `resumeSession(input, signal)` | 验证失败后发送失败摘要（只含退出码与截断输出，不含可执行指令） |
| `observe` | 事件流（`assistant.message`、`session.state`、`session.terminal`） | 状态投影与写入请求（代理模式） |
| `stop` | `AbortSignal` + 可选 `confirmStopped` | 没有 `confirmStopped` 的执行器，停止后进入“停止状态不明”处理（§9） |

能力声明在现有 `capabilities()` 之外增加一个 Mission 专用的只读描述：`containment: { modes: ('proxy'|'sandbox')[], probe: boolean }`、`resume`、`stop_proof`、`version`。描述由适配器给出，**但是否可用由 §5.4 的实测决定**，声明本身不授予任何档位。

### 5.2 两种写入模式

**代理模式（`proxy`，首选）。** 执行器以只读沙箱运行（`codex-cli` 的 `-s read-only`），不能写任何文件。它在最终消息中给出一个统一 diff。主机侧：

1. 解析 diff（拒绝二进制补丁、改名、模式变化、符号链接、子模块）；
2. 对每个目标路径过分类器（§6）；
3. 用 `git apply --check` 在当前 worktree 上演练，再应用；git 以禁用全局/系统配置、剥离 `GIT_*` 环境的方式运行（与 `graph-contained-tests.ts` 导出候选时相同）；
4. 写 `t0_intent`→应用→`t0_receipt`。

优点：写入完全由主机执行，路径检查与写入之间没有执行器可利用的竞态，满足运行模型对“写入代理”的要求。限制：执行器无法运行测试或看到自己的改动生效；diff 受消息大小限制（初版上限 256 KiB，超出则转 T1 的沙箱模式或请求拆分）。

**沙箱模式（`sandbox`）。** 执行器以 `-s workspace-write -C <worktree>` 运行，**不加任何 `writableRoots`**。它可以在 worktree 内直接编辑和运行命令。约束：

- 写入在执行器结束后由分类器对累计 diff 复核（第二道）；任何越界都转 `awaiting_decision`，已写内容留在 worktree，不交付。
- worktree 的 git 元数据在主仓库 `.git/worktrees/` 下，不在可写范围内，因此执行器无法提交；若 HEAD 仍变化（`commitWorktreeChanges` 报告 `executorCommitted`），视为越界。
- 沙箱模式只能运行在 T1（不享有 T0 的“写前判定”，因为写前无法拦截）。

### 5.3 首期合格的执行器

| 适配器 | 代理模式 | 沙箱模式 | 结论 |
|---|---|---|---|
| `codex-cli` | 可（`read-only`） | 可（`workspace-write`，无额外可写目录） | **首期唯一合格** |
| `claude-code` | 否 | 否：只有默认权限或 `bypassPermissions`，没有 OSStack 可强制的写入边界 | 不合格，直到能在强制沙箱（如容器）中运行 |
| `claude-cli`、`opencode-cli`、`deepseek-command` | 否 | 否：无沙箱参数 | 不合格 |
| `zcode-cli` | 否 | 否：硬编码 `--mode yolo` | 不合格 |
| `contained-command` | — | 命令来自构造参数而非目标 | 用于验证，不作为执行器 |

### 5.4 金丝雀自检

声明不可信，每个 Mission 在 `executing` 之前对所选模式做一次实测，结果写 `containment_probe`：

- 沙箱模式：让执行器尝试写入 worktree 外的一个主机侧随机路径（scratch 根下 `runtime/` 中的金丝雀文件）与主仓库 `.git/` 下的一个随机文件，二者都必须失败；再写 worktree 内的金丝雀文件必须成功，之后由主机删除。
- 代理模式：确认执行器以只读沙箱启动后 worktree 未发生任何变化。
- 任一失败：模式不可用，Mission 进入 `awaiting_decision`，不降级运行。

金丝雀依赖的执行器行为（Codex 版本与其沙箱实现、仓库内配置是否会改变沙箱）必须按实测版本核实；`executor_version` 记入规格，版本变化即需重新授权。

### 5.5 执行器环境

执行器子进程的环境为白名单：保留执行器自身登录所需的 `HOME` 与必要的 `PATH`；剥离 `OSSTACK_HOME`、`OSSTACK_SOCKET`、`OSSTACK_ENGINEERING_AUTH_FILE`、`GH_*`/`GITHUB_*`、`*_TOKEN`、`*_API_KEY`（执行器自身所需的除外，按适配器逐个列出）与 `OSSTACK_AUTOAPPROVE`。worktree 在 scratch 根的 `worktrees/` 下创建，遵守 scratch 纪律。

## 6. 写入分类器与档位

### 6.1 位置与复用

在 `packages/governance` 中实现一个纯函数分类器 `classifyMissionWrite(spec, baseline, change)`，规则来源合并 `autonomy/src/risk.ts` 的路径风险规则、`loop/src/review-boundary.ts` 的禁写路径与大小上限、运行模型 §1 的保护集合。代理模式在写前调用，沙箱模式在提交前对累计 diff 调用；同一函数，同一结论。

### 6.2 保护集合

运行模型 §1 的初版，另加两类此前遗漏、会改变执行或验证结果的路径：

- 执行器与工具配置：`.codex/`、`.claude/`、`.cursor/`、`.mcp.json`、`.vscode/`、`.idea/`。
- Git 行为文件：`.gitattributes`（过滤器与 diff 驱动）、`.gitmodules`、任何 `.git*` 路径。

保护集合规范化后取摘要存入 `protected_set_digest`；保护集合本身的修改是 T2。

### 6.3 档位判定

| 判定 | 条件 | 结果 |
|---|---|---|
| 拒绝 | 符号链接、硬链接、改名、模式变化、二进制、被忽略路径、worktree 外路径（realpath 后）、`..` 逃逸 | `write_rejected`，不写入；执行器收到拒绝原因 |
| T2 | 触及保护集合，或改动 `package.json` scripts、测试运行配置、验证代码本身，或不在 `allowed_paths` 内 | 停止执行器，`tier_escalated`，进入 `awaiting_decision` |
| T1 | 累计超出 T0 上限，但仍在规格内 | 继续，记录档位变化；沙箱模式始终为 T1 |
| T0 | 其余（仅代理模式） | 写前登记、写入、收据 |

T0 累计上限（相对 `start_commit`，基线不可由执行器重置）初值：≤ 10 个文件、≤ 400 行增删、单文件 ≤ 1 MB、总 ≤ 5 MB。规格可以收紧，不能放宽；放宽属于修改分类器配置，是 T2。

## 7. 受限验证

### 7.1 复用方式

验证复用 `graph-contained-tests.ts` 的受限执行本身：从 git 对象导出候选提交的文件、构建镜像、在无网络容器中运行固定命令、记录容器移除回执。Graph 依赖只在类型层（`GraphScope`、`VerificationBinding`），`ContainedCommandExecutor` 不依赖 Graph。实现时把导出与建镜像部分提成一个不依赖 Graph 类型的函数，Graph 与 Mission 两个调用方共用；不复制代码。

### 7.2 绑定

| `VerificationBinding` 字段 | Mission 中的取值 |
|---|---|
| `scope` | Mission 的 `scope_id` |
| `graphRunId` | `mission_id` |
| `specHash` | `spec_digest` |
| `epoch` | 验证轮次 `round` |
| `candidateRevision` | `head_commit` |
| `artifactDigest` | 候选的 `diff_digest` |
| `acceptanceRef` | 规格中验证命令的摘要 |

### 7.3 依赖与命令

- 容器无网络，依赖不能在验证时安装。基础镜像按 `pnpm-lock.yaml` 的摘要预先构建并固定镜像 ID（`baseImageId`）；锁文件属于保护集合，所以候选不会改变依赖。基础镜像的构建与刷新是主机侧的独立步骤，不在 Mission 内。
- 命令是规格中的 argv 数组，不来自执行器；本 Mission 若改动了验证会执行的脚本或配置，已在 §6.3 升为 T2。
- 120 秒上限沿用现有容器限制；需要更长时间的验证在规格中显式声明并单独审查上限。

### 7.4 结果

`verify_receipt` 记录退出码、截断输出摘要、`docker-removed:<sha>` 回执与绑定。通过：`verified`。失败：`round < max_rounds` 时把失败摘要 `send` 给执行器并回到 `executing`（新的写入仍走分类器，累计上限仍以 `start_commit` 为基线）；否则 `awaiting_decision`。Docker 不可用：Mission 停在 `candidate_ready` 并进入 `awaiting_decision`，**不在宿主机上直接运行验证命令**。

## 8. 交付与证据

- 推送：主机侧把 `branch` 推到规格中的远端，推送前确认分支头等于 `head_commit`。
- 开 PR：只调用 `openPullRequestToGitHub(input, { repository, headCommit, draft })`，`draft` 取规格值。永不调用 `deliverToGitHub`（它会等待 CI 并合并），也不调用 `mergeWorktree`。
- 交付证据（v3 §2）：仓库与 PR 编号、head 与 base SHA、证据 schema 版本、验证命令与结果、迁移变化（应为无，迁移属于保护集合）、受保护路径变化（应为无）、`mission_id`、证据摘要。权威副本写入 `delivery_evidence` 事件并绑定 head SHA；PR 描述只放展示副本与摘要。候选字段沿用 `protocol` 中 `DeliveryVerificationReceiptV2` 的 `{base_head, head, tree_id, diff_digest}` 形状，不另起格式。
- 开 PR 后 Mission 到达 `pr_opened`，Attention 发一条通知（不是决定）。合并仍由用户人工完成。

## 9. 恢复与停止

- 守护进程重启后，`tick()` 的 `recover()` 列出所有非终态的 contained Mission：
  - 有 `*_intent` 无对应 receipt：`needs_reconciliation`，决策项写明“改动状态未知”与 worktree 的当前 diff 摘要。
  - `executing` 中且执行器没有 `confirmStopped`（`codex-cli` 即如此）：无法证明旧进程已停，记 `stop_unknown`，worktree 冻结（不再写入、不验证、不交付），进入决策。用户确认后才可继续或放弃。
  - `verifying` 中：复用 Graph 受限执行的日志与 `reopen` 方式确认容器是否已移除；不能确认则同样进入决策。
- 用户取消：`cancel_requested` → 停止执行器 → 保全 worktree 与分支 → `cancelled`。
- owner generation 变化时，旧 generation 持有的进程内许可全部失效（与现有许可一致）；新 owner 只能从账本恢复，不能续用旧许可。

## 10. 实施拆分

每项一个面向 `main` 的 PR，按顺序：

| 序号 | 内容 | 主要文件 |
|---|---|---|
| M1 | 迁移 50：`engineering_missions` 重建与 `mission_kind`、`engineering_workspaces`；store API（创建、CAS 转换、事件）；升级门禁与读模型区间 | `packages/core/src/state/engineering-*`、`migrations.ts` |
| M2 | 分类器与保护集合（纯函数、规范化与摘要） | `packages/governance` |
| M3 | `codex-cli` 的 Mission 描述、两种模式的启动参数、环境白名单、金丝雀 | `packages/agents/src/adapters/codex-cli.ts` |
| M4 | 受限验证：从 `graph-contained-tests.ts` 提出不依赖 Graph 的导出与建镜像函数，Mission 绑定 | `packages/cli/src/graph-contained-*` |
| M5 | 宿主编排与 CLI：`osstack mission start|status|cancel|decide`、daemon RPC、tick 中的状态推进 | `packages/cli/src/engineering-host.ts`、`daemon.ts`、新命令文件 |
| M6 | 推送、开 PR、交付证据、Attention 通知 | `packages/cli`、`packages/github` |
| M7 | 中断与重启演练测试（§11 的恢复项） | 各包测试 |

M2、M3、M4 互不依赖，可以并行；M5 依赖 M1–M4；M6 依赖 M5。CLI 新命令按性能预算懒加载，不进入 `cli-entry.ts` 的启动路径。

## 11. 验收

- 迁移 49 的 home 升到 50 后，已有 adopted Mission 的读写与派发行为不变；`contained` 行违反类型约束（如带 `session_id`）被 CHECK 拒绝；同一 worktree 或分支不能同时属于两个活跃 Mission。
- 代理模式：符号链接、改名、二进制、被忽略路径、worktree 外路径在写前被拒；多次小写入累计越过上限后升为 T1；保护集合内的一行改动停止执行器并进入决策。
- 沙箱模式：金丝雀写 worktree 外与 `.git/` 失败；执行器自行提交被识别为越界。
- 修改 `package.json` scripts 或测试配置后，验证不运行，Mission 进入决策。
- 验证在无网络容器中针对固定 head SHA 运行；head 之后变化使证据失效；Docker 不可用时不在宿主机运行验证。
- 验证失败两轮后进入决策；第三轮不会自动开始。
- 交付只开 PR、不合并；PR 描述中的证据摘要与账本中 `delivery_evidence` 一致。
- 崩溃于写入、验证、交付任一 intent 之后：重启后 Mission 处于 `needs_reconciliation`；执行器停止状态不明时 worktree 被冻结。
- 执行器环境中不含 GitHub 凭证与 OSStack 控制面变量。

## 12. 开放问题与评审记录

开放问题（实现前需实测确认）：

1. Codex 沙箱在固定版本下是否会读取仓库内配置并改变沙箱级别；若会，`.codex/` 在保护集合中只能防止被修改，不能防止仓库原有配置生效，需要在启动参数中显式覆盖。
2. 基础镜像的构建方式与刷新时机（按锁文件摘要缓存），以及 pnpm workspace 在只读根文件系统下运行测试是否需要额外的 tmpfs。
3. 代理模式的 diff 上限与拆分策略是否足够实用，还是首期直接以沙箱模式（T1）为主、代理模式作为 T0 的窄通道。
4. `draft` 缺省值：无人值守的结果默认 draft，便于用户先看一眼再请求评审；是否改为 ready 由用户决定。

评审记录：待 Codex 评审后补充。
