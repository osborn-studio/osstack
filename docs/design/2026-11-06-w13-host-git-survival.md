# W13 设计：守护进程崩溃后存活的主机子进程

日期：2026-11-06。基线：`main` `b706367b`（含 #377 阶段 4-C）。行号均指该基线。
上位文档：[v3 执行计划](../plans/2026-10-31-osstack-v3-execution-plan.md)（下称“计划”）第 33 行 W13；[受限 Mission 路径设计](2026-10-31-contained-mission-path.md)（下称“Mission 设计”）§9 与“实现说明（M8）”；[阶段 5 附录](2026-11-06-bridge-same-pr-revision.md)（下称“5 附录”，分支 `docs/bridge-phase5-appendix`，撰写中）§2“阶段 5 对 W13 验收的额外要求”。

5 附录第 48 行约定：两份文档对“放行”“登记回执”的定义不一致时以本文为准。本文 §6 列出需要回改 5 附录的地方。

## 1. 范围

**问题。** 受限 Mission 的守护进程用子进程做主机侧的 git 写入与远端写入。它们都在独立进程组里运行（`hardened-git.ts` L121 `detached: true`），或是普通子进程（`contained-mission-bridge.ts` L49–62 `defaultBridgeExec`、`packages/github/src/delivery.ts` L135 `defaultDeliveryCommandRunner`，均为 `execFile`）。守护进程崩溃时这些子进程不会随之退出，pid/pgid 也没有写进任何持久记录。重启后的 `recover()`（`contained-mission-host.ts` L193–211）只为执行器回合（`executor_started` 的 pgid，L249–251）和验证容器（L240）取停止证明，不知道还有一个 `git update-ref`、`git push` 或 `gh pr create` 在跑。后果：

- 本地：新 owner 判 `needs_reconciliation`，人选择 `discard_changes`（`ports.ts` L244 `update-ref` 回退），孤儿的 `update-ref`（`plumbing.ts` L306，旧值仍匹配时）随后把分支移回去（Mission 设计 M8 残余风险）。
- 远端：孤儿 `delivering` 由下一次 tick 重试（Mission 设计 §9 偏差一），这时取消会直接到 `cancelled`（`runner.ts` L164 起：没有活动句柄、`stop_obligation=0`），认领随即释放，孤儿 `git push` / `gh pr create` 在“已取消”之后才落到 GitHub。阶段 5 更严重：恢复读到 `expected_old_head` 判意图 `failed`，旧推送随后落地，产生没有 `confirmed` 意图的提交（5 附录 §2 第 36 行）。

**W13 的保证（本文的目标）：**

1. **先登记、后可写。** 被覆盖的子进程在能写入任何东西之前，其 pid、pgid、启动时间与一个唯一的“持有标记”已持久登记；真正允许写入的是登记之后、栅栏通过之后的“放行”，放行本身也先持久记账。
2. **恢复先证明停止。** 重启后，对每条未结的登记，要么证明它的进程已全部停止（防 pid 复用），要么把状态当作未知：非终态 Mission 进 `stop_unknown`，终态 Mission 保持认领与 hold。
3. **未知期间不前进。** 只要同一 Mission 或同一远端分支上有未证明停止的登记，就不释放工作区认领、不转 `cancelled`/`pr_opened`、不清停止义务、不开始新的主机写入或远端写入。这三条有数据库触发器或唯一索引兜底，不依赖调用方自律。

**不做：** 证明远端写入是否发生（那是首轮发布的幂等重试与阶段 5 意图对账的事）；防恶意后代逃逸（与 Mission 设计 §9 执行器的停止证据同等强度，见 §5.4）；Linux 的 pidfd/cgroup（宿主是 macOS，§5.3 只用 macOS 有的东西；Linux CI 走同一接口的另一实现）。

## 2. 覆盖哪些子进程

判断标准：守护进程崩溃后，这个进程若继续运行，能否改变**认领所保护的东西**（Mission 分支引用、worktree 管理数据）或**远端状态**（分支、PR）。

| 子进程 | 调用点 | 覆盖 | 理由 |
|---|---|---|---|
| `git push`（首轮） | `pushCandidate` `delivery.ts` L413–432，经 `fencedDeliveryRunner` `ports.ts` L74–95 → `appCredentialRunner` `bridge.ts` L94–105 或主机 runner | **是** | 远端写入 |
| `git push --force-with-lease`（阶段 5） | 5 附录 §5.3 第 5 步 | **是** | 远端写入；阶段 5 的硬前置就是它 |
| `gh pr create` | `createPullRequest` `delivery.ts` L434 起 | **是** | 远端写入（建 PR）；孤儿在取消后建 PR 与孤儿推送同样违反“取消后无远端写入” |
| `git update-ref` | `commitPlumbing` `plumbing.ts` L306；`restoreWorkspace` `ports.ts` L244；`commitWorktree` `ports.ts` L285 | **是** | 移动 Mission 分支；W13 计划条目的原始例子 |
| `git worktree add --no-checkout -b` | `createNoCheckoutWorktree` `plumbing.ts` L213 | **是** | 建分支引用与 worktree 管理目录；孤儿可在 `abandoned` 且认领释放后才完成 |
| `hash-object -w`、`write-tree`、`commit-tree`、临时索引上的 `read-tree`/`update-index` | `plumbing.ts`、`ports.ts` `withTempIndex` L114–120 | 否 | 只写不可达对象或 `runtime/` 下的临时索引；不移动任何引用，孤儿的结果没有读者 |
| 真实索引上的 `read-tree`、`update-index --refresh` | `materializeCommit` `plumbing.ts` L199–200（`restoreWorkspace` 经 `ports.ts` L249 调用） | **是**（`git_index_write`） | 内容上可被重读覆盖，但孤儿持有 `index.lock` 时恢复路径的 `read-tree` 会失败，被 `SIGKILL` 的孤儿还会留下陈旧的 `index.lock`。登记后：证明停止之前不重新物化；证明之后，若 `<git_dir>/index.lock` 存在且 mtime 早于证明时间，由恢复删除并记事件（worktree 由认领独占，没有别的合法持有者） |
| 只读命令（`rev-parse`、`ls-tree`、`diff`、`config --list`、`cat-file`、`symbolic-ref`、`remote get-url`、`merge-base`） | 各处 | 否 | 不写 |
| 网络只读（`git ls-remote`、`gh pr view`、`gh api` GET） | `delivery.ts` L368–411、L558–590；`ports.ts` L210 | 否 | 不写远端 |
| check run（POST/PATCH） | `bridge.ts` L172–227 | 否 | 进程内 `fetch`，不派生子进程，随守护进程退出；按 App id + `external_id` + head 查重（L191–205），孤儿请求最多多出一条被标 `neutral` 的重复 check，不改分支与 PR |
| Codex 执行器 | `codex-proxy.ts` L174 起 | 否（已有） | 已有 `executor_launch_intent`/`executor_started`（pgid）与 `stop_obligation`；W13 不改 |
| 验证容器 | `contained-verification.ts` | 否（已有） | 已有 Docker 移除证明 |
| `ps`、`lsof`、`sysctl` 探针 | 本文 §5 | 否 | 只读 |

`packages/agents/src/worktree.ts` 的 `worktree remove`、`branch -D`（L208–213、L417–418）属于 Loop 路径，受限 Mission 不调用，不覆盖。

## 3. 记录：迁移 54 的新表

### 3.1 为什么用表而不是事件

`engineering_contained_events` 是只追加日志，能留审计轨迹，但做不到本文需要的三件数据库层保证：“同一 Mission 最多一个未结登记”“同一远端分支最多一个未结登记”（部分唯一索引）以及“有未结登记时拒绝释放认领、拒绝转 `cancelled`/`pr_opened`、拒绝清停止义务”（触发器里的 `EXISTS` 查询需要可索引的状态列）。所以登记放新表，审计事件照常写进 `engineering_contained_events`（同一事务，§4）。

### 3.2 迁移号

计划用 **54**：52 已由 App E 影子合并设计（`docs/design/2026-11-06-bridge-shadow-merger.md` §4.1，分支 `docs/bridge-shadow-merger`）占用，53 由 5 附录 §4.2 占用。`runMigrations`（`db.ts` L139–141）跳过 `id <= user_version` 的迁移，所以**编号必须按合并顺序连续**：W13-A 若先于 52 或 53 合并，必须改用当时的下一个空号，另两份文档顺延；不能留空号等别人补（已升级到 54 的库会永远跳过后插入的 52/53）。这是 §10 决定 3。新表名以 `engineering_` 开头，`assertMigrationLineage`（`db.ts` L110–121）从 `MIGRATIONS` 自动推导（L103），无需另行登记；升级测试里写死的版本号按 4 附录 §3.1 的方法逐个改。

