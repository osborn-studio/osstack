# Architecture design

Use this method when a task needs a deliberate choice of data shapes, interfaces or ownership before implementation. Produce a design that callers can use and implementers can test. Keep an already clear local change small; an architecture exercise is not required for every edit. Follow [the common evidence rules](evidence.md).

First determine the authorized deliverable. For design-only work, stop with the design and executable next-step specification; do not change product behavior. If implementation is already authorized, continue into the appropriate [feature](feature.md), [bug-fix](bug-fix.md) or [refactoring](refactoring.md) work after choosing a supported design. Do not invent another approval checkpoint. Honor an explicit request to pause before implementation. Ask only for an unresolved decision that changes the permitted work or a material design constraint, and continue independent checks.

## Ground the system before choosing a shape

Pin the relevant source revision and working-tree changes. Read the actual entry point, callers, types, state owners, persistence, adapters and tests. Trace a concrete input through them to its output, failure and side effects. A file list or component diagram is not that trace. Use [investigation](investigation.md) when the mechanism or reason for the existing shape is unclear.

Record the user outcome, affected consumers, existing contracts and constraints. Use history, design records and caller behavior to distinguish a deliberate compatibility choice from an accidental pattern. Cite the evidence and label unresolved hypotheses. Even a new component has external boundaries and deployment constraints; greenfield work does not justify inventing them.

Identify what is known from source, what was executed, and what still needs a probe. Do not run an install, migration or production operation merely to fill a design document. Any probe uses the task's actual execution authority and an owned environment. Missing access leaves that fact unknown.

## Start with callers, then model the data

Write a short usage example before defining the interface. Include two or three realistic call sites when the operation has distinct consumers or outcomes. Show what they import, provide, receive and handle. Include an important failure or retry, not only a happy path. Derive the types and signatures from those uses. Reconcile disagreement between usage and sketch rather than making callers orchestrate hidden internal steps.

Name the domain entities, semantic identifiers and allowed states. Trace the dominant reads, updates and queries through the proposed structures. Choose a map, index, queue, state machine or plain record because an access pattern or invariant requires it. Do not add a generic abstraction or promise to solve an unexplained access cost with a cache later. Keep explicit local code when it already fits.

For each stateful resource, name its authoritative owner, readers, permitted writers and lifetime. State who creates, publishes, cancels, releases and cleans it up. Distinguish a request from its acknowledged effect. Describe repeated requests, partial failure, process restart, concurrent writers and late results. If actors publish independent facts, consider separate owned artifacts with a read-time merge. If one canonical state is required, design the actual single writer, transaction or conflict check. A comment saying “only one writer” is not enforcement.

Sketch inputs, results and explicit error variants. Use semantic types to prevent mixing different identifiers, and discriminated states to exclude invalid combinations. Derive types from an authoritative schema where one exists. Parse external bytes at each trust boundary, including database reads, RPC and IPC; a static type or earlier validation does not authenticate a later message. Keep pure domain decisions separate from I/O where practical. Authorization, freshness and concurrent-state checks still belong at the point where their facts can change.

## Compare distinct structures

For a non-trivial architectural choice, sketch at least two structurally different candidates before selecting one. They must differ in ownership, representation or responsibility, not only naming or a helper function. A single author can make both sketches. Use extra reviewers only when authorized and available; no model name, arena service or mandatory delegation is required.

Compare the candidates using the same callers, constraints and failure scenarios. A deep interface hides substantial policy and coordination behind a small usable surface. It is not a long call chain. State what each interface hides and what callers still must know. Compare compatibility, operational cost, testability and migration cost as well as implementation effort. If only one candidate is viable, show which concrete constraint rejects the other rather than inventing a false choice.

Check for duplicated state owners, wire or storage types leaking into public APIs, phase-by-phase modules that repeat the same invariant, pass-through layers without policy, importable internals, and lists that require manual synchronization. Prefer one authoritative representation and derived views. Where derivation is impractical, name the owner and a consistency check. Do not remove a legitimate adaptation boundary or compatibility path solely because it forwards a call.

## Make the recommendation implementable

