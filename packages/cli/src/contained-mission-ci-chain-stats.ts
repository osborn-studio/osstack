const stages = ['registered', 'pr_opened', 'failure_observed', 'repair_dispatched', 'repair_approved',
  'repair_pushed', 'ci_verified', 'merge_reserved', 'merged'] as const;
type Stage = typeof stages[number];
export type StageTimeline = Partial<Record<Stage, number | undefined>>;

/** The caller supplies at least one measured wait. */
export function waitPercentiles(waits: readonly number[]) {
  if (!waits.length) throw new RangeError('No wait samples');
  const sorted = [...waits].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return {
    median_ms: sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2,
    p95_ms: sorted[Math.ceil(sorted.length * 0.95) - 1]!,
  };
}

export function summarizeHops(timelines: readonly StageTimeline[]) {
  const samples = new Map<string, number[]>();
  let outOfOrder = 0;
  for (const timeline of timelines) {
    let previous: { stage: Stage; time: number } | undefined;
    for (const stage of stages) {
      const time = timeline[stage];
      if (time === undefined) continue;
      if (previous) {
        const wait = time - previous.time;
        if (wait < 0) outOfOrder++;
        else {
          const key = `${previous.stage}->${stage}`;
          const waits = samples.get(key);
          if (waits) waits.push(wait);
          else samples.set(key, [wait]);
        }
      }
      previous = { stage, time };
    }
  }
  const hops = [];
  for (const from of stages) {
    for (const to of stages) {
      const hop = `${from}->${to}`;
      const waits = samples.get(hop);
      if (waits) hops.push({ hop, n: waits.length, ...waitPercentiles(waits) });
    }
  }
  return { counts: 'closed chains only; wait between consecutive recorded stages (first event of each stage)',
    closed_chains: timelines.length, out_of_order: outOfOrder, hops };
}

type Chain = { mission_id: string; state: string; since: number };

export function summarizeOpenWaits(chains: readonly Chain[], nowMs: number) {
  const waitsByState = new Map<string, number[]>();
  const rows = [];
  let clockSkew = 0;
  for (const { mission_id, state, since } of chains) {
    if (state === 'closed' || state === 'stopped') continue;
    const wait_ms = nowMs - since;
    if (wait_ms < 0) { clockSkew++; continue; }
    rows.push({ mission_id, state, since, wait_ms });
    const waits = waitsByState.get(state);
    if (waits) waits.push(wait_ms);
    else waitsByState.set(state, [wait_ms]);
  }
  rows.sort((a, b) => b.wait_ms - a.wait_ms || (a.mission_id < b.mission_id ? -1 : a.mission_id > b.mission_id ? 1 : 0));
  const by_state = [...waitsByState.keys()].sort().map(state => {
    const waits = waitsByState.get(state)!;
    return { state, n: waits.length, median_ms: waitPercentiles(waits).median_ms,
      max_ms: waits.reduce((max, wait) => Math.max(max, wait)) };
  });
  return { counts: 'open chains (not closed, not stopped); now minus the start of the current state',
    as_of_ms: nowMs, open_chains: rows.length + clockSkew, clock_skew: clockSkew, by_state, longest: rows.slice(0, 10) };
}
