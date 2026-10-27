import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { MethodMaterial } from './method-materials.js';
import { GateEvidence, MigrationSpec, OracleLifecycle, schemaSpecDigest } from './joint-lifecycle.js';
import { RecoveryReceipt, RecoveryRequest, RecoveryProofEnvelope, recoverySubjectDigest } from './joint-recovery.js';
import { CheckBinding, MethodBinding, ArtifactRequirements, ContextReceipt } from './method-binding.js';
import { CheckRegistry, SourceSnapshot, sourceSnapshotDigest, checkRegistryDigest } from './joint-evidence.js';
const hash = 'a'.repeat(64);
const cases = JSON.parse(readFileSync(new URL('../fixtures/joint/contracts.json', import.meta.url), 'utf8')).fixtures as Array<{id:string;payload:Record<string,unknown>}>;
const original = (id: string) => structuredClone(cases.find(f => f.id === id)!.payload);
const materials = [
  { kind: 'material:intent_frame', task_id:'t',intent_revision:0,goals:['fix'],non_goals:[],observations:[],hypotheses:[],unknowns:['cause'],source_refs:[] },
  { kind: 'material:grounding',facts:[],inferences:[],unknowns:[],source_refs:[] },
  { kind: 'material:impact_map',changed_surfaces:['cli'],assumptions:[],check_refs:['c'] },
  { kind: 'material:verification_plan',scenario_refs:['s'],required_checks:['c'],environment_refs:['e'] },
  { kind: 'material:review_dispositions',finding_ref:'f',decision:'reject',rationale:'evidence',evidence_refs:['e'] },
  { kind: 'material:decision_trail',revision:0,supersedes:null,decision:'keep',evidence_refs:['e'] },
  { kind: 'material:feature_map',entry:'cli',preconditions:[],actions:['run'],observable_end:'exit',recovery:['preserve'],owner:'o' },
  { kind: 'material:experiment_result',protocol:'p',arms:[{id:'a',candidate_digest:hash,observation_refs:['a']},{id:'b',candidate_digest:hash,observation_refs:['b']}],ledger:'l',oracle_digest:hash,result:'inconclusive',uncertainty:'one sample' },
  { kind: 'material:usage_sketch',caller:'c',input:'i',output:'o',errors:[],alternatives:[] },
  { kind: 'material:prototype_decision',hypothesis:'h',observations:['o'],decision:'stop',limits:['l'] },
];
describe('material body registry', () => {
  for (const material of materials) it(material.kind, () => {
    const body = {schema_version:1,...material};
    expect(MethodMaterial.safeParse(body).success).toBe(true);
    expect(MethodMaterial.safeParse({...body, publication:'push'}).success).toBe(false);
    for (const field of Object.keys(body)) {
      const missing: Record<string,unknown> = {...body}; delete missing[field];
      expect(MethodMaterial.safeParse(missing).success, field).toBe(false);
    }
  });
});
const oracle = {kind:'oracle_lifecycle',schema_version:1,oracle_id:'o',revision:1,status:'executed',authors:['author'],reviewers:['reviewer'],implementation_principals:['implementer'],custodian:'custodian',critical_safety:true,pinned_digest:hash,freeze_record_ref:'freeze',frozen_at_ms:10,candidate_created_at_ms:11,candidate_sha:'a'.repeat(40),support_profile_digest:hash,result_ref:'result',executed_at_ms:12};
describe('oracle and gate lifecycle', () => {
  it('requires distinct authors, reviewers, implementers and independent custodian', () => {
    expect(OracleLifecycle.safeParse(oracle).success).toBe(true);
    for (const patch of [{authors:['implementer']},{reviewers:['author']},{reviewers:[]},{custodian:'author'},{custodian:'implementer'},{frozen_at_ms:11},{executed_at_ms:9}]) expect(OracleLifecycle.safeParse({...oracle,...patch}).success).toBe(false);
  });
  it('requires executed evidence bound to the exact candidate and profile before pass', () => {
    const gate = {kind:'gate_evidence',schema_version:1,gate_id:'JA01',stage:'merge',candidate_sha:oracle.candidate_sha,support_profile_digest:hash,dependency_evidence_refs:[],oracle,result:'passed',evidence_refs:['e'],verifier_ref:'v',observed_at_ms:12};
    expect(GateEvidence.safeParse(gate).success).toBe(true);
    expect(GateEvidence.safeParse({...gate,candidate_sha:'b'.repeat(40)}).success).toBe(false);
    expect(GateEvidence.safeParse({...gate,oracle:{kind:'oracle_lifecycle',schema_version:1,oracle_id:'o',revision:1,status:'unassigned'}}).success).toBe(false);
  });
  it('freezes adjacent migration lineage and makes table order irrelevant', () => {
    const spec = {kind:'migration_spec',schema_version:1,schema_change_id:'bootstrap',source_schema:47,target_schema:48,ddl_digest:hash,fixture_digest:hash,source_schema_digest:hash,target_schema_digest:hash,expected_lineage_tables:['b','a']};
    expect(schemaSpecDigest(spec)).toBe(schemaSpecDigest({...spec,expected_lineage_tables:['a','b']}));
    expect(MigrationSpec.safeParse({...spec,target_schema:49}).success).toBe(false);
    expect(MigrationSpec.safeParse({...spec,expected_lineage_tables:['a','a']}).success).toBe(false);
  });
});
describe('recovery decision matrix', () => {
  const subject = {kind:'effect' as const,home_id:'fixture-home',effect_id:'fixture-ref'};
  const subject_digest = recoverySubjectDigest(subject);
  const proof = {record_ref:'proof',type:'invocation_contained',effect_id:subject.effect_id,subject_digest,evidence_digest:hash,producer_ref:'trusted-ref'};
  it.each(['reserved','dispatch_committed','legacy_unknown','broker_unknown'])('restricts decisions for %s', phase => {
    for (const decision of ['preserve_unknown','proven_not_started','proven_stopped','applied_observed']) {
      const v = original('valid-recovery_receipt');
      const type = {preserve_unknown:'invocation_contained',proven_not_started:'cancelled_before_dispatch',proven_stopped:'invocation_contained',applied_observed:'applied_completion'}[decision];
      Object.assign(v,{prior_phase:phase,decision,proof_refs:decision==='preserve_unknown'?[]:['proof'],proofs:decision==='preserve_unknown'?[]:[{...proof,type}]});
      const allowed = phase === 'reserved' ? ['preserve_unknown','proven_not_started'] : phase === 'dispatch_committed' ? ['preserve_unknown','proven_stopped','applied_observed'] : [];
      expect(RecoveryReceipt.safeParse(v).success, `${phase}/${decision}`).toBe(allowed.includes(decision));
    }
  });
  it('rejects a mismatched subject or proof digest', () => {
    const v = {...original('valid-recovery_receipt'),decision:'proven_stopped',proof_refs:['proof'],proofs:[proof]};
    expect(RecoveryReceipt.safeParse(v).success).toBe(true);
    expect(RecoveryReceipt.safeParse({...v,subject_digest:hash}).success).toBe(false);
    expect(RecoveryReceipt.safeParse({...v,proofs:[{...proof,effect_id:'different'}]}).success).toBe(false);
  });
  it('client cannot claim operator or phase, envelope must bind subject', () => {
    const r = {kind:'recovery_request',schema_version:1,request_id:'r',if_revision:0,subject,decision:'preserve_unknown',proof_refs:[],schema_spec_digest:hash};
    expect(RecoveryRequest.safeParse(r).success).toBe(true);
    expect(RecoveryRequest.safeParse({...r,operator_ref:'admin'}).success).toBe(false);
    const e = {kind:'recovery_proof',schema_version:1,subject,proof,owner_generation:1,observed_at_ms:1,record_ref:'proof',authorization_ref:'a',binding_generation:1,support_profile_digest:hash,prior_phase:'dispatch_committed',schema_spec_digest:hash,recovery_build_digest:hash};
    expect(RecoveryProofEnvelope.safeParse(e).success).toBe(true);
    expect(RecoveryProofEnvelope.safeParse({...e,proof:{...proof,subject_digest:hash}}).success).toBe(false);
  });
});
it('enforces uniqueness and role/byte constraints beyond generated shapes', () => {
  const b=original('valid-method_binding'); const roles=b.role_materials as unknown[];
  expect(MethodBinding.safeParse({...b,role_materials:[roles[0],roles[0],roles[2]]}).success).toBe(false);
  const c=original('valid-check_binding');const checks=c.checks as unknown[];
  expect(CheckBinding.safeParse({...c,checks:[checks[0],checks[0]]}).success).toBe(false);
  const a=original('valid-artifact_requirements');const req=a.requirements as unknown[];
  expect(ArtifactRequirements.safeParse({...a,requirements:[req[0],req[0]]}).success).toBe(false);
  expect(ContextReceipt.safeParse({...original('valid-context_receipt'),method_bytes:100,prompt_bytes:99}).success).toBe(false);
});
it('rejects source traversal and conflicting check outcome sets', () => {
  const s={kind:'source_snapshot',schema_version:1,pin:original('valid-source_pin'),files:[{path:'../outside',mode:'100644',blob:'a'.repeat(40)}],dependencies:[]};
  expect(SourceSnapshot.safeParse(s).success).toBe(false);
  const c={kind:'check_registry',schema_version:1,entries:[{ref:`sha256:${hash}`,command_bytes_sha256:hash,pass_codes:[0],fail_codes:[0]}]};
  expect(CheckRegistry.safeParse(c).success).toBe(false);
});

