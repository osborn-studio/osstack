# Graph Engineering：从配置到候选结果

[返回中文 README](../../README.zh.md#graph-engineering) · [English overview](../../README.md#graph-engineering) · [运维与恢复](../runbooks/graph-runtime.md)

本手册对应 main 的内部 beta。2026-09-21 查询 npm：CLI latest 为 0.19.0，Graph 包尚未公开发布。先使用从当前源码构建的 Node CLI，或已核验提交的内部 Node 安装。不要根据相同的 `--version` 推断内部构建一致。

## 1. 选择适合的任务

当前固定模板 `code-delivery-v1` 适合有明确验收命令的小变更。bounded writer 一次替换一个登记的 UTF-8 文件（最多 4 KiB），不能当成任意多文件 agent。下面以独立练习仓库的 `answer.txt` 从 `0` 改成 `1` 为例。配置生成和离线验证不调用模型；提交 run 会调用供应商并产生费用。

| 阶段 | 输入 | 输出与路由 |
|---|---|---|
| workspace | repositoryRef、精确 baseRevision | 独立 writer workspace lease |
| implement / repair | 输入 artifact 引用、workspace；修复还带上一轮候选与反馈 | 实现回执；确认执行器停止后才可 freeze |
| freeze | workspace、停止后的回执 | 不可变 candidateRevision、artifact 引用与摘要 |
| prepare_review / prepare_tests | 同一冻结 candidate | 两个独立工作副本 |
| review / tests | candidate、对应副本、登记的验收命令 | 评审 verdict / 测试 passed，均绑定候选与证据 |
| join | candidate、review、tests | 通过则 ready；业务缺陷进入有预算的 repair；权限/格式/未知副作用不会按业务失败无限重试 |

Loop 管任务发现与循环，Graph 管一次任务中的明确依赖和并行汇合；Graph 复用 host 权限及 agent 执行能力，并非把 `loop run` 改名。`graph explain` 是另一条只读诊断入口。

## 2. 构建并隔离状态

构建可使用 Node 22.23.1（CI 使用版本）及项目指定 pnpm。Graph 运行最低 Node 20.6.0；SQLite 原生模块必须匹配运行时 ABI。Bun 单文件仅保留 explain/离线 validate，不能执行 Graph。

在 OSStack 源码根目录：

```sh
corepack enable pnpm
pnpm install --frozen-lockfile
pnpm build
export OSSTACK_HOME="$(mktemp -d /tmp/osg-XXXXXX)"
chmod 700 "$OSSTACK_HOME"
export OSSTACK_SOCKET="$OSSTACK_HOME/daemon.sock"
export OSSTACK_UPDATE_CHECK=0
export OSSTACK_POWER_POLICY=none
export OSSTACK_CLOCK_MONITOR=monotonic-v1
export OSSTACK_DASHBOARD_PORT=0
# 此函数只在当前终端有效；后续命令使用此源码构建。
osstack() { node "$PWD/packages/cli/dist/bin.js" "$@"; }
osstack graph --help
```

以下操作都在同一个源码根目录终端执行。开发 checkout 不能指向默认 `~/.osstack` 或已有 serving home。使用短 home 路径避免 Unix socket 路径长度限制。已有部署的升级、停止、备份不能用本练习替代。

## 3. 创建练习仓库与请求

```sh
export GRAPH_DEMO_REPO="$(mktemp -d /tmp/osg-repo-XXXXXX)"
git -C "$GRAPH_DEMO_REPO" init -q
mkdir -p "$GRAPH_DEMO_REPO/.osstack"
printf '0\n' > "$GRAPH_DEMO_REPO/answer.txt"
printf 'schema_version: 1\nmode: execute\n' > "$GRAPH_DEMO_REPO/.osstack/policy.yaml"
git -C "$GRAPH_DEMO_REPO" add answer.txt .osstack/policy.yaml
git -C "$GRAPH_DEMO_REPO" -c user.name=GraphDemo -c user.email=demo@example.invalid commit -qm 'Initialize graph demo'
```

在私有终端准备 `DEEPSEEK_API_KEY`，并设置你账户实际可用的模型和端点；不要把密钥写入下面 JSON、仓库或报告。切换 Anthropic 需要同步更改 provider、writer/reviewer 身份，并使用 `ANTHROPIC_API_KEY`。

```sh
export GRAPH_MODEL='REPLACE_WITH_AVAILABLE_MODEL_ID'
export GRAPH_BASE_URL='https://api.deepseek.com/v1'
node --input-type=module <<'JS'
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
const { OSSTACK_HOME: home, GRAPH_DEMO_REPO: repo, GRAPH_MODEL: model, GRAPH_BASE_URL: baseUrl } = process.env;
if (!home || !repo || !model || model.startsWith('REPLACE_') || !baseUrl) throw Error('Set the four environment variables first');
const scope = { schemaVersion: 1, tenantId: 'local-demo', principalId: 'owner', workspaceId: 'demo' };
const task = 'Replace answer.txt with exactly 1 followed by a newline. Preserve every other file. Do not claim tests ran.';
const spec = {
  schemaVersion: 1, template: 'code-delivery-v1', publication: 'artifact_only',
  input: { taskRef: 'answer-one', repositoryRef: 'demo-repo',
    baseRevision: execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), acceptanceRef: 'answer-check' },
  limits: { maxEpochs: 2, maxBranchAttempts: 1, maxConcurrentReaders: 2,
    maxConcurrentWritersPerRepo: 1, maxActionStarts: 14, deadlineSeconds: 600, tokenReservationLimit: 196608 }
};
const host = { schemaVersion: 1, admissionEnabled: false, registration: {
  id: 'demo-owner', scope, repositoryRef: 'demo-repo', repositoryPath: repo,
  taskRef: 'answer-one', task, inputArtifactRef: 'demo-input',
  writer: { agentId: 'deepseek-bounded-writer', capabilityId: 'deepseek-bounded-writer.writer' },
  reviewer: { agentId: 'deepseek-bounded-reviewer', capabilityId: 'deepseek-bounded-reviewer.reviewer' },
  boundedMessages: { provider: 'deepseek', baseUrl, model, files: ['answer.txt'], acceptance: task },
  acceptanceRegistry: [{ ref: 'answer-check',
    command: `env -u DEEPSEEK_API_KEY -u ANTHROPIC_API_KEY node -e 'require("node:assert/strict").equal(require("node:fs").readFileSync("answer.txt","utf8"), "1\\n")'`,
    passExitCodes: [0], failExitCodes: [1] }],
  grant: { scope, expiresAt: Date.now() + 1200000, operations: ['read', 'execute', 'cancel', 'resume'] }
} };
const start = { schemaVersion: 1, kind: 'start', scope, idempotencyKey: 'demo-start-1',
  inputArtifactRef: 'demo-input', source: { product: 'osstack', requestId: 'demo-start-1' }, spec };
for (const [name, value] of Object.entries({ 'graph-host.json': host, 'scope.json': scope, 'spec.json': spec, 'start.json': start })) {
  writeFileSync(join(home, name), JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' });
}
JS
osstack graph validate --spec "$OSSTACK_HOME/spec.json" --json
```

生成器拒绝覆盖已有文件；新试验用新的私有 home。`validate` 只验证 spec、固定拓扑和预算，不验证凭据、host 授权、仓库或供应商可用性。返回 `valid:true` 后查看 `nodes`、`budget`、`specHash`。

`graph-host.json` 必须为当前用户拥有的普通文件、权限 0600。scope、repositoryRef、taskRef、inputArtifactRef、acceptanceRef 必须对应，不可通过在请求里写“approved”获得权限。grant 的 expiresAt 是毫秒时间戳，本例 20 分钟；应在有效期内启动。writer/reviewer 角色分离不等于不同模型供应商的独立性。

## 4. 启动、开放准入、提交

```sh
osstack serve > "$OSSTACK_HOME/daemon.log" 2>&1 &
osstack health --json
osstack autonomy health --json
```

等待 daemon 就绪；普通 health 成功只说明服务可达。`autonomy health` 的 `result.can_run_local` 必须为 true，否则先查看 write blockers 和日志。此时新 Graph 准入仍关闭。准备执行并确认本次模型费用后，仅开启准入：

```sh
node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
const path = process.env.OSSTACK_HOME + '/graph-host.json';
const config = JSON.parse(readFileSync(path, 'utf8'));
config.admissionEnabled = true;
writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600 });
JS
osstack graph run --request "$OSSTACK_HOME/start.json" --json
```

保存响应里的 `graphRunId`，用其替换 RUN_ID。轮询以下命令直到业务状态明确，不需要再次提交 start：

```sh
osstack graph status --run RUN_ID --scope "$OSSTACK_HOME/scope.json" --json
osstack graph result --run RUN_ID --scope "$OSSTACK_HOME/scope.json" --json
```

`ready` 的候选与 review/tests/join 证据应属于同一 candidateRevision。`result` 返回交付/证据引用；从私有 home 保存对应产物进行人工审阅。原练习仓库的 `answer.txt` 仍为 `0` 是预期结果：修改在隔离候选中，Graph 不把它自动应用回源仓库。

## 5. 参数与 JSON 字段

Graph 不接受 `--prompt`、`--agent`、`--verify` 或任意用户节点列表；任务和验收在 host 注册，预算和模板在 spec。

| 命令 | 必填参数 | 作用 |
|---|---|---|
| `graph validate` | `--spec FILE` | 离线编译 GraphSpec；不是 start 请求 |
| `graph run` | `--request FILE` | 提交 kind=start |
| `graph status` / `result` | `--run ID --scope FILE` | scope 文件只包含 GraphScope |
| `graph cancel` / `reconcile` | `--request FILE` | 都使用 kind=cancel；对账不会接受伪造停止证明 |
| `graph resume` | `--request FILE` | kind=resume，精确 interruptId 和当前授权 |
| 以上全部 | 可选 `--json` | 缩进 JSON；执行命令本身也输出 JSON |
| `graph explain` | `--task ID --db ABS_PATH --board BOARD --state ABS_PATH`，加 `--tenant ID` 或 `--default-tenant` | 只读关系诊断，独立于执行请求；可选 `--json` |

请求及 scope 为严格 v1 JSON，最多 64 KiB；未知字段、重复/缺少参数会被拒绝。

| spec.limits 字段 | 合法范围 / 示例 | 含义 |
|---|---|---|
| maxEpochs | 1–3；例 2 | 实现总轮数，包括初次实现，不是额外修复次数 |
| maxBranchAttempts | 1–32；例 1 | host 授权的分支尝试容量，不授权未知副作用重发 |
| maxConcurrentReaders | 1–64；例 2 | 读分支并发上限 |
| maxConcurrentWritersPerRepo | 固定 1 | 同一仓库写者限制 |
| maxActionStarts | 1–100000；例 14 | 副作用动作启动额度，必须容纳编译展开的计划 |
| deadlineSeconds | 1–604800；例 600 | 秒级期限，到期不代表未知执行器已停止 |
| tokenReservationLimit | 0–1000000000；例 196608 | token 预留额度；不是价格或保证实际用量 |

上述字段均必填，无 CLI 默认值。增加 epoch/尝试数后必须重新 validate；schema 合法但预算不足也会被拒绝。

## 6. 状态、取消与恢复

| 状态 | 下一步 |
|---|---|
| queued / running | 继续查 status；需要停止则 cancel |
| ready | 读取 result，审阅候选及证据，另行决定合并/发布 |
| failed | 检查错误及已有证据，不能等同于 ready |
| waiting_input | 查明 interrupt，使用精确 resume；输入数据不授予权限 |
| cancel_pending | 取消意图已持久化，但尚未确认停止 |
| reconciliation_required | 保留 workspace、锁、账本、日志，按运维手册核对 |
| cancelled | 已确认取消；仍保留证据 |

取消文件示例：复制本次 scope，用真实 run ID 和刚读到的 revision 替换占位值。

```json
{
  "schemaVersion": 1,
  "kind": "cancel",
  "scope": { "schemaVersion": 1, "tenantId": "local-demo", "principalId": "owner", "workspaceId": "demo" },
  "graphRunId": "REPLACE_WITH_RUN_ID",
  "expectedRevision": 0,
  "idempotencyKey": "demo-cancel-1"
}
```

保存为 `$OSSTACK_HOME/cancel.json` 后运行 cancel；需要可信对账时运行 reconcile。revision 为整数，示例 0 不是可复用默认值。resume 还需 `interruptId`、`input`（例如 `{ "kind": "data", "value": {} }`），其内容由实际中断决定；不要随意构造“成功”对账结果。

- 退出码 **0**：请求已确认，仍须看业务状态。
- 退出码 **1**：输入/RPC 拒绝；按 error.code、nextAction 处理。
- 退出码 **2**：`delivery_unknown`；原请求、原 idempotencyKey 重试，不创建新任务碰碰运气。
- `REVISION_CONFLICT`：重新读 status；同一传输重试不改请求，新的操作意图才使用新的 key/revision。
- `GRAPH_ADMISSION_DISABLED`：owner 需检查准入配置；`GRANT_EXPIRED` 检查有效期与注册绑定。
- 未知执行结果不能靠 PID 消失、过期或删锁“修复”。关闭新准入不会停止已有任务。完成取消/对账、确认无在途动作后再正常停止 daemon；保留私有 home 和证据。

更完整的故障、升级、回滚及恢复约束见[运维手册](../runbooks/graph-runtime.md)。协议事实来源：[graph.ts](../../packages/protocol/src/graph.ts)、[CLI](../../packages/cli/src/graph-execution-command.ts)、[host 注册](../../packages/cli/src/graph-rpc.ts)、[固定编译器](../../packages/graph/src/spec-compiler.ts)。
