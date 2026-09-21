# Approved improvement candidate execution

This increment connects a stored improvement proposal to an actual candidate patch. It builds on [PR #217](https://github.com/osborn-studio/osstack/pull/217), whose current-main integration at `59eafa0` passed 285 test files / 2,418 tests and GitHub CI.

## Operator workflow

Use an explicitly isolated `OSSTACK_HOME` when running a development checkout. Never point it at the serving control-plane home. The repository must have exactly one enabled registry entry with an absolute root path and verification commands.

```sh
export OSSTACK_HOME=/absolute/path/to/workspace-osstack-home

osstack improve inspect --proposal <proposal-id>
osstack improve approve --proposal <proposal-id> --digest <inspected-sha256> --yes

# Preview the frozen request, including base SHA, exact files, gates and profile.
osstack improve execute --proposal <proposal-id> --digest <inspected-sha256> \
  --execution <stable-attempt-id> --registry /absolute/path/to/repos.json \
  --role coder=codex-cli --role evaluator=kimi-code

# Run the same request after reviewing it.
osstack improve execute --proposal <proposal-id> --digest <inspected-sha256> \
  --execution <stable-attempt-id> --registry /absolute/path/to/repos.json \
  --role coder=codex-cli --role evaluator=kimi-code \
  --request-digest <preview-request-sha256> --yes

osstack improve status --execution <stable-attempt-id>
```

`approve` without `--yes` previews the approval. A changed digest fails closed. Approval freezes the proposal definition. `execute` without `--yes` prepares the request without invoking a model or creating a candidate worktree. It may create the evidence parent directory. Execution also requires the preview's `request_digest`, so changes to the base, gates, profile or other request fields invalidate that confirmation. `apply` keeps its existing gate-only behavior; it does not implement a proposal.

The initial production adapter combination is Codex CLI Builder and Kimi structured, no-tools Evaluator. Unsupported or unavailable role selections fail before claiming an attempt. This command does not switch GitHub accounts or approve a GitHub PR.

## Execution and evidence

Migration 25 stores the immutable request hash, proposal digest, state, worktree descriptor and result. A transaction checks the current approved definition and reserves one active attempt per proposal. Reusing the same execution ID and request returns the stored result; changing its request is a conflict. Interrupted `claimed` or `running` attempts remain inspectable and are never automatically retried. There is no heuristic lock expiry that might start a second worker while the first is still running.

The request binds the proposal and its source assets, repository root, exact Git base SHA, exact allowed files, proposal and registry verification commands, role resolution and per-stage timeout. The prepared request is cloned and deeply frozen before adapters receive instructions.

Execution creates an external `codex/improve/...` worktree at the bound base. The operator's original checkout is not used as the build directory. A successful candidate requires:

1. A successful Builder receipt, with strict Codex native completion and process exit handling.
2. A nonempty patch whose complete changed-path set is within the approved exact file list. Protected configuration/policy paths, symlink candidates and submodules are rejected.
3. Passing frozen command checks and a passing required structured semantic review of the captured patch from an independent adapter. The review boundary scans that exact patch, including changes Git's ordinary diff could hide.
4. The same candidate before and after verification, including the index and raw file bytes.

Artifact capture includes staged, unstaged, added, removed, renamed and ignored source changes. It reads raw blobs and constructs a binary-capable Git patch in a private temporary object store, without changing the candidate index or invoking repository clean filters. Conventional ignored caches are excluded. Size limits and unsupported repository shapes fail closed rather than producing incomplete evidence.

Each retained evidence directory contains the frozen request, Builder result, candidate patch and file hashes, verification result and a hash manifest when successful. Failed attempts retain their worktree and whatever evidence was produced. The SQLite result stores the manifest hash as well. `candidate_verified` reports `applied: false` and `effectiveness_proven: false`; the proposal remains approved. This stage does not commit, merge, push, deploy or promote an evaluator.

## Trust and practical limits

This is an explicit local operator command for a trusted repository. It is not connected to the signed session continuation service: a `phase_continue` grant cannot invoke it or authorize a code/GitHub action. The Codex Builder uses workspace-write configuration and a per-attempt `OSSTACK_HOME`; the Kimi reviewer uses its existing no-tools profile. Verification commands receive a per-attempt `OSSTACK_HOME` and `OSSTACK_AUTOAPPROVE=0`, without changing the host process environment.

Ordinary shell gates still run with the local operator's operating-system privileges. A Git worktree and after-the-fact diff checks are not a hostile-code sandbox or a separate tenant boundary. Hash manifests support later integrity checks; a process with the same user's filesystem permissions is not excluded by a cryptographic trust boundary. The configured CLI sandboxes must be available and enforced by their runtimes. This local mode must not be advertised as unattended execution of untrusted proposals.

The timeout is per Builder, command and review invocation, not a total spend or wall-clock budget. Supported adapters must stop their processes on cancellation. An interrupted attempt is retained as uncertain rather than declared failed and automatically restarted. Failed worktrees are intentionally retained for inspection; automated retry, cleanup, dependency provisioning and a human-verified abandonment/recovery command remain separate work.

Changing an evaluation file and passing that evaluation is not evidence that OSStack improved. A later promotion stage needs frozen baseline/holdout tasks, comparable before/after measurements and exact-candidate delivery through the existing governed delivery chain. This increment supplies the missing candidate and evidence records for that stage.

## Validation

The implementation is covered by real temporary Git repositories and command execution with fixture adapters. Tests cover approval digest conflicts, concurrent claims, replay after interruption, terminal immutability, real patch reconstruction, exact path boundaries, verifier mutation, missing structured judgments and absent Builder receipts. Adapter tests exercise process-level completion and environment configuration. No live model call or serving database migration is part of these tests.

Full workspace validation passed: **290 test files / 2,532 tests**, build, TypeScript checks, schemas and generated inventory. Biome passed with the same two pre-existing warnings. The CLI integration enters through `main`, previews and confirms the request digest, runs both real shell gates, checks persisted status and proves that replay invokes neither agents nor gates again. Repository, profile and gate changes invalidate preview confirmation before any execution is claimed.

For later delivery, replay the reviewed patch on its bound base and revalidate it. Do not directly commit the retained worktree's current index: its staged content can differ from the reviewed final working-tree content, and the index fingerprint is evidence for detecting changes rather than permission to publish that index.
