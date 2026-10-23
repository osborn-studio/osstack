import { expect, it } from 'vitest';
import { parseGraphCheckpointRequest, parseGraphCheckpointResponse } from './graph-checkpoint.js';
const get = { kind: 'get', threadId: 'run', namespace: '' };
it('accepts plain opaque data and rejects worker authority or unbounded messages', () => {
  expect(parseGraphCheckpointRequest(get)).toEqual(get);
  expect(() => parseGraphCheckpointRequest({ ...get, scope: { principalId: 'admin' } })).toThrow();
  expect(() => parseGraphCheckpointRequest({ kind: 'list', threadId: 'run', pageSize: 17 })).toThrow();
  expect(() => parseGraphCheckpointResponse({ kind: 'list', tuples: Array(17).fill(null) })).toThrow();
  expect(() => parseGraphCheckpointRequest({ ...get, namespace: 'x'.repeat(1025) })).toThrow();
  expect(() => parseGraphCheckpointRequest({ ...get, huge: Array(10).fill('x'.repeat(1024 * 1024)) })).toThrow('CHECKPOINT_FRAME_LIMIT');
});
it('rejects cycles, proxies and accessors before recursive validators', () => {
  const cycle: Record<string, unknown> = { ...get }; cycle['cycle'] = cycle;
  expect(() => parseGraphCheckpointRequest(cycle)).toThrow('CHECKPOINT_FRAME_LIMIT');
  expect(() => parseGraphCheckpointRequest(new Proxy(get, {}))).toThrow('CHECKPOINT_FRAME_INVALID');
  expect(() => parseGraphCheckpointRequest({ get kind() { throw new Error('executed'); } })).toThrow('CHECKPOINT_FRAME_INVALID');
});
