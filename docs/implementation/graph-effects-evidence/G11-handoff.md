# Provisional G11 interface — parent integration notice, NOT acceptance

Parent inspected current G11 source. graph-actions.ts and graph-storage.ts plus migration26 now exist. G13 may proceed with graph-checkpoints.ts and migration27; waiting for G11 final full-core build would create a dependency cycle because G13 tests already import its missing module. G11 actor will replace this provisional note with final evidence handoff.

GraphActionStore(db): reserve(fence, GraphActionAdmission), get(fence,effectKey), markRunning(fence,effectKey,executionRef), recordOutcome(fence,effectKey,outcome), markUncertain(fence,effectKey,{state,evidenceRef,observedTokens}), retry(fence,effectKey). Return GraphActionResult {action,run,budget,created,changed}. Admission {epoch,nodeId,effectSlot,action,reservationTokens}. Budget {actionStarts,reservedTokens:string,chargedTokens:string,accountingBlocked}. Outcome {state:'confirmed',evidenceRef,actualTokens,result:GraphResult} OR {state:'failed',evidenceRef,actualTokens,error:GraphJsonValue,retrySafe:boolean}.

Internal ./graph-storage.js: fencedGraphTransaction(db,fence,(run)=>({value:T,changed:boolean})) returns {value:T,run:GraphRun}; BEGIN IMMEDIATE acquired before live scope/generation/identity/owner/revision check, then whole callback; changed increments revision/updatedAt in same transaction. No nested/async callbacks. get/cache hits changed:false still check fence. Never export this callback-taking function via core index.

GraphRun now has spec: StartGraphRequest['spec'] | null; migration26 adds spec_json (legacy null), stores original spec for newrun, immutable trigger. G13 core table migration27 only; G11 owns migration26. Read actual sources for exact types. Each actor can append OWN nonconflicting exports to core index only after its importcost measurement. Parent final build/test validates all packages together; interim full-core/cli failures caused by unimplemented sibling modules are not task failures.

Parent owns graph-checkpoint-service.ts/test and graph-checkpoint-daemon.test.ts; G13.execute signature from G13-interface.md honored. Parent will wire daemon checkpoint service after G12 finishes broker changes. Read parent-review-notes.md for current independent boundary test concerns; G12 parent tests graph-action-broker-boundary.test.ts reproduce them, parent will integrate fixes after actors finish unless actor naturally handles them now.


## Final checks

All commands used `OSSTACK_HOME=/Volumes/AIMATE_WORK/tmp/gc4/home TMPDIR=/Volumes/AIMATE_WORK/tmp/gc4`.

- `pnpm --filter @osstack/core test`: PASS, 35 files / 382 tests, including concurrently completed G13 tests. Log: G11-core-test-2.log.
- `pnpm --filter @osstack/core typecheck`: PASS. Log: G11-typecheck-3.log.
- `pnpm --filter @osstack/core build`: PASS. Log: G11-build-2.log.
- `pnpm --filter @osstack/core exec vitest run src/state/graph-actions.test.ts src/state/graph-runs.test.ts src/state/db.test.ts`: PASS, 84 tests. Log: G11-focused-3.log.
- `git diff --check`: PASS.

Root exports now include GraphActionStore/GraphActionStorageError and named API types. Shared fencing utility and its callback are internal only. G13 has independently adopted the utility and appended migration 27; those code/DDL additions belong to parent/other actor, not this G11 implementation. Other packages and G13 core files changed concurrently and were preserved. No commit/push/status/config/AGENTS changes or nested execution by this actor.
