import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { decodeJointContractBytesAs } from './joint-contracts.js';
import { describe, expect, it } from 'vitest';
import { bindingDigest, trialRootEffectId, trialConsumptionInputDigest } from './method-binding.js';
import { recoverySubjectDigest, recoveryRequestInputDigest } from './joint-recovery.js';
import { schemaSpecDigest } from './joint-lifecycle.js';
import { JOINT_DIGEST_DOMAINS, parseJointJson, canonicalJointJson, jointDigest, parseJointJsonBytes } from './joint-json.js';
import { methodProposalDigest, supportProfileDigest, artifactRequirementsDigest, roleRequirementsDigest, checkBindingDigest, methodRecipeDigest } from './method-binding.js';
import { sourceSnapshotDigest, methodInputDigest, environmentDigest, scenarioDigest, checkRegistryDigest } from './joint-evidence.js';
import { intentDigest } from './method-materials.js';
const helpers: Record<string,(input:unknown)=>string> = {bindingDigest,trialRootEffectId,trialConsumptionInputDigest,recoverySubjectDigest,recoveryRequestInputDigest,schemaSpecDigest};
it('matches independent Python vectors and keeps the domain registry closed', () => {
  const fixture = parseJointJson(readFileSync(new URL('../fixtures/joint/reference-vectors.json', import.meta.url), 'utf8')) as {vectors:Array<{helper:string;input:unknown;expected:string}>};
  for(const v of fixture.vectors) expect(helpers[v.helper]!(v.input),v.helper).toBe(v.expected);
  const catalog=parseJointJson(readFileSync(new URL('../fixtures/joint/digest-catalog.json', import.meta.url), 'utf8')) as {domains:Array<{domain:string}>};
  expect([...JOINT_DIGEST_DOMAINS].sort()).toEqual(catalog.domains.map(d=>d.domain).sort());
});

it('runs the independent Python reference with no dependency on J11 files', () => {
  expect(execFileSync('python3',['-I',fileURLToPath(new URL('../scripts/joint-reference-vectors.py',import.meta.url)),'--check'],{encoding:'utf8',timeout:10000})).toContain('independent vectors verified');
});
it('does not silently accept corrupt vectors under Python optimization', () => {
  const script=fileURLToPath(new URL('../scripts/joint-reference-vectors.py',import.meta.url));
  const probe=`import json,pathlib,runpy,sys
original=pathlib.Path.read_text
def corrupted(path,*args,**kwargs):
 value=original(path,*args,**kwargs)
 if path.name=='reference-vectors.json':
  data=json.loads(value);data['vectors'][0]['expected']='corrupted';return json.dumps(data)
 return value
pathlib.Path.read_text=corrupted
sys.argv=[sys.argv[1],'--check']
runpy.run_path(sys.argv[0],run_name='__main__')`;
  expect(()=>execFileSync('python3',['-I','-O','-c',probe,script],{encoding:'utf8',timeout:10000,stdio:'pipe'})).toThrow('FAIL: bindingDigest');
});

// JA59 regression evidence. The oracle is language-independent, not an
// authenticated independent principal; passing these tests never grants a gate.

type WireCase = { id: string; bytes_hex: string; accepted: boolean; canonical?: string; hashes?: Record<string, string>; error?: string };
type HelperCase = { id: string; helper: string; domain: string; input: unknown; expected: string };
const acceptance = JSON.parse(readFileSync(new URL('../fixtures/joint/acceptance-oracle.json', import.meta.url), 'utf8')) as {
  domains: string[]; wire_cases: WireCase[]; helper_cases: HelperCase[]; not_applicable: Array<{domain: string; reason: string}>; boundary_cases: {max_wire_bytes: number; max_depth: number; expected_error: string};
};
const referenceOutput = JSON.parse(execFileSync('python3', ['-I', fileURLToPath(new URL('../scripts/joint-acceptance-oracle.py', import.meta.url))], {
  encoding: 'utf8', timeout: 10_000, maxBuffer: 1_048_576,
})) as { wire: WireCase[]; helpers: Array<{id: string; digest: string}>; authority: string };
const digestHelpers: Record<string, (input: unknown) => string> = {
  ...helpers, methodProposalDigest, supportProfileDigest, artifactRequirementsDigest,
  checkBindingDigest, methodRecipeDigest, sourceSnapshotDigest, methodInputDigest,
  environmentDigest, scenarioDigest, checkRegistryDigest, intentDigest,
  roleRequirementsDigest(input) {
    const row = input as { role: 'builder' | 'reviewer' | 'verifier'; requirements_digest: string };
    return roleRequirementsDigest(row.role, row.requirements_digest);
  },
};

