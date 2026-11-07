interface ReadSchedule {
  now: () => number;
  gapMs: number;
  signal: AbortSignal;
}
interface ChainReadState {
  busy: boolean;
  lastAttempt: number;
  due: number;
  failures: number;
  failureVersion: number;
}

/**
 * One daemon-owned instance coordinates live cycles and D7 reads. Busy leases are never evicted.
 * At capacity, new chains are skipped until idle entries expire. This bounds memory without
 * permitting overlapping reads or forgetting backoff; a hung transport keeps its slot.
 */
export class BridgeReadLimiter {
  private readonly states = new Map<string, ChainReadState>();
  constructor(private readonly capacity = 1024) {
    if (!Number.isInteger(capacity) || capacity < 1) throw Error('invalid_bridge_read_capacity');
  }

  fail(chainId: string, now: number, gapMs: number): void {
    const state = this.states.get(chainId);
    if (!state) return;
    state.failureVersion++;
    state.failures = Math.min(7, state.failures + 1);
    state.due = now + Math.min(3_600_000, gapMs * 2 ** (state.failures - 1));
  }

  async run<T>(chainId: string, schedule: ReadSchedule, operation: () => Promise<T>): Promise<T | undefined> {
    const { now, gapMs, signal } = schedule;
    if (!Number.isFinite(gapMs) || gapMs <= 0) throw Error('invalid_bridge_read_gap');
    if (signal.aborted) throw Error('bridge_read_aborted');
    const time = now();
    let state = this.states.get(chainId);
    if (state && (state.busy || time < state.due || time - state.lastAttempt < gapMs)) return undefined;
    if (!state) {
      // Expire only idle entries whose maximum supported cadence has elapsed. At capacity, fail closed.
      for (const [id, entry] of this.states) {
        if (!entry.busy && time >= entry.due && time - entry.lastAttempt >= 3_600_000) this.states.delete(id);
      }
      if (this.states.size >= this.capacity) return undefined;
      state = { busy: false, lastAttempt: time, due: 0, failures: 0, failureVersion: 0 };
      this.states.set(chainId, state);
    }
    state.busy = true;
    state.lastAttempt = time;
    state.due = time + gapMs;
    const lease = state;
    const failureVersion = lease.failureVersion;
    // Invoke synchronously so cancellation after acquisition cannot skip the owned operation.
    let result: Promise<T>;
    try { result = Promise.resolve(operation()); } catch (error) { result = Promise.reject(error); }
    const work = result.then(value => {
      if (!signal.aborted && lease.failureVersion === failureVersion) lease.failures = 0;
      return value;
    }, error => {
      if (!signal.aborted) this.fail(chainId, now(), gapMs);
      throw error;
    }).finally(() => {
      lease.busy = false;
      lease.due = Math.max(lease.due, now() + gapMs);
    });
    return new Promise<T>((resolve, reject) => {
      const abort = () => reject(Error('bridge_read_aborted'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
      work.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }
}
