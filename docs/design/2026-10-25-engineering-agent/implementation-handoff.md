# Session adoption implementation contract

Baseline: 14e7433b70f103499059c15fb9bf2ed87b0b0279. Scope: adopt_session only; the runtime registry and goal_dispatch remain out of scope. Read runtime-contract-v2.md and waiting-decision-pilot.md. Runtime is opt-in via OSSTACK_ENGINEERING=1 plus OSSTACK_ATTENTION=1. No new initial Worker. Single default tenant. No production isolation claim.

## Final P2 decision: authority and cancellation

The daemon authenticates an engineering credential from a host-owned file outside the repository. The request never supplies a trusted actor, role or permission. The local pilot is explicitly a trusted-process profile: same-UID malicious workers are not isolated by a token file. Worker isolation is a separate qualification, not claimed here.

An authenticated principal has separately scoped read, write, stop and operator rights from the host authority configuration. Every Mission RPC, including cancel, requires current scope read permission to prevent receipt disclosure. Read and stop remain independent of write. Adoption requires current read+write authority and records immutable owner_principal_id. Decide/defer/dispose require that same owner and current read+write authority. Other writers cannot steer this Mission. A scope stop operator can cancel this Mission even after its owner's write authority is revoked; write authority alone never grants operator or stop rights. The adopt owner can cancel while its independently granted scope stop right remains valid. Scope write revocation must prevent dispatch but must not implicitly revoke independent stop authority. A credential revoked entirely is rejected; the host's separately authenticated scope-stop operator remains the recovery path. No impersonation via request JSON.

endObservation requires the owner with current read authority, or a scope operator with explicit read+stop authority. It only ends observation; it never stops the Worker, clears a receipt, grants new execution, or asserts success. It prevents pending first dispatch for this Mission and terminalizes only proven uncommitted reservations as cancelled_before_dispatch; committed/unknown effects remain under the original attention ledger and guard. Cancel and endObservation take CAS revision and request_id; authenticated same-payload replay is read-only and idempotent. None may require a successful send or a resolved receipt. A denied stop returns permission_denied, not stopped.

The actor/credential table is host configuration, not Mission-controlled data. A live credential reload must make revocation effective before every new dispatch. Startup refuses insecure credential file modes/symlinks where needed. Tests inject host-authenticated principals, not params.actor. Do not log bearer secrets or commit local authority files.

## Parallel ownership

- Core agent: packages/core/src/state/engineering-*.ts, attention-actions.ts and tests, migrations.ts and migration compatibility readers/tests, core index exports. Implement authoritative store, phase extension and projection fixes atomically.
- Runtime agent: packages/cli/src/engineering-host.ts, engineering-access.ts and tests, daemon.ts integration and daemon engineering tests. Reuse the existing execution helper, admission and stop mechanism. No duplicate outbox.
- Protocol/entry agent: packages/protocol/src/engineering*.ts and index/tests; packages/cli/src/engineering-command.ts and tests, bin.ts lazy command entry, bilingual CLI guide. Publish protocol/API choices promptly to the core and runtime agents.
- Root: task ledger, design decision, integration, independent scenarios/validation, full tests, Sonnet audit, PR and cleanup. Only root commits shared changes.

All three agents share one worktree with disjoint file ownership. Coordinate API contracts before heavy implementation. Do not run simultaneous full builds that mutate dist. Root performs integrated builds. Use Node 22. Targeted Vitest may run after baseline build. Never use default OSSTACK_HOME. Temporary output must live under /Volumes/AIMATE_WORK/tmp/osstack; use an explicit task scratch directory. Do not edit the primary dirty checkout.

## Minimum contracts

Expose strict request schemas for adopt, observe, decide, defer, cancel, endObservation and reconcile (query_action/dispose_wait). Use the original stable work-item IDs C01/C02/D01–D08/V00. Include principal/client binding, Mission/item/session version separation, HMAC or opaque persisted interaction tokens, actor-scoped replay, no TTL extension by replay, source identity, FULL on the actual daemon write connection, dispatch CAS permit, and callback completion in the original completeInboundTurn transaction.

All phase-aware paths must agree: reserveSessionInstruction guard, AttentionActions.reconcile/recover/abandon, attention.answer and session.send replay, executeReservedSessionTurn gate and engineering restart recovery. Legacy/committed unknown messages are never retried. Strictly proven reserved messages may perform their first dispatch after current authorization/admission/fence checks. Recovered inconsistency remains unknown, not auto-corrected.

ObservationProof is not code delivery. A Run terminal predating the adopted reply cannot complete the Mission. Bound queues, pagination, payload sizes and reminder budgets. Non-changing observations do not call a model. All 58 adopt_session scenarios need evidence or a precise missing environment reason; never mark planned cases as passed by inference.