describe('JA59 frozen cross-language wire and domain matrix', () => {
  it('covers every registered domain and the 18 declared protocol digest helpers', () => {
    expect(acceptance.wire_cases).toHaveLength(63);
    expect(acceptance.helper_cases).toHaveLength(18);
    expect(acceptance.domains).toHaveLength(20);
    expect(new Set(acceptance.wire_cases.map(row => row.id)).size).toBe(63);
    expect(createHash('sha256').update(readFileSync(new URL('../fixtures/joint/acceptance-oracle.json', import.meta.url))).digest('hex')).toBe('279c3ff6bc347913f62cf6ba375b44f4d2a8a30c923de55722041b71b8950bbd');
    expect([...new Set([...acceptance.helper_cases.map(row => row.domain), ...acceptance.not_applicable.map(row => row.domain)])].sort()).toEqual([...acceptance.domains].sort());
    expect(acceptance.not_applicable.every(row => row.reason.includes('J02'))).toBe(true);
    expect([...acceptance.domains].sort()).toEqual([...JOINT_DIGEST_DOMAINS].sort());
    expect(acceptance.helper_cases.map(row => row.helper).sort()).toEqual(Object.keys(digestHelpers).sort());
    expect(referenceOutput.authority).toBe('component_regression_only');
  });
  for (const row of acceptance.wire_cases) it(row.id, () => {
    const raw = Buffer.from(row.bytes_hex, 'hex');
    const python = referenceOutput.wire.find(result => result.id === row.id)!;
    expect(python.accepted).toBe(row.accepted);
    if (!row.accepted) {
      expect(() => parseJointJsonBytes(raw)).toThrow(row.error);
      expect(() => decodeJointContractBytesAs('method_proposal', raw)).toThrow(row.error);
      expect(python.error).toBe(row.error);
      return;
    }
    const value = parseJointJsonBytes(raw);
    expect(canonicalJointJson(value)).toBe(row.canonical);
    expect(python.canonical).toBe(row.canonical);
    for (const domain of acceptance.domains) {
      expect(jointDigest(domain, value), domain).toBe(row.hashes![domain]);
      expect(python.hashes![domain], domain).toBe(row.hashes![domain]);
    }
    // The same bytes in different domains must never become interchangeable.
    expect(new Set(Object.values(row.hashes!)).size).toBe(acceptance.domains.length);
  });
  for (const row of acceptance.helper_cases) it(row.helper, () => {
    expect(digestHelpers[row.helper]!(structuredClone(row.input))).toBe(row.expected);
    expect(referenceOutput.helpers.find(result => result.id === row.id)?.digest).toBe(row.expected);
  });
  it('retains null/absent, Unicode normalization and array-order distinctions', () => {
    for (const [left, right] of [['null-field', 'absent-field'], ['composed', 'decomposed'], ['array-order', 'array-reverse']]) {
      const a = acceptance.wire_cases.find(row => row.id === left)!;
      const b = acceptance.wire_cases.find(row => row.id === right)!;
      for (const domain of acceptance.domains) expect(a.hashes![domain]).not.toBe(b.hashes![domain]);
    }
    for (const domain of ['osstack.joint.unregistered.v1', 'osstack.joint.support-profile.v1', 'OSSTACK.joint.intent.v1', 'osstack.joint.intent.v1\n']) expect(() => jointDigest(domain, {})).toThrow('UNKNOWN_JOINT_DIGEST_DOMAIN');
  });

  it('enforces exact raw-byte size boundaries at the parser and decoder', () => {
    const raw = Buffer.from(' '.repeat(acceptance.boundary_cases.max_wire_bytes - 2) + '{}');
    expect(parseJointJsonBytes(raw)).toEqual({});
    expect(() => parseJointJsonBytes(Buffer.concat([raw, Buffer.from(' ')]))).toThrow(acceptance.boundary_cases.expected_error);
    expect(() => decodeJointContractBytesAs('method_proposal', Buffer.concat([raw, Buffer.from(' ')]))).toThrow(acceptance.boundary_cases.expected_error);
  });
  it('retains declared-order arrays in additional schema-aware helpers', () => {
    for (const [helper, field] of [['supportProfileDigest', 'measurement_refs'], ['methodInputDigest', 'requested_materials'], ['environmentDigest', 'setup_fixture_digests'], ['intentDigest', 'goals'], ['artifactRequirementsDigest', 'requirements']]) {
      const row = acceptance.helper_cases.find(item => item.helper === helper)!;
      const reversed = structuredClone(row.input) as Record<string, unknown>;
      expect((reversed[field!] as unknown[]).length).toBeGreaterThan(1);
      (reversed[field!] as unknown[]).reverse();
      expect(digestHelpers[helper!]!(reversed)).not.toBe(row.expected);
    }
  });
  it('rejects corrupted new oracle expectations even with Python optimization', () => {
    const script = fileURLToPath(new URL('../scripts/joint-acceptance-oracle.py', import.meta.url));
    for (const expression of ["data['component_matrix'][0]['sample']['bytes']=2", "data['helper_cases'][0]['expected']='corrupted'", "data['wire_cases'][0]['hashes'][data['domains'][0]]='corrupted'"]) {
      const probe = `import json,pathlib,runpy,sys
original=pathlib.Path.read_bytes
def corrupted(path):
 raw=original(path)
 if path.name=='acceptance-oracle.json':
  data=json.loads(raw);${expression};return json.dumps(data).encode()
 return raw
pathlib.Path.read_bytes=corrupted
sys.argv=[sys.argv[1]]
runpy.run_path(sys.argv[0],run_name='__main__')`;
      expect(() => execFileSync('python3', ['-I', '-O', '-c', probe, script], {encoding: 'utf8', timeout: 10_000, stdio: 'pipe'})).toThrow('FAIL:');
    }
  });
  it('normalizes only explicitly declared sets while retaining recipe role order', () => {
    for (const [helper, field] of [['bindingDigest', 'role_materials'], ['sourceSnapshotDigest', 'files'], ['checkRegistryDigest', 'entries'], ['schemaSpecDigest', 'expected_lineage_tables']]) {
      const row = acceptance.helper_cases.find(item => item.helper === helper)!;
      const changed = structuredClone(row.input) as Record<string, unknown>;
      (changed[field!] as unknown[]).reverse();
      expect(digestHelpers[helper!]!(changed)).toBe(row.expected);
    }
    const recipe = structuredClone(acceptance.helper_cases.find(row => row.helper === 'methodRecipeDigest')!.input) as Record<string, unknown>;
    const original = methodRecipeDigest(recipe);
    (recipe.role_materials as unknown[]).reverse();
    expect(methodRecipeDigest(recipe)).not.toBe(original);
  });
});
