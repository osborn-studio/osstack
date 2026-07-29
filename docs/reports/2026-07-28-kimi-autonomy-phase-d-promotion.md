# Kimi Autonomy Phase D → E Promotion Report

Status: `BLOCKED_PENDING_REAL_SOAK`

Report date: 2026-07-28

Implementation branch: `feat/guarded-deploy-operations`

Required base: Phase C merged on `main` at
`b99bbfb126895f862aa85eb93b09857945d5d078`

## Decision

Phase D implementation is eligible for pull-request review and merge after the
repository gates below pass. Phase E productization is **not** authorized by
this report. Promotion remains blocked until the reviewed Phase D release is
installed on the registered Mac Mini and the seven-day real soak produces a
passing, checksummed report.

This checkpoint grants no machine-wide authority, production authority, or
publication authority. Those actions retain their separate literal gates:
`OWNER-GO-MACHINE`, `OWNER-GO-PROD`, and `OWNER-GO-PUBLISH`.

## Implemented Phase D controls

- closed, deterministic deploy change classification and stricter private
  policy overlay;
- script-authority hashing with RISK-R3 escalation for referenced deploy,
  verify, health, and rollback scripts;
- project-allowlisted staging and production deployment with bounded argv
  execution, minimal environment forwarding, health verification, rollback,
  and durable production freeze;
- externally signed approval and freeze-clear decisions;
- append-only deployment, transition, notification, and controlled rollback
  drill evidence in SQLite;
- repository locks, machine-wide concurrency control, restart recovery, clock
  anomaly handling, and fail-closed external outage recovery;
- launchd installation, host evidence, retention, health, reliability
  scorecards, durable Owner notification retry, and dry-soak fault injection;
- a controlled non-production rollback drill producer:
  `osstack autonomy drill rollback --repo OWNER/REPOSITORY --json`.

## Repository verification

The release checkpoint must retain logs for all of the following:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm smoke:guarded-git
pnpm smoke:guarded-deploy
pnpm test:soak-kimi-autonomy
git diff --check
```

The offline guarded-deploy smoke must report:

- `status: passed`;
- `remote_writes: 0`;
- healthy staging and production fixture deployments;
- a verified final proof emitted after deploy health succeeds.

Repository verification proves implementation behavior only. It does not
substitute for real Mac Mini or production evidence.

## Blocking real-soak evidence

After the Phase D PR is merged and the reviewed release is installed, the Mac
Mini operator must follow
`docs/runbooks/kimi-mac-mini-autonomy.md` and produce:

1. a checksummed manifest of at least 30 distinct real RISK-R1/R2 tasks across
   at least two registered repositories;
2. a checksummed chronological NDJSON event log covering seven elapsed days;
3. five successful SIGKILL recoveries;
4. three recovered network interruptions;
5. three forced deploy failures with successful rollback and post-rollback
   health;
6. one durable notification outage/retry;
7. one stale signed-decision rejection;
8. one deploy-script digest-mismatch rejection;
9. at least 85% unattended completion;
10. zero unauthorized R3/R4 actions, escaped reviewer mutations,
    proof-integrity failures, or open high-severity defects.

The read-only productization check is:

```bash
node scripts/soak-kimi-autonomy.mjs \
  --status \
  --require-productization \
  --report "$OSSTACK_HOME/reports/kimi-autonomy-soak-latest.json"
```

## Promotion rule

Phase E may start only when all conditions are true:

- the Phase D PR is merged;
- the installed revision matches the reviewed Phase D release;
- the productization check above exits zero against checksummed source
  evidence;
- the report covers at least seven real elapsed days and passes every exact
  threshold;
- no unresolved high-severity defect or production freeze remains.

Until then, the authoritative decision is:

```text
PHASE_E_PROMOTION=DENIED
REASON=REAL_MAC_MINI_SOAK_NOT_YET_GREEN
```
