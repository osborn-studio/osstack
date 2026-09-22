import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { changesetPolicyDigest, validateChangesetInput, validateChangesetProposal } from './changeset.js';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const policy = { exactPaths: [], directoryPrefixes: ['src'], denyPaths: [], denyPrefixes: ['src/private'] };
const binding = { runId: 'run', effectKey: 'a'.repeat(64), generation: 1, baseRevision: 'b'.repeat(40), treeRevision: 'c'.repeat(40), profileDigest: 'd'.repeat(64), grantDigest: 'e'.repeat(64), programDigest: 'f'.repeat(64), policyDigest: changesetPolicyDigest(policy) };
const manifest = { schemaVersion: 1, binding, entries: [
  { path: 'src/old.ts', state: 'present', content: 'old', sha256: sha('old'), mode: '100755' },
  { path: 'src/new.ts', state: 'absent' },
  { path: 'src/remove.ts', state: 'present', content: 'remove', sha256: sha('remove'), mode: '100644' },
] };
const proposal = { kind: 'propose', changes: [
  { kind: 'replace', path: 'src/old.ts', expectedSha256: sha('old'), content: 'new' },
  { kind: 'create', path: 'src/new.ts', content: 'created' },
  { kind: 'delete', path: 'src/remove.ts', expectedSha256: sha('remove') },
] };
const validate = (p: unknown = proposal, m: unknown = manifest, rules: unknown = policy, expected: unknown = binding) => validateChangesetProposal(p, m, rules, expected);
describe('experimental changeset contract (no execution authority)', () => {
  it('accepts a bound three-file proposal and freezes an order-independent digest', () => {
    const a = validate(); const b = validate({ ...proposal, changes: [...proposal.changes].reverse() });
    expect(a).toEqual(b);
    // Cross-checked with Python hashlib + sorted compact JSON, independent of workerCanonical.
    expect(a).toMatchObject({
      manifestDigest: '8d8b8fa8d6e062b010c85778b93331524b6d89c2f0d85c6e45e389befd6d5b1f',
      policyDigest: '9955c057ba098b605f79be471591f37a2da1cdaeaedb093909103fdac9a35db6',
      proposalDigest: '59f89c049902d8299d0a407240e4fe1c54fd855ef163f37bdab20e659d9e5e20',
    });
    expect(Object.isFrozen(a.proposal)).toBe(true);
    expect(() => { (a.proposal as { kind: string }).kind = 'oops'; }).toThrow();
    const changedPolicy = { ...policy, denyPaths: ['src/other.ts'] };
    expect(() => validate(proposal, manifest, changedPolicy)).toThrow('CHANGESET_POLICY_MISMATCH');
    const changedBinding = { ...binding, policyDigest: changesetPolicyDigest(changedPolicy) };
    expect(validate(proposal, {...manifest,binding:changedBinding}, changedPolicy, changedBinding).proposalDigest).not.toBe(a.proposalDigest);
    expect(a.manifest.entries[0]!.path).toBe('src/new.ts');
    expect(Object.isFrozen(a.manifest.entries[0])).toBe(true);
    expect(Object.isFrozen(a.policy.directoryPrefixes)).toBe(true);
  });
  it.each(['../x','/src/a','src//a','src/./a','src/../a','src/.git/a','src/a/','src/a\\b','src/CON.ts','src/a.','src/ſecrets','src/é.ts','src/a\u0000'])('rejects nonportable path %s', path => {
    expect(() => validate({kind:'propose',changes:[{kind:'create',path,content:''}]}, {...manifest,entries:[{path,state:'absent'}]})).toThrow();
  });
  it.each(Object.keys(binding))('rejects mismatched binding %s', key => {
    expect(() => validate(proposal, manifest, policy, {...binding,[key]:key==='generation'?2:'0'.repeat(64)})).toThrow();
  });
  it('requires exact manifest preimages and supported modes', () => {
    for (const change of [ {...proposal.changes[0],expectedSha256:sha('wrong')}, {...proposal.changes[2],expectedSha256:sha('wrong')}, {kind:'create',path:'src/old.ts',content:''}, {kind:'replace',path:'src/new.ts',expectedSha256:sha(''),content:''}, {kind:'create',path:'src/unlisted.ts',content:''}, {...proposal.changes[0],mode:'100644'}, {...proposal.changes[2],content:''} ]) expect(() => validate({kind:'propose',changes:[change]})).toThrow();
    for (const mode of ['120000','160000','040000']) expect(() => validate(proposal, {...manifest,entries:[{...manifest.entries[0],mode},...manifest.entries.slice(1)]})).toThrow();
    expect(() => validate(proposal,{...manifest,entries:[{...manifest.entries[0],content:'changed'},...manifest.entries.slice(1)]})).toThrow();
  });
  it('rejects duplicate, parent-child and case-aliased directories', () => {
    for (const paths of [['src/a','src/a'],['src/a','src/a/b'],['src/A/x','src/a/y']]) {
      expect(() => validate({kind:'propose',changes:paths.map(path=>({kind:'create',path,content:''}))},{...manifest,entries:paths.map(path=>({path,state:'absent'}))})).toThrow();
    }
  });
  it('enforces deny first and segment boundaries; allow is case-sensitive', () => {
    for (const [path,rules] of [ ['src/private/a',policy], ['srcfoo/a',policy], ['SRC/a',policy], ['src/new.ts',{...policy,denyPaths:['SRC/NEW.TS']}], ['src/new.ts',{...policy,exactPaths:['src/new.ts'],directoryPrefixes:[],denyPrefixes:['src']}] ] as const) {
      const authorized = {...binding,policyDigest:changesetPolicyDigest(rules)};
      expect(() => validate({kind:'propose',changes:[{kind:'create',path,content:''}]},{...manifest,binding:authorized,entries:[{path,state:'absent'}]},rules,authorized)).toThrow('CHANGESET_PATH_DENIED');
    }
  });
  it('bounds changes, UTF-8 bytes, and rejects noops, NUL and unpaired surrogates', () => {
    const single = (content: string) => ({kind:'propose',changes:[{kind:'create',path:'src/new.ts',content}]});
    expect(validate(single('é'.repeat(8192)))).toBeDefined();
    for (const value of [single('é'.repeat(8192)+'x'),single('\u0000'),single('\ud800'),{kind:'propose',changes:[]},{kind:'propose',changes:Array(9).fill(proposal.changes[0])},{kind:'noop'}, {kind:'read'},{kind:'shell'}, {kind:'propose',changes:[{...proposal.changes[0],content:'old'}]}]) expect(() => validate(value)).toThrow();
  });
  it('accepts eight changes and bounds aggregate content and manifest snapshots', () => {
    const targets = Array.from({length:8}, (_, i) => ({path:`src/f${i}`,state:'absent'}));
    const changes = targets.map(e=>({kind:'create',path:e.path,content:'x'.repeat(2048)}));
    expect(validate({kind:'propose',changes},{...manifest,entries:targets})).toBeDefined();
    expect(() => validate({kind:'propose',changes:[{...changes[0],content:'x'.repeat(2049)},...changes.slice(1)]},{...manifest,entries:targets})).toThrow('CHANGESET_CONTENT_LIMIT');
    const many = Array.from({length:17}, (_, i) => ({path:`src/f${i}`,state:'absent'}));
    expect(() => validate({kind:'cannot_complete',reason:'insufficient_context'},{...manifest,entries:many})).toThrow();
    const entries = Array.from({length:3}, (_, i) => ({path:`src/f${i}`,state:'present',content:'x'.repeat(12000),sha256:sha('x'.repeat(12000)),mode:'100644'}));
    expect(() => validate({kind:'cannot_complete',reason:'insufficient_context'},{...manifest,entries})).toThrow('CHANGESET_MANIFEST_LIMIT');
  });
  it('supports bounded cannot_complete without an arbitrary text channel', () => {
    expect(validate({kind:'cannot_complete',reason:'insufficient_context'}).proposal).toEqual({kind:'cannot_complete',reason:'insufficient_context'});
    expect(() => validate({kind:'cannot_complete',reason:'insufficient_context',detail:'anything'})).toThrow();
  });
  it('does not invoke input accessors', () => {
    const touched=vi.fn();expect(() => validate({get kind(){touched();return 'propose';}})).toThrow();expect(touched).not.toHaveBeenCalled();
  });
});

it('validates and freezes input before a provider response exists, preserving v1 digests', () => {
  const input = validateChangesetInput(manifest, policy, binding);
  const full = validate();
  expect(input).toEqual({ manifest: full.manifest, policy: full.policy, manifestDigest: full.manifestDigest, policyDigest: full.policyDigest });
  expect(Object.isFrozen(input.manifest.entries)).toBe(true);
  expect(() => validateChangesetInput(manifest, policy, { ...binding, generation: 2 })).toThrow('CHANGESET_BINDING_MISMATCH');
});
