import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { bindingDigest, trialRootEffectId, trialConsumptionInputDigest } from './method-binding.js';
import { recoverySubjectDigest, recoveryRequestInputDigest } from './joint-recovery.js';
import { schemaSpecDigest } from './joint-lifecycle.js';
import { JOINT_DIGEST_DOMAINS, parseJointJson } from './joint-json.js';
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
