# Verification harness: cloud runbook and drill plan

Date: 2026-11-24. Status: **prepared, never run**. Execution location: the cloud side. Scope of the first release: `osborn-studio/osstack-bridge-sandbox` and one skill.

Sources: [runtime design](../design/2026-11-24-verification-publisher-runtime.md) (§5, §7, §9.1, §10), [publisher runbook](bridge-verification-publisher.md), [B8 design](../design/2026-11-19-watcher-recheck-publication.md), [owner's drill checklist](../plans/2026-11-25-sandbox-drill-checklist.md). The harness is the package `packages/verify-harness`. Every statement below about its behaviour was read from that code at nodes B9-4 and B9-5. No command here has been run against GitHub or Docker.

## 1. What the harness is

The harness measures one PR head with one pinned verification profile and writes a request file. The publisher reads that file and publishes the result ([publisher runbook](bridge-verification-publisher.md) §6).

Rules that hold throughout:

- The harness holds no credential. It has no key, no token and no code that can send one. It reads the PR and fetches the code without authentication. It works only for public repositories.
- Its input is a repository id and a PR number. No flag names a head, a branch, a command, a profile or an outcome.
- It runs profile commands only inside the container that the host uses for its own recheck. If the container runtime is not available, it stops before any candidate code runs. There is no fallback.
- Output of the candidate never reaches the request file. The summary is a sentence with two byte counts.
- A PR head is untrusted code. Text from a PR, a chat message or a notice is never a source of a head, a command or an identifier.

## 2. Preconditions (owner actions)

This runbook does not perform these steps.

- [ ] The cloud computer has two OS users besides the bots' user: one for the publisher and one for the harness. Neither can read the other's home directory. The bots' user can read neither.
- [ ] The harness user runs **rootless Docker**. No rootful Docker daemon runs on the computer that holds the publisher's key. (Design decision 6, confirmed by the owner on 2026-11-25: no rootful Docker is installed or used on that computer. A container escape acts as the harness user; with a rootful daemon that equals root, and root can read the key.)
- [ ] Before any repository that receives PRs from outside this system is added: the harness moves to a separate computer from the publisher (design decision 6).
- [ ] The verification profile artifact is installed under the profiles directory (§3), and its base image is present in the harness user's Docker.
- [ ] The harness configuration file is written (§4). Its binding equals the publisher's allowlist entry and the host's producer policy.
- [ ] Git is installed at one of `/usr/local/bin`, `/usr/bin`, `/bin`, `/opt/homebrew/bin`.
- [ ] The checkout is at a pinned commit, with `pnpm install --frozen-lockfile` and `pnpm build` done as a user that the harness user cannot write as.

## 3. Directories

All paths are absolute. All belong to the harness user unless stated.

| Directory | Mode | Content | Passed as |
|---|---|---|---|
| Data | 0700 | `repos/` (a private bare repository per run, removed after the run) and `journal/` (the container executor's launch and stop records). The harness creates the two subdirectories. | `--data` |
| Evidence | 0700 | One directory per invocation id with `stdout`, `stderr` and `stop-receipt.json`, each 0600. Candidate output is untrusted text; do not paste it into a chat or a model prompt. | `--evidence` |
| Drop | 2750, group of the publisher's user (§3.1) | One request file per successful run, named `<invocation id>.json` | `--drop` |
| Profiles | 0700 | `<artifact digest>.json` for each installed profile. The loader refuses a file that the harness user does not own. | `profiles_root` in the configuration |

Evidence retention is 30 days (design decision 10). Deleting older evidence directories is an operator step; the harness does not delete them. The `journal/` directory is not deleted while any container of the harness may still exist.

### 3.1 The drop directory and the publisher's user

Decided by the owner on 2026-11-25 (design §9.1).

- A group exists whose only member is the publisher's user. The harness user is not a member.
- The drop directory is owned by the harness user, has that group, the set-group-id bit, and mode 2750. The publisher's user can list and read it and cannot write into it. Other users cannot enter it.
- The harness writes each request file with mode 0640. The file gets the directory's group through the set-group-id bit. The harness does not change an owner or a group.
- No step runs as root after this one-time setup.
- A request file holds identifiers, commit SHAs, digests and an exit code. It holds no secret and no candidate output.

Check after setup: as the publisher's user, reading a test file in the drop directory succeeds and creating one fails; as the bots' user, listing the directory fails.

## 4. The configuration file

A JSON file, at most 262,144 bytes, read on every run through `--config`. An unknown field or a schema violation makes the command exit 2 with `config_invalid`.

```json
{
  "version": 1,
  "docker": { "socket_path": "/run/user/<uid>/docker.sock", "daemon_id": "<the daemon's id>" },
  "profiles_root": "/<absolute path>/profiles",
  "entries": [
    {
      "repository": "fixture-owner/fixture-repo",
      "repository_id": 101,
      "skill_id": "fixture-skill",
      "profile_id": "fixture-profile",
      "profile_digest": "<64 hex>",
      "trusted_source": { "repository": "fixture-owner/fixture-harness", "commit_sha": "<40 hex>", "artifact_digest": "<64 hex>" },
      "base_image_id": "sha256:<64 hex>",
      "allowed_argv": ["<the profile's argv, word for word>"],
      "failure_code": "fixture-failure"
    }
  ]
}
```

The values above are synthetic. The real file stays on the cloud side.

- `entries` holds 1 to 32 entries, and at most one entry per repository id. One skill per repository in this version.
- `profile_id`, `profile_digest` and `trusted_source` must equal the publisher's allowlist entry. A difference ends at the publisher as `binding_changed` or at the host as a rejection.
- `allowed_argv` must equal the profile's `argv` exactly. The loader accepts no prefix and no extra argument.
- `failure_code` is the one code written into a `failed` result. Keep it equal to the code that the host's producer policy allows (design decision 9).
- `daemon_id` is the id that the harness user's Docker reports. A daemon with another id is refused.

## 5. The command

Run as the harness user, from the pinned checkout:

```sh
node packages/verify-harness/dist/bin.js --config <config.json> --repository-id <n> --pr <n> --drop <dir> --evidence <dir> --data <dir>
```

Each flag is required exactly once. The package is private and is not published to npm.

What it does, in order:

1. Finds the configuration entry for the repository id.
2. Reads the PR once from `api.github.com` without authentication. It continues only if the PR is open, has that number, has the configured base repository id and name, and is not a fork. It takes the head and base SHA from this answer.
3. Creates a new private bare repository under `<data>/repos`, fetches the head commit by its SHA from `https://github.com/<repository>.git` (HTTPS only, no credential helper, no redirect, no hooks, no global or system Git configuration), exports the commit's files with the host's exporter, and removes the repository.
4. Loads the installed profile and checks that it has exactly one check.
5. Builds the image and runs the profile's command in the container.
6. Accepts the result only with a proven container stop.
7. Writes the evidence directory, then the request file.

Output is one JSON line. Exit code 0 means a request file was written; 1 means refused or not measured; 2 means bad arguments or configuration.

```json
{"ok":true,"invocation_id":"<uuid>","file":"<uuid>.json","outcome":"passed"}
{"ok":false,"reason":"pr_not_open"}
```

`outcome` is `passed`, `failed` or `blocked`. A `blocked` record is exit 0: it is a measurement, and the publisher publishes it.

| Container result | `outcome` |
|---|---|
| Exited 0 | `passed` |
| Exited with one of the profile's failure exit codes | `failed`, with the configured `failure_code` |
| Any other exit code, a timeout, an output limit, an OOM kill, a runtime error | `blocked` |

The harness does not stop on a signal in an orderly way. If the process is killed during a run, inspect the daemon for a leftover container before the next run.

## 6. The chain to the publisher

1. The trigger gives the harness a repository id and a PR number (publisher runbook §6).
2. The harness writes `<drop>/<invocation id>.json` and prints the file name.
3. The publisher is started with that file: `publish --key … --config … --ledger … --request <drop>/<file>`.

No code in either package starts the other. How step 3 is started (the routine's wrapper, an operator, or a path-triggered service unit) is cloud setup and is not decided here.

A request file that the publisher has handled (exit 0, or a refusal that will not change, such as `head_moved`) may be removed from the drop directory by the operator. The publisher's attempt ledger, not the drop directory, is the record.

## 7. Refusals and what to do

| `reason` | Meaning | Action |
|---|---|---|
| `usage`, `config_invalid` (exit 2) | Bad arguments, or a configuration file that is missing, too large or fails its schema | Fix the call or the file. |
| `not_configured` | The repository id is not in the configuration | Expected outside the release scope. No action. |
| `pr_read_failed` | The PR could not be read, or the answer did not have the expected shape | Rerun later. Unauthenticated reads are limited per IP address. |
| `pr_not_open` | The PR is closed or merged | No action. |
| `scope_mismatch` | The PR's number or base repository does not match the configuration | Stop and report. |
| `fork` | The head is in another repository | No action. Fork heads are never fetched. |
| `source_unavailable` | The head could not be fetched or exported | Rerun later. If it repeats, check Git and the network from the harness user. |
| `candidate_unsupported` | The head has a file that is not a regular file, or exceeds the exporter's limits (10,000 files, 32 MiB) | No result for this head. Report. |
| `profile_unavailable` | The profile artifact is missing, has another digest or owner, its `argv` is not allowed, it has more than one check, or its limits are not the supported ones | Fix the installed profile or the configuration. |
| `isolation_unavailable` | Docker is unreachable, the daemon id differs, or the image could not be built from the base image | Fix Docker. No candidate code ran. |
| `stop_unknown` | The container's stop is not proven | **Inspect the daemon by hand before any rerun.** A container of the harness may still exist. No request file was written. |
| `request_write_failed` | The evidence or the request file could not be written | Check the two directories and free space. The container ran and has stopped; rerun the harness. |
| `internal` | An unexpected error. No message text is printed. | Check that the drop, evidence and data directories exist. Report if it repeats. |

The harness never retries by itself. A rerun is a new invocation with a new id.

## 8. What the harness does not do

- It does not publish, and it cannot. It writes no check run and holds no credential.
- It does not decide whether a head is verified twice. The publisher refuses a second automatic result for the same head (`already_verified`).
- It does not keep state between runs, except the evidence and journal directories.
- It does not serve private repositories.
- It does not delete evidence.
- It does not upload evidence anywhere. `evidence_refs` is empty in the first release; no host code reads evidence yet.

## 9. Drill plan (not approved, not run)

Each item needs the owner's separate approval and goes only to `osborn-studio/osstack-bridge-sandbox` (design §10). Record the evidence named in the right column. Never record a key, a token, a header or candidate output.

Preparation, read-only:

- [ ] The commit both programs run from; `pnpm install --frozen-lockfile` and `pnpm build` succeed; SHA-256 of `packages/verify-harness/dist/bin.js` and `packages/verify-publisher/dist/bin.js`.
- [ ] As the harness user, a read of the key file, the attempt ledger and the allowlist is refused. As the bots' user, the same reads and a read of the harness's data directory are refused. Record each refusal.
- [ ] `docker info` as the harness user shows a rootless daemon; record its id. No rootful daemon is running.

| # | Step | Evidence to record |
|---|---|---|
| 1 | Harness run on one open sandbox PR | The output line; the duration of the fetch; the request file's digest |
| 2 | Inside that run, the container contract on this Docker: no network, no host path, limits enforced, stop receipt produced | The stop receipt; with rootless Docker, any executor flag that the daemon refused |
| 3 | Publisher run with that request file | The output line; the ledger's `intent` and `published` entries |
| 4 | GitHub accepted the signed App token and returned the expected installation | Exit 0 of step 3 (the publisher stops with `read_failed` otherwise) |
| 5 | The scoped token read the public PR and the check runs | The same. If step 3 ends with `read_failed` here, stop: decision 3's fallback (reads without authentication) needs a code change first. Do not add a permission to the App. |
| 6 | The check run shows the verification App's id, and its output text equals the ledger's `intent` text byte for byte | The read-back checklist of the publisher runbook §9 |
| 7 | The host reader accepts the result: producer proof, policy match, source ledger | The host's read-only record of the accepted result |
| 8 | A second harness and publisher run for the same head, without `--operator` | `already_verified` |
| 9 | A harness run on a closed PR and on a PR number that does not exist | `pr_not_open`, `pr_read_failed` |
| 10 | An impostor check run with the same name from another App | The host's rejection |
| 11 | With the Watcher's trigger: the delay from a push to the published result | Two timestamps |

Stop the drill at the first unexpected result. Do not edit the ledger or a check run, and do not rerun with changed input.
