# U4b B9: verification publisher runtime

Date: 2026-11-24. Status: **proposed; the decisions in §9 are open**. Design only: no code, test, migration, GitHub write, App setting or sandbox run is part of this change.

Baseline: `origin/main` at `176ea389`. Every `file:line` below refers to that commit.

Parent contracts: [verify-failure intake](2026-11-16-verify-failure-intake.md) ("the intake design") and [Watcher recheck publication](2026-11-19-watcher-recheck-publication.md) ("the B8 design"). The cloud procedure is the [publisher runbook](../runbooks/bridge-verification-publisher.md) ("the runbook"). This document changes none of their decisions, with one exception that it names and puts to the owner: the fallback in B8 decision 8 (§3.4 below).

## 0. The gap

The runbook lists three pieces that are not built (`docs/runbooks/bridge-verification-publisher.md:13-16`):

1. An executable entry point. The package has no `bin` (`packages/verify-publisher/package.json:8-12`), and `runCli` takes its GitHub transport as an argument (`packages/verify-publisher/src/cli.ts:7`, `:44`).
2. The real GitHub transport, including how it reads the private key.
3. The fixed harness that reads the PR, obtains the head, runs the pinned profile and writes the request file.

Until they exist, nothing can publish a verification result, the recheck ledger never receives input (a), and `recheck_passed` is unreachable in production (B8 design §0).

Two terms are used throughout:

- **The publisher**: the process that holds the cloud key (K1) and writes the check run. It is `packages/verify-publisher`.
- **The harness**: the process that runs code from a PR head inside a container and writes the request file. It holds no credential.

## 1. What exists today

| Fact | Evidence |
|---|---|
| The publisher's GitHub interface has two operations: `get(path)` and `createCheckRun(repository, body)`. There is no edit operation. A reply is `{ ok: true, body }` or `{ ok: false }`, with no error detail. | `packages/verify-publisher/src/publish.ts:11-16` |
| The publisher makes at most four kinds of call: one PR read, one check-run list for a commit, one check-run detail, one check-run create. | `publish.ts:163`, `:80`, `:93`, `:201` |
| `runCli` passes a signal that is never aborted. Every time limit must therefore be inside the transport. | `cli.ts:54` |
| `runCli` refuses any flag other than `--config`, `--ledger`, `--request` or `--invocation`, and `--operator`. | `cli.ts:13-24` |
| The request file carries repository id, PR number, skill id, the measured head and base, and a `record` object. It is at most 262,144 bytes. | `packages/verify-publisher/src/config.ts:22-26`, `cli.ts:32` |
| The record's fields are fixed by the builder's type. They are values only. | `packages/core/src/bridge/verification-result-builder.ts:6-18` |
| The allowlist entry pins the skill, the profile id and digest, and the trusted source with its artifact digest. It holds no failure code and no Docker setting. | `config.ts:8-13` |
| A static test restricts the publisher package: imports only from `@osstack/core/verification-publish`, `zod` and three Node modules; no `fetch(`, `child_process`, `node:http`, `process.env`, `PATCH`, `DELETE` or `PUT`; exactly one `createCheckRun(` call in `publish.ts`. | `packages/verify-publisher/src/guard.test.ts:41-46` |
| The host accepts an installation only when it has exactly two permissions: `checks: write` and `metadata: read`. Any third permission gives `not_installed`, and the result is then rejected as `verify_producer_untrusted`. | `packages/cli/src/contained-mission-verification-installation.ts:77-79`; `packages/cli/src/contained-mission-verification-reader.ts:96-97` |
| The host's installation read builds a JWT with `iat` 60 seconds in the past and `exp` 540 seconds ahead, opens the key with `O_NOFOLLOW`, and refuses a key that is not a regular file, is readable by group or others, or belongs to another user. | `contained-mission-verification-installation.ts:21-34` |
| The host's read transport accepts four GET path shapes and nothing else, with 15 seconds and 1 MiB per request. | `packages/cli/src/contained-mission-verification-read-transport.ts:6`, `:17-18` |
| A verification profile is one JSON artifact: one harness file, fixtures, one `argv`, an image pinned by digest, a list of checks with their failure exit codes, and limits. `network` is `none`, the root is read-only, and the working directory is the candidate. | `packages/cli/src/contained-mission-verification-profile.ts:22-32` |
| The installed profile is the file `<artifact_digest>.json` under a host-configured directory. The loader checks owner, mode, link count, size, the artifact digest, the profile digest and an allowed `argv` list. | `contained-mission-verification-profile.ts:100-131` |
| The host runs a profile through `prepareContainedProfileImage` and `runPreparedContainedProfile`. Both accept injected replacements, which is how the host tests them without Docker. | `packages/cli/src/contained-mission-profile-execution.ts:33`, `:79`; `packages/cli/src/contained-mission-local-failure-recheck-run.ts:182`, `:200` |
| The container has no network, a read-only root, all capabilities dropped, no new privileges, user 65534, 64 pids, 128 MiB, 1 CPU and a 16 MiB `noexec` `/tmp`. | `packages/agents/src/contained-command.ts:100-107` |
| The image build never runs candidate code: a pinned local `FROM`, `COPY` and `WORKDIR`, with `pull=false` and `networkmode=none`. | `packages/agents/src/contained-image.ts:49-50`, `:64`, `:82` |
| The host exports the candidate from Git objects of one commit, not from a working tree. It accepts regular files only, at most 10,000 files and 32 MiB, and checks every blob hash. | `packages/cli/src/contained-verification.ts:52-80` |
| The host run supports exactly one check per profile and exactly one allowed failure code. | `contained-mission-local-failure-recheck-run.ts:118`; `packages/core/src/bridge/diagnosis-admission.ts:169-171` |
| The host computes a check's `result_digest` from exit code, output digests, termination, OOM flag and start flag. | `contained-mission-local-failure-recheck-run.ts:239-248` |
| The profile loader, the profile execution and the commit exporter live in `packages/cli/src`. Eight non-test files in that package import them. `@osstack/agents` already exports the image preparer and the command executor. | `packages/agents/src/index.ts:173-177`; importer list read with `grep` on 2026-11-24 |
| The repository rule on direct Git writes counts `init`, `fetch` and `clone` as writes in any `packages/*/src` file, and its allowlist "may only shrink". | `scripts/check-deterministic-rules.mjs:377`, `:399-401`; `AGENTS.md` (Security & Configuration Tips) |
| No host code reads `evidence_refs`, `runtime_provenance` or the policy's `evidence_store` beyond the schema. | `grep` over `packages/cli/src` and `packages/core/src/bridge` on 2026-11-24; schema at `packages/core/src/bridge/verification-result.ts:50-52` |

