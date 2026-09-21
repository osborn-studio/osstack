# Kimi K3 审查裁决

实际通过 OSStack KimiCodeAdapter 调用 kimi-code/k3，review profile tools=[]；最终模型身份看 runtime_identity，不能把 readiness 当通过。

## 设计审查：changes_requested

- create 到 launch 记录间隙：本批明确保持 unknown，调用目录已永久消耗，不自动重建。真实故障夹具在 API create 返回后暂停并杀死原 host，验证容器只处于 created、无持久ID时不能生成stop证明。没有实现“根据label直接删除”的管理恢复。这是有意保留的liveness缺口，不转换为安全恢复声明。
- DELETE 与迟到 start：使用完整不可复用ID，删除204后再次检查404和daemon身份。真实pause-before-start测试中，新host移除后，旧host继续得到404；SIGKILL旧host且独立session后代存活时，新host可移除整个scope。另做实际专用daemon重启，之前receipt仍有效。
- journal持久性：限定可信host的本地私有目录，原子mkdir消费调用并fsync父目录；先fsync临时文件，再hard-link不可覆盖发布launch/receipt并fsync目录；无共享FS/恶意管理员保证。损坏/缺失记录只会unknown。
- 网络隔离已明确使用network=none，非仅“private namespace”；无mount/socket、非root、drop-all、no-new-privileges。Docker socket是可信host控制面，不能暴露给容器或worker。
- 使用完整SHA256目录名、固定spec/binding摘要和UUIDnonce；重复调用目录不会被删除或重新使用。

## 首轮源码审查：approved

两项judgment通过，无阻断问题。resource-bounds-unverified为warning：已采纳，将PidsLimit/Memory/NanoCpus/LogConfig加入inspect的严格复核，新增内存上限被移除时拒绝启动/删除的测试。

create-gap-orphan为warning：保留上述unknown与后续管理恢复任务。catch-error-masking为info：清理无法确认时最后错误会覆盖原异常，仍是error/unknown；本轮不扩展错误展示重构。

另补Linux daemon身份拒绝及同调用竞争测试。最终18个单元测试、6项真实故障实验均通过后，完整源码再次交Kimi复审；不把首轮针对旧代码的批准算作最终代码审查。

最终完整源码复审 **approved**，proof / authority两项judgment均通过，无阻断问题；实际runtime_identity为provider=kimi、model_id=kimi-code/k3、evidence_source=reported。剩余3条均为info：confirmStopped统一返回unknown、create到journal间隙的管理回收缺口，以及abort无法证明停止时继续保留unknown。

## 验证范围

普通测试中的Docker HTTP服务是故障注入替身；6项probe使用真实Linux Docker与独立OS进程，两类证据分开。真实probe中的SIGSTOP/SIGKILL和原型注入只在scripts/fixtures，不进入运行包。

测试VM为本任务独立创建，未修改默认Docker context、未触及其他profile；probe清理只针对其记录的精确测试containerID。目录中的首次日志保留初始实现和后续改动，最终准入仅绑定source-manifest与最终Loop记录。
