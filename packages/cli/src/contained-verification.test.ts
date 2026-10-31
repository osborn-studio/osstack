import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createScratchDirSync, type ContainedMission } from '@osstack/core';
import { canonicalJson } from '@osstack/protocol/source';
import type { ContainedImageReceipt } from '@osstack/agents';
import { containedBindingCanonical, containedBindingDigest, containedCommandFromArgv, containedOwnerPort, exportContainedCandidate, missionVerificationBinding, parseContainedVerificationBinding,
  prepareContainedCandidateImage, readContainedJournal, registerContainedExecution, type ContainedVerificationBinding } from './contained-verification.js';
import { prepareGraphContainedImage } from './graph-contained-tests.js';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const scratch = (label: string) => { const root = realpathSync(createScratchDirSync('tests', label)); roots.push(root); return root; };
const binding = (): ContainedVerificationBinding => ({ owner_kind: 'contained_mission', owner_id: 'mission-1', spec_digest: 'a'.repeat(64), epoch: 2,
  candidate: { revision: 'b'.repeat(40), tree: 'c'.repeat(40) }, artifact_digest: 'd'.repeat(64), acceptance_ref: 'e'.repeat(64) });
const mission = (patch: Partial<ContainedMission> = {}): ContainedMission => ({ mission_id: 'mission-1', scope_id: 'scope', owner_principal_id: 'p', owner_client_session_id: 's',
  spec_digest: 'a'.repeat(64), spec_json: '{}', state: 'verifying', revision: 7, expected_head: 'f'.repeat(40), candidate_head: 'b'.repeat(40), candidate_tree: 'c'.repeat(40),
  candidate_diff_digest: 'd'.repeat(64), verify_attempts: 2, repair_cycles: 0, stop_obligation: 0, candidate_verified: 0, repair_pending: 0, supersedes: null, created_at: 1, updated_at: 1, ...patch });

describe('neutral binding', () => {
  it('canonicalizes stably regardless of object key order', () => {
    const a = binding();
    const b = { acceptance_ref: a.acceptance_ref, artifact_digest: a.artifact_digest, candidate: { tree: a.candidate.tree!, revision: a.candidate.revision }, epoch: a.epoch, spec_digest: a.spec_digest, owner_id: a.owner_id, owner_kind: a.owner_kind };
    expect(containedBindingCanonical(b)).toBe(containedBindingCanonical(a));
    expect(containedBindingCanonical(a)).toBe(canonicalJson(a));
    expect(containedBindingCanonical(a)).toBe('{"acceptance_ref":"' + 'e'.repeat(64) + '","artifact_digest":"' + 'd'.repeat(64) + '","candidate":{"revision":"' + 'b'.repeat(40) + '","tree":"' + 'c'.repeat(40)
      + '"},"epoch":2,"owner_id":"mission-1","owner_kind":"contained_mission","spec_digest":"' + 'a'.repeat(64) + '"}');
    expect(containedBindingDigest(b)).toBe(sha(containedBindingCanonical(a)));
    const { tree: _tree, ...withoutTree } = a.candidate;
    expect(containedBindingDigest({ ...a, candidate: withoutTree })).not.toBe(containedBindingDigest(a));
  });
  it.each<[string, (b: Record<string, unknown>) => void]>([
    ['extra field', b => { b.scope = {}; }], ['empty owner', b => { b.owner_id = ''; }], ['owner kind', b => { b.owner_kind = 'Graph Run'; }],
    ['negative epoch', b => { b.epoch = -1; }], ['fractional epoch', b => { b.epoch = 1.5; }], ['candidate extra', b => { b.candidate = { revision: 'x', head: 'y' }; }],
    ['candidate missing', b => { b.candidate = {}; }], ['control', b => { b.acceptance_ref = 'a\nb'; }],
  ])('rejects %s', (_name, edit) => {
    const value = binding() as unknown as Record<string, unknown>; edit(value);
    expect(() => parseContainedVerificationBinding(value)).toThrow('CONTAINED_BINDING_INVALID');
  });
});