## 2. Shape of the solution

```text
trigger (repository id, PR number)
   │
   ▼
harness  ── no key, no token ──────────────────────────────┐
   1. read the PR from GitHub (no authentication)           │
   2. fetch the head commit by its SHA, export Git objects  │
   3. load the pinned profile artifact                      │
   4. build the image, run the container (no network)       │
   5. map the exit code to a record                         │
   6. write <drop>/<invocation_id>.json                     │
                                                            ▼
publisher  ── holds key K1 ─────────────────  reads the request file
   1. allowlist, ledger, PR read, head check (merged code)
   2. JWT → installation check → one scoped token
   3. one POST, then read back (merged code)
```

The two processes share one thing: the request file. The harness never starts the publisher from its own code, and neither package imports the other.

## 3. The GitHub transport

### 3.1 Where it lives

One new file, `packages/verify-publisher/src/github-transport.ts`, exporting `createPublisherGithub(config, deps)` that returns a `PublisherGithub` (`publish.ts:13-16`). Key loading is a second new file, `src/app-key.ts`. `fetch` is injected (`deps.fetchImpl`), as in the host proof (`contained-mission-verification-installation.ts:54`, `:66`), so every test runs against an in-memory fake.

The guard test (`guard.test.ts:41-46`) is narrowed, not removed:

- `fetch(` is allowed in `github-transport.ts` only.
- `node:fs/promises` key reads are allowed in `app-key.ts` only; no other file may name the key flag or open the key path.
- `method:` appears exactly three times in the transport, as the literals `GET`, `POST` (token) and `POST` (check run). `PATCH`, `PUT` and `DELETE` stay forbidden in the whole package.
- `process.env`, `child_process` and `node:http` stay forbidden in the whole package.

### 3.2 How it authenticates

1. **JWT.** Signed with K1, `RS256`, `iss` = the App id from the allowlist file (`config.ts:17`), `iat` 60 seconds in the past, `exp` 540 seconds ahead. These are the host's values (`contained-mission-verification-installation.ts:32`). GitHub allows at most 10 minutes (GitHub documentation, read 2026-11-24).
2. **Installation check.** `GET /repos/{repo}/installation` with the JWT. The transport continues only when the answer shows the configured installation id and App id, `suspended_at` null, `repository_selection` equal to `selected`, and exactly the two permissions `checks: write` and `metadata: read`. This is the host's rule (`contained-mission-verification-installation.ts:77-79`), applied before the write, so the publisher does not write a result that the host would then reject for a widened App.
3. **Token.** `POST /app/installations/{installation_id}/access_tokens` with the JWT and the body `{ "repository_ids": [<the one repository id>], "permissions": { "checks": "write", "metadata": "read" } }`. GitHub lets these two body fields narrow the token (GitHub documentation, read 2026-11-24). The transport accepts the answer only when it lists exactly that one repository id and exactly those two permissions.
4. **Use.** The token is held in memory for one process run. It is not cached on disk, not printed, and not passed to any other process. One `publish` or `abandon` call mints at most one token. GitHub expires it after one hour (same source).

