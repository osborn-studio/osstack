# Bridge 运行手册（osstack × Grok Bots 双循环）

日期：2026-11-06。基线：`main` `f09d55a6`（含 #378 阶段 4-D 影子对账器、#381 App E 设计、#382 阶段 5 附录、#383 W13 设计）。代码行号均指该基线。
上位文档：[实施方案](../plans/2026-11-02-osstack-grok-bridge-implementation.md)（下称“方案”）、[双循环接通设计 v3](../design/2026-11-01-osstack-grok-bridge.md)（下称“设计”）§9、§11、[阶段 4 附录](../design/2026-11-05-bridge-shadow-reconciler.md)、[阶段 5 附录](../design/2026-11-06-bridge-same-pr-revision.md)、[W13 设计](../design/2026-11-06-w13-host-git-survival.md)、[App E 设计](../design/2026-11-06-bridge-shadow-merger.md)、[ADR-006](../decisions/ADR-006-bridge-s0-decisions.md)。

方案阶段 7 要求本手册先合并，再对主仓库开 `OSSTACK_BRIDGE=1`。本手册写的是**今天能做的操作**，以及阶段 5、W13、App E 合并之后要用的操作。凡是今天代码里还没有的命令、错误码或开关值，都标为 **【计划：PR】**，在那个 PR 合并之前不要执行。没有标记的命令都在基线代码里存在。

2026-11-07 补充：[既有 Grok Bots 接入交接](bridge-grok-bots-handoff.md) 记录用户已给出的云电脑、Bot 分工、原验证技能扩展与 Mac mini 职责。既有个人账号流程继续接续；App C/D 身份迁移和阶段 6 运行条件仍按证据验收。

---

## 0. 安全边界（每次操作前）

1. **只用正式 serving home。** 下文所有 `osstack` 命令都指已安装的 `osstack`（shim），并在命令前显式设置 serving home：`export OSSTACK_HOME=<serving home 的绝对路径>`。**不要**在开发 checkout 里运行 `node packages/cli/dist/bin.js`，也不要让任何 CLI 指向默认的 `~/.osstack` 或保留 home（AGENTS.md“Control-plane DB discipline”：打开数据库就会自动迁移）。控制面守卫会在运行时拒绝开发 checkout 对这些 home 执行 `serve` 和直接读写数据库的命令；守卫是兜底，不是许可，操作上仍要先设好 `OSSTACK_HOME`。
2. **沙箱与主仓库用两个 home。** 沙箱 `osborn-studio/osstack-bridge-sandbox` 与主仓库 `osborn-studio/osstack` 各用一个 serving home，`bridge/` 目录各自独立（§6）。
3. **临时目录**放在 `$OSSTACK_SCRATCH_ROOT` 之下（主机上设为外置盘等固定位置，见 AGENTS.md “Scratch directory discipline”），不要把 `TMPDIR` 指到卷根或项目根。Mission worktree 在 `$OSSTACK_SCRATCH_ROOT/worktrees/` 下。
4. **密钥不进聊天、不进仓库、不进 scratch 根。** App 私钥与签发私钥只放主机私有路径（§2.3）。不要把 `OSSTACK_ENGINEERING_CREDENTIAL`、令牌或私钥内容粘贴到任何会话或 issue。
5. **GitHub 设置的改动**（ruleset、App 安装、App 私钥、协作者权限）都是对外操作，只由仓库管理员执行。会话只准备命令与核对清单（方案 §0.3、ADR-006 决定 5）。
6. 另有一个无关的 `osstack killswitch`（F4 策略开关），它**不是**桥接的关闭开关，不要混用。

---

## 1. 现状一览

| 部分 | 状态（基线） | 依赖的 PR |
|---|---|---|
| 阶段 0：人工修订流程（Watcher/Reviewer/Relay 只通知，人用 `--supersedes` 发起替代 Mission） | **现行流程**，见方案第一部分 §1–§6 | — |
| 阶段 1：PR 机器标记、`mission status` 的 `publication` 字段 | 已实现 | #368 |
| 阶段 3：App A 推送与开 PR、App B 发 `osstack/verify`、`mission publish-check` | 已实现，**只在沙箱**验收（App 只装在沙箱） | #373 |
| 阶段 4-D：影子对账器 `OSSTACK_BRIDGE=shadow`、`mission status --json` 的 `chain` 字段 | 已实现（只读 GitHub，只写影子链表） | #378 |
| App E 影子合并者 `OSSTACK_MERGER=shadow`、`merger.json`、`mission merger report` | **未实现**（只有设计） | M-A（迁移 52）、M-B、M-C |
| 阶段 5：`grant-revisions`、`chain-decide`、修订子 Mission、`publishRevision`、`OSSTACK_BRIDGE=1` | **未实现**（只有附录） | 5-P、5-A … 5-G |
| W13：主机 git 子进程登记、`host_process_unproven`、`marker_lost`、`resume_workspace` | **未实现**（只有设计） | W13-A、W13-B、W13-C1、W13-C2 |
| 阶段 6：Watcher/Reviewer 改用 App C/D，`grok/verify-osstack` 必需检查 | 待决定（平台侧） | — |
| `osstack stats` 的链指标（设计 §6、§9） | **【计划：PR 分支 `feat/bridge-observability`】**：按模式与状态计数、停止原因、影子决定、周期与读取失败；每轮耗时、对账周期耗时等需阶段 5 的数据，届时为 null 并注明原因 | 阶段 7 的前置（§7） |

---

## 2. 主机配置

### 2.1 守护进程环境

按方案 §1.1 设置 Mission 所需变量，分三类，缺失时的表现不同：

| 变量 | 缺失时 |
|---|---|
| 功能开关 `OSSTACK_CONTAINED_MISSIONS=1` | Mission 服务根本不构建：`serve` 照常启动，`mission` 命令返回 `mission_disabled`；`bridge/` 下的文件**一个都不读** |
| 工程面 `OSSTACK_ENGINEERING=1`、`OSSTACK_ATTENTION=1`、`OSSTACK_ENGINEERING_AUTH_FILE` | 开了 `OSSTACK_CONTAINED_MISSIONS=1` 却没开 `OSSTACK_ENGINEERING=1`：`serve` 以 `contained_missions_require_engineering` 退出（`daemon.ts` L4410）。开了工程面但 attention 没启用：`attention_disabled`；缺授权文件变量：`engineering_auth_required`（L4367–4369） |
| 执行配置 `OSSTACK_CONTAINED_CODEX_BIN`、`OSSTACK_CONTAINED_CODEX_HOME`、`OSSTACK_CONTAINED_DOCKER_SOCKET`、`OSSTACK_CONTAINED_DOCKER_DAEMON_ID`、`OSSTACK_CONTAINED_BASE_IMAGE_ID` | `serve` 以 `contained_config_required:<变量名>` 退出（`contained-mission-rpc.ts` L175、L186–191） |

然后在一个终端运行 `osstack serve`。

**所有桥接开关和 `bridge/` 下的文件只在 `osstack serve` 启动、并且 Mission 服务已启用时读取一次**（`createContainedMissionService`，`contained-mission-rpc.ts` L156–219）。改了开关或文件，必须重启 `osstack serve` 才生效。Mission 服务启用时，任何桥接配置错误都会让整个 `serve` 退出（fail closed），不会退回到“关闭桥接”。

### 2.2 `$OSSTACK_HOME/bridge/` 下的文件

| 文件 | 读取者 | 缺失 | 存在但无效 | 状态 |
|---|---|---|---|---|
| `apps.json` + `rulesets.json` | `loadBridgeConfig`（`contained-mission-github-app.ts` L92–110），**无论 `OSSTACK_BRIDGE` 取什么值都读** | **两个都缺**：发布退回主机 `gh` 凭证（阶段 3 之前的行为）；**只缺一个**：`BRIDGE_CONFIG_INVALID:incomplete`，`serve` 退出 | `BRIDGE_CONFIG_INVALID:<文件>:<字段>`、`BRIDGE_CONFIG_INVALID:repository_mismatch`、`BRIDGE_KEY_PERMISSIONS:publisher\|evidence` | 已实现 |
| `producers.json` | `loadProducerRegistry`（`contained-mission-bridge-registry.ts`），只在 `OSSTACK_BRIDGE=shadow` 时读 | 影子关闭，日志 `osstack: bridge shadow: off (no bridge/producers.json)` | `BRIDGE_CONFIG_INVALID:producers.json:<字段>`、`…:duplicate_identity`、`…:publisher_is_reviewer`，`serve` 退出 | 已实现 |
| `merger.json` | 影子合并者 | 影子合并者关闭 | `serve` 退出 | **【计划：M-B/M-C】**今天没有代码读它，放了也不起作用 |
| `revision-issuer.json` + `revision-issuer-<key_id>.pem` | `grant-revisions` | 命令拒绝；守护进程侧 `bridge_grant_not_configured` | 拒绝 | **【计划：5-A】** |

**`apps.json`**（schema 为 `.strict()`，多一个字段即无效）：

```json
{ "version": 1, "repository": "osborn-studio/osstack-bridge-sandbox",
  "publisher": { "app_id": 5620012, "installation_id": 178741375, "private_key_path": "/绝对路径/osstack-publisher.pem" },
  "evidence":  { "app_id": 5620053, "installation_id": 178742088, "private_key_path": "/绝对路径/osstack-evidence.pem" } }
```

App id 与安装 id 以 ADR-006 决定 3 的登记表为准（App id 用于检查归属，安装 id 用于换令牌，不要混用）。今天两个 App 都只装在沙箱。

