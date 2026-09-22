import { afterEach, expect, it, vi } from 'vitest';
import { createBoundedProvider } from '../adapters/bounded-messages-provider.js';
import { changesetPolicyDigest } from './changeset.js';
import { createChangesetProposalClient } from './changeset-client.js';
const policy = { exactPaths: ['src/new.ts'], directoryPrefixes: [], denyPaths: [], denyPrefixes: [] };
const binding = { runId: 'run', effectKey: 'a'.repeat(64), generation: 1, baseRevision: 'b'.repeat(40), treeRevision: 'c'.repeat(40), profileDigest: 'd'.repeat(64), grantDigest: 'e'.repeat(64), programDigest: 'f'.repeat(64), policyDigest: changesetPolicyDigest(policy) };
const input = () => ({ task: 'Create the file', manifest: { schemaVersion: 1, binding, entries: [{ path: 'src/new.ts', state: 'absent' }] }, policy, binding,
  maxOutputTokens: 100, inputTokenUpperBound: 1000, tokenBoundEvidenceRef: 'host-pinned-tokenizer-v1' });
const proposal = { kind: 'propose', changes: [{ kind: 'create', path: 'src/new.ts', content: 'hello' }] };
const payload = (text = JSON.stringify(proposal)) => ({ id: 'msg_1', type: 'message', role: 'assistant', model: 'fixture-model', stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 80, output_tokens: 10 } });
const setup = (fetcher: typeof fetch = vi.fn(async () => new Response(JSON.stringify(payload())))) => {
  const client = createChangesetProposalClient({ provider: 'anthropic', model: 'fixture-model', apiKey: 'secret-key', timeoutMs: 50, fetch: fetcher });
  return { client, fetcher, prepared: client.prepare(input()) };
};
afterEach(() => vi.useRealTimers());
it('prepares frozen exact bytes before claiming and dispatches only once without tools', async () => {
  const { client, prepared, fetcher } = setup();
  expect(fetcher).not.toHaveBeenCalled();
  expect(prepared.reservationTokens).toBe(1100);
  expect(Object.isFrozen(prepared)).toBe(true);
  const gate = vi.fn((request) => { expect(request).toBe(prepared); return true; });
  const result = await client.invoke(prepared, gate);
  expect(result).toMatchObject({ kind: 'terminal', disposition: 'proposal', actualTokens: 90, requestDigest: prepared.requestDigest });
  expect(JSON.parse(prepared.body)).toMatchObject({ stream: false, model: 'fixture-model', max_tokens: 100 });
  expect(JSON.parse(prepared.body).tools).toBeUndefined();
  expect(fetcher).toHaveBeenCalledWith(prepared.endpoint, expect.objectContaining({ body: prepared.body, redirect: 'error', method: 'POST' }));
  expect(await client.invoke(prepared, gate)).toMatchObject({ kind: 'not_authorized' });
  expect(fetcher).toHaveBeenCalledTimes(1); expect(gate).toHaveBeenCalledTimes(1);
});
it('binds task, budget evidence, endpoint, model and generation to request digest', () => {
  const { client, prepared } = setup();
  for (const patch of [{ task: 'different' }, { inputTokenUpperBound: 1001 }, { tokenBoundEvidenceRef: 'new-proof' }, { maxOutputTokens: 101 }]) {
    expect(client.prepare({ ...input(), ...patch }).requestDigest).not.toBe(prepared.requestDigest);
  }
  expect(() => client.prepare({ ...input(), binding: { ...binding, generation: 2 } })).toThrow();
  expect(() => client.prepare({ ...input(), inputTokenUpperBound: Number.MAX_SAFE_INTEGER })).toThrow();
});
it('rejects forged and foreign prepared handles before invoking host code', async () => {
  const { client, prepared, fetcher } = setup(); const gate = vi.fn(() => true);
  expect(await client.invoke({ ...prepared }, gate)).toMatchObject({ kind: 'not_authorized' });
  expect(await setup().client.invoke(prepared, gate)).toMatchObject({ kind: 'not_authorized' });
  expect(gate).not.toHaveBeenCalled(); expect(fetcher).not.toHaveBeenCalled();
});
it.each([false, undefined, {}, Promise.resolve(true)])('requires exact synchronous true, received %s', async (answer) => {
  const { client, prepared, fetcher } = setup();
  const result = await client.invoke(prepared, () => answer);
  expect(result.kind).toBe(answer === false ? 'not_authorized' : 'unknown');
  expect(fetcher).not.toHaveBeenCalled();
});
it('contains gate failures that may have committed and never treats them as stop evidence', async () => {
  const { client, prepared, fetcher } = setup();
  expect(await client.invoke(prepared, () => { throw Error('secret-key'); })).toEqual({ kind: 'unknown', requestDigest: prepared.requestDigest, reason: 'gate_uncertain' });
  expect(fetcher).not.toHaveBeenCalled();
});
it('captures caller input before any mutation and blocks duplicate effect through another preparation', async () => {
  const { client, fetcher } = setup(); const value = input(); const prepared = client.prepare(value);
  value.task = 'changed'; value.manifest.entries[0]!.path = 'outside';
  expect(prepared.body).toContain('Create the file'); expect(JSON.parse(JSON.parse(prepared.body).messages[0].content).manifest.entries[0].path).toBe('src/new.ts');
  await client.invoke(prepared, () => true);
  expect(await client.invoke(client.prepare(input()), () => true)).toMatchObject({ kind: 'not_authorized' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it.each(['cannot_complete', 'invalid', 'truncated'])('retains terminal usage for %s without accepting a proposal', async (which) => {
  const response = payload(which === 'cannot_complete' ? JSON.stringify({ kind: 'cannot_complete', reason: 'insufficient_context' }) : 'invalid-json');
  if (which === 'truncated') response.stop_reason = 'max_tokens';
  const { client, prepared } = setup(vi.fn(async () => new Response(JSON.stringify(response))));
  expect(await client.invoke(prepared, () => true)).toMatchObject({ kind: 'terminal', actualTokens: 90, disposition: which === 'cannot_complete' ? 'cannot_complete' : 'rejected' });
});
it.each(['tools', 'wrong-model', 'bad-usage', 'http-error', 'oversize', 'utf8', 'transport'])('preserves uncertainty on %s and never retries', async (which) => {
  const fetcher = vi.fn(async () => {
    if (which === 'transport') throw Error('secret-key');
    if (which === 'http-error') return new Response('{}', { status: 503 });
    if (which === 'oversize') return new Response('x'.repeat(65_537));
    if (which === 'utf8') return new Response(new Uint8Array([0xc0, 0xaf]));
    const response = payload();
    if (which === 'tools') response.content = [{ type: 'tool_use', text: 'forbidden' }];
    if (which === 'wrong-model') response.model = 'different';
    if (which === 'bad-usage') response.usage.input_tokens = -1;
    return new Response(JSON.stringify(response));
  });
  const { client, prepared } = setup(fetcher);
  const result = await client.invoke(prepared, () => true);
  expect(result).toMatchObject({ kind: 'unknown' }); expect(JSON.stringify(result)).not.toContain('secret-key');
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it('bounds an abort-ignoring fetch and consumes the attempt permanently', async () => {
  vi.useFakeTimers();
  const { client, prepared, fetcher } = setup(vi.fn(() => new Promise<Response>(() => {})));
  const pending = client.invoke(prepared, () => true); await vi.advanceTimersByTimeAsync(51);
  expect(await pending).toMatchObject({ kind: 'unknown', reason: 'timeout' });
  expect(await client.invoke(prepared, () => true)).toMatchObject({ kind: 'not_authorized' }); expect(fetcher).toHaveBeenCalledTimes(1);
});
it('bounds a hung response stream even when cancel does not finish', async () => {
  vi.useFakeTimers();
  const stream = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => {}), cancel: () => new Promise(() => {}) });
  const { client, prepared } = setup(vi.fn(async () => new Response(stream)));
  const pending = client.invoke(prepared, () => true); await vi.advanceTimersByTimeAsync(51);
  expect(await pending).toMatchObject({ kind: 'unknown', reason: 'timeout' });
});
it('does not claim an already aborted call and proves no dispatch only after winning the gate', async () => {
  const { client, prepared, fetcher } = setup(); const controller = new AbortController(); const gate = vi.fn(() => true);
  controller.abort(); expect(await client.invoke(prepared, gate, controller.signal)).toMatchObject({ kind: 'not_authorized' }); expect(gate).not.toHaveBeenCalled();
  const other = new AbortController();
  expect(await client.invoke(prepared, () => { other.abort(); return true; }, other.signal)).toMatchObject({ kind: 'not_dispatched' }); expect(fetcher).not.toHaveBeenCalled();
});
it('supports DeepSeek codec with disabled thinking and no tool declarations', async () => {
  const fetcher = vi.fn(async () => new Response(JSON.stringify({ id: 'chat_1', object: 'chat.completion', model: 'fixture-model', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(proposal) } }], usage: { prompt_tokens: 80, completion_tokens: 10 } })));
  const client = createChangesetProposalClient({ provider: 'deepseek', model: 'fixture-model', apiKey: 'key', fetch: fetcher }); const prepared = client.prepare(input());
  expect(JSON.parse(prepared.body)).toMatchObject({ thinking: { type: 'disabled' }, response_format: { type: 'json_object' } });
  expect(await client.invoke(prepared, () => true)).toMatchObject({ kind: 'terminal', disposition: 'proposal' });
});
it('rejects proposal acceptance on exceeded input/output bounds while retaining actual usage', async () => {
  for (const usage of [{ input_tokens: 1001, output_tokens: 10 }, { input_tokens: 10, output_tokens: 101 }, { input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: 1 }]) {
    const { client, prepared } = setup(vi.fn(async () => new Response(JSON.stringify({ ...payload(), usage }))));
    expect(await client.invoke(prepared, () => true)).toMatchObject({ kind: 'terminal', disposition: 'rejected', budgetExceeded: true, validated: null });
  }
});
it('returns unknown on cancellation after dispatch and ignores a late valid response', async () => {
  let finish!: (response: Response) => void;
  const { client, prepared, fetcher } = setup(vi.fn(() => new Promise<Response>(resolve => { finish = resolve; })));
  const controller = new AbortController(); const pending = client.invoke(prepared, () => true, controller.signal);
  controller.abort(); expect(await pending).toMatchObject({ kind: 'unknown', reason: 'aborted' });
  const cancel = vi.fn(); finish(new Response(new ReadableStream<Uint8Array>({ cancel })));
  await Promise.resolve(); await Promise.resolve();
  expect(cancel).toHaveBeenCalledTimes(1); expect(fetcher).toHaveBeenCalledTimes(1);
});
it('shares durable gate authorization across competing clients even before response arrives', async () => {
  let claimed = false; const gate = () => { if (claimed) return false; claimed = true; return true; };
  const fetcher = vi.fn(async () => new Response(JSON.stringify(payload())));
  const a = setup(fetcher); const b = setup(fetcher);
  const results = await Promise.all([a.client.invoke(a.prepared, gate), b.client.invoke(b.prepared, gate)]);
  expect(results.map(r => r.kind)).toEqual(['terminal', 'not_authorized']); expect(fetcher).toHaveBeenCalledTimes(1);
});
it('hashes exact response bytes, including a UTF-8 BOM', async () => {
  const plain = JSON.stringify(payload());
  const a = setup(vi.fn(async () => new Response(plain))); const b = setup(vi.fn(async () => new Response('\ufeff' + plain)));
  const ra = await a.client.invoke(a.prepared, () => true); const rb = await b.client.invoke(b.prepared, () => true);
  if (ra.kind !== 'terminal' || rb.kind !== 'terminal') throw Error('fixture');
  expect(ra.responseDigest).not.toBe(rb.responseDigest);
});
it('retains terminal evidence for an empty-content refusal', async () => {
  const { client, prepared } = setup(vi.fn(async () => new Response(JSON.stringify({ ...payload(), content: [], stop_reason: 'refusal' }))));
  expect(await client.invoke(prepared, () => true)).toMatchObject({ kind: 'terminal', disposition: 'rejected', actualTokens: 90 });
});
it('contains invalid manifest details in a fixed input error', () => {
  const { client } = setup(); const value = input(); value.manifest.entries[0]!.state = 'secret-input-marker';
  expect(() => client.prepare(value)).toThrow(/^CHANGESET_CLIENT_INPUT$/);
});
it('includes both Anthropic cache usage counters in the bound check', async () => {
  const response = { ...payload(), usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 500, cache_read_input_tokens: 500 } };
  const { client, prepared } = setup(vi.fn(async () => new Response(JSON.stringify(response))));
  expect(await client.invoke(prepared, () => true)).toMatchObject({ kind: 'terminal', disposition: 'rejected', actualTokens: 1002, budgetExceeded: true });
});
it('caps unresolved transport retention to one operation per client', async () => {
  vi.useFakeTimers(); const { client, prepared } = setup(vi.fn(() => new Promise<Response>(() => {})));
  const pending = client.invoke(prepared, () => true); await vi.advanceTimersByTimeAsync(51); await pending;
  const nextBinding = { ...binding, effectKey: '1'.repeat(64) };
  const next = client.prepare({ ...input(), binding: nextBinding, manifest: { ...input().manifest, binding: nextBinding } }); const gate = vi.fn(() => true);
  expect(await client.invoke(next, gate)).toMatchObject({ kind: 'not_authorized', reason: 'capacity' }); expect(gate).not.toHaveBeenCalled();
});

it('leaves empty-content parsing disabled for legacy codec callers', () => {
  const codec = createBoundedProvider('anthropic');
  const raw = JSON.stringify({ ...payload(), content: [], stop_reason: 'refusal' });
  expect(() => codec.response(raw, 'fixture-model')).toThrow('BOUNDED_CONTENT_EMPTY');
  expect(codec.response(raw, 'fixture-model', { allowEmptyContent: true })).toMatchObject({ complete: false, tokensIn: 80 });
});
it('denies synchronous reentry before a second gate can claim a distinct effect', async () => {
  const { client, prepared, fetcher } = setup(); const nextBinding = { ...binding, effectKey: '1'.repeat(64) };
  const next = client.prepare({ ...input(), binding: nextBinding, manifest: { ...input().manifest, binding: nextBinding } });
  const secondGate = vi.fn(() => true); let reentered: ReturnType<typeof client.invoke> | undefined;
  await client.invoke(prepared, () => { reentered = client.invoke(next, secondGate); return true; });
  expect(await reentered).toMatchObject({ kind: 'not_authorized', reason: 'capacity' });
  expect(secondGate).not.toHaveBeenCalled(); expect(fetcher).toHaveBeenCalledTimes(1);
});