### 3.3 表与触发器

新文件 `packages/core/src/state/engineering-host-process-ddl.ts`，`migrations.ts` 追加 `{ id: 54, name: "engineering_host_processes", sql: ENGINEERING_HOST_PROCESS_DDL }`。

```sql
CREATE TABLE engineering_host_processes (
  op_id TEXT PRIMARY KEY CHECK(op_id LIKE 'hp_%'),
  mission_id TEXT NOT NULL REFERENCES engineering_contained_missions(mission_id),
  kind TEXT NOT NULL CHECK(kind IN ('git_push','gh_pr_create','git_update_ref','git_worktree_add','git_index_write')),
  remote_target TEXT,          -- push/PR：'<owner>/<repo>#refs/heads/<branch>'（小写仓库）；本地操作为 NULL
  local_target TEXT NOT NULL,  -- '<repo_identity>#<ref>' 或 worktree 路径
  intent_id TEXT,              -- 阶段 5 推送意图 id；首轮发布与本地操作为 NULL
  argv_digest TEXT NOT NULL CHECK(length(argv_digest)=64),   -- 不含令牌的规范化 argv 的 sha256
  owner_home TEXT NOT NULL, owner_instance TEXT NOT NULL, owner_generation INTEGER NOT NULL,
  boot_id TEXT NOT NULL,       -- 登记时的启动会话标识（§5.3）
  marker_path TEXT NOT NULL, marker_dev TEXT NOT NULL, marker_ino TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('launching','registered','released','stopped')),
  pid INTEGER, pgid INTEGER, leader_start TEXT,   -- leader_start：§5.3 的启动时间串，可为 NULL（读不到）
  released_at INTEGER,
  exit_code INTEGER, exit_signal TEXT,
  stop_proof TEXT, stop_detail_json TEXT CHECK(stop_detail_json IS NULL OR length(stop_detail_json)<=4096),
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  CHECK(kind NOT IN ('git_push','gh_pr_create') OR remote_target IS NOT NULL),
  CHECK(state NOT IN ('registered','released') OR (pid IS NOT NULL AND pgid = pid AND pid > 1)),
  CHECK(released_at IS NULL OR pid IS NOT NULL),          -- 放行必须先登记
  CHECK(state <> 'released' OR released_at IS NOT NULL),
  CHECK(state <> 'stopped' OR stop_proof IS NOT NULL)
);
CREATE UNIQUE INDEX engineering_host_process_mission_open ON engineering_host_processes(mission_id) WHERE state <> 'stopped';
CREATE UNIQUE INDEX engineering_host_process_remote_open ON engineering_host_processes(remote_target)
  WHERE state <> 'stopped' AND remote_target IS NOT NULL;
CREATE UNIQUE INDEX engineering_host_process_intent ON engineering_host_processes(intent_id) WHERE intent_id IS NOT NULL;
CREATE INDEX engineering_host_process_open ON engineering_host_processes(state, created_at) WHERE state <> 'stopped';
```

触发器（写法同 `engineering-contained-ddl.ts`）：

| 触发器 | 规则 |
|---|---|
| `engineering_host_process_fixed` | `op_id`、`mission_id`、`kind`、`remote_target`、`local_target`、`intent_id`、`argv_digest`、owner 三列、`boot_id`、marker 三列、`created_at` 不可改 |
| `engineering_host_process_flow` | 只允许 `launching→registered`、`launching→stopped`、`registered→released`、`registered→stopped`、`released→stopped`；`stopped` 终态；`pid`/`pgid`/`leader_start` 只在 `launching→registered` 时由 NULL 设值，之后不可改；`released_at` 只在 `registered→released` 时设值 |
| `engineering_host_process_no_delete` | 禁止 `DELETE` |
| `engineering_host_process_insert_shape` | `INSERT` 必须是 `state='launching'`，且 `pid`、`pgid`、`leader_start`、`released_at`、`exit_code`、`exit_signal`、`stop_proof`、`stop_detail_json` 全为 NULL；否则 `RAISE(ABORT,'host_process_insert_invalid')`。防止直接插入 `stopped`/`released` 行绕过唯一索引与门禁 |
| `engineering_host_process_insert_gate` | `INSERT` 时所属 Mission 必须非终态，且不是 `stop_unknown`、`cancel_requested`，且 `stop_obligation=0`；否则 `RAISE(ABORT,'host_process_launch_denied')`。即“未知期间不开始新的主机写入” |
| `engineering_claim_release_host_processes`（建在 `engineering_workspace_claims` 上） | `BEFORE UPDATE OF state` 且 `NEW.state='released'` 且该 Mission 存在 `state<>'stopped'` 的登记 → `RAISE(ABORT,'claim_release_denied')`。覆盖 `releaseClaim`（store L188–200）与 `authorize` 的 `supersedes` 交接（store L107–110） |
| `engineering_contained_host_process_gate`（建在 `engineering_contained_missions` 上） | 该 Mission 存在未结登记时，拒绝 `NEW.state IN ('cancelled','pr_opened')` 的转换，也拒绝 `OLD.stop_obligation=1 AND NEW.stop_obligation=0` → `RAISE(ABORT,'host_process_unproven')` |

三个触发器都只是**新增**对象，不改迁移 50 的表与触发器。

**为什么不复用 `stop_obligation`。** `stop_obligation` 只在转入 `executing`/`verifying`/`stop_unknown` 时置 1（store L158），终态只允许 1→0（DDL L30–33）。主机写入发生在 `executing`（停止证据已清义务之后，`runner.ts` L231 → L271）、`needs_reconciliation`、`delivering`，终态的子 Mission 也可能有未结推送（5 附录 §4.1 第 3 条）。把登记做成独立的行，再用触发器把它接到认领、终态转换与义务清除上，比扩展 `stop_obligation` 的语义少改既有约束。这与 5 附录第 101 行“推送操作记录自己有 `stopped` 状态，不复用 `stop_obligation`”一致。

### 3.4 store

`packages/core/src/state/engineering-host-process-store.ts`（新），全部经 `attention.write(owner, …)`，即都受 owner 栅栏约束（`attention-store.ts` L86–92），并沿用 `engineering-contained-store.ts` L202–204 的 `synchronous=FULL` 检查（否则 `durability_required`）。**`launching`、`registered`、`release`、`stopped` 必须是顶层事务**：`attention.write` 在已有事务中直接运行回调、不提交（L86–90），外层事务回滚或在提交前崩溃会抹掉放行记录，而放行字节已经写出。所以这四个方法入口检查 `db.inTransaction`，为真即抛 `host_process_nested_transaction`；调用方（包括阶段 5 的 `chainStore.transaction`）不能把它们包进自己的事务。`fence` 里的嵌套写入仍在 `release` 自己的顶层事务内。每个方法在同一事务里写一条 `engineering_contained_events`（`host_process_launching`、`host_process_registered`、`host_process_released`、`host_process_stopped`），负载不含 argv 原文与令牌。

```ts
launching(input: { mission_id; kind; remote_target?; local_target; intent_id?; argv_digest; marker: { path; dev; ino }; boot_id }, now): { op_id }
registered(opId, { pid, pgid, leader_start: string | null }, now): void
release(opId, fence: () => void, now): void      // 事务内先 fence()，再 registered→released；fence 抛错则整个事务回滚
stopped(opId, { proof, detail, exit_code?, exit_signal? }, now): void
open(missionId?): HostProcessRecord[]           // state<>'stopped'
remoteEffectPossible(op): boolean               // released_at IS NOT NULL
```

`release` 的 `fence` 是调用方的同步检查，可以在同一事务里写自己的事件（首轮发布的 `remote_mutation`，`runner.ts` L401–406），嵌套写入直接运行（`attention-store.ts` L86–90）。所以“栅栏通过”“`remote_mutation` 记账”“放行记账”三者同时成立或同时不成立。

`containedUpgradeHolds`（store L216–222）与 `listOutstanding`（L82–90）不需要改：有未结登记的 Mission 要么非终态，要么认领仍为 `active`（触发器禁止释放），两条查询已经计入。4-A 加一条测试锁定这一推论。

## 4. 启动协议

### 4.1 包装进程与放行

每个被覆盖的子进程都经同一个包装进程启动：

```
/bin/sh -c 'IFS= read -r g || exit 97; [ "$g" = "$0" ] || exit 98; exec "$@"' <op_id> <program> <args…>
```

