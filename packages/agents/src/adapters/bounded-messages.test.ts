import { createHash } from 'node:crypto';
import { chmodSync, linkSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { BoundedMessagesAdapter, type BoundedMessagesOptions } from './bounded-messages.js';
import { HermesEventSchema, type HermesEvent } from '@osstack/hermes-adapter';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const digest = (s: string) => createHash('sha256').update(s).digest('hex');
const review = { schemaVersion: 1, verdict: 'accept', summary: 'Answer is 42', findings: [] };
const edit = { edit: { path: 'answer.txt', beforeSha256: digest('41\n'), content: '42\n' } };
function response(output: unknown = edit, overrides: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ id: 'msg-test', type: 'message', role: 'assistant', model: 'test-model', stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify(output) }], usage: { input_tokens: 10, output_tokens: 5 }, ...overrides }));
}
function deepseekResponse(output: unknown = edit, choice: Record<string, unknown> = {}, overrides: Record<string, unknown> = {}) {
  return new Response(JSON.stringify({ id: 'chat-test', object: 'chat.completion', model: 'test-model',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: JSON.stringify(output) }, ...choice }],
    usage: { prompt_tokens: 10, completion_tokens: 5, prompt_cache_hit_tokens: 8, completion_tokens_details: { reasoning_tokens: 2 } }, ...overrides }));
}
function fixture(options: Partial<BoundedMessagesOptions> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'bounded-messages-'))); roots.push(root);
  writeFileSync(join(root, 'answer.txt'), '41\n');
  const fetch = vi.fn<typeof globalThis.fetch>(async () => response());
  const adapter = new BoundedMessagesAdapter({ role: 'writer', model: 'test-model', files: ['answer.txt'], acceptance: 'Answer must be 42.', apiKey: 'test-only', authorize: () => {}, fetch, ...options });
  const task = { run_id: 'run-1', task_id: 'task', session_id: 'session', capability_id: adapter.capabilities()[0]!.id, prompt: 'Fix answer', context: { repo_path: root } };
  const run = async (signal = new AbortController().signal) => { const events: HermesEvent[] = []; for await (const event of adapter.invoke(task, signal)) events.push(event); return events; };
  return { root, adapter, task, fetch, run, text: () => readFileSync(join(root, 'answer.txt'), 'utf8') };
}
it('makes one fixed-origin no-tools request, atomically edits and proves stopped before terminal output', async () => {
  const f = fixture(); chmodSync(join(f.root, 'answer.txt'), 0o751);
  const events = await f.run();
  for (const event of events) expect(HermesEventSchema.safeParse(event).success).toBe(true);
  expect(f.text()).toBe('42\n'); expect(statSync(join(f.root, 'answer.txt')).mode & 0o777).toBe(0o751);
  expect(readdirSync(f.root)).toEqual(['answer.txt']);
  expect(events.at(-1)).toMatchObject({ type: 'done', payload: { status: 'completed', last_seq: 2 } });
  expect(events.map(e => e.seq)).toEqual([0, 1, 2, 3]);
  expect(await f.adapter.confirmStopped('run-1')).toMatchObject({ stopped: true, evidence: expect.stringContaining('msg-test') });
  const [url, init] = f.fetch.mock.calls[0]!;
  expect(url).toBe('https://api.anthropic.com/v1/messages'); expect(init).toMatchObject({ redirect: 'error', method: 'POST' });
  const request = JSON.parse(init!.body as string); expect(request.tools).toBeUndefined(); expect(request.stream).toBe(false);
  expect(JSON.parse(request.messages[0].content).files).toEqual([{ path: 'answer.txt', content: '41\n', sha256: digest('41\n') }]);
  expect(f.fetch).toHaveBeenCalledTimes(1);
});
it('keeps reviewer read-only and emits the Graph review contract using fresh input', async () => {
  const f = fixture({ role: 'reviewer', fetch: async () => response(review) });
  const events = await f.run(); expect(f.text()).toBe('41\n');
  expect(events[1]).toMatchObject({ type: 'token.delta', payload: { delta: JSON.stringify(review) } });
  expect(await f.adapter.confirmStopped('run-1')).toMatchObject({ stopped: true });
});
it.each(['../outside', '.git/config', '/tmp/file', 'dir//file', 'dir/./file', 'dir\\file', 'file\0'])('rejects host path %s', path => {
  expect(() => fixture({ files: [path] })).toThrow('BOUNDED_OPTIONS_INVALID');
});
it.each(['symlink', 'hardlink', 'binary', 'large'])('refuses %s source before dispatch', async kind => {
  const f = fixture(); const target = join(f.root, 'answer.txt');
  if (kind === 'symlink') { unlinkSync(target); symlinkSync('/etc/hosts', target); }
  if (kind === 'hardlink') linkSync(target, join(f.root, 'other'));
  if (kind === 'binary') writeFileSync(target, Buffer.from([0, 255]));
  if (kind === 'large') writeFileSync(target, 'a'.repeat(65537));
  expect((await f.run()).at(-1)).toMatchObject({ payload: { status: 'failed' } }); expect(f.fetch).not.toHaveBeenCalled();
  expect(await f.adapter.confirmStopped('run-1')).toMatchObject({ stopped: true, evidence: expect.stringContaining('no-request') });
});
it.each([
  { edit: { ...edit.edit, path: '../outside' } }, { edit: { ...edit.edit, beforeSha256: '0'.repeat(64) } },
  { edit: { ...edit.edit, content: '文'.repeat(30000) } }, { edit: { ...edit.edit, content: '\0' } },
  { edit: edit.edit, command: 'echo escaped' }, { edits: [edit.edit] },
  { kind: 'propose', changes: [{ kind: 'replace', path: 'answer.txt', expectedSha256: edit.edit.beforeSha256, content: '42\n' }] },
])('rejects invalid model proposal without writing (provider stopped)', async output => {
  const f = fixture({ fetch: async () => response(output) });
  expect((await f.run()).at(-1)).toMatchObject({ payload: { status: 'failed' } }); expect(f.text()).toBe('41\n');
  expect(await f.adapter.confirmStopped('run-1')).toMatchObject({ stopped: true });
});
it('rejects concurrent source replacement even if content is the same', async () => {
  const f = fixture();
  // Ensure a different inode while the original still exists (inode reuse is legal).
  f.fetch.mockImplementationOnce(async () => { writeFileSync(join(f.root, 'replacement'), '41\n');
    const { renameSync } = await import('node:fs'); renameSync(join(f.root, 'replacement'), join(f.root, 'answer.txt')); return response(); });
  expect((await f.run()).at(-1)).toMatchObject({ payload: { status: 'failed' } }); expect(f.text()).toBe('41\n');
});
it('rechecks live write authority after inference without exposing errors', async () => {
  const f = fixture({ authorize: (_root, op) => { if (op === 'write') throw Error('SECRET'); } });
  const events = await f.run(); expect(f.text()).toBe('41\n'); expect(JSON.stringify(events)).not.toContain('SECRET');
  expect(events.at(-1)).toMatchObject({ payload: { status: 'failed' } }); expect(await f.adapter.confirmStopped('run-1')).toMatchObject({ stopped: true });
});
it.each([
  async () => { throw Error('network disconnected'); },
  async () => new Response('unavailable', { status: 503 }),
  async () => new Response('not JSON'),
  async () => new Response('a'.repeat(524289)),
  async () => response(edit, { model: 'different' }),
  async () => response(edit, { stop_reason: 'pause_turn' }),
  async () => response(edit, { content: [{ type: 'tool_use', id: 'tool', name: 'Bash', input: {} }] }),
])('never proves stop from a failed or untrusted transport response', async fetch => {
  const f = fixture({ fetch }); expect((await f.run()).at(-1)).toMatchObject({ payload: { status: 'failed' } });
  expect(await f.adapter.confirmStopped('run-1')).toEqual({ stopped: false }); expect(f.text()).toBe('41\n');
});
it('cancellation during HTTP sends abort, never applies and retains uncertainty', async () => {
  let started!: () => void; const dispatched = new Promise<void>(resolve => { started = resolve; });
  const f = fixture({ fetch: async (_url, init) => { started(); return await new Promise<Response>((_resolve, reject) => {
    init!.signal!.addEventListener('abort', () => reject(Error('aborted')), { once: true }); }); } });
  const controller = new AbortController(); const running = f.run(controller.signal); await dispatched;
  expect(await f.adapter.confirmStopped('run-1')).toEqual({ stopped: false }); controller.abort();
  expect((await running).at(-1)).toMatchObject({ payload: { status: 'cancelled' } }); expect(f.text()).toBe('41\n');
  expect(await f.adapter.confirmStopped('run-1')).toEqual({ stopped: false });
});
it('cancellation before dispatch is provably stopped and never calls provider', async () => {
  const f = fixture(); const c = new AbortController(); c.abort(); await f.run(c.signal);
  expect(f.fetch).not.toHaveBeenCalled(); expect(await f.adapter.confirmStopped('run-1')).toMatchObject({ stopped: true });
});
it('refuses duplicate IDs, never grants unknown/restarted IDs stopped status', async () => {
  const f = fixture(); await f.run(); await expect(f.run()).rejects.toThrow('BOUNDED_INVOCATION_REUSE_OR_CAPACITY');
  expect(f.fetch).toHaveBeenCalledTimes(1); expect(await f.adapter.confirmStopped('other')).toEqual({ stopped: false });
  expect(await fixture().adapter.confirmStopped('run-1')).toEqual({ stopped: false });
});
it('requires explicit credentials rather than implicit CLI login', async () => {
  const f = fixture({ apiKey: '' }); expect(await f.adapter.isAvailable()).toMatchObject({ available: false, status: 'not_authenticated' });
  await f.run(); expect(f.fetch).not.toHaveBeenCalled();
});
it('closing after run.started proves no dispatch and does not leave an active timer', async () => {
  const f = fixture(); const iterator = f.adapter.invoke(f.task, new AbortController().signal)[Symbol.asyncIterator]();
  await iterator.next(); await iterator.return?.(); expect(f.fetch).not.toHaveBeenCalled();
  expect(await f.adapter.confirmStopped('run-1')).toMatchObject({ stopped: true, evidence: expect.stringContaining('no-request') });
});
it.each([[400, 'invalid_request_error'], [401, 'authentication_error'], [403, 'permission_error'], [404, 'not_found_error'], [413, 'request_too_large'], [429, 'rate_limit_error']] as const)('recognizes complete %i request rejection and binds both digests', async (status, type) => {
  const f = fixture({ fetch: async () => new Response(JSON.stringify({ type: 'error', error: { type, message: 'provider rejected' } }), { status }) });
  const events = await f.run(); expect(events.at(-1)).toMatchObject({ payload: { status: 'failed', result_summary: expect.stringContaining('BOUNDED_HTTP_ERROR') } });
  expect(await f.adapter.confirmStopped('run-1')).toMatchObject({ stopped: true, evidence: expect.stringMatching(new RegExp(`^anthropic-bounded-v1:http-${status}:req=[a-f0-9]{64}:res=[a-f0-9]{64}$`)) });
});
it.each([[401, 'api_error'], [503, 'authentication_error'], [529, 'overloaded_error']] as const)('does not treat mismatched/5xx %i response as request rejection', async (status, type) => {
  const f = fixture({ fetch: async () => new Response(JSON.stringify({ type: 'error', error: { type, message: '' } }), { status }) });
  await f.run(); expect(await f.adapter.confirmStopped('run-1')).toEqual({ stopped: false });
});
it('rejects a too-large writer input before paying for an impossible full replacement', async () => {
  const f = fixture(); writeFileSync(join(f.root, 'answer.txt'), 'a'.repeat(4097));
  expect((await f.run()).at(-1)).toMatchObject({ payload: { result_summary: expect.stringContaining('BOUNDED_WRITER_INPUT_LIMIT') } });
  expect(f.fetch).not.toHaveBeenCalled();
});
it('rejects a review that exceeds the graph serialized byte limit', async () => {
  const f = fixture({ role: 'reviewer', fetch: async () => response({ ...review, summary: '文'.repeat(3000) }) });
  expect((await f.run()).at(-1)).toMatchObject({ payload: { status: 'failed', result_summary: expect.stringContaining('BOUNDED_REVIEW_LIMIT') } });
});
it('retains observed usage on truncated or invalid output', async () => {
  const f = fixture({ fetch: async () => response(edit, { stop_reason: 'max_tokens', usage: { input_tokens: 10, output_tokens: 32768, cache_read_input_tokens: 3 } }) });
  const events = await f.run(); expect(events[1]).toMatchObject({ type: 'usage.final', payload: { tokens_in: 13, tokens_out: 32768, duration_ms: expect.any(Number) } });
  expect(events.at(-1)).toMatchObject({ payload: { status: 'failed' } }); expect(f.text()).toBe('41\n');
});
it('timeout aborts pending transport without granting stopped status', async () => {
  const f = fixture({ timeoutMs: 5, fetch: async (_url, init) => new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(Error('timeout')), { once: true })) });
  expect((await f.run()).at(-1)).toMatchObject({ payload: { status: 'failed' } });
  expect(await f.adapter.confirmStopped('run-1')).toEqual({ stopped: false });
});
it.each(['writer', 'reviewer'] as const)('DeepSeek %s uses owner endpoint, Bearer auth, JSON-only fresh input and correct usage', async role => {
  const f = fixture({ provider: 'deepseek', role, baseUrl: 'https://api.deepseek.com/v1/' });
  f.fetch.mockImplementationOnce(async () => deepseekResponse(role === 'writer' ? edit : review));
  const events = await f.run();
  expect(f.adapter.id).toBe(`deepseek-bounded-${role}`); expect(f.text()).toBe(role === 'writer' ? '42\n' : '41\n');
  const [url, init] = f.fetch.mock.calls[0]!; expect(url).toBe('https://api.deepseek.com/v1/chat/completions');
  expect(init).toMatchObject({ redirect: 'error', headers: { authorization: 'Bearer test-only' } });
  expect(init!.headers).not.toHaveProperty('x-api-key');
  const body = JSON.parse(String(init!.body)); expect(body).toMatchObject({ stream: false, thinking: { type: 'disabled' }, response_format: { type: 'json_object' } });
  expect(body.tools).toBeUndefined(); expect(body.messages.map((m: {role: string}) => m.role)).toEqual(['system','user']);
  expect(events.find(e => e.type === 'usage.final')).toMatchObject({ payload: { tokens_in: 10, tokens_out: 5 } });
  expect(events.at(-1)).toMatchObject({ payload: { status: 'completed' } });
  expect(await f.adapter.confirmStopped('run-1')).toMatchObject({ stopped: true, evidence: expect.stringContaining('deepseek-bounded-v1:chat-test:req=') });
  for (const event of events) expect(HermesEventSchema.safeParse(event).success).toBe(true);
});
it.each(['length', 'content_filter', 'insufficient_system_resource', 'aborted'])('DeepSeek %s means stopped failure with paid usage', async finish_reason => {
  const f = fixture({ provider: 'deepseek', fetch: async () => deepseekResponse(edit, { finish_reason }) });
  const events = await f.run(); expect(events.at(-1)).toMatchObject({ payload: { status: 'failed' } });
  expect(events.some(e => e.type === 'usage.final')).toBe(true); expect(f.text()).toBe('41\n');
  expect(await f.adapter.confirmStopped('run-1')).toMatchObject({ stopped: true });
});
it.each([
  { finish_reason: 'tool_calls' }, { finish_reason: null }, { finish_reason: 'unknown' },
  { index: 1 }, { message: { role: 'assistant', content: '{}', tool_calls: [{ id: 'tool' }] } },
  { message: { role: 'assistant', content: '{}', function_call: { name: 'execute' } } },
])('DeepSeek untrusted completion never proves stop', async choice => {
  const f = fixture({ provider: 'deepseek', fetch: async () => deepseekResponse(edit, choice) }); await f.run();
  expect(await f.adapter.confirmStopped('run-1')).toEqual({ stopped: false }); expect(f.text()).toBe('41\n');
});
it.each([{ model: 'different' }, { object: 'chat.completion.chunk' }, { choices: [] }, { usage: { prompt_tokens: -1, completion_tokens: 1 } }])('DeepSeek validates full response identity/usage', async overrides => {
  const f = fixture({ provider: 'deepseek', fetch: async () => deepseekResponse(edit, {}, overrides) }); await f.run();
  expect(await f.adapter.confirmStopped('run-1')).toEqual({ stopped: false });
});
it.each([400,401,402,422,429,500,503,504,529])('DeepSeek HTTP %i is classified without printing provider errors', async status => {
  const f = fixture({ provider: 'deepseek', fetch: async () => new Response(JSON.stringify({ error: { type: 'provider_error', message: 'SECRET' } }), { status }) });
  const events = await f.run(); expect(JSON.stringify(events)).not.toContain('SECRET');
  expect((await f.adapter.confirmStopped('run-1')).stopped).toBe(status < 500);
});
it.each(['http://example.com', 'https://user:password@example.com', 'https://example.com?a=b', 'https://example.com#key', 'https://example.com?', 'https://example.com#', 'ftp://example.com', ' https://example.com', 'not a url'])('rejects unsafe DeepSeek base URL %s before admission', baseUrl => {
  expect(() => fixture({ provider: 'deepseek', baseUrl })).toThrow('BOUNDED_BASE_URL_INVALID');
});
it('does not widen Anthropic fixed-origin behavior', () => {
  expect(() => fixture({ baseUrl: 'https://api.example.com' })).toThrow('BOUNDED_BASE_URL_UNSUPPORTED');
});
it('DeepSeek abort after dispatch never assumes provider completion', async () => {
  const c = new AbortController();
  const f = fixture({ provider: 'deepseek', fetch: async () => { c.abort(); throw Error('disconnected'); } });
  await f.run(c.signal); expect(f.text()).toBe('41\n'); expect(await f.adapter.confirmStopped('run-1')).toEqual({ stopped: false });
});
it('DeepSeek explicit null tool_calls means no calls, while nonempty calls stay rejected', async () => {
  const f = fixture({ provider: 'deepseek', fetch: async () => deepseekResponse(edit, { message: { role: 'assistant', content: JSON.stringify(edit), tool_calls: null } }) });
  expect((await f.run()).at(-1)).toMatchObject({ payload: { status: 'completed' } });
  expect(f.text()).toBe('42\n'); expect(await f.adapter.confirmStopped('run-1')).toMatchObject({ stopped: true });
});
