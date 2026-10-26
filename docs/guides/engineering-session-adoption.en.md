# Adopt a Session and handle a waiting decision

[中文](engineering-session-adoption.md)

`osstack engineering` provides one entry to adopt an existing Session, inspect waits, send an explicit answer, and observe its reply turn. This local pilot requires explicit enablement. It does not start an initial Agent, select Loop or Graph, or provide a general chat interface.

The completion level is `observed_turn`. OSStack confirms that the reply turn caused by this Mission's answer completed and was stored. This result does not prove code delivery, passing checks, or successful deployment.

An exact decision can currently be adopted by only one Mission, once. This remains true if observation ends or is cancelled before any answer. A later adoption returns `authority_already_adopted`. A cancelled answer cannot be replaced with a new key. Continue through the original Session endpoint, or handle a new decision with a new source-issued identity. Do not fabricate a decision ID to bypass this limit.

## 1. Enable the pilot

Use an exact, admitted Task, Run, and Session. The Session must be `awaiting_decision` and have a nonempty native session ID. The pilot accepts only the default tenant and ordinary product choices or questions that allow text input. Risk and task authorization still use their existing approval endpoints.

The host sets both `OSSTACK_ATTENTION=1` and `OSSTACK_ENGINEERING=1`. Set an explicit, isolated `OSSTACK_HOME`. Do not open `~/.osstack` or a reserved production home from a development checkout. This command does not start a daemon.

Use the existing attention service to establish the exact repository scope:

```sh
osstack attention watch --task TASK_ID --repo /absolute/repository --default-tenant
```

Save the returned `scope_id`. Check the Session's Task, Run, and repository binding. The host operator prepares the authority file, then restarts that home's daemon with the existing operations procedure. The pilot has no command that automatically grants host authority.

### Host identity configuration

`OSSTACK_ENGINEERING_AUTH_FILE` is an absolute path. Its file must belong to the current host user, have mode `0600`, and be a regular file, not a symbolic link. Keep it in a trusted private home and outside every adopted repository. Do not commit it.

The file has this structure. Replace all placeholders. Digests and scopes are 64 lowercase hexadecimal characters.

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

Use separate, cryptographically random credentials. Provision each raw credential through a trusted channel outside the repository into the client environment variable `OSSTACK_ENGINEERING_CREDENTIAL`. The CLI reads that variable only. It does not select a principal from the authority file. Do not place credentials in command arguments, request JSON, logs, reports, or the repository. The authority file stores SHA-256 digests only. The host reloads grants on each request and before first dispatch; revocation does not depend on a stale cache.

Rotating `credential_sha256` while retaining the same principal/client and grants does not revoke that principal's accepted answer awaiting first dispatch. To block dispatch, remove its write grant or its principal/client authority row. The host rechecks principal authority before dispatch; a changed credential hash is not grant revocation. Keep a separately authenticated operator with read + stop authority for recovery.

This is a trusted-process profile. A token file does not isolate a hostile Worker with the same UID. Existing local socket endpoints, including `session.send`, `attention.answer`, `attention.abandon-receipt`, and `task.cancel`, can still operate on the same Session under their original authority rules. Engineering credentials do not replace those rules. Every local caller must be trusted. This pilot does not establish production isolation qualification.

## 2. Observe one reply

Run these commands with the same private home and authenticated client. Save every `--request` or `--action` idempotency key. After a timeout, retry the unchanged request with the same key. Do not change the key to guess the outcome.

`action_id` uses the home's global attention namespace, shared by all principals and legacy commands. Generate and save a globally unique UUID for each new answer, or use its actual Mission UUID with a suffix such as `actualMissionUUID:answer-001`. Do not reuse plain `answer-001` across Missions. `request_id` is unique within the principal/client pair.

```sh
osstack engineering adopt \
  --scope SCOPE_ID --task TASK_ID --run RUN_ID --session SESSION_ID \
  --goal "Observe the reply to this compatibility decision" --request adopt-001 --json

osstack engineering observe --mission MISSION_ID --json > "$OSSTACK_HOME/mission-view.json"
```

Read the question, explicit choice IDs, Mission revision, Wait ID, and state in this file. The file contains a short-lived interaction token. Protect the file and do not commit it. Send an explicit choice. Generate the following UUID once. Preserve `ANSWER_ID` for retries and queries:

```sh
ANSWER_ID="$(node -p 'require("node:crypto").randomUUID()')"
osstack engineering decide --observation "$OSSTACK_HOME/mission-view.json" \
  --wait WAIT_ID --action "$ANSWER_ID" --choice CHOICE_ID --json

osstack engineering observe --mission MISSION_ID --json
```

For a question that allows original text, use `--text "original answer"` instead of `--choice`. Do not supply both. The system does not map “continue” to an assumed choice. Text does not authorize a risk action.

