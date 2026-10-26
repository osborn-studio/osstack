# 采纳 Session，处理等待决策

[English](engineering-session-adoption.en.md)

`osstack engineering` 用同一个入口采纳已有 Session、显示等待、提交明确回答并观察回复回合。它是显式启用的本地试点。它不启动初始 Agent，不选择 Loop 或 Graph，也不提供通用聊天界面。

完成级别固定为 `observed_turn`：OSStack 确认本 Mission 的回答所触发的回复回合已完成并落库。这个结果不是代码交付、测试通过或部署成功的证明。

当前每个精确决定只能被一个 Mission 采纳一次。即使尚未回答就取消或结束观察，这个决定也不能再采纳；系统返回 `authority_already_adopted`。已有回答取消后也不能换键重答。继续用原 Session 的正式入口处理，或由来源产生具有新身份的新决定。不要伪造 decision ID 来绕过这个限制。

## 1. 启用条件

使用已经准入、处于 `awaiting_decision` 的精确 Task、Run 和 Session。Session 必须具有非空原生会话 ID。试点仅接受默认租户、普通产品选择或允许文本输入的问题。风险批准、任务授权仍使用原来的正式批准入口。

宿主同时设置 `OSSTACK_ATTENTION=1` 和 `OSSTACK_ENGINEERING=1`。使用独立、明确的 `OSSTACK_HOME`。不要用开发 checkout 打开 `~/.osstack` 或保留的生产 home。CLI 不自动启动 daemon。

先通过已有 attention 服务建立精确仓库范围：

```sh
osstack attention watch --task TASK_ID --repo /absolute/repository --default-tenant
```

保存返回的 `scope_id`，并核对 Session 的 Task、Run 和仓库绑定。由宿主管理者准备权限文件，然后按现有运维流程重启该 home 的 daemon。试点没有自动生成宿主权限的命令。

### 宿主身份配置

`OSSTACK_ENGINEERING_AUTH_FILE` 是绝对路径。文件必须由当前宿主用户拥有，权限为 `0600`，是普通文件且不是符号链接。将它放在受信私有 home 内，且位于所有被采纳仓库之外。不要提交它。

文件结构如下。替换全部占位值。摘要和 scope 都是 64 位小写十六进制字符串。

```json
{
  "version": 1,
  "principals": [
    {
      "credential_sha256": "<SHA256 of owner credential>",
      "principal_id": "local-owner",
      "client_session_id": "owner-cli",
      "read_scopes": ["<scope_id>"],
      "write_scopes": ["<scope_id>"],
      "stop_scopes": ["<scope_id>"],
      "operator_scopes": []
    },
    {
      "credential_sha256": "<SHA256 of separate operator credential>",
      "principal_id": "local-stop-operator",
      "client_session_id": "operator-cli",
      "read_scopes": ["<scope_id>"],
      "write_scopes": [],
      "stop_scopes": ["<scope_id>"],
      "operator_scopes": ["<scope_id>"]
    }
  ]
}
```

使用密码学随机的独立凭据。通过受信、仓库外的渠道将原始凭据传给客户端环境变量 `OSSTACK_ENGINEERING_CREDENTIAL`。CLI 只读这个环境变量；它不从权限文件挑选账号。不要把凭据放到命令参数、请求 JSON、日志、报告或仓库里。宿主文件只存 SHA-256 摘要。宿主在每次请求及首次派发前重新读取权限，撤销不会依赖旧缓存。

仅轮换 `credential_sha256`，同时保留相同 principal/client 及权限，不会撤销这个主体已经接受、仍待首次派发的回答。要阻止派发，撤销对应 write grant 或删除该 principal/client 授权行。宿主在派发前重读主体授权，不把凭据哈希变化等同于撤权。保留独立的 read + stop operator 恢复通道。

这是受信进程 profile。权限文件不能隔离同一 UID 下的恶意 Worker。旧的本地 socket 接口（例如 `session.send`、`attention.answer`、`attention.abandon-receipt`、`task.cancel`）仍可按其原有权限规则操作同一 Session；engineering 凭据不覆盖这些入口的授权。所有本地调用者必须可信。试点未因此获得生产隔离资格。

## 2. 完成一次回复观察

以下命令在同一个私有 home、同一个客户端身份下执行。每个 `--request` 或 `--action` 都是调用者保存的幂等键。发生超时后，重试原请求与原键；不要换键猜测结果。

