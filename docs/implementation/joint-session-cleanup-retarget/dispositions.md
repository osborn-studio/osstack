# Audit dispositions

The original Claude reports are retained verbatim. Round 1 was REVISE; round 2 was PASS with no actionable P0/P1/P2.

| Observation | Host verification and disposition |
|---|---|
| Claimed #276 content missing | Audit prompt described both project slices. This PR is #278 only; clarified in round 2. |
| requestScan synchronous throw | Read the concrete SupervisionService: work runs in Promise.resolve().then; stopped state returns Promise.reject. A synthetic synchronous replacement is not the current implementation. Independent test confirms rejected scan preserves the receipt. |
| Controller identity guard lacks alternate-controller test | Defensive compare-and-delete is correct. Current start lookup/transaction path prevents that interleaving; no artificial mutation hook added. |
| Failed replay returns ok:true | Confirmed existing lookup semantics; changeset now says clients must inspect state:failed. Replay does not repeat execution. |
| Stop verifier behavior unavailable | Supplied adapter-lifecycle.ts and GovernedExecution. Exceptions/timeouts return false, retain marks ownership before diagnostic writes, physical release failure keeps permits. Existing and independent RPC tests cover this. |

No product correction was required after retargeting. The changeset clarification is documentation only. #279 terminal fencing and DEBT02 process-death recovery remain separate obligations; J11 specification merge does not implement them.