`--observation` uses the exact Mission revision, decision reference, and token in the saved file. The CLI does not silently refresh them before submission. The host checks current source identity, grants, and expiry again.

Interpret each state by its evidence:

| State or fact | Meaning |
|---|---|
| Answer recorded / reserved | The answer reservation is durable. Worker execution is not yet proven. |
| dispatch_committed | This dispatch is committed. An unknown result cannot cause an automatic resend. |
| applied | The full reply turn completed and was stored. This is more than transport acceptance. |
| delivery_unknown / needs_reconciliation | Evidence is incomplete. The original receipt and responsibility remain. |
| Mission completed + ObservationProof | The exact reply turn is confirmed, with no new decision, unresolved wait, unknown effect, or cancellation intent. |

If the reply asks a new question, observe again and handle the new Wait. An older terminal Run, plain `done` text, or an idle Session cannot independently complete this Mission.

If the original answer turn completed but a person advances another manual turn before the next observation refresh, the latest turn no longer matches that answer. The original Mission can remain `observing`. Query the original action receipt and inspect the Session turn records. If this Mission no longer needs observation, explicitly use `end-observation`. Do not resend the answer or invent a completed state.

## 3. Defer, cancel, and end observation

Deferral only changes the recheck schedule. It does not answer or grant permission.

```sh
osstack engineering defer --observation "$OSSTACK_HOME/mission-view.json" \
  --wait WAIT_ID --request defer-001 \
  --revisit-at 2026-10-26T12:00:00Z --reason "Waiting for product input"

osstack engineering cancel --mission MISSION_ID --revision REVISION \
  --request cancel-001 --reason "Stop this work"

osstack engineering end-observation --mission MISSION_ID --revision REVISION \
  --request end-001 --reason "Stop observing this reply"
```

`cancel` stores a stop intent and requests an abort through an independent stop path. An unknown answer does not block it. Neither `stop_requested` nor `stop_unknown` proves termination. An action already in flight can still complete.

`end-observation` ends this Mission's observation and prevents its later first dispatch. It does not stop the Worker, claim success, or erase committed/unknown receipts. The original attention reconciliation responsibility and Session send guard remain active. If the original answer is still waiting for repository writer admission, the host releases that queued work only after durable proof confirms `cancelled_before_dispatch`. This releases work that never started; it does not abort a committed Worker.

When cancellation proves that dispatch never occurred, replay of the original answer with the same key and payload returns `cancelled_before_dispatch`. A changed payload returns `action_conflict`. A new action_id submitted after the Mission ends returns `mission_terminal`. The legacy `session.send` endpoint returns the error code `cancelled_original_answer` for replay of that cancelled message. None of these outcomes permits reopening or replacing the original answer.

| Operation | Current authority required |
|---|---|
| adopt | Scope read + write; records an immutable owner |
| decide / defer / dispose_wait | That owner with current read + write |
| cancel | Current scope read + independent stop, and either the owner or an explicit scope-stop operator |
| end-observation | Owner with read authority, or operator with read + stop |

Other writers cannot replace the owner. Write authority does not imply stop authority. An owner can still cancel after write revocation if read and independent stop remain valid. Read revocation prevents Mission access; a separately authenticated operator provides recovery. If the whole credential is revoked, a separately authenticated scope-stop operator provides recovery.

## 4. Reconcile

Query the original action. This query does not resend it:

```sh
osstack engineering reconcile --kind query_action \
  --mission MISSION_ID --action "$ANSWER_ID" --json
```

If a person handled the question in the original Session, and the old Wait has no answer action or unknown effect in flight, explicitly remove that observation obligation. First read a fresh snapshot:

```sh
osstack engineering observe --mission MISSION_ID --json > "$OSSTACK_HOME/mission-view.json"
osstack engineering reconcile --kind dispose_wait \
  --observation "$OSSTACK_HOME/mission-view.json" --wait WAIT_ID --request dispose-001 \
  --disposition human_answered_out_of_band --reason "Handled in the original Session"
```

The other disposition is `no_longer_relevant`. Disposal binds the exact old Wait and current observation digest. It is an authorized change to the observation goal. It does not create applied evidence, termination evidence, or execution authority. A Wait with an answer action must use receipt query or cancellation; a human statement cannot clear unknown effects.

## 5. Interface and limits

Every command accepts `--input FILE` instead of its business flags. `--json` can be used with it. The request must be strict JSON in a regular, non-symlink file of at most 1 MiB. Unknown fields, duplicate flags, and `actor` or authority claims are rejected. Zod definitions and generated JSON Schemas are in `packages/protocol/src/engineering.ts` and `packages/protocol/schemas/engineering-*.schema.json`.