`action_id` 使用同一 home 的 attention 全局命名空间，多个主体和旧命令共享它。每次新回答生成并保存一个全局唯一 UUID，或使用真实 Mission UUID 加后缀（如 `真实MissionUUID:answer-001`）。不能让不同 Mission 都使用裸 `answer-001`。`request_id` 则在 principal/client 范围内唯一。

```sh
osstack engineering adopt \
  --scope SCOPE_ID --task TASK_ID --run RUN_ID --session SESSION_ID \
  --goal "确认本次兼容性选择的回复回合" --request adopt-001 --json

osstack engineering observe --mission MISSION_ID --json > "$OSSTACK_HOME/mission-view.json"
```

读取这个观察文件中的问题、明确选项 ID、Mission revision、Wait ID 和状态。文件保存了短期交互 token。保护这个文件，不要提交它。随后回答明确选项。下列 UUID 只生成一次，重试和查询必须复用保存的 `ANSWER_ID`：

```sh
ANSWER_ID="$(node -p 'require("node:crypto").randomUUID()')"
osstack engineering decide --observation "$OSSTACK_HOME/mission-view.json" \
  --wait WAIT_ID --action "$ANSWER_ID" --choice CHOICE_ID --json

osstack engineering observe --mission MISSION_ID --json
```

对于允许原文输入的问题，用 `--text "原始回答"` 代替 `--choice`。两者不能同时提供。系统不把“继续”自动猜成某个选项；文本也不能批准风险动作。

`--observation` 使用文件中原封不动的 Mission revision、问题引用和 token。CLI 不会在提交前偷偷刷新版本。宿主重新核对来源、身份、权限和过期时间。

状态必须按证据理解：

| 状态或事实 | 含义 |
|---|---|
| 回答已记录 / reserved | 已持久预留回答；尚未证明 Worker 执行 |
| dispatch_committed | 已承诺这一次派发；结果不明时不能自动再发 |
| applied | 整个回复回合已完成并落库；不只是传输接收 |
| delivery_unknown / needs_reconciliation | 证据不足；保留原回执与责任 |
| Mission completed + ObservationProof | 本次回答的精确回合已确认，当前没有新决定、未清义务、未决副作用或取消意图 |

若回复又提出决定，重新 `observe` 并处理新 Wait。较早的 Run 终态、普通 `done` 文本或 Session 空闲不能单独使 Mission 成功。

若原回答回合已完成，但用户在下一次观察归约前又推进了一个人工 turn，最新 turn 就不再是原回答回合；原 Mission 可能保持 `observing`。先查询原 action 回执并核对原 Session 的回合记录。确认不再需要本 Mission 的观察后，可以明确 `end-observation`。不要因此重发原回答或伪造完成状态。

## 3. 暂缓、取消与结束观察

暂缓只改变重查安排。它不提供回答或执行权限。

```sh
osstack engineering defer --observation "$OSSTACK_HOME/mission-view.json" \
  --wait WAIT_ID --request defer-001 \
  --revisit-at 2026-10-26T12:00:00Z --reason "等待产品输入"

osstack engineering cancel --mission MISSION_ID --revision REVISION \
  --request cancel-001 --reason "停止本次工作"

osstack engineering end-observation --mission MISSION_ID --revision REVISION \
  --request end-001 --reason "不再观察此回复"
```

`cancel` 持久记录停止意图，并通过独立停止通道请求中止。未知回答不会阻塞它。`stop_requested` 或 `stop_unknown` 都不是停止证明。在途动作可能仍然完成。

`end-observation` 结束本 Mission 的观察，阻止其后续首次派发。它不停止 Worker，不声称成功，也不抹去 committed/unknown 回执。原 attention 对账责任和会话发送守卫仍然有效。 若原回答仍在等待仓库 writer 准入，且持久证明确认它已是 `cancelled_before_dispatch`，宿主会释放这条尚未开始的排队工作。此处理不向已 committed 的 Worker 发送中止。

对已证明未派发的取消，原回答的同键、同正文重放返回 `cancelled_before_dispatch`；改变原正文返回 `action_conflict`。Mission 终结后，换新 action_id 再回答返回 `mission_terminal`。旧 `session.send` 重放这条已取消消息时使用错误码 `cancelled_original_answer`。这些结果都不允许恢复或替换原回答。

| 操作 | 当前权限要求 |
|---|---|
| adopt | scope read + write；记录不可变 owner |
| decide / defer / dispose_wait | 同一 owner + 当前 read + write |
| cancel | 当前 scope read + 独立 stop，且是 owner 或显式 scope-stop operator |
| end-observation | owner + read；或 operator + read + stop |