**`rulesets.json`**：

```json
{ "version": 1, "repository": "osborn-studio/osstack-bridge-sandbox", "mission_ruleset_ids": [26577637, 26577639] }
```

只登记 Mission 分支的两个 ruleset（`mission-writers`、`mission-history`）。发布路径只在候选分支的适用规则**全部**来自这些 id、且规则类型只有写入者限制、禁止 force-push、禁止删除时才放行（方案阶段 3）。多登记 `main-quality` 或 `main-update` 是错误的。

**`producers.json`**（阶段 4 附录 §5.2）：

```json
{ "version": 1, "repository": "osborn-studio/osstack-bridge-sandbox",
  "publisher": [{ "actor_id": <App A 的 bot 用户 id>, "app_id": 5620012 }],
  "reviewers": [{ "actor_id": <测试评审 App 的 bot 用户 id>, "app_id": 5620098 }] }
```

- 只按数字 id 匹配，不看 login。`actor_id` 是 bot **用户** id（`gh api users/osstack-publisher%5Bbot%5D --jq .id`），不是 App id。
- 主仓库在阶段 3 之前由 `gilosbornhello` 发布，`publisher` 应为 `{"actor_id":269190136,"app_id":null}`；`reviewers` 来自 ADR-005 名单。是否在主仓库开影子由用户决定（阶段 4 附录 §8 决定 2，**未决定**；默认只开沙箱）。
- 发布者不能同时是评审者；`gilosbornhello` 的“计入批准”不是链的评审输入，不登记为 reviewer。
- `repository` 必须与 Mission 的 `--publish-repository` 完全一致（区分大小写，`contained-mission-bridge-shadow.ts` L219），否则 Mission 被跳过（日志 `reason=repository_not_registered`）。

### 2.3 私钥的位置与权限

`loadBridgeConfig` 对 App A、App B 私钥分两层检查。路径格式由 schema 检查：`private_key_path` 不是绝对路径时报 `BRIDGE_CONFIG_INVALID:apps.json:publisher.private_key_path`（或 `evidence.…`，`contained-mission-github-app.ts` L18、L74）。文件本身由 `checkKey` 检查（L79–90）：存在、是普通文件、不是符号链接、组与其他用户没有任何权限位（`mode & 077 == 0`）、属主是运行 `serve` 的用户；任一不满足报 `BRIDGE_KEY_PERMISSIONS:<publisher|evidence>`。两种都让 `serve` 退出。推荐权限 `0600`（代码也接受 `0400` 等更严的值）。换令牌时读不到文件：`BRIDGE_KEY_PERMISSIONS:unreadable`；文件不是有效 PEM：`BRIDGE_KEY_INVALID`。

位置约定：沿用沙箱脚本的默认目录 `~/.config/osstack-bridge/apps/<slug>.pem`（`scripts/sandbox-bridge-scenario.mjs`、`scripts/bridge-probe-github.mjs` 的 `--apps-dir`，文件名用 ADR-006 的 GitHub slug）。不要放在仓库、worktree、`$OSSTACK_SCRATCH_ROOT`（`pnpm scratch:clean` 会删）或任何会被同步的目录。

```bash
D=~/.config/osstack-bridge/apps
chmod 700 "$D"; chmod 600 "$D"/*.pem
stat -f '%Lp %Su %HT %N' "$D"/*.pem          # 期望每行：600 <你的用户名> Regular File <路径>
```

| 私钥 | osstack 守护进程是否读取 | 放在哪里 |
|---|---|---|
| A `osstack-publisher`、B `osstack-evidence` | 是（`apps.json`） | 主机，上面的目录 |
| E `osstack-merger` | **否**：仓库里没有为 App E 铸造令牌的代码，影子合并者也不读私钥（App E 设计 §5.3）。只有沙箱探针 P-11 用过 | 不放在 serving 主机上；需要探针时临时放入，用完移走 |
| C、D（Grok Bots） | 否 | Grok Bots 平台的密钥库 |
| 沙箱测试评审 App | 否（只有沙箱脚本） | 同 A、B 的目录，只用于沙箱脚本 |
| `revision-issuer-<key_id>.pem`（Ed25519） | 否（只有 `grant-revisions` 客户端在交互确认后读） | **【计划：5-A】**`$OSSTACK_HOME/bridge/`，`0600` |

### 2.4 ruleset 读回

`--actors` 参数是 **App 名到 App id 的映射文件**，不是 `bridge/apps.json`（`scripts/rulesets-check.mjs` L7、L48–50）：

```bash
cat > "$OSSTACK_SCRATCH_ROOT/actors.json" <<'EOF'
{ "osstack-publisher": 5620012, "osstack-merger": 5620091 }
EOF
node scripts/rulesets-check.mjs --repo osborn-studio/osstack-bridge-sandbox --target sandbox --actors "$OSSTACK_SCRATCH_ROOT/actors.json"
node scripts/rulesets-check.mjs --repo osborn-studio/osstack --target main-repo-interim --actors "$OSSTACK_SCRATCH_ROOT/actors.json"
```

脚本只读，不一致时非零退出。调用者没有 ruleset 管理权限时 GitHub 不返回 `bypass_actors`，脚本把它判为失败。`--target main-repo-interim` 只比较 `main-quality`；它通过只说明质量规则一致，不说明谁能合并。这个脚本只在仓库 checkout 里运行，不打开任何 osstack 数据库，可以安全地在开发 checkout 中执行。

---

## 3. 开关与状态

### 3.1 `OSSTACK_BRIDGE`

| 值 | 今天（`parseBridgeMode`，`contained-mission-rpc.ts` L59–64） | 5-E 合并之后 **【计划：5-E】**（阶段 5 附录 §6） |
|---|---|---|
| 未设 | 关闭：不读 `producers.json`，不建影子链。阶段 3 首轮发布不变：`apps.json` + `rulesets.json` 都在时用 App A/B，都缺时用主机 `gh` 凭证 | 关闭：授权 RPC 拒绝（`bridge_live_disabled`）；在途子 Mission 的推送被栅栏拒绝，子 Mission 停 `awaiting_decision(publication_failed:bridge_live_disabled)`；`revisionRecovery` 的推送回执对账照常运行 |
| `0`（显式） | 关闭：不读 `producers.json`，不建影子链。**熔断（2026-11-07 用户决定）**：`bridge/` 配置存在时，对配置的仓库发布 Mission PR 被拒绝，固定码 `BRIDGE_DISABLED`；不取 App 令牌、不推送、不开 PR、不发 `osstack/verify`，也**不退回主机凭证**。配置外的仓库保持现状（`CONTAINED_BRIDGE_REPOSITORY`）；配置不存在时与未设相同（走主机凭证）。Mission 停 `awaiting_decision(publication_failed:BRIDGE_DISABLED)`（§5.1）。开关只在启动时读一次，改值后必须重启 | 关闭：授权 RPC 拒绝（`bridge_live_disabled`）；在途子 Mission 的推送被栅栏拒绝，子 Mission 停 `awaiting_decision(publication_failed:bridge_live_disabled)`；`revisionRecovery` 的推送回执对账照常运行 |
| `shadow` | 影子：有 `producers.json` 时每 5 分钟只读扫描（§4.3），只写影子链表 | 同左 |
| `1` | `serve` 启动失败：`BRIDGE_LIVE_NOT_IMPLEMENTED` | live：授权过的链由 live 对账器推进；未授权的根 Mission 仍影子记录。要求 `producers.json`、`apps.json`、`rulesets.json`、`revision-issuer.json` 全部有效，否则 `serve` 退出 |
| 其他（含 `true`、`live`、空串、带空格） | `serve` 启动失败：`BRIDGE_MODE_INVALID` | 同左 |

**关于 `0` 的语义：** 设计 §11 写的是“`OSSTACK_BRIDGE=0` 只停止新的预留与派发，在途子 Mission 走现有取消路径，`pending` 意图在下次启动时对账”。阶段 5 附录偏差 7 把它改得更严：`0` 同时拒绝在途子 Mission 的推送，关掉开关后不再有任何 App A 修订推送。这一偏差是否接受仍待用户决定（阶段 5 附录 §8 决定 8）。在决定之前，按更严的语义操作：关开关之后，要逐个处理停住的子 Mission（§5.4、§5.5）。

“只对单个 scope 开 `OSSTACK_BRIDGE=1`”（方案阶段 7）：基线代码里没有按 scope 限制的开关；实际范围由 `grant-revisions` 只授权哪些根 Mission 决定（**【计划：5-A】**）。

### 3.2 `OSSTACK_MERGER`

**今天没有任何代码读 `OSSTACK_MERGER`**，设成什么都没有效果，也不会报错。M-C 合并之后 **【计划：M-C】**：`shadow` 且 `merger.json` 存在时启用影子合并者；未设或 `0` 关闭；`1`、`live` 或其他值让 `serve` 以 `MERGER_LIVE_NOT_IMPLEMENTED` 退出。它与 `OSSTACK_BRIDGE` 互不依赖。真实合并不在任何已批准的设计里（ADR-006 决定 2 “Shadow first”）。

### 3.3 隐含的开关：`apps.json`

首轮 App A/B 发布看 `bridge/apps.json` 与 `rulesets.json` 是否存在（§2.2），并受 `OSSTACK_BRIDGE=0` 熔断约束。所以：

