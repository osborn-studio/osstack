# C6 Claude Fable 5.1 独立审查裁定

实际通过本地 Claude CLI 调用 `claude-fable-5-1`，关闭工具，只提供所列源码快照和上下文。原始 prompt/JSON 保留，modelUsage 与 is_error 另有汇总。Claude 没有运行测试；实际测试由 OSStack Loop/Codex 和父执行器完成。

## 设计审查

- 接受：独立工作区必须贯穿 broker 的准入、策略、执行上下文、cwd 与 retained recovery；已逐路径实现并测试异步候选检查、权限撤回和精确保留目录。
- 接受：合法 tests exit 1 应是 confirmed passed:false；仅在实际停止、普通退出、允许的失败码且无取消/基础设施错误时成立。未知停止继续保留。
- 接受：worker RETURN 不是汇合权威。新增 host 最新账本/证据复核和迁移31的一次性汇合记录，真实 Functional/SQLite 恢复证明旧缓存不会替代最新 attempt。
- 接受：测试结束后也须检查 HEAD/index/原始跟踪文件；已修复实际成功命令改写候选后误报通过的反例。tests 可保留自己的未跟踪构建输出。
- 接受：仅新建 plan 不足以保证 retry 会话独立。真实 adapter invoke 前分配 UUID session，重建最小 context，持久记录实际 run/task/session 与摘要；实际 broker retry 验证两个 session 不同。
- 接受：证据包含 workspace lease 和候选前后身份；加载校验精确 effect/attempt，host 再与账本 action 的 lease 引用核对。
- 没有采纳“账本已经有 cancelled action 状态”的判断：当前 core action terminal 只有 confirmed/failed，协议的 cancelled 并不代表存储已支持。沿用 G15 的 run 取消意图与停止/对账约束，不凭错误前提修改状态机。
- 没有采纳“reserve/retry 没有动作/token/deadline 约束”的判断：该轮审查未包含 core 实现；实际原子账本已有这些检查。后续提供 core 源码后，Claude 确认分支/动作/token 核算一致。
- epoch advance、冻结后动态注册及完整模板是真实缺口，明确交由 G21，未将路由建议包装成已执行修复。

## 实施审查 REQUEST_CHANGES

1. **legacy failed 造成 evaluate 永久抛错：已修复。** broker 可能保存仅含 message 的旧错误；host 不再强制把它解析成 GraphError，也不把 pre-admission retrySafe 当作 G19 可重试结果。没有分类的失败给不可重试 stop；若真实分类与账本不一致仍拒绝。即使存在合法证据文件，也不能把账本 failed 提升为该文件的代码 verdict。
2. **新 retry intent 在 grant 复检前丢失调用所有权：已修复。** executeRequest 在复检前持有原 retry action/binding；仍然有效的原 fence 才能记入未开始的失败。实际测试第二次 grant 检查拒绝，新行由 intent 收敛为 failed，执行器调用次数不增加。过期/换代的 owner 仍不得写入，必须 G15；这不是自动清理旧代。
3. **预算停止导致已经产生的完整证据丢失：发布与路由已分开。** 完整合法 join 可以在 stop 路由时写入 immutable journal，不授权任何新动作。保留原计划的严格 deadline/超额记账 stop；没有采纳“超额后仍直接 ready”的产品策略。精确上限、无需新花费的通过结果仍 ready。
4. **续期与异步验证竞争：保持严格冲突，明确 G21/G28 活性要求。** 不采纳从快照删去 revision/updatedAt 并直接改用新 fence 的建议，这会违背 C5“不得刷新掉已经验证的前提”。G21 driver 须安排足够的 host lease、停止/排空旧 worker后恢复，并在冲突时重新核验；持续短租约续期场景尚未声明可用。

## 简化意见

保留 typed plan 验证：除了固定拓扑相等，它还核对当前 registry 的自身输入/输出合同。Binding 提取到 protocol 与统一 epoch 常量可随后在接口收敛时处理，不为本批扩大协议迁移。slot 名称在受信任夹具中可配置，G21 必须把实际编译计划与 host 注册固定绑定；此时直接强制 eN.review 会破坏已验证的 G19 默认节点接口。evidenceRef 的前缀/摘要格式已由实际 loader 检查，不重复加入弱的字符串校验代替加载验证。

## 最终复审

最终完整源码复审为 **PASS（限定 C6）**，确认 P1、retry 所有权和发布/路由分离已修复；另列两个 P2：

- **输出体积：接受并修复。** 实际 Node 命令输出 16000 个 ESC 与中文字符串时，原代码由合法 exit1 落入 unknown；已用前缀/摘要压缩诊断输出，保留真实退出、停止、身份和合法业务报告。报告契约限制为 8192 UTF-8 JSON 字节；超限给 stopped OUTPUT_CONTRACT_INVALID。compiler/registry/schema 升级 v3，两个实际回归由失败转通过。诊断摘要/长度针对 G04 提供的 JS 字符串重新编码 UTF-8，不承诺完整原始输出字节或被截后缀可找回。
- **retry 复用 run id 的条件性担忧：未成立。** `packages/loop/src/executor.ts:85` 实际使用 `run_${randomUUID()}`；真实 G19/G20 retry 已证明不同 session、不同调用收据与已结算的 attempt 2。未为不存在的固定 run id 问题更改 receipt key。
- 后一轮提出按 effect slot 分摊 branch budget：不采纳。core 明确按 node 跨 slot 共享 retry 上限，host 必须保持相同口径，不能为每个 slot 另发预算。

输出补丁另一次实际 Claude Fable 5.1 独立复审为 **PASS**，没有修改请求。指出诊断前缀可能在代理对之间截断、UTF-8 长度不是原始进程字节计数；保留有界、可 JSON 往返的前缀，已在产品接续文档准确说明长度语义。

所有 Claude JSON 均 `is_error:false`，modelUsage 包含 `claude-fable-5-1`。最终测试结果以父 Loop 验收日志为准，不以审查文字代替执行证据。

## 验证边界

实测采用真实 shell/G04、Git/artifact、SQLite、worker/Functional 与 G15 收据，review 模型是确定性 adapter。新 session 的证明只到真实 adapter API 入参；未宣称测试了 live provider 内部会话隔离。same-UID 与 WAL NORMAL 等边界沿用 C5。C6 不包含 G21 全模板、公开 graph CLI、任意逃逸执行器自动恢复或生产性能准入。
