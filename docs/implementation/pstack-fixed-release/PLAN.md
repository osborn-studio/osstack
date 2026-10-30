# pstack 0.15.36：固定范围，交付可以直接使用的 OSStack 能力

决策时间：2026-10-30（上海）。目标是让用户在指定仓库实际使用固定的方法与工具，随后逐步补齐强制执行接线；不是等待整个 Firstmate 联合运行时完成。Firstmate 深运行仍禁止。本文是执行方案，未勾选的验收不是已完成结果。

## 1. 版本边界已经可以确定

采用基线为 `cursor/plugins` 的 pstack **0.15.36**：

- commit：`c742dd61706fbacc1b95f1a20b7b988cf096ce6c`
- subdir：`pstack`
- tree：`4719e1c4b4c43bac85d4206a8b41dd2899769c1c`
- `plugin.json` 已实际读取并确认版本；573 个 Git blob 路径，合计 6,295,660 字节。这不是能力数量。
- 与此前观察的 `4dd1d05818d19792e7cd6e818f1667f95f7e1dbe:pstack` 完全同树。
- 保留 Lauren Tan / poteto、MIT、原始文件摘要及 OSStack 改写来源。
- 原研究 0.15.32 / `99b609a7`、原 24 PS / 19 W / 48 A 及历史结果保留，不改写成新版本成绩。

完整目录及归档摘要见 `source-lock.json`。该锁是采用计划的来源证据，`active:false`，不是安装或运行许可。版本号方便阅读，真正重放绑定 commit + subdir + tree + 文件摘要；不跟随 main，不自动吸收 0.15.37 或之后的更新。更新只生成另一个候选，必须给差异、影响范围和回归结果。旧任务继续用旧 pin，不能执行到一半换材料。

首版清单必须同时列明“采用并可用 / 采用候选 / 仍未实现 / 不采用宿主专有实现”。冻结源码范围不代表 573 个文件已经全部集成；首批可用也不注销原剩余义务。

## 2. 当前究竟卡在哪里

| 层 | 已有可复用内容 | 距直接使用的具体缺口 | 本轮停止线 |
| --- | --- | --- | --- |
| 固定来源 | `inspectGitSource` 能从固定 Git 对象读取、检查许可和摘要 | 旧镜像为 partial store；整个新版子树 573 路径超过读取器 512 上限；旧 manifest 不保存 subdir，未知字段被丢弃；本轮修复候选已支持登记，消费者与采用闭包尚未接线 | 有可重放来源锁、准确的组件采用清单、候选不自动激活；不重建第二 registry |
| 方法包 | OSStack 四入口、14 个独立改写的方法及双宿主导出/有界读取 | 现包仍来自旧研究 pin；不能把新 lock 放旁边便称 .36 适配完成；目标项目安装/发现和来源关联尚未一次性跑通 | 一个固定版本、一个项目局部包、一个支持宿主可实际发现或显式调用，缺引用拒绝 |
| 验证工具 | 固定五例驱动、地图维护、证据投影、PR/栈只读核对、W18 材料读取 | W19 健康查询尚在候选；这些工具仍需调用者拼接，不能自动解释为任意项目验证 | 完成本次有界 W19，不新增后台 watcher、自动修复平台或新地图体系 |
| 方法编译 | `MethodRecipe` / `MethodProposal` / `CheckRegistry` / 摘要合同 | 形状已有，生产 recipe→proposal 编译与 repo 主检查选择尚未接通 | 只做 bug_fix 一种 recipe；输出可审阅且不可执行的 proposal |
| 实际调用 | 已有 `deliver --autonomy guarded-local`、合同、adapter、execution-context、候选验证收据 | 没有现成 `--method bug-fix`；mandatory 方法材料、角色分配、调用前摘要/预算核对未连成一个入口 | 复用既有 deliver；先一个 host / 一个真实任务，不另建调度器 |
| 可信结果 | 已有候选、检查与路径约束 | 尚未证明一个任务从固定方法选择走到实际修复、独立检查和最终状态 | 一次真实 RED→修复→GREEN，合法控制通过、最终候选一致、原失败保留 |
| formal / statechart | .36 上游工具已经存在；OSStack 尚未采用执行链 | TS runtime、TLC/Java、输入/输出/取消边界、代码回放、项目局部验证技能尚未接线 | 独立能力包验收一条代码不变量；不作为首个普通 bugfix 的前置 |