Steps 2 and 3 happen lazily, on the first GitHub call of a run. A run that is refused before any GitHub call (bad arguments, not allowlisted, an open intent) reads no key.

### 3.3 How it reads the key

- The path comes from a required flag of the entry point, `--key <absolute path>`. It does not come from the environment, the allowlist file or the request file.
- The file is opened once with `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`. The transport refuses it unless it is a regular file, has no group or other permission bits, belongs to the current user, and is at most 16 KiB. These are the host's checks (`contained-mission-verification-installation.ts:23-28`) plus a size bound.
- The key text exists only inside `app-key.ts` and the signing call. It is never placed in an error, a log line, an output line or the ledger. A failure of any step in §3.2 reaches `publish.ts` as `{ ok: false }` and the operator as `read_failed` or `write_unconfirmed` (`publish.ts:165`, `:115`). The entry point prints one closed code for a key problem, `key_unavailable`, and exits 2.
- The session that writes this code never reads a real key. Tests generate a throwaway RSA key in memory at run time; no key material is committed.

### 3.4 Which calls, with which limits

All requests go to the fixed origin `https://api.github.com` with `redirect: 'error'`, `accept: application/vnd.github+json` and `x-github-api-version: 2022-11-28`.

| Call | Method and path | Auth | Time limit | Response byte limit |
|---|---|---|---|---|
| Installation check | `GET repos/{repo}/installation` | JWT | 5 s | 64 KiB |
| Token | `POST app/installations/{id}/access_tokens` | JWT | 10 s | 64 KiB |
| PR read | `GET repos/{repo}/pulls/{n}` | token | 15 s | 1 MiB |
| Check-run list | `GET repos/{repo}/commits/{sha}/check-runs?check_name=…&filter=all&per_page=100` | token | 15 s | 4 MiB |
| Check-run detail | `GET repos/{repo}/check-runs/{id}` | token | 15 s | 1 MiB |
| Check-run create | `POST repos/{repo}/check-runs` | token | 15 s | 1 MiB; request body at most 64 KiB |

- The body is read as a stream and the read stops at the limit, as the host proof does (`contained-mission-verification-installation.ts:36-50`).
- No call is retried. For the create call this is a rule of the merged publisher: an unknown outcome is resolved by a read-back, never by a second write (`publish.ts:201-203`, `:102-116`).
- The worst case for one run is about 75 seconds of GitHub time (six calls at their limits).
- Any status other than 200 (201 for the create call), a redirect, a body over the limit, or a body that is not JSON gives `{ ok: false }`.

**One open platform fact.** The publisher reads the PR with a token that has no Pull requests permission. The sandbox repository is public. GitHub's page for this endpoint does not say whether such a token may read a public PR (read 2026-11-24; the B8 design left the same point open at its §9). If the drill shows that it may not, the fallback of B8 decision 8, "add Pull requests read-only", **no longer works**: the merged host proof would then reject every result (`contained-mission-verification-installation.ts:78-79`). The fallback that keeps the host unchanged is to send the three GET calls without authentication (the unauthenticated limit is 60 requests per hour per IP address; a run uses at most three). Decision 3 in §9.

### 3.5 How it refuses any other repository

Four independent layers, each sufficient alone:

1. **The path.** The transport is built from the allowlist's `repository` names (`config.ts:9`). `get` accepts only the three GET shapes of §3.4 for exactly those names, by one anchored pattern, in the manner of the host transport (`contained-mission-verification-read-transport.ts:6`, `:13-15`). `createCheckRun` accepts only those names. Anything else returns `{ ok: false }` without a request.
2. **The token.** It is minted for one repository id (§3.2 step 3). GitHub enforces this, so a path bug cannot write elsewhere.
3. **The installation.** It must be `selected` (§3.2 step 2). Installing the App on all repositories stops the publisher.
4. **The merged publisher.** It checks the allowlist, then that the PR's base repository id and name equal the allowlist entry, and that the PR is not a fork (`publish.ts:147-148`, `:168-169`).

## 4. The entry point

- A new file `packages/verify-publisher/src/bin.ts` and a `bin` field in `package.json` named `osstack-verify-publisher`. The package stays private (`package.json:6`); nothing is published to npm. In the cloud it is run from a checkout of a pinned commit: `node packages/verify-publisher/dist/bin.js …`.
- Arguments: `publish|abandon --key <path> --config <path> --ledger <path> (--request <path> [--operator] | --invocation <uuid>)`. The entry point removes `--key`, builds the transport and calls `runCli` with the rest (`cli.ts:44`). It adds no other command.
- `now` is the system clock; `uuid` is `crypto.randomUUID`; `stdout` writes one line.
- Exit codes are those of `runCli` (`cli.ts:47`, `:64`): 0 done, 1 refused, 2 bad arguments or files. A missing or unsafe key is exit 2 with `key_unavailable`.
- An uncaught error prints `{"ok":false,"reason":"internal","detail":null}` and exits 1. It prints no stack and no message text.
- `bin.ts` contains no logic that a test cannot reach: it calls one exported function `main(argv, io)` that tests call with a fake `fetch` and a temporary key generated in the test.

