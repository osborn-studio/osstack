import { MemorySaver } from '@langchain/langgraph-checkpoint';
import { expect, it } from 'vitest';
import { entrypoint, task } from './worker-entry.js';

it('does not treat settled task promises as proof that a failed sibling stopped physical work', async () => {
  let started!: () => void; let release!: () => void; let finished!: () => void;
  const slowStarted = new Promise<void>(resolve => { started = resolve; });
  const allowFinish = new Promise<void>(resolve => { release = resolve; });
  const slowFinished = new Promise<void>(resolve => { finished = resolve; });
  let physicalWorkFinished = false;
  let fail = true; let slowCalls = 0;
  const events: string[] = [];
  let settlements: PromiseSettledResult<unknown>[] | undefined;
  const slow = task({ name: 'stop-proof.slow', retry: { maxAttempts: 1 } }, async () => {
    slowCalls++; events.push('slow-started'); started(); await allowFinish;
    physicalWorkFinished = true; events.push('slow-finished'); finished(); return 'physical-result';
  });
  const failure = task({ name: 'stop-proof.failure', retry: { maxAttempts: 1 } }, async () => {
    await slowStarted;
    if (fail) throw new Error('injected branch failure');
    return 'recovered';
  });
  const saver = new MemorySaver();
  const workflow = entrypoint({ name: 'stop-proof', checkpointer: saver }, async () => {
    settlements = await Promise.allSettled([slow(), failure()]);
    const rejected = settlements.find(result => result.status === 'rejected');
    if (rejected?.status === 'rejected') throw rejected.reason;
    return 'ready';
  });
  const config = { configurable: { thread_id: 'physical-stop-proof' }, durability: 'sync' as const };
  try {
    await expect(workflow.invoke({}, config)).rejects.toThrow();
    events.push('invoke-rejected');
    expect(settlements?.map(result => result.status)).toEqual(['rejected', 'rejected']);
    expect(physicalWorkFinished).toBe(false);
    const checkpoint = await saver.getTuple(config);
    expect(checkpoint?.pendingWrites?.some(([, channel]) => channel === '__error__')).toBe(true);
    expect(checkpoint?.pendingWrites?.some(([, channel]) => channel === '__return__')).toBe(false);
  } finally { release(); await slowFinished; }
  expect(physicalWorkFinished).toBe(true);
  expect(events).toEqual(['slow-started', 'invoke-rejected', 'slow-finished']);
  fail = false;
  await expect(workflow.invoke(null, config)).resolves.toBe('ready');
  expect(slowCalls).toBe(2);
});

it('replays orchestration through the public worker entry without repeating completed tasks', async () => {
  const calls = { left: 0, right: 0, join: 0 };
  let fail = true;
  const left = task('proof.left', () => { calls.left++; return { value: 20 }; });
  const right = task({ name: 'proof.right', retry: { maxAttempts: 1 } }, () => {
    calls.right++;
    if (fail) throw new Error('injected branch failure');
    return { value: 22 };
  });
  const join = task('proof.join', (values: { value: number }[]) => {
    calls.join++;
    expect(values).toEqual([{ value: 20 }, { value: 22 }]);
    return values.reduce((sum, item) => sum + item.value, 0);
  });
  const workflow = entrypoint({ name: 'proof', checkpointer: new MemorySaver() }, async (_input: { goal: string }) => {
    // Call order is part of the persisted program identity, not completion order.
    return join(await Promise.all([left(), right()]));
  });
  const config = { configurable: { thread_id: 'functional-proof' }, durability: 'sync' as const };
  await expect(workflow.invoke({ goal: 'sum' }, config)).rejects.toThrow('injected branch failure');
  expect(calls.join).toBe(0);
  fail = false;
  expect(await workflow.invoke(null, config)).toBe(42);
  expect(calls).toEqual({ left: 1, right: 2, join: 1 });
  expect(await workflow.invoke(null, config)).toBe(42);
  expect(calls).toEqual({ left: 1, right: 2, join: 1 });
});

// Negative controls: the upstream replay cache does not authenticate a program.
// OSStack must reject these changes before invoking an existing checkpoint.
it.each(['changed-argument', 'reordered-calls'] as const)(
  'characterizes the replay hazard when the program identity gate is bypassed: %s',
  async (scenario) => {
    const saver = new MemorySaver();
    const calls = { left: 0, right: 0, join: 0 };
    const left = task('identity.left', (value: number) => { calls.left++; return value; });
    const right = task('identity.right', (value: number) => { calls.right++; return value; });
    const join = task('identity.join', (values: number[]) => {
      calls.join++;
      return values.reduce((sum, value) => sum + value, 0);
    });
    const build = (changed: boolean) => entrypoint(
      { name: 'identity', checkpointer: saver },
      async (_input: Record<string, never>) => {
        const values = await Promise.all(changed && scenario === 'reordered-calls'
          ? [right(22), left(20)] : [left(20), right(22)]);
        const result = await join(changed && scenario === 'changed-argument' ? [100, 200] : values);
        // Leave task RETURNs durable but the entrypoint itself unfinished.
        if (!changed) throw new Error('injected entrypoint error');
        return result;
      },
    );
    const config = { configurable: { thread_id: scenario }, durability: 'sync' as const };
    await expect(build(false).invoke({}, config)).rejects.toThrow('injected entrypoint error');
    const before = await saver.getTuple(config);
    expect(before?.pendingWrites?.some(([, channel, value]) => channel === '__return__' && value === 42)).toBe(true);
    expect(calls).toEqual({ left: 1, right: 1, join: 1 });
    // Changed arguments reuse the old result; changed order re-enters completed tasks.
    expect(await build(true).invoke(null, config)).toBe(42);
    expect(calls).toEqual(scenario === 'changed-argument'
      ? { left: 1, right: 1, join: 1 } : { left: 2, right: 2, join: 1 });
  },
);
