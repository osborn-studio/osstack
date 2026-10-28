# Feature map template

This is an authoring template, not a completed map or a machine contract. Replace placeholders from inspected source and real observations before presenting a feature as usable.

## Index

| Feature ID / user outcome | Entry point | Owner | Source reviewed at | Live evidence at | Coverage / missing prerequisite |
| --- | --- | --- | --- | --- | --- |
| <stable name> | <CLI/RPC/UI route> | <maintainer> | <commit and path> | <record or not_run> | <explicit state> |

## Per-feature page

- **User goal and sub-features:** observable outcome; alternative user entry points that also need coverage.
- **Source:** commit, relevant implementation, test and any governing contract.
- **Preconditions:** build, fixture inputs, auth scope, platform, external prerequisites. List replaced external systems.
- **Launch and readiness:** exact command/cwd; evidence the instance is usable and owned.
- **Doctor:** exact supported check and what it cannot inspect.
- **Drive:** ordered commands/actions, stable identifiers and bounded waits.
- **Observe:** predicate on actual result plus side effects; identify evidence for action and outcome.
- **Failure and recovery:** distinguish product failure, driver failure and missing prerequisite; bounded reset/retry with ownership rules.
- **Cleanup:** owned resources, observed shutdown, state disposition, proof that evidence survives.
- **Coverage:** candidate/environment actually exercised; omitted paths and provider/platform cells.
- **Maintenance owner and trigger:** who reviews changes to source/driver/predicate; no automatic schedule implied.

Use separate rows for behavior, cleanup and coverage rather than compressing them into one green badge. The [engineering decision example](engineering-decision.md) is a concrete starting map, with three observations from one scripted journey rather than three independent end-to-end scenarios.

The [skills-check journey](skills-check-journey.md) is another concrete map: a healthy CLI result and an expected source failure, each with separate product and driver exits. It names the supported command, retained proof and cleanup limit. Use its two rows only for that scope; do not copy their outcomes into an unexecuted run.