- 脚本是常量，参数只经 `"$@"` 传递，不拼接字符串；`$0` 是 `op_id`，用作放行行的期望内容（不是秘密，只防误读）。
- `stdin` 是父进程独占写端的管道。父进程写入 `op_id\n` 才放行；sh 的 `read` 在管道上按字节读，不会多读，`exec` 之后程序看到的 stdin 是同一管道（父进程随即关闭写端，程序读到 EOF；被覆盖的命令都不读 stdin）。
- **父进程在放行前死亡** → 写端随进程关闭 → `read` 返回 EOF → sh 以 97 退出，**不 `exec`**。这一性质不需要超时，也不需要新 owner 做任何事。写端只在父进程中：Node 为子进程建的管道带 `FD_CLOEXEC`，其他子进程不会继承。
- `exec` 保留 pid、pgid 与文件描述符。所以登记的 pid 就是之后 git/gh 的 pid，pgid 就是整个命令的进程组。
- 用管道而不是 Unix 套接字：没有 AF_UNIX 路径长度问题（AGENTS.md 的 104 字符限制），也不需要在 scratch 根下建套接字文件。

**持有标记。** 父进程在登记前建一个空文件 `$OSSTACK_HOME/contained/host-processes/<op_id>.hold`（`O_CREAT|O_EXCL|O_NOFOLLOW`，0600，目录 0700），记下 `fstat` 的 dev/ino，把这个 fd 作为子进程的 fd 3 传入（`spawn` 的 `stdio` 第四项是整数 fd 时 Node 以 `dup2` 交给子进程且不设 CLOEXEC），然后关闭自己的副本。sh、`exec` 后的 git/gh 以及它们派生的帮助进程（`git-remote-https`、凭证帮助程序 `sh -c`、gh 调起的 git）默认继承 fd 3。恢复时“没有任何进程持有该文件”就是“这次命令的所有进程都已退出”的第二个独立证据（§5.2），它不依赖 pid，所以不受 pid 复用影响，也覆盖了“登记 pid 之前就崩溃”的窗口。继承关系由 W13-B 的真机探针实测（§8 T12）；git 与 gh 的子进程不继承 fd 3 时，标记退化为只覆盖包装进程本身，证明仍成立（进程组检查覆盖其余），但 §5.4 的强度说明要相应改写。

标记放在 `$OSSTACK_HOME` 而不是 scratch 根的 `runtime/`：`pnpm scratch:clean` 会删 `runtime/`（AGENTS.md），被删的标记即使有 dev/ino 校验也只能判“未知”，会把可证明的情况变成人工处理。这是对 scratch 规则的偏差（§9 偏差 4）；文件在证明停止后删除，恢复时清理没有对应行的旧标记。

### 4.2 步骤

`packages/agents/src/contained-workspace/host-process.ts`（新）提供进程机制，不依赖 core；登记由调用方经 `HostProcessJournal` 接口提供（cli 用 §3.4 的 store 实现）：

```ts
export interface HostProcessJournal {
  launching(input: HostProcessLaunchInput): { op_id: string; marker_path: string };
  registered(opId: string, identity: { pid: number; pgid: number; leader_start: string | null }): void;
  release(opId: string, fence: () => void): void;
  stopped(opId: string, outcome: HostProcessOutcome): void;
}
export function runGatedProcess(program: string, args: readonly string[], options: {
  cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number; signal?: AbortSignal;
  journal: HostProcessJournal; launch: Omit<HostProcessLaunchInput, 'marker'>; fence: () => void;
}): Promise<{ stdout: Buffer; stderr: string; exitCode: number | null; signal: string | null; released: boolean; proof: HostStopProof | null }>;
```

| 步 | 动作 | 持久状态 | 失败 |
|---|---|---|---|
| L0 | 建标记文件并 `fstat` | 文件（无行） | 抛错，无行，无进程 |
| L1 | `journal.launching`（owner 栅栏、插入门禁 §3.3） | 行 `launching` | `stale_owner`/`host_process_launch_denied`/唯一索引冲突 → 删标记，抛错，无进程 |
| L2 | `spawn('/bin/sh', [...], { detached: true, stdio: ['pipe','pipe','pipe', markerFd] })`；关闭父进程的 `markerFd` | 不变 | `error` 事件 → `journal.stopped(never_spawned)` |
| L3 | `ps -o pid=,pgid=,lstart= -p <pid>`（`LC_ALL=C`，同 `graph-process-identity.ts` L30–31）；要求 `pgid = pid` | 不变 | 读不到 → `leader_start = null`（§5.3 对 NULL 一律保守） |
| L4 | `journal.registered(pid, pgid, leader_start)` | `registered` | 抛错（如 `stale_owner`）→ 杀进程组（在线，子进程未回收）、关 stdin、等待并证明 → `stopped(never_released)`；若这条也写不进（owner 已失效），留给新 owner 按 §5.2 观察 |
| L5 | **同一同步调用链**：`journal.release(opId, fence)`，事务内先跑调用方 `fence()` | `released`（`released_at`） | `fence` 或写入抛错 → 事务回滚（仍为 `registered`）→ 杀进程组、关 stdin → 证明 → `stopped(never_released)` |
| L6 | 紧接 L5（无 `await`）：`stdin.write(op_id + '\n')`，`stdin.end()` | 不变 | 写失败（子进程已死）→ 进 L7 照常收尾 |
| L7 | 等 `exit`/`close`；超时、`signal` 中止或 L4/L5 失败 → `kill(-pgid, SIGKILL)`，**只在尚未观察到 leader 的 `exit` 事件时**发出（此时子进程未被回收，pid 与同号进程组都不会被复用） | 不变 | — |
| L8 | 收尾证明（§5.2 的同一判定，在线版：进程组为空且标记无人持有，最多等 2 秒）→ `journal.stopped(proof, exit_code, signal)`，删标记。**只观察，不再发信号**：`close` 之后子进程已被回收，其 pid 不再受保护 | `stopped` | 证明不成立 → 行保持 `released`（或 `registered`），返回 `proof: null`；调用方必须把 Mission 停到 `stop_unknown`（§6.1） |

要点：

- **放行即授权。** 栅栏在登记**之后**、放行**之前**，二者在一个同步调用链里，中间没有 `await`。放行记账（L5）先于放行字节（L6）：崩溃若落在 L5 与 L6 之间，账上是 `released` 而字节没写出，sh 读到 EOF 退出，结果只是“可能写过”的保守判断，不会反过来。
- **`released_at IS NULL` ⇒ 程序从未 `exec`。** 放行字节只在 L5 提交之后写；没有提交就没有字节；没有字节 sh 不 `exec`。这条推论是阶段 5 判“从未放行 → 意图 `failed`”的依据（§6.3），它不要求进程已被证明停止。
- **令牌与环境在 spawn 时固定。** 包装进程继承 git/gh 的环境（含 `OSSTACK_BRIDGE_PUSH_TOKEN`/`GH_TOKEN`，`bridge.ts` L99–111）。取令牌的 `await` 落在 L2 之前，不在栅栏与放行之间，所以首轮发布路径的 `appCredentialRunner`（L98 的 `await publisherToken()`）在 W13 之下已经满足“栅栏与写入之间无异步”（§6.3 对 5 附录的影响）。
- **超时与取消。** 超时或 `AbortSignal` 只在 L6 之后杀进程组；L5 之前的取消由 `fence()` 拒绝（runner 的栅栏查 `state === 'delivering'` 等，`runner.ts` L402–403）。现有发布路径**不传递** `signal`：`ports.publish` 收到 `signal` 但不使用（`ports.ts` L180），`openPullRequestToGitHub` 与 `runner.run` 的选项只有 `cwd`/`timeoutMs`（`delivery.ts` L424–427、L458–460）。W13-C2 把 `signal` 从 `publish` 经 `openPullRequestToGitHub`、`DeliveryCommandRunner.run` 的选项、`appCredentialRunner`、`BridgeExec` 一路传到 `runGatedProcess`；本地写入经 `runHardenedGit` 已有的 `signal`（L54、L114）。
- **重试。** `pushCandidate` 的 3 次重试（`delivery.ts` L418–431）每次都是新的一行；上一行到 `stopped` 之前，第二行插不进去（`engineering_host_process_mission_open`）。

### 4.3 接入点