For text that starts with `--`, such as `--help`, use `--input FILE` with the complete request JSON. Set its `answer` to `{"kind":"text","text":"--help"}`. This fragment is not a complete request. `--text -h` works; `--text --help` is rejected as a missing value.

For `observe`, `--cursor` is an event sequence and `--limit` is 1–100. Check cursor, has_more, and unresolved Waits. Incremental events do not replace the current wait view. Restrict permissions on saved JSON that contains interaction tokens.

| Error | Next action |
|---|---|
| permission_denied | Ask the host operator to check current identity and exact scope grants. Do not add an actor claim to JSON. |
| draining | The host paused new work. Read, query, and authorized stop remain available. After an aborted upgrade, use the recovery procedure below; do not bypass the pause with a new key. |
| dispatch_gate_required | The unified dispatch gate must execute the original answer. Preserve its action and query it through engineering; do not bypass the gate through legacy session.send. |
| dispatch_inconsistent | Dispatch phase, message, or cancellation evidence is inconsistent. Stop new writes and preserve evidence for host-operator investigation. Do not edit the ledger. |
| stale_decision / source_changed | Observe again. Query the old action before creating a new answer, so an accepted effect is not duplicated. |
| action_conflict / action_id_conflict | Preserve the original key and payload. Use a separate request for a distinct intent. |
| delivery_unknown | Query the original action. Do not resend with a new key. |
| signed_approval_required | Use the formal risk/task approval endpoint. |
| executor_not_qualified | Check default tenancy, Session state, native ID, and the supported Adapter profile. |
| not_dispatched_use_cancel | Cancel a proven uncommitted reservation. Do not classify it as an unknown sent message. |
| cancelled_original_answer | The original message was cancelled before dispatch. Query its receipt; do not resend with a new key. |
| authority_already_adopted | This exact decision was already adopted, including observation ended/cancelled without an answer. Use the original Mission/Session endpoint. |
| budget_exhausted | A persistent host or Mission limit was reached. Inspect the ledger; do not reset the database. This home currently permits 1000 cumulative Missions, including terminal records. |
| engineering_busy | Dispatch slots are full. Retry the unchanged request later. Read and stop remain available. |
| mission_terminal | The Mission ended. Read its outcome; do not turn a retry into a new goal or answer. |
| interaction_expired | Query the original action first. If it was never accepted, observe again for a current token and submit an explicit new request. |
| interaction_mismatch | Check the principal/client and original observation file. Do not combine tokens, Waits, or decision references manually. |
| durability_required | The actual daemon write connection is not verified as synchronous=FULL. Correct host configuration; do not bypass the durability check. |
| stop_attempt_budget_exhausted | This Mission has accepted eight stop attempts. The first stop intent remains. Query its receipt and ask the host operator to resolve it; a new key cannot bypass the limit. |

The host permits at most 16 concurrent in-memory dispatch attempts and scans at most 16 reserved actions and 16 active Missions per watchdog page. A reply has a 5-minute host deadline. Expiry requests an abort; it does not prove process termination. Each deferral produces at most one reminder event, visible through `observe`; this pilot sends no external notifications.

The pilot stores at most 1,000 Mission records per home and 64 Waits per Mission. Each Mission permits 256 general control requests. Cancellation and ending observation have separate limits: cancellation permits at most eight accepted stop attempts per Mission, including the first. Each attempt keeps the first stop intent and targets only that Mission's unresolved original committed messages. An identical replay does not consume another attempt. Ending observation is a single terminal operation. Interaction tokens expire after five minutes; a Mission retains at most 32 active tokens. Neither `budget_exhausted` nor `stop_attempt_budget_exhausted` authorizes deletion of unresolved evidence. Query the receipt and ask the host operator to inspect the limit.

`completed` and `failed` are absorbing states. A new cancel or end-observation request returns `mission_terminal`; it cannot change the outcome or abort a later manual instruction in the same Session. An accepted identical request remains available as a read-only replay. After observation ends, the independent stop path can still request abort for this Mission's unresolved committed messages within the stop-attempt limit.

`cost_evidence` reports `status: unknown` and `hard_cap_enforced: false`. The adoption pilot does not meter Provider usage or treat missing usage as zero. The 5-minute host deadline is not a token or cost limit. A real coding reply can exceed it. An abort can leave an unknown receipt and partial workspace edits. This profile is not suitable for unbounded long reply turns.

### Disable and recover

Disabling `OSSTACK_ENGINEERING` does not erase dispatch phases or release the Session guard. An existing `reserved` action still blocks new manual instructions, and legacy `abandon-receipt` requires cancellation first. The disabled engineering endpoint cannot cancel it. Re-enable `OSSTACK_ENGINEERING=1` and `OSSTACK_ATTENTION=1` for the same home, then use a valid credential to query and resolve the original action before disabling again. Do not rewrite or delete database receipts to unlock it. A committed/unknown action still requires its original reconciliation and must not be resent after re-enablement.