- **显式 `OSSTACK_BRIDGE=0` 会阻止阶段 3 的首轮发布**：配置存在时，对配置仓库的发布以 `BRIDGE_DISABLED` 被拒绝（App A 不推送、不开 PR，App B 不发 check），不退回主机凭证。开关只在 `osstack serve` 启动时读取一次，**改值后必须重启**。未设与 `shadow` 不阻止首轮发布。
- 同时删除两个文件会**静默退回主机 `gh` 凭证**。沙箱上主机凭证推送 Mission 分支会被 `mission-writers` 拒绝（探针 P-10），但在没有 Mission ruleset 的仓库上会成功。不要用“删掉两个文件”来停用 App A。

---

## 4. 日常检查

### 4.1 守护进程

```bash
export OSSTACK_HOME=<serving home>
osstack status                     # daemon 版本；"daemon: not running" 说明 serve 没在跑
```

`osstack serve` 的 stderr 是桥接的唯一服务日志，但它**只覆盖下表这几种情况**：已有影子链的周期结果（`observation_cycle`）、已有链的读取失败（`read_failed`）与状态转换（`transition`）只写进链事件表，不打日志，今天也没有 CLI 能读（§4.2 末）。影子对账器的日志行都以 `osstack: bridge shadow:` 开头：

| 日志 | 含义 | 处理 |
|---|---|---|
| `off (no bridge/producers.json)` | 设了 `shadow` 但没有登记表 | 符合预期则不管；否则补 `producers.json` 并重启 |
| `chain_created mission=cm_… chain=rc_…` | 首次见到一个 Mission PR，建了影子链 | 正常 |
| `skip mission=cm_… reason=<原因>` | 这个 Mission 在本进程内不再被考虑 | 见下表 |
| `discovery_read_failed mission=… code=<码>` | 首次读取 PR 失败，下一轮重试 | 偶发正常；持续出现看 §5.6 |
| `cycle_abandoned chain=… code=version_conflict\|stale_decision` | 乐观并发冲突，本周期放弃 | 偶发正常 |
| `read_failed_unrecorded`、`scan_failed` | 连失败事件都写不进去 | 检查磁盘与数据库锁；不是 GitHub 问题 |

`skip` 的原因：`publication_not_opened`（Mission 没有 `publication.kind = opened`）、`repository_not_registered`（仓库名与登记表不同）、`base_head_missing`、`pr_has_shadow_chain`（同一 PR 已被另一个 Mission 的影子链占用，例如阶段 0 的替代 Mission 复用了 PR——实际上替代总是开新 PR，出现时要查）、`repository_invalid`、`author_not_publisher`（PR 作者不在 `publisher` 里）。这些 `skip` 只在进程内记住，重启后会重新判断。`skip … reason=publication_unreadable` 例外：它是读取账本出错，不记入跳过集合，游标再次扫到时会重试（`contained-mission-bridge-shadow.ts` L217）。

### 4.2 `mission status --json`

```bash
M=cm_<id>
osstack mission status --mission $M --json > "$OSSTACK_SCRATCH_ROOT/status-$M.json"
S="$OSSTACK_SCRATCH_ROOT/status-$M.json"
jq -r '.mission.state' "$S"
jq -r '[.events[] | select(.kind=="halted")] | last | .payload | fromjson | .reason' "$S"   # 最近一次停机原因
jq '.publication' "$S"                                                                      # kind / pr / pushed_commit / base_head
jq '.chain | if . == null then "no shadow chain" else
  {mode, state, stop_reason, pr_number, published_head, published_base,
   decisions: [.shadow_decisions[] | {action, reason, head_sha, base_sha, review_ids, observed_at}]} end' "$S"
```

- `events` 只含最近 50 条，每条 `payload` 截断到 2 000 字符（`contained-mission-host.ts` L38、L82）；截断的 `payload` 上 `fromjson` 会失败，此时看原始字符串。
- `publication` 按事件种类读取，不受 50 条的限制。
- `chain` 今天只返回**影子**链（`chainForMission(missionId, 'shadow')`，`contained-mission-rpc.ts` L209），字段为 `chain_id`、`mode`、`state`、`stop_reason`、`repository`、`pr_number`、`published_head`、`published_base`、`base_ref`、`updated_at` 与最近 10 条 `shadow_decisions`。不含正文、摘要或身份。live 链字段（`rounds_used`、`grant.rounds`、`expires_at`、`current_mission_id`）**【计划：5-A】**。
- 链挂在**根 Mission** 上。查修订子 Mission 的 `chain` 得到 `null` 是正常的。
- 影子链的事件（`observation_cycle`、`read_failed`、`transition`）今天**没有任何读取入口**：不打日志，`mission status` 也不返回。能看到的只有链的 `state`、`stop_reason`、`updated_at` 与影子决定。一条链长期停在 `awaiting_review` 且 `updated_at` 不变，可能是读取持续失败，也可能只是没有新评审，今天无法区分；先用 §4.4 的 `gh api rate_limit` 与手工 `gh pr view` 排除 GitHub 侧问题。`mission status --json` 返回最近 10 条链事件（只含白名单字段）与事件总数 **【计划：PR 分支 `feat/bridge-observability`】**。按状态计数、`awaiting_decision` 原因分布与读取失败次数见 `osstack stats` 的 bridge 段（同一 PR）；对账周期耗时目前没有记录。

### 4.3 正常是什么样子

| 对象 | 正常 | 需要看一眼 |
|---|---|---|
| Mission | 发布后停在终态 `pr_opened`；`publication.kind = opened`；`publication.pushed_commit` 等于 `mission.candidate_head` | `publication.kind` 为 `evidence_missing` 或 `opened_before_cancel`；`events` 里有 `verify_check_failed`（用 `mission publish-check` 重发，§5.4） |
| 影子链（沙箱） | Mission 进入 `pr_opened` 后，要等发现扫描的游标覆盖到它、且读取与建链都成功才会建链，没有固定时限。`serve` 启动 5 分钟后第一次扫描，之后每次扫描**结束后**再等 5 分钟；每次扫描的发现阶段最多遍历 200 个 `pr_opened` Mission（4 页 × 50，已有链或已跳过的也占位置，到末尾才回到开头），最多新读 5 个 PR，每次扫描总共最多读 10 条链；`pr_opened` 的历史 Mission 多时要多轮；`state` 为 `awaiting_review` 或 `ready_for_human`；评审要求修改时出现一条 `would_reserve`（`reason = changes_requested`） | `awaiting_decision`：看 `stop_reason`（§5.5）；同一 head 出现两条 `would_reserve`（数据库主键不允许，出现即缺陷） |
| 影子链的结束 | PR 合并或关闭后转 `closed`（转换原因 `pr_merged`/`pr_closed`，不产生影子决定） | PR 已关闭但链长期不是 `closed`：链若已在 `awaiting_decision`，对账器不再读它（`contained-mission-bridge-shadow.ts` L294），这是设计内的行为，不是故障 |
| 首轮发布身份 | 沙箱 PR 作者 `osstack-publisher[bot]`；`osstack/verify` 来自 App id 5620053，`head_sha` 等于 `candidate_head` | 作者是 `gilosbornhello`：说明 `apps.json` 不在或 serving home 不对 |

影子决定只是“会做的动作”，不是许可：`would_mark_ready` 不代表可以合并，合并前仍按方案 §4 的合并者清单核对；`would_reserve` 在今天对应阶段 0 的“Relay 给主机所有者发摘要，人按方案 §1.3 发起替代 Mission”。

### 4.4 每日 GitHub 侧核对

```bash
gh api rate_limit --jq '.resources.graphql | "\(.remaining)/\(.limit) reset \(.reset|todate)"'   # 影子读取用主机 gh 的 GraphQL 额度
node scripts/rulesets-check.mjs --repo osborn-studio/osstack-bridge-sandbox --target sandbox --actors "$OSSTACK_SCRATCH_ROOT/actors.json"
gh api repos/<owner/repo>/pulls/<n>/commits --paginate --jq '.[].sha'                            # 与 publication.pushed_commit 对照
```

---

## 5. 事故处理

### 5.1 关闭开关

**今天（基线）：**

1. 在运行 `osstack serve` 的终端按 Ctrl-C（或对 serve 进程发 `SIGTERM`）。守护进程会先置 draining、停影子对账器（最多等 5 秒）、等当前 Mission tick 结束再退出。不要用 `SIGKILL`：它会把在途的执行器或验证留成需要停止证明的状态（§5.3）。
2. 以 `OSSTACK_BRIDGE=0` 重新启动 `osstack serve`。如果 serve 由 LaunchAgent 管理（`osstack serve --install`），环境来自 plist：用 `osstack serve --status` 找到 plist 路径，直接检查其 `EnvironmentVariables.OSSTACK_BRIDGE`（`--status` 本身不显示该值），改 plist 后重新加载，再按第 4 步用启动日志确认。
3. **步骤 2 里显式的 `OSSTACK_BRIDGE=0` 重启已经同时阻止 App A 的首轮发布**（§3.3）：`bridge/` 配置存在时，对配置仓库的发布被拒绝，Mission 停 `awaiting_decision(publication_failed:BRIDGE_DISABLED)`，`mission status --json` 的停止原因里可见；未设不算熔断。恢复：去掉 `OSSTACK_BRIDGE=0`（改为未设或 `shadow`）后重启，再对停住的 Mission 执行 `approve_publication`，或 `abandon`。更强的选项：
   - 只想暂停：新 Mission 不加 `--publish-preauthorized`，并且不对停在 `publication_pending` 的 Mission 执行 `approve_publication`。已在 `delivering` 的 Mission 会在下一次 tick 重试发布。
   - 要立即硬停（比开关更强，不依赖 osstack 代码；怀疑泄露或被滥用时用这个）：由管理员在 GitHub 上暂停（Suspend）或卸载 App A 的安装（§5.2）。这是平台级的阻止，不依赖 osstack 代码。
   - 只删除 `bridge/apps.json`（保留 `rulesets.json`）会让 `serve` 以 `BRIDGE_CONFIG_INVALID:incomplete` 拒绝启动，同时停掉所有 Mission。只在要整体停机时用。不要两个文件都删（§3.3）。