## 5. The harness

### 5.1 Trust boundary, stated plainly

The harness runs commands against a PR head. A PR head is untrusted code. These statements define what protects what.

**What isolates the code.** The same container the host uses for its own recheck (`packages/agents/src/contained-command.ts:100-107`): no network, read-only root, all capabilities dropped, no new privileges, an unprivileged user, fixed memory, CPU and pid limits, and a 16 MiB `noexec` `/tmp`. The candidate's files are copied into an image; no host directory is mounted. The image build executes nothing from the candidate (`contained-image.ts:49-50`, `:64`).

**What the code can reach from inside the container.**

| Thing | Reachable? | Why |
|---|---|---|
| The network, GitHub included | No | `NetworkMode: none` |
| The key K1 | No | It is not in the harness process, not in its user's files, and not mounted |
| An installation token | No | The harness never has one; only the publisher mints one, in another process |
| The attempt ledger, the allowlist | No | Not mounted |
| The profile's harness file and fixtures | Read only | Copied into the image as root-owned files (`contained-image.ts:64`) |
| Its own exit code and output | Yes | That is the measurement |

**What the code controls.** Its own exit code and its output bytes. Therefore a PR can make its own verification fail, time out or pass falsely only as far as the pinned profile's harness lets candidate code decide the exit code. That is a property of the profile, not of this runtime. Output is never copied into the request file: the summary is a fixed sentence with byte counts (§5.5), so PR text cannot reach the check run.

**What happens if isolation is missing.** The harness never runs a profile command outside a container. If the Docker daemon is unreachable, its id differs from the configured one, the base image is absent, or the profile asks for limits the executor does not enforce (`contained-mission-profile-execution.ts:42`, `:61`), the harness stops before any candidate code runs, writes no request file, and exits with a closed code. There is no fallback to a direct process, a `chroot`, or a container with relaxed flags, and no flag to turn the check off.

**What isolation does not cover: a container escape.** If code escapes the container, it acts as the harness's OS user. That user can talk to the Docker daemon, and access to a rootful Docker daemon equals root on that machine. On a machine that also holds K1, root can read K1. The container flags reduce the chance of an escape; they do not bound its effect. Three arrangements bound it, in order of strength:

1. The harness runs on a different machine or VM from the publisher. An escape reaches no key.
2. Same machine, the harness user uses rootless Docker and is a different OS user from the publisher. An escape reaches the harness user's files only.
3. Same machine, rootful Docker. An escape reaches the key. **Not acceptable for a repository that receives PRs from anyone other than this system.**

This is decision 6 in §9. It is the owner's, because it decides what can reach a signing key.

**What a compromised harness can do even without the key.** It can write a request file with a false `passed` record. The publisher would publish it for that PR and head, because the publisher trusts the record (B8 decision 3). It could not publish for another repository, another PR or a moved head (`publish.ts:147`, `:168-171`). The three later gates still hold: the host's own recheck in its own container, the Actions result, and a counted human approval (intake design §4.1).

### 5.2 Where it lives, and what it reuses

A new private package, `packages/verify-harness`. It does not import `@osstack/verify-publisher` and is not imported by it or by any host package; a guard test in the new package states this, in the manner of `guard.test.ts:29`, `:37`. It contains no key code and no token code, and a static test forbids the strings `access_tokens`, `authorization` and `private_key` in its source.

The harness must run the profile exactly as the host does; a second implementation of the container rules would drift. The loader, the execution wrapper and the commit exporter are in `packages/cli/src` today (§1). Two ways to share them:

- **R1 (recommended): move them.** One node moves `contained-mission-verification-profile.ts`, `contained-mission-profile-execution.ts`, and the three functions they need from `contained-verification.ts` (`authorizeContained`, `containedCommandFromArgv`, `exportContainedCommit` with `exportContainedCandidate`) into `@osstack/agents` behind a new subpath. The old `cli` files become re-exports, so the eight importers do not change. No behaviour changes; the existing tests move with the code.
- **R2: copy the schema.** The harness calls the two functions `@osstack/agents` already exports and re-implements the profile schema, the digests and the exporter, with a conformance test against the host's versions. Smaller change, permanent duplicate of security-relevant code.

Decision 7 in §9.

### 5.3 How it reads the PR