it('normalizes declared source/check sets and retains byte binding', () => {
  const file=(path:string)=>({path,mode:'100644',blob:'a'.repeat(40)});
  const source={kind:'source_snapshot',schema_version:1,pin:original('valid-source_pin'),files:[file('z'),file('a')],dependencies:[]};
  expect(sourceSnapshotDigest(source)).toBe(sourceSnapshotDigest({...source,files:[...source.files].reverse()}));
  const entry=(ch:string)=>({ref:`sha256:${ch.repeat(64)}`,command_bytes_sha256:ch.repeat(64),pass_codes:[0],fail_codes:[1]});
  const registry={kind:'check_registry',schema_version:1,entries:[entry('b'),entry('a')]};
  expect(checkRegistryDigest(registry)).toBe(checkRegistryDigest({...registry,entries:[...registry.entries].reverse()}));
  expect(checkRegistryDigest(registry)).not.toBe(checkRegistryDigest({...registry,entries:[entry('c'),entry('a')]}));
});
it('binds orphan containment proof to exact broker, lease, schema and broker generation', () => {
  const receipt=original('valid-broker-recovery');
  const proof={record_ref:'proof',type:'invocation_contained',evidence_digest:hash,producer_ref:'broker-measurement',subject_digest:receipt.subject_digest,broker_identity:{broker_id:'broker-1',lease_id:'lease-1',schema:48,owner_generation:1}};
  Object.assign(receipt,{decision:'proven_stopped',proof_refs:['proof'],proofs:[proof]});
  expect(RecoveryReceipt.safeParse(receipt).success).toBe(true);
  for (const change of [{broker_id:'other'},{lease_id:'other'},{schema:47},{owner_generation:2}]) {
    expect(RecoveryReceipt.safeParse({...receipt,proofs:[{...proof,broker_identity:{...proof.broker_identity,...change}}]}).success).toBe(false);
  }
});
it('freezes oracle before any candidate exists and later binds execution to custody', () => {
  const {candidate_sha:_sha,candidate_created_at_ms:_created,support_profile_digest:_profile,result_ref:_result,executed_at_ms:_executed,...body}=oracle;
  expect(OracleLifecycle.safeParse({...body,status:'frozen'}).success).toBe(true);
  expect(OracleLifecycle.safeParse({...body,status:'frozen',freeze_record_ref:undefined}).success).toBe(false);
});
it('rejects contradictory or unlinked proofs and oversized request IDs before a receipt is needed', () => {
  const v=original('valid-recovery_receipt');
  expect(RecoveryReceipt.safeParse({...v,proof_refs:['orphan']}).success).toBe(false);
  const r={kind:'recovery_request',schema_version:1,request_id:'x'.repeat(257),if_revision:0,subject:v.subject,decision:'preserve_unknown',proof_refs:[],schema_spec_digest:hash};
  expect(RecoveryRequest.safeParse(r).success).toBe(false);
  expect(RecoveryRequest.safeParse({...r,request_id:'x',subject:{kind:'effect',home_id:'h',effect_id:'x'.repeat(257)}}).success).toBe(false);
});
it('rejects listed source manifest syntax and collision hazards', () => {
  const file=(path:string,mode='100644')=>({path,mode,blob:'a'.repeat(40)});
  const base={kind:'source_snapshot',schema_version:1,pin:original('valid-source_pin'),dependencies:[]};
  for (const files of [[file('.git/hooks/post-checkout')],[file('A'),file('a')],[file('é'),file('e\u0301')],[file('a'),file('a/b')],[file('link','120000')],[file('module','160000')]]) expect(SourceSnapshot.safeParse({...base,files}).success).toBe(false);
});
it('pins effect, legacy and broker identity rejection independently of other phase checks', () => {
  const effect=original('valid-recovery_receipt');
  for(const patch of [{binding_generation:null},{support_profile_digest:null}]) expect(RecoveryReceipt.safeParse({...effect,...patch}).success).toBe(false);
  const attention=original('valid-recovery-attention-subject');
  expect(RecoveryReceipt.safeParse(attention).success).toBe(true);
  expect(RecoveryReceipt.safeParse({...attention,effect_id:'unexpected'}).success).toBe(false);
  const broker=original('valid-broker-recovery');
  expect(RecoveryReceipt.safeParse(broker).success).toBe(true);
  const brokerIdentity={broker_id:'broker-1',lease_id:'lease-1',schema:48,owner_generation:1};
  const proof={record_ref:'proof',type:'invocation_contained',evidence_digest:hash,producer_ref:'p',subject_digest:broker.subject_digest,broker_identity:brokerIdentity};
  for(const [decision,type] of [['applied_observed','applied_completion'],['proven_not_started','cancelled_before_dispatch']]) expect(RecoveryReceipt.safeParse({...broker,decision,proof_refs:['proof'],proofs:[{...proof,type}]}).success).toBe(false);
  expect(RecoveryReceipt.safeParse({...broker,target:'home'}).success).toBe(false);
  const {broker_identity:_identity,...missingIdentity}=proof;
  expect(RecoveryReceipt.safeParse({...broker,decision:'proven_stopped',proof_refs:['proof'],proofs:[missingIdentity]}).success).toBe(false);
  for(const receipt of [effect,attention]) {
    const p={...proof,subject_digest:receipt.subject_digest,...(receipt===effect?{effect_id:effect.effect_id}:{})};
    expect(RecoveryReceipt.safeParse({...receipt,decision:'proven_stopped',proof_refs:['proof'],proofs:[p]}).success).toBe(false);
  }
});
