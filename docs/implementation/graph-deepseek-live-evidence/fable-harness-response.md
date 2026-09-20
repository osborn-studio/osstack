**Verdict: accept.** No concrete correctness or assertion-honesty blockers in `scripts/verify-bounded-deepseek.mjs`.

**What I verified against the code it exercises**

- Endpoint validation via the adapter factory runs before the report is first written, and the report is only ever written through the redacting save. The key is never placed in the report or config.
- Health gating is the real `autonomy.health` RPC with the `can_run_local` assertion before any `graph.start`. Power policy none and dashboard port 0 are passed by env, not mocked.
- Ready path assertions match the schema. All seven ledger nodes must be `confirmed`, and the outcome shapes match the protocol's result kinds (`implementation_complete`, `candidate_ready`, review `verdict`, tests `passed`). The join row is read from the immutable `graph_verification_joins` table and its `receipt_ref` is compared to the status `resultRef`, which the RPC status spreads from the stored result.
- Negative review saves events and the parsed review before asserting the verdict, so a wrong verdict still leaves evidence on disk. Event types and the `confirmStopped` shape match the adapter.
- Cancellation is honest. The CLI broker only ever marks actions `unknown`, never `cancel_pending`, so the wait for a non-intent, non-running state resolves only to `unknown`, `confirmed`, or `failed`. The unknown branch checks the exact effect key's unreleased admission, no `cancelled` status, unchanged writer candidate, and zero freeze rows. The settled branch requires the outcome JSON state to agree with the ledger state.
- Cancel retry is limited to one attempt, only on `PILOT_RPC_REVISION_CONFLICT`, with a fresh revision and a distinct idempotency key. A timeout or any other code throws immediately.
- Timing defaults are consistent. The 540 second poll ceiling sits under the run's 600 second deadline, so the harness cannot outwait the daemon and misreport.

**Non-blocking notes**

- The RPC maps `TERMINAL_RUN` to `REVISION_CONFLICT`, so a run that finished before the cancel would trigger one retry and then fail honestly. This produces a true failure, not a false pass.
- In the settled writer branch, the check name still says "no forced release of unknown inference." The report records the actual writer state, so a reader can tell which branch ran, but a branch-specific name would be clearer.
- Log redaction operates per stdout chunk, so a key split across two chunks would not be masked. The daemon should never log the key, so this is theoretical.
- If a live model returned inside the 200 ms window before cancel, freeze could start and the zero-freeze assertion would fail. Again an honest failure, not a false positive.

Nothing here changes the prior acceptance of the adapter, profile, or RPC. The harness is suitable as the live pilot gate for this slice.