- Input: `--repository-id <n> --pr <n>`, nothing else about the target (B8 design §2.3 rule 1). The harness looks the repository id up in its own configuration file to get the repository name. A repository id that is not configured is refused before any network call.
- One request: `GET https://api.github.com/repos/{repo}/pulls/{n}`, **without authentication**, 15 seconds, 1 MiB, `redirect: 'error'`, through an injected transport. The harness therefore holds no credential at all.
- It continues only when the PR is open, its number matches, its base repository id and name equal the configuration, and its head repository id equals its base repository id (not a fork). These are the publisher's own rules (`publish.ts:167-169`), applied early so that no fork code is fetched.
- It takes `head.sha` and `base.sha` from this one answer. They become `head_sha` and `base_sha` of the request file. The publisher reads the PR again and refuses if either moved (`publish.ts:170-171`).

### 5.4 How it obtains exactly the head it read

No working tree is checked out. The harness needs the Git objects of one commit.

- **S1 (recommended): `git fetch` by SHA into a private bare repository, then the host's exporter.** The harness creates a bare repository in its own data directory, and runs `git fetch --depth=1 --no-tags https://github.com/{repo}.git <head sha>` with no credential helper, `GIT_TERMINAL_PROMPT=0`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CONFIG_NOSYSTEM=1`, hooks disabled and only the `https` protocol allowed. Git addresses objects by their hash, so the commit that arrives is the commit that was asked for. `exportContainedCommit` then resolves the SHA, refuses a replacement ref, lists the tree, and checks every blob hash (`contained-verification.ts:52-80`). No hook can run: nothing is checked out and the repository is new.
- **S2: the tarball endpoint plus a tree-hash check.** One HTTPS download of the commit's archive, unpacked in memory, with the Git tree hash recomputed and compared to the commit's tree read from the API. No `git` binary and no Git write. It needs a tar reader and a tree hasher written for this purpose, and it trusts the API for the commit-to-tree link.

S1 adds two counted entries (`init`, `fetch`) to `scripts/deterministic-git-allowlist.json` for one file of the harness. The repository rule says that list may only shrink (`AGENTS.md`). An exception is the owner's to grant. Decision 5 in §9.

Under either option the candidate must satisfy the exporter's limits: regular files only, at most 10,000 files and 32 MiB (`contained-verification.ts:73-78`). A head that does not is reported as `candidate_unsupported`; no request file is written. Whether the sandbox repository and `osborn-studio/osstack` satisfy these limits was not measured.

### 5.5 How it runs the profile and records the result

Configuration. A harness configuration file, strict JSON, at most 262,144 bytes, read on every run:

```json
{
  "version": 1,
  "docker": { "socket_path": "<absolute>", "daemon_id": "<id>" },
  "profiles_root": "<absolute>",
  "entries": [
    {
      "repository": "fixture-owner/fixture-repo", "repository_id": 101, "skill_id": "fixture-skill",
      "profile_id": "fixture-profile", "profile_digest": "<64 hex>",
      "trusted_source": { "repository": "fixture-owner/fixture-harness", "commit_sha": "<40 hex>", "artifact_digest": "<64 hex>" },
      "base_image_id": "sha256:<64 hex>", "allowed_argv": ["<arg>", "<arg>"],
      "failure_code": "fixture-failure"
    }
  ]
}
```

The profile binding of an entry must equal the binding in the publisher's allowlist and in the host's producer policy; the publisher refuses a difference as `binding_changed` or the host rejects it (runbook §4). `failure_code` is here because neither the profile (`contained-mission-verification-profile.ts:20`) nor the allowlist (`config.ts:8-13`) holds one, and the host requires a failed result to carry a code its policy allows (`packages/core/src/bridge/verification-producer-policy.ts:50`).

Run, in order:

1. Load `<profiles_root>/<artifact_digest>.json` with the host's loader. It must have exactly one check, as on the host (`contained-mission-local-failure-recheck-run.ts:118`).
2. `prepareContainedProfileImage` with the exported candidate (`contained-mission-profile-execution.ts:33`). Its limit rule (128 MiB, 1 CPU, 64 pids, at most 120 seconds, `:42`) and its output rule (`:61`) apply unchanged. A runtime blocker stops the run (§5.1).
3. A new `invocation_id` (UUID), then `runPreparedContainedProfile` (`:79`). The harness accepts the result only with the identity and `docker_removed` stop-receipt checks the host applies (`contained-mission-local-failure-recheck-run.ts:217-234`). A result without a proven stop writes no request file and exits with `stop_unknown`; the operator must inspect the daemon.
4. Map the result to a record:

| Container result | `outcome` | Check `exit` | Check and record `failure_code` |
|---|---|---|---|
| Exited 0 | `passed` | 0 | null |
| Exited with a code in the check's `failure_exit_codes` | `failed` | that code | the configured `failure_code` |
| Exited with any other code | `blocked` | that code | null |
| Timeout, OOM kill, or not started | `blocked` | null | null |

