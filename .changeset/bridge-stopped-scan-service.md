---
'@osstack/cli': patch
'@osstack/core': patch
---

Add a bounded stopped live-chain PR scan and durable child Mission cancellation. The service waits for the separate live-mode switch.

Core `scanStoppedChains` now accepts an abort signal and a post-close callback, chain close persists `stop_reason`, and the chain store exposes `listClosedPrLive` for cancellation recovery.

The scan's per-chain read backoff is local to this service. The live cycle has no shared rate limiter yet.

A crash between a successful cancel request and its `child_cancel_requested` event leaves the cancel unrecorded, although the cancel itself happened.
