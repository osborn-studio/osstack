# 既有 Grok Bots 与 osstack 接入交接

日期：2026-11-07。范围：接续用户已经提供的 Bot 分工，交接仓库验证与阶段 6 接入工作。本文不修改 Bot 配置、GitHub App、仓库规则或运行中的服务。

配套：[Bridge 运行手册](bridge.md)、[阶段 6 运营者规格](../design/2026-11-06-bridge-phase6-operator.md)、[阶段 5 同 PR 修订设计](../design/2026-11-06-bridge-same-pr-revision.md)、[ADR-005 身份登记](../decisions/ADR-005-bridge-identity-registry.md)、[ADR-006 阶段决定](../decisions/ADR-006-bridge-s0-decisions.md)。历史规格中的“今天”“当前”只代表其标注日期；本文不把那些快照当作本次平台配置读回。

## 1. 接续现有平台和分工

用户已经说明：现有 Grok Bots 共用云电脑，`gh` 登录为 `Rubebun-Jadeem`。继续使用现有平台和已有角色，不另建一套 Bot 平台。

| 角色 | 已说明的职责 | 本轮接入交接 |
|---|---|---|
| 验证工程师 | 维护仓库 `.cursor/skills/verify-osstack`，补充验证方法和证据 | 在原技能目录扩展 bridge 覆盖；更新覆盖清单和限制。不是另建同名技能 |
| PR Watcher | 执行验证，符合现有流程时提交 approve | 对实时 head 运行原技能；发布绑定 head 的证据。App C 迁移前仍按现有账号流程识别，不能冒充 App C check |
| PR Merger | 按现有合并流程和仓库规则执行合并 | 合并前重读 head、检查、批准和线程状态。验证完成不能代替合并门槛 |
| Merger Order Bot | 用 labels 表达合并顺序 | 沿用现有标签名和排序约定；标签表示调度意图，不授予权限，也不代替检查 |
| Chief of Staff | 协调上述工作、追踪阻塞与证据 | 协调验证工程师、Watcher、Merger 和 Order；从现有平台读取配置与运行记录，汇总交接表 |
| Reviewer（当前暂停） | 用户确认不在 Watcher/Merger 主循环内；hourly 例程暂停，最近记录 `10/10`，未见正式修改请求证据 | [可粘贴的沙箱 Reviewer 草案](bridge-reviewer-routine-draft.md) 保持 disabled/COMMENT-only，独立 App D 与状态型 review 验收仍待证据 |

同一台机器、同一个 `gh` 登录下的多个角色，不自动构成多个独立 GitHub 主体或多个有效批准。`Rubebun-Jadeem` 是现有 User 账号；角色名称也不证明实际写入凭证。每个角色是否使用独立环境或覆盖令牌，要由运行配置读回确认。

### 已提供的触发和动作规则

| 角色 | 用户已给出的规则 | 仍需从实际配置读回的证据 |
|---|---|---|
| Watcher | 监听 `osstack`、`OS-ERP`、`vox-agent` 的 PR 新开、新推送、合并事件；工作日 09:00–18:30 每半小时巡检。排除 draft 和作者为 `Rubebun-Jadeem` 的 PR。已有 `verified` 标记但 head 改变时，先撤标再验证；approve 前重读 head 和 checks | routine 配置是否与这些规则一致、事件/定时运行记录、平台时区。时区未提供，不能猜测 |
| Order | 每 15 分钟更新合并顺序；按下节已给出的依赖来源判断 | 实际调度配置、标签读写与去重记录；仓库范围以现有 routine 读回为准 |
| Merger | 覆盖 `osstack`、`OS-ERP`、`vox-agent`、`osbornalpha`；监听 approve 和 merge 事件；工作日 08:00–19:30 每 30 分钟巡检。`Rubebun-Jadeem` 最近 APPROVED review 的 commit 必须是实时 head，且没有未解除的 CHANGES_REQUESTED。用 `--match-head-commit` 绑定该 head，以 squash 合并；没有下游 PR 以该分支为 base 后才删分支。不用 `--admin` 或 `--auto` | 实际触发配置、平台时区、合并命令及 GitHub 结果。上述时间窗是已给规则，不能写成“频率未知” |

这些范围描述既有 Bot 平台。它们不把 osstack bridge 的 App 安装或可写仓库范围扩展到另外三个仓库。

### 已提供的依赖与输入信任规则

