import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { createBoundedMessagesAdapter } from '@osstack/agents';
import { GraphDelegationStatus } from '@osstack/protocol';
import { GraphRpcService } from './graph-rpc.js';
import { graphRpcFixture } from './graph-test-fixture.js';

// The provider response is a fixture, not a live model pilot. Everything after
// that boundary is real: source clone, edit, graph worker, ledger, freeze, review,
// registered acceptance command, parallel join, and public cancellation RPC.
async function fixture(mode: 'success' | 'review-fails' | 'disconnect') {
  const f = await graphRpcFixture(); const calls: { role: string; source: string }[] = [];
  const adapter = async (role: 'writer' | 'reviewer') => createBoundedMessagesAdapter({ role, model: 'fixture-model', files: ['answer'],
    apiKey: 'test-only', acceptance: 'The answer file must contain 1 followed by a newline.', authorize: () => f.registration.authorize('execute'),
    fetch: async (_url, init) => {
      const request = JSON.parse(String(init!.body)); const input = JSON.parse(request.messages[0].content);
      const file = input.files[0]; calls.push({ role, source: file.content });
      if (mode === 'disconnect' && role === 'writer') throw Error('connection lost after sending request');
      const output = role === 'writer' ? { edit: { path: file.path, beforeSha256: file.sha256, content: '1\n' } }
        : { schemaVersion: 1, verdict: mode === 'review-fails' ? 'changes_requested' : 'accept', summary: 'Review frozen input', findings: mode === 'review-fails' ? ['fixture review objection'] : [] };
      return new Response(JSON.stringify({ id: `msg-${role}`, model: request.model, type: 'message', role: 'assistant', stop_reason: 'end_turn',
        content: [{ type: 'text', text: JSON.stringify(output) }], usage: { input_tokens: 20, output_tokens: 10 } }));
    } });
  const writer = await adapter('writer'); const reviewer = await adapter('reviewer');
  const registration = { ...f.registration, delivery: { ...f.registration.delivery,
    writer: { identity: writer.id, adapter: writer, capabilityId: writer.capabilities()[0]!.id },
    reviewer: { identity: reviewer.id, adapter: reviewer, capabilityId: reviewer.capabilities()[0]!.id } } };
  const service = new GraphRpcService({ ...f.options, registrations: [registration] });
  const until = async (id: string, status: string) => {
    const deadline = Date.now() + 20000;
    for (;;) {
      const value = await f.status(id, service); if (value.status === status) return value;
      if (Date.now() > deadline) throw Error(`TIMEOUT: ${JSON.stringify(value)}`);
      await new Promise(resolve => setTimeout(resolve, 15));
    }
  };
  return { ...f, service, calls, until, close: async () => { await service.close(); await f.close(); } };
}
it('runs the bounded writer and independent reviewer through the public graph to ready', async () => {
  const f = await fixture('success');
  try {
    const first = GraphDelegationStatus.parse(await f.service.handle(f.connection, 'graph.start', f.request));
    const ready = await f.until(first.graphRunId, 'ready'); expect(ready.candidate).toBeDefined(); expect(ready.resultRef).toMatch(/^graph-join:/);
    expect(f.calls).toEqual([{ role: 'writer', source: '0\n' }, { role: 'reviewer', source: '1\n' }]);
    expect(await readFile(join(f.root, 'source', 'answer'), 'utf8')).toBe('0\n');
    expect(f.db.prepare("SELECT count(*) n FROM graph_actions WHERE state='uncertain'").get()).toEqual({ n: 0 });
    expect(await f.service.handle(f.connection, 'graph.submit', f.request)).toMatchObject({ graphRunId: first.graphRunId, status: 'ready' });
    expect(f.calls).toHaveLength(2);
  } finally { await f.close(); }
}, 30000);
it('routes a stopped negative review to a quality interrupt rather than ready', async () => {
  const f = await fixture('review-fails');
  try {
    const first = GraphDelegationStatus.parse(await f.service.handle(f.connection, 'graph.start', f.request));
    const waiting = await f.until(first.graphRunId, 'waiting_input'); expect(waiting.interrupt).toBeDefined();
    expect(f.calls).toHaveLength(2);
    await f.service.handle(f.connection, 'graph.cancel', { schemaVersion: 1, kind: 'cancel', scope: f.request.scope, graphRunId: first.graphRunId, expectedRevision: waiting.revision, idempotencyKey: 'cancel' });
    await f.until(first.graphRunId, 'cancelled');
  } finally { await f.close(); }
}, 30000);
it('keeps a dispatched disconnected inference unresolved through public reconcile', async () => {
  const f = await fixture('disconnect');
  try {
    const first = GraphDelegationStatus.parse(await f.service.handle(f.connection, 'graph.start', f.request));
    const unknown = await f.until(first.graphRunId, 'reconciliation_required');
    expect(unknown.delivery).toBe('delivery_unknown'); expect(f.calls).toHaveLength(1);
    const result = await f.service.handle(f.connection, 'graph.reconcile', { schemaVersion: 1, kind: 'cancel', scope: f.request.scope, graphRunId: first.graphRunId, expectedRevision: unknown.revision, idempotencyKey: 'reconcile' });
    expect(result).toMatchObject({ status: 'cancel_pending', delivery: 'delivery_unknown' });
    expect(f.calls).toHaveLength(1);
    expect(await readFile(join(f.root, 'source', 'answer'), 'utf8')).toBe('0\n');
  } finally { await f.close(); }
}, 30000);
