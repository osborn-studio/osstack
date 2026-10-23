# Firstmate 第六批：扩展入口与资格边界

本批以 PR #242 的 Graph/远程只读/恢复接口为基线，整合三个并行代理的提交和主线程真实 CLI/daemon 接线。PR 状态、最终源码与全量结果在下方最终资格段更新。所有功能均未合并到 main，未部署到用户服务 home。

## 实现

- Worker viewer：固定原始 view token、只读结构化快照、默认60秒、总读取期限、字节上限、Ctrl-C与socket物理关闭。没有 tmux/cmux、原始日志 tail 或进程取消权限。
- R3 sources：宿主固定私有 source-registry.json，固定typed JSON快照、manifest/content digest、canonical repo/default tenant、过期与撤销复查、最多两个实际未完成读取。真实main/daemon覆盖ready、disabled、配置错误、跨repo拒绝与撤销。不会自动注入模型上下文。
- O2：迁移45、Ed25519单attempt grant、精确目的地/正文/账号/作者绑定、IMMEDIATE事务、发送前FULL同步落盘、一次send调用、未知结果保留、无自动重发、receipt对账。RPC无法注入signer或transport；production默认空。真实daemon/CLI通过注入fake完成签名流程，test_only送达仍exit1；关闭前等待逻辑完成与DB最终事务，迟到promise不能写已关闭DB。没有真实provider适配器或外部消息发送。
- U2a：显式版本/build/protocol/schema、per-group预算、共享installation/home claims、durable journal与故障恢复状态。main仅开放homes plan-upgrade/upgrade-status；没有apply。NativeUpgradePort为注入接口，完整consumer证明、真实安装重启及原生reconciliation未实现；不恢复旧DB。
- 四组Graph子进程fixture补入迁移45 DDL，Attention只读schema上限更新45；生成CLI与公开exports清单。

## 验证与审计

组件原始审计、命令记录、哈希清单见 `2026-10-23-firstmate-wave6-evidence/`。O2组件123测试，U2a67新测试+31旧模块回归，R3 20测试，viewer63测试；这些是各组件快照，不能相加当成最终独立测试数。

主线程真实CLI/daemon/socket回归最初22项通过，随后增加upgrade子命令help覆盖，并将默认投递测试改为真实存在的本地义务，明确验证缺少宿主目标时拒绝。所有这些测试会进入最终全量。测试输出fake回执不代表生产发送完成。

主线程两组 Claude Code CLI `claude-haiku-5-5 --effort medium` 静态挑战分别覆盖投递持久性与扩展入口，两组报告均无确认的P0/P1。审计没有执行测试。modelUsage报告该model ID，但stderr提示unrecognized_model；这只能证明请求参数/响应元数据，不能证明代理服务背后的真实模型权重。

审计提出的边界：

1. 投递CLI超时后的操作者应inspect/reconcile；不会自动再发。O1 resolve递增revision，因此旧授权不能越过后续义务修改；已解除义务上的新显式发送与本地义务状态仍独立。
2. 源文件底层I/O无法强制取消，两个hung读取会占满实际槽；这是限制资源累积的保守策略。跨重启可信时钟、网络盘和瞬时路径替换的OS级隔离未取得资格。
3. upgrader的consumer completeness、真实NativeUpgradePort、断电恢复、claim释放的原生对账均待实现/资格。journal全局目录上限是有意的有界读取；满目录需运维归档。未开放执行的coordinator早期verified返回不携带cleanup原因，但公开status保留claim_cleanup_pending。
4. reviewer未提供的关联文件分别由另一审计组和实际测试覆盖：RPC仅connect不autostart/no retry；worker.inspect只读；home inventory不打开DB；delivery.handle为async，错误为reject；boundedCall最大30秒，shutdown先等pending再关闭DB。不存在其猜测的无限网络等待或同步throw逃逸。
5. help路由不显示说明的P2已修复并测试；升级JSON补转义U+2028/2029。其余缺失真实环境证据不以fixture替代。

## 最终资格

待主线程在最终源码上跑完整8项检查、记录OSStack任务与远端精确head CI后更新。