Only the first two rows are assertions about the code. The third and fourth are "could not decide", as the intake design requires: "缺凭证、超时、环境失败均 blocked" (intake design §3.1). The builder enforces the first two rows again (`verification-result-builder.ts:84-87`).

5. Fill the remaining record fields (`verification-result-builder.ts:7-18`):

| Field | Value |
|---|---|
| `started_at`, `finished_at` | The harness's clock, UTC, second precision |
| `checks[0].check_id` | The profile's one check id |
| `checks[0].result_digest` | The host's formula (`contained-mission-local-failure-recheck-run.ts:239-248`) |
| `evidence_refs` | Empty in the first release (§5.6) |
| `evidence_digest` | SHA-256 over the result digest and the stop-receipt reference, the host's formula (`:264`) |
| `runtime_provenance.runtime_id` | The fixed id `contained-docker` |
| `runtime_provenance.runtime_digest` | The hex part of the built image id |
| `runtime_provenance.source_manifest_digest` | The candidate content digest from the image receipt (`contained-image.ts:46`) |
| `summary` | The fixed sentence `stdout: N bytes; stderr: M bytes`, as on the host (`contained-mission-local-failure-recheck-run.ts:263`). No output text. |

6. Write the request file (`config.ts:22-26`) to `<drop>/<invocation_id>.json`: first to a temporary name in the same directory with mode 0600, then `fsync`, then rename. Print one JSON line with the invocation id and the file name, and exit 0.

Harness exit codes: 0 a request file was written; 1 refused or could not measure (closed code on standard output, no request file); 2 bad arguments or configuration. A `blocked` record is exit 0: it is a measurement, and the publisher publishes it.

One automatic run per PR, head and skill is the publisher's rule (`publish.ts:176-177`), not the harness's. The harness keeps no state between runs except the bare repository cache and the evidence directory.

### 5.6 Evidence

The intake decision is 30 days' retention in a cloud store, copied before close-out (intake design §9.1). No host code reads evidence today (§1). First release: the harness writes the captured stdout and stderr and the stop receipt to `<evidence>/<invocation_id>/` with mode 0600, publishes `evidence_refs: []`, and binds them through `evidence_digest`. Deleting directories older than 30 days is a runbook step, not harness code. A readable evidence store and the copy before close-out stay unbuilt; §11.

### 5.7 Handing the request file to the publisher

The harness and the publisher are different OS users (§5.1). The drop directory is writable by the harness user and readable by the publisher user. How the publisher is started for a new file is a cloud deployment matter: the routine's wrapper, an operator, or a path-triggered service unit. No code in either package starts the other. The runbook gets the exact arrangement once decision 6 is made.

## 6. What stays out

- No change to the result contract, the builder, the publisher's order of steps, the host reader, the source ledger, the classifier, or any host state. No migration, no RPC method, no decision kind.
- No host-side publishing. The host still never requests a token for the verification App; the guard at `packages/cli/src/contained-mission-verification-identity.guard.test.ts:35-41` stays as it is.
- No withdrawal command and no command that clears `readback_mismatch` (runbook §7.5). They are real gaps, listed in §11, and are not part of B9.
- No stale-lock detection for the attempt ledger.
- No trigger. How the Watcher routine calls the harness with two numbers is cloud setup (B8 design §3.6 items 6 and 7).
- No webhook, no listener, no network server in either package.
- No installation on `osborn-studio/osstack` and no production switch.
- No real GitHub request, no real key and no Docker run in any node of §8. Those are the drill (§10).

## 7. Failure states added by B9

All are cloud-side. None creates a host state; on the host every one of them looks like "waiting for the Watcher's result" (B8 design §5).

| Where | Code | Meaning | Operator action |
|---|---|---|---|
| Publisher entry | `key_unavailable` (exit 2) | Key file missing, not a regular file, wrong owner or mode, too large, or not a usable RSA key | Fix the file. Nothing was sent. |
| Publisher | `read_failed` (existing) | Also covers: installation check failed, App widened or suspended, token refused, token scope not as requested | Read the App's settings; the publisher wrote nothing |
| Harness | `not_configured` | Repository id or skill not in the harness configuration | None |
| Harness | `pr_read_failed`, `pr_not_open`, `scope_mismatch`, `fork` | The PR read failed or the PR is out of scope | Rerun later, or none |
| Harness | `source_unavailable`, `candidate_unsupported` | The head could not be fetched or exported, or exceeds the exporter's limits | Report; no result for this head |
| Harness | `profile_unavailable` | Artifact missing, digest mismatch, `argv` not allowed, more than one check, limits unsupported | Fix the installed profile or the configuration |
| Harness | `isolation_unavailable` | Docker unreachable, daemon id mismatch, base image absent | Fix Docker. No candidate code ran. |
| Harness | `stop_unknown` | The container's stop is not proven | Inspect the daemon by hand before any rerun |