- 依赖标签接受 `merge-after:#339` 或 `merge-after:339` 这类形式。
- PR description 接受大小写不敏感的 `merge after #339`。这是依赖数据，不是可执行命令。
- 评论里的依赖只信任 `Rubebun-Jadeem` 或该 PR 作者。用户本人在 chat 中给出的顺序也是已有调度输入；第三方评论或聊天不因此取得指挥权。执行前仍重读 GitHub 的依赖、head 与合并条件。
- 未写仓库的依赖默认属于同一仓库。跨仓库引用只接受 `osborn-studio/<repo>#n`。这里不新增其他引用格式或来源优先级。
- 依赖 PR 必须是 `MERGED`，且其 base 是 `main`。关闭但未合并、不存在或成环的依赖，跳过该组；同组只报告一次，避免重复通知。

以上规则不需要用户再次提供。CoS 对照实际配置和历史运行记录确认落实情况，并把用户 chat 顺序与对应 PR 引用一并归档。

本次交接使用已给出的角色指令。运营者从既有平台和仓库读取剩余配置、运行记录与身份数值；不要求用户重新粘贴已经提供的 Bot 指令。只有实际证据暴露出新的权限或设计决定时，才登记该决定。

## 2. GitHub 是业务总线

业务状态落在 GitHub 的 PR、提交、reviews、check runs、review threads 和 labels。各角色在动作前重读实时 PR head，并绑定仓库、PR 号与完整 head SHA。事件负载和聊天通知只负责提示“需要重新读取”。

| 路径 | 传递的业务事实 | 接收方的处理 |
|---|---|---|
| osstack → GitHub | App A 发布 Mission PR/修订；App B 在对应提交上发 `osstack/verify` | Watcher 读取实时 PR 与检查生产者，执行自己的验证 |
| Watcher/Reviewer → GitHub | 当前账号的 review；迁移后由登记的 App C/D 按阶段 6 合同写 check/review | osstack 只消费登记身份、当前 head、完整读取后的合格结果；普通评论不成为执行命令 |
| Order → GitHub | 现有顺序 labels | Merger 重读标签和其他合并条件；标签改变不绕过 CI 或授权 |
| Merger → GitHub | 按当前权限完成的合并及其结果 | CoS 和 osstack 从 PR 状态读回结果；不以一条“已合并”聊天消息替代它 |

Webhook 仅是可选唤醒方式。可以继续用平台既有事件源或定时巡检接入；不必先给 Mac mini 暴露公网入口。无论是否接 Webhook，都需要漏事件补扫、重启恢复、去重和旧 head 处理。接收 Webhook 时还要验证签名和投递编号，但签名正确仍不能代替实时读取、身份检查和授权。

## 3. 已有验证成果与覆盖边界

