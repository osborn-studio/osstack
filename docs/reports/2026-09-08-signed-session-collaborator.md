# 有限委托与自动接续：S2/S3 首个可运行切片

日期：2026-09-08。分支：`codex/collaborator-foundation`。
承接[首批基础实现](2026-09-08-collaborator-foundation-implementation.md)和[产品 RFC](../design/2026-09-08-collaborator-and-self-improvement-rfc.md)。

## 当前结果

一次有效的签名委托可以让 daemon 在阶段之间自行检查输出、发送冻结指令、有限返工并接续，不再要求逐阶段输入 `go`。当前接入 `agent_sessions`，运行配置为 `claude-controlled-session`，支持用户提供材料的规划与评审。它不读取项目代码或运行代码工具，因此不能代替现有 LoopEngine 的代码实施与受控交付流程。

本切片没有安装到正在服务的 daemon，没有创建真实信任密钥、调用真实模型、调整 GitHub 权限、合并或发布。这些是本地分支上通过 fixtures 验证的实现。首批报告中“尚无自动接续、automatic_continuation 始终 false”的描述是此前切片的历史状态，由本报告更新。

## 授权与执行

Ed25519 委托绑定 `session_id / runtime_id / runtime_policy_sha256 / repo_path / initial_turn_id / initial_version`，以及有序 steps、指令、验收规则、返工指令、累计预算、发行时间和截止时间。私钥由发行者保管，daemon 只加载公钥。`requested_by` 是审计标签，不能代替签名。

每个 step 检查**当前持久化输出**；通过后发送该 step 的 instruction。最后一条指令完成后，委托状态成为 `completed`，表示委托步骤已耗尽，不表示整个项目完成，也不表示最后输出通过额外验收。需要检查最后输出时，计划须显式增加相应检查步骤。

输出检查只支持 exact text 和 JSON primitive equality，全部通过才接续。JSON path 只遍历自有属性，不执行表达式。模型 `next_action`、自报证据引用和“测试通过”文本不会被直接当作执行指令、工具回执或通用质量证明。此处无法验证一个开放性设计是否正确；真实代码晋升仍须接入独立测试和受控交付。

每次检查批次计入 `checks_used`；接续和返工都计入 `resumes_used`，且在发送前与 accepted 消息一起原子预留。预算最高 32 次接续、64 批检查，最多 16 个步骤，每步最多 3 次返工，委托最长 24 小时。预算不会因重放或重启清零。当前没有可信 usage 事件，未提供 token 或美元硬上限。

只有 `phase_continue` 且 phase 匹配才可进入检查；`risk_approval / task_authorization / external_input`、无类型决策、陈旧 turn、未知密钥、不同运行策略均停止自动接续。输出不满足契约时，只有冻结且尚有次数的 retry_instruction 可以发送。

## 运行配置

新适配器固定 tools=[]、无 MCP/项目 settings/hooks/plugins/skills、dontAsk、maxTurns=1，并在启动与续接时核对 SDK init 的实际工具、模型、权限与工作目录。它使用独立的控制器目录和精简环境，只接受显式 `ANTHROPIC_API_KEY`，默认模型固定为 `claude-sonnet-4-6`。模型与本机 SDK 二进制内容、固定配置和规范运行目录进入策略指纹；运行文件或目录变化后拒绝继续使用旧指纹。

这是一项 SDK 工具权限边界，不是 OS 沙箱，也不防拥有同一操作系统 UID 的恶意本地进程。仓库路径只是本次委托的上下文绑定，适配器不会把它设为 SDK 工作目录。没有把既有 Claude/Codex 的全局免审批、项目 MCP 或 shell 权限带入自动接续。

严格结构化响应形如：

```json
{
  "result": {"ready": true, "summary": "已完成提供材料的初步分析"},
  "decision": {
    "decision_id": "plan_ready",
    "question": "进入评审阶段？",
    "choices": [],
    "continuation": {
      "version": 1, "gate_kind": "phase_continue", "phase": "plan",
      "next_action": "建议评审", "evidence_refs": []
    }
  }
}
```

`result` 与 `decision` 分别落库，问题文本不会覆盖被检查的结果。`decision:null` 或省略 decision 代表普通结果，不推断阶段完成。

## 使用流程

开发版本只能使用专用 `OSSTACK_HOME`；不要用开发 CLI 打开默认或保留的服务库。生产安装需遵守现有控制面升级流程。

1. 配置 daemon 公钥文件 `<OSSTACK_HOME>/continuation-trust.json`，格式如下；未配置时信任集为空，所有新委托拒绝。私钥不放入此文件或受限运行目录。信任集在 daemon 启动时加载，密钥撤销需撤销活动委托并更新文件/重启。
2. 用 `osstack session start --agent claude-controlled-session` 创建会话，其余必需参数见 `osstack session --help`。首次提示须说明所需的结构化结果及 phase。
3. `inspect` 读取实际会话与运行指纹；`draft` 把本地 steps 文件与当前 turn/version 绑定；发行者审阅并签署；`install` 后自动开始接续。

```json
{
  "schema_version": 1,
  "keys": [{"key_id": "owner", "public_key_pem": "-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n"}]
}
```

例如 steps.json：

