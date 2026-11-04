# ADR-006: bridge stage S0 decisions — merge rights, identities, rulesets

- Status: Accepted (2026-11-04; answers given by the repository owner in conversation)
- Date: 2026-11-04
- Decision owner: repository owner
- Scope: the decisions in §12 of the [bridge design](../design/2026-11-01-osstack-grok-bridge.md) (stage S0), and a correction to [ADR-005](ADR-005-bridge-identity-registry.md)
- Supersedes: the “Operated by” column of ADR-005 §1 and §2, and ADR-005 §1 rules 2–3 as they apply to the accounts below. ADR-005's role tables and numeric ids stay in force until the GitHub Apps of decision 3 replace them.

## Context

The bridge design leaves five decisions to the owner (§12). Stage 2 of the [implementation plan](../plans/2026-11-02-osstack-grok-bridge-implementation.md) (tasks 2.1–2.5) starts only after they are recorded here. While answering them, the owner corrected a fact ADR-005 had recorded wrongly. That correction changes what decision 1 means in practice, so it comes first.

## Decision

### 1. Who operates the accounts (correction to ADR-005)

ADR-005 recorded all seven collaborators as operated by a person. That is wrong for six of them.

| Login | Numeric id | Repository role | Operated by |
|---|---|---|---|
| `gilosbornhello` | 269190136 | admin | person (the owner); the only human account |
| `gilberthello` | 160148718 | admin | automation (Grok Bots); a person spot-checks |
| `Rubebun-Jadeem` | 243772068 | admin | automation (Grok Bots); a person spot-checks |
| `hyfwin` | 2900559 | admin | automation; a person spot-checks |
| `wsorange` | 127640032 | admin | automation; a person spot-checks |
| `maomaobdm` | 317464155 | maintain | automation; a person spot-checks |
| `linxinlan1980` | 292102352 | read | automation; a person spot-checks |

“Spot-checks” is the owner's description: the bot decides on its own and approves and merges when its rules are met, and a person looks afterwards or occasionally. Many merges have no person looking first. For example, `Rubebun-Jadeem` approved and merged #367 and #368 on 2026-11-04.

Consequences for ADR-005:

- ADR-005 rule 2 (“a bot account may not hold the Human merger role”) is violated today: both registered Human mergers are automation. The rule is not relaxed. Instead, merging by automation is now governed by decision 2 below, and the Human merger role is understood as “the account that merges”, not as proof that a person decided.
- ADR-005 rule 3 (Reviewer and Human merger on one account only if a person operates it) is violated by `gilberthello` and `Rubebun-Jadeem`. As a result, the required approval on `main` is in practice given by the same automation that merges. This risk is recorded below (risk 1). S1 makes GitHub enforce checks and approvals, but it does not by itself bring in human review.
- Bridge conventions (Relay summaries, the merger checklist in plan Part 1) must not say “a person approved” or “a person merged” on the strength of these accounts.

### 2. Merge rights (design §12.1)

Decision: **automation may merge, but only Mission PRs, only under strict gates, and only after a shadow period.** This replaces the design's recommendation of “human merge only”, and moves “bot merge” out of the deferred list for Mission PRs only.