### Upgrade, rollback, and service recovery

Schema 47 is a database migration boundary. After migration, a binary that supports only the old schema cannot open this home. Reinstalling an older npm version or replacing only the binary is not a valid rollback. This pilot has no supported database downgrade or automatic rollback path. A backup alone does not authorize rollback: retain post-migration actions and evidence of external effects.

Upgrade checks `attention_dispatch_holds`. A hold clears only when the original committed message is `applied`, or complete proof establishes `cancelled_before_dispatch`. A committed message without applied evidence continues to block upgrade. A failed or unknown receipt, `abandoned_unknown`, ending observation, or disabling the feature cannot clear it. For a failed or unknown action without original applied evidence, the hold can persist indefinitely. This pilot has no supported automatic release procedure. Preserve the home, ledger, and available effect evidence for a separately designed and reviewed offline recovery procedure. Do not edit phases, messages, receipts, or the schema version, and do not delete the database to force an upgrade.

Managed upgrade writes a persistent `upgrade-operation.json` during `resolveAuthority`, before drain or installation. Do not start a managed upgrade while a hold exists. If an unresolved hold then blocks the upgrade, the operation fence and upgrade journal remain, and the operation requires recovery (`recovery_required`). `daemon.resume` only restores admission in the surviving process. It does not remove that fence; a later managed restart can fail with `upgrade_start_blocked`. Existing upgrade reconciliation cannot automatically resolve an indefinite hold for an unknown committed action. This pilot has no supported fence-clear or operator-release procedure for that failure. Preserve the fence, journal, and original home for a separately reviewed and implemented recovery procedure. Do not edit or delete those files, and do not invoke a nonexistent complete or force-clear command.

Even when `daemon.drain` returns `drained: false`, the daemon remains draining. It refuses new tasks and Session writes. An aborted upgrade does not automatically restore admission. First confirm that no install, restart, or other maintenance is still running. Then inspect the hold. An original reserved answer with proof that dispatch never occurred can be explicitly cancelled while draining. An unknown committed action cannot be released this way.

If you abandon this upgrade and keep running the current version, a trusted host operator must call the `daemon.resume` RPC. Then check that `osstack health` reports `result.draining: false`. This version has no `osstack daemon resume` or generic `osstack rpc` command. The following Node command uses the existing local socket RPC and does not open the database. Replace `OSSTACK_SOCKET` with the exact absolute socket path for this home from its daemon startup log. Keep `OSSTACK_HOME` set to that home:

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

Resuming admission lets eligible queued work run again. First cancel any reserved answer that must not execute. `daemon.resume` does not clear an upgrade hold, prove that unknown work stopped, or roll back the database. A bad health condition, such as low disk space, can raise draining again. This RPC uses the existing trusted local host interface; it does not use engineering credential authorization.

Independent checks still required: live Provider replies, physical power loss and filesystem durability, process-domain termination across restarts, hostile same-UID Worker isolation, nondefault tenants, and remote hosts. Unit tests, the full test suite, and model audits do not replace those qualifications.

See the [revised runtime contract](../design/2026-10-25-engineering-agent/runtime-contract-v2.md) and [pilot scenarios](../design/2026-10-25-engineering-agent/pilot-scenarios.json).


## Repeat the local integration check

From a clean development checkout, use the supported Node version and run:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm smoke:engineering-decision
```

The smoke uses a separate daemon process, the compiled CLI, and a deterministic Adapter. It creates its own home, authority file and scratch directory. It tests adoption, observation, deferral, one answer, completed-turn proof, same-key replay and receipt lookup. Success requires exactly one Adapter invocation and confirmed daemon exit. The JSON result always states `provider_qualified: false`. CI runs the same check.

An applied reply is separate from lease cleanup. `health` and `daemon.drain` expose `execution_lease_holds`. A held read or write permit keeps `drained` false, including after a failed physical writer-lock release. `daemon.resume` does not release these permits. Do not force-clear the lock to complete an upgrade.

A detected source identity replacement keeps the Mission in reconciliation, even if all waits were cleared and the old native ID returns. This restriction survives restart. Read the original action receipt or explicitly end observation. A later manual turn does not become the original Mission's success evidence.

See the [remaining-work plan](../plans/2026-10-26-session-pilot-debt.md) for the integration order and external qualification gates.


On upgrade, an existing event with `category: identity` also preserves this restriction. Temporary repository unavailability is a separate category and can recover after the repository returns. This change needs no database migration. Drain counts all held execution permits, including Loop and Graph work; a retained unknown execution can intentionally keep drain blocked.
