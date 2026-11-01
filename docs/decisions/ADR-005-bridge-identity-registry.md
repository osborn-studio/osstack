# ADR-005: identity registry for the osstack × Grok Bots first phase

- Status: Proposed (draft; the repository owner fills in every `FILL` cell, then sets Accepted)
- Date: 2026-11-01
- Decision owner: repository owner
- Scope: which GitHub identities the first-phase bridge conventions recognize

## Context

The [bridge design](../design/2026-11-01-osstack-grok-bridge.md) lands a zero-code first phase (section “首期落地范围”). Grok Bots routines identify osstack Mission PRs and handle PR, review and check events only for registered identities. They compare **numeric GitHub ids, not logins**, because logins can be renamed. The design keeps this registry in its own ADR (stage S0a), so it does not wait for the other decisions in §12 of the design.

The first phase takes effect when this ADR is Accepted and the Grok Bots routines are configured from the tables below.

### Observed facts (read 2026-11-01 with `gh api`; not role assignments)

| Login | Numeric id | GitHub account type | Repository role | In the last 40 merged PRs (#325–#364) |
|---|---|---|---|---|
| `gilosbornhello` | 269190136 | User | admin | authored 37; this host's `gh` and git identity |
| `gilberthello` | 160148718 | User | admin | authored 1; approved 20; merged 20 |
| `Rubebun-Jadeem` | 243772068 | User | admin | authored 2; approved 21; merged 20 |
| `maomaobdm` | 317464155 | User | maintain | one dismissed review |
| `hyfwin` | 2900559 | User | admin | none |
| `wsorange` | 127640032 | User | admin | none |
| `linxinlan1980` | 292102352 | User | read | none |

All seven are ordinary user accounts; the repository has no GitHub App identities yet. In every one of those 40 PRs, the account that merged also approved it. Whether each account is operated by a person or by a bot cannot be read from GitHub and must be stated below.

## Decision

### 1. Roles

Each role lists the accounts whose actions the first-phase conventions recognize. An account not listed for a role is ignored for that role.

| Role | What the conventions use it for | Login | Numeric id | Operated by (person / bot) |
|---|---|---|---|---|
| osstack publisher | A PR counts as a Mission PR only if this account authored it (design A.1) | `gilosbornhello` (FILL: confirm) | 269190136 | FILL |
| Reviewer | Its `CHANGES_REQUESTED` and `APPROVED` reviews feed the human summary (design B) | FILL | FILL | FILL |
| Watcher | Its verify-osstack conclusions on the current head and base feed the human summary (design B) | FILL | FILL | FILL |
| Human merger | Merges `main` after GitHub shows the PR as mergeable | FILL | FILL | person |

A role may have several rows; add one row per account.

**Check producers.** “All checks passed” (design B) counts only check runs from the producers below. Check runs are matched by the producing GitHub App's id, not by a user id.

| Producer | Check names | GitHub App id | Counts toward “all checks passed” |
|---|---|---|---|
| GitHub Actions (`github-actions`) | `check`, `graph-macos-fixtures (*)`, `graph-runtime-matrix (*)` (observed on `main` at `d19b7fae`) | 15368 | FILL: yes / no, and which names |
| Watcher, if it publishes check runs | FILL | FILL | FILL |

**Identity field per event.** Routines compare these numeric fields with the tables:

| Event | Field compared | Against |
|---|---|---|
| `pull_request` | `pull_request.user.id` | osstack publisher |
| `pull_request_review` | `review.user.id` | Reviewer |
| Watcher conclusion posted as a review | `review.user.id` | Watcher |
| `check_run`, `check_suite` | `check_run.app.id`, `check_suite.app.id` | check producers |
| Any event, to skip self-triggered ones (design B) | `sender.id` | the routine's own account |

Rules:

1. The publisher must not also be a Reviewer or Watcher. GitHub already refuses an author's approval of their own PR; this rule also keeps the publisher's conclusions out of the summary.
2. An account operated by a bot must say so in the last column. A bot account may hold the Reviewer or Watcher role, but not the Human merger role.
3. One account may hold both the Reviewer and the Human merger role only if a person operates it. Record that in the table; the observed history shows this pattern for `gilberthello` and `Rubebun-Jadeem`.

### 2. Every collaborator

Every account in the observed facts must have a row here before this ADR is Accepted, including the ones that also appear in §1.

| Login | Numeric id | Operated by (person / bot) | Roles from §1, or “none” | Keep current repository role? |
|---|---|---|---|---|
| `gilosbornhello` | 269190136 | FILL | FILL | FILL |
| `gilberthello` | 160148718 | FILL | FILL | FILL |
| `Rubebun-Jadeem` | 243772068 | FILL | FILL | FILL |
| `maomaobdm` | 317464155 | FILL | FILL | FILL |
| `hyfwin` | 2900559 | FILL | FILL | FILL |
| `wsorange` | 127640032 | FILL | FILL | FILL |
| `linxinlan1980` | 292102352 | FILL | FILL | FILL |

Repository role changes are not part of the first phase; record the intent here and make the change separately.

### 3. Changes

The registry changes only through a PR to this ADR. A routine's allowlist must match the Accepted version of the tables. When an account is removed from a role, events from it are ignored from the moment the routine is reconfigured; past summaries are not revisited.

## Consequences

- Grok Bots routines get one authoritative allowlist, keyed by numeric id.
- Until this ADR is Accepted, the first-phase conventions are not in effect, and bots handle osstack PRs as they do today.
- The later stages of the design (GitHub Apps, rulesets) will replace user accounts with App identities; this ADR is then superseded, not edited in place.
