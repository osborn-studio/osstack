# Verification publisher: cloud runbook

Date: 2026-11-20. Status: **prepared, not runnable yet**. Execution location: the cloud side, next to the existing Grok Bots. Scope of the first release: `osborn-studio/osstack-bridge-sandbox` and one skill.

Sources: [B8 design](../design/2026-11-19-watcher-recheck-publication.md) (node B8-5, §2.3, §3.2–§3.6, §5), [Grok Bots hand-over](bridge-grok-bots-handoff.md), [bridge runbook](bridge.md). The publisher's code is the package `packages/verify-publisher`; every statement below about its behaviour was read from that code at `f09adb41`.

## 1. What exists and what does not

The publisher package is a library with a command function. It has been tested only against an in-memory GitHub. Three pieces are missing, and all three belong to node B9:

| Piece | State |
|---|---|
| Publish and abandon logic, allowlist and request parsers, attempt ledger | Merged (`packages/verify-publisher/src`) |
| An executable entry point. The package has no `bin`; `runCli` takes its GitHub transport as an argument. | **Not built** |
| The real GitHub transport, including how it reads the private key | **Not built** |
| The fixed harness that checks out the head, runs the pinned profile and writes the request file | **Not built** |

Until B9 delivers these and the owner approves one sandbox run (design §3.6 item 8), **nothing in this runbook writes to GitHub and no command here can be run**. Commands are written with the placeholder `<publisher>` for the future entry point; the arguments after it are the ones `runCli` accepts today.

Rules that hold throughout:

- The publisher is the only place with a credential that can write as the verification App. The host never publishes.
- The publisher writes one check run per result, already `completed`, and never edits one.
- Text from a PR, a chat message or a notice is never a source of a head, a command or an identifier.
- No key, App id or installation id is written into this repository, a chat or a model prompt.

## 2. Preconditions (owner actions)

These are the owner's manual steps from design §3.6. This runbook does not perform them.

- [ ] The verification App is installed on selected repositories only, with the sandbox repository selected; installation id read back.
- [ ] Permissions are exactly Checks read and write and Metadata read-only; no event subscription; webhook inactive.
- [ ] A second private key is generated for the App and placed in the publisher's secret location (§3 below).
- [ ] The host-private producer policy file is filled on the host (`$OSSTACK_HOME/bridge/verification-producers.json`, mode 0600).
- [ ] The cloud location, allowlist file, attempt ledger and evidence store are prepared (§3–§5 below).
- [ ] The Watcher routine is read back on the Grok side: listener and patrol enabled, time zone, and Mission PRs not excluded by the author rule.
- [ ] One real sandbox run is approved, once B9 is ready.

## 3. Key placement

- The key in the cloud is a **second** private key of the same App (design §3.5, arrangement K1). The host keeps its own key and uses it only for the signed installation read. Each key can be revoked on its own.
- The owner places the key by hand. It does not pass through this repository, a chat, a model or the host.
- The key file, the allowlist and the attempt ledger live under an OS user (or a separate small service) that the bots' OS user cannot read. The PR checkout, the browser and the model executor must not be able to read that location.
- File mode 0600, owned by the publisher's user. No copy in a shell profile, an environment file shared with the bots, or a routine prompt.
- The merged publisher code reads no key. How the transport loads it is defined in B9; when that lands, add the exact path rule here.
- To revoke: the owner deletes the key in the App's settings. The host key keeps working.

## 4. The allowlist file

A JSON file, at most 262,144 bytes, read on every call through `--config`. Any unknown field or schema violation makes the command exit 2 with `config_invalid`.

```json
{
  "version": 1,
  "producer": { "app_id": 201, "installation_id": 301 },
  "allow": [
    {
      "repository": "fixture-owner/fixture-repo",
      "repository_id": 101,
      "skill_id": "fixture-skill",
      "skill_version": "1.0.0",
      "skill_blob": "<40 hex>",
      "skill_manifest_digest": "<64 hex>",
      "profile_id": "fixture-profile",
      "profile_digest": "<64 hex>",
      "trusted_source": {
        "repository": "fixture-owner/fixture-harness",
        "commit_sha": "<40 hex>",
        "artifact_digest": "<64 hex>"
      }
    }
  ]
}
```

The values above are synthetic. The real file stays on the cloud side.

- `allow` holds 1 to 32 entries, and at most one entry per repository id and skill id.
- Each entry pins the full skill binding. It must equal the binding the host registers in its producer policy file; a result with another binding is rejected by the host.
- **Changing a binding after a result was published on an open PR stops publishing for that PR** (`binding_changed`). This is intended (design decision 6): a recheck with a moved binding would seal the host's row. Change bindings between Missions, not during one.
- First release: one entry, the sandbox repository and one skill. Adding `osborn-studio/osstack` is a separate owner approval.

## 5. The attempt ledger