4. 核对：serve 启动日志出现 `osstack: bridge: disabled by OSSTACK_BRIDGE=0`（`bridge/` 配置存在时才有；只有它能区分“显式 0”与“未设”，未设时发布仍走 App A）；`osstack: bridge shadow:` 不再出现；`mission status --json` 中已有的 `chain` 保持不变（影子链表只是记录，关掉后不需要清理）。

**5-E 合并之后 【计划：5-E】：**

1. 同上重启为 `OSSTACK_BRIDGE=0`。新的预留与派发立即停止。
2. 在途子 Mission：按阶段 5 附录偏差 7，推送会被栅栏拒绝，子 Mission 停在 `awaiting_decision(publication_failed:bridge_live_disabled)`。逐个决定：`osstack mission decide --mission <子> --decision abandon`，或等重新开启后 `approve_publication`。需要立即终止执行中的子 Mission：`osstack mission cancel --mission <子>`（现有取消路径；需要 stop 或 write scope）。
3. 未结的推送意图：下次 `serve` 启动时 `revisionRecovery` 的推送回执对账在任何模式下都会运行（只读 GitHub、只写本地账本），不需要人工触发。仍为 `uncertain` 的意图见 §5.5 的 `intent_uncertain`。
4. 链本身：`osstack mission chain-decide --chain rc_<id> --decision abandon` 关闭不再需要的链 **【计划：5-A】**。

### 5.2 App 私钥泄露或需要吊销

**先做平台动作，再改主机。** 吊销私钥不会使已经签出的安装令牌失效（令牌最长约 1 小时有效，`contained-mission-github-app.ts` 在到期前 5 分钟刷新）；暂停或卸载安装才会让该安装的令牌立即失效。所以泄露时两件都要做。

| App | 泄露后攻击者能做什么（ADR-006 探针结果） | 立即动作（管理员，GitHub 设置） | 主机动作 | 恢复 |
|---|---|---|---|---|
| A `osstack-publisher` | 创建并快进任何 `osstack/mission/*` 分支、开 PR、发评论和非批准 review（P-1：只有发布代码阻止这两项）；**不能**推 `main`、合并、批准、强推或删除 Mission 分支（P-1、P-3、P-12） | ① 暂停或卸载 App A 在所有仓库的安装 ② 在 App 设置里删除泄露的私钥 | 停 `serve`（§5.1）；把 `apps.json` 里 `publisher.private_key_path` 指向新私钥（`0600`） | 生成新私钥 → 重新安装 → 用 `gh api repos/<r>/branches --paginate --jq '.[].name' \| grep '^osstack/mission/'` 列出 Mission 分支，与账本里 `pr_opened` Mission 的 `spec_json.branch` 对照；多出的分支与 PR 是可疑写入，关闭 PR（`mission-history` 禁止删除这些分支，留作证据） |
| B `osstack-evidence` | 在安装仓库的任何提交上发 check run，包括伪造 `osstack/verify`（`checks: write`）；不能推送或评论（P-8） | 同上 ① ② | 同上，换 `evidence.private_key_path` | 新私钥生效后，对每个仍打开的 Mission PR 先核对 live head：`gh pr view <n> --repo <r> --json headRefOid -q .headRefOid` 必须等于该 Mission 的 `publication.pushed_commit`（`publish-check` 只比较本地账本里的候选与发布证据，不读 PR 当前 head，`contained-mission-bridge.ts` L179–186）；相等才运行 `osstack mission publish-check --mission cm_<id>`（把 check 发在账本的候选提交上，不碰分支与 PR）；不相等说明发布后有人推送，不要重发，按方案 §2.3 “head 与 Candidate 不一致”处理；把泄露期间 App B 发出、但账本里没有对应 `verify_check_published` 事件的 check 列为可疑，告知 Watcher 运营者 |
| E `osstack-merger` | `contents: write`：推送任何**未受 ruleset 保护**的分支；在沙箱上它是 `main-update` 的 bypass（`pull_request` 模式），能合并满足 `main-quality` 的 PR（P-11 ①） | ① 暂停或卸载安装 ② 删除私钥 ③ 从沙箱 `main-update` 的 bypass 中移除 App E：管理员在 GitHub 的 ruleset 设置里删掉 App E 这一项（`.github/rulesets/main-update.json` 的模板本身含 App E，`--print-body main-update --actors <映射>` 输出的请求体也含它，**不能原样应用**；要用它就先从输出里删掉 `actor_id` 为 5620091 的项）。之后 `gh api repos/osborn-studio/osstack-bridge-sandbox/rulesets/26577634 --jq '.bypass_actors'` 读回确认没有 5620091。此时 `rulesets-check.mjs --target sandbox` 会因与模板不一致而失败，这是预期的，直到决定是否改模板 | 无：osstack 守护进程不使用 App E（§2.3） | 新私钥只在需要探针时临时放到主机 |
| C、D（Grok Bots） | C 发 `grok/verify-osstack`；D 提交 review（App 的批准不计入必需批准，P-5） | 同上 ① ② | 无 | 通知 Grok Bots 运营者在平台密钥库更换 |

吊销 App A 之后 osstack 侧的表现：令牌源会复用尚未临近到期的缓存令牌（到期前 5 分钟才刷新，`contained-mission-github-app.ts` L206），所以失败可能出现在两处：重新签发被拒（`BRIDGE_TOKEN_REQUEST:<HTTP 状态>`），或缓存令牌的 `git push`/`gh pr create` 被 GitHub 拒绝（错误码是 git/gh 的退出信息）。不要以某一个错误码作为吊销生效的判据；以 GitHub 上安装已暂停或已卸载为准，再看 Mission 不再前进。两种失败都发生在栅栏已经记下 `remote_mutation` 之后，所以都按“可能已写远端”处理：Mission 记 `delivery_uncertain`，留在 `delivering`，下一次 tick 重试，3 次后停在 `awaiting_decision(publication_failed:attempts_exhausted)`（`contained-mission-runner.ts` L49、L394、L411–416）。新私钥与安装就绪后，对这些 Mission 执行 `approve_publication` 重试；发布对同一 head 幂等（复用同一 PR）。

阶段 5 之后 **【计划：5-C】**：修订推送非零退出后按远端读回分三种（阶段 5 附录 §5.3 第 5 步）：明确被拒（`--porcelain` 的 `!`，或认证在任何引用更新前失败，被吊销的令牌属于这种）**且**读到远端仍为 `expected_old_head` → 意图 `failed`，链 `stopLive('publish_refused:push_rejected')`，子 Mission 停 `publication_failed:<码>`；读到 `new_head` → 继续第 6 步确认；读取失败或其他结果 → 意图 `uncertain`，链 `intent_uncertain`（§5.5）。修订路径没有主机凭证回退（未配置 App 时端口缺失，`publication_failed:bridge_not_configured`）。

### 5.3 卡在 `stop_unknown`

`stop_unknown` 的意思是 osstack 不能证明它启动过的某个进程或容器已经停止。证明不了就不前进：不释放工作区、不允许 `discard_changes`/`adopt_worktree`（`stop_evidence_required`）。出口只有一个：`osstack mission decide --mission <id> --decision retry_stop_check`，它重新取停止证明，成功后转 `needs_reconciliation`（原因 `stop_evidence_recovered`），或在取消未完成时转 `cancelled`（`contained-mission-host.ts` L105–118、L180–192）。证明仍不成立时报 `CONTAINED_STOP_UNPROVEN`，状态不变。

**今天的 `stop_unknown` 原因**（`halted` 事件的 `reason`）：

| 原因 | 未停止的是什么 | 怎么证明 |
|---|---|---|
| `executor_stop_unproven`、`executor_failed:<码>`、`executing_stop_unproven_after_restart`、`cancel_requested_stop_unproven_after_restart`（最近打开的是执行器） | Codex 执行器的进程组 | `executor_started` 事件里的 `pgid` 对应的进程组为空；没有 `executor_started` 时，没有任何进程的命令行包含该 worktree 路径 |
| `qualification_probe_not_stopped` | 执行器资格探针的进程组 | **今天的恢复缺口**：探针不写 `executor_started`，`retry_stop_check` 只会去证明最近一次执行器回合或验证（`contained-mission-host.ts` L201–218）。首轮之前的探针没有可证明的对象，`retry_stop_check` 一直报 `CONTAINED_STOP_UNPROVEN`；修复回合之前的探针则可能拿上一轮执行器的证明“通过”，而探针本身未被检查。所以：先用下面 A 的第二条 `grep` 确认没有命令行含该 worktree 的 Codex 进程，再 `retry_stop_check`；确认不了就保留现场与工作区认领、不要发信号。探针登记与恢复 **【计划：未分配 PR】** |
| `verify_stop_unproven`、`verify_failed_to_settle:<码>`、`verifying_stop_unproven_after_restart` | 验证容器 | osstack 自己按记录的容器 id 删除容器并写回执 |

**A. 执行器进程组（安全地手工结束孤儿进程）**

osstack 的恢复从不替你杀进程；只有在下面每一条核对都通过时才由你手工结束。任何一条不通过就**不要发信号**，让 Mission 停在 `stop_unknown`，记录现场后找人。