本次已实际建立无 filter 的固定 commit Git store，消除 partial store 限制。现有检查器对完整 pstack 返回 `RESOURCE_LIMIT`；对 `pstack/skills/statechart` + MIT 许可成功读取 408 成员、返回 `source_inspection`。后者只证明来源读取，不证明依赖闭包、执行或正式采用。最初错误 Git binary 的 INVALID_INPUT 与随后 PARTIAL_STORE 原件均保留。

## 3. 三个可独立交付的用户结果

### U1：固定方法包能够用于当前工作

用户在一个目标项目中得到固定的 OSStack 方法入口、来源说明和最短教程，能明确要求代理按 bug-fix 方法完成真实任务。首次支持一个可用宿主；另一宿主独立验证后加入，不用双宿主比较挡住首用。

验收：包可导出到全新项目局部目录；每个必要引用完整且摘要匹配；实际宿主找到或显式读取 mode / bug-fix / evidence，能跑项目自己的复现和检查。无法自动发现时明确“显式读取可用”，不冒称原生 slash 注册。不得复制上游默认模型、Cursor 专用 Task/Project 或自动合并授权来替代 OSStack 配置。

这可以早于正式联合资格使用，记录为普通授权下的 assisted 使用；不能据此签发 trial/qualified 或关闭 W08。

### U2：一个任务经 OSStack 完成完整 bugfix

用户给出仓库、问题和验收条件；OSStack 从固定方法包选择材料，生成限定路径/命令/预算的 proposal，沿现有合同和 host 执行，得到补丁、原失败、最终检查和结果。最终用户不用再手工安排“读哪几份材料、谁复现、谁验证、哪份候选有效”。

计划的单一 method 入口名称在实现时冻结；**目前没有可直接执行的 `osstack method bug-fix` 命令**。现有 `deliver` 可以复用，不能把在聊天中手工传方法写成已完成强制集成。

完整验收为：一个当前真实缺陷可复现 → OSStack 实际调用 builder 编写回归并得到行为 RED → 最小补丁 → 同一检查 GREEN + 合法控制不退化 → 独立验证实际最终候选 → 输出有边界的 local_verified/failed/blocked/unknown。缺材料、版本漂移、未注册检查在模型调用前拒绝。取消或不明结果不自动重试。不重跑已关闭 1038/4611/currentpacket 来把历史失败翻绿。

### U3：形式化验证与 statechart 在 OSStack 内可重复使用

组合采用 `.36` 的 create-formal-verification、statechart、maintain-formal-verification。用户说出一条代码承诺，代理从真实代码建模，运行 TLC，报告违反规则的最短路径，并生成 Mermaid；需要图像时再渲染。

验收至少包含：当前模型结果；一个真实代码坏变体使不变量失败；反例按动作在真实代码上回放；还原后回到原结果；未检查规则明确 unknown。图画得好看不证明代码正确；模型通过只覆盖声明范围。

## 4. 下一步的有序实施单元

