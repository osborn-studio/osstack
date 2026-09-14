import type { AgentAdapter } from "@osstack/agents";

/** Abort requests stop; iterator closure does not prove it. Bound waiting for a
 * non-cooperating producer without losing observation of its eventual errors. */
export async function* boundedAdapterEvents<T>(events: AsyncIterable<T>, signal: AbortSignal): AsyncGenerator<T> {
  const iterator = events[Symbol.asyncIterator]();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancellationError: Error | undefined;
  let waiting: ((error: Error) => void) | undefined;
  const onAbort = (): void => {
    timer ??= setTimeout(() => {
      cancellationError = new Error("adapter cancellation grace elapsed");
      waiting?.(cancellationError);
    }, 1_000);
  };
  const nextEvent = (): Promise<IteratorResult<T>> => new Promise((resolve, reject) => {
    if (cancellationError) { reject(cancellationError); return; }
    waiting = reject;
    Promise.resolve().then(() => iterator.next()).then(
      value => { waiting = undefined; resolve(value); },
      error => { waiting = undefined; reject(error); },
    );
  });
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  let exhausted = false;
  try {
    while (true) {
      const next = await nextEvent();
      if (next.done) { exhausted = true; return; }
      yield next.value;
    }
  } finally {
    waiting = undefined;
    signal.removeEventListener("abort", onAbort);
    if (timer) clearTimeout(timer);
    if (!exhausted) void Promise.resolve().then(() => iterator.return?.()).catch(() => {});
  }
}

/** Only a trusted adapter's exact invocation receipt may resolve uncertainty. */
export async function confirmAdapterStopped(adapter: AgentAdapter, runId: string): Promise<boolean> {
  if (!adapter.confirmStopped) return false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const proof = await Promise.race([
      Promise.resolve().then(() => adapter.confirmStopped!(runId)),
      new Promise<undefined>(resolve => { timer = setTimeout(() => resolve(undefined), 1_000); }),
    ]);
    return proof?.stopped === true && typeof proof.evidence === "string" && proof.evidence.trim().length > 0;
  } catch { return false; }
  finally { if (timer) clearTimeout(timer); }
}