One append-only JSONL file, passed through `--ledger`. It is the publisher's memory of what it wrote; without it the publisher cannot number attempts or avoid a second write.

| Entry | Written | Meaning |
|---|---|---|
| `intent` | Before the write, and synced to disk | The exact result text, result id, invocation id, repository id, PR, head, base, skill and attempt number |
| `published` | After the check run was read back and matched | The check run id for that result id |
| `abandoned` | By the `abandon` command only | The intent's write was confirmed absent |

- Keep it on durable storage, mode 0600, on the same protected location as the key. Back it up; **never edit, truncate or rotate it by hand**. A line that does not parse, a duplicate result id or a resolution without an intent makes every command refuse with `ledger_unavailable`.
- One ledger file serves all allowlisted repositories.
- While a command runs it holds `<ledger>.lock`. A second command at the same time refuses with `ledger_unavailable`. A crash can leave the lock file behind; there is no stale-lock detection. Remove the lock file by hand only after confirming that no publisher process is running.
- An `intent` without a `published` or `abandoned` entry is an **open intent**. It blocks all further publishing on that PR until it is resolved (§8).

## 6. The routine's call

The Watcher routine triggers a verification with **the repository id and the PR number, and nothing else** (design §2.3). It does not pass a head, a branch, an outcome or any text.

The intended chain, of which only the last step exists today:

1. The routine calls the harness service with repository id and PR number.
2. The harness reads the PR from GitHub itself, checks out the head it read, runs the pinned profile's commands and records the exit codes. The model does not author the outcome (design decision 3).
3. The harness writes a request file and calls the publisher:

```sh
<publisher> publish --config <allowlist.json> --ledger <attempts.jsonl> --request <request.json>
```

The request file (at most 262,144 bytes):

```json
{
  "version": 1,
  "repository_id": 101,
  "pr": 7,
  "skill_id": "fixture-skill",
  "head_sha": "<the head the harness checked out>",
  "base_sha": "<the base the harness measured against>",
  "record": {
    "invocation_id": "<uuid, new for every harness run>",
    "started_at": "2026-11-16T12:00:00Z",
    "finished_at": "2026-11-16T12:01:00Z",
    "outcome": "passed",
    "failure_code": null,
    "checks": [{ "check_id": "fixture-check", "failure_code": null, "exit": 0, "result_digest": "<64 hex>" }],
    "evidence_refs": [{ "artifact_id": "fixture-artifact", "sha256": "<64 hex>", "size": 12, "type": "text/plain", "retention": 30 }],
    "evidence_digest": "<64 hex>",
    "runtime_provenance": { "runtime_id": "fixture-runtime", "runtime_digest": "<64 hex>", "source_manifest_digest": "<64 hex>" },
    "summary": "Synthetic verification"
  }
}
```

What the publisher does with it, in order: checks the allowlist; reads the PR once and refuses unless it is open, in the same repository, not a fork, and at the same head and base as the request; numbers the attempt from its ledger; checks the binding pin; builds the result with the host's own builder and parser; simulates the host's ledger decision; writes the `intent`; sends one create request; reads the check run back; writes `published`.

Output is one JSON line on standard output. Exit code 0 means done, 1 means refused, 2 means bad arguments or an unreadable or invalid file.

```json
{"ok":true,"status":"published","result_id":"<uuid>","attempt":1,"check_run_id":123}
{"ok":false,"reason":"head_moved","detail":null}
```

The routine treats exit 0 as finished. On exit 1 or 2 it does nothing further and reports the `reason` to the operator; it does not retry with changed input. `detail` carries only an identifier or a closed code.

One automatic verification is published per PR, head and skill. A second call for the same head without `--operator` is refused with `already_verified`.

## 7. Operator commands

All commands run as the publisher's OS user on the cloud side.

### 7.1 Manual trigger

When the Watcher did not verify a head (routine off, outside patrol hours, cloud was down), the operator starts the same chain by hand: run the harness for the repository id and PR number, then the same `publish` command as in §6. There is no separate manual path and no way to hand-write an outcome.

### 7.2 Rerun after an interruption

If a `publish` call was interrupted or ended with `write_unconfirmed` or `read_failed`, run **the same command with the same request file**. The publisher recognises the invocation id and never writes a second time:

- `already_published`: the earlier call had finished; nothing to do.
- `recovered`: the check run existed; it is now recorded in the ledger.
- `write_unconfirmed`: the check run is not on GitHub. Go to §7.3.
- `read_failed`: GitHub could not be read. Run it again later.

### 7.3 Abandon an unconfirmed write

```sh
<publisher> abandon --config <allowlist.json> --ledger <attempts.jsonl> --invocation <invocation uuid>
```

The command looks the check run up once more. Only if it is absent does it write `abandoned` and answer `{"ok":true,"status":"abandoned",...}`. If the check run is found after all, it records it and answers `recovered`. An abandoned attempt does not use up its attempt number.