```bash
M=cm_<id>; S="$OSSTACK_SCRATCH_ROOT/status-$M.json"
osstack mission status --mission $M --json > "$S"
WT=$(jq -r '.mission.spec_json | fromjson | .worktree_path' "$S")
# 转入 executing 的事件（首轮 executor_launch_intent，修复 repair_started，extra_repair decision_extra_repair，discard_changes decision_discard_changes）与随后的 executor_started
jq -c '[.events[] | select(.kind | IN("executor_launch_intent","repair_started","decision_extra_repair","decision_discard_changes","executor_started"))] | .[-2:][] | {kind, created_at, payload}' "$S"
PGID=<executor_started 的 payload 里的 pgid>          # payload 还有 pid 与 started_at（毫秒）
ps -axww -o pid=,ppid=,pgid=,lstart=,command= | awk -v g="$PGID" '$3 == g'   # 该进程组里的全部进程
ps -axww -o pid=,pgid=,command= | grep -F -- "$WT" | grep -v grep             # 命令行里提到该 worktree 的进程
ps -o pgid= -p $$                                                            # 你自己 shell 的进程组，不能等于 PGID
```

执行器先被启动，`executor_started` 事件才写入（`codex-proxy.ts` L174–181、`contained-mission-runner.ts` L221），所以真正的执行器 leader 的启动时间在“转入 `executing` 的事件”与 `executor_started` 之间。逐条核对：

1. 输出的两行依次是一个转入 `executing` 的事件和紧随其后的 `executor_started`，都来自本 Mission **最近一次**执行器回合，并且都在 50 条事件的窗口里（不在窗口里就不要猜，停下）。
2. 进程组的 leader（`pid` 等于 `PGID` 的那一行）存在，命令行是 `OSSTACK_CONTAINED_CODEX_BIN` 指向的程序，并且包含完整的 worktree 路径 `$WT`（执行器总是以 `-C <worktree>` 启动，`contained-mission-host.ts` L237；路径里有每个 Mission 独有的随机 id）。
3. leader 的 `lstart`（只精确到秒）落在转入 `executing` 事件的 `created_at` 与 `executor_started.payload.started_at` 之间（两端各放宽 1 秒）。在这个区间之外，或 leader 不存在而组里还有别的进程，都说明不能确认身份（pgid 可能被复用，或进程逃出了预期），**不要杀**。
4. 组里的其他进程都是 leader 的后代（沿 `ppid` 能追到 leader），启动时间不早于 leader。
5. `PGID` 不等于 `osstack serve` 的进程组，也不等于你自己 shell 的进程组。
6. 第二条 `grep` 列出的进程，如果是你自己打开的编辑器、shell 或 `git`（命令行带 worktree 路径），正常退出它们，不要发信号。

任何一条不能确认，就让 Mission 留在 `stop_unknown`，保存上面三条命令的输出，找第二个人复核；宁可等这些进程自行退出后再 `retry_stop_check`，也不要对身份不明的进程组发信号。

全部通过后：

```bash
kill -TERM -- "-$PGID"; sleep 10
kill -0 -- "-$PGID" 2>/dev/null && echo "still alive" || echo "group empty"
# 仍存活且重新核对第 2–4 条通过，才用：kill -KILL -- "-$PGID"
osstack mission decide --mission $M --decision retry_stop_check --json
```

然后按 §5.4 的 `needs_reconciliation` 行处理。

**B. 验证容器**

不要手工 `docker rm`。停止证明要求 osstack 自己写的删除回执；你手工删掉容器，回执就永远不会产生，这个 Mission 再也证明不了（`packages/agents/src/contained-command.ts` L163–186）。正确做法：

```bash
docker info --format '{{.ID}}'                       # 必须等于 OSSTACK_CONTAINED_DOCKER_DAEMON_ID
docker ps -a --filter label=osstack.contained.spec   # 只看，不删
osstack mission decide --mission $M --decision retry_stop_check --json
```

`retry_stop_check` 会按记录的容器 id 删除容器并写回执（`contained-mission-ports.ts` L317–343）。Docker 守护进程没运行、socket 不对、daemon id 变了，都会让证明失败；先修好 Docker，再重试。

**C. 放弃**

`stop_unknown` 也允许 `abandon`，但这只结束 Mission：停止义务没清时，工作区声明不会释放，每次 `serve` 启动的恢复仍会尝试证明（`contained-mission-host.ts` L161–169）。先证明，再放弃。

**W13 之后 【计划：W13-C1、W13-C2】**（W13 设计 §5、§10）：

- 新原因 `host_process_unproven:<op_id>`：主机侧的 `git update-ref`、`worktree add`、真实索引写入、`git push`、`gh pr create` 在守护进程崩溃后可能仍在运行。用户已决定（W13 设计 §10 决定 1）：恢复**只观察、从不发信号**，由人手工结束进程后 `retry_stop_check`。`mission status` 会显示该登记的 pgid 与命令种类，`host_process_unproven` 事件带具体的未知原因码（W13 设计 §5.2）。**只有 `group_alive` 可以考虑手工结束**，并且要做与上面 A 相同的核对，替换两条：第 2 条改为“leader 的命令是对应的 `/bin/sh` 包装进程或其 `exec` 出的 `git`/`gh`，`cwd` 是该 worktree 或仓库”（`git push` 的 argv 不含 worktree 路径，用 `lsof -a -p <pid> -d cwd` 看）；第 3 条改为“leader 的 `lstart` 与登记的 `leader_start` 相同”。登记的 `leader_start` 不可读、或与 `lstart` 不同，都不发信号。其他原因码不能靠结束登记的进程组解决：

  | 未知原因 | 含义 | 出口 |
  |---|---|---|
  | `group_alive` | 登记的进程组仍在，leader 启动时间与登记相同 | 等它退出，或按上面核对后手工结束；再 `retry_stop_check` |
  | `group_present` | 进程组存在，但 leader 不在、`leader_start` 为空或 `ps` 读不到 | 不发信号；等进程组自行消失后 `retry_stop_check` |
  | `escaped_holder` | 进程组已空（或 pid 已复用），但有别的进程仍持有标记文件（逃出了进程组） | 用 `lsof -- <标记文件>` 找持有者，按同样的身份核对决定；核对不了就等它退出 |
  | `unregistered_holder` | 登记还是 `launching`（没有 pid），标记却有人持有 | 同上 |
  | `holder_scan_unavailable` | `lsof` 阳性对照失败，无法扫描持有者 | 修好 `lsof`（权限、PATH）后 `retry_stop_check`；不要因为“扫不到”就认为已停止 |
  | `probe_failed` | 任一探针抛错 | 看服务日志里的错误，修好后 `retry_stop_check` |
  | `marker_lost` | 持有标记文件（`$OSSTACK_HOME/contained/host-processes/` 下）被删或被替换，证明永远不成立 | 推荐出口（W13 设计 §10 决定 5 (a)，**未决定**）：等主机重启（启动会话标识变化后判 `stopped(rebooted)`），或 `abandon`（认领不释放，worktree 冻结）。不要手工重建标记文件 |
- 证明之后的出口：路线为 `delivering` 的转 `awaiting_decision(publication_failed:host_process_recovered)`，用 `approve_publication` 重试；路线为 `authorized` 的转 `awaiting_decision(workspace_recovered)`，用 `osstack mission decide --decision resume_workspace` **【计划：W13-C1】**；核对不成立的转 `awaiting_decision(workspace_failed:host_process_recovered)`，只能 `abandon`。
- `retry_stop_check` 的前提放宽为“`stop_unknown`，或终态且有未结登记”（后者只证明并释放认领，不改状态）。

### 5.4 Mission 的停机原因与下一步

决定命令都是 `osstack mission decide --mission <id> --decision <决定> --json`，需要该 scope 的 write（`cancel` 需要 stop 或 write）。允许的决定由 `contained-mission-runner.ts` L101–116 与 `contained-mission-host.ts` L105–118 决定，不在下表的组合返回 `CONTAINED_DECISION_NOT_ALLOWED`。

