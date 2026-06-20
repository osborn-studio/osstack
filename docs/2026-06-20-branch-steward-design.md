# Branch Steward Design

> Date: 2026-06-20
> Status: Draft for user review
> Owner: Osborn + Codex
> Target repo: osstack

## One-line Definition

Branch Steward is an osstack Loop Engineering capability that discovers promising remote feature branches, opens safe pull requests, verifies them, and lets GitHub-native protections decide whether they can merge into the default branch.

It is not a direct "merge remote branches into main" bot. The product promise is engineering asset recovery with guardrails.

## Context

The user wants an agentic capability integrated into osstack that can inspect a GitHub repo, find useful `feat/*` remote branches that are not merged into `main`, create PRs for the best candidates, and eventually merge them automatically when safe. The first user is the repo owner, but the design should be reusable for future PartnerOS customers.

osstack already has the right substrate:

- `packages/loop` implements Discover -> Plan -> Execute -> Verify -> Iterate.
- `packages/agents` already owns worktree isolation.
- `packages/cli` already exposes `loop run`, `loop start`, task queues, state files, and daemon-managed loop sessions.

Branch Steward should extend this loop instead of creating a separate automation system.

## Current Repository Observations

As of 2026-06-20, `gilosbornhello/osstack` is private. The current user has admin permission. The default branch is `main`.

The current remote branch scan found no unmerged `feat/*` branches. The only unmerged remote branch is `origin/changeset-release/main`, with an open PR whose merge state is `UNSTABLE`.

This matters because the first release must handle the "no eligible candidate" path as a first-class success state.

## Best-practice Inputs

Branch Steward follows these external patterns:

- GitHub auto-merge should merge only after required reviews and checks pass.
  Source: https://docs.github.com/en/pull-requests/collaborating-with-pull-requests/incorporating-changes-from-a-pull-request/automatically-merging-a-pull-request
- GitHub pull request APIs should be used for create, inspect, update, and merge actions, with merge failures treated as normal state transitions.
  Source: https://docs.github.com/en/rest/pulls/pulls
- GitHub compare APIs should be used to evaluate ahead/behind state and commit deltas before acting on a branch.
  Source: https://docs.github.com/en/rest/commits/commits#compare-two-commits
- Branch protection and required status checks are the central safety boundary.
  Source: https://docs.github.com/en/rest/branches/branch-protection
- Renovate's automerge model is a strong precedent: automation can be aggressive only when repository checks and merge rules are trusted.
  Source: https://docs.renovatebot.com/key-concepts/automerge/

## Product Modes

### Mode 1: Report

Scan branches, rank candidates, and write a report. No GitHub writes.

This is the default for new repositories and PartnerOS customers.

### Mode 2: PR Autopilot

Scan branches, create PRs for qualified candidates, add labels/comments, and optionally enable GitHub auto-merge when supported.

This is the recommended first build.

### Mode 3: Merge Autopilot

Create PRs and merge them after all checks pass, using GitHub-native auto-merge or merge queue. Direct merge API calls are allowed only when explicitly configured and branch protection is present.

This is not the default.

## Safety Defaults

Branch Steward defaults to conservative behavior:

- `dry_run: true`
- `branch_prefix_allowlist: ["feat/", "feature/", "codex/"]`
- `repo_allowlist` required before write actions
- no auto-merge when branch protection cannot be confirmed
- no merge when CI status is failing, pending too long, or unknown
- no merge when the branch has conflicts with the default branch
- no merge for sensitive file changes unless explicitly allowed
- no merge for large diffs above the configured limit
- no direct push to the default branch
- no force push
- no deletion of remote branches unless explicitly enabled

Sensitive file globs:

- `.github/workflows/**`
- `package.json`
- `pnpm-lock.yaml`
- auth, payment, deployment, secret, and infra paths configured per repo

## Scoring Model

Each remote branch gets a candidate score from 0 to 100.

Positive signals:

- branch prefix is allowlisted
- branch is ahead of `main` and not behind by much
- compare API reports no conflicts
- existing PR has passing checks
- recent activity is within the configured freshness window
- diff size is small or medium
- files touched match known product areas
- author is trusted or has successful history in osstack memory
- branch title or commits indicate feature completion

Negative signals:

- branch is stale
- branch is far behind `main`
- diff is too large
- sensitive files changed
- CI is failing
- existing PR is draft
- existing PR has requested changes
- branch has merge conflicts
- branch source repo is a fork without trust metadata

Initial thresholds:

- `score >= 80`: eligible for PR Autopilot
- `score >= 90`: eligible for auto-merge enablement when checks are green
- `score < 80`: report only

## Pipeline

### 1. Repo Sync

Inputs:

- GitHub repo owner/name
- default branch
- local workspace path
- osstack config profile

Actions:

- run `git fetch --prune`
- read default branch metadata
- list remote branches
- list open and recently closed PRs
- inspect branch protection if available
- record permission level

Output:

- `RepoSnapshot`

### 2. Branch Discovery

Actions:

- select remote branches by prefix
- remove branches already merged into default branch
- remove branches with existing open PRs unless `refresh_existing_prs` is enabled
- compare each candidate against default branch