其他 writer 不能接管 owner。write 不隐含 stop。owner 写权被撤销后，只要 read 与独立 stop 权仍有效，就可取消。read 权被撤销时不能读取或操作这个 Mission；另行认证的 operator 负责恢复处置。凭据整体撤销后由另行认证的 scope-stop operator 恢复处置。

## 4. 对账

查询原动作。查询不会重新发送：

```sh
osstack engineering reconcile --kind query_action \
  --mission MISSION_ID --action "$ANSWER_ID" --json
```

如果用户已在原会话处理问题，且旧 Wait 没有关联回答 action、没有未知在途副作用，可以明确撤出旧观察义务。先读取新快照，再提交：

```sh
osstack engineering observe --mission MISSION_ID --json > "$OSSTACK_HOME/mission-view.json"
osstack engineering reconcile --kind dispose_wait \
  --observation "$OSSTACK_HOME/mission-view.json" --wait WAIT_ID --request dispose-001 \
  --disposition human_answered_out_of_band --reason "已在原会话明确处理"
```

另一个处置值是 `no_longer_relevant`。处置绑定精确旧 Wait 和当前观测摘要，是用户授权的观察目标调整。它不产生 applied、停止证明或新的执行权限。有关联回答的 Wait 必须查询原 action 或取消，不能用人工声明清除未知副作用。

## 5. 接口与限制

所有命令都接受 `--input FILE`，用严格请求 JSON 代替其余业务参数；可同时使用 `--json`。文件上限为 1 MiB，必须是普通文件且不是符号链接。未知字段、重复参数和 `actor`/权限声明会被拒绝。协议 Zod 源码和已生成 JSON Schema 位于 `packages/protocol/src/engineering.ts` 与 `packages/protocol/schemas/engineering-*.schema.json`。

以 `--` 开头的文本值（例如 `--help`）必须放入 `--input FILE` 的完整请求 JSON；把 `answer` 写为 `{"kind":"text","text":"--help"}`。不要把这段 JSON 当作完整请求。普通 `--text -h` 可用，但 `--text --help` 会被识别为缺失参数。

`observe` 的 `--cursor` 是事件序号，`--limit` 为 1–100。检查返回的 cursor、has_more 与未决 Wait；增量事件不是完整等待视图的替代。保存含 token 的 JSON 后应限制文件权限。

| 错误 | 下一步 |
|---|---|
| permission_denied | 让宿主管理者核对当前身份与精确 scope 权限；不要在 JSON 中伪造 actor |
| draining | 宿主暂停新工作；读取、查询和已授权停止仍可用。若升级已中止，按下文核对后恢复接收，不能换键绕过 |
| dispatch_gate_required | 原回答须由统一派发门执行；保留原 action，通过工程入口查询，不经旧 session.send 绕过 |
| dispatch_inconsistent | 派发阶段、消息或取消证明不一致；停止新增写入，保留证据交由宿主操作员调查，不手改账本 |
| stale_decision / source_changed | 重新观察；先查询原 action，确认没有已接受副作用后再提交新决定 |
| action_conflict / action_id_conflict | 保留原键和原正文；不同意图使用独立新请求 |
| delivery_unknown | 查询原 action；不要换键重发 |
| signed_approval_required | 使用该风险/任务的正式批准入口 |
| executor_not_qualified | 检查默认租户、Session 状态、原生 ID 与支持的 Adapter profile |
| not_dispatched_use_cancel | 取消严格未派发预留；不要把它伪装成未知已发送 |
| cancelled_original_answer | 原消息已明确取消且未派发；查询原回执，不换键重发 |
| authority_already_adopted | 该精确决定已被采纳；包括无回答就取消/结束观察的情况。使用原 Mission/Session 入口 |
| budget_exhausted | 宿主或 Mission 的持久上限已达到；检查账本，不改库重置。当前 home 累计最多 1000 个 Mission，包含终态记录 |
| engineering_busy | 待派发槽已满；稍后重试未改变的原请求，读取和停止仍可用 |
| mission_terminal | Mission 已终结；读取现有结果，不把重试变成新的目标或回答 |
| interaction_expired | 先查询原 action；未接受的回答需重新 observe 获取当前 token，再提交明确的新请求 |
| interaction_mismatch | 核对 principal/client 和原观察文件；不得手工拼接 token、Wait 或问题引用 |
| durability_required | 实际 daemon 写连接没有验证为 synchronous=FULL；修正宿主配置，不绕过持久性检查 |
| stop_attempt_budget_exhausted | 本 Mission 已接受 8 次停止尝试；原停止意图仍保留。查询原回执，交由宿主操作员处理，不能换键绕过上限 |

