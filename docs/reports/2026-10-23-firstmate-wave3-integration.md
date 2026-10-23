# Firstmate Wave 3：真实交付合同与上下文

[PR #240](https://github.com/osborn-studio/osstack/pull/240) 依赖 #239，尚未合并/部署。源码冻结为 `db16ec1a`；此报告与原始证据属于后续文档提交。

## 实际实现

V2 契约已进入 guarded-local / guarded-git 的真实执行入口，检查与预算来自宿主已提交策略和私有 overlay。所有风险级别按 `requested_actions` 限制发布步骤；R3 签名范围只包含该契约要求的效果。approved candidate 修改策略后仍以冻结 base 策略+当前私有限制为权限来源，不让新代码自授权。

本地候选成果不合回原仓库；队列/状态/回执/报告默认在显式私有 home，每次调用独立目录。原仓库 HEAD、index、tracked/untracked 字节与 ignored 目录根会重复采样，变化则阻断成功并保留现场；这不是沙箱。现有 ignored 内容、瞬时改后复原与仓库外写入不属于该检测保证。

执行上下文通过实际 AgentTask.prompt 注入，准备/adapter-observed 回执落盘后返回摘要；强制 instruction/safety/contract 超预算即拒绝调用。回执不证明 provider wire 字节或模型权重。Home 清单仅连接显式 pin 的现有同 UID socket；lesson 来自实际有来源绑定的 run 证据，先 draft，显式 promote。

## 独立审计

[原始审计与摘要](2026-10-23-firstmate-wave3-evidence/root-audit/)保留全部输入/输出。共 5 次请求：第 2 次因 prompt 超长未执行，不能算一次完成审计；其余四次完成。请求 model `claude-haiku-5-5`，返回 metadata 同名，不视为底层模型权重证明。

首轮发现的 R3 PR scope、全风险 action 校验、policy base 与私有 bookkeeping 问题已修；强制上下文省略是缺少 assembler 源码造成的条件疑问，补源码后撤回。后续审计促成原仓库变更检测、ignored 根计数、结构化准入失败与中间目录 symlink 拒绝。PR destination 指控在提供实际 GitHub 发布实现与既有 remote-rebind 测试后撤回。最终第 5 次请求结论：改变范围内无确认 P0/P1。静态审计不替代执行测试。

保留边界：旧 legacy `--action` 是风险意图而非 V2 allowlist；context refs 尚未由交付 verifier 逐个重新打开；reported reviewer identity 不是密码学身份；guarded-git context 配置在 resume 重读；guarded-git 命令级 timeout 未完全等于总 wall budget；local 无新增执行 lease；任意同 UID 文件竞态与真实远程部署资格不在本批保证范围。Graph 独立后续切片处理，不能把这批称为 Graph 已验证。

## 验证记录

真实 CLI + Git + policy + 私有 context writer 的成功与 source-escape 反例通过；最终 source边界定向 28 测试通过，typecheck/lint通过。首个完整任务失败于恢复了 tracked knowledge outputs 后的增量构建缓存，以及 schema 列表 fixture；第二个完整任务期间发现并开发 source 反例，该任务捕获红测试，保留失败，不作为最终资格。最终冻结源码使用全新的 OSStack 原生任务 `firstmate-wave3-final-source-qualification`，正在运行八项完整检查；最终结果与 exact-head CI 完成后补入。没有把旧结果改写成通过。