After an abandon, the same invocation id is refused for good (`invocation_abandoned`). To publish for that head, run the harness again; the new run has a new invocation id.

### 7.4 Republish for the same head

To publish a second result for a head that already has one, run the harness again and add `--operator`:

```sh
<publisher> publish --config <allowlist.json> --ledger <attempts.jsonl> --request <new-request.json> --operator
```

The new result gets the next attempt number. The earlier check run is left untouched. Use this only on the owner's or operator's own decision, never because a PR comment or a bot message asks for it.

### 7.5 What has no command

- **Withdrawing a published result.** The builder can produce a withdrawal, but the publisher has no command for it.
- **Clearing a `readback_mismatch`.** See §8.
- **Editing or deleting a check run.** Never done, by command or by hand.

## 8. Refusals and what to do

| `reason` | Meaning | Action |
|---|---|---|
| `usage`, `config_invalid`, `request_invalid` (exit 2) | Bad arguments, or a file that is missing, too large or fails its schema | Fix the call or the file. A bad request file is a harness fault. |
| `ledger_unavailable` | Ledger locked, corrupt or unreadable | Check for a running publisher and a leftover lock file (§5). If the file is corrupt, stop and restore from backup; do not repair lines by hand. |
| `not_allowlisted` | Repository id and skill id are not in the allowlist | Expected for anything outside the release scope. No action. |
| `read_failed` | The PR or the check runs could not be read | Rerun later (§7.2). |
| `pr_not_open` | The PR is closed or merged | No action. |
| `scope_mismatch` | The PR's base repository is not the allowlisted one | Stop and report; the request does not match the allowlist. |
| `fork` | The head is in another repository | No action. Fork PRs are never published. |
| `head_moved`, `base_moved` | The PR changed since the harness measured it | No action for this record. The new head is verified by its own trigger. |
| `already_verified` | This head already has a published result for the skill | No action, or §7.4 on an operator decision. |
| `unresolved_intent` | Another invocation on this PR has an open intent; `detail` is its invocation id | Resolve that invocation first: rerun it (§7.2) or abandon it (§7.3). |
| `invocation_abandoned` | This invocation id was abandoned | Run the harness again. |
| `binding_changed` | The allowlist binding differs from the first published result on this PR | Publish nothing. Report to the owner (§4). |
| `original_check_missing` | The record lacks a check id of the latest failed result on an earlier head | Harness or profile fault. Publish nothing and report. |
| `build_refused` | The builder refused the record; `detail` is its code | Harness fault, for example a passed outcome with a non-zero exit. Report. |
| `host_would_reject` | The host's ledger rule would reject this result; `detail` is the host's reason code | Publish nothing and report. |
| `write_unconfirmed` | The intent is recorded but the check run is not on GitHub | §7.2, then §7.3. |
| `readback_mismatch` | A check run with this result id exists but differs from the intent, or more than one exists | **Stop.** No command clears this, and the PR stays blocked by the open intent. Report to the owner with the invocation id; do not edit the ledger or the check run. |
| `not_open` (abandon) | No open intent for that invocation id on an allowlisted repository | Nothing to abandon. |

One known gap (design §9): if the host rejected an earlier result for a reason the publisher cannot see, the publisher's next attempt number can differ from the one the host expects. That case ends on the host as `verify_attempt_ambiguous` and needs an operator decision; the publisher has no channel to learn of it.

## 9. Read-back checklist

After each `publish` that exits 0, and in full for the first sandbox run.

Publisher side:

- [ ] The output line has `"ok":true` with status `published`, `recovered` or `already_published`, and a `check_run_id`.
- [ ] The ledger's last entries for that result id are one `intent` followed by one `published` with the same check run id.
- [ ] No `<ledger>.lock` file remains.
- [ ] The credential appears in no output line, log or argument list.

On GitHub, read with any read identity:

- [ ] The check run's name is `osstack/verify-intake/<skill_id>`.
- [ ] Its `head_sha` is the head in the request, and the PR's head still is that commit.
- [ ] Its status is `completed`, and its conclusion matches the outcome: `passed` gives `success`, `failed` gives `failure`, `blocked` gives `action_required`.
- [ ] Its `external_id` equals the `result_id` in the output line.
- [ ] Its `app.id` is the verification App's id.
- [ ] Its output text equals the `text` of the ledger's `intent` entry, byte for byte.
- [ ] There is exactly one check run with that result id.

On the host, read-only:

- [ ] The host's producer policy file registers the same App id, installation id, repository id and skill binding as the allowlist.
- [ ] The host's reader records the result as accepted; a rejection reason of `verify_producer_untrusted`, `verify_attempt_ambiguous` or `verify_contract_invalid` is reported to the owner and not answered by publishing again.

For the first sandbox run also record: the commit the publisher ran from, the digest of the allowlist file, the time of the run and the check run id. Do not record the key, a token or any header.
