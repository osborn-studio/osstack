# C4 可复核证据

最终源代码提交：`36eee05f6bc6ef6aa8148dd9f4e9271e2237d4fc`；验收基线：`405b318`。最终全库 2856 项 / 22 个包；详见 admission.json 与 source-hashes.json。

- `acceptance-result.json` 中本轮 completedTasks 只有 `C4-final-acceptance-3` 且 success。state 历史保留先前 escalated/success 记录，不把历史失败删掉。
- `first-acceptance/`：全库捕获父级正在修复的 false-authorizer 红测试，正确 escalated。
- `idle-rerun/`：同 ID 的默认跳过行为导致未执行，不算验收成功。
- `second-acceptance/`：2,853 项通过。此后两处加固增添三项测试，最终再次全库通过。
- G11/G12/G13 由真实 OSStack Loop + CodexCliAdapter 执行。各 actor 自带 verifier 仅作初检；其 handoff、计数和代码描述是当时快照，最终事实以父级全库验收及 source-hashes 为准。G12 曾受嵌套 sandbox Unix socket EPERM 阻断，父级重新验证了真实 daemon。
- `claude-*`：三轮实际 Claude Fable 5.1，保留异议与裁定。`closure-*` 和红绿日志保留最后边界修复。
- 控制器脚本以 `.mjs.txt` 保存，含当次绝对工作区路径；重跑时必须改为新的隔离 OSSTACK_HOME。无数据库、凭证、socket 或活进程目录入库。

图存储进程崩溃夹具是异步 IPC/SQLite/ACK 验证。生产 graph worker 与 daemon→worker→broker 恢复链仍是 G14–G17，不能将夹具冒充已交付产品。

原始工具输出含 Vitest 差异行尾空格及尾部空行；本目录 `.gitattributes` 仅豁免原始 `.txt`/`.log` 的空白格式检查，以保留原字节，代码和正文检查不放宽。
