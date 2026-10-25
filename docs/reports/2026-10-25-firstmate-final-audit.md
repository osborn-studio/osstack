# PR #244 最终审计与交付边界

核对日期：2026-10-25（Asia/Shanghai）。[PR #244](https://github.com/osborn-studio/osstack/pull/244) 的 base 为 `codex/firstmate-extension-integration`，不是 main。前序 PR 栈必须一并处理，才能交付到 main。Ready 只表示 PR 退出草稿状态，不表示已合并、已发布或已部署。

## 修改结果

- Loop 在执行前写入并同步持久化宿主隔离记录。停止未知、崩溃或状态写入失败时保留记录。重启不能仅换一个状态文件就重新执行。
- 隔离记录使用真实规范路径。已在实际 macOS SSD 验证大小写别名。宿主目录必须位于主工作区和实际候选工作树之外。
- 验证器检查可用性探测和执行前后的候选内容。检查原始文件、索引和 Git 元数据，不靠规范化 diff 判断完整性。拒绝未经显式提供的隐藏索引改动。
- 来源读取使用有界等待与槽位。取消和 busy 不写来源状态。其他未知结果保留明确的恢复限制。
- 默认 DeepSeek 审计报告写入受管 scratch 目录。成功结果保留完整报告路径。验证任务不能通过上下文字段覆盖输出路径。
- 受管安装和启动共享 home 检查。升级、远程取消与对外投递继续使用精确授权和持久回执。
- 更新中英文 README 和命令手册。新增 prompt 写作约定，借鉴 ASD-STE100。命令名、参数名和状态值保持原样。

## 审计证据的读法

本次实际调用 Claude Code CLI，参数为 `--model claude-haiku-5-5`。调用返回非零 usage。CLI 同时输出 `unrecognized_model` 警告；原始记录保留该警告。这证明调用和结果存在，不构成底层模型权重的独立证明。

审计按代码范围分组。发现问题后，先修复，再提交相应源码、测试证据和旧意见做复审。小范围 PASS 只关闭对应问题，不能单独代表整个 PR 通过。工具权限关闭的静态审计没有运行测试；测试由宿主独立执行。

| 范围 | 复审链与证据 | 解释 |
|---|---|---|
| 来源与升级 | [A 最后修订](2026-10-25-pr244-final-audit-evidence/reaudit-A-upgrade-final-A-result.json)、[升级代码](2026-10-25-pr244-final-audit-evidence/reaudit-A-upgrade-final3-upgrade-result.json)、[升级证据修订](2026-10-25-pr244-final-audit-evidence/reaudit-A-upgrade-final4-upgrade-result.json) | 后续来源 delta 另由 F2 覆盖。 |
| 投递、远程取消与授权 | [B1 最终复审](2026-10-25-pr244-final-audit-evidence/reaudit-B1-final-result.json) | 未知结果不自动重发。 |
| Graph | [B2 r10](2026-10-25-pr244-final-audit-evidence/reaudit-B2-r10-result.json)、[B2 r11](2026-10-25-pr244-final-audit-evidence/reaudit-B2-r11-result.json) | r10 关闭代码问题；r11 关闭两项文档问题。 |
| 来源并发与取消 | [F2 r3](2026-10-25-pr244-final-audit-evidence/parent-F2-r3-reaudit-result.json) | 66 项定向测试通过，包含 daemon 接口。 |
| 宿主隔离 | [F1 closure](2026-10-25-pr244-final-audit-evidence/reaudit-parent-F1-closure-result.json)、[最终证据](2026-10-25-pr244-final-audit-evidence/F1-final-evidence-hashes.json) | PASS_SCOPED；49 项定向测试通过。大小写输入、全仓操作指导和 lint 配置证据已补齐。 |
| 数据库迁移登记 | [Migration 46](2026-10-25-pr244-final-audit-evidence/migration-registration-reaudit-result.json) | PASS_SCOPED；检查新增 import、顺序和事务执行接口。 |
| 命令与语言约定 | [文档 r3](2026-10-25-pr244-final-audit-evidence/readme-haiku-language-r3-result.json) | PASS_SCOPED；明确已有参数，不宣称 STE 运行时校验。 |
| 默认报告输出 | [输出路径复审](2026-10-25-pr244-final-audit-evidence/cli-default-output-r2-reaudit-result.json) | PASS_SCOPED；失败报告路径展示等建议不是当前阻断。 |
| 启动与安装 home | [文档及 guard 修订](2026-10-25-pr244-final-audit-evidence/readme-haiku-r5-result.json) | 两个 guard 使用相同 home，tilde 由已有逻辑展开。 |

验证器 F3 的代码问题由 [r9](2026-10-25-pr244-final-audit-evidence/reaudit-F3-r9-result.json) 关闭；剩余证据由 [r10](2026-10-25-pr244-final-audit-evidence/reaudit-F3-r10-result.json) 复审为 PASS_SCOPED。最终生产源码为 `97c68e4396248664eda5df4b803745b668615dbd`；后续 `49fee8e3` 修复随机篡改测试，`b2329ccd` 固定测试 Git 提交身份；两项均未改生产代码。定向回归包括 80 项验证器测试、9 项真实提交路径测试、61 项引擎与隔离测试，以及 124 项 CLI/daemon 测试；各组范围与版本绑定见对应 manifest。最终全量测试和当前 HEAD 的 CI 是独立条件；最新结果、源码提交和计数由 [PR 正文及检查页](https://github.com/osborn-studio/osstack/pull/244) 记录。旧失败与历史通过记录都保留，不计作最新版本通过。

完整验收曾发现 worker cursor 测试随机失败：把首字符改为 `x` 有 1/64 概率没有改变令牌。测试现翻转认证标签的一位，并断言令牌确实变化。32 项测试连续三轮通过，[独立复审](2026-10-25-pr244-final-audit-evidence/worker-cursor-fix-reaudit-result.json) 为 PASS_SCOPED。原始失败未保存令牌值；旧表达式允许不变的缺陷由代码证明，不能还原该次令牌。没有修改生产鉴权或放宽断言。

干净 CI 随后发现路径预算测试的 `git commit` 依赖可用的作者身份。修复仅给该次测试提交传入明确的姓名和邮箱。禁用自动推断身份的严格环境下，修复前失败、修复后目标测试通过；[独立复审](2026-10-25-pr244-final-audit-evidence/git-identity-fix-reaudit-result.json) 为 PASS_SCOPED。完整本地验收和 CI 另行重跑，目标测试不冒充全套通过。

原始审计结果、调用记录和源码摘要见[证据清单](2026-10-25-pr244-final-audit-evidence/manifest.json)。完整源码输入保存在本次工作 scratch 中，清单保存输入摘要。

## 真实环境资格与已知边界

| 场景 | 仍需验证的内容 |
|---|---|
| GitHub sandbox | 真实发送与查找、正文 CRLF/空白归一化、网络中断、权限变更。 |
| 跨机 SSH | 远端安装、固定 host key、两台机器的 generation、断网恢复。 |
| tmux/cmux | 固定版本、窗口与 socket、实际打开和关闭行为。 |
| launchd 多 home | 真实服务停止和启动、制品与运行版本、物理断电恢复。 |
| 模型运行 | 独立 holdout 数据、真实费用、provider 终止行为。静态审计不替代这些检查。 |
| 原生与跨平台 | 当前 CI 矩阵之外的 Bun 编译产物、系统与运行环境。 |

宿主、私钥和同 uid 进程属于受信任边界。这些机制不是恶意同 uid 代码的安全沙箱。正常适配器完成事件不证明所有后代进程已停止；候选前后观察也不是持续文件系统监控。已知未停止或完整性未知仍阻止后续效果。

### 验证器的明确适用范围

候选快照保护指定候选工作树及选定 Git 元数据。它不覆盖其他工作树中的普通文件，也不对完成后的每次文件写入做持续监控。只有可信适配器遵守完成契约时，前后检查才可用于后续提交。不能把这项机制表述成“任意审查进程永远不能批准自己的修改”。

正常完成事件不证明脱离的后代进程全部停止。已知异常、未结束流或完整性未知必须继续阻断；文档中的信任边界不能用于忽略这些信号。既有提交路径中的 `git status` 和 `git add -A` 仍可能执行仓库配置的 clean filter。关闭 ext-diff、textconv 或 fsmonitor 不会关闭所有 filter。仓库配置仍属于受信任执行环境。

未经显式提供的 review boundary 和 candidate freeze 拒绝 assume-unchanged / skip-worktree 项，因此 sparse checkout 也会被拒绝。宿主拥有的验证 Git helper 不读取全局或系统配置；其全局 ignore 和 safe.directory 设置不会自动继承。适配器内部的 Git 调用不属于此保证，例如 DeepSeek command 的 diff 仍使用进程环境。需要这些设置的仓库必须先符合受支持的宿主配置，不能通过放宽完整性检查继续。

本轮明确采用执行与验证角色分离。显式 `agentId` 不能同时是本次的 verifier。没有合格执行器时拒绝任务，不把它当成成功的空操作。静态配置拒绝可在效果开始前结束；已经调用动态可用性探测后的失败仍需保守保留，因为探测也可能启动外部效果。

Loop 的 Git 元数据快照不包含 `.git/objects`、reflog、`info/sparse-checkout` 或 Git include 文件。Loop 原始快照的 Git 子进程输出和索引可见性列表各有 64 MiB 上限；candidate helper 的其他 Git 调用仍有 1 MiB 上限。原始 tracked/untracked 文件流没有总字节或总项数上限，依靠期限拒绝超时。这不同于下方 Graph 的总量限制。未经配置的适配器运行 `git status` 可能刷新索引，从而被保守判为修改；真实适配器仍需资格验证。

验证器自身的前置拒绝也可能触发保守隔离，包括非法 base commit 或超范围 artifact。这里的“未知”表示宿主未完成效果与完整性的核对，不证明已经启动过子进程或仍有进程存活。索引可见性检查的 10 秒期限和 64 MiB 上限也会触发拒绝。Review boundary 的路径输出上限为 16,000,000 bytes；artifact 路径清单读取和其他 candidate Git 调用保留 1 MiB 上限。Artifact 清单使用完整 NUL 分隔输出，超限拒绝，不能把截断日志当成完整清单。

`enforceRoleSeparation` 参数为 API 兼容而保留；其值不再关闭角色分离。daemon 和会话调度器在 CLI 包内，使用同一测试隔离配置，没有另一个未隔离的 daemon 包。当前 CI 平台为 macOS 与 Linux。既有测试临时 socket 别名使用 `/tmp`；本 PR 不声明原生 Windows 测试支持。宿主隔离目录及祖先目录须支持读取和目录 fsync；权限或文件系统不满足要求时会拒绝启动。

普通 worktree 发布也拒绝隐藏索引项，包括 sparse checkout 的 skip-worktree 项。无法读取索引不证明索引干净，因此保留候选并报告可见性未知；不能清理工作树或自动重试。

执行前的隔离记录可能因规划、选择或创建工作树失败而保守保留。创建后的工作树也可能保留。保留不是任务成功或仍在运行的证明。规范路径标识不承诺跨挂载点改名后保持身份；不应通过迁移路径来清除未知状态。

隔离记录没有自动 reset。不能因状态文件没有标记就删除宿主记录。必须先调查原执行，保留证据。切换宿主 root 或工作区不构成安全重试证明。OS 层 fsync 成功不等于完成物理断电资格。

Graph 候选原始内容上限为 128 MiB / 10,000 entries；Git metadata 遍历上限为 256 MiB / 20,000 entries。实际仓库快照测量是指定文件规模的证据，不代表任意仓库的性能保证。

来源/日志读取最多占用 4 个槽位。超时操作未结束时继续占用槽位，可能需要正常重启。关闭 daemon 时不能强制关闭仍可能写入的数据库。

默认审计报告保留在 scratch 的 runtime 目录，供用户读取。操作者可使用既有 scratch 清理流程。默认输出测试也可能留下这些产物；它们不一定随测试 worker 自动删除。

## 命令与文档

- [中文命令手册](../guides/firstmate-commands.md)：区分 #244 新增命令、扩展参数与已有入口。
- [English command guide](../guides/firstmate-commands.en.md)：相同接口的英文说明。
- [Prompt 写作约定](../guides/prompt-language.md)：条件、操作、结果与固定术语。
- [neat 文档检查](2026-10-25-firstmate-readme-neat.md)：文档卫生证据，不是功能或部署验收。
- [24 项能力交付账本](2026-10-24-firstmate-capability-completion-ledger.md)：保留历史测试基线与外部资格列表。
