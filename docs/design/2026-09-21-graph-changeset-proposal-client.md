# Graph 多文件提案客户端：P05a 实现与继续开发契约

日期：2026-09-21。状态：实验性传输模块；未注册 executor，未接入生产 graph.start。

## 本轮解除的阻塞

上一轮 Claude CLI 审计连续 HTTP 500，属于外部审计服务故障，不能据此判定本地实现失败。本轮显式调用 `claude-fable-5-1`，成功获得两轮审计，第三轮最终源码复核也已成功返回。

第一轮审计只得到 recovery 文件的局部片段，提出“释放后重新 hold”和“failed 投影绕过门禁”。补齐 schema、SQL 与正常 project 路径后，两项指控均不成立：

- `GraphAdmissionStore.hold` 使用 INSERT ON CONFLICT DO NOTHING，不会清除 released_at。
- recovery project 枚举不包含 failed；正常 project 对 ready/failed/cancelled 都检查未决 action 和未释放 admission。
- `inspectAdmission` 已能读取 release 状态，不需新增重复查询接口。

新增两项真实 SQLite 回归测试均通过，Fable 在第二轮明确撤回上述结论。因此不能把未经复现的模型意见直接当作修复清单。

## 本轮实际实现

入口：`@osstack/agents/experimental/changeset-client`。主函数 `createChangesetProposalClient` 返回 `prepare` 和 `invoke`。显式子路径避免给 CLI 的根导入增加依赖。复用已有 Anthropic/DeepSeek JSON、无工具、非流式 codec；没有新 npm 依赖、shell、文件写入或自动重试。

`validateChangesetInput` 从已有提案校验器抽取，可在网络请求前验证 manifest、路径策略、当前 binding、前像 SHA256、内容上限及别名冲突，并冻结排序后的数据。已有 v1 policy/manifest/proposal 三组 golden digest 不变。

### prepare

1. 验证输入与任务大小，拒绝不匹配 binding/policy、越界路径、错误前像等。
2. 生成最终 JSON 请求字节；不读取 API key 环境变量，不从任务选择 endpoint。
3. 请求摘要绑定 provider、owner 配置的 endpoint、精确 model、完整 body、manifestDigest、generation/effectKey 等 binding、输出上限、输入 token 上限与证据引用。
4. 计算安全整数 reservationTokens = inputTokenUpperBound + maxOutputTokens；上限不是费用估算。
5. 返回冻结对象，私有 WeakMap 标记来源。复制、伪造或另一客户端生成的对象不能用于 invoke。

任务/manifest/body 是敏感工作区内容；API key 不进入 prepared 对象或摘要。不得把请求正文写入普通日志。host 的受保护 artifact store 尚待接入。

### invoke

- 先检查 handle、取消、已消费 effect 和容量；锁定客户端再调用同步 host gate，防止重入。
- host gate 返回精确 `true` 才允许请求。其他 truthy 值、Promise、异常均不授权。
- false/重复/容量不足不构成原 effect 的“已经停止”证据。
- 只有赢得 gate 后、调用 fetch 前观察到 abort，才返回 not_dispatched。
- 单次 POST、redirect:error、无 retry。fetch 与 body 读取共用截止时间。
- 响应最多 65536 原始字节；严格 UTF-8；摘要在解码之前计算，保留 BOM 等字节差异。
- timeout/abort 通过 Promise.race 返回，底层不响应 AbortSignal 或 cancel 也不会阻塞调用方。每个客户端最多一个尚未完成的底层 operation；该 operation 挂起时拒绝新的 gate。
- 4096 个已消费 effect 不淘汰。达到容量后需要 host 管理客户端生命周期；重建客户端不能替代持久化 gate。
- 已完成且合法的 provider 响应保留实际 usage；提案必须再次通过现有 changeset 验证。超输入/输出 token 上限或加法溢出，一律 rejected，不能进入 apply。
- Anthropic 空 content 拒绝响应仅由新客户端显式 opt-in 支持；旧 bounded writer 仍采用原有拒绝空数组的行为。

空内容拒绝确实可能是正常 HTTP 200 终止响应，见 [Anthropic refusals 文档](https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback)。本模块保留 usage 作为保守的 token 容量证据，不把 usage 直接解释为美元账单；不同拒绝时机可能有不同计费规则。未启用 provider fallback。

### 结果语义

| 结果 | 本模块能说明什么 | host 不能据此做什么 |
|---|---|---|
| not_authorized | 本次调用没有获得发请求资格 | 不能释放另一个已发出的同 effect 请求、不能宣称原请求未执行 |
| not_dispatched | 本次赢得 gate，随后取消发生于本地 fetch 前 | 不能跳过持久化、generation 和停止证据绑定 |
| unknown | gate 提交状态或远程执行状态不确定 | 不能重发、自动释放 reservation、标记 retrySafe |
| terminal/proposal | 收到绑定 model 的合法终止响应与合法提案 | 不能直接写文件、不能跳过当前 lease/授权/前像复核 |
| terminal/cannot_complete | 模型明确无法完成，终止与用量可保留 | 不能转成成功实现 |
| terminal/rejected | 终止已知，但内容/预算不接受 | 不能把提案送入 apply；账务仍须处理 |