| 接入点 | 改动 |
|---|---|
| `runHardenedGit`（`hardened-git.ts` L96 起） | 新增可选 `gate?: { journal; launch; fence }`。有 `gate` 时经 `runGatedProcess` 启动，其余（参数校验、环境、输出上限、超时）不变；无 `gate` 时行为不变 |
| `commitPlumbing`（`plumbing.ts` L306）、`createNoCheckoutWorktree`（L213）、`materializeCommit`（L199–200） | 选项新增 `gate`，传给 `update-ref`、`worktree add`、真实索引上的 `read-tree` 与 `update-index --refresh`（每次调用一条登记）；`commitPlumbing` 的 `fence`（L304）作为 `gate.fence` |
| `restoreWorkspace`、`commitWorktree`（`ports.ts` L244、L285） | 同上，`fence` 为 runner 的写入栅栏（`assertWriter`） |
| `DeliveryCommandRunner`（`packages/github`） | `run(command, args, options)` 的 `options` 新增 `gate`；`defaultDeliveryCommandRunner`（L135）在有 `gate` 时经 `runGatedProcess`；runner 对象新增 `gated: true` 声明 |
| `BridgeExec`/`defaultBridgeExec`（`bridge.ts` L49–62）、`appCredentialRunner`（L75–117） | `exec` 的选项透传 `gate`；`credentialed` 把 `gate` 原样交给 `exec` |
| `fencedDeliveryRunner`（`ports.ts` L74–95） | `push` 与 `pr create` 不再在 `inner.run` 之前调用 `beforeRemoteMutation`，而是把它作为 `gate.fence` 传下去；`inner.gated !== true` → 抛 `CONTAINED_PUBLICATION_UNGATED`，不运行。push URL 复查（L86–90，异步）仍在 spawn 之前 |
| runner `deliver`（`runner.ts` L401–406） | `beforeRemoteMutation` 不变（仍同步、仍写 `remote_mutation`），只是现在它在 L5 的事务里被调用 |

测试替身（`delivery.test.ts`、`contained-mission-*.test.ts` 里的假 runner）要么声明 `gated: true` 并按协议调用 `journal` 与 `fence`，要么在 push/PR 测试中被拒绝。一条静态测试扫描 `packages/cli/src/contained-mission-*.ts` 与 `packages/github/src/delivery.ts`：`'push'`、`['pr','create']` 只能出现在经 `fencedDeliveryRunner` 的路径上。

## 5. 重启恢复

### 5.1 何时运行、处理谁

`recover()` 在服务启动时运行一次（`contained-mission-rpc.ts` L54–55），之后由 `retry_stop_check` 决定（`host.ts` L145–149）与 §10 决定 2 的低频复查触发。处理对象：所有 `state<>'stopped'` 且 `owner_generation` 小于当前 generation 的行，或当前进程里没有对应活动句柄的行（M8 演练里的僵尸 owner 场景：旧 owner 的行 generation 较小）。当前 owner 正在运行的登记不受影响（与 `recoverOne` 跳过 `inFlight` 的写法相同，L180）。

### 5.2 单条登记的判定

`classifyHostProcess(record, probe)`（纯函数，`host-process.ts`）+ 注入的 `HostProcessProbe`（真实实现见 §5.3），输出 `{ kind: 'stopped', proof } | { kind: 'unknown', reason }`；恢复不发任何信号（本节末）：

| # | 条件 | 结果 |
|---|---|---|
| 0 | 当前启动会话标识可读且 ≠ `boot_id` | `stopped(rebooted)`：上一次启动的进程都已不存在 |
| 1 | 标记校验失败：路径不存在、不是普通文件、dev/ino 与记录不同 | `unknown(marker_lost)` |
| 2 | `lsof` 阳性对照失败（§5.3） | `unknown(holder_scan_unavailable)` |
| 3 | `state='launching'`（没有 pid）：标记无人持有 | `stopped(never_registered+marker_unheld)` |
| 4 | `state='launching'`：标记有人持有 | 等待最多 5 秒（包装进程读到 EOF 后自行退出）；仍持有 → `unknown(unregistered_holder)` |
| 5 | 有 pgid：`kill(-pgid, 0)` 为 `ESRCH`，且标记无人持有 | `stopped(group_empty+marker_unheld)` |
| 6 | 有 pgid：进程组为空，但标记有人持有 | 逃出进程组的持有者：`unknown(escaped_holder)`。不杀（下面“恢复不发信号”） |
| 7 | 有 pgid：进程组存在；leader（pid = pgid）存在，其 pgid = 记录的 pgid，启动时间可读且 ≠ `leader_start`（两者都非 NULL） | pid 已被复用（§5.3 假设 A1）→ 原进程组已空；再看标记：无人持有 → `stopped(leader_reused+marker_unheld)`；有人持有 → `unknown(escaped_holder)`。启动时间**不等**只用来得出“已停止”，从不用来授权信号 |
| 8 | 有 pgid：进程组存在；leader 启动时间等于 `leader_start` | `unknown(group_alive)`。`registered`（从未放行）的包装进程在父进程死亡后读到 EOF 自行退出，所以先等最多 5 秒再判；`released` 直接 `unknown` |
| 9 | 有 pgid：进程组存在，但 leader 不存在，或 `leader_start` 为 NULL，或 `ps` 读不到 | `unknown(group_present)`，不杀 |
| 10 | 任一探针抛错 | `unknown(probe_failed)` |

`stopped` 时 `journal.stopped(...)` 写入证明与观测细节（`stop_detail_json`：探针结果、复用判断、等待时长），然后删标记。`unknown` 不写行，只写一条 `host_process_unproven` 事件（原因码），供 `mission status` 显示。

**恢复不发信号。** macOS 的 `lstart` 只到秒，同一秒内的 pid 复用会让“启动时间相等”成立（`graph-process-identity.ts` L24–40 因此不把它当作身份）；按 `lsof` 列出的 pid 发信号也有“查到之后、发出之前”被复用的竞态。所以恢复路径**从不**对任何 pid 或进程组发信号，只观察：相等或读不到 → `unknown`。从未放行的包装进程不需要信号——父进程已死，`read` 读到 EOF 就退出。在线路径（父进程仍活着）只在**尚未观察到 leader 退出**时杀进程组（§4.2 L7）：此时子进程未被回收，pid 与同号进程组都不会被复用。leader 退出之后（L8）只观察，不再发信号。

**“从未放行”与“已停止”分开用。** 任何一条判定都不改变 `released_at`，所以对远端结果的判断（§6.3）与进程是否停止相互独立。

### 5.3 macOS 上的探针

| 探针 | 实现 | 说明 |
|---|---|---|
| 启动会话标识 | `sysctl -n kern.bootsessionuuid`（macOS）；Linux `/proc/sys/kernel/random/boot_id`（同 `graph-process-identity.ts` L15） | 守护进程启动时读一次并缓存；读不到 → 记 `'unknown'`，第 0 条不适用 |
| 进程组是否为空 | `process.kill(-pgid, 0)`，`ESRCH` 为空（同 `codex-proxy.ts` L163–165 `processGroupEmpty`） | pid 复用不会让它误报“空”：同号进程组存在时 pid 不会被分配（假设 A1），所以误差只会是“非空” |
| leader 身份 | `ps -o pgid=,lstart= -p <pgid>`，`LC_ALL=C`；Linux 用 `/proc/<pid>/stat` 的 `starttime`（同 `graph-process-identity.ts` L14–22，精确到时钟滴答） | macOS 的 `lstart` 只到秒（`graph-process-identity.ts` 因此把它标为“粗略、仅诊断”，L24、L33–34）。本文只在**不等**时使用它（判复用），相等一律当作“同一进程”，所以秒级精度只会让结果更保守 |
| 标记持有者 | `lsof -n -P -F pfDi -- <marker> <control>`（逐文件输出 pid、fd、设备号、inode） | 解析为（pid, fd, dev, ino）记录，按 dev/ino 归到标记或对照，不按 pid 归。要求：退出码为 0（有持有者）或 1 且 stdout 只含对照的记录；stderr 为空；对照恰有一条记录，pid 为守护进程自身、dev/ino 等于对照文件的 `fstat`。任何解析失败、多余字段错误、stderr 非空 → `holder_scan_unavailable`。对照只证明 `lsof` 能读本用户进程的描述符表；“某个同用户进程的描述符表读取失败而 `lsof` 不报错”无法从外部排除，这一点与 `lsof` 本身的可靠性一并列入 §5.4 |

**假设 A1（pgid 不被复用）。** POSIX 要求：进程组 ID 仍被某个进程组使用时，不得把它分配为新进程的 pid。所以“pid = pgid 的进程存在、在 pgid 组里、启动时间与登记不同”说明原组曾经变空（否则这个 pid 不会被分配），之后的新进程自建了同号的组。XNU 的 pid 分配是否检查进程组与会话，W13-B 开工时对照 `bsd/kern/kern_fork.c` 的 `forkproc` 核实并把结论写进 PR；不成立则删掉第 7 条（复用时只能 `unknown` 等人处理），其余各条不依赖 A1。第 7 条另外要求标记无人持有，所以即使 A1 不成立，误判也需要“原组的某个进程仍活着、却关掉了继承的 fd 3”。

