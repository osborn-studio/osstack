# Sonnet 5.5 实现审计处置

## 方法与范围

Claude Code CLI 实际使用 `claude-sonnet-5-5`，无工具、无 MCP、无持久 session，对冻结输入进行静态审计。原始 JSON 的 `modelUsage` 确认模型，不以 prompt 中自称作为证明。测试由实现团队执行；Claude 没有执行测试。本报告不是生产资格认证。

两份首轮审计分别检查完整采纳流程与升级兼容。最终复审检查下面的处置和更新源码。每轮保留输入、逐文件 SHA-256 manifest、原始 JSON 输出；不重写历史审计。

## 逐项处置

| 首轮编号 | 处置 | 实现与验证 |
|---|---|---|
| P1-1 正常在途回复被降为 unknown | 修复 | host 注入当前进程的精确 live message；refresh/replay 显示 in_flight；完成事务同时更新 action/item。超过两个 tick 的真实 daemon fixture 与重启未知测试分开验证 |
| P1-2 瞬时来源失败永久污染 Wait | 修复 | 临时 IO 保留 Wait 并记录去重原因；来源身份改变继续阻断；未分类程序错误回滚。目录恢复和 TypeError 零写测试 |
| P1-3 migration 47 表谱系未展示 | 补证，无需另建手工登记 | db.ts 从 MIGRATIONS[].sql 动态识别 CREATE TABLE；提供完整源码及 47 重新打开、逐一缺失 7 张表拒绝测试。未来 48 未实现且保持拒绝，不伪造未来兼容 |
| P2-1 拒绝动作反复占用 admission | 修复 | admission 前纯读预检、异步 admission 后重新验证、1 秒至 60 秒退避、每种原因最多一条持久事件 |
| P2-2 终态可改写、取消误停后续消息、停止次数无界 | 修复 | completed/failed 为吸收态；保留首个停止意图；停止仅匹配 Mission 原消息；最多 8 次 stop 请求。另对严格证明未派发的原排队消息释放 admission，不触及后续人工发送 |
| P2-3 对象存在性探测 | 修复 | 未知或无 read 权的 Mission 统一 permission_denied，先检 scope 再使用仓库元数据 |
| P2-3 全局 action_id | 保留现有合约并明确限制 | attention action/message 是全局共享发送权限；本轮不引入第二套 ID 映射。CLI 指南使用全局唯一 UUID。重复 ID 发生严格冲突并回滚，不读出另一 Mission 回执，也不重发。两个客户端故意复用 ID 仍会冲突；不是多租户命名空间隔离 |
| P2-4 取消回执在旧视图显示未知 | 修复 | read model 使用严格取消证明；坏证明显示 dispatch_inconsistent；session.send 对原消息返回 cancelled_original_answer，排空期间同样可读取 |
| P2-5 空闲轮询反复 FULL 写 | 修复 | observed_at 最多每分钟更新；action state 不变不更新；正常空闲与 unknown 空闲 total_changes 回归测试 |
| P2-6 一次采纳、容量和错误说明 | 有界试点限制，已修订契约和指南 | 同一原决定即使未回答且结束观察，也不能再次采纳；全库累计 1000 Mission，无自动回收；原答案重放返回取消状态，新请求返回 mission_terminal；完整错误表 |
| P2-7 决策摘要口径 | 修复 | decide/defer/dispatch/refresh 都对 SessionDecision.parse 后内容取摘要；带 trim/default 规范化的测试 |
| P2-8 回滚、时限与凭据 | 文档明确限制，CLI 缺陷修复 | feature off 不抹掉 reserved 权限，恢复取消需重新启用；5 分钟仅请求 abort，费用仍 unknown；轮换凭据不等于撤销 principal/client grant；答案文本 -h 不再触发 help |
| 升级 P2-1 取消与未知 phase 放行 | 修复 | 纯读共享 guard 仅允许 committed+applied 或严格有效的取消证明；真实 schema 47 及破坏证据矩阵 |
| 升级 P2-2 旧 schema 藏新表 | 修复 | schema 小于 47 却有 phase 表时拒绝未知谱系，既不跳过也不擅自迁移 |
| 升级 P2-3 停服后才发现未完成动作 | 修复 | daemon.drain 返回 attention_dispatch_holds，进入 drain 后不再派发；有 holds 时在 stop 前拒绝，停止后在 DB 独占锁内再次检查 |

## 保留边界

- 旧本地 socket 路由仍属于 trusted-process 管理面；engineering 的凭据不把同 UID 的恶意程序隔离出来。
- committed 但未 applied 的未知消息不因人工放弃回执而自动放行升级；明确保留不确定性，不能据此声称已停止。
- 两个独立进程 SIGKILL 场景覆盖派发前与已调用后；事务故障注入另测回滚，不声称覆盖物理掉电或所有指令窗口。
- 真实受控 Provider 需要独立 API 凭据。Claude Code CLI 审计登录成功不等于该 Adapter 可执行真实 Session。
- 本次只交付 existing Session 的 observed_turn，不交付自动初始 Worker、Loop/Graph 选路或 24 项能力全面运行时融合。

