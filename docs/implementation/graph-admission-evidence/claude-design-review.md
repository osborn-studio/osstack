以下为对 G08–G10 基线的独立对抗性设计审查。不调用工具，仅依据所给材料。

## 一、阻断项（本批必须解决，否则 G17 无法证明）

**B1. 锁权威被 OSSTACK_HOME 切分，跨 worktree 无互斥。**
文件锁根目录是 `osstackHome()/locks/repos`，而项目纪律要求每个工作区独立 OSSTACK_HOME。两个 daemon 各自 HOME、指向同一 git commonDir，锁文件在不同目录，完全不互斥。G09 只规范化 commonDir 字符串不够。最小方案：写锁文件放在资源本身之下，即 `<commonDir>/osstack/write.lock`（.git 内，天然不进版本库）。HOME 下的 semaphore 仅作进程内排队，不再作为跨进程权威。repo_id 必须由 realpath 后的 commonDir 派生（本机 `~/Developer` 就是 symlink，字符串比较会分裂成两把锁）。

**B2. 锁 owner 无宿主绑定，pid 存活判断跨主机无意义。**
共享卷或 NFS 场景下，`process.kill(pid,0)` 检查的是本机进程。G09 增加 expiry/renewal 后，规则必须是：只有 `host_id` 相同且 pid 已死才允许回收；host 不同或不可判定一律 Busy。owner 增加 `host_id`（hostname + boot 标识）和 `lease_generation`。generation 本批无消费者，但 G08 的 run 行必须记录它，否则 G11 的 fencing 没有起点。

**B3. 同 run 重入会挂死或误判 Busy。**
`FifoSemaphore(1)` 不可重入；`resumeGuardedAutonomy` 内若再触发 `acquireDaemonRunSlot`（嵌套 loop、重试路径），进程内排队永久等待，或文件锁因自身 pid 存活抛 Busy。G10 共享准入必须维护 `activeSlots: Map<run_id, slot>`，同 run 二次申请立即拒绝并带明确原因，绝不排队、绝不重入。

**B4. 取消未确认时 `finally { slot.release() }` 直接交出写锁，与设计文档矛盾。**
文档要求 unknown/cancel_pending 时隔离工作区、不转交租约，基线却无条件释放。最小方案：`release(outcome)`；outcome 为 `unknown` 时锁文件改写为 `quarantined: true`（owner 改为 daemon 本身），repo semaphore 保持占用。`acquireRepoWriteLock` 的 stale 回收路径必须拒绝回收带 quarantine 标记的锁，即使 pid 已死，否则 daemon 重启后隔离状态被自动"捡走"。解除只能走显式 reconcile 命令。

**B5. 策略路径由调用方决定，且回退到 daemon 的 cwd。**
`makePolicyGate(runOptions.workspacePath ?? process.cwd())`：RPC 不传 workspacePath 就读 daemon 当前目录的策略；传一个没有 policy.yaml 的目录就得到 allow。这等于调用方 principal 授予权限。G10 必须让策略读取路径与锁路径同源：都由 G09 的 canonical worktree/commonDir 解析得出，并写入 G08 run 行。调用方只能提供 repo 标识，不能提供策略文件位置。

**B6. 准入检查发生在排队之前，排队期间的撤销不生效。**
health 检查在 semaphore 排队前执行；guarded resume 路径在基线中根本没有 policy gate。排队可能持续数分钟，期间 `mode: observe` 翻转或 health 变红都不再检查。共享准入应为"获得槽位之后、首个 effect 之前"再评估一次，结果作为 invoke 的拒绝（Promise reject），不能杀 producer 或 scheduler。

**B7. CLI 直连路径绕过全部准入。**
AGENTS.md 明示存在直接 DB 命令（loop run、daily 等）。这些路径不经 `acquireDaemonRunSlot`，不取文件锁。G10 的"共享准入"若只被 daemon 调用，名不副实。最小方案：进程内 CLI 写路径至少调用同一个 commonDir 文件锁与同一个 admission 函数；读能力仍可直连。证明要求：daemon 写运行与 CLI 直连写运行同 repo 并发，其一必须得到 `RepoLockBusyError`。

**B8. 无策略时的 allow 不能延伸到 graph seam。**
"缺 policy.yaml 即允许"是 legacy 兼容，graph 是新表面，没有可兼容的存量。共享准入接收一个由 daemon 内部代码给出的 `surface` 参数（loop | graph），不是调用方标志；graph 表面下缺策略即拒绝。这不是新增 auth flag，只是准入函数的固定入参。

**B9. 访问类型按能力名字判定，等于信任请求方。**
`READ_ONLY_CAPABILITY_KINDS` 按字符串放行，读槽位不检查 health、不取锁。graph 节点的 read/write 必须来自 G08 注册表中的节点声明，请求体里的 kind 字段仅用于校验一致，不得作为判定依据。

**B10. G08 的 SQLite 租约与文件锁是两个权威，顺序未定义。**
必须固定：先取 commonDir 文件锁，再 CAS 租约（租约行记录锁的 host_id/generation/acquired_at），CAS 失败立即释放文件锁；释放顺序相反。不可变身份列用 SQLite trigger `RAISE(ABORT)` 保护 UPDATE，并有测试证明更新失败，而不是靠约定。

## 二、集成证明要求（G17 前置，本批应产出的测试）

1. 两个不同 OSSTACK_HOME 的 daemon，同一 commonDir 的两个 worktree，一个经 symlink 路径进入：写运行严格串行。
2. 锁文件 host_id 不同 + pid 已死 + 已过期：拒绝回收。
3. 同 run 嵌套申请槽位：立即拒绝，不挂死。
4. 取消后 worker 退出未确认：下一个写申请得到含 quarantine 原因的 Busy；daemon 重启后依然 Busy。
5. 排队中翻转 observe：出队后被拒，daemon 与其他排队者不受影响。
6. RPC 携带过期 generation：daemon 侧拒绝。本批只要求信封字段与相等性检查，不要求 checkpoint 层。
7. 身份列 UPDATE 触发器失败。

## 三、后续义务（不阻断本批，但本批不得封死）

- **策略文件自改写。** `.osstack/policy.yaml` 在 worktree 内，worker 可改成 execute，gate 每 tick 重读即生效。本批至少在 G08 记录准入时策略摘要；后续规则为"只接受收紧，放宽需重新准入"，或把该路径列入受保护提交路径。
- **受保护 commit/merge。** 写槽位不限制目标 ref。G08 现在就应记录 `target_ref` 与候选 SHA 字段，即使 G19 才填充。
- **compiledProgramDigest 的规范化版本。** G18 之前的占位摘要必须声明 canonicalization 版本并入库，避免 G18 落地后旧测试夹具静默失效。
- **锁文件写入窗口。** `wx` 打开到写完之间，其他申请者 `readOwner` 读到空文件会抛 Corrupt 而非重试。低概率，建议对空/半写文件短暂重试后再判定损坏。
- **read 槽位的实际副作用。** review 类能力若执行 `git fetch` 或修改索引，仍会与写者冲突；G11 动作级权限落地前先记录，不在本批处理。
- **多 worker 生成的 SQLite busy 重试。** CAS 失败与 `SQLITE_BUSY` 要区分，后者重试不得产生重复 generation。

## 结论

基线最危险的两点是 B1 与 B4：前者让"锁"在项目自己规定的部署方式下失效，后者让文档承诺的隔离在代码里不存在。B5–B7 共同构成"准入可被调用方或路径绕过"的同一类问题，应由 G10 的单一 admission 函数一并封闭。其余项均可在不新增调度器、不新增调用方标志的前提下落地。
