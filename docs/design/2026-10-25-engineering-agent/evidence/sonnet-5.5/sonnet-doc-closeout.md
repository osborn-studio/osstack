# P2-D 文档终审结论:**PASS**

这是静态核对,没有运行任何工具或测试。未重复代码审计。

## 逐项核对

| 要求 | 中文指南 | 英文指南 | ADR-16 |
|---|---|---|---|
| 操作 fence 在 `resolveAuthority` 写入,早于 drain 和安装 | ✓ | ✓ | ✓ |
| 失败后 fence 与 journal 保留,状态为 `recovery_required` | ✓ | ✓ | ✓ |
| `daemon.resume` 只恢复存活进程的接收,不删 fence,不清 hold,不证明未知动作已停止,不是数据库回退 | ✓ | ✓ | ✓ |
| 之后的托管重启可能被 `upgrade_start_blocked` 拒绝 | ✓ | ✓ | ✓ |
| committed 未知动作的 hold 可永久保留,现有 upgrade reconcile 无法自动解决 | ✓ | ✓ | ✓ |
| 没有受支持的 fence 清除、操作员放行或数据库降级通道 | ✓ | ✓ | ✓ |
| 禁止手改或删除 fence、journal、DB,不得调用不存在的 complete/force-clear 命令 | ✓ | ✓ | ✓ |
| 已有 hold 时不要发起托管升级 | ✓ | ✓ | ✓ |
| 新人工 turn 先于观察归约时,Mission 可保持 `observing`,先查原回执,再 `end-observation`,不重发、不伪造完成 | §2 ✓ | §2 ✓ | ADR-14 ✓ |
| 错误码 `draining`、`dispatch_gate_required`、`dispatch_inconsistent` | 错误表 ✓ | 错误表 ✓ | 末段 ✓ |

## 措辞检查

- **没有暗示 resume 会清除 fence。** 三处文本都明确否定。"放弃升级"段落紧接在 fence 段之后,并重申 resume 不解除 hold,不是回退。
- **没有认可手改 DB 或 fence。** 所有相关位置都是禁止性表述,并指向"另行审核的离线恢复方案"。
- 范围限定准确:fence 段落只声称"因未决 hold 失败"的场景,与协调器"任何失败后保留 fence"的行为一致,没有夸大。

## 不阻塞的小注记(P3,可不改)

1. "不要调用不存在的 complete/force-clear 命令"中的"命令"措辞准确:`ManagedNativeUpgradePort.complete()` 是类内方法,仅在 `reconcileForward` 成功后内部调用,不是操作员入口。如果以后增加 CLI 封装,这句话需要同步更新。
2. `runtime-contract-v2.md` 开头的状态行仍写"设计规范,尚未实现"。这与 ADR-16 的实现性表述不一致,但不属于 P2-D 范围。
3. `upgrade_start_blocked` 的行为依据 native.test:107-108,我在本次提供的材料里看不到该测试,按上轮报告引用。

## 结论

P2-D 已在中英文指南和 ADR-16 中完整处理,没有剩余的精确文档缺口。该试点仍是默认关闭、opt-in 的有界试点,不具备生产资格。
