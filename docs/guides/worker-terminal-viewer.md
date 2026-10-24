# Local worker snapshot viewer

`worker watch VIEW_ID --repo ABSOLUTE_PATH --default-tenant` opens a local terminal
presentation of the existing worker state view. Obtain the view ID from the
existing read-only worker list/inspect flow. This displays structured snapshots,
not a log tail, process liveness proof or execution console.

Optional `--interval-ms` is 1000..10000 (default 2000). `--duration-ms` is
1000..900000 (default 60000). Each read calls only `worker.inspect` with the original
repo/default-tenant/view token and a 1000ms RPC timeout. A separate local 1000ms deadline ends a hung read
as unknown even if the transport ignores its timeout. The server may return a new
token, but the viewer never adopts it to renew authority. Expiry, daemon restart,
source unavailable/unknown, invalid response or scope changes end observation
without acquiring another token. Stale observations remain visibly stale. All
snapshots retain `process_liveness:unknown` and `controls:unsupported`.

`PresentationBackend` exposes `capabilities`, `open`, `focus`, and `closeView`.
The terminal backend supports view only; focus and archive are unsupported. A
backend instance opens one view. Its opaque local handle has no worker control
authority. Closing the view or pressing Ctrl-C only stops local reads/display;
it never invokes cancel/resume, changes a task, removes logs or closes stdout.
No tmux/cmux/desktop integration is installed or claimed qualified.

Output is serialized with the existing worker-view terminal escape policy,
including ANSI, C1, OSC and Unicode format controls. Identical metadata snapshots
are suppressed. Each bounded write completes before another poll, so backpressure
cannot accumulate an unbounded output queue. EPIPE ends only the presentation.
A pending read/write is logically cancelled at duration/close; late read results
cannot print. The local deadline aborts the read signal. The RPC transport should honor the supplied AbortSignal and must
retain the bounded timeout even if cancellation is unavailable.

Host integration is `handleWorkerViewerCommand(args,{rpc,output?,stderr?,onInterrupt?})`
where args begins with `watch` and rpc receives
`('worker.inspect',params,1000,signal)`. Wire this lazily beside existing worker
list/inspect routing. The handler returns 130 on Ctrl-C, 1 on unknown/output failure,
and 0 on configured duration or normal local close. It never opens/migrates a DB
or starts a daemon. Existing worker scope/tenant validation stays authoritative.

Tests exercise real WorkerViewService reads with no DB row changes, fixed-token
polling, changed scope, invalid/flood responses, unknown/expired data, terminal
escaping, output backpressure, EPIPE, duration and interruption. A separate native
smoke uses fixture read responses with the compiled viewer code to verify actual
OS SIGINT and closed stdout pipe behavior; full CLI/daemon routing is integrated
and qualified separately. No real model or external display backend is involved.

Residual boundaries: the server's authenticated opaque token binds source identity;
the viewer retains that exact token and additionally fences returned scope/kind.
It does not infer process health from revisions. Transport timeout failures may be
reported generically as `worker_request_failed`; the independent local deadline
reports `worker_read_timeout`. Both end observation as unknown. If stdout never
completes a pending write, one chunk and one late-error guard remain until its
callback/error, so a delayed EPIPE cannot crash the process. This deliberately
bounded guard can consume an unrelated error on the shared stream; the viewer
never destroys shared stdout to reclaim it.