| 状态（原因） | 含义 | 下一步 |
|---|---|---|
| `awaiting_decision`（`publication_pending`） | 候选已验证，等发布许可 | 核对 diff 后 `approve_publication`；不发布则 `abandon` |
| `awaiting_decision`（`publication_failed:<码>`） | 发布失败且确定没有写远端，或重试次数用完（`attempts_exhausted`）、读回的推送提交不符（`pushed_head_mismatch`）、发布前检查不过（`candidate_unverified`、`stop_unproven`、`claim_released`、`verify_receipt_mismatch`、`candidate_untraced`、`publication_not_configured`），或发布端口报错（如 `BRIDGE_TOKEN_REQUEST`、`BRIDGE_KEY_PERMISSIONS`、`CONTAINED_PUBLICATION_DESTINATION`、`CONTAINED_BRIDGE_REQUIRES_HTTPS`、`CONTAINED_PUBLICATION_FENCE`） | 先按码修好原因（令牌与私钥见 §5.2、§5.7；目的地错误检查 remote 的 push URL），再 `approve_publication`；修不好则 `abandon` |
| `awaiting_decision`（`revalidation_failed:<码>`） | `approve_publication` 之后的复核不过（码同上一行的发布前检查） | 同上 |
| `awaiting_decision`（`repair_cycles_exhausted`） | 验证失败且修复额度用完 | `extra_repair`（再给一次修复回合）或 `abandon` |
| `awaiting_decision`（`tier_escalated`、`write_rejected`、`secret_detected`、`patch_invalid:<码>`、`patch_apply_failed:<码>`、`cumulative_diff_failed:<码>`） | 改动越界（T2、受保护路径、超出 caps）、含疑似密钥，或补丁无法应用 | 只能 `abandon`；需要时用更窄的 `--allow` 或更清楚的 `--goal` 重新发起 Mission（阶段 0 用 `--supersedes`，方案 §1.3） |
| `awaiting_decision`（`qualification_failed`、`executor_identity_changed`、`executor_spawn_failed:<码>`） | 执行器探针不过、Codex 版本或身份与授权时不同、启动失败 | 修主机上的 Codex 配置；只能 `abandon` 后重新发起 |
| `awaiting_decision`（`workspace_failed:<码>`、`workspace_head_mismatch`、`workspace_unrecorded`） | worktree 建立失败或起点不符 | 只能 `abandon`；检查 `--base` 与 `$OSSTACK_SCRATCH_ROOT/worktrees/` 的空间与权限 |
| `needs_reconciliation`（`stop_evidence_recovered`、`orphaned_executing`、`orphaned_verifying`、`commit_failed:<码>`） | 停止已证明，但工作区可能与账本不一致 | `discard_changes`（回到上一次提交的候选，重新执行一回合）、`adopt_worktree`（把 worktree 里的改动分类后当作候选）或 `abandon`。两者都要求停止义务已清，否则 `stop_evidence_required` |
| `stop_unknown`（任何原因） | 见 §5.3 | 证明停止后 `retry_stop_check` |
| `pr_opened` 且事件里有 `verify_check_failed` | PR 已开，`osstack/verify` 没发出去 | `osstack mission publish-check --mission <id>`（只重发 check，幂等；未配置 App B 时报 `bridge_not_configured`；`OSSTACK_BRIDGE=0` 熔断时同样报 `bridge_not_configured`，不是 `BRIDGE_DISABLED`，因为熔断下 check 端口不存在） |
| `cancel_requested` 长期不变 | 取消在等执行器或验证停止（运行中的那一步收到中止后自己记证据并转 `cancelled`） | 先看 `stepping`（`mission status --json` 顶层字段）：为 `true` 说明那一步仍在运行，等它结束。守护进程重启过、`stepping` 为 `false` 仍不变时，`retry_stop_check` 不接受这个状态（只接受 `stop_unknown`）：按 §5.1 第 1 步正常重启 `serve`，启动恢复会证明停止后转 `cancelled`，证明不了则转 `stop_unknown(cancel_requested_stop_unproven_after_restart)`，再按 §5.3 中最近打开的是执行器（A）还是验证（B）处理 |
| `delivering` 长期不变 | 每次 tick 幂等重试发布；看 `events` 里的 `delivery_uncertain` | 3 次后会自动停到 `publication_failed:attempts_exhausted` |

阶段 5 与 W13 之后新增的 Mission 原因 **【计划】**：

| 原因 | 来源 | 下一步 |
|---|---|---|
| `publication_failed:bridge_live_disabled` | 5-E：`OSSTACK_BRIDGE` 不为 `1` 时修订推送被拒 | 重新开启后 `approve_publication`，或 `abandon` |
| `publication_failed:bridge_not_configured`、`publication_failed:push_in_flight`、`publication_failed:pr_changed_after_push`、`publication_failed:readback_mismatch`、`publication_failed:<publish_refused 码>` | 5-C：修订发布 | 链同时停止（§5.5）；先按链的停止原因处理，子 Mission 通常 `abandon` |
| `budget_exhausted` | 5-B：`chargeLaunch` 时分配不足 | 先 `grant-revisions --chain` 增加预算，再 `osstack mission decide --decision resume_budget` **【计划：5-B】** |
| `grant_stopped:<原因>` | 5-A/5-D：授权到期或失效 | 先 `grant-revisions --chain` 再授，再 `resume_grant` **【计划：5-B】** |
| `chain_stopped:<原因>` | 5-B：链已因其他原因停止，子 Mission 被阻止推进 | 按链的停止原因处理（§5.5）；子 Mission 不能单独恢复 |
| `publication_failed:host_process_recovered`、`workspace_recovered`、`workspace_failed:host_process_recovered` | W13 | 见 §5.3 末 |

### 5.5 链的停止原因与下一步

**影子链（今天）**：影子链停在 `awaiting_decision` 之后不会再被读取，也没有任何命令能让它离开（`contained-mission-bridge-shadow.ts` L294）。它是记录，不需要处理；需要处理的是它指出的 PR 状况，处理方法仍是阶段 0 的人工流程。

| `stop_reason` | 影子链里出现的条件 | 你要做的 |
|---|---|---|
| `attribution_unknown` | PR head 不等于发布的 head（影子模式无法把新 head 归因给发布者，任何 head 变化都停止） | 查谁推了：`gh api repos/<r>/pulls/<n>/commits --paginate --jq '.[].sha'` 与 `publication.pushed_commit` 对照。不是预期的推送 → 按方案 §5 “bot 做了约定之外的写操作”处理；阶段 0 案例 B（人手工推送）属于预期 |
| `base_changed` | base SHA 或 base ref 与发布时不同（`main` 前移最常见） | 无需处理影子链；阶段 0 由 Watcher 在新 base 上重新验证（方案 §2.5 “需要重新验证”） |
| `reviewer_conflict` | 当前 head 上一个登记评审者批准、另一个要求修改 | 转给主机所有者决定（方案 §1.3） |
| `no_feedback` | `CHANGES_REQUESTED` 的顶层正文与未解决线程都为空 | 请评审者补充要改什么；在那之前不要发起替代 |
| `review_deadline` | 影子链不设截止时间，**不会出现** | 出现即缺陷，报告 |
| `external_write`、`head_regressed`、`rounds_exhausted` | 只属于 live 链，影子链**不会出现** | 出现即缺陷，报告 |

**live 链 【计划：5-A … 5-E】**（阶段 5 附录 §4.4、§5.1）。命令：`osstack mission grant-revisions --chain rc_<id> --rounds 1|2 --expires <时长>`（再授，只能在交互终端，需要输入 `GRANT <preview_sha256>` 确认并用主机签发私钥签名）与 `osstack mission chain-decide --chain rc_<id> --decision abandon|takeover|reconcile`（需要 write scope，不要求 TTY）。

| `stop_reason` | 子 Mission | 下一步 |
|---|---|---|
| `rounds_exhausted` | 无在途 | 默认 1 轮、累计上限 2（用户已定的默认值，阶段 5 附录 §8）：还没到 2 轮可 `grant-revisions --chain … --rounds 2`。`rounds_exhausted` 是在预留**之前**判定的（`revision-chain.ts` L169–178），所以当前 head 通常没有预留，再授后对账器会重新评估当前 head 上的要求；只有当前 head 已有预留（含被作废的）时，才要等新 head（命令会提示“当前 head 已消耗”）；到 2 轮后只能人自己改、`chain-decide abandon` 或 `takeover` |
| `grant_expired`、`grant_invalid` | 不取消，停 `awaiting_decision(grant_stopped:<原因>)` | `grant-revisions --chain …` 再授（`grant_invalid` 要先让授予人重新获得该 scope 的 write），再 `mission decide --decision resume_grant`；不再继续则 `chain-decide abandon` |
| `budget_exhausted` | 不取消，停 `awaiting_decision(budget_exhausted)` | `grant-revisions --chain …` 增加预算，再 `resume_budget` |
| `child_halted` | 保持，人处理同一个子 Mission | 按 §5.4 对**子 Mission** 做 `mission decide`；子 Mission 被恢复后链自动回到在途状态（唯一会自动恢复的停止原因） |
| `child_cancelled`、`child_failed` | 终态，预留作废 | `chain-decide abandon` 或 `takeover`。不能再授，也不会自动恢复：这个 head 已经预留过，而新 head 只会来自本链的推送（阶段 5 附录 §4.4、§5.1）。还要继续修订，就在人接管后重新发起 Mission 并重新授权 |
| `external_write`、`head_regressed` | 请求取消 | 查推送来源（同影子 `attribution_unknown`）；接管则 `chain-decide takeover`，否则 `abandon`。不能靠再授恢复 |
| `base_changed` | 请求取消 | `chain-decide abandon`（不会自动重放到新 base）；需要时在新 base 上重新发起 Mission |
| `reviewer_conflict`、`no_feedback`、`review_deadline` | — | 人决定；`chain-decide abandon` 或 `takeover` |
| `protected_set_changed` | 请求取消 | 守护进程升级改变了保护集合；`chain-decide abandon`，在新版本下重新授权 |
| `publish_refused:<码>` | `awaiting_decision(publication_failed:<码>)` | 按码查（`not_descendant`、`push_rejected` 等）；通常 `chain-decide abandon` |
| `intent_uncertain` | `awaiting_decision`，或推送进程停止证明不成立时为 `stop_unknown(host_process_unproven:<op_id>)` | 推送可能已落地。子 Mission 是 `stop_unknown` 时，先按 §5.3 的 W13 部分证明推送进程已停止并 `retry_stop_check`；之后再 `chain-decide reconcile`（只读回执；远端等于 `new_head` 且提交范围相符则结算 `confirmed`）。仍判定不了：人确认该推送不会再落地后 `chain-decide takeover`。不要重推 |
| `dispatch_failed` | 未创建 | 同一 head 连续 3 个周期派发失败。它不在可再授的停止原因里，链也不会自动恢复：查明原因（serve 日志、链事件）后 `chain-decide abandon` 或 `takeover` |
| `reconciliation_incomplete`（不改停止原因的检查结果） | — | 还有已放行未结算的推送意图；先处理 `intent_uncertain` |