describe('mission binding', () => {
  it('maps a verifying mission candidate and attempt', () => {
    const argv = ['pnpm', '--filter', '@osstack/cli', 'test'];
    expect(missionVerificationBinding(mission(), { argv })).toEqual({ owner_kind: 'contained_mission', owner_id: 'mission-1', spec_digest: 'a'.repeat(64), epoch: 2,
      candidate: { revision: 'b'.repeat(40), tree: 'c'.repeat(40) }, artifact_digest: 'd'.repeat(64), acceptance_ref: sha(canonicalJson(argv)) });
    expect(missionVerificationBinding(mission({ verify_attempts: 3 }), { argv }).epoch).toBe(3);
  });
  it.each<Partial<ContainedMission>>([{ candidate_head: null }, { candidate_tree: null }, { candidate_diff_digest: null }, { candidate_head: null, candidate_tree: null, candidate_diff_digest: null }])('rejects a candidate-less mission %#', patch => {
    expect(() => missionVerificationBinding(mission(patch), { argv: ['true'] })).toThrow('CONTAINED_MISSION_CANDIDATE_REQUIRED');
  });
  it.each<ContainedMission['state']>(['candidate_ready', 'verified', 'executing', 'cancelled'])('rejects state %s', state => {
    expect(() => missionVerificationBinding(mission({ state }), { argv: ['true'] })).toThrow('CONTAINED_MISSION_NOT_VERIFYING');
  });
  it('rejects an invalid acceptance argv', () => {
    expect(() => missionVerificationBinding(mission(), { argv: [] })).toThrow('CONTAINED_ARGV_INVALID');
  });
});

describe('argv to contained command', () => {
  const awkward = ['plain', 'two words', "it's", '"double"', '$HOME', '$' + '{PATH}', '`id`', '$(id)', '\\', '*', '~', '', ' lead', 'trail ', "''", ';|&<>', '#', '!', 'ünï 😀', '-n'];
  it('round-trips awkward arguments through /bin/sh -c', () => {
    const { command, argv_digest } = containedCommandFromArgv(['printf', '%s\\0', ...awkward]);
    const out = execFileSync('/bin/sh', ['-c', command], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: '/nonexistent' } }).toString('utf8');
    expect(out.split('\0').slice(0, -1)).toEqual(awkward);
    expect(argv_digest).toBe(sha(canonicalJson(['printf', '%s\\0', ...awkward])));
  });
  it('is deterministic and digests the argv, not the quoted string', () => {
    expect(containedCommandFromArgv(['a', "b'c"])).toEqual({ command: `'a' 'b'\\''c'`, argv_digest: sha('["a","b\'c"]') });
    expect(containedCommandFromArgv(['a b']).argv_digest).not.toBe(containedCommandFromArgv(['a', 'b']).argv_digest);
  });
  it.each<[string, unknown]>([
    ['empty argv', []], ['empty program', ['']], ['newline', ['echo', 'a\nb']], ['carriage return', ['echo', 'a\rb']], ['tab', ['echo', 'a\tb']], ['NUL', ['echo', 'a\0b']],
    ['DEL', ['echo', 'a\x7fb']], ['C1 control', ['echo', 'a\u0085b']], ['lone surrogate', ['echo', 'a\ud800b']], ['non-string', ['echo', 1]], ['not an array', 'echo hi'],
    ['too long', ['echo', 'x'.repeat(64000)]], ['too many', Array(257).fill('x')],
  ])('rejects %s', (_name, argv) => {
    expect(() => containedCommandFromArgv(argv as string[])).toThrow('CONTAINED_ARGV_INVALID');
  });
});

describe('neutral execution registration', () => {
  const image: ContainedImageReceipt = { version: 1, daemonId: 'daemon', baseImageId: 'sha256:' + 'a'.repeat(64), imageId: 'sha256:' + 'b'.repeat(64),
    contentDigest: 'c'.repeat(64), archiveDigest: 'd'.repeat(64), workingDirectory: '/osstack-candidate-00000000-0000-4000-8000-000000000000' };
  const options = (root: string) => ({ socketPath: join(root, 'missing.sock'), daemonId: 'daemon', baseImageId: image.baseImageId, journalRoot: root, authorizeStop: () => {}, authorizeRead: () => {} });
  it.each([{ owner_kind: 'graph_run', owner_id: 'mission-1' }, { owner_kind: 'contained_mission', owner_id: 'mission-2' }])('rejects an invocation bound to another owner %#', async owner => {
    const root = scratch('cv-binding'); let started = 0;
    const { registration } = registerContainedExecution(options(root), image, binding(), 'true', containedOwnerPort);
    await expect(registration.execute({ ...owner, invocationId: 'inv-1' }, new AbortController().signal, () => { started++; })).rejects.toThrow('CONTAINED_INVOCATION_BINDING');
    expect(started).toBe(0);
    await expect(registration.execute({ ...owner, invocationId: 'inv-1' }, new AbortController().signal, () => {})).rejects.toThrow('CONTAINED_INVOCATION_REPEATED');
    expect(await registration.confirmStopped('inv-1')).toEqual({ stopped: false });
  });
  it('uses the caller identity check and freezes the binding at registration', async () => {
    const root = scratch('cv-port'); const b = binding(); const seen: string[] = [];
    const { registration } = registerContainedExecution(options(root), image, b, 'true', { ...containedOwnerPort, matches: (_invocation, fixed) => { seen.push(fixed.owner_id); return false; } });
    b.owner_id = 'mutated';
    await expect(registration.execute({ owner_kind: 'contained_mission', owner_id: 'mutated', invocationId: 'inv' }, new AbortController().signal, () => {})).rejects.toThrow('CONTAINED_INVOCATION_BINDING');
    expect(seen).toEqual(['mission-1']);
  });
});

