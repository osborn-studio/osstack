import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, linkSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { GraphInvocationEvidenceStore } from './invocation-evidence.js';
const roots: string[] = [];
const binding = { schemaVersion: 1 as const, scope: { schemaVersion: 1 as const, tenantId: 't', principalId: 'p', workspaceId: 'w' },
  runId: 'run', effectKey: 'a'.repeat(64), generation: 1, requestDigest: 'b'.repeat(64), kind: 'request' as const };
const fixture = () => { const parent = realpathSync(mkdtempSync(join(tmpdir(), 'invocation evidence-'))); roots.push(parent); const root = join(parent, 'private'); return { root, parent, store: new GraphInvocationEvidenceStore(root) }; };
afterEach(() => { for (const root of roots) rmSync(root, { force: true, recursive: true }); roots.length = 0; });
it('persists exact bytes privately across reopen and returns the same immutable reference', () => {
  const { root, store } = fixture(); const bytes = Buffer.from([0xef, 0xbb, 0xbf, 0, 0xff]); const ref = store.put(binding, bytes);
  expect(store.put(binding, bytes)).toBe(ref);
  const reopened = new GraphInvocationEvidenceStore(root);
  expect(reopened.read(ref, binding)).toEqual(bytes); expect(reopened.lookup(binding)).toBe(ref);
  expect(statSync(root).mode & 0o777).toBe(0o700);
  expect(statSync(join(root, readdirSync(root).find(name => !name.startsWith('.'))!, 'evidence.json')).mode & 0o777).toBe(0o600);
});
it('never replaces bytes at the same identity and preserves the original on conflict', () => {
  const { store } = fixture(); const ref = store.put(binding, Buffer.from('original'));
  expect(() => store.put(binding, Buffer.from('changed'))).toThrow('INVOCATION_EVIDENCE_CONFLICT');
  expect(store.read(ref, binding).toString()).toBe('original');
});
it.each(['scope', 'runId', 'effectKey', 'generation', 'requestDigest', 'kind'])('rejects reference reuse across %s', field => {
  const { store } = fixture(); const ref = store.put(binding, Buffer.from('body'));
  const changed = { ...binding, [field]: field === 'scope' ? { ...binding.scope, tenantId: 'other' } : field === 'generation' ? 2 : field === 'kind' ? 'response' : field === 'effectKey' || field === 'requestDigest' ? 'c'.repeat(64) : 'other' };
  expect(() => store.read(ref, changed)).toThrow();
});
it('rejects tampered envelope bytes against the saved reference', () => {
  const { store, root } = fixture(); const ref = store.put(binding, Buffer.from('body')); const path = join(root, readdirSync(root).find(name => !name.startsWith('.'))!, 'evidence.json');
  const envelope = JSON.parse(readFileSync(path, 'utf8')); envelope.bodyBase64 = Buffer.from('other').toString('base64'); writeFileSync(path, JSON.stringify(envelope));
  expect(() => store.read(ref, binding)).toThrow('INVOCATION_EVIDENCE_CORRUPT');
});
it('rejects unsafe roots, public permissions and symlink or hardlink evidence files', () => {
  const { root, parent, store } = fixture(); const ref = store.put(binding, Buffer.from('body')); const path = join(root, readdirSync(root).find(name => !name.startsWith('.'))!, 'evidence.json');
  linkSync(path, join(parent, 'hardlink')); expect(() => store.read(ref, binding)).toThrow(); rmSync(join(parent, 'hardlink'));
  chmodSync(path, 0o644); expect(() => store.read(ref, binding)).toThrow(); chmodSync(path, 0o600);
  rmSync(path); symlinkSync(join(parent, 'outside'), path); expect(() => store.read(ref, binding)).toThrow();
  chmodSync(root, 0o755); expect(() => new GraphInvocationEvidenceStore(root)).toThrow();
});
it('fails closed on replaced root and over-limit evidence', () => {
  const { root, store } = fixture();
  expect(() => store.put(binding, Buffer.alloc(524289))).toThrow('INVOCATION_EVIDENCE_LIMIT');
  rmSync(root, { recursive: true }); symlinkSync(roots[0]!, root);
  expect(() => store.put(binding, Buffer.from('body'))).toThrow();
});

it.each(['before_rename', 'after_rename', 'after_put'])('fails closed or preserves exact evidence after SIGKILL at %s', point => {
  const { root } = fixture();
  const source = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const point=process.argv[2]; const rename=fs.renameSync;
    fs.renameSync=(...args)=>{if(point==='before_rename')process.kill(process.pid,'SIGKILL');rename(...args);if(point==='after_rename')process.kill(process.pid,'SIGKILL');};
    syncBuiltinESMExports();
    const {GraphInvocationEvidenceStore}=await import(${JSON.stringify(new URL('../../dist/graph/invocation-evidence.js', import.meta.url).href)});
    new GraphInvocationEvidenceStore(process.argv[1]).put(${JSON.stringify(binding)},Buffer.from('crash-body'));
    process.kill(process.pid,'SIGKILL');`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source, root, point], { encoding: 'utf8' });
  expect(child.signal, child.stderr).toBe('SIGKILL'); const reopened = new GraphInvocationEvidenceStore(root);
  if (point === 'before_rename') expect(reopened.lookup(binding)).toBeNull();
  else { const ref = reopened.lookup(binding)!; expect(reopened.read(ref, binding).toString()).toBe('crash-body'); }
});

it('coalesces concurrent identical publications without overwriting or hard-link ambiguity', async () => {
  const { root, store } = fixture();
  const script = `const {GraphInvocationEvidenceStore}=await import(${JSON.stringify(new URL('../../dist/graph/invocation-evidence.js', import.meta.url).href)});
    process.stdout.write(new GraphInvocationEvidenceStore(process.argv[1]).put(${JSON.stringify(binding)},Buffer.from('same')));`;
  const run = () => new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, root], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = ''; child.stdout.on('data', chunk => { out += chunk; }); child.stderr.on('data', chunk => { err += chunk; });
    child.on('error', reject); child.on('close', code => code === 0 ? resolve(out) : reject(Error(err)));
  });
  const [a, b] = await Promise.all([run(), run()]); expect(a).toBe(b); expect(store.read(a!, binding).toString()).toBe('same');
});
it('does not replace an existing published directory whose evidence file is missing', () => {
  const { store, root } = fixture(); store.put(binding, Buffer.from('original'));
  const directory = join(root, readdirSync(root).find(name => !name.startsWith('.'))!);
  rmSync(join(directory, 'evidence.json'));
  expect(() => store.put(binding, Buffer.from('different'))).toThrow();
});