## 最终复审

第二轮原文：[JSON](https://github.com/osborn-studio/osstack/blob/cf3bc68c71c336b59d0b3735b24bcd22209813b0/docs/design/2026-10-25-engineering-agent/evidence/sonnet-5.5/sonnet-round2.json) · [可读报告](https://github.com/osborn-studio/osstack/blob/cf3bc68c71c336b59d0b3735b24bcd22209813b0/docs/design/2026-10-25-engineering-agent/evidence/sonnet-5.5/sonnet-round2.md)。结论为受限本地试点通过、无 P0/P1，同时提出三项 P2；继续整改如下，并提交第三轮聚焦复审。

| 第二轮编号 | 处置 |
|---|---|
| P2-A 完成事务依赖 realpath | 完成事务只读取 DB 内的 task/run/native/scope/source 绑定及最新 snapshot，不调用文件系统，也不在事务内 refresh。实际 turn、applied、completion proof 原子保存；后续观察才确认 Mission completed。真实目录 rename 消失与三种 DB 身份变化测试区分验证。 |
| P2-B drained:false 被 literal schema 吞成通用错误 | 先解析非负计数与布尔值，优先报告 attention hold，再检查 graph/active/drained。fake fixture 与真实 daemon 都返回 drained:false、hold:1。拒绝后保持 draining 是现有协调器行为；指南给出确认升级已中止后的显式恢复方法。 |
| P2-C 无法升级或回退的运维边界 | 中英文指南与 ADR-16 明写：committed 未 applied 始终阻止升级，包括人工 abandon；本试点没有受支持的自动清除/离线放行实现。schema47 无法由旧 binary 打开。保留证据，禁止重置 user_version 或直接改账本。 |
| P3-1 纯未派发取消仍显示 stop_unknown | 只有存在 committed 未完成消息时写停止未知事件；纯已证明未派发的取消保留原证据并释放本 Mission 排队 admission。 |
| P3-2 旧 Session 错误分类 | session.send 将 dispatch_inconsistent 保留为明确错误码。 |
| P3-3 以 -- 开头文本 | 指南明确使用完整 --input JSON，避免把值当作选项。 |
| P3-4 scope reader 的资格信息 | 当前 scope reader 可获知该 scope Session 的资格状态，这是受信本地可读信息；不新增跨 scope 权限。 |

第三轮原文：[JSON](https://github.com/osborn-studio/osstack/blob/cf3bc68c71c336b59d0b3735b24bcd22209813b0/docs/design/2026-10-25-engineering-agent/evidence/sonnet-5.5/sonnet-round3.json) · [可读报告](https://github.com/osborn-studio/osstack/blob/cf3bc68c71c336b59d0b3735b24bcd22209813b0/docs/design/2026-10-25-engineering-agent/evidence/sonnet-5.5/sonnet-round3.md)。结果：无 P0/P1/代码 P2，有一项条件性文档 P2-D。完成以下文档修订后进行最终定点核验：

- 升级失败的 `upgrade-operation.json` 和 `recovery_required` journal 保留；`daemon.resume` 不清除它们，后续托管重启可能被阻断。有永久 hold 时不得发起托管升级；目前没有受支持的自动清理、无证据放行或降级通道。指南与 ADR-16 明示限制。
- P3-A：没有本 Mission 在途动作时的 stop_unknown 是保守的停止状态，不证明曾派发；原 Session/Worker 的退出不由采纳试点证明。严格的 cancelled_before_dispatch 证据仍单独有效。保留为措辞改善项，不将其升级为执行或停止证明。
- P3-B：人工新 turn 抢先推进 snapshot 时，不伪造原 Mission 完成；指南说明读取原回合证据并结束观察的处理。
- P3-C：部分额外组合未逐项做测试；其现有判断不因此获得真实环境资格。保留具体测试局限，不以静态审计补齐执行证据。
- P3-E：补充 draining、dispatch_gate_required、dispatch_inconsistent 的排查说明。

最终文档核验：[原始 JSON](https://github.com/osborn-studio/osstack/blob/cf3bc68c71c336b59d0b3735b24bcd22209813b0/docs/design/2026-10-25-engineering-agent/evidence/sonnet-5.5/sonnet-doc-closeout.json) · [可读结论](https://github.com/osborn-studio/osstack/blob/cf3bc68c71c336b59d0b3735b24bcd22209813b0/docs/design/2026-10-25-engineering-agent/evidence/sonnet-5.5/sonnet-doc-closeout.md)，P2-D **PASS**。因此合并判断为：受限试点无剩余 P0/P1/代码 P2，文档 P2 已处理；保留上述非阻断 P3 与真实环境限制。

代码复审与文档复核均实际使用 `claude-sonnet-5-5`，原始返回 `is_error=false`。它们不执行测试，不代替本地完整测试或真实 Provider 资格。源码文件 SHA-256 与第三轮冻结输入一致；最终规范状态标题作事实澄清，指出采纳试点已实现、其他架构阶段仍待实现。

最终完整测试与其他执行凭据参见[交付报告](../../../../reports/2026-10-25-session-adoption-pilot.md)。