宿主同时最多运行 16 个内存中的派发尝试，每页 watchdog 最多检查 16 个 reserved action 和 16 个活跃 Mission。回复有 5 分钟宿主 deadline；到期请求中止，不代表进程已停止。每次暂缓最多产生一个提醒事件，可通过 `observe` 读取；试点不发送外部通知。

每个 home 最多存储 1,000 条 Mission，每个 Mission 最多 64 个 Wait。每个 Mission 最多 256 个一般控制请求。取消和结束观察独立于此计数；取消另有每个 Mission 最多 8 次的停止尝试上限，包含第一次。每次尝试保留原停止意图，只面向本 Mission 尚未解决的原 committed 消息。相同请求重放不增加计数。结束观察是单次终结操作。交互令牌五分钟到期，每个 Mission 最多保留 32 个活跃令牌。遇到 `budget_exhausted` 或 `stop_attempt_budget_exhausted` 时，不得删除未解决的证据来绕过限制。查询既有回执，并由主机操作员核对额度。

`completed` 和 `failed` 是不可逆的终态。新的 cancel 或 end-observation 请求返回 `mission_terminal`，不会改写结果或中止同 Session 后续的手工指令。已接受的相同请求仍可只读重放。结束观察后若仍有本 Mission 的 committed 未决消息，独立停止通道可在上述停止额度内请求中止。

`cost_evidence` 明确返回 `status: unknown` 和 `hard_cap_enforced: false`。试点不核销 Provider 用量，不把缺失计量当作零。5 分钟宿主 deadline 不是 token 或费用硬上限。真实编程回复可能超过这个期限；到期中止可能留下不确定回执和部分工作区改动。此 profile 尚不适合不设时长边界的长回合任务。

### 关闭功能后的处理

关闭 `OSSTACK_ENGINEERING` 不会删除派发阶段或释放 Session 守卫。已有 `reserved` 行仍会阻止新的手工指令；旧 `abandon-receipt` 会要求先取消。工程入口关闭时不能通过它取消，因此须在相同 home 重新启用 `OSSTACK_ENGINEERING=1` 与 `OSSTACK_ATTENTION=1`，使用有效凭据查询并处理原 action，然后再关闭。不要改写或删除数据库回执来解锁。已 committed/unknown 的动作仍需原有对账，不能因重新启用而重发。

### 升级、回退与恢复服务

schema 47 是数据库迁移边界。迁移完成后，只支持旧 schema 的 binary 不能打开这个 home。不能只退回旧 npm 版本或替换 binary；本试点没有受支持的数据库降级/自动回退通道。备份也不等于已获得回退许可：还须保留迁移后的动作和外部副作用证据。

升级前会检查 `attention_dispatch_holds`。只有原 committed 消息已经 `applied`，或完整证明确认 `cancelled_before_dispatch`，才能清除相应 hold。committed 但未 applied 的消息持续阻止升级；failed、unknown、`abandoned_unknown` 回执、结束观察和关闭功能均不能清除它。对于没有原 applied 证明的失败或未知动作，这个限制可能无限期保留。当前试点没有自动解除它的受支持流程。保留原 home、原账本和可用副作用证据，等待单独设计并审核的离线处置方案；不要手工修改 phase、消息、回执或 schema version，也不要删除数据库来强制升级。

托管升级在 `resolveAuthority` 阶段就写入持久的 `upgrade-operation.json`，早于 drain 和安装。已有 hold 时不要发起托管升级。若它随后因未决 hold 失败，operation fence 和升级 journal 会保留，状态需要恢复处置（`recovery_required`）。`daemon.resume` 只恢复仍存活进程的接收状态，不删除该 fence；今后的托管重启可能被 `upgrade_start_blocked` 拒绝。对 committed 未知动作的持续 hold，现有 upgrade reconcile 也不能自动解决。本试点没有针对这种失败的受支持 fence 清除或操作员放行流程。保留 fence、journal 和原 home，等待单独审核并实现的恢复方案；不要手改或删除这些文件，不要调用不存在的 complete/force-clear 命令。

