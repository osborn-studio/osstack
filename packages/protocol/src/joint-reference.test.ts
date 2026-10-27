import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
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
  domains: string[]; wire_cases: WireCase[]; helper_cases: HelperCase[];
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
  it('covers every registered domain and every protocol digest constructor in the matrix', () => {
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
    expect(() => jointDigest('osstack.joint.unregistered.v1', {})).toThrow('UNKNOWN_JOINT_DIGEST_DOMAIN');
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
