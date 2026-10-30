# 固定 pstack 方法的首次实际 Loop 调用：已到模型，测试环境阻塞

本次把 pstack **0.15.36 / c742dd61706fbacc1b95f1a20b7b988cf096ce6c** 的固定材料实际送入已有 OSStack Loop 和 Codex CLI，使用当前真实卡 `joint-firstmate-pstack/card_ebb91eda`。结果是 **blocked before native reproduction**；没有补丁，没有 GREEN，不是 U2 或 `local_verified`。原尝试只执行一次，后续接线修复不改变这个成绩。

## 用户现在距离直接使用还差哪段

材料采用、纯编译、完整材料调用前核验和持久收据已有候选；本次证明 32,286 字节 builder 材料进入 36,134 字节实际调用 prompt，并出现原生 turn 与工具调用。仍缺的是在正确的项目与临时目录权限内完成一个真实修复，然后独立核验最终候选、把收据回到同卡。普通 CLI `deliver` 还默认使用只读 Codex；其适配器缺少用于 V2 最终收据的 reported runtime identity。因此本次明确用现有 `LoopEngine`、`createHostExecutionContext`、`CodexCliAdapter` 的显式 assisted U1 调用，不删除 V2 校验，不声称统一 CLI 的端到端交付已完成。

## 实际任务与失败

目标仅 `packages/github/src/delivery.test.ts`：现有变异测试在 Node 26.5.0 因 `stripTypeScriptTypes` 的 transform 模式报错，同一测试在 Node 22.22.1 通过。root 新基线分别为 1 fail / 1 pass，其余 64 为名称筛选未执行。模型须自己先复现，再最小修复，最后运行双版本整文件检查；不得跳过断言或修改生产安全逻辑。

实际模型执行第一条冻结复现命令时，Vitest setup 在统一 scratch 根创建目录被 macOS sandbox 拒绝（EPERM），**零测试执行**。它随后分别读取 scratch setup 与 scratch API 源码，报告阻塞并停止，没有修改文件。原生 exit 0 / turn.completed 仅表示模型完成回复；Loop 的实际检查得到 Node22 成功、Node26 失败及目标补丁缺失，最终为 `escalated` / no-progress，未误记任务完成。9,133 个 tracked 文件前后摘要一致；运行前已有四份 fresh knowledge/dist，不归模型产物，也不称 clean committed tree。

## 本批只修实际遇到的宿主接点

新增 `CodexCliAdapter` 可选 `writableRoots`，供调用者向宿主显式请求加入可写目录。仅非空且 sandbox 为 `workspace-write` 时有效；去重前最多八项绝对、现存目录，拒绝根目录、非法路径和文件，canonical 去重并复制调用者数组。invoke、startSession、resumeSession 均通过独立 `--add-dir` 参数传递，resume 的父参数顺序保留。默认 argv 和只读策略不变，availability probe 不带写权限，不从 OSSTACK_SCRATCH_ROOT 或其他环境变量自动扩大授权。

该配置按本机 Codex CLI help 声明的接口拼接参数；参数传递测试不是实际 CLI 接受或 OS 隔离证明。本机 `codex exec --help` 确认支持 `--add-dir`；额外无模型 sandbox 控制因新版命令要求 permissions profile，而配置无该表，在命令执行前拒绝，原件保留。未用这些拒绝宣称目录授权已执行成功，未重跑原模型任务来翻绿。

目录校验只在 constructor 发生；之后 invoke/turn/resume 重用该 canonical 字符串，不再次核验目录，不能防路径置换。数组八项限制在去重前执行；只拒文件系统根目录，不自动拒绝 HOME、CODEX_HOME、仓库或其祖先，所以“任务专用”是调用方责任。每任务创建独立 adapter，不能把带额外目录的实例注册为其他任务共享的 adapter；恢复会话的权限是否继承仍待真实 CLI 验证。

后续调用应在统一 scratch 根下面创建**本任务专用**根，再同时显式设置 adapter 的 `writableRoots:[taskScratch]` 与子环境 `OSSTACK_SCRATCH_ROOT:taskScratch`。不要授予整个历史归档根；先验证安装版本的权限行为。记录匹配 build、全部输入、权限与预算，再开展下一项真正的新需求。原 Node26 缺陷仍未修，不换名重放本 packet。完成定义仍是实际 RED → 修复 → GREEN → 独立最终候选 → 同卡证据；不能把目录参数修复当成这条链已完成。

## 证据与限制