Output:

- `BranchCandidate[]`

### 3. Candidate Scoring

Actions:

- calculate score
- attach skip reasons
- mark candidate action: `report`, `create_pr`, `enable_auto_merge`, or `escalate`

Output:

- `BranchStewardPlan`

### 4. PR Planning

Actions:

- generate PR title and body
- include branch score, evidence, risks, and verification plan
- add labels such as `osstack/steward`, `auto-pr`, `needs-human-review`

Output:

- `PullRequestIntent`

### 5. Verification

Actions:

- run repo verification commands locally when configured
- inspect GitHub check suites and statuses
- optionally run osstack reviewers such as `ds-review` or `codex-cli`

Output:

- `VerificationVerdict`

### 6. Merge Control

Actions:

- enable GitHub auto-merge when supported and safe
- otherwise leave PR open with status comments
- never bypass branch protection by default

Output:

- `MergeDecision`

### 7. State and Audit

Actions:

- write `LOOP-STATE.json`
- write `STATE.md`
- emit loop events
- save decisions into osstack memory/stats

Output:

- auditable run history

## osstack Integration

### New Capability

`github.branch_steward`

### New Discover Source

`github_branch`

This source scans GitHub remote branches and emits tasks such as:

```json
{
  "capability": "github.branch_steward",
  "prompt": "Evaluate origin/feat/example for safe PR creation into main.",
  "source": "github_branch",
  "priority": 85,
  "context": {
    "repo": "gilosbornhello/osstack",
    "base": "main",
    "head": "feat/example"
  }
}
```

### CLI Shape

```bash
osstack steward scan --repo gilosbornhello/osstack --dry-run
osstack steward plan --repo gilosbornhello/osstack --json
osstack steward run --repo gilosbornhello/osstack --mode pr-autopilot
osstack loop run --source github_branch --verify "pnpm test"
```

### Suggested Files

- `packages/github/src/client.ts`
- `packages/github/src/branch-scanner.ts`
- `packages/github/src/branch-scorer.ts`
- `packages/github/src/pr-planner.ts`
- `packages/github/src/merge-controller.ts`
- `packages/loop/src/discover.ts`
- `packages/loop/src/types.ts`
- `packages/cli/src/bin.ts`

## Data Types

```ts
type BranchCandidate = {
  repo: string;
  base: string;
  head: string;
  aheadBy: number;
  behindBy: number;
  changedFiles: number;
  additions: number;
  deletions: number;
  hasOpenPr: boolean;
  isDraft?: boolean;
  checksState: "success" | "failure" | "pending" | "unknown";
  sensitivePaths: string[];
  score: number;
  reasons: string[];
  action: "report" | "create_pr" | "enable_auto_merge" | "escalate";
};
```

## Test Plan

Unit tests:

- branch prefix filtering
- stale branch filtering
- score calculation
- sensitive path detection
- PR body generation
- merge decision matrix

Integration tests:

- local git repo with multiple branches
- mocked GitHub compare and PR APIs
- dry-run scan with no candidates
- dry-run scan with one eligible candidate
- existing PR with failing checks
- existing PR with passing checks

Smoke tests:

- `pnpm build`
- `pnpm test`
- `pnpm smoke:loop`
- dry-run against `gilosbornhello/osstack`

## Rollout Plan

### Phase 1: Report Mode

Implement scanning, scoring, reports, and tests. No GitHub writes.

### Phase 2: PR Autopilot

Add PR creation behind `--mode pr-autopilot` and repo allowlist.

### Phase 3: Auto-merge Enablement

Enable GitHub auto-merge or merge queue only when branch protection and checks are confirmed.

### Phase 4: PartnerOS Packaging

Expose policies as customer-level config, with audit logs and per-repo safety defaults.

## Open Decisions

1. GitHub access should start with `gh` CLI for local speed or Octokit for cleaner long-term library code.
   Recommendation: Octokit inside package code, `gh` only for local diagnostics.

2. The first CLI should be `osstack steward ...` or stay under `osstack loop ...`.
   Recommendation: add `osstack steward ...` as product-facing sugar, backed by loop internals.

3. Auto-merge should be enabled in the first release.
   Recommendation: no. First release should stop at report mode plus dry-run PR intents.

## Success Criteria

- A dry-run against `gilosbornhello/osstack` correctly reports no eligible `feat/*` branches today.
- A mocked repo with one good `feat/*` branch produces a PR intent with clear evidence.
- A branch with failing checks is never marked merge-eligible.
- A branch touching sensitive paths is escalated.
- The loop writes machine-readable and human-readable state.
- All behavior is covered by unit and integration tests.

## Non-goals

- Directly pushing to `main`.
- Bypassing branch protection.
- Cleaning or deleting remote branches in the first release.
- Supporting every Git provider in the first release.
- Multi-tenant PartnerOS UI in the first release.

## Spec Self-review

- No placeholders remain.
- The first release scope is report mode and dry-run PR intents, not full auto-merge.
- The design aligns with osstack's existing loop model.
- The "no eligible candidate" case is explicitly handled.
- Dangerous actions require allowlists and branch protection.