describe('neutral journal', () => {
  const write = (root: string, id: string, data: string, ref = sha(data)) => {
    const dir = join(root, sha(id)); mkdirSync(dir); writeFileSync(join(dir, 'binding.json'), JSON.stringify({ version: 1, bindingRef: ref, data }));
  };
  it('reads canonical identities and rejects non-canonical or mismatched ones', () => {
    const root = scratch('cv-journal');
    write(root, 'ok', canonicalJson({ b: 1, a: 'x' })); expect(readContainedJournal(root, 'ok').identity).toEqual({ a: 'x', b: 1 });
    write(root, 'order', '{"b":1,"a":"x"}'); expect(() => readContainedJournal(root, 'order')).toThrow('CONTAINED_BINDING_NOT_CANONICAL');
    write(root, 'surrogate', '{"a":"\\ud800"}'); expect(() => readContainedJournal(root, 'surrogate')).toThrow('CONTAINED_BINDING_NOT_CANONICAL');
    write(root, 'ref', '{"a":1}', 'f'.repeat(64)); expect(() => readContainedJournal(root, 'ref')).toThrow('CONTAINED_BINDING_MISMATCH');
    const link = join(scratch('cv-link'), 'root'); symlinkSync(root, link); expect(() => readContainedJournal(link, 'ok')).toThrow('CONTAINED_ROOT_CHANGED');
  });
});

describe('candidate export', () => {
  const repo = (label: string) => {
    const root = scratch(label);
    const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: root }).toString().trim();
    git('init', '-q'); writeFileSync(join(root, 'file'), 'candidate'); writeFileSync(join(root, 'run.sh'), '#!/bin/sh\n'); execFileSync('chmod', ['755', join(root, 'run.sh')]);
    return { root, git };
  };
  it('exports regular files from an immutable revision', () => {
    const { root, git } = repo('cv-export'); git('add', '.'); git('commit', '-qm', 'one'); const head = git('rev-parse', 'HEAD');
    writeFileSync(join(root, 'file'), 'changed after commit');
    expect(exportContainedCandidate(root, head).map(f => [f.path, f.mode, Buffer.from(f.bytes).toString()])).toEqual([['file', '100644', 'candidate'], ['run.sh', '100755', '#!/bin/sh\n']]);
  });
  it.each(['symlink', 'submodule'])('rejects a %s with the existing error code on both paths', async kind => {
    const { root, git } = repo(`cv-${kind}`);
    if (kind === 'symlink') symlinkSync('file', join(root, 'link'));
    git('add', '.');
    if (kind === 'submodule') git('update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},vendor/sub`);
    git('commit', '-qm', kind); const head = git('rev-parse', 'HEAD'); let authorized = 0;
    const host = { socketPath: join(root, 'missing.sock'), daemonId: 'daemon', baseImageId: 'sha256:' + 'a'.repeat(64) };
    expect(() => exportContainedCandidate(root, head)).toThrow('CONTAINED_CANDIDATE_REGULAR_FILES_REQUIRED');
    await expect(prepareContainedCandidateImage(host, root, head, () => { authorized++; })).rejects.toThrow('CONTAINED_CANDIDATE_REGULAR_FILES_REQUIRED');
    await expect(prepareGraphContainedImage({ ...host, journalRoot: root, authorizeRead: () => {}, authorizeStop: () => {} }, root, head, () => { authorized++; })).rejects.toThrow('CONTAINED_CANDIDATE_REGULAR_FILES_REQUIRED');
    expect(authorized).toBe(0);
  });
});