**为什么不用 flock。** `flock` 同样不依赖 pid，但 macOS 没有 `flock(1)` 命令，Node 不暴露 `flock(2)`，包装进程又必须是不经模型、不加依赖的 `/bin/sh`。`lsof` 是系统自带的只读工具，只在恢复与收尾证明时运行。

### 5.4 证明的强度

与 Mission 设计 §9 对执行器的说明同一口径：进程组为空 + 标记无人持有，**不**等于“全部后代已停止”。一个后代若既 `setsid` 离开进程组、又关闭继承的 fd 3，就不会被发现。本地写入（`update-ref`、`worktree add`、索引写入）经 `runHardenedGit`：禁用 hooks、fsmonitor、属性文件，`GIT_CONFIG_GLOBAL=/dev/null`、`GIT_CONFIG_NOSYSTEM=1`（`hardened-git.ts` L3–10、L76–93），没有外部帮助程序。**发布路径不是这样**：`fencedDeliveryRunner` 只加了 hooks、fsmonitor 与协议限制（`ports.ts` L75–76），环境来自 `githubDeliveryEnvironment()`（`delivery.ts` L120–131），全局与系统 git 配置仍生效。主机凭证模式下会运行用户配置的 `credential.helper`（如 `git-credential-osxkeychain`）与 `ssh`/`core.sshCommand`；App 模式清掉了凭证帮助程序（`bridge.ts` L104）但没清 `core.sshCommand` 等其他配置。这些程序不在本文能担保的范围内。所以：证明的强度按 T12 的实测分配置记录；逐项 `-c` 清空配置的做法覆盖不全，W13-C2 改为在 App 模式下与本地写入一样设 `GIT_CONFIG_GLOBAL=/dev/null`、`GIT_CONFIG_NOSYSTEM=1`（App 模式只需内联帮助程序，不依赖用户配置）。这会改变传输：全局配置里的 `http.proxy`、`http.sslCAInfo` 等也随之失效，而 App 模式的读取仍走主机 runner（`bridge.ts` L114），URL 复查（`ports.ts` L84–90）读到的配置与推送用的配置可能不同。所以 App 模式定义一份**显式传输配置**：预检时从主机配置读出白名单项（`http.proxy`、`https.proxy`、`http.sslCAInfo`、`http.sslCAPath`，只接受 `https://github.com/` 作用域或全局值），以 `-c` 固定传给 App 模式的 `remote get-url --push`、`push`、`ls-remote` 三类命令；白名单之外仍影响 `github.com` 的项（`url.*.insteadOf`、`http.*.extraHeader`、`core.sshCommand` 等）存在即预检失败（`CONTAINED_BRIDGE_TRANSPORT_UNSUPPORTED`）；主机凭证模式保留用户配置，在 `mission status` 与证据里标 `stop_proof_scope: "host_credential_helpers_untrusted"`，§10 决定 6 决定是否要求主机凭证模式也只用经 T12 验证过的帮助程序。证据记为 `stop_proof` 的具体码（`group_empty+marker_unheld` 等），不复用执行器的 `group_empty+sandbox_inherited`。

### 5.5 Mission 层的处理

`recoverOne`（`host.ts` L193–211）改为先处理该 Mission 的未结登记，再走原逻辑：

| Mission 状态 | 登记全部 `stopped`（含本轮证明的） | 仍有 `unknown` |
|---|---|---|
| 终态 | 原逻辑（执行器停止义务、释放认领） | 不改状态（终态不可转换）；认领保持（触发器）；该 Mission 继续被 `listOutstanding` 扫描 |
| `executing`、`verifying`、`cancel_requested` | 原逻辑 `settleStop` | `stop_unknown`（`host_process_unproven:<op_id>`） |
| `stop_unknown` 且 `stop_obligation=1` | 原逻辑 `settleStop`，但 `stopProof` 的证据要附上登记的证明列表 | 保持 |
| `delivering`（孤儿） | 原逻辑（留给 tick 幂等重试） | `stop_unknown`（`host_process_unproven:<op_id>`）。**新规则**：孤儿 `delivering` 只在没有未结登记时才交给重试（§9 偏差 3） |
| `authorized`（孤儿 `worktree add`） | 见下“只有主机登记的停止义务” | `stop_unknown`（`host_process_unproven:<op_id>`） |
| `needs_reconciliation`、`awaiting_decision` 等 | 原逻辑 | `stop_unknown`（`host_process_unproven:<op_id>`） |

`stop_unknown` 的出口：`settleStop`（`host.ts` L214–226）在证明之后按 `halted` 事件里记录的 `from` 分流：原状态是 `delivering` 的 → `awaiting_decision`（`publication_failed:host_process_recovered`），人用 `approve_publication` 回到 `revalidating`，重试仍是首轮的幂等路径（同 head、复用同一 PR）；其他 → 原规则（`cancel_requested` → `cancelled`，否则 `needs_reconciliation`）。`retry_stop_check`（`host.ts` L145–149）的前提从“`stop_unknown`”放宽为“`stop_unknown`，或终态且有未结登记”，后者只做登记证明与认领释放，不转换状态。

**只有主机登记的停止义务。** 转入 `stop_unknown` 总会置 `stop_obligation=1`（store L158），而 `stopProof`（L235–252）只在找到此前的 `executing`/`verifying` 转换时才给证明（L237–238）。孤儿 `worktree add` 发生在 `authorized`，此前没有这两种转换，证明永远给不出。所以 `halt(…,'stop_unknown','host_process_unproven:…')` 的事件负载记 `prior_obligation`（转入前的 `stop_obligation`）与 `from`；`stopProof` 对这种 `stop_unknown` 的规则改为：登记全部 `stopped`，且 `prior_obligation=0` 或原有的执行器/验证证明成立。出口按 `from`：

- `delivering` → `recordStopEvidence`，然后 `awaiting_decision(publication_failed:host_process_recovered)`（见上）；候选在停机时保留（store L243），`approve_publication` 回到 `revalidating`。
- `authorized` → 恢复只做两件事：`recordStopEvidence`（附登记证明；此时没有未结登记，触发器放行），然后 `halt(awaiting_decision, workspace_recovered)`。`stop_unknown → awaiting_decision` 合法：`transition` 对 `HALTS` 中的目标不查 `NEXT`（store L138），`awaiting_decision` 在 `HALTS` 中（L36）。恢复本身**不**物化工作区：Mission 仍为 `stop_unknown` 时插入门禁拒绝任何新登记（§3.3）。人用新决定 `resume_workspace`（runner 新方法，前提：`awaiting_decision` 且原因为 `workspace_recovered`）：核对 worktree 目录存在、`git worktree list` 列出它、`refs/heads/<branch>` 等于 `start_commit`、`HEAD` 指向该分支、仓库配置摘要等于 `inspectRepoConfig` 的结果；成立则经门控的 `materializeCommit` 重新物化（此时 `awaiting_decision`、`stop_obligation=0`，插入门禁放行），写 `workspace_created`（`runner.ts` L188–189 与 `recordedGitDir` L204–206 依赖它），转 `workspace_ready`（store 的 `NEXT.awaiting_decision` 加 `workspace_ready`，代码改动，不需要迁移；DDL 的 `engineering_contained_gates` 不限制这一转换）。核对不成立 → `awaiting_decision(workspace_failed:host_process_recovered)`，只能 `abandon`；认领可释放，worktree 目录保留由 `pnpm scratch:clean -- --worktrees` 清理。`resume_workspace` 中途崩溃：Mission 仍为 `awaiting_decision(workspace_recovered)`，未结的物化登记按 §5.5 再走一遍，人可重试决定。
- 其他 → 原规则。

`stopProof` 对其他 `stop_unknown` 的处理不变；`settleStop` 在调用 `recordStopEvidence` 之前先确认没有未结登记（代码检查；触发器是第二道），证据负载里加 `host_processes: [{ op_id, proof }]`。

## 6. 与现有机制的关系

### 6.1 停止义务与取消