Provide the selected module map, caller examples, data definitions and signatures. Mark pseudocode and unimplemented bodies visibly. Keep exploratory stubs outside production entry points unless executable scaffolding is explicitly part of the task. A sketch that typechecks is still not an implemented system.

Keep a short rationale beside the sketch: problem and constraints; candidate comparison; selected shape and any useful part retained from another candidate; rejected alternatives; accepted tradeoffs; unresolved questions; and the first bounded implementation unit. Do not claim independent model agreement when no such review occurred.

List the checks that could disprove the design. Include caller-level success and rejection, invariant violations, duplicate/conflicting requests, interruption and ownership transfer when relevant. Bind proposed checks to an actual entry point or mark the driver as missing. Keep a design walkthrough, a typecheck, a model check and a real execution result separate. A passing example cannot prove an untested distributed or provider path.

For an existing system, inventory consumers before changing the contract. Sequence migration and compatibility checks in small units. Preserve an external promise while it remains required. Give any temporary adapter an owner and removal condition. Remove an old API only after its callers and compatibility obligations are resolved. Establish rollback or reconciliation for partially applied transitions; do not assume a schema edit or a retry reverses an external side effect.

During authorized implementation, record departures from the sketch with their cause and affected contracts. Repeated caller workarounds, casts, special-case branches or unexpected shared-state locking can indicate a wrong shape. Investigate the pattern across independent cases. One difficult edge case is not sufficient reason for a rewrite. Re-ground the system using the new constraints, compare revised shapes, and replace the obsolete design proposal when warranted. Preserve existing code, user changes and evidence until an authorized migration replaces them. Redesign is not permission to discard a checkout or delete working compatibility paths.

## Synthetic design comparison

This example is invented. It illustrates a design review; it is not an OSStack API, an implemented service or an executed crash test.

A caller wants an asynchronous report and may retry its request. Sketch the caller operations first: `request(spec, requestKey) -> RequestResult`, `status(reportId) -> ReportState`, and `cancel(reportId) -> CancelResult`. An accepted request returns a `ReportId`; reusing the same key with the same specification returns that identifier, while a different specification with that key returns a conflict. `ReportState` separates queued, running, succeeded-with-artifact, failed-with-reason and cancelled outcomes. `CancelResult` separates a recorded cancellation request from an already terminal state. A cancellation request alone does not make the report cancelled. Queued and running states expose a `cancelRequested` marker; status and cancellation also have an explicit unknown-identifier result. These are sketch requirements, not existing API definitions.

| Candidate | Ownership and caller cost | Decision under the example's constraints |
| --- | --- | --- |
| One report coordinator with durable request and outcome state | Workers compute; the coordinator owns key deduplication, cancellation decisions and publication. Callers use the three domain operations without coordinating persistence stages. | Choose this if one authoritative report outcome and cancellation decision are required. Accept the coordinator's availability and persistence cost. |
| Independent immutable worker-attempt records with a merged view | Workers own their attempts. A reader combines observations; a separately defined publication decision must still choose the authoritative artifact. | Useful when independent observations are the product. For the stated single-outcome contract, the extra publication/cancellation coordination is not removed by merging records, so reject this shape for this example. |

The recommended sketch still needs a durable definition of request-key scope, specification equality, retention and terminal-state precedence. A late worker must not overwrite a terminal outcome. After a crash between producing an artifact and recording success, recovery must inspect durable evidence and reconcile it. An idempotent publication target or a queryable operation identity may help; the signatures alone do not provide exactly-once effects.

Walk through these counterexamples before implementation: a different specification reuses a key; cancellation races with completion; a worker returns after ownership changed; and a restart occurs after publication but before acknowledgement. Check both callers' observed state and the artifact. A design that marks cancellation complete on request, reports success before the artifact exists, or lets every caller update outcome storage violates its own contract. This is a manual reasoning exercise. Those failures remain proposed execution tests until a real implementation and authorized driver exist.

The method adapts the pinned upstream architect and related design principles in OSStack wording. See [source attribution](sources.md). It does not add a design service, install a model panel, expand runtime permissions or issue a qualification gate.