- **Scope:** only PRs opened by the osstack publisher identity (App A once stage 3 lands; `gilosbornhello` until then) whose body carries exactly one valid machine marker (design A.4). This ADR does not govern ordinary PRs. How the Grok Bots accounts merge them today stays as it is, and is listed as a risk.
- **Separate identity:** merging is done by a fifth GitHub App, App E `osstack-merger`, never by App A `osstack-publisher`. App A's token must still be refused a merge (plan probe P-1).
- **Gates.** App E may merge only when every one of these holds. Each gate is read from the live PR at evaluation time.
  1. **Publication evidence:** `mission status` returns `publication.kind === 'opened'` for this PR number. `null`, `evidence_missing` and `opened_before_cancel` are refused. This is historical evidence of what osstack published, not the live PR state.
  2. **Binding:** the live PR's repository, number, head repository and branch, base ref and head SHA must equal the publication evidence (`delivery_evidence`: `repository`, `pr`, `branch`, `base`, `head`). The live head SHA must equal, all at once:
     - `publication.pushed_commit`,
     - the ledger's `candidate_head`,
     - the marker's `head`,
     - the `head_sha` of the `osstack/verify` check.

     The marker's `id`, `spec_digest` and `start` must equal the ledger's `mission_id`, `spec_digest` and `start_commit`. The marker on its own proves nothing, because a valid marker can be copied into another PR.
  3. **Mission-specific evidence check:** `osstack/verify` comes from App B (matched by `app.id`), its `external_id` equals `<mission_id>:<head>`, its conclusion is `success`, and duplicates are resolved by the plan's phase 3 rule (lowest `id` wins).
  4. **Required checks:** every required check on `main` succeeds on the live head, from its registered producer (ADR-005 check producers; App C for `grok/verify-osstack` once S6 lands).
  5. **Base:** the live base SHA equals the evidenced `base_head`. If not, the Mission needs fresh evidence and App E does not merge.
  6. **Review state:** at least one approval counted by the `main` ruleset exists on the live head, from an account other than the publisher. There are no unresolved review threads, and no `CHANGES_REQUESTED` review that is still current.
  7. **Head precondition:** every merge request passes `sha = <evaluated head>`, so GitHub refuses the merge if the head moved after evaluation.
- **Residual race:** GitHub's merge API takes an expected head SHA but no expected base SHA. The base, a review or a check can still change between evaluation and merge. Re-reading narrows this window but does not close it, so it is not counted as an atomic guarantee. Real merges stay disabled until the later design either closes it through platform enforcement (required checks and approvals in the `main` ruleset, which GitHub re-checks at merge time) or records it as an accepted risk. Tests must cover concurrent head, base and review changes.
- **Shadow first:** App E starts in shadow mode. It evaluates the gates and records the merge it would have made, but does not merge. Enabling real merges needs its own design section and a later ADR. Before that, shadow decisions are compared with the merges that actually happened, recording for each whether a person inspected it. Any human-sampling requirement in that comparison is an implementation proposal for that later ADR, not something decided here. Until then, Mission PRs are merged as other PRs are today.
- **Credential scope:** App E's token can technically merge any PR its permissions reach. “Mission PRs only” is enforced by the gates in code plus negative tests: a non-Mission PR, a copied marker, a mismatched head and a moved base must all be refused.
- **Unchanged:** osstack itself (the CLI, daemon and loops) never merges; that guard stays in code. This also does not change the standing rule for coding sessions: an agent session does not merge its own PRs unless the owner says so.

### 3. Identities (design §12.2)

Agreed: replace personal and shared accounts with GitHub Apps. There are four from the design plus App E:

| App | Permissions (design §8.1) | Does |
|---|---|---|
| A `osstack-publisher` | `contents: write`, `pull_requests: write` | pushes `osstack/mission/*`, opens Mission PRs |
| B `osstack-evidence` | `checks: write`, `metadata: read` | posts `osstack/verify` |
| C `grok-pr-watcher` | `checks: write`, `contents: read` | posts `grok/verify-osstack` |
| D `grok-pr-reviewer` | `pull_requests: write` | submits reviews |
| E `osstack-merger` | `contents: write` (required by the merge endpoint), `pull_requests: read`, `checks: read` | evaluates the decision 2 gates; merges once enabled |

There is also one sandbox-only test-review App (plan 2.4). App ids and installation ids are recorded here when the owner creates the Apps. Private keys live only on the host or in the platform's secret store, never in the repository.

### 4. Collaborators (design §12.3)

The operator for each account is given in decision 1. **Downgrade after the Apps go live:** no repository role changes now. An account is downgraded only after the App that replaces its actual duties is working on the main repository:

- the publisher's duties move to App A in phase 3;
- the Watcher and Reviewer duties move to Apps C and D in phase 6;
- merging moves to App E only after real merges are enabled.

Passing the S2 sandbox probes alone is not enough. The target role for each account is decided then. The owner makes these changes; an agent session only prepares the checklist.

ADR-005 records `gilberthello` and `hyfwin` as owners of the `osborn-studio` organization. Lowering their repository role does not remove their organization-owner authority, so the checklist must cover organization membership as well.

### 5. Rulesets (design §12.4)

Agreed: S1 replaces `main`'s classic branch protection with a ruleset, **in the sandbox first**:

1. build the sandbox repository (plan 2.3);
2. apply the same rulesets there (plan 2.2);
3. run the probes (plan 2.5);
4. only then apply them to the main repository.

That last step also waits for the phase 3 delivery fix. Today's publisher treats any applicable ruleset on a Mission branch as protection and refuses to publish (plan phase 3, probe P-10). So the main repository gets the Mission-branch rulesets only after that fix merges and P-10 succeeds on rerun. Its existing branch protection stays until the replacement is ready.

The repository admin performs every change to GitHub settings. An agent session writes the ruleset files and the read-back script, and stops before each external change.

**Ruleset layout.** A bypass actor bypasses every rule in its ruleset, so `main` needs two rulesets, not one:

- **`main-quality`** (plan 2.2's `main.json`): required checks, approval, resolved conversations, last-push approval, no force-push or deletion. It has **no** bypass actors, so App E and everyone else must meet it, and GitHub re-checks it at merge time.
- **`main-update`**: restricts who may update `main`. Its bypass list is the allowlist of accounts that may merge. Once real merges are enabled it includes App E, preferably in pull-request-only mode. App A is never on it.

Who else is on the `main-update` allowlist during the transition is **not decided here**. Today ordinary PRs are merged by the automation accounts, and an allowlist that leaves them out would stop that. The owner decides the allowlist, and when it applies, at the time S1 is applied to the main repository.

Probes are added to plan 2.5:
- App E cannot merge with a failing check or a missing approval;
- App E cannot push directly to `main`;
- App A cannot merge.

**S1 does not create human review.** It makes GitHub enforce that checks and approvals exist, but approvals can still come from automation (the current accounts, or App D under decision 2). Installing S1 does not change who operates the approving accounts.

### 6. Revision rounds, budget and deadline (design §12.5)

Deferred together with the revision chain (stages S4/S5). These settings are decided when S5 starts. They do not block S1–S3 or S6.

## Consequences

- Plan stage 2 (tasks 2.2–2.5) may start. Its precondition no longer cites ADR-005 for merge rights, since decision 2 above replaces that. Task 2.2 gains the `main-update` ruleset file, and task 2.5 gains probes P-11 and P-12.
- A new task is added: “App E shadow merger” (design and implementation). It follows stage 3, because gates 2–3 need App B evidence and the ledger join.
- ADR-005 stays Accepted for its role tables and numeric ids until the Apps replace them. Its Status line points here.

## Risks

1. **No human gate on `main`.** Approvals and merges on every PR, not only Mission PRs, are made by automation that a person checks only afterwards. The required approval on `main` is not evidence that a person reviewed anything, and S1 does not change that (decision 5). Requiring human review would be a separate owner decision.
2. **One human account.** `gilosbornhello` is the only person and is also the current publisher. GitHub refuses an author's approval of their own PR, so before App A takes over publishing, an approval on a Mission PR can only come from automation.
3. **Ordinary PRs stay outside the gates.** Decision 2 narrows automated merging only for Mission PRs. Whether to gate ordinary PRs the same way is a separate decision.
4. **App review counting is unconfirmed** (design §13.1). If App D's reviews do not count toward the required approval, gate 6 must be met by the one human account or another counted reviewer; probe P-5 settles this.
