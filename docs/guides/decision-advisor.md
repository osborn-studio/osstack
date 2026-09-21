# Experimental Jev decision advisor

Source preview: build this checkout before using these commands. A published
0.20.0 version label alone does not mean the command is included.

`osstack decision` classifies a selected failure description or suggests one of a
user-supplied list of skills. It returns advisory data only. It cannot execute a
skill, change a task, retry a Graph action, grant permissions, or mark work ready.
No daemon or control-plane database is used. It is not automatically called by Loop.

## Offline use (default)

Create a JSON input file containing only text you intend to evaluate:

```json
{
  "schemaVersion": 1,
  "scopeId": "my-project",
  "taskId": "csv-export",
  "taskRevision": 1,
  "purpose": "failure_label",
  "state": "CSV export test failed: expected UTF-8 column names, received replacement characters."
}
```

```sh
osstack decision advise --input decision.json
```

This validates the input and prints its digest, pinned model, available options,
and request size. It makes no network request, requires no key and writes no ledger.
It does **not** produce a predicted classification or measure model quality.

For `"purpose": "skill_hint"`, add `"candidates"`:

```json
[
  { "id": "regression-tests", "description": "Write and run focused regression tests" },
  { "id": "docs", "description": "Improve user documentation" }
]
```

There must be 1–32 unique candidate IDs. The application supplies the `abstain`
option. State is limited to 8192 UTF-8 bytes; each description to 512 bytes;
the complete request to 32768 bytes. These are byte limits, not token estimates.
Unknown fields, including permission fields, are rejected.

## Explicit live experiment

Initialize a new dedicated directory. Its parent must exist. Do not use a shared
directory, a control-plane home, a network drive, or a symlink as the store.

```sh
osstack decision init --store "$PWD/.decision-experiment" --scope my-project
osstack decision advise --input decision.json --store "$PWD/.decision-experiment" --live
osstack decision status --store "$PWD/.decision-experiment"
```

Supply `TYPESAFE_API_KEY` through your secret manager or environment. Do not put it
in the JSON, command arguments, source control, or logs. `--live` sends the selected
state and skill descriptions to TypeSafe. It does not scan or upload the repository.
Choose and redact that text before invoking the command. Exact occurrences of the
configured API key are rejected; this is not a general secret scanner.

Default per-store limits are **1000 dispatched requests, USD 1 (1000000 microUSD),
and 10000000 input tokens**; the first exhausted limit stops new dispatches.
`init` accepts smaller limits with `--max-calls`, `--budget-microusd`, and
`--max-input-tokens`. Initialization cannot reset an existing store. Limits are
per store, not account-wide: creating another store creates another budget.
The provider's account controls remain the authority for actual billing limits.

The model is pinned to `jev-1.13.0`. The code's rate card is dated 2026-09-21:
USD 0.042 per million input tokens, free output. See the official
[model documentation](https://docs.typesafe.ai/models) and
[HTTP contract](https://docs.typesafe.ai/api). A price or model change requires a
reviewed code/rate-card update; the CLI never follows a floating model alias.

Before sending, the ledger durably reserves **65536 input tokens and 2753 microUSD**.
A validated answer settles to reported input usage, rounded up to whole microUSD.
A timeout, HTTP error, invalid answer, or uncertain transport failure keeps the
full reservation. Held money is a conservative local allowance, **not proof of a
provider charge**. Dispatch is never retried automatically, including 429/529.
The 1500 ms deadline covers response headers and the entire response body; the
body is capped at 65536 actual bytes and must be valid UTF-8.

Repeated input with the same scope, task revision, candidate set, question version,
model, and rate card returns its existing record without another request. A changed
revision or input creates a different request. An `abstain` choice is a valid answer.
Confidence describes the provider distribution; it is not a measured correctness rate.

Exit codes: `0` for help, initialization, status, dry-run, or a validated answer;
`2` for an unknown/dispatched outcome; `1` for invalid input, unavailable credentials,
busy/corrupt store, or exhausted budget. Unknown results retain a safe failure
category and HTTP status when available (for example, `http_error` / `401`),
so an authentication failure is diagnosable without releasing its hold. Errors
omit input text and provider error bodies.

## Persistence and recovery

Directories are private (0700), records are private (0600), and files are checked
for ownership, regular-file type, hard links and symlinks. Supported filesystem
types are APFS, HFS, ext-family, overlayfs, Btrfs, XFS, ZFS and F2FS on POSIX systems.
Linux tmpfs is rejected. macOS temporary directories may use APFS but are still
auto-cleaned: never keep a live ledger there. Use persistent local storage for live
experiments. Darwin filesystem type numbers are platform-dependent; unfamiliar
types fail closed and need a reviewed compatibility update. Processes with the same OS user are trusted; the ledger is
not a sandbox against malicious processes running as that user.

The store contains model/rate/budget configuration and digest-named result records.
It intentionally does **not** retain raw input text, request bodies, API keys, or
provider error bodies. Keep your redacted input file if semantic replay is required;
the digest alone cannot reconstruct it. Normal result replay never contacts Jev.

Status is a best-effort read-only snapshot and remains available while a writer
or a crash-left lock exists. Admission always rechecks under the write lock.

An exclusive `.lock` directory serializes writers and is deliberately left behind
when a process is killed. `DECISION_STORE_BUSY` never causes automatic unlocking.
Recovery is an operator action:

1. Stop all processes using that store and establish that the previous owner has
   exited. A PID alone is insufficient evidence because it can be reused.
2. Preserve the store and examine its records. `dispatched` means the outcome is
   unknown; retain its budget hold regardless of whether an answer was observed.
3. Remove **only the empty `.lock` directory** using `rmdir`, after establishing
   that no writer remains. Never remove or edit digest records to force a retry.
4. Run `decision status`. Repeating `advise` will return the unknown record, not send.

Process-crash recovery is tested; sudden power loss is not guaranteed by Node
`fsync` on all hardware/platforms. After power loss, reconcile against provider
records before using the store again.

Finder `.DS_Store` metadata is ignored. Other unexpected entries produce
`DECISION_STORE_CORRUPT` and require inspection. If `init` fails, preserve the
directory and inspect it: a valid `config.json` can be read with `status`; an
incomplete initialization with no config cannot be used for live calls. After
confirming no process remains, remove only an empty directory with `rmdir`, or
choose a new directory. Do not delete digest records to repair initialization.

Disk loss, manual ledger deletion, malicious same-user edits and creating a new
store are outside the at-most-once guarantee. Back up a live ledger before moving it.

## Validation and promotion

Focused tests cover strict contracts, budgets, malformed answers, default zero
network, timeout across streaming, replay, and store isolation. Build and run:

```sh
pnpm smoke:decision-advice
```

The smoke test uses synthetic fetch responses in real CLI subprocesses. It checks
six simultaneous submissions, a SIGKILL during a request, sticky-lock recovery,
and retained unknown holds. It makes zero real provider calls.

This implementation has no live quality or latency result. Before enabling a Loop
observer, use independently labeled English/Chinese failures and skill tasks,
including ambiguous and adversarial inputs. Freeze examples and expected labels
before querying; separate threshold tuning from held-out evaluation. Compare
against deterministic rules and the current general-purpose model, reporting
accuracy, abstention/coverage, false recommendations, p50/p95 latency, and observed
plus unknown cost. Do not enable automatic routing solely because the HTTP and
storage tests pass. Loop/Graph authorization and stop evidence remain independent.
