---
"@osstack/cli": patch
---

Add the phase 5-E live observation service, with bounded cursor scans, read backoff, stable-read checks, revision dispatch, and cancellation retry from durable chain state. Synchronize halted and terminal children without reopening stopped chains or settling push intents. Register host work before calling ports so synchronization can distinguish a halted child from a human decision in progress.

This slice depends on the D9 same-child resume store methods. It does not enable `OSSTACK_BRIDGE=1` or construct the production service. Production wiring, receipt recovery ordering, and a shared limiter with the D7 stopped-chain PR reader remain integration work. Cancellation ports must enforce the grant principal and daemon fallback contract and honor the supplied abort signal. Legacy read transports can continue a bounded read after stop, but its result cannot write the ledger.