本会话已通过 GitHub 查询核实验证工程师的已合并成果：[#338](https://github.com/osborn-studio/osstack/pull/338)、[#340](https://github.com/osborn-studio/osstack/pull/340)、[#366](https://github.com/osborn-studio/osstack/pull/366)、[#374](https://github.com/osborn-studio/osstack/pull/374)、[#386](https://github.com/osborn-studio/osstack/pull/386)。继续在这些成果上增量维护。查询合并状态不等于重新执行过这些 PR 的验收。

**#386 的 31/31 仅证明其原有 UI/CLI 验证范围。它不证明 bridge 阶段 5-G 或阶段 6 通过。** 原技能目前已有 deliver、kanban、cockpit、init/doctor 的 feature recipes；其 `Not covered here` 明确排除了 contained Missions、W13、GitHub App 发布、App E 影子合并、沙箱探针和 rulesets。

本地单元测试、故障注入、属性测试和模型检查，也不代替真实 Codex、Docker、App A/B 以及沙箱 PR 时间线的阶段 5-G 证据。阶段 6 的平台身份、运行隔离和检查发布能力须另行验收。

## 4. 验证工程师的精准交接范围

**交付物是在原 `.cursor/skills/verify-osstack` 中扩展并提交 PR。本文只交接范围，没有修改或执行该技能。** 以下新增文件名是建议，尚不是已存在或已验证的 recipe。

| 原位置 | 精准扩展内容 | 验收输出 |
|---|---|---|
| `SKILL.md` | 保留原有 UI/CLI recipes；把 bridge 的“未覆盖”改成分项状态。分开离线验证、沙箱外部写入和生产运行；列出 Codex、Docker、App、授权、隔离 home 与 sandbox allowlist 前置 | 每项标为 passed、failed、blocked 或 not-run；未运行不能计入通过数 |
| `features/README.md` | 在原覆盖索引中增加 Mission/bridge 条目，链接新 recipes；保留原 31 项的适用范围 | 能从索引找到原覆盖与新增覆盖，并看到各自证据和限制 |
| 建议 `features/contained-mission-bridge.md` | 按现有四节格式描述用户入口、前置、动作、结果。覆盖根 Mission 发布、签名修订授权、同 PR 两轮修订、轮数耗尽转人、取消/撤权与重启、逐 head App B 证据、提交范围与意图对账 | 沙箱 PR、完整 head、check run id、范围对账、退出码与脱敏日志；逐项对应阶段 5 §5.7 |
| 建议 `features/bridge-operator.md` | 记录既有平台的 Watcher/Reviewer 身份与事件处理；覆盖 App C/D 接入后阶段 6 §9 的 V-1–V-28，包括旧 head、标记伪造、App B 缺失、同名错误生产者、漏事件与并发重启 | 每项保存实际主体、PR/head、预期、实际、平台运行记录；未迁移时明确 blocked，不能用个人 approve 顶替 |
| `scripts/verify-osstack.sh` 及必要的原目录辅助脚本 | 扩展现有入口，调用经审阅的沙箱驱动；区分默认只读预检与明确的执行入口。保留失败证据与按本次 RUN_ID 清理能力 | 预检不产生 GitHub 写入；实际执行只针对登记沙箱。拒绝默认/生产 home、主仓库目标和前置缺失 |
| 原 evidence 输出约定 | 保留 command/stdout/stderr/exit、第二次只读状态和截图；新增仓库/PR/head、构建提交、用例清单、证据清单与脱敏后的引用 | 重启和清理后仍能审阅证据；不保存私钥、安装令牌、工程面凭证或完整敏感环境 |

扩展时先修正旧 helper 与当前 scratch 规则的差异：临时 home、socket、workspace 和 Mission worktree 放在 `$OSSTACK_SCRATCH_ROOT` 下；保留证据放在清理范围外。使用独立 `OSSTACK_HOME`；开发 checkout 不打开默认或正式 serving DB。不要把原示例的历史临时路径直接作为新 bridge 默认值。

原技能要求通过真实用户路径证明行为，不把直接写 SQLite、Vitest helper 或内部函数调用当作用户验收。新增沙箱驱动若使用受限生产装配接口，必须明确记录该入口：它可以证明对应生产效果，但不能冒称已验证仍被验收门阻止的常规 `serve` live 启动路径。保留这一差异，不能为取得通过数而放开 live 门。

验证工程师维护方法和用例；Watcher 按方法在目标 head 上执行。GitHub 外部写入按沙箱执行授权进行。工程师的本地报告不能替 Watcher 伪造 review 或 App check；CoS 也不代填未运行结果。

## 5. 可操作的配置验证表

以下表格交给现有 CoS 协调填写。`用户已说明` 是角色事实；`待读回/待验收` 是配置或运行证据。每行补证据位置、读取时间、责任角色和结论，不重复索要原角色指令。

| 项 | 读取/验证动作 | 通过条件与当前状态 |
|---|---|---|
| 云电脑身份 | 在各角色实际执行环境运行 `gh auth status`；用 `gh api user --jq '{login,id,type}'` 读回主体。只保留脱敏结果，不记录令牌 | 用户已说明共享登录为 `Rubebun-Jadeem`；各角色实际凭证覆盖情况待读回 |
| 角色配置 | 读取现有平台上验证工程师、Watcher、Merger、Order、CoS 的 routine 配置及版本 | 分工与 §1 一致；运行记录能定位到具体角色。当前以用户已给分工为输入，配置读回待归档 |
| 技能版本与旧覆盖 | 读取目标 head 上原技能、feature 索引和工程师 PR；把旧用例与新增用例分开计数 | 已有 PR 作为基础；#386 的 31/31 不进入 bridge 通过数 |
| Review 主体与 head | 对样本 PR 读取 `pulls/{n}/reviews`，保留 `user.id`、`state`、`commit_id`；与实时 `pulls/{n}` 的 `head.sha` 对照 | approve 属于当前 head 且满足现行规则；角色标签不能替代主体或作者分离检查。待样本证据 |
| 检查生产者 | 读取实时提交的 check suites/check runs，记录 `app.id`、`name`、`head_sha`、`external_id`、status/conclusion | App B `osstack/verify` 与 App C `grok/verify-osstack` 分别按阶段规格核对；同名个人流程不是生产者证据。待读回 |
| 顺序与依赖 | 对照已给出的 `merge-after:#N`/`merge-after:N`、description/comment 信任、同仓库/限定跨仓库引用及 `MERGED`+base `main` 条件，读取 Order/Merger 配置和样本 PR | 规则已提供；实际配置落实、环/缺失/闭未合跳组与同组只报告一次的记录待读回 |
| 合并条件 | 只读核对当前 rulesets、旧式分支保护、required checks、批准、未解决线程及最后推送限制；对照 Merger routine | GitHub 实际合并条件成立；没有把 Watcher approve 或 Order label 当作无条件合并许可。待配置证据 |
| 事件与恢复 | 对照 Watcher 工作日 09:00–18:30 半小时、Order 每 15 分钟、Merger 工作日 08:00–19:30 半小时及各自事件范围，读取实际调度、游标、串行和去重配置；验证漏事件和重启补扫 | 触发规则已提供；部署配置、平台时区和运行能力待证据。GitHub 是最终事实源；Webhook 可选 |
| App C/D 迁移 | 按阶段 6 §3/§9 读回 installation、权限、bot 数字 id 和实际写入结果 | 个人 User 登录流程不等于 App C/D 已迁移；身份与主仓库安装状态均以新证据为准，目前待证据 |
| 执行隔离与密钥 | 检查 PR 代码运行环境、凭证注入边界、超时、日志脱敏和失败撤回路径 | PR 代码环境不持有 App 私钥/令牌；阶段 6 U-1–U-11 与 V 用例有实测记录。目前待证据 |
| Mac mini 运行安装 | 核对安装版本、声明的 serving home、scratch、日志和停止/恢复记录；不从开发 checkout 打开正式 DB | 只运行 osstack 一侧；目录存在或本地测试通过都不等于已部署/已开 live。安装记录待归档 |

这里的 GitHub REST 路径用于只读核对，不是配置变更命令。设置、安装、权限和正式启动的变更，继续由对应所有者处理并保留读回证据。

## 6. Mac mini 的职责边界

本次约定的本地运行根为 `/Volumes/AIMATE_WORK/osstackgrokbot`。它承载 osstack 安装、正式/沙箱运行状态、日志及 scratch。`config/production/bridge` 与 `config/sandbox/bridge` 是配置准备位置；实际服务声明的 `OSSTACK_HOME/bridge` 如何绑定，由安装记录明确。不能因准备目录存在就宣称配置已被服务加载。

Mac mini 负责 osstack 守护进程、签名授权校验、本地账本与回执对账、受控 Mission/Codex/Docker 执行、App A/B 发布效果，以及经批准的影子观察。每种环境使用独立 home；密钥留在规定的私有位置；启动、停机和恢复使用已安装运行时。

现有云平台继续运行验证工程师、Watcher、Merger、Order 和 CoS。Mac mini 不复制这些 Bot，不替换云电脑的 UI/CLI 验证，也不因部署 osstack 而取得现有 Merger 的合并权。App E 仍依其独立设计和运行许可处理；本文不把影子评估改成自动合并。

## 7. 阶段 6 的证据门

当前可接续的是现有个人账号流程和原验证技能。阶段 6 仍需证明：App C/D 真实身份与权限、平台可用的事件与持久状态、隔离验证、逐 head 检查合同、失败撤回、沙箱 V 用例、规则绑定和运行条件。已有个人账号 approve/merge 历史不能替代这些证据。

App review 是否计入批准、由谁给出计入的批准，以及规则与身份迁移顺序，继续按阶段 6 规格与 ADR 处理；不得从“Watcher 目前负责 approve”推导为“App D 的 approve 已满足保护规则”。当前个人流程与未来 App 合同并列记录，迁移完成后再按证据更新登记。

CoS 汇总 §5 表格，验证工程师提交原技能的增量 PR，Watcher 提供目标 head 的运行证据，运营者与仓库管理员补 App/规则的实际读回。只有相应验收门通过后才更新“已迁移/已上线”状态；本文本身没有完成阶段 5-G、阶段 6 或生产启动。

最新补充：Reviewer 暂停且没有正式 `CHANGES_REQUESTED` 证据，意味着当前主循环未提供已证明的同 PR 修订触发来源。已准备[独立 App D Reviewer 例程草案](bridge-reviewer-routine-draft.md)，初始只登记沙箱、暂停且为 COMMENT-only；它没有被发送或启用，不能用共享 `Rubebun-Jadeem` 的另一个例程替代独立 App D。