| 单元 | 具体改动与复用点 | 验收与交付物 | 依赖 / owner |
| --- | --- | --- | --- |
| P0 来源冻结（本轮） | 固定 .36 commit/tree/许可/完整文件清单；新完整 Git store；保留原研究 pin；来源检查器实际探针 | `source-lock.json` + 完整归档 hash + `SOURCE-PROBE.md`；无运行激活 | 无；root |
| P1 来源登记兼容 | 在现有 `packages/skill-registry/src/manifest.ts` 原位添加 subdir 默认 `.`、独立 package_version；严格拒绝未知字段与非法路径，旧合法 manifest 仍可读 | 同测试 RED/GREEN；read/write 往返保留 `pstack` 与 `0.15.36`，版本和 commit 不互相替代；不启 watcher/网络/自动晋升 | P0；作者 + 独立验证 |
| P2 采用闭包 | 复用 `source-snapshot.ts`，新增显式采用组件/引用清单；分别检查每组件，同 commit 汇总；新增引用必须显式处理；完整归档与执行采用集合分开 | 缺文件/越界/symlink/超预算拒绝；移动 HEAD 不改变输入；candidate-only；依赖闭包清楚标出宿主服务/外部工具 | P1；来源作者 |
| P3 首用方法包 | 对照 .36 更新首批 bugfix 路由/调查/回归/评审/证据材料，沿 `scripts/lib/osstack-method-export.mjs` 导出；保持 OSStack 控制权 | 新目录导出与安装回读；完整引用/摘要/许可证；一个实际 host 的新任务使用证据；仍未验证的宿主不升级 | P2；材料作者 + root |
| P4 单方法纯编译 | 复用 protocol 的 MethodRecipe/Proposal/CheckRegistry，实现 bug_fix 编译器；绑定目标 repo 的注册复现/主检查与材料 | 同输入同 proposal；`executable:false`；未知 check/缺 required feature 拒绝；观察/假设分开；提供真实 proposal | P2、现有 W17/W18 使用依据；编译作者 |
| P5 执行接线 | 在既有 deliver / execution-context-host / delivery-contract-host 接入固定材料、角色、路径与预算；lazy CLI 调用 | adapter 真正收到完整材料；invoke 前版本/权限/预算检查；缺材料 invoke=0；默认旧路径兼容 | P3/P4；host 作者 |
| P6 首个真实完整任务 | 新缺陷、新独立 freeze/输入/预算，实际 host 修复，复用 verifier 与候选收据 | U2 全链证据；独立审查；用户可重放的教程；不自动 merge/release | P5；root 单执行队列 + 独立验证 |
| F1 formal 工具采用 | 精确采用 .36 三技能及 statechart 脚本，薄 OSStack wrapper；TLC/Java/runtime 单独固定，不改写编译器 | doctor 显示缺依赖；干净 scratch 可生成 report/mmd；错误/取消/输出冲突不覆盖现有成果 | P0/P2；独立 formal lane |
| F2 formal 项目试点 | 选 pstack 集成代码中的高后果不变量，先核真实原子边界，再坏变体和代码回放；保留本地 verify skill | U3 验收和覆盖记录；再次运行成功；维护时变更触发重新核对 | F1；formal 作者 + 独立验证 |

P1/P2 与 W19 发布收口可以并行，因为没有执行依赖。P3/P4 可在采用集合冻结后并行。P5/P6 顺序执行。F1 的来源和依赖准备可并行，实际模型检验预算另列，不挤占 root 的 full 队列。最多三个本地子代理，root 独占中央账本/PR/full；用户审批合并。

P2 不直接放大所有全局资源限制。首选单一版本下显式组件采用，再汇总来源关系；如果完整子树读取确有必要，新增经过测试的有界策略，不能截取前512文件后称完整。

## 5. statechart 的真实依赖和边界

源码入口为 `pstack/skills/statechart/scripts/statechart`。支持 Node 22.18–22.x 或 23.6+，也有 Bun/Deno 路径；OSStack 首期只验证一个运行时。TLC 为 1.7.4，jar SHA-256 为 `936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88`。上游默认通过 mise 准备 Java Temurin25，也允许显式 JAVA/TLA2TOOLS（Java11+）。OSStack doctor 应先显示依赖与网络需要，首次准备与每次模型执行分开，不在普通任务里隐式安装。

模型检查使用 TLC；TypeScript 管线解析结果、转换中间表示并生成 report / Mermaid。整图默认最多500状态；超过预算可能只画反例路径，若无违反规则则不生成 chart.mmd。再次检查未处理规则时存在100,000状态上限；未检查不是通过。视图模块会执行代码，必须在任务授权与进程预算内，不当成纯JSON。

图像层可按上游固定 `pele@1.9.0`，采用本地渲染；不把用户源码上传到网站。样式属于展示层，先完成模型结果与代码回放，蓝图/手绘等主题不成为首用门槛。用户附图是上游能力参考，不是 OSStack 已验证的进程隔离或原子发布证明。

## 6. W19 为什么现在收口，以及不再扩展什么

它回答“最近一次失败是什么、上次成功是什么、版本或相关文件是否改变、谁负责”，防止旧成功盖住新失败。当前范围限于固定五例留存记录；健康查询不执行任务、不定时、不通知、不签资格。已完成真实工具故障→修复→新执行的有限观察；已补强严格hash类型、矛盾map-after与诊断保留，并修复CLI符号链接入口与失败分类优先级（分类由合成封存证据验证，不是新实际产品故障实验）。