- **在线收尾失败。** L8 证明不成立时，调用方（runner 的 `applyPatch`、`discardChanges`、`adoptWorktree`、`createWorkspace`、`deliver`）把 Mission 停到 `stop_unknown`（`host_process_unproven:<op_id>`），不能按“命令失败”走 `awaiting_decision`/`needs_reconciliation`：后者允许 `discard_changes` 等决定再次写分支，而插入门禁会拒绝它的登记，人看到的是一个无法执行的决定。
- **取消。** `runner.cancel`（L164 起）与 `settleCancel`（L490 起）在“没有活动句柄且 `stop_obligation=0`”时直接转 `cancelled`；W13 加一个条件：没有未结登记。有未结登记时 Mission 停在 `cancel_requested`，由恢复或 `retry_stop_check` 证明后再转（触发器 `engineering_contained_host_process_gate` 是第二道）。取消正在运行的登记走 `AbortSignal` → L7 杀进程组 → L8 证明 → `settleCancel`；发布路径要先补上 `signal` 的传递（§4.2“超时与取消”）。
- **认领。** 只有登记全部 `stopped` 后才能释放（触发器）。这同时覆盖重启恢复（L202）与 5 附录 §5.2 的 `releaseClaim(child,'revision_settled')`。

### 6.2 owner 栅栏与 M8 的僵尸 owner

M8 演练（`contained-mission-recovery.test.ts`）里，僵尸 owner 的每次账本写入都被 `stale_owner` 拒绝，但“已经通过栅栏的那一次写入……可能在接管之后完成”（Mission 设计 §9 M8 第 2 点）。W13 之下：僵尸的 L1、L4、L5 都是 owner 栅栏下的写入，接管之后任何一步都写不进去，所以它不能再派生被覆盖的进程，已派生的也放不行（L5 回滚、杀进程组）。接管前已经放行的那一次，在新 owner 的 `recover()` 里是 generation 较小的未结行，按 §5.2 判定；进程仍在时 Mission 停 `stop_unknown`，直到它退出。M8 第 2 点的残余风险因此关闭，替代为“可见的 `stop_unknown`”。

### 6.3 阶段 5 的栅栏与意图对账

5 附录 §2 的三条要求，在本文中的对应：

| 5 附录要求 | 本文 |
|---|---|
| 1 先登记、后变更，放行即授权；spawn 后、放行前崩溃没有推送 | §4.2 L1–L6；`released_at IS NULL ⇒ 未 exec`；sh 在父进程死亡时读到 EOF 退出，不需要超时 |
| 2 没有登记回执即视为未知 | **细化**：区分两个问题。①远端是否可能被写：只看 `released_at`。没有行（意图之后、L1 之前崩溃）或 `released_at IS NULL` ⇒ 不可能，意图可以判 `failed`。②进程是否已停止：只看 `state='stopped'`；没有 pid（`launching`）时用标记证明（§5.2 第 3–4 条），证明不了即 `unknown`，链保持阻塞。5 附录 §5.5 表中“从未放行 → 意图 `failed`”与此一致；第 41 行“意图 `pending` 而操作记录没有 pgid → 按 `stop_unknown` 处理”应改为本条 |
| 3 三个崩溃点测试 | §8 T3 |

5 附录需要回改的地方（由 5-C 的作者在合并前处理，本文不改那份文档）：

1. **操作 id 与意图 id。** 5 附录第 40 行“意图 id 即操作 id”改为：登记行有独立的 `op_id`，以 `intent_id` 列绑定意图（唯一索引）。
2. **栅栏位置。** 5 附录 §5.3 第 4 步与 §5.4 的“spawn 包装进程并登记 pgid → `beforeRemoteMutation('push')` → 写放行信号”即本文 L2–L6；`assertPublishable` 作为 `fence` 传入 `journal.release`。
3. **事务边界。** `journal.release` 与 `journal.stopped` 是顶层事务（§3.4），不能放进 5 附录 §5.3 第 6 步的确认事务。顺序固定为：推送退出 → `stopped` 单独提交 → 读回 → 确认事务。两次提交之间崩溃，恢复看到登记已 `stopped`、意图仍 `pending`，按 5 附录 §5.5 继续（T15）。
4. **令牌预取。** 有了放行门，栅栏与放行之间天然没有 `await`；取令牌在 spawn 之前，无论是否 `await`。`tokenCredentialRunner`（5 附录 §5.3 第 4 步）不再是必需的，但保留无害。
5. **同一远端分支的并发。** `engineering_host_process_remote_open` 让同一远端分支在上一条推送登记未证明停止之前插不进新登记，跨 Mission 生效（修订子 Mission 推的是根 Mission 的远端分支）。`assertPublishable` 可以直接依赖这一点，另报更清楚的错误码。
6. **终态子 Mission 的未结推送。** 与 5 附录第 101 行一致：终态 Mission 不转 `stop_unknown`，未结登记阻止认领释放；链因下一轮派发要求“上一个子 Mission 的认领已释放”（5 附录 §5.2）而被阻止。

## 7. 失败与状态

| 崩溃或故障点 | 登记行 | 远端/分支可能被写 | 恢复后的进程判定 | Mission |
|---|---|---|---|---|
| L0 之后、L1 之前 | 无（只有孤儿标记） | 否 | 无进程；清理孤儿标记 | 原规则 |
| L1 之后、L2 之前 | `launching` | 否 | 第 3 条 `stopped` | 原规则 |
| L2 之后、L4 之前 | `launching` | 否（sh 读到 EOF） | 第 3 条；sh 仍在退出途中时第 4 条等待 | 原规则；等待超时 → `stop_unknown` |
| L4 之后、L5 之前 | `registered` | 否 | 第 5 条；包装进程仍在退出途中时第 8 条等待，超时 `unknown` | 原规则；`unknown` 时 `stop_unknown` |
| L5 事务回滚（栅栏拒绝） | `registered` → 在线 L8 `stopped(never_released)` | 否 | — | 调用方按栅栏原因停 |
| L5 提交之后、L6 之前 | `released` | 视为可能（实际未写） | 第 5 条 `stopped` | 原规则；首轮发布按幂等重试 |
| L6 之后、程序运行中 | `released` | 可能 | 第 8/9 条 `unknown`，进程退出后第 5 条 | `stop_unknown`，退出后按 §5.5 出口 |
| 程序退出、L8 之前 | `released` | 可能 | 第 5 条 | 按 §5.5 出口 |
| L8 证明不成立（在线） | `released` | 可能 | 留给恢复 | 调用方转 `stop_unknown`（§6.1） |
| 父进程在放行后被杀，子进程继续 | `released` | 可能 | `unknown` 直到退出 | `stop_unknown` |
| 放行门永不打开（父进程活着） | `registered` | 否 | 在线：杀组 + 证明 | 调用方按栅栏原因停 |
| 宿主重启 | 任意 | 视 `released_at` | 第 0 条 `stopped(rebooted)` | 按 §5.5 出口 |
| 标记被删或替换 | 任意 | 视 `released_at` | `unknown(marker_lost)`，需人处理（§10 决定 5） | `stop_unknown` |
| pid 复用 | `registered`/`released` | 视 `released_at` | 第 7 条（启动时间不等）`stopped`；相等或读不到 → `unknown` | 同上 |

## 8. 测试

