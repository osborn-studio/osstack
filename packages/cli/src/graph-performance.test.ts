import { boundedWorkspaceFingerprint } from './graph-bounded-recovery-journal.js';
import { connect } from 'node:net';
import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { expect, it, vi } from 'vitest';
import { FrameDecoder, encodeFrame } from '@osstack/hermes-adapter';
import { LoopEngine } from '@osstack/loop';
import { GraphDelegationStatus } from '@osstack/protocol';
import { startDaemon } from './daemon.js';
import { graphRpcFixture } from './graph-test-fixture.js';
import { GraphWorkerManager } from './graph-worker-manager.js';
import { GraphCheckpointService } from './graph-checkpoint-service.js';
import { GraphActionBroker } from './graph-action-broker.js';
const stats = (samples: number[]) => {
  const sorted = [...samples].sort((a,b) => a-b);
  return { count: sorted.length, p50: sorted[Math.floor(sorted.length / 2)] ?? 0,
    p95: sorted[Math.max(0, Math.ceil(sorted.length * .95) - 1)] ?? 0, max: sorted.at(-1) ?? 0 };
};
function rpc(path: string, method: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = connect(path); const decoder = new FrameDecoder();
    const timeout = setTimeout(() => { socket.destroy(); reject(Error('RPC timeout')); }, 5000);
    socket.on('error', e => { clearTimeout(timeout); reject(e); });
    socket.on('connect', () => socket.write(encodeFrame({ id: 1, method })));
    socket.on('data', chunk => { const frame = decoder.push(chunk)[0] as { ok: boolean; result: unknown } | undefined;
      if (frame) { clearTimeout(timeout); socket.destroy(); frame.ok ? resolve(frame.result) : reject(Error('RPC failed')); } });
  });
}
it.skipIf(!process.env['OSSTACK_GRAPH_BENCH_REPORT'])('measures real graph cold/hot workers, checkpoint/broker timings and concurrent non-graph socket RPC', async () => {
  const f = await graphRpcFixture(); const oldHome = process.env['OSSTACK_HOME'];
  process.env['OSSTACK_HOME'] = join(f.root, 'perf-home');
  const samples: Record<string, number[]> = { rpc: [], startup: [], checkpoints: [], brokerIncludingEffects: [], graph: [], recoveryFingerprint: [] };
  const start = GraphWorkerManager.prototype.start;
  const checkpoint = GraphCheckpointService.prototype.execute;
  const broker = GraphActionBroker.prototype.handle;
  const startSpy = vi.spyOn(GraphWorkerManager.prototype, 'start').mockImplementation(function(this: GraphWorkerManager, input) {
    const at = performance.now(); const handle = start.call(this, input);
    void handle.ready.then(() => samples['startup']!.push(performance.now() - at), () => {}); return handle;
  });
  const checkpointSpy = vi.spyOn(GraphCheckpointService.prototype, 'execute').mockImplementation(async function(this: GraphCheckpointService, ...args) {
    const at = performance.now(); try { return await checkpoint.apply(this, args); } finally { samples['checkpoints']!.push(performance.now() - at); }
  });
  const brokerSpy = vi.spyOn(GraphActionBroker.prototype, 'handle').mockImplementation(async function(this: GraphActionBroker, ...args) {
    const at = performance.now(); try { return await broker.apply(this, args); } finally { samples['brokerIncludingEffects']!.push(performance.now() - at); }
  });
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined; let sampling = true;
  let traffic: Promise<void> | undefined;
  try {
    daemon = await startDaemon({ socketPath: join(f.root, 'rpc.sock') });
    // Warm only the non-graph socket path, then measure while real graphs run.
    await rpc(daemon.socketPath, 'version');
    traffic = (async () => { while (sampling) { const at = performance.now(); await rpc(daemon!.socketPath, 'version'); samples['rpc']!.push(performance.now()-at); await new Promise(r => setTimeout(r, 5)); } })();
    for (let index = 0; index < 2; index++) {
      const at = performance.now();
      const run = GraphDelegationStatus.parse(await f.service.handle(f.connection, 'graph.start', { ...f.request, idempotencyKey: `perf-${index}` }));
      await f.until(run.graphRunId, s => s.status === 'ready'); samples['graph']!.push(performance.now()-at);
    }
    // Exercise the synchronous final recheck at almost the supported byte limit,
    // under a real SQLite write transaction while other socket calls are queued.
    const fingerprintRoot = join(f.root, 'fingerprint'); await mkdir(fingerprintRoot);
    await writeFile(join(fingerprintRoot, 'payload'), Buffer.alloc(31 * 1024 * 1024, 42));
    for (let index = 0; index < 8; index++) {
      const at = performance.now(); f.db.transaction(() => boundedWorkspaceFingerprint(fingerprintRoot)).immediate();
      samples['recoveryFingerprint']!.push(performance.now()-at);
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    sampling = false; await traffic;
    // Real idle polling at the normal one-second interval, including state persistence.
    const loop = new LoopEngine({ workspacePath: f.root, sources: [], inputTasks: [], useWorktree: false,
      stateFilePath: join(f.root, 'LOOP-STATE.json'), markdownPath: join(f.root, 'STATE.md') });
    const at = performance.now(); const result = await loop.runCycles({ cycles: 4, intervalMs: 1000 });
    const wallMs = performance.now()-at; const loopOverheadRatio = Math.max(0, wallMs-3000)/wallMs;
    const report = { node: process.version, platform: process.platform, samples,
      timingsMs: Object.fromEntries(Object.entries(samples).map(([key, values]) => [key, stats(values)])),
      loop: { cycles: result.cycles.length, wallMs, scheduledIdleMs: 3000, overheadRatio: loopOverheadRatio },
      notes: ['broker includes external Git/adapter duration; checkpoint measures host service incl SQLite, not worker transport',
        'first graph is cold engine process; second has warm host/cache but a fresh engine process',
        'RPC samples include socket connection + framing; graph and daemon share this host event loop'] };
    if (process.env['OSSTACK_GRAPH_BENCH_REPORT']) await writeFile(process.env['OSSTACK_GRAPH_BENCH_REPORT'], JSON.stringify(report, null, 2)+'\n');
    expect(samples['rpc']!.length).toBeGreaterThan(30); expect(samples['startup']).toHaveLength(2);
    expect(samples['checkpoints']!.length).toBeGreaterThan(10);
    expect(stats(samples['rpc']!).p95).toBeLessThan(10);
    expect(loopOverheadRatio).toBeLessThan(.01);
  } finally { sampling = false; await traffic?.catch(() => {}); await daemon?.close(); await f.close();
    startSpy.mockRestore(); checkpointSpy.mockRestore(); brokerSpy.mockRestore();
    if (oldHome === undefined) delete process.env['OSSTACK_HOME']; else process.env['OSSTACK_HOME'] = oldHome; }
}, 60000);