**`ready_for_human`** 不是停止：链认为评审已通过，等人合并。osstack 永不合并（ADR-006 决定 2 “Unchanged”）。它的判定规则（“参与评审者集合非空且全部批准”）仍待用户确认（阶段 4 附录 §8 决定 3、阶段 5 附录 §8 决定 3），5-E 合并前必须定下。

### 5.6 限流

| 调用方 | 凭证 | 额度 | 被限流时的表现 | 处理 |
|---|---|---|---|---|
| 影子对账器（今天） | 主机 `gh`（`gh api graphql`，`contained-mission-bridge-reader.ts` L94） | 主机账号的 GraphQL 额度。每次扫描结束后等 5 分钟再扫；每次扫描最多读 10 条链；同一条链两个周期之间至少隔 5 分钟；每次完整读取一个 PR 最多 40 个请求、每个连接最多 10 页；要记录 `would_reserve`/`would_mark_ready` 时，紧接着再做一次二次确认读取（另计最多 40 个请求） | 已有链：只写 `read_failed` 链事件（`request_failed`、`graphql_errors`、`request_cap`、`page_cap`、`second_read_failed` 等，今天看不到，§4.2 末），链不变；首次发现：serve 日志 `discovery_read_failed` | `gh api rate_limit` 查看（§4.4）；额度紧张时关影子（§5.1），不要调小间隔（代码里也没有可调的开关） |
| App A 推送与开 PR、App B check | 安装令牌 | 每个安装单独计 | `BRIDGE_TOKEN_REQUEST:403\|429:…`、`CONTAINED_VERIFY_CHECK_HTTP:403\|429`、`CONTAINED_VERIFY_CHECK_LIMIT` | 首轮发布按 §5.2 的重试规则；check 用 `mission publish-check` 稍后重发 |
| live 对账器 【计划：5-E】 | 主机 `gh` 读、App A 写 | — | 指数退避，退避期间不写任何东西（设计 §9） | 等退避结束；持续限流时关开关 |

### 5.7 启动与配置错误码速查

| 错误 | 原因 | 处理 |
|---|---|---|
| `contained_config_required:<变量>` | 缺 Mission 环境变量 | 补变量（§2.1） |
| `contained_missions_require_engineering`、`attention_disabled`、`engineering_auth_required`、`mission_disabled` | 工程面或 Mission 的功能开关、attention、授权文件变量缺失（§2.1 表） | 同上 |
| `BRIDGE_LIVE_NOT_IMPLEMENTED`、`BRIDGE_MODE_INVALID` | `OSSTACK_BRIDGE` 取值（§3.1） | 改为未设、`0` 或 `shadow` |
| `BRIDGE_CONFIG_INVALID:incomplete` | `apps.json`、`rulesets.json` 只有一个 | 补齐或（只在确定要退回主机凭证时）两个都移走 |
| `BRIDGE_CONFIG_INVALID:<文件>:<字段>`、`…:json`、`…:unreadable:<errno>`、`…:repository_mismatch` | 文件格式、字段，或 `apps.json` 与 `rulesets.json` 的仓库不一致（忽略大小写比较） | 按字段改。`producers.json` 的 `repository` 代码**不**与这两个文件比较：不一致时 `serve` 照常启动，Mission 在发现时被跳过（日志 `reason=repository_not_registered`）。三者一致是运维约定，配置后自己核对 |
| `BRIDGE_KEY_PERMISSIONS:publisher\|evidence\|unreadable`、`BRIDGE_KEY_INVALID` | 私钥路径、权限、属主或内容 | §2.3 |
| `BRIDGE_TOKEN_REQUEST:<状态>:<消息>` | 换安装令牌失败（安装被暂停或卸载、私钥被删、App id 或安装 id 错） | 核对 ADR-006 登记表与 GitHub 上的安装 |
| `BRIDGE_TOKEN_SCOPE:repositories\|permission:<名>\|malformed_response` | 令牌覆盖了多余的仓库或权限 | 管理员收紧 App 安装的仓库范围与权限 |
| `CONTAINED_VERIFY_CHECK_STATE\|EVIDENCE\|HEAD\|REPOSITORY\|NETWORK\|MALFORMED` | `publish-check` 的前置不满足或网络问题 | 只对 `pr_opened` 且验证通过的 Mission 重发。`HEAD` 说明本地账本的候选与发布证据不一致，**不**表示检查过 PR 当前 head；PR 当前 head 要另用 `gh pr view` 核对（§5.2 B 行） |
| `engineering_credential_required`、`daemon_connection_required`、`permission_denied` | CLI 侧凭证、守护进程未运行、scope 不够 | 设置 `OSSTACK_ENGINEERING_CREDENTIAL`（read 与 write 都要，方案 §1.1 第 3 条）；启动 `serve` |

---

## 6. 沙箱与主仓库

| | 沙箱 `osborn-studio/osstack-bridge-sandbox` | 主仓库 `osborn-studio/osstack` |
|---|---|---|
| App 安装 | A–E 与测试评审 App 都只装在这里（ADR-006 决定 3） | **没有**。在主仓库安装任何 App 是用户决定 |
| ruleset | 四个都已套用（`main-quality` 26575831、`main-update` 26577634、`mission-writers` 26577637、`mission-history` 26577639） | 经典分支保护；Mission 分支 ruleset 未套用（ADR-006 决定 5）。以 `rulesets-check.mjs --target main-repo-interim` 读回为准 |
| `bridge/apps.json`、`rulesets.json` | 放（§2.2 示例） | **不放**：App 没装，放了只会让首轮发布在换令牌时失败。阶段 0 的发布身份是主机 `gh`（`gilosbornhello`，方案 §1.1 第 5 条） |
| `OSSTACK_BRIDGE=shadow` | 可以 | 需要用户决定（阶段 4 附录 §8 决定 2）；登记表用 `gilosbornhello` 作 publisher |
| `OSSTACK_MERGER=shadow` 【计划：M-C】 | 可以 | 建议等 `main-quality` 与 Mission ruleset 套到主仓库之后（App E 设计 §8 决定 3）；之前所有决定都会是 `refused` |
| 破坏性脚本（`bridge-probe-github.mjs`、`sandbox-bridge-scenario.mjs`） | 只允许这里（脚本内白名单） | 禁止 |
| 每次运行留下的痕迹 | 每次探针或场景留下一个删不掉的 `osstack/mission/…` 分支（`mission-history`）；尽量少跑 | — |

一个 serving home 只服务一个仓库的桥接配置。`apps.json` 与 `rulesets.json` 的 `repository` 由代码强制一致；`producers.json` 的 `repository` 不在加载时比较（§5.7），要自己保持一致。在两个仓库上都要用桥接时，用两个 serving home，各自运行一个 `osstack serve`，并给每个 home 设置不同的 `OSSTACK_HOME`。

---

### 6.1 GitHub Actions 修复试验

在独立沙箱控制面配置 App A 与现行 Mission ruleset，把 `OSSTACK_CONTAINED_SANDBOX_CI_SCOPE` 设为沙箱克隆所在的登记 scope。此模式可以省略 Docker 配置。启动权限限于该 scope 的 operator，当前 fixture 使用 `osborn-studio/osstack-bridge-sandbox`。

用 `osstack mission start --github-ci --base main --publish-repository osborn-studio/osstack-bridge-sandbox` 及正常的 scope、repo、goal 和 allow 参数启动。在夹具演练中显式允许 `PROBE_FAIL` 和需要保留的探针文件。初始发布使用原有的 `approve_publication` 入口。失败观察确认已登记的工作流、检查、提交和失败步骤后，最多派发一个修复 Mission。

从原 Mission 的状态事件 `ci_repair_dispatched` 取出修复 Mission ID。审阅该 Mission 的候选提交和本地 diff 后，使用 `osstack mission approve-ci-repair --mission ID --candidate SHA`。授权有效期为 15 分钟。发布前 osstack 再读 PR、CI 失败和授权，用旧 head 的 Git 租约推送单个快进提交。修复停在 `ci_repair_publication_unresolved` 时，先对照发布意图与远端，保留该次尝试的记录。

`ci_repair_verified` 保存新提交的 GitHub 检查证据。App B 的本地检查信号仍用于容器验证路径。Watcher、计入的人工审批和合并身份继续按阶段 6 审批与验收。

## 7. 阶段 7 上线前检查清单