| # | 层 | 场景 | 通过标准 |
|---|---|---|---|
| T1 | agents 单元，真实 `/bin/sh` 与假程序 | 正常路径：登记→放行→退出→证明 | `stopped(group_empty+marker_unheld)`，退出码与输出透传；标记已删 |
| T2 | 同上 | 放行门永不打开（`fence` 抛错） | 假程序的启动哨兵文件不存在；`stopped(never_released)`；调用方收到栅栏错误 |
| T3 | agents 集成，崩溃线束 | 在子 Node 进程里运行 `runGatedProcess`，经 `OSSTACK_TEST_HOST_PROCESS_CRASH_AT=after_launching|after_spawn|after_registered|after_release_commit|after_release_write` 在对应点 `process.kill(process.pid,'SIGKILL')`；另一进程打开同一账本做恢复 | 前三点：哨兵不存在，恢复后 `stopped`、`released_at` 为 NULL；`after_release_commit`：哨兵不存在（EOF），恢复后 `stopped`、`released_at` 非 NULL；`after_release_write`：假程序持有标记睡眠 → 恢复 `unknown`，Mission `stop_unknown`；假程序退出后 `retry_stop_check` → `stopped` |
| T4 | agents 单元，注入 `HostProcessProbe` | pid 复用：leader 启动时间不同 / 相同（模拟同秒复用）/ NULL；leader 不存在而组存在；探测与观察之间进程退出 | 分别为 `stopped(leader_reused+marker_unheld)` / `unknown(group_alive)` / `unknown(group_present)` / `unknown(group_present)`；所有恢复用例中探针记录的信号调用次数为 0 |
| T5 | 同上 | 标记被删、被替换（dev/ino 不同）、`lsof` 阳性对照缺失、`ps` 失败 | 全部 `unknown`，原因码各异 |
| T6 | 同上 | 启动会话标识不同 | `stopped(rebooted)` |
| T7 | agents 集成 | 假程序派生一个 `detached` 的孙进程持有 fd 3 后自身退出 | 进程组空而标记被持有 → `released` 时 `unknown(escaped_holder)`；孙进程退出后 `stopped` |
| T8 | core 单元 | DDL：插入非 `launching` 行或带预填列、在已有事务中调用四个写方法、`synchronous` 非 FULL、放行先于登记、状态倒退、改不可变列、删行均被拒；同 Mission 第二条未结登记、跨 Mission 同远端分支第二条未结登记被拒；`stop_unknown`/`cancel_requested`/终态/`stop_obligation=1` 时插入被拒；有未结登记时释放认领、`supersedes` 交接、转 `cancelled`/`pr_opened`、清 `stop_obligation` 均被拒 | 全部按预期 `RAISE` |
| T9 | core 单元 | `containedUpgradeHolds`/`listOutstanding` 计入有未结登记的 Mission（含终态） | 计入 |
| T9b | cli 演练 | `worktree add` 在各崩溃点（L1 后、L4 后、L6 后）孤儿化；`git_index_write` 被持有时 `restoreWorkspace`；被杀后遗留 `index.lock` | 分别：证明后按 §5.5 `authorized` 出口（工作区完整 → `resume_workspace`，不完整 → 只能 `abandon`）；恢复等待证明，不并发物化；证明后陈旧锁被删除并记事件 |
| T15 | cli 演练，真实 store 与触发器 | 正向全链路：`authorized` 孤儿 → 证明 → `awaiting_decision(workspace_recovered)` → `resume_workspace` → `workspace_ready` → 执行；孤儿 `delivering` → `retry_stop_check` → `approve_publication` → `pr_opened`；验证中崩溃且无主机登记（原 `stopProof` 路径不变）；取消到 `cancelled`；阶段 5 形状：在 `stopped` 单独提交之后、确认事务之前注入崩溃，恢复按 5 附录 §5.5 走确认或 `reconcileReceipt`（5-C 前用桩事务） | 每条路径都走到目标状态，触发器无误拒 |
| T16 | agents 单元 | 在线 L8：`close` 之后到证明之间模拟 pgid 复用 | 收尾不发任何信号，结果为 `proof: null` 或观察成立 |
| T17 | cli 集成 | App 模式显式传输配置：经本地 HTTPS 代理与自签 CA 的认证推送；存在 `insteadOf` 时预检失败 | 推送、`ls-remote`、URL 复查读到同一配置；预检按预期拒绝 |
| T10 | cli 演练（`contained-mission-recovery.test.ts` 扩展，`gitBinary` 指向会阻塞的假 git） | 提交途中崩溃，`update-ref` 被持有 | Mission `stop_unknown`；`discard_changes` 被拒（`stop_evidence_required` 或插入门禁）；假 git 退出后 `retry_stop_check` → `needs_reconciliation`；之后 `discard_changes` 成功且分支等于 `expected_head`（这就是计划 W13 的验收） |
| T11 | 同上 | 首轮推送中崩溃（假 git push 持有）；推送中取消；`gh pr create` 中崩溃；僵尸 owner 在接管后放行 | 依次：`stop_unknown` → 退出后 `awaiting_decision(publication_failed:host_process_recovered)` → `approve_publication` 后幂等重试成功；取消停在 `cancel_requested` 直到证明，再 `cancelled`；同推送；僵尸的放行事务因 `stale_owner` 回滚、哨兵不存在 |
| T12 | agents 真机探针（macOS 本机与 CI） | ①真实 `git push` 到本地裸仓库（测试内 `-c protocol.file.allow=always`，`--receive-pack` 指向睡眠脚本）；②HTTPS 推送到本地 `git http-backend`（经 `git-remote-https`），分别配置 App 模式的内联凭证帮助程序与一个外部 `credential.helper` 脚本；③ssh 推送到 `localhost` 的 sshd（本机有时运行，CI 跳过），`core.sshCommand` 指向记录自身 fd 的脚本；④真实 `gh pr create --help` 与一次 `gh api` 到本地假服务器 | 每种情况下，所有派生进程（`git-remote-https`、凭证帮助程序、`ssh`、gh 调起的 git）都在进程组内并持有标记；结果逐项写进 PR。不成立的配置在 §5.4 中列为“不支持证明”，W13-C2 对它们拒绝发布 |
| T13 | cli 静态 | push 与 `pr create` 只经 `fencedDeliveryRunner`；`fencedDeliveryRunner` 拒绝 `gated !== true` 的 runner | 通过 |
| T14 | 性能 | 每次被覆盖操作的附加耗时（标记、4 次事务、`ps`、`lsof`） | 记入 PR；目标单次 < 250 ms（本机），不进 `cli-entry.ts`/`bin.ts` 顶层导入 |

**变异检查**（手工，记入 PR 描述，每个变异都必须有测试失败）：放行字节先于放行记账；spawn 先于 `launching` 行；栅栏放在 spawn 之前而不是放行之前；收尾只看进程组不看标记；把 `leader_start` 相等当作复用；`leader_start` 为 NULL 时允许杀；去掉 `lsof` 阳性对照；去掉认领触发器；去掉远端分支唯一索引；去掉插入门禁；`settleCancel` 不查未结登记；孤儿 `delivering` 在有未结登记时仍交给重试。

## 9. 与上位文档的偏差

| # | 偏差 | 理由 |
|---|---|---|
| 1 | 计划写“pgid 记入账本或启动日志”；本文用新表 + 放行门 + 持有标记，证明为“进程组为空且标记无人持有” | 只记 pgid 有三个缺口：spawn 与记账之间的窗口、pid 复用、逃出进程组的帮助进程；还需要数据库层的认领与终态门禁（§3.1、§4.1） |
| 2 | 覆盖范围包括 `gh pr create`、`worktree add` 与真实索引写入，不包括对象写入与临时索引 | §2 的判断标准；真实索引写入因 `index.lock` 而覆盖（第 1 轮审计） |
| 3 | 孤儿 `delivering`、`authorized` 等状态在有未结登记时也进 `stop_unknown`；`stop_unknown` 来自 `delivering` 的，证明后回到 `awaiting_decision(publication_failed:…)` 而不是 `needs_reconciliation` | Mission 设计 §9 偏差一把孤儿 `delivering` 留给重试，前提是旧推送已结束；`needs_reconciliation` 的两个决定都不恢复发布 |
| 4 | 持有标记放在 `$OSSTACK_HOME/contained/host-processes/`，不在 scratch 根 | `pnpm scratch:clean` 删 `runtime/`，标记被删只能判未知（§4.1）；与 Mission 设计 §9 启动日志放“守护进程 home 证据根”的做法一致 |
| 5 | 5 附录要求 2 细化为“远端看 `released_at`，进程看 `stopped`”；操作 id 与意图 id 分开 | §6.3 |
| 6 | 恢复从不发信号，只观察；在线路径才杀进程组 | macOS 启动时间只到秒、`lsof` 查到的 pid 有复用竞态，恢复时无法安全地确认信号对象；计划 W13 的验收也要求“进程退出后才可结算” |
| 7 | App 模式的发布路径改用与本地写入相同的配置隔离（`GIT_CONFIG_GLOBAL=/dev/null`、`GIT_CONFIG_NOSYSTEM=1`） | 否则全局配置里的帮助程序不在证明范围内（§5.4） |
| 8 | `authorized` 的孤儿恢复补写 `workspace_created` 并新增决定 `resume_workspace` | 否则只有主机登记的 `stop_unknown` 无法证明、也无法回到执行（§5.5） |

## 10. 需要用户做的决定

1. **恢复不发信号（已定为设计，不是选项）**：第 1 轮审计后去掉了“身份核对后由恢复杀进程”的方案（§5.2 末）。需要你确认的是后果：已放行的孤儿（例如卡住的 `git push`）没有上限地运行时，Mission 一直是 `stop_unknown`，只能由人在宿主机上自行结束该进程（`mission status` 显示 pgid 与命令种类）后 `retry_stop_check`。
2. **低频复查。** (a) 推荐：服务 tick 每 60 秒对有未结登记的 Mission 跑一次 §5.2（先 `kill(-pgid,0)`，空了才跑 `lsof`），证明成立即结算；(b) 只在重启与 `retry_stop_check` 时结算（与执行器的现有做法一致）。
3. **迁移号。** 54（等 52、53 先合并）还是合并时取下一个空号（§3.2）。
4. **标记位置**：`$OSSTACK_HOME`（推荐，偏差 4）还是 scratch 根 `runtime/`（违反可证明性，但符合 scratch 规则字面）。
5. **`marker_lost` 的人工出口。** 标记被删时证明永远不成立。(a) 推荐：只能等宿主重启（第 0 条）或 `abandon`（认领不释放，worktree 冻结）；(b) 增加一个需要 TTY 输入登记 `op_id` 的 `mission decide --decision attest_host_process_stopped`，人在确认 `ps` 后签字结算（与“用户不能用确认代替停止证据”，Mission 设计 §9，相冲突，所以不推荐）。
6. **主机凭证模式的帮助程序**：(a) 推荐：允许，证据标 `host_credential_helpers_untrusted`；(b) 只允许 T12 验证过的帮助程序，其余拒绝发布。
7. **W13-C 拆成两个 PR**（本地写入、远端写入）还是一个（§11）。

