# Graph Engineering: configuration to candidate result

[README](../../README.md#graph-engineering) · [中文](graph-quickstart.md) · [Operator runbook (中文)](../runbooks/graph-runtime.md)

This walkthrough describes the main-branch internal beta. On 2026-09-21, both `@osstack/cli@0.20.0` and `@osstack/graph@0.20.0` were verified on npm; GitHub releases use the package tags [CLI 0.20.0](https://github.com/osborn-studio/osstack/releases/tag/%40osstack/cli%400.20.0) and [Graph 0.20.0](https://github.com/osborn-studio/osstack/releases/tag/%40osstack/graph%400.20.0). Use the current source build or a verified internal Node installation. Identical version labels do not establish identical internal builds.

## 1. Choose a bounded task

The fixed `code-delivery-v1` template needs an explicit acceptance command. A bounded writer replaces one registered UTF-8 file per invocation, up to 4 KiB; it is not a general multi-file coding agent. This example changes `answer.txt` from `0` to `1` in a separate practice repository. Configuration generation and offline validation make no model calls. Submitting a run invokes the configured provider and incurs costs.

| Stage | Input | Output and routing |
|---|---|---|
| workspace | repositoryRef, exact baseRevision | Isolated writer workspace lease |
| implement / repair | Input artifact reference, workspace; repair also receives prior candidate and feedback | Implementation receipt; confirmed executor stop precedes freeze |
| freeze | Workspace and receipt | Immutable candidateRevision, artifact references and digest |
| prepare_review / prepare_tests | The same frozen candidate | Separate verification workspaces |
| review / tests | Candidate, workspace, registered acceptance command | Verdict / passed result, each bound to candidate evidence |
| join | Candidate, review, tests | ready, bounded repair for business defects, or failure/unresolved outcome |

Loop handles discovery and iteration. Graph handles typed dependencies and parallel joins within a task, reusing host authority and agent capabilities. `graph explain` is a separate read-only diagnostic command.

## 2. Build with isolated state

Use Node 22.23.1 (the CI build version) and the project's pinned pnpm. Graph runtime requires Node 20.6.0 or newer and a matching native SQLite ABI. Bun single binaries can explain/validate but cannot execute Graph.

Run from the OSStack source root:

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
# This function uses the source build and is local to this terminal.
osstack() { node "$PWD/packages/cli/dist/bin.js" "$@"; }
osstack graph --help
```

Keep the same terminal and source-root working directory throughout. A development checkout must not use `~/.osstack` or a reserved serving home. A short home path avoids Unix socket path limits. This exercise does not replace the production upgrade/backup procedure.

## 3. Create the practice repository and request files

```sh
export GRAPH_DEMO_REPO="$(mktemp -d /tmp/osg-repo-XXXXXX)"
git -C "$GRAPH_DEMO_REPO" init -q
mkdir -p "$GRAPH_DEMO_REPO/.osstack"
printf '0\n' > "$GRAPH_DEMO_REPO/answer.txt"
printf 'schema_version: 1\nmode: execute\n' > "$GRAPH_DEMO_REPO/.osstack/policy.yaml"
git -C "$GRAPH_DEMO_REPO" add answer.txt .osstack/policy.yaml
git -C "$GRAPH_DEMO_REPO" -c user.name=GraphDemo -c user.email=demo@example.invalid commit -qm 'Initialize graph demo'
```

Load `DEEPSEEK_API_KEY` in a private terminal. Set a model actually available to your account and its endpoint. Never put credentials into the JSON, repository or report. Anthropic requires changing provider, both adapter identities, and using `ANTHROPIC_API_KEY`.

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

The generator refuses to overwrite files. Use a fresh home for a new exercise. `validate` checks the spec, fixed topology and budget; it does not validate credentials, host authority, repository or provider availability. Inspect `valid`, `nodes`, `budget` and `specHash`.

`graph-host.json` must be an owner-only regular file (0600). Scope and all registration references must match. An "approved" string in a request grants no authority. The grant expiresAt is a millisecond timestamp, 20 minutes ahead in this example. Distinct writer/reviewer roles are not proof of independent model providers.

## 4. Start, enable admission and submit

```sh
osstack serve > "$OSSTACK_HOME/daemon.log" 2>&1 &
osstack health --json
osstack autonomy health --json
```

Wait for the daemon to become available. Ordinary health only establishes reachability; `autonomy health` must report `result.can_run_local: true`. Inspect blockers and logs otherwise. Admission remains disabled until you are ready to incur provider costs. Enable only admission:

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

Save `graphRunId` from the response and substitute it for RUN_ID. Poll status, rather than submitting another start:

```sh
osstack graph status --run RUN_ID --scope "$OSSTACK_HOME/scope.json" --json
osstack graph result --run RUN_ID --scope "$OSSTACK_HOME/scope.json" --json
```

For `ready`, the candidate, review, tests and join evidence must identify the same candidateRevision. `result` returns delivery/evidence references; retain the corresponding private-home artifacts for review. The original practice repository still containing `0` is expected: changes exist in an isolated candidate. Graph does not apply them back automatically.

## 5. Commands and request parameters

Graph does not accept `--prompt`, `--agent`, `--verify`, or arbitrary user node definitions. Register tasks/acceptance on the host; select the template and budget in spec.

| Command | Required flags | Meaning |
|---|---|---|
| `graph validate` | `--spec FILE` | Offline GraphSpec compilation, not a start request |
| `graph run` | `--request FILE` | Submit kind=start |
| `graph status` / `result` | `--run ID --scope FILE` | Scope file contains only GraphScope |
| `graph cancel` / `reconcile` | `--request FILE` | Both use kind=cancel; reconciliation needs trusted host evidence |
| `graph resume` | `--request FILE` | kind=resume, exact interruptId, current authority |
| All above | Optional `--json` | Pretty-print JSON; execution commands already emit JSON |
| `graph explain` | `--task ID --db ABS_PATH --board BOARD --state ABS_PATH`, plus `--tenant ID` or `--default-tenant` | Read-only relationship diagnostics; optional `--json` |

Request/scope files are strict v1 JSON, at most 64 KiB. Unknown fields, duplicate flags and missing options are rejected.

| spec.limits | Range / example | Meaning |
|---|---|---|
| maxEpochs | 1–3 / 2 | Total implementation epochs, including the initial attempt |
| maxBranchAttempts | 1–32 / 1 | Host-authorized branch capacity, not permission to replay unknown effects |
| maxConcurrentReaders | 1–64 / 2 | Read branch concurrency cap |
| maxConcurrentWritersPerRepo | Exactly 1 | Repository writer limit |
| maxActionStarts | 1–100000 / 14 | Effect-start capacity; must cover the compiled plan |
| deadlineSeconds | 1–604800 / 600 | Deadline in seconds; expiry does not prove an executor stopped |
| tokenReservationLimit | 0–1000000000 / 196608 | Token reservation budget, not a price or guaranteed usage |

All fields are required, with no CLI defaults. Revalidate after changing epochs/attempts; schema-valid but insufficient budgets are rejected.

## 6. State, cancellation and recovery

| State | Next action |
|---|---|
| queued / running | Poll status, or cancel if no longer wanted |
| ready | Inspect candidate/evidence; decide separately whether to merge/release |
| failed | Inspect errors and retained evidence |
| waiting_input | Inspect the exact interrupt and resume; data is not authority |
| cancel_pending | Cancellation intent persisted; stop is not confirmed |
| reconciliation_required | Retain workspace, locks, ledger and logs; follow the runbook |
| cancelled | Cancellation confirmed; preserve evidence |

Copy this run's scope and replace run ID and expectedRevision with authoritative values from a fresh status response:

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

Save as `$OSSTACK_HOME/cancel.json`, then invoke cancel or reconcile. Revision 0 is a placeholder, not a reusable default. Resume additionally needs `interruptId` and `input` (for example `{ "kind": "data", "value": {} }`), chosen for the actual interrupt. Do not fabricate successful reconciliation evidence.

- Exit **0**: acknowledged; inspect business status.
- Exit **1**: input/RPC rejection; follow error.code and nextAction.
- Exit **2**: delivery_unknown; retry the identical request and idempotencyKey.
- REVISION_CONFLICT: refresh status. Keep transport retries identical; use a new revision/key only for a new operation intent.
- GRAPH_ADMISSION_DISABLED: inspect host admission. GRANT_EXPIRED: inspect expiry and registration binding.
- A missing PID or expired timer does not settle an unknown effect. Disabling new admission does not stop existing runs. Resolve cancellation/reconciliation and confirm no in-flight effects before normal daemon shutdown; retain the home and evidence.

Sources: [protocol](../../packages/protocol/src/graph.ts), [CLI](../../packages/cli/src/graph-execution-command.ts), [host registration](../../packages/cli/src/graph-rpc.ts), [compiler](../../packages/graph/src/spec-compiler.ts). See the [operator runbook (中文)](../runbooks/graph-runtime.md) for upgrades, rollback and recovery.