`daemon.drain` 即使返回 `drained: false`，daemon 仍处于 draining 状态。新的任务和会话写入会被拒绝；升级中止不会自动恢复接收工作。先确认没有安装、重启或其他维护仍在进行，再查询 hold。仍是严格未派发 reserved 的回答可在 draining 状态下显式取消；已经 committed 的未知动作不能据此释放。

如果决定放弃本次升级并继续运行当前版本，由受信宿主管理者调用 `daemon.resume` RPC，然后核对 `osstack health` 的 `result.draining` 为 `false`。本版没有 `osstack daemon resume` 或通用 `osstack rpc` 子命令。下面的 Node 命令使用现有本地 socket RPC；它不打开数据库。必须先把 `OSSTACK_SOCKET` 换成启动日志中该 home 的精确绝对 socket 路径，并保持 `OSSTACK_HOME` 指向该 home：

```sh
export OSSTACK_SOCKET=/absolute/path/from-daemon-startup.sock
node --input-type=module <<'NODE'
import { connect } from 'node:net';
import { isAbsolute } from 'node:path';
const path = process.env.OSSTACK_SOCKET;
if (!path || !isAbsolute(path)) throw Error('Set OSSTACK_SOCKET to the exact absolute daemon socket path');
const socket = connect(path);
let bytes = Buffer.alloc(0), done = false;
const fail = message => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); console.error(message); process.exitCode = 1; };
const timer = setTimeout(() => fail('daemon.resume timed out'), 5000);
socket.on('error', error => fail(error.message));
socket.on('end', () => { if (!done) fail('Incomplete RPC response'); });
socket.on('connect', () => {
  const body = Buffer.from(JSON.stringify({ id: 1, method: 'daemon.resume' }));
  const header = Buffer.alloc(4); header.writeUInt32BE(body.length);
  socket.write(Buffer.concat([header, body]));
});
socket.on('data', chunk => {
  bytes = Buffer.concat([bytes, chunk]);
  if (bytes.length < 4) return;
  const size = bytes.readUInt32BE(0);
  if (size > 1048576) return fail('RPC response exceeds 1 MiB');
  if (bytes.length < size + 4) return;
  try {
    const response = JSON.parse(bytes.subarray(4, size + 4).toString('utf8'));
    if (response.id !== 1 || response.ok !== true || response.result?.draining !== false) throw Error('Resume was not confirmed');
    done = true; clearTimeout(timer); socket.end(); console.log(JSON.stringify(response));
  } catch (error) { fail(error.message); }
});
NODE
osstack health
```

恢复接收工作会让符合条件的队列继续调度，必须先处理不希望执行的 reserved 回答。`daemon.resume` 不解除 upgrade hold，不证明未知动作已停止，也不是数据库回退。若磁盘等健康条件仍不满足，健康检查可能再次进入 draining。以上 RPC 属于现有受信本地宿主接口，并非 engineering 凭据授权接口。

尚需独立验证：真实 Provider 回答、物理断电与文件系统持久性、跨重启的进程域停止证明、恶意同 UID Worker 隔离、非默认租户、远程宿主。单元测试、完整测试和模型审计不能替代这些资格。

完整规格见[修订后的运行时契约](../design/2026-10-25-engineering-agent/runtime-contract-v2.md)与[试点场景](../design/2026-10-25-engineering-agent/pilot-scenarios.json)。


## 重复本地集成检查

在干净的开发工作区使用受支持的 Node 版本执行：

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm smoke:engineering-decision
```

此检查使用独立 daemon 进程、编译后的 CLI 和可控 Adapter。它创建专用 home、授权文件和临时目录，验证采纳、观察、延期、回答一次、完成回合证明、同键重放和回执查询。成功要求 Adapter 恰好调用一次，并确认 daemon 退出。JSON 始终标明 `provider_qualified: false`。CI 执行同一检查。

回答已应用，不代表执行许可已释放。`health` 和 `daemon.drain` 返回 `execution_lease_holds`。仍持有读写许可时，`drained` 为 false；物理写锁释放失败也不能报告安全排空。`daemon.resume` 不释放这些许可。不要为了升级而强行清除锁。

来源身份替换一经发现，Mission 就保持对账限制。即使等待项已清除、原 native ID 恢复、daemon 重启，也不能自动解除。可以查询原动作回执，或明确结束观察。后续手工回合不能成为原 Mission 成功的证据。

集成顺序和外部验证条件见[剩余任务计划](../plans/2026-10-26-session-pilot-debt.md)。