## 8. Node split

Each node is one PR against `main`. Each is built and tested without real GitHub, a real key or Docker: `fetch`, the Git runner, the image preparer and the profile runner are injected, and tests use fakes. No node needs a migration.

| Node | Content | Main files | Acceptance tests |
|---|---|---|---|
| B9-0 | This document and the owner's decisions | `docs/design/2026-11-24-verification-publisher-runtime.md` | Link check, governance tests |
| B9-1 | Publisher GitHub transport and key loader, as a library | `packages/verify-publisher/src/github-transport.ts`, `src/app-key.ts`, their tests, `src/guard.test.ts` | With a fake `fetch` and a key generated in the test: the JWT verifies with the public key and has the stated claims; the installation check refuses another installation id, a suspended App, selection `all`, and a third permission; the token request body is exactly the one repository id and two permissions; a token answer with another repository or permission is refused; one token per run; each path outside the three GET shapes and each repository outside the allowlist is refused without a request; each time and byte limit is enforced; a redirect is refused; the create call is sent once and never retried; the key is refused for wrong mode, wrong owner, a symlink, a directory and an oversize file; neither key nor token nor JWT appears in any reply, thrown error or output. The narrowed guard of §3.1 passes. |
| B9-2 | Publisher entry point | `packages/verify-publisher/src/bin.ts`, `package.json` (`bin`), test; runbook §1, §3, §6, §7 (`<publisher>` replaced, key path rule added) | `main` with a fake `fetch`: a full `publish` against the in-memory GitHub writes one check run and the ledger entries; `abandon` works; `--key` is required and removed before `runCli`; a bad key gives exit 2 and `key_unavailable`; an internal error prints the closed line and no stack; the built file starts under `node` and prints `usage` for no arguments. Needs B9-1. |
| B9-3 | Shared profile-run library (only under R1) | new subpath in `@osstack/agents`; the moved `cli` files become re-exports | No behaviour change: the moved tests pass unchanged; the full `@osstack/cli`, `@osstack/agents` and `@osstack/core` suites pass; the CLI startup budget and the static import rule pass; inventory regenerated. |
| B9-4 | Harness core: configuration, PR read, result mapping, request writer | new package `packages/verify-harness` (`src/config.ts`, `src/pull-request.ts`, `src/record.ts`, `src/request-file.ts`, `src/run.ts`, guard test) | With injected ports: the PR read refuses closed, fork and out-of-scope PRs; the four rows of the mapping table; the request file passes `parsePublishRequest` and, with a matching allowlist, the merged `publishVerification` against the in-memory GitHub publishes it (`passed`, `failed`, `blocked`); output text never appears in the request file; each harness code of §7; a result without a proven stop writes no file; the file is written by rename with mode 0600. Guard: no import of the publisher in either direction; none of the forbidden strings. Needs B9-3 under R1. |
| B9-5 | Harness real ports and entry point | `packages/verify-harness/src/source.ts` (S1 or S2), `src/docker-ports.ts`, `src/bin.ts`; `scripts/deterministic-git-allowlist.json` under S1 | Source port against a local bare fixture repository over a file path (no network): fetch by SHA yields the exporter's files and tree; a SHA that is absent fails closed; the Git environment is the stated one. Docker port: constructed and type-checked; its only test without Docker is that an unreachable socket gives `isolation_unavailable`. Entry point: argument and exit-code tests. Needs B9-4. |
| B9-6 | Runbook completion and drill plan | `docs/runbooks/bridge-verification-publisher.md`; a drill checklist | Harness setup, the two OS users, the drop directory, evidence retention; the drill steps of §10 with the evidence to record. Link check. |

Order: B9-1 → B9-2. B9-3 → B9-4 → B9-5. The two chains are independent. B9-6 last.

## 9. Decisions for the owner

