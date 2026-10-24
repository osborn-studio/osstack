# Active Graph + supervision qualification

This is an opt-in executable local qualification (`scripts/bench-supervision-active.mjs`), not a finished-Graph read-only soak. It starts actual Graph engine processes and actual Node adapter children, holds a child live during supervision/Loop/socket load, then observes actual completion and separate actual cancellation/process-group stop. A fresh Graph service re-reads durable cancelled state without starting another child. Supervision stop/restart rejects old owner access and discards an actual-file read that finishes after its owner stops. Sixty retained session fixtures create mixed observer load; they are explicitly synthetic, not live providers. No model/provider/network message is sent.

## First stress measurement — budget FAIL, functional assertions PASS

At20ms dirty interval (50Hz), on the shared development machine concurrently running root QA and this agent's Graph regressions:

-790 real socket samples; p95=21.847ms, max=722.072ms. Target<10ms was **not met**.
-6 Loop cycles,5,000ms scheduled idle,5,321.614ms measured wall; overhead6.0435%. Target<1% was **not met**.
-Observer step p95=5.848ms, max19.517ms. The5ms slice is soft and was exceeded.
-Actual Graph completed; second actual child cancelled and stopped; released admissions=0held; supervisor generations1→2; stale owner/read rejected.

The earlier RED run's adapter fixture returned unconfirmed before its own pending child-stop proof had settled. Its `confirmStopped` now awaits its real pending shell result, matching the adapter contract. Production cancellation thresholds were **not changed**.

The harness defaults to100ms dirty cadence for the next normal-cadence measurement and accepts `OSSTACK_SUPERVISION_DIRTY_INTERVAL_MS=20` to reproduce saturation. No threshold is relaxed. Raw requestScan durations include coalesced requests waiting for quiescence; they are not per-pass CPU duration. Additional per-tick timing distinguishes work from scheduler delay without replacing the original wall-overhead gate. Final isolated measurement is pending the root full-QA window.

Run with an explicit scratch OSSTACK_HOME and OSSTACK_SCRATCH_ROOT; use a short scratch TMPDIR for Unix sockets. Output reports retain samples and independent function/budget conclusions. Live model/Docker/remote-provider behavior and cross-platform qualification remain unmeasured. Final external audit is blocked on the root's CLI authentication; this report does not claim an audit pass.
