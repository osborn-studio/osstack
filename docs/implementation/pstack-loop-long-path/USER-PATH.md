# 从已完成首用到普通用户直接使用

现在已经走通一次真实 assisted U1：一张当前缺陷卡，固定 pstack 0.15.36 来源，准备 builder/reviewer/verifier 三份角色正文，由现有 Loop 与 host 将必需材料送入原生 Codex 的实际任务 prompt；模型留下真实 RED、修复、同入口 GREEN，host 执行注册检查，独立候选验收四向量通过，持久 receipt 留存并人工关联同一卡。三份材料准备不等于调用了三个模型，本轮没有实际 reviewer/verifier 模型调用；prompt 证据也不是 provider 内部上下文或 runtime identity 认证。

最早可重复使用的路径已经是“用户提卡、维护者伴行”。用户提供目标仓库、触发步骤、期望行为和不做什么；维护者确认它仍是当前缺陷，补齐允许改动文件、基线、检查命令及退出码、任务预算和卡/task 对应关系。维护者还负责匹配构建、真实材料 bytes/hash、来源事实、三角色能力映射、独立 home 与本任务 scratch。可写目录必须显式配置，不能把全部历史归档根交给模型。

准备沿用仓库 helper scripts/prepare-bug-fix-method.mjs，产出 compiled.json、context.json 和三份 Markdown；这些产物本身不授权执行。执行复用公开的 LoopEngine、CodexCliAdapter，明确单个 inputTasks、sources:[]、一次迭代与注册检查。本次 createHostExecutionContext 来自 CLI 内部带构建 hash 的 chunk，路径会随构建变化，不能当作稳定公共 SDK。现有教程中的 deliver --execution-context 仍有合同、profile、权限和身份前提，不能说普通用户拿到材料就能直接运行。

完成条件应由证据决定：原错误确实复现、修复只在授权范围、同入口与邻近控制通过、最终候选独立核验、实际材料和调用 receipt 可追溯、清理状态明确，并把失败与成功链接一起留在原卡。首次缺权限的旧 Node26 packet 保持封存；这次成功属于新的长路径任务，不替它翻绿。

例如，用户提“Loop 把深层文件名变成省略号，评审目标找不到”。维护者在该卡冻结一个长路径与短路径控制，准备固定材料，安排一次真实修复，独立检查完整路径、计数和优先级，最后人工贴回候选与 receipt。下一张窄缺陷可以重复这条路径，仍需逐任务准备和审核，不能复制旧授权。

接下来先将这条已证实的接线整理成稳定、可校验的用户入口与安装包，消除维护者依赖内部 chunk 的步骤；同时按父 PR 顺序合并，在实际 main 上重新核验。再接卡片读取与幂等证据回写，减少人工映射。U2 与可信 runtime identity 单独补证，不冒称目前已经具备。无需把 Firstmate 深运行、U3、全部方法或全部宿主认证追加成下一次 assisted 使用的前置门槛；本轮也不代表整个 C2 已完成。

依据：现有 docs/verification/bug-fix-method-handoff.md 的输入与边界，以及本次 run/、native-candidate/、independent/FINAL-REPORT.md。教程仍含旧阻塞时态，整合时应追加新任务结果，保留旧失败身份。本稿只描述已有 helper/API，没有新建“method bug-fix”CLI，也没有宣称安装版已发布。