## 11. PR 拆分

每个 PR 目标 `main`，一个 PR 一件事。

| PR | 内容 | 依赖 |
|---|---|---|
| W13-0 | 本文（含审计结果）；计划第 33 行改为“设计中” | — |
| W13-A | 迁移 54 的表、索引、触发器；`engineering-host-process-store.ts`；T8、T9；升级测试版本号 | W13-0；迁移号见决定 3 |
| W13-B | `host-process.ts`（包装进程、标记、`runGatedProcess`、`classifyHostProcess`、macOS/Linux 探针）；`runHardenedGit` 的 `gate` 选项；T1–T7、T12、T14；核实假设 A1 | W13-0（与 W13-A 互不依赖，可并行） |
| W13-C1 | 本地写入接入：`update-ref` 三处、`worktree add`、`materializeCommit` 的 `read-tree` 与 `update-index --refresh`（首次建工作区与 `restoreWorkspace` 两条路径）；陈旧 `index.lock` 清理；runner 在线收尾失败转 `stop_unknown`；`recoverOne`/`settleStop`/`stopProof`/`retry_stop_check`；`resume_workspace`；取消门；T9b、T10、T15 的本地部分；Mission 设计 §9 M8 说明改为“已关闭” | W13-A、W13-B |
| W13-C2 | 远端写入接入：`DeliveryCommandRunner`/`BridgeExec` 的 `gate`、`fencedDeliveryRunner` 拒绝未门控 runner、`deliver` 的 `remote_mutation` 进放行事务、孤儿 `delivering` 规则与 `awaiting_decision` 出口；`signal` 传递；App 模式的配置隔离与显式传输配置；T11、T13、T15 的发布部分、T17；计划第 33 行改为“已合并” | W13-C1 |

5-C（阶段 5 的推送）依赖 W13-C2。W13-C2 合并后，`OSSTACK_BRIDGE=1` 之前的首轮发布路径也受益。

每个 PR 开出前照方案 §7：`pnpm build`、`pnpm typecheck`、受影响包测试、CLI 启动预算、Codex 只读审查。新模块从现有懒加载点进入（`ports.ts` 已对桥接懒加载，`host-process.ts` 由 `contained-mission-ports.ts` 静态导入即可，后者只经 `contained-mission-rpc.ts` L140 的动态 `import()` 加载）。

## 12. 审计记录

**第 1 轮（Codex CLI gpt-6-astra，medium，只读，基于初稿）：** 4 个 P1、4 个 P2、0 个 P3。沙箱内无法运行 `ps`，进程语义部分是读源码得出的。逐条核对代码后全部接受：

| 发现 | 核对 | 处理 |
|---|---|---|
| P1 `release` 经 `attention.write` 在已有事务中不提交，外层回滚可抹掉放行记录而字节已写出；新 store 缺 `synchronous=FULL` 检查 | 属实，`attention-store.ts` L86–90；`engineering-contained-store.ts` L202–204 | §3.4：四个写方法必须是顶层事务（`db.inTransaction` 即拒绝），沿用 FULL 检查；5 附录的 `chainStore.transaction` 不能包住它们 |
| P1 macOS `lstart` 秒级相等不能授权 `SIGKILL`；按 `lsof` 的 pid 发信号有复用竞态 | 属实，`graph-process-identity.ts` L24–40 | §5.2：恢复从不发信号；相等即 `unknown`；只在在线路径、子进程未回收时杀进程组；偏差 6、决定 1 改写；T4 断言信号次数为 0 |
| P1 `authorized` 的孤儿 `worktree add` 进 `stop_unknown` 后 `stopProof` 永远无证明，恢复后又缺 `workspace_created` | 属实，store L158；`host.ts` L237–238；`runner.ts` L188–189、L204–206 | §5.5：记 `prior_obligation` 与 `from`，只有主机登记时按登记证明；`authorized` 出口核对工作区、补写事件、新决定 `resume_workspace`；偏差 8 |
| P1 发布路径没有禁用全局/系统 git 配置，凭证帮助程序与 ssh 不在可信集合内 | 属实，`delivery.ts` L120–131；`ports.ts` L75–76 | §5.4：如实降级；App 模式改设 `GIT_CONFIG_GLOBAL=/dev/null`、`GIT_CONFIG_NOSYSTEM=1`（偏差 7）；主机凭证模式标 `host_credential_helpers_untrusted`（决定 6）；T12 加 HTTPS、外部帮助程序、ssh |
| P2 发布路径不传递 `AbortSignal` | 属实，`ports.ts` L180；`delivery.ts` L424–427、L458–460 | §4.2“超时与取消”：W13-C2 把 `signal` 传到 `runGatedProcess` |
| P2 `lsof -F p` 只给 pid，无法区分标记与对照 | 属实 | §5.3：`-F pfDi`，按 dev/ino 归属，严格校验退出码、stderr 与对照记录；残余的不可观测性写入 §5.4 |
| P2 真实索引写入不只是性能问题：孤儿持有或遗留 `index.lock` | 属实，`plumbing.ts` L199–200，`ports.ts` L249 | §2：覆盖为 `git_index_write`；证明后清理陈旧 `index.lock` |
| P2 插入可直接写 `stopped`/`released` 行绕过索引 | 属实（初稿只约束 UPDATE） | §3.3：`engineering_host_process_insert_shape` 只允许 `launching` 且其余列为 NULL；T8 补用例 |

**第 2 轮（Codex CLI gpt-6-astra，medium，只读，基于第 1 轮修订稿）：** 第 1 轮 8 项中 5 项判为已解决，3 项部分解决；新增 3 个 P1、3 个 P2。审计另确认：在“先提交、后写字节”的协议下 `released_at IS NULL ⇒ 程序从未 exec` 成立；顶层事务规则与阶段 5 兼容，前提是 `stopped` 在确认事务之前单独提交。逐条核对：

| 发现 | 核对 | 处理 |
|---|---|---|
| P1 `authorized` 恢复在 `stop_unknown` 中调用门控的物化，被自己的插入门禁拒绝 | 属实（修订稿 §5.5） | §5.5：恢复只记证据并转 `awaiting_decision(workspace_recovered)`；物化移到 `resume_workspace` 决定内；写明中途崩溃的处理 |
| P1 `stop_unknown → awaiting_decision` 不在 `NEXT` 中，两个恢复出口都会 `transition_denied` | **不属实**：`transition` 对 `HALTS` 中的目标不查 `NEXT`（store L138），`awaiting_decision` 在 `HALTS`（L36）；现有 `halt()` 就靠这一点从任意非终态停机 | 不改设计；§5.5 写明依据；T15 用真实 store 走通两个出口 |
| P1 在线 L8 在 `close` 之后再发 `SIGKILL`，子进程已被回收，pid 复用竞态回来了 | 属实（修订稿 L8“必要时再 `SIGKILL` 一次”） | §4.2 L7/L8：只在未观察到 leader 退出时发信号，L8 只观察；§5.2 末同步；T16 |
| P2 App 模式去掉全局配置会改变传输（代理、CA），读与推送的配置不一致 | 属实，`bridge.ts` L114，`ports.ts` L84–90 | §5.4：App 模式的显式传输配置（白名单透传、其余影响 github.com 的项预检拒绝），三类命令共用；T17 |
| P2 真实索引写入未进实施清单，偏差 2 仍写“不包括” | 属实 | §4.3 接入表、W13-C1 范围、偏差 2 修正 |
| P2 测试只覆盖拒绝与崩溃，没有真实 store 的正向恢复链路与阶段 5 事务边界 | 属实 | T15；§6.3 第 3 条写明 `stopped` 与确认事务的顺序 |

两轮之后未再审计。第 2 轮的修改（`resume_workspace`、在线信号规则、App 传输配置）尚未经独立复核；W13-A 开工前建议对 §4.2、§5.4、§5.5 再做一次只读审计。