```json
[
  {
    "phase": "plan",
    "checks": [{"kind": "json_value_equals", "path": ["ready"], "expected": true}],
    "instruction": "评审上一阶段提供的方案。返回 result 含 ready 字段，以及 phase=review 的 phase_continue decision。",
    "retry_instruction": "修订当前分析后重新返回 plan 阶段的结构化结果。",
    "max_retries": 1
  },
  {
    "phase": "review",
    "checks": [{"kind": "json_value_equals", "path": ["ready"], "expected": true}],
    "instruction": "综合讨论给出最终建议，返回 result，decision 为 null。"
  }
]
```

```text
osstack collaborator inspect <session_id> --json
osstack collaborator draft <session_id> --steps steps.json --out grant.json --ttl-seconds 3600
osstack collaborator sign --file grant.json --key-id owner --private-key <发行者私钥路径> --out signed.json
osstack collaborator install --file signed.json --json
osstack collaborator status <grant_id> --json
osstack collaborator revoke <grant_id> --json
```

发行者已有 Ed25519 私钥即可使用 sign；工具不自动创建或信任密钥。输出文件独占创建，避免覆盖已审阅计划。`draft` 默认预算为 steps 与允许返工之和（分别受协议上限约束），单轮超时 120 秒；签署前可在协议范围内调整。签署后任何指令内容变化都须重签。

## 恢复与撤销

Migration 24 仅添加 grants/attempts 两张表和索引，旧会话/消息原样保留。新 turn、applied 回执和委托游标在同一事务提交。撤销立即持久化并取消当前运行；它不能撤回已经生成的结果，也不会把真实回执丢掉。提交时再次比较绝对截止时间，避免事件循环延迟让超时回调晚于结果而错误地把委托标为完成。

重启时，未预留发送的 checking 标为 abandoned，已经花掉的检查预算保留，允许重新检查；reserved 一律阻断为 `delivery_uncertain`，不换 ID 重发。未知或已移除的发行公钥、过期委托和改变的实际运行配置不会自动恢复。排空阻止新动作，恢复接收后可继续尚有效且没有不确定投递的委托。

`session status/list/snapshot` 增加 collaborator 的状态、预算和调度状态。只有处于有效调度中的 phase 请求才显示 automatic_continuation=true；这表示已委托的自动检查/接续流程在运行，不表示任意模型请求已经通过验收。

## 验证与下一处盲区

定向测试覆盖签名篡改、规范化、协议边界、初始与当前游标、非 phase 请求、固定指令、防重放与预算重置、有限返工、撤销、超时、迟到完成、重启投递不确定，以及运行文件漂移。daemon 集成使用真实受限适配器工厂与假的 provider stream，没有调用真实模型。

最终代码提交：`0686f6f`，主功能为 `5a82b1c`，多阶段测试限时修正为 `53da717`。独立、干净的 Git 检出验证结果：

| 验证 | 结果 |
|---|---|
| 完整 `pnpm test` | **285 个测试文件、2,414 个测试全部通过**；其中 CLI 97 个文件、838 个测试 |
| 构建 | 全包 `pnpm build` 通过；最后的 CLI 修正重新构建通过 |
| 类型检查 | 全包 `pnpm typecheck:check` 通过；最终 CLI 再次 typecheck 通过 |
| lint | 通过，仅保留 deployed-home.test.ts 与 upgrade.ts 两项原有 warning |
| 协议与导出 | JSON Schema 漂移检查、inventory freshness、5 个发布敏感包的 changeset coverage 通过 |
| CLI 启动 | 最终开发构建 5 次采样中位数：version **41ms**，help **130ms**，均在 150/500ms 本地预算内 |
| 新导入成本 | 既有 session 依赖加载后，controlled-session 增量导入约 **5.91ms**；SDK 仍延迟加载 |
| CLI 入口 | 使用独立临时 OSSTACK_HOME 验证 compiled collaborator help 调度成功 |

第一次全量运行的两项失败来自多阶段测试共用默认 5 秒整例限时，彼时其他用例通过。两个场景的整例限时改为 20 秒，产品每轮 5 秒 fixture 预算及独立超时断言不变；完整回归重跑通过。另一个新增健康检查 fixture 曾误调用真实只读探测，现改用受控报告，其恢复门禁测试通过。

对抗审查还关闭了公钥字段误接收私钥 PEM、首次健康检查前恢复执行、迟到完成绕过 timer 顺序，以及旧决策 JSON 被从结果中再次解释的问题。受限会话只接受独立的 decision 事件；结果中即使包含 ostag_decision 对象，也保持普通数据。已有适配器的旧格式兼容路径保留。

验证检出只包含已提交内容，工作区原有 AGENTS.md 记忆修改没有被删除、暂存或改写；服务数据库没有迁移。SDK 无工具边界与真实 provider 联调仍须区分：模型 ID 绑定不证明模型权重快照，本轮没有生产模型运行或长期浸泡测试。

本次把一个盲区变成了明确约束：**输入 `go` 的频率减少，与结果经过独立验收是两件事。** 新路径证明有限授权可以可靠接续；只有把实际候选、可信测试回执和精确 diff 的交付验证接上，才支持代码自改进。下一条主线仍是 RFC 的 S4/S6/S7，Github App 身份治理见[独立 RFC](../design/2026-09-08-github-identity-and-cloud-steward-rfc.md)。