| # | Decision | Recommendation | Blocks |
|---|---|---|---|
| 1 | Where the publisher gets the key path | A required `--key <absolute path>` flag. The file must be regular, owned by the publisher's user, mode 0600 or stricter, at most 16 KiB. Not the environment, not a configuration field. | B9-1 |
| 2 | Scope and life of the write token | One token per run, requested for the one repository id and the two permissions, checked on receipt, held in memory only, never cached. An installation check with the host's exact rule comes first. | B9-1 |
| 3 | What to do if the scoped token cannot read a public PR | Keep the App at exactly two permissions. If the drill shows a refusal, send the three GET calls without authentication. Do **not** add Pull requests read-only: the merged host proof would reject every result. This replaces the fallback of B8 decision 8. | B9-1 design only; confirmed in the drill |
| 4 | Whether the harness holds any credential | None. It reads the PR and fetches the code without authentication. This works only for public repositories; a private repository needs a new design. | B9-4 |
| 5 | How the harness obtains the head commit | S1: `git fetch` by SHA into a private bare repository and the host's exporter. This needs your exception to the "may only shrink" rule: two counted entries (`init`, `fetch`) for one harness file. If you refuse the exception: S2, the tarball with a tree-hash check. | B9-5 |
| 6 | Where the harness runs relative to the key | First release, sandbox only: same cloud computer, two OS users, rootless Docker for the harness user (arrangement 2 of §5.1). Before any repository that receives PRs from outside this system: a separate machine (arrangement 1). Never rootful Docker on the machine that holds the key. | Cloud setup; B9-6 |
| 7 | How the harness shares the host's profile code | R1: move the loader, the execution wrapper and the exporter into `@osstack/agents`, with re-exports in `cli`. | B9-3, B9-4 |
| 8 | What is published when the harness cannot measure | Container results that are not a decision (timeout, OOM, unexpected exit code) are published as `blocked`. Harness faults before or around the container (PR unreadable, source unavailable, Docker missing, stop not proven) publish nothing and report in the cloud. | B9-4 |
| 9 | Where the failure code of a failed result comes from | One `failure_code` per entry in the harness configuration. You keep it equal to the one code in the host's producer policy. | B9-4 |
| 10 | Evidence in the first release | Local directory per invocation, 30 days, `evidence_refs` empty, bound by `evidence_digest`. The readable store and the copy before close-out stay open. | B9-4 |

Chosen by the session, not put to the owner: the file names, the `bin` name `osstack-verify-publisher`, the byte and time limits of §3.4, the closed code names of §7, and the split into six nodes.

Not asked here because they are already decided: K1, P2, the publisher's location in this repository, sandbox only (B8 design §8 decisions 2, 3, 4, 9).

## 10. What only a real sandbox drill can prove

None of this is part of the nodes in §8. Each item needs the owner's separate approval (B8 design §3.6 item 8) and goes only to `osborn-studio/osstack-bridge-sandbox`.

1. That GitHub accepts the JWT signed with K1 and returns the expected installation for the sandbox.
2. That the token request with `repository_ids` and the two permissions is accepted, and what the answer lists.
3. Whether that token can read a public PR and the check runs of a commit (decision 3).
4. That a check run created with the token shows the verification App's id, and that its `output.text` comes back byte for byte (open since B8 design §9). The read-back compares the text exactly (`publish.ts:99`); a difference would end every publish in `readback_mismatch`.
5. The real shapes of the four responses against the publisher's schemas (`publish.ts:37-46`), which so far match only the test fake.
6. That the host reader accepts the published result end to end: producer proof, policy match, source ledger, and the recheck ledger's input (a).
7. That the container contract holds on the cloud machine's Docker: no network from inside, no host path visible, limits enforced, stop receipt produced. With rootless Docker this includes whether the executor's flags are all supported.
8. That `git fetch` by SHA works against GitHub for a PR head without authentication, and its duration.
9. That the publisher's user can read the drop directory and the harness's user cannot read the key, the ledger or the allowlist: a read attempt as the harness user and as the bots' user, with the refusal recorded.
10. That the run from a pinned commit is reproducible: the commit, `pnpm install --frozen-lockfile`, `pnpm build`, and the digest of the two built entry files.
11. An impostor check with the same name from another App, rejected by the host (B8 design §7).
12. The measured delay from a push to a published result with the Watcher's trigger.

## 11. What could not be verified, and known gaps

- Nothing was built or run for this document. Statements about code come from reading source at `176ea389`.
- GitHub platform behaviour comes from GitHub's documentation, read on 2026-11-24 through a fetch tool, and was not probed: the token endpoint and its narrowing fields, the one-hour token life, the 10-minute JWT limit, `RS256`, the check-run endpoints and their 65,535-character output limits, and the rate limits. The sentence that the repository-installation read needs a JWT came from a summary of the page, not its verbatim text. The documentation did not state whether a token without Pull requests permission can read a public PR.
- I did not read any key, any host-private configuration, the App's settings or the cloud computer. The App's permission set and installation come from the B8 design and the plan.
- Whether rootless Docker is available on the shared cloud computer, and whether that computer can keep two OS users apart from the bots' user (also open in B8 design §9).
- Whether the sandbox repository's PR heads meet the exporter's limits (regular files only, 10,000 files, 32 MiB). `osborn-studio/osstack` itself was not measured either.
- Which profile will be installed for the first skill, and whether its base image exists in the cloud. The profile, its digest and the image are owner inputs.
- The cost of R1 was estimated from the importer list, not from a trial move. Tests that read the moved files as text may need path changes.
- The attempt-number gap after a host-side rejection remains (B8 design §9, runbook §8).
- Gaps in the merged publisher that B9 leaves open: no withdrawal command, no way to clear `readback_mismatch`, no stale-lock detection (runbook §5, §7.5).
- Evidence: no store that the host can read, and no copy before close-out (§5.6).
