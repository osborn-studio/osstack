# Graph 内部运行手册

## 配置与启动

仅在授权的单仓库、独立私有 home 上执行。开发 checkout 禁止指向默认 `~/.osstack` 或已保留的服务 home。

```sh
export OSSTACK_HOME=/absolute/private/osstack-graph-beta
export OSSTACK_UPDATE_CHECK=0
export OSSTACK_POWER_POLICY=none
export OSSTACK_CLOCK_MONITOR=monotonic-v1
mkdir -p "$OSSTACK_HOME"
chmod 700 "$OSSTACK_HOME"
pnpm build
node packages/cli/dist/bin.js serve
```

`graph-host.json` 放在该 home，权限 0600。字段采用 `schemaVersion:1`、`admissionEnabled:true` 和一个 `registration`：精确 scope、repositoryRef/repositoryPath、taskRef/task、inputArtifactRef、writer/reviewer capability、allowlisted acceptanceRegistry，以及带过期时间和 read/execute/cancel/resume 的 grant。不可在该文件写 API key；在私有终端输入环境变量。当前实现的注册示例和完整请求由 `scripts/verify-graph-internal-pilot.mjs` 生成，脚本显式收费并始终使用新的隔离 clone/home。

真实试点命令（先在私有终端载入 DeepSeek 环境变量）：

```sh
OSSTACK_HOME=/absolute/private/new-pilot TMPDIR=/tmp \
  node scripts/verify-graph-internal-pilot.mjs /absolute/pilot-result.json deepseek-v4-pro
```

实际模型 ID 需与供应商可用列表一致。脚本会验证 endpoint、真实健康检查、候选/独立评审/测试/join、原仓库未改、负面评审和取消未知结果。不要把 API key 输入聊天或写入报告。

## 迁移、备份与升级

1. 修改 owner-only 配置 `admissionEnabled:false`；不改变 immutable registration 的身份字段。daemon drain 同样禁止新图准入。
2. 查询现有 run；完成正常任务，取消不再需要的任务。`cancel_pending` / `reconciliation_required` 是未解决状态，不等于已经停止。
3. `osstack upgrade` 现在同时检查 daemon drain 与只读 durable inventory。任何非终态 run 或未释放 admission 都拒绝安装/回滚，保留当前 daemon 供继续处理。
4. 全部 executor 停止且无未知动作后，再停服务；备份整个私有 home（DB、WAL/SHM、workspace、artifact、过程日志、回执、配置），另记二进制版本与 source commit。单独 DB 不是外部世界的快照。不要复制正在写入的 SQLite 文件冒充一致备份；在线 DB 快照使用 SQLite backup API。
5. 迁移在新代码打开 DB 时执行；先在隔离副本验证。历史备份只允许在关闭准入的隔离 home 中检查，同时保留当前实际执行日志及工作目录。若备份早于外部调用，禁止按“数据库没有动作”启动新调用。没有完整外部状态清单就不恢复写入。

## 取消、对账、重试

保存当前 status 的 revision，提交严格 v1 `kind:"cancel"` 请求。`graph reconcile` 使用同一请求格式，不接受用户伪造的 stop proof。响应丢失时重试同一个 key；revision 冲突先读状态，只有新的操作意图才生成新 key。

自动公开对账仅支持有可信 no-child 证据，或第一个 bounded writer 已有真实停止、原始内容回执、worker exit 日志及未变化的私有 workspace。结算先落 durable recovery decision，再按精确 token 释放原锁；释放 ACK 丢失可重试，替换锁不会被误删。

如果 daemon 在观察 worker 退出前被杀，或者 HTTP 请求结果不明、workspace 被修改、授权失效、锁身份改变，则继续保留。重新取得同 scope 的权限只能授权检查，不能创造停止证据。不要使用 kill/PID 缺失、过期时间、模型回答或手动 SQL 把它改成 `not_applied`。

## 回收与回滚

当前没有面向未知执行器的强制解锁/自动 GC。保留旧目录、锁、预留成本和证据，记录 run/action/executor identity，交由可独立确认结果的执行器对账。必要时暂停该试点；不能复制旧任务换 key 重发。开始无关新任务也必须重新授权，并避开隔离中的目录和外部副作用。

残留 artifact 临时锁意味着 freeze 可能中断；不按年龄清理。已冻结 artifact 可以独立核验/恢复到全新目录；旧 writer 对旧目录的迟到写入不能改变 artifact。

回滚优先关闭新准入、保留兼容 daemon 的读取/取消/对账。禁止删新表、删锁、用旧 DB 覆盖当前 DB 以“撤销”外部动作。已发布 0.17.0 的旧锁解析器会拒绝新 managed lock，这是保护行为；不能把报错当成删除锁的理由。

## 发布边界

本地验收和内部 beta 不代表已经推送、合并、部署或支持所有 adapter。查看[兼容矩阵](../implementation/graph-runtime-compatibility.md)、[性能报告](../reports/graph-runtime-performance.md)和[真实试点](../reports/graph-runtime-pilot.md)。
