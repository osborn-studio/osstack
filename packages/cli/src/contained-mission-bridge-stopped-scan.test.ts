import { afterEach, describe, expect, it, vi } from 'vitest';
import { scanStoppedChains, type RevisionChainStore, type StoppedPrFacts } from '@osstack/core';
import { setup, T0 } from './contained-mission-revision.testkit.js';
import { StoppedChainScanService } from './contained-mission-bridge-stopped-scan.js';
import { createStoppedChainScan } from './contained-mission-rpc.js';

const facts: StoppedPrFacts = { pr_state: 'CLOSED', head: 'a'.repeat(40), head_repository: 'o/r', head_ref: 'topic', base_sha: 'b'.repeat(40), base_ref: 'main', complete: true };
const row = (id: string, time = 1) => ({ chain_id: id, updated_at: time, repository: 'o/r', pr_number: 7, current_mission_id: `cm_${id}` });
function fixture(enabled = true) {
  const rows = [row('one'), row('two', 2), row('three', 3)];
  const reads: string[] = []; const cancelled: string[] = []; const events: Array<{ id: string; kind: string; payload: unknown }> = []; const logs: string[] = [];
  let failRead: string | undefined; let failCancel = false; let pending: Promise<void> | undefined; let now = 0;
  const store = {
    listStoppedLive: (limit: number, after?: { updated_at: number; chain_id: string }) => rows.filter(r => !after || r.updated_at > after.updated_at).slice(0, limit),
    listClosedPrLive: () => [],
    get: (id: string) => ({ ...rows.find(r => r.chain_id === id)!, revision: 1, state: 'awaiting_decision', mode: 'live', published_head: facts.head, published_base: facts.base_sha, base_ref: 'main', rounds_used: 0, review_deadline: null }),
    events: () => [], appendEvent: (id: string, kind: string, payload: unknown) => { events.push({ id, kind, payload }); },
    reservations: () => [], applyDecision: () => undefined,
  } as unknown as RevisionChainStore;
  const service = new StoppedChainScanService({ chains: store, enabled: () => enabled, now: () => now,
    missionState: () => 'awaiting_decision', refreshPrincipal: () => { throw Error('permission_denied'); },
    readPr: async chain => { reads.push(chain.chain_id); if (failRead) throw Error(failRead); if (pending) await pending; return facts; },
    cancelChild: async (_principal, id) => { if (failCancel) throw Error('cancel_denied:detail'); cancelled.push(id); },
    log: line => { logs.push(line); }, batchLimit: 1, intervalMs: 600_000, initialDelayMs: 600_000 });
  return { service, reads, cancelled, events, logs, setReadFailure: (v: boolean | string) => { failRead = v === true ? 'read_failed' : v || undefined; }, setCancelFailure: (v: boolean) => { failCancel = v; }, setPending: (v: Promise<void> | undefined) => { pending = v; }, advance: () => { now += 600_000; } };
}
afterEach(() => { vi.useRealTimers(); });
describe('StoppedChainScanService', () => {
  it('stops promptly when a reader ignores cancellation and never settles', async () => {
    const f = fixture();
    f.setPending(new Promise(() => {}));
    const scan = f.service.scan();
    await new Promise(resolve => setImmediate(resolve));
    expect(f.reads).toEqual(['one']);
    await f.service.stop();
    await scan;
    expect(f.events).toEqual([]);
    expect(f.cancelled).toEqual([]);
  });
  it('wires the live scan to the chain store, mission state, refreshed access, and both host cancel paths', async () => {
    const f = setup(); await f.dispatch();
    const child = f.children()[0]!;
    const chain = f.rig.chains.get(f.chain.chain_id);
    f.rig.chains.stopLive(chain.chain_id, chain.revision, 'child_halted', T0 + 1);
    const chainGet = vi.spyOn(f.rig.chains, 'get');
    const missionGet = vi.spyOn(f.rig.missions, 'get');
    const refresh = vi.fn(() => f.principal);
    const cancel = vi.fn(async () => { throw Error('permission_denied'); });
    const cancelFromBridge = vi.fn(async (id: string) => f.rig.missions.get(id));
    const service = await createStoppedChainScan({ chains: f.rig.chains, missions: f.rig.missions,
      access: { refresh }, host: { cancel, cancelFromBridge }, enabled: () => true, now: () => T0 + 2,
      transport: async () => ({ data: { repository: { pullRequest: { state: 'CLOSED', headRepository: { nameWithOwner: 'o/r' },
        headRefName: f.chain.branch, headRefOid: f.chain.published_head, baseRefName: 'main', baseRefOid: f.chain.published_base, url: 'https://example.invalid/pr/7' } } } }),
      log: () => undefined });
    await service.scan();
    expect(chainGet).toHaveBeenCalledWith(chain.chain_id);
    expect(missionGet).toHaveBeenCalledWith(child);
    expect(refresh).toHaveBeenCalledWith('human', 'cli');
    expect(cancel).toHaveBeenCalledWith(f.principal, child);
    expect(cancelFromBridge).toHaveBeenCalledWith(child);
    expect(f.rig.chains.get(chain.chain_id).state).toBe('closed');
    expect(f.rig.chains.events(chain.chain_id).some(e => e.kind === 'child_cancel_requested')).toBe(true);
  });
  it('skips a missing child in the closed sweep and stopped scan while both cursors advance', async () => {
    const closed = [row('closed_bad', 1), row('closed_good', 2)];
    const stopped = [row('stopped_bad', 1), row('stopped_good', 2)];
    const cancelled: string[] = []; const logs: string[] = [];
    const chain = (r: ReturnType<typeof row>) => ({ ...r, revision: 1, state: 'awaiting_decision', mode: 'live',
      published_head: facts.head, published_base: facts.base_sha, base_ref: 'main', rounds_used: 0, review_deadline: null, grant_json: '{}' });
    const after = (rows: ReturnType<typeof row>[], cursor?: { updated_at: number; chain_id: string }) =>
      rows.filter(r => !cursor || r.updated_at > cursor.updated_at).map(chain).slice(0, 1);
    const store = { listClosedPrLive: (_limit: number, cursor?: { updated_at: number; chain_id: string }) => after(closed, cursor),
      listStoppedLive: (_limit: number, cursor?: { updated_at: number; chain_id: string }) => after(stopped, cursor),
      get: (id: string) => { if (id === 'stopped_bad') throw Error('not_found:private'); return chain(stopped.find(r => r.chain_id === id)!); },
      events: () => [], reservations: () => [],
      appendEvent: () => undefined, applyDecision: () => undefined } as unknown as RevisionChainStore;
    const service = new StoppedChainScanService({ chains: store, enabled: () => true, now: () => 1, batchLimit: 1,
      missionState: id => { if (id.endsWith('_bad')) throw Error('not_found:private'); return 'awaiting_decision'; },
      refreshPrincipal: () => { throw Error('permission_denied'); }, readPr: async () => facts,
      cancelChild: async (_principal, id) => { cancelled.push(id); }, log: line => { logs.push(line); } });
    await service.scan(); await service.scan();
    expect(cancelled).toEqual(['cm_closed_good', 'cm_stopped_good']);
    expect(logs).toContain('osstack: bridge stopped scan: chain_failed chain=closed_bad reason=not_found');
    expect(logs).toContain('osstack: bridge stopped scan: chain_failed chain=stopped_bad reason=not_found');
    expect(logs.some(line => line.includes('scan_failed'))).toBe(false);
  });
  it('closes a real stopped live chain, voids its reservation, and requests its child cancellation', async () => {
    const f = setup();
    const dispatched = await f.dispatch();
    expect(dispatched.status).toBe('dispatched');
    const child = f.children()[0]!;
    const chain = f.rig.chains.get(f.chain.chain_id);
    f.rig.chains.stopLive(chain.chain_id, chain.revision, 'child_halted', T0 + 1);
    const cancelled: string[] = []; const principals: string[] = [];
    const service = new StoppedChainScanService({ chains: f.rig.chains, enabled: () => true, now: () => T0 + 2,
      missionState: id => f.rig.missions.get(id).state, refreshPrincipal: () => f.principal,
      readPr: async () => ({ ...facts, head: f.chain.published_head, base_sha: f.chain.published_base, head_ref: f.chain.branch }),
      cancelChild: async (principal, id) => { principals.push(principal?.principal_id ?? 'daemon'); cancelled.push(id); }, log: () => undefined });
    await service.scan();
    expect(f.rig.chains.get(chain.chain_id).state).toBe('closed');
    expect(f.reservations().map(r => r.state)).toEqual(['void']);
    expect(cancelled).toEqual([child]);
    expect(principals).toEqual(['human']);
    expect(f.rig.chains.events(chain.chain_id).some(e => e.kind === 'child_cancel_requested' && JSON.parse(e.payload_json).principal === 'human')).toBe(true);
  });
  it('requests cancellation for a closed scan entry', async () => {
    const f = fixture(); await f.service.scan();
    expect(f.cancelled).toEqual(['cm_one']);
  });
  it('records child_cancel_failed when cancellation fails', async () => {
    const f = fixture(); f.setCancelFailure(true); await f.service.scan();
    expect(f.events).toContainEqual({ id: 'one', kind: 'child_cancel_failed', payload: { child: 'cm_one', code: 'cancel_denied', principal: 'daemon' } });
  });
  it('does not write on read failure and retries on the next tick', async () => {
    const f = fixture(); f.setReadFailure(true); await f.service.scan(); expect(f.events).toEqual([]); expect(f.cancelled).toEqual([]);
    f.setReadFailure(false); f.advance(); await f.service.scan(); expect(f.reads).toEqual(['one', 'two']);
    expect(f.logs).toContain('osstack: bridge stopped scan: read_failed chain=one reason=read_failed count=1');
  });
  it('carries the cursor across ticks and wraps after the end', async () => {
    const f = fixture(); for (let i = 0; i < 5; i++) { await f.service.scan(); f.advance(); }
    expect(f.reads).toEqual(['one', 'two', 'three', 'one']);
  });
  it('backs off only the rate-limited chain without writing', async () => {
    const f = fixture(); f.setReadFailure('HTTP 503'); await f.service.scan();
    f.setReadFailure(false); await f.service.scan(); expect(f.reads).toEqual(['one', 'two']);
    f.advance(); await f.service.scan(); expect(f.reads).toEqual(['one', 'two', 'three']);
  });
  it('does not overlap ticks', async () => {
    const f = fixture(); let release!: () => void; f.setPending(new Promise<void>(r => { release = r; }));
    const first = f.service.scan(); const second = f.service.scan(); await vi.waitFor(() => expect(f.reads).toEqual(['one'])); release(); await Promise.all([first, second]);
    expect(f.reads).toEqual(['one']);
  });
  it('uses the daemon cancel path only after the grant principal loses stop permission', async () => {
    const f = setup(); await f.dispatch();
    const chain = f.rig.chains.get(f.chain.chain_id);
    f.rig.chains.stopLive(chain.chain_id, chain.revision, 'child_halted', T0 + 1);
    const principals: string[] = [];
    const service = new StoppedChainScanService({ chains: f.rig.chains, enabled: () => true, now: () => T0 + 2,
      missionState: id => f.rig.missions.get(id).state,
      refreshPrincipal: () => ({ ...f.principal, write_scopes: [], stop_scopes: [] }),
      readPr: async () => ({ ...facts, head: f.chain.published_head, base_sha: f.chain.published_base, head_ref: f.chain.branch }),
      cancelChild: async principal => { principals.push(principal?.principal_id ?? 'daemon'); }, log: () => undefined });
    await service.scan();
    expect(principals).toEqual(['daemon']);
    expect(f.rig.chains.events(chain.chain_id).some(e => e.kind === 'child_cancel_requested' && JSON.parse(e.payload_json).principal === 'daemon')).toBe(true);
  });
  it('falls back to daemon when host rejects the refreshed principal permission', async () => {
    const f = setup(); await f.dispatch();
    const chain = f.rig.chains.get(f.chain.chain_id);
    f.rig.chains.stopLive(chain.chain_id, chain.revision, 'child_halted', T0 + 1);
    const principals: string[] = [];
    const service = new StoppedChainScanService({ chains: f.rig.chains, enabled: () => true, now: () => T0 + 2,
      missionState: id => f.rig.missions.get(id).state, refreshPrincipal: () => f.principal,
      readPr: async () => ({ ...facts, head: f.chain.published_head, base_sha: f.chain.published_base, head_ref: f.chain.branch }),
      cancelChild: async principal => { principals.push(principal?.principal_id ?? 'daemon'); if (principal) throw Error('permission_denied'); },
      log: () => undefined });
    await service.scan();
    expect(principals).toEqual(['human', 'daemon']);
    expect(f.rig.chains.events(chain.chain_id).some(e => e.kind === 'child_cancel_requested' && JSON.parse(e.payload_json).principal === 'daemon')).toBe(true);
  });
  it('keeps scanning past a permanently unreadable PR and beyond the first batch window', async () => {
    const rows = Array.from({ length: 13 }, (_, i) => ({ ...row(`chain${i + 1}`, i + 1), state: 'awaiting_decision', stop_reason: 'child_halted' }));
    const reads: string[] = []; const cancelled: string[] = []; const logs: string[] = [];
    let now = 0;
    const store = {
      listStoppedLive: (limit: number, after?: { updated_at: number; chain_id: string }) => rows.filter(r => r.state === 'awaiting_decision' && (!after || r.updated_at > after.updated_at)).slice(0, limit),
      listClosedPrLive: () => [],
      get: (id: string) => ({ ...rows.find(r => r.chain_id === id)!, revision: 1, mode: 'live', published_head: facts.head, published_base: facts.base_sha, base_ref: 'main', rounds_used: 0, review_deadline: null, grant_json: '{}' }),
      events: () => [], appendEvent: () => undefined, reservations: () => [],
      applyDecision: (id: string) => { const found = rows.find(r => r.chain_id === id)!; found.state = 'closed'; found.stop_reason = 'pr_closed'; },
    } as unknown as RevisionChainStore;
    const service = new StoppedChainScanService({ chains: store, enabled: () => true, now: () => now, batchLimit: 3,
      missionState: () => 'awaiting_decision', refreshPrincipal: () => { throw Error('permission_denied'); },
      readPr: async chain => { reads.push(chain.chain_id); if (chain.chain_id === 'chain1') throw Error('PR_MISSING:private'); return facts; },
      cancelChild: async (_principal, id) => { cancelled.push(id); }, log: line => { logs.push(line); } });
    for (let i = 0; i < 9; i++) { await service.scan(); now += 600_000; }
    expect(rows.filter(r => r.state === 'closed')).toHaveLength(12);
    expect(cancelled).toHaveLength(12);
    expect(reads.filter(id => id === 'chain1').length).toBeGreaterThan(1);
    expect(reads).toContain('chain13');
    expect(logs.some(line => line.includes('reason=PR_MISSING count='))).toBe(true);
  });
  it('retries a failed cancellation on the next tick', async () => {
    const f = setup(); await f.dispatch();
    const chain = f.rig.chains.get(f.chain.chain_id);
    f.rig.chains.stopLive(chain.chain_id, chain.revision, 'child_halted', T0 + 1);
    let attempts = 0;
    const service = new StoppedChainScanService({ chains: f.rig.chains, enabled: () => true, now: () => T0 + 2,
      missionState: id => f.rig.missions.get(id).state, refreshPrincipal: () => f.principal,
      readPr: async () => ({ ...facts, head: f.chain.published_head, base_sha: f.chain.published_base, head_ref: f.chain.branch }),
      cancelChild: async () => { attempts++; if (attempts === 1) throw Error('cancel_denied:private'); }, log: () => undefined });
    await service.scan(); expect(f.rig.chains.get(chain.chain_id)).toMatchObject({ state: 'closed', stop_reason: 'pr_closed' }); expect(f.rig.chains.listClosedPrLive()).toHaveLength(1); await service.scan();
    expect(attempts).toBe(2);
    expect(f.rig.chains.events(chain.chain_id).filter(e => e.kind === 'child_cancel_failed')).toHaveLength(1);
  });
  it('recovers a crash after close and before cancel on a new instance', async () => {
    const f = setup(); await f.dispatch();
    const chain = f.rig.chains.get(f.chain.chain_id);
    f.rig.chains.stopLive(chain.chain_id, chain.revision, 'child_halted', T0 + 1);
    await scanStoppedChains({ store: f.rig.chains, now: T0 + 2, limit: 1,
      readPr: async () => ({ ...facts, head: f.chain.published_head, base_sha: f.chain.published_base, head_ref: f.chain.branch }) });
    expect(f.rig.chains.listClosedPrLive()).toHaveLength(1);
    const cancelled: string[] = [];
    const restarted = new StoppedChainScanService({ chains: f.rig.chains, enabled: () => true, now: () => T0 + 3,
      missionState: id => f.rig.missions.get(id).state, refreshPrincipal: () => f.principal,
      readPr: async () => { throw Error('unexpected_read'); },
      cancelChild: async (_principal, id) => { cancelled.push(id); }, log: () => undefined });
    await restarted.scan();
    expect(cancelled).toEqual(f.children());
  });
  it('stops mid-batch without later writes and a new instance requests the outstanding cancel', async () => {
    const rows = [row('first', 1), row('second', 2)].map(r => ({ ...r, state: 'awaiting_decision', stop_reason: 'child_halted' }));
    const events: string[] = []; const cancelled: string[] = [];
    let blocked!: () => void;
    const blockedRead = new Promise<void>(resolve => { blocked = resolve; });
    const store = {
      listStoppedLive: (limit: number, after?: { updated_at: number; chain_id: string }) => rows.filter(r => r.state === 'awaiting_decision' && (!after || r.updated_at > after.updated_at)).slice(0, limit),
      listClosedPrLive: (limit: number) => rows.filter(r => r.state === 'closed').slice(0, limit),
      get: (id: string) => ({ ...rows.find(r => r.chain_id === id)!, revision: 1, mode: 'live', published_head: facts.head, published_base: facts.base_sha, base_ref: 'main', rounds_used: 0, review_deadline: null, grant_json: '{}' }),
      events: () => [], appendEvent: (_id: string, kind: string) => { events.push(kind); }, reservations: () => [],
      applyDecision: (id: string) => { const found = rows.find(r => r.chain_id === id)!; found.state = 'closed'; found.stop_reason = 'pr_closed'; },
    } as unknown as RevisionChainStore;
    const options = { chains: store, enabled: () => true, now: () => 1, batchLimit: 2,
      missionState: () => 'awaiting_decision', refreshPrincipal: () => { throw Error('permission_denied'); }, log: () => undefined };
    const first = new StoppedChainScanService({ ...options,
      readPr: async (chain, signal) => {
        if (chain.chain_id === 'first') return facts;
        await Promise.race([blockedRead, new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(Error('scan_stopped')), { once: true }))]);
        return facts;
      },
      cancelChild: async () => { throw Error('cancel_denied'); } });
    const tick = first.scan();
    await vi.waitFor(() => expect(rows[0]!.state).toBe('closed'));
    await vi.waitFor(() => expect(events).toContain('child_cancel_failed'));
    await first.stop(); await tick;
    const written = events.length;
    blocked();
    await Promise.resolve();
    expect(events).toHaveLength(written);
    expect(rows[1]!.state).toBe('awaiting_decision');
    const restarted = new StoppedChainScanService({ ...options, readPr: async () => facts,
      cancelChild: async (_principal, id) => { cancelled.push(id); } });
    await restarted.scan();
    expect(cancelled).toContain('cm_first');
  });
  it('logs a sanitized reason when the scan itself fails', async () => {
    const logs: string[] = [];
    const store = { listClosedPrLive: () => { throw Error('STORE_DOWN:private detail'); } } as unknown as RevisionChainStore;
    const service = new StoppedChainScanService({ chains: store, enabled: () => true, now: () => 1,
      missionState: () => 'awaiting_decision', refreshPrincipal: () => { throw Error('permission_denied'); },
      readPr: async () => facts, cancelChild: async () => undefined, log: line => { logs.push(line); } });
    await service.scan();
    expect(logs).toEqual(['osstack: bridge stopped scan: scan_failed reason=STORE_DOWN']);
  });
  it('schedules nothing when bridge live mode is disabled', async () => {
    vi.useFakeTimers(); const f = fixture(false); f.service.start(); await vi.advanceTimersByTimeAsync(1_200_000); expect(f.reads).toEqual([]); await f.service.stop();
  });
  it('clears the timer on stop', async () => {
    vi.useFakeTimers(); const f = fixture(); f.service.start(); await f.service.stop(); await vi.advanceTimersByTimeAsync(1_200_000); expect(f.reads).toEqual([]);
  });
});