P1登记已随PR312 Ready候选实现；P2显式11组件闭包与P3五份材料/两种局部导出已形成候选，真实host使用未验；接下来实施P4/P5/P6，不新增长期运行/全局资源监控/跨机器恢复/多模型排名/全方法维护。原 A39 的接口冻结前因果条件及全 W17/W18/W19 仍按原标准保留；新接口必须在冻结前完成自己的调用原型，不能用后验教程冒充。

## 7. 现成工具的使用方式

现在这些是仓库中已实现的工具，需对应构建和显式目录；不是所有都已打包为已安装 osstack 的统一命令。首用发布必须把它们的安装/构建要求写清并验证，不能把“在源码目录能跑”当任意机器开箱可用。

- `pnpm export:methods --host codex --output <全新绝对目录> --dry-run`：检查导出；实际导出移除 dry-run。Claude 布局另有 host 参数。
- `node scripts/read-method-material.mjs --file <绝对文件> --start 1 --lines 60`：分页读材料，后页按输出 continuation/hash 读取到EOF。
- `node scripts/method-feature-map.mjs --index docs/verification/features/index.json --query maintenance --limit 1`：读取相关说明，不执行验证。
- `node scripts/method-verification-journey.mjs --output <全新输出目录> --scope full`：固定五例实际验证。
- `node scripts/maintain-skills-check-map.mjs --map <绝对地图> --output <全新目录>`：实际驱动并对照地图。
- `node scripts/project-method-journey-evidence.mjs --input <旅程目录> --output <新packet目录> --scope full`，再 `--check <packet目录>`：投影和检查。
- W19 候选：`node scripts/method-control-health.mjs --config <绝对配置> --as-of <UTC时间>`；exit0只代表报告生成。

这些是语法示意，尖括号不可原样执行。真实执行必须用显式 OSSTACK_HOME 与 scratch，不能从开发 checkout 触及默认服务数据库。

## 8. 完成定义与状态统计

用户看到三个单独状态：固定方法包可用（U1）、OSStack bugfix完整链可用（U2）、formal/statechart可用（U3）。每项有具体入口、支持环境、演示任务、失败恢复、可重放记录和已知限制。批准某一项不等于批准全部原24PS或32J。

已有 guarded-local 普通使用不需伪造正式 MethodBinding/TrialPermit；若采用正式 trial 路线，当前 `adapter_invocations_unattested` 等真实门槛必须实现，不得删除校验或伪造身份。普通使用、正式资格和用户验收分别记录。

上游新版本、Firstmate 深运行、通用生产率基准、双宿主全部方法等价、持续watcher、自动merge/release均不追加为 U1 首用条件。原有未完成范围仍在独立欠账中。每次报告优先写“用户现在能做什么、下一条还缺哪段代码”，不以PR数/卡数或测试总数代替完成。

## 9. 本轮实际推进与下一交付停止线

P0固定来源检查已执行；P1作者两文件实现已完成并进入本批候选，root补齐CLI测试夹具中的解析默认字段：作者同52测试旧43失败→新全通过，独立同47向量旧45失败→新全通过，目标类型检查通过；整合类型检查首次旧CLI mock缺字段失败，修复mock后全仓类型检查通过。组合全仓e82adca9为22包7304pass/5skip/0fail，199脚本定向通过；原失败保留。它只保留来源登记，不是安装采用。W19与P1合入同一交付批次，共用root全仓队列；独立来源和测试原件分别保留。

P2/P3本批已有固定commit的11组件显式闭包、五份采用材料和两种全新项目局部导出；实际host首次任务仍未做。下一实施直接做P4纯编译与P5既有deliver调用接线，再P6当前真实缺陷同卡收据；不要重复范围分析或扩大维护平台。W19不再扩成新的健康平台。statechart来源已成功检查，TLC/Java实际执行尚未做，按F1/F2独立交付。

全部24PS与固定版本61个SKILL候选路径见 [CAPABILITY-ADOPTION.md](CAPABILITY-ADOPTION.md)。用户最新指定Loop Engineering与看板为优先入口，接线核对见 [LOOP-AND-BOARD-FIRST.md](LOOP-AND-BOARD-FIRST.md)：沿现有任务队列/Loop/候选验证/看板记录承载方法能力，不另建调度权威。具体生产插入点须用调用原型验证，不能把现有辅助脚本称统一入口已完成。