HTTP 非 200、错误模型、非法 usage/tool block 等继续保留 unknown。这是保守的实验边界。此版本只支持精确响应 model ID；host 必须配置并验证固定标识，尚不支持请求别名到响应快照 ID 的解析。不能把所有 model mismatch 自动视为可信 terminal，更不能顺便允许模型 fallback。后续如支持 alias，须把 owner 授权的解析结果纳入 profile/request digest 并有专门测试。

## host gate 的实现义务

客户端回调是可信 host 代码，不是 worker JSON API，也不是独立的授权系统。

生产连接前必须完成以下顺序：

1. 从当前编译计划、授权 profile/grant、run/action/fence、独占 workspace lease 得到输入；读取 manifest 前确认路径/inode/link 类型和完整树别名，不接受模型自报策略。
2. 对最终模型输入证明输入 token 上限。使用固定版本 tokenizer 的有效上界或 provider 强制且经验证的上下文上限。必须包含消息封装等计数；不是字符数/4，也不采用 Fable 建议的“body 字节数加常数”未经证明规则。
3. 在既有 action ledger 保留足够容量，并验证 request.reservationTokens 与 action 实际 reservation 的关系、当前截止时间、停止状态。
4. 将精确 request 和输入证据存入受保护 artifact store，绑定 manifestDigest/requestDigest。artifact 成功后由 `beginInvocation` 原子写入 request 元数据与 running 转换。
5. 仅 `beginInvocation.changed === true` 返回 true。异常、重复、丢失 ACK 不允许请求，即使会留下未用的保留容量。
6. 收到 terminal 后，持久化 response、usage、模型 ID 与 host 终止凭证，绑定 requestDigest/effect/generation，再调用 `recordInvocationResponse`。此操作不结算 apply、不释放 admission。
7. proposal 再交由 host applier；cannot_complete/rejected 走有证据的非重试失败结算；unknown 留待可信恢复。客户端结果对象本身不是 host 签发的持久化凭证。

测试中的 gate 仅使用固定 fixture token bound 与 mock provider，证明数据库去重集成。它不证明真实 tokenizer、授权验证器、provider 成本或生产 profile 已就绪。

## 后续可执行顺序及验收

### P05b：生产 host 连接与持久化证据

目标代码区域：agents experimental client、core graph artifact store、host executor enrollment/broker。

交付：实现上述 gate、受保护 request/response artifact、与 action 绑定的用量和停止证据；明确定义 provider 已终止与 workspace 已停止两种不同事实；显式 owner enrollment，不改全局默认路由。

验收：真实 SQLite + 本地 HTTP 假服务覆盖请求前崩溃、请求后断连、response artifact 写满/失败、持久化 ACK 丢失、跨客户端竞争、跨 generation 重启、取消与迟到响应。每个 effect 最多一个网络 dispatch；unknown 保留容量；无 artifact 不能伪造完整 response 证据。

阻塞：付费调用的输入 token 证明和掉电持久性决策。既有 WAL synchronous=NORMAL 与 SIGKILL 测试只证明进程崩溃恢复，不证明 OS/电源故障后请求门禁绝不丢失。生产启用前选定并验证同步策略；不得用“已有 crash 测试”代替这一决策。

### P06：真实多文件 host applier

已有 `beginApply`、immutable apply intent/resolution、quarantine 和停止后 admission release 只是 ledger 基础，不是完整 applier。

交付：在隔离 Git 工作区，复核每个目标的 preimage、路径和 inode；生成完整目标树与逐文件 journal；取得 applyAuthorized 后才开始修改；create/replace/delete 及 executable mode 遵守 changeset v1；文件/目录同步和 journal 持久化次序必须明确；写后验证真实 Git 树并绑定 receipt，才能 `completeApply`。

验收：真实 Git 仓库的 create/replace/delete 混合提案、大小写目录别名、symlink/hardlink、只读/磁盘满、外部改写竞争，以及每个物理写窗口 SIGKILL。未提交 applied receipt 的不确定工作区不能继续 freeze/join。模型发来的 target tree/hash 不能替代 host 的物理验证。

### P07：隔离恢复与最终演练

先保持 quarantine 的不可自动重试属性。补充跨 run 的物理工作区隔离登记与只读检查，然后定义显式管理操作（弃置隔离工作区并从已知 Git 基线创建新工作区，或经可信核验恢复）。不能覆盖旧 immutable quarantine receipt，不能只比较摘要就改成 applied/failed。

验收：旧 generation、旧 receipt、旧 lease、物理工作区仍被占用、相同路径跨 run 重用都不能越权；恢复操作本身幂等且有新的审计事件。最后才做自愿付费 canary 和评测，再考虑 CLI/registry 激活。

## Fable 审计取舍

采纳：空 content 终止处理、固定校验错误码、挂起操作资源上限、缓存 usage 合计和取消边界测试。

维持保守边界：错误 model 保持 unknown；未实现精确非 200 拒绝证明前不按零用量结算；denied effect 在当前客户端不重试。gate 的 throw 可能发生在 DB 已提交后，不能按未执行处理。

拒绝：未复现的 admission/project 漏洞；摘要相等即可解除 quarantine；不经证明的 token 字节上界。模型审计不是执行授权，也不能替代测试与物理证据。


最终 Fable 源码复核结论：在“实验性、无工具、未启用生产、没有文件 applier”的范围内，没有发现剩余明确正确性阻塞。它未执行测试，因此此结论不替代本地验证，也不是生产启用批准。
