**Verdict: accept.**

The version-pin fix is correct and the changed files contain no new concrete blocker.

**Version pin.** The literal set in `graph-bounded-recovery.ts:35` matches the current delivery version exactly, field for field, including the engine, checkpoint, and template values. All nine program fields are compared against the stored run identity, and the compiler-derived fields are recomputed from the stored spec rather than trusted from the ledger. A future template bump changes only the delivery constant, so recovery refuses with a program error and the RPC catch path returns cancel_pending without settling or releasing. Not importing the delivery version constant is the right call for this boundary. The specHash and inputDigest fields are not compared, but they are bound through the fence and the compiled digest, so that omission is safe.

**Future-template fixture.** The prototype patch on the run store's create is reachable. The RPC service creates the run once and hands it to delivery as a reserved run, so no second create with a conflicting version occurs. The worker manager and worker runtime check only engine and checkpoint versions, so the run proceeds to reconciliation_required normally. The test then expects cancel_pending, retained admission, zero recovery decisions, and one invocation, which is consistent with the recovery code and the RPC catch path. That test is unexecuted per your report, so this acceptance is conditional on it passing as written.

**Stop evidence.** The broker attaches the stop evidence reference only for implement and repair, sourced from the adapter's independent confirmStopped result, never from model text. The receipt validator accepts extra evidence fields, so verification receipts without the field remain loadable. Both the journal publisher and the recovery path require the provider-prefixed evidence format, which fails closed for non-bounded adapters.

**Scope.** Unchanged from the accepted narrow scope. Journaled worker exit is still required through the reconciler's verify hook, the host PID must be provably dead, and there is no host_lost or unknown-state inference.

**Non-blocking observations.**
- Reconstructed actual tokens use the sum of the receipt's in and out counts, while the live broker takes a maximum over observed and persisted values. For a single finite response these coincide, and this was already part of the accepted design.
- The recovery version literals will need a coordinated edit whenever the delivery constant moves. That is the intended fail-closed cost, but worth a comment pointing at the delivery function so the coupling is discoverable.
- The fixture's prototype override is bundled by esbuild without type checking. Fine for a fixture, but it will not be caught if the create signature changes.

Remaining before merge: run the future-template test and the broader Loop suite you noted as pending.
