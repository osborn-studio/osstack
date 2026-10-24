# Descendant drain fixture startup handshake

The full qualification run at `84b406b4` failed
`packages/loop/src/executor.test.ts` / `lets finishing descendants drain within a bounded window`.
The recorded case took 217 ms and returned exit code 1, termination trigger
`leader_exit`, `stop_confirmed: true`, and signals `["SIGTERM"]` instead of a
natural exit without signals. The original raw log is
`/Volumes/AIMATE_WORK/tmp/osstack/smoke/firstmate-completion-20261024/final-qa-logs/test.log`.

The fixture spawned another Node process and immediately exited its leader.
Receiving a child PID does not establish that the child has started evaluating
its program or scheduled its 10 ms timer. Node startup was therefore included
in the production descendant drain allowance, which is at most 100 ms
(`executor.ts`, `descendantDeadline`). Under contention this can correctly
trigger termination before the supposedly finishing child actually starts.
The observed result is consistent with that race; the old log did not capture
the child's startup timestamp, so it does not prove the exact scheduling order.

The fixture now uses a real Node IPC channel. The child registers a disconnect
handler and sends `ready`, then waits for its parent's exit to disconnect IPC.
Only that disconnect handler schedules the 10 ms timer, so the descendant's
remaining work cannot finish before the leader exits. The leader records the
child PID and exits only on the ready message. Production code,
timeouts, the exit-code/trigger/no-signals assertions, and the process-group
cleanup assertion are unchanged. Both reviewed executor files matched the
qualification commit before this fixture edit.

Validation status at this commit: source and diff reviewed; `git diff --check`
passed. Execution is intentionally deferred until the root's ongoing full-suite
qualification window ends. This is not a test-pass claim or a Claude audit.
