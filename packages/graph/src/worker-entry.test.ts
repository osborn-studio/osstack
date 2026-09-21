import { expect, it } from 'vitest';
import { Annotation, END, START, StateGraph } from './worker-entry.js';

it('executes a tiny StateGraph through the worker kernel boundary', async () => {
  const state = Annotation.Root({ value: Annotation<number>() });
  const graph = new StateGraph(state)
    .addNode('increment', ({ value }) => ({ value: value + 1 }))
    .addEdge(START, 'increment')
    .addEdge('increment', END)
    .compile();

  expect(await graph.invoke({ value: 41 })).toEqual({ value: 42 });
});

import { PassThrough } from 'node:stream';
import { GraphWorkerClient } from './worker-client.js';
import { WorkerFramedTransport, type GraphWorkerBinding } from '@osstack/protocol';
const binding: GraphWorkerBinding = { scope: { schemaVersion: 1, tenantId: 't', principalId: 'p', workspaceId: 'w' }, graphRunId: 'run', generation: 1, owner: 'owner', identity: { executionModel: 'langgraph-functional-v1', durability: 'sync', engineVersion: '1.4.15', checkpointVersion: '1.1.5', templateVersion: '1', registryVersion: '1', compilerVersion: '1', schemaVersion: '1', compiledProgramDigest: 'a'.repeat(64), specHash: 'b'.repeat(64), inputDigest: 'c'.repeat(64) } };
it('bounds outstanding client RPCs and rejects old responses after cancellation', async () => {
  const input = new PassThrough(); const output = new PassThrough(); const abort = new AbortController();
  let client!: GraphWorkerClient;
  const transport = new WorkerFramedTransport(input, output, value => client.receive(value), error => client.close(error));
  client = new GraphWorkerClient(binding, transport, abort.signal, 1, 1000);
  const first = client.checkpoint({ kind: 'get', threadId: 'run', namespace: '' });
  await expect(client.checkpoint({ kind: 'get', threadId: 'run', namespace: '' })).rejects.toThrow('WORKER_BACKPRESSURE');
  expect(client.outstanding).toBe(1); abort.abort(); await expect(first).rejects.toThrow('CANCELLED');
  expect(client.outstanding).toBe(0); await expect(client.checkpoint({ kind: 'get', threadId: 'run', namespace: '' })).rejects.toThrow('CANCELLED'); transport.close();
});
it.each(['graphRunId', 'generation', 'owner', 'identity', 'scope'])('rejects response with wrong %s', async key => {
  const input = new PassThrough(); const output = new PassThrough();
  const transport = new WorkerFramedTransport(input, output, () => {}, () => {});
  const client = new GraphWorkerClient(binding, transport, new AbortController().signal, 1, 1000);
  const promise = client.checkpoint({ kind: 'get', threadId: 'run', namespace: '' });
  const changed = { ...binding, [key]: key === 'generation' ? 2 : key === 'identity' ? { ...binding.identity, compilerVersion: '2' } : key === 'scope' ? { ...binding.scope, tenantId: 'other' } : 'other' };
  expect(() => client.receive({ kind: 'response', binding: changed, id: '1', ok: true, payload: { kind: 'get', tuple: null } })).toThrow('WORKER_IDENTITY');
  client.close(new Error('closed')); await expect(promise).rejects.toThrow('closed'); transport.close();
});
it('times out a stalled checkpoint ACK and rejects all outstanding requests', async () => {
  const input = new PassThrough(); const output = new PassThrough();
  const transport = new WorkerFramedTransport(input, output, () => {}, () => {});
  const client = new GraphWorkerClient(binding, transport, new AbortController().signal, 2, 20);
  const one = client.checkpoint({ kind: 'get', threadId: 'run', namespace: '' });
  const two = client.checkpoint({ kind: 'get', threadId: 'run', namespace: '' });
  await Promise.all([expect(one).rejects.toThrow('WORKER_REQUEST_TIMEOUT'), expect(two).rejects.toThrow('WORKER_REQUEST_TIMEOUT')]);
  expect(client.outstanding).toBe(0); transport.close();
});