- 一个 native invocation，600 秒预算，`sources:[]`、单 task、maxIterations=1、`useWorktree:false`；root 自有隔离工作树。避免普通 Loop 的自动 worktree 成功合并路径。
- 两份持久 execution-context 收据，边界为 AgentTask prompt；并非 provider wire、模型理解、原生 slash 发现或模型身份认证。
- 原生工具只运行冻结复现命令与两次单独 source read；提示词命令限制不是 OS 命令围栏。认证/环境继承，未声称独立 principal；全后代终止未认证。
- 看板 native `task_id` 与 `tenant_id` 均为 null；body 显式绑定本 task，使用人工同卡回链，不冒称自动 DB task 外键或自动投影。
- 实际构建入口使用当次已核 hash 的 CLI chunk，尚非稳定 npm 子路径。方法包是项目局部产物；原 helper 把包写到 workspace 外的首次请求拒绝，改为合法项目局部位置后准备成功，不是产品失败。
- 12 项通用准则与 8 项 Node26 准则预冻；新增 writableRoots 独立准则另冻。保持原 FAILED/LIMITED、原24PS/19W/48A与32J正式状态不变。Firstmate 深运行禁止。

## 本批候选验证

代码与 changeset 提交 `1438f3c5ec6775befe4be22d6074ca204b27ae8a`：fresh build、22包完整回归 **7448 passed / 5 skipped / 0 failed**、typecheck、TS lint、inventory、changeset coverage通过；启动中位数 version47ms/help114ms。作者同新增测试旧19fail/17pass→新36pass，中间漏接invoke的1fail与类型检查错误保留；独立同27控制旧9pass/18未满足新增能力→新27pass，旧结果不能说成18个既有产品缺陷。

完整回归开始时有四份 fresh knowledge/dist 和未跟踪本次文档/材料包；9,134 tracked清单中，期间root更新了9个文档文件，所有tracked产品/脚本 bytes不变。不是clean committed tree，也不声称全部tracked字节不变。完整清单见原始证据。root首次inventory使用不存在的脚本名退出1，正确现有generator退出0，两者保留，不当产品失败。

实际 tool-less Sonnet5.5 **PASS_WITH_CONCERNS**，无确认代码blocker；采纳实例共享范围、构造时快照、八项限额在去重前等措辞修订。完整输入/响应/用量与逐条处置保留。该静态审计未看到后来full结果，不声称其认证测试或真实宿主效果。独立公共API探针另核源码与fresh dist对应；没有重复native调用。

原P6失败、adapter候选验证、PR314旧CI分开记录。PR312→313→314→本批按人类合并及actual-main重验顺序；本批将发布Draft，不合feature base，不自动批准、合并或发布。归档与最终出版记录位于本目录evidence/publication。


## 原始证据归档

[原始归档](evidence/raw-verification.tar.gz) SHA256 `1b1146ff92916ea675d26c53b56560a032694984f541a984418f3a9a1571c098`；[逐成员清单](evidence/raw-manifest.json) SHA256 `f0ef2d26521a0faa3b4143319d7002ca72298ae68ee5871e893f90364db97191`。共419成员：311文件、102目录、6symlink，文件payload11,968,136bytes。root逐type/mode/size/hash/target核验，不解引用测试symlink。原source/baseline/freeze/native完整JSONL、两持久receipt、失败控制、作者RED与中间错误、独立旧新、full原log及Sonnet完整输入/响应均在内。原目录冻结；后续出版/清理另存publication。

PR314完整原CI另见[ci-final](../pstack-method-bridge/ci-final/README.md)。没有下载或重新hash远程artifact。当前main与候选发布栈分别记录，不能把这份修复的local full当作314或新PR的远程CI。

独立逐成员核验同样通过，见[包外独立收据](publication/independent-archive/receipt.json)，SHA256 `fb2777c9cfc11b7e536c1c33797e6f742e450904ff0a72dc82646d680a7f30c7`；另核三个源码Git、三个完整审计输入及实际prompt/两收据。该核验不运行产品或模型。

发布：PR315 https://github.com/osborn-studio/osstack/pull/315，head08342874b1ffdbdf447f38d5221ffbb9aed8eeda，Draft/base codex/pstack-method-bridge-delivery，CI41048799532运行。312→313→314→315依序人类merge、actual-main核验/retarget/适用重验；不要合featurebase。最终publication241docs/1hygiene通过；四fresh dist与保存bytes/hash/patch一致后才恢复。原P6仍BLOCKED。
