# OSStack prompt language / Prompt 写作约定

OSStack uses writing principles from ASD-STE100 to make prompts and explanations easier to understand. This is a project writing policy. It is not a claim of full STE compliance. Chinese text uses the same clarity principles; STE itself specifies English.

OSStack 借鉴 ASD-STE100 的写作原则。目标是让任务、条件和结果更容易理解。本页是项目写作约定，不是完整 STE 合规声明。中文采用相同的清晰表达原则。

Reference: [ASD-STE100 official FAQ](https://www.asd-ste100.org/STE_faq.html). The standard includes writing rules and a controlled dictionary. This guide does not replace the standard or reproduce its dictionary.

## Write the task / 写清任务

1. Name the object. Use its exact path, task ID, or command name. / 写明对象，使用准确的路径、任务编号或命令名。
2. Put the condition before the action. / 先写条件，再写操作。
3. Give one action in each instruction. / 每条指令只写一个操作。
4. Use short sentences and active verbs. / 使用短句，明确谁执行操作。
5. Use one term for one concept. / 同一概念使用同一术语。
6. State the expected output and the acceptance check. / 写明输出和验收检查。
7. State what to do when a check fails or the result is unknown. / 写明检查失败或结果未知时的处理。
8. Keep command names, flags, paths, JSON keys, and state values unchanged. / 不改写命令、参数、路径、JSON 字段和状态值。

These are project guidelines inspired by STE. They are not a complete list of STE rules. An automated word count or `neat check` cannot prove STE compliance.

以上是项目约定，不是标准的完整规则。字数检查或 `neat check` 不能证明 STE 合规。

## Prompt template / Prompt 模板

```text
Task: Describe one result.
Scope: List the permitted files or task IDs.
Inputs: List the evidence to read.
Actions:
1. Read the inputs.
2. Make the required change.
3. Run the specified checks.
Acceptance: State the checks that must pass.
If a check fails: Fix the cause. Run the affected checks again.
If the result is unknown: Preserve the evidence. Report what is missing.
Output: List changed files, check results, and remaining limits.
```

```text
任务：写明一个交付结果。
范围：列出允许修改的文件或任务编号。
输入：列出需要读取的证据。
操作：
1. 读取输入。
2. 完成修改。
3. 运行指定检查。
验收：列出必须通过的检查。
检查失败时：修复原因，再运行受影响的检查。
结果未知时：保留证据，说明缺少的信息。
输出：列出修改文件、检查结果和剩余限制。
```

A prompt describes intent. It does not create a host grant, expand permissions, or replace a machine-enforced check. Preserve the user's meaning when rewriting a prompt. Ask for missing information only when it changes the permitted action or the acceptance check.

Prompt 描述意图。它不能生成宿主授权、扩大权限或替代程序检查。改写时保留用户的原意。只有缺失信息会改变允许操作或验收条件时，才需要补充确认。

## Explain an OSStack command / 解释命令

Use four parts: purpose, required inputs, action, result. Explain a write operation before giving its command.

使用四个部分：用途、必要输入、操作、结果。先说明写操作的影响，再给出命令。

Example: `osstack sources events SOURCE_ID --repo /absolute/repo --default-tenant --after 0 --json`

- Purpose: Read source observation events. / 用途：读取来源观察事件。
- Inputs: Use a registered source ID and the repository path. / 输入：已登记的来源编号和仓库路径。
- Action: Read the bounded event journal. / 操作：读取有数量限制的事件账本。
- Result: Check `events`, `next_sequence`, and `has_more`. This command does not acknowledge a source change. / 结果：检查 `events`、`next_sequence` 和 `has_more`。此命令不确认来源变更。

## Stable terms / 固定术语

| Term | 中文 | Meaning |
|---|---|---|
| task | 任务 | Requested work with a defined result. |
| check | 检查 | A specified operation that produces evidence. |
| grant | 授权凭证 | Host authorization for a specific operation. A prompt is not a grant. |
| unknown | 未知 | Evidence is insufficient to determine the result. |
| stop_requested | 已请求停止 | The request is recorded. Process termination is not proved. |
| Ready | 待审查状态 | The PR is no longer a draft. This does not prove deployment readiness. |

Use these explanations in new prompts, help text, and user guides. This change adds authoring guidance and examples. It does not automatically rewrite submitted prompts or validate the full STE dictionary at runtime.

后续新增 prompt、帮助文本和用户手册采用这些解释。本次增加写作约定和示例；尚未加入运行时自动改写或完整 STE 词典校验器。