> 2026-11-09 首发计划更新。下列是既有本地验证和 App 迁移路径的清单。GitHub CI 驱动首发须先按[实施方案阶段 7](../plans/2026-11-02-osstack-grok-bridge-implementation.md#阶段-7-主仓库单-scope-试运行)完成验证、更新运行手册，并审批 [ADR-007 提案](../decisions/ADR-007-bridge-github-ci-first.md)后再开启单 scope 试运行。

方案阶段 7 的验收是“连续 5 条链无异常，设计 §6 的指标能用 `osstack stats` 读出”。下面每一项都要有记录（PR 号、链 id、时间）。任何一项不满足，不在主仓库开 `OSSTACK_BRIDGE=1`。

**前置代码与决定**

- [ ] 本手册已合并。
- [ ] 阶段 5 全部合并并满足阶段 5 附录 §5.6 末的完成门槛：live TLA 模型 TLC 无反例；`OSSTACK_PROPERTY_RUNS=10000` 的属性测试通过；故障注入与变异全部有失败测试；5-G 沙箱端到端全部场景通过（含第 3 次要求修改转人与越权测试）。
- [ ] W13-C2 已合并（5-C 的硬前置）；5-P 的探针 P-13（真实 `git push --force-with-lease` 的快进、非快进、过期租约）在沙箱通过。
- [ ] 阶段 6 完成：Watcher 为 App C，`grok/verify-osstack` 是 `main` 的必需检查并绑定 App C；Reviewer 为 App D。
- [ ] 用户已决定：`ready_for_human` 规则；阶段 5 附录偏差 6、7；W13 设计 §10 决定 2、5、6；App A/B 是否安装到主仓库；主仓库的 `main-update` 名单。
- [ ] 主仓库已套用 `main-quality`、`mission-writers`、`mission-history`，`rulesets-check.mjs` 读回一致；`bridge/rulesets.json` 只登记主仓库的两个 Mission ruleset id。
- [ ] 主仓库 serving home 的 `apps.json`、`producers.json`、`revision-issuer.json` 与私钥按 §2 配置并核对过权限；`gilosbornhello` 的 `gh` 登录可用（阶段 0 流程在上线期间仍是回退路径）。
- [ ] `osstack stats` 能读出：链按状态计数、每轮耗时、`awaiting_decision` 原因分布、对账周期耗时与失败次数（设计 §9）。状态计数、原因分布与失败次数由 PR 分支 `feat/bridge-observability` 提供；每轮耗时与对账周期耗时尚未记录（需阶段 5），在它们可读之前仍是阶段 7 的阻塞项。

**演练（在沙箱 serving home 上做一遍）**

- [ ] 关闭开关：`OSSTACK_BRIDGE=1` → `0`，确认新派发停止、在途子 Mission 停在预期原因、重启后回执对账运行（§5.1）。
- [ ] 吊销：暂停 App A 安装后修订推送失败且链停止；恢复后能继续或干净地 `abandon`（§5.2）。
- [ ] `stop_unknown`：用一个阻塞的假 `git` 制造主机进程孤儿，按 §5.3 的核对手工结束并 `retry_stop_check`（W13 设计 T10/T11 的人工版）。
- [ ] `intent_uncertain`：在推送后、确认前停掉 `serve`，重启后按 §5.5 用 `chain-decide reconcile` 结算。

**上线（主仓库，单个根 Mission 起步）**

- [ ] 先对主仓库开影子（`OSSTACK_BRIDGE=shadow`）至少一周，影子链没有 `review_deadline`/`external_write`/`head_regressed`/`rounds_exhausted`（这些在影子链出现即缺陷），没有未解释的 `attribution_unknown`。
- [ ] 开 `OSSTACK_BRIDGE=1` 后只对一个根 Mission 执行 `grant-revisions --rounds 1`。
- [ ] 连续 5 条链无异常。“无异常”定义为：每条链都以 `ready_for_human`（随后人合并）、`closed` 或 `awaiting_decision` 中**有预期原因**的一种结束；没有 `intent_uncertain`、`external_write`、`head_regressed`、`dispatch_failed`、`reconciliation_incomplete`；每次推送都对应一条 `confirmed` 意图，PR 上的提交与账本的推送范围一一对应；每个 head 一条 App B 的 `osstack/verify`；没有任何 merge、评论或 PR 编辑来自 App A。
- [ ] 每条链结束后，对照 PR 时间线（`gh api repos/osborn-studio/osstack/issues/<PR>/timeline --paginate`）与 `mission status --json`，记录在方案 §10。

---

## 8. 审计记录

**第 1 轮（Codex CLI gpt-6-astra，medium，只读，基于初稿）：** 2 个 P1、12 个 P2、0 个 P3。逐条核对代码后全部接受：

| 发现 | 核对 | 处理 |
|---|---|---|
| P1 手工结束执行器进程组的身份判据反了：执行器先启动、`executor_started` 后写入，“启动时间不早于事件”会拒绝真进程、放行复用 pgid 的进程；W13 部分沿用了这一判据 | 属实，`codex-proxy.ts` L174–181，`contained-mission-runner.ts` L221；W13 设计 §5.2 第 7 条 | §5.3 A：leader 的 `lstart` 必须落在 `executor_launch_intent` 与 `executor_started.started_at` 之间，并要求 leader 存在、命令含完整 worktree 路径、其他成员是其后代；核对不了不发信号。W13 部分改为比较登记的 `leader_start`，且只对 `group_alive` 考虑手工结束 |
| P1 App E 撤权步骤用 `--print-body main-update` 生成的请求体仍含 App E，且缺 `--actors` | 属实，`.github/rulesets/main-update.json` L14，`scripts/lib/rulesets.mjs` L50–61 | §5.2 E 行：在 GitHub 设置里删除该项（或先从输出中删掉 5620091 再应用），并读回确认 |
| P2 W13 的未知原因只写了两个 | 属实，W13 设计 §5.2 | §5.3 W13 部分加原因表与各自出口 |
| P2 `child_cancelled`/`child_failed`、`dispatch_failed` 写了“等新 head 继续”，没有合法路径 | 属实，阶段 5 附录 §4.4、§5.1 | §5.5：只能 `chain-decide abandon\|takeover` |
| P2 `intent_uncertain` 漏了子 Mission 为 `stop_unknown` 的情况 | 属实，阶段 5 附录 §5.3 第 5 步 | §5.5：先证明停止并 `retry_stop_check`，再 `reconcile` |
| P2 影子读取的请求上限与间隔作用范围写错 | 属实，`contained-mission-bridge-reader.ts` L211–215、L428–437 | §5.6 分开写扫描间隔、同链间隔、单次读取上限与二次确认 |
| P2 “一个扫描周期内出现影子链”没有保证 | 属实，`contained-mission-bridge-shadow.ts` L134、L169、L181 | §4.3 改为“无积压时下一次扫描”，写明发现预算与扫描后再等 5 分钟 |
| P2 serve 日志看不到 `observation_cycle` 与已有链的 `read_failed` | 属实，同文件 L325、L333–336 | §4.1、§4.2：写明观测缺口，事件查询标为计划 |
| P2 `CONTAINED_VERIFY_CHECK_HEAD` 不检查 PR 当前 head | 属实，`contained-mission-bridge.ts` L179–186 | §5.7 改写；§5.2 B 行恢复前先用 `gh pr view` 核对 live head |
| P2 吊销后的失败不一定出现在取令牌（缓存令牌） | 属实，`contained-mission-github-app.ts` L206 | §5.2 写两种失败位置，不以错误码判断吊销生效 |
| P2 不是每个环境变量缺失都报 `contained_config_required` | 属实，`contained-mission-rpc.ts` L175，`daemon.ts` L1292、L4404–4411 | §2.1 分三类列出 |
| P2 私钥路径错误由 schema 报 `BRIDGE_CONFIG_INVALID`；`077` 检查不等于只接受 0600/0400 | 属实，`contained-mission-github-app.ts` L18、L74、L88 | §2.3 分两层写 |
| P2 三份配置的仓库一致性只校验了两份 | 属实，`contained-mission-bridge-registry.ts` 独立加载 | §5.7、§6 写明代码实际校验范围 |
| P2 说直接读写数据库的命令没有守卫，与 AGENTS.md 相反 | 属实，AGENTS.md “Control-plane DB discipline” | §0 第 1 条改写 |

**第 2 轮（同一模型与设置，基于第 1 轮修订稿）：** 第 1 轮 14 项中 11 项判为已解决、3 项部分解决（进程身份判据只适用于首轮回合、建链时延仍无保证、工程面错误码合并错写），0 项未解决；新增 1 个 P1、7 个 P2（含部分解决项的剩余问题）。逐条核对代码后全部接受：

| 发现 | 核对 | 处理 |
|---|---|---|
| P1 `cancel_requested` 指向 `retry_stop_check`，而它只接受 `stop_unknown` | 属实，`contained-mission-host.ts` L112、L171 | §5.4：先看 `stepping`；守护进程重启后由启动恢复转 `cancelled` 或 `stop_unknown`，再按执行器或验证处理 |
| 部分：身份核对只认 `executor_launch_intent`，修复、`extra_repair`、`discard_changes` 回合写的是别的事件 | 属实，`contained-mission-runner.ts` L109、L132、L212、L335 | §5.3 A：时间下界取任一转入 `executing` 的事件，jq 同步修改 |
| 部分：缺 attention 或授权文件变量的错误码不是 `contained_missions_require_engineering` | 属实，`daemon.ts` L4367–4369 | §2.1 表与 §5.7 补 `attention_disabled`、`engineering_auth_required` |
| P2 `qualification_probe_not_stopped` 不能“同上”恢复 | 属实，探针不写 `executor_started`，`stopProof` 只看最近一次执行或验证（`contained-mission-host.ts` L201–218） | §5.3 表标为今天的恢复缺口，先手工确认无残留进程；探针登记标为计划 |
| P2 `rounds_exhausted` 被说成当前 head 已预留 | 属实，`revision-chain.ts` L169–178 先查已预留 head 再查额度 | §5.5 区分“额度不足、未预留”与“已有预留” |
| 部分：发现阶段的分页上限没写，建链时延仍被写成有保证 | 属实，`contained-mission-bridge-shadow.ts` L191–203 | §4.3 改为“游标覆盖到且读取成功才建链”，写明每次最多遍历 200 个 |
| P2 `publication_unreadable` 不会被永久跳过 | 属实，同文件 L217 只打日志 | §4.1 单列为可重试 |
| P2 计划中的认证失败结算缺远端读回条件 | 属实，阶段 5 附录 §5.3 第 5 步 | §5.2 末改为三分支，保留计划标记 |

两轮之后停止审计；第 2 轮的修改未再审计。
