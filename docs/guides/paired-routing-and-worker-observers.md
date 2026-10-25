# Paired routing and explicit worker observers

## Paired held-out evaluation

`attention routing-eval --mode paired_holdout --input /absolute/dataset.json` executes two explicitly named models through the controlled no-tools runtime. It never consumes caller-supplied model predictions. Use an explicit development `OSSTACK_HOME` and an existing supported API credential. Missing authentication produces an incomplete report; this is not model-quality qualification.

The strict input is defined by `PairedRoutingInputSchema` in `packages/cli/src/paired-routing-evaluation.ts`: version 1, dataset ID, declared `holdout` split, training prompt SHA256 list, 2–128 distinct cases (`id`, `excerpt`, expected category), exactly two distinct model IDs with explicit per-million input/output/cache-creation/cache-read prices, pricing source, seed, 1–5 repetitions, per-call and total dollar caps, and per-call timeout. Categories are `human_decision`, `system_wait`, and `source_uncertain`. The cap admits at most 256 calls; per-call timeout is at most 30 seconds, total active evaluation is capped at ten minutes between calls, and planned reserved cost must fit the supplied total cap before any provider call. This is a classifier comparison, not a universal coding benchmark.

Only the excerpt goes to the provider. Neither expected labels nor case IDs are sent. Raw and wire-prompt hashes are checked against the operator's declared training set. Pair order is deterministic and counterbalanced. Every result requires requested/runtime/API-reported model agreement, the pinned runtime policy, actual usage classes, and physical process exit evidence. Any error stops further calls. An incomplete evaluation publishes no paired quality comparison, rather than selecting a successful subset.

Cost is usage multiplied by explicit operator-supplied prices, not a billing invoice. Unknown usage remains unknown and retains the call's reserved cost. The 95% Hoeffding interval uses one mean difference per case, grouping repeats; it assumes independently sampled cases and is deliberately wide on small datasets. Labels and holdout independence still need independent dataset review. Requested/API-reported identity does not attest provider weights. Results never change the default route.

Cancellation aborts the runtime and allows its bounded termination escalation/exit observation before CLI exit; repeated SIGINT/SIGTERM requests keep the cancellation handler installed during drain. Unconfirmed runtimes retain their private scratch directory. This does not claim containment against SIGKILL of the host, kernel failure, or arbitrary descendants outside the controlled no-tools runtime.

## Native terminal observers

`worker open VIEW_ID --backend tmux|cmux --repo /absolute/repository --default-tenant --duration-ms 60000` loads only the private host's `viewer-backends.json`. The registry pins schema version 1, canonical `home`, `node` and `cli` objects (`path`, SHA256), and up to one registration of each backend. Each registration fixes its executable pin, exact `version_output`, private same-UID socket, target (`$SESSION_NUMBER` for tmux; UUID for cmux), and `shell: posix`. No RPC request may supply a binary, socket, arbitrary command or existing worker pane.

Paths and ancestors are checked; pins are streamed with bounded memory and rechecked immediately before launch. These are executable/entry-file pins, **not** a cryptographic seal of the complete transitive Node installation. The boundary excludes root or same-UID hostile processes. cmux commands contain only shell-neutral ASCII words; installations with shell-sensitive paths are refused. tmux uses its documented multi-argument direct execution contract. See the [tmux manual](https://man.openbsd.org/tmux.1) and [cmux CLI contract](https://github.com/manaflow-ai/cmux/blob/main/docs/cli-contract.md).

Capability tokens and repository paths travel in a 0600, one-use, 60-second handoff file, never the backend command text. The observer atomically claims and deletes that file. Expired unconsumed handoffs are swept on a subsequent launch; inventory and pending-file limits bound this work. A delayed or failed backend can leave an expiring private handoff until the next launch or operator cleanup. Unknown launch results are not retried. An explicit later operator launch may create another observer.

Only a new observer is created. No send-keys, reuse, focus, kill-pane or worker-stop operation exists. A successful response says `launch_requested` and `backend_runtime_pending`, not that an actual window was observed. This machine has neither tmux nor cmux installed; real version/socket/window/interrupt behavior remains separate qualification. Local tests execute a pinned fixture child and real main/daemon/handoff path, and do not mislabel that fixture as a real backend.

## Separately authorized persisted output

`worker logs --grant-file /private/reader.json [--before-ordinal N]` reads a bounded snapshot of durable session assistant text. It does not read arbitrary files, tool payloads, native process stdout, provider transcripts, or decision bodies. Ordinary `worker list/inspect/watch` tokens remain metadata-only.

A local host operator explicitly registers content access in 0600 `$OSSTACK_HOME/worker-log-grants.json` under a 0700 home outside the target repository:

```json
{"schema_version":1,"grants":[{"repo_path":"/canonical/repo","session_id":"host-known-session-id","capability_sha256":"SHA256_OF_RANDOM_CAPABILITY","issued_at_ms":0,"expires_at_ms":0,"content":"persisted_assistant_text"}]}
```

Replace placeholders with actual canonical scope, a cryptographically random 32-byte base64url capability (43 characters), its SHA256, and current epoch milliseconds; expiration must be after issue and within 15 minutes. The private reader file contains only `repo_path`, `default_tenant:true`, and the raw `capability`. There is no network signer or automatic grant issuer; writing this private host registry is the explicit operator authorization. Removing the row revokes subsequent reads. Host wall-clock correctness is required; no cross-machine time authority is asserted.

Every read reloads and rechecks the registry, then uses one read-only DB transaction to verify exact task/run/session/agent/repository/default-tenant joins. At most four turns and 2,048 bytes per turn are materialized, with original byte count and truncation explicitly reported. Pagination walks older ordinal snapshots; it is not an exactly-once live stream. The daemon allows at most four outstanding output reads. JSON output escapes terminal controls and format characters, remains untrusted text, and grants no worker control. Closing an observer cannot establish process liveness.
