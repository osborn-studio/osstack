// In-memory per-method RPC latency recorder for the daemon (Performance
// Hints plan, P1.5). Feeds the `rpc` section of `osstack stats` so bulk-API
// work (P2) can target the actual p95 offenders instead of guesses.
//
// Design follows the Hints stats advice: the record path is O(1) and
// allocation-free after warm-up (a preallocated Float64Array ring per
// method), and all expensive work — sorting for percentiles — is deferred
// to snapshot(), which only runs when someone asks for stats. Memory is
// bounded on both axes: at most RING_CAPACITY samples per method, and at
// most MAX_METHODS distinct method windows. Method names arrive from
// client frames (unknown methods are served an error and still measured),
// so once the cap is hit, further new names fold into the OVERFLOW_METHOD
// bucket instead of growing the map.

const RING_CAPACITY = 512;
const MAX_METHODS = 64;
export const OVERFLOW_METHOD = "(other)";

interface MethodWindow {
  samples: Float64Array;
  /** Next write slot; samples[count % capacity] semantics via `filled`. */
  cursor: number;
  /** True once the ring has wrapped at least once. */
  filled: boolean;
  /** Lifetime observation count (not capped by the ring). */
  total: number;
  maxMs: number;
}

export interface RpcMethodLatency {
  method: string;
  /** Lifetime request count for this method. */
  count: number;
  /** Percentiles over the most recent window (≤512 samples). */
  window: number;
  p50_ms: number;
  p95_ms: number;
  max_ms: number;
}

export class RpcLatencyRecorder {
  private readonly windows = new Map<string, MethodWindow>();

  record(method: string, durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    let w = this.windows.get(method);
    if (w === undefined && this.windows.size >= MAX_METHODS) {
      method = OVERFLOW_METHOD;
      w = this.windows.get(method);
    }
    if (w === undefined) {
      w = {
        samples: new Float64Array(RING_CAPACITY),
        cursor: 0,
        filled: false,
        total: 0,
        maxMs: 0,
      };
      this.windows.set(method, w);
    }
    w.samples[w.cursor] = durationMs;
    w.cursor += 1;
    if (w.cursor === RING_CAPACITY) {
      w.cursor = 0;
      w.filled = true;
    }
    w.total += 1;
    if (durationMs > w.maxMs) w.maxMs = durationMs;
  }

  /** Sorted by descending p95 so the top offender reads first. */
  snapshot(): RpcMethodLatency[] {
    const out: RpcMethodLatency[] = [];
    for (const [method, w] of this.windows) {
      const size = w.filled ? RING_CAPACITY : w.cursor;
      if (size === 0) continue;
      const window = Array.from(w.samples.subarray(0, size)).sort((a, b) => a - b);
      out.push({
        method,
        count: w.total,
        window: size,
        p50_ms: percentile(window, 0.5),
        p95_ms: percentile(window, 0.95),
        max_ms: w.maxMs,
      });
    }
    out.sort((a, b) => b.p95_ms - a.p95_ms);
    return out;
  }
}

/** Nearest-rank percentile over an ascending-sorted array. */
function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[rank]!;
}
