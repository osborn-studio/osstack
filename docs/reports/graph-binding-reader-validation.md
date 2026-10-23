# G25：恢复绑定文件的有界读取

源码 `1ca7d09bec024ba3a807adc8e9c5fdef9dd0c393`。修复 `reopenGraphContainedTests` 在首次打开及 G15 最终事务复核时读取 `binding.json` 的阻塞与超限窗口。**25/30；G25 仍为 in_progress。**

## 实现

使用 `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` 打开绑定文件，先检查普通文件及大小，再用固定 65537 字节缓冲区分段读取，超过 65536 字节即拒绝。`finally` 关闭文件描述符。原有 canonical identity、当前权限、完整 inventory 和事务复核规则保留。

已有 agent journal reader 曾采用这些限制，但 CLI 的 binding reader 尚未同步；这次补齐该路径。它不提供新的整图停止或 workspace 隔离证明，也不会结算业务结果、释放 admission 或自动重放动作。

## 验证

- 独立 Node 子进程读取真实 FIFO，无 fs mock：旧代码等待至 3 秒外部超时并被终止；新代码约 200ms 拒绝，动作仍 running、admission 仍 held、没有未关闭事务。
- 新增6个测试，覆盖首次 reopen 与最终事务中的 FIFO、读取中增长，另含恰好64KiB、短读及异常关闭。完整文件72项通过。
- 初版新增测试在旧代码上4失败/2通过。Kimi指出增长测试会因后续 stat 而在旧代码上也拒绝，不能独立证明实际读取上限。已加强为后续 fstat 也返回小尺寸，真实文件仍是65537字节的有效JSON加空白；旧 reader 的这2项测试均失败，新 reader通过。预期RED日志保留。
- 首个真实 OSStack Loop `G25-binding-read-1` 通过：6项专项及全新固定seed矩阵585次执行（loop112、agents47、core79、cli343、并发复跑4；seed250929/250930），另有类型、schema、startup及whitespace检查。
- 测试增强后，真实 Loop `G25-binding-read-2` 执行1、跳过0、success：完整72项测试与5项 verifier通过。矩阵复用核对所有生产源码及dist哈希未变；唯一变化是加强后的测试文件，明确记录前后哈希，未宣称测试源码完全一致。没有重复计数为新的585次执行。
- 两轮真实 Kimi K3 (`kimi-code/k3`) 审查；最终 approved，全部判断通过。模型身份来自运行时 reported identity。初审意见与最终结果均保留。
- 最终全workspace typecheck、schema freshness通过；CLI version中位29ms、help81ms，均在预算内。

[机器证据及原始记录](../implementation/graph-binding-reader-evidence/admission.json)。验证使用显式隔离 OSSTACK_HOME/TMPDIR；本轮针对宿主文件读取，不新增真实Linux/Docker运行，也不声称全库测试或G25全部完成。

## 边界与后续

O_NONBLOCK 解决POSIX FIFO等待写者的问题，不保证任意设备或网络文件系统的延迟上限。私有journal父目录及宿主/admin仍可信；O_NOFOLLOW不能防止恶意父目录替换。

下一步仍须构建实际descriptor/candidate对应的完整执行器注册，提供host/opaque writer/reviewer、worker后代及workspace的独立证明，再替换GraphDelivery取消/接管中的占位引用。完成业务envelope对账、精确资源释放、artifact锁及其他F01–F12窗口后，再进入G26–G29。
