import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// J11 executable storage specification. No runtime recovery entry point is installed.
import { createHash } from 'node:crypto';
import { readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createScratchDirSync } from '../scratch.js';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { schemaSpecDigest, MigrationSpec, parseJointJson, canonicalJointJson, decodeJointContractAs, RecoveryReceipt, recoverySubjectDigest, verifyRecoveryProofEnvelopes } from '@osstack/protocol/joint';
import { CURRENT_SCHEMA_VERSION } from './migrations.js';
import { runMigrations } from './db.js';
const path = new URL('../../fixtures/operator-recovery/', import.meta.url);
const bytes = (name: string) => readFileSync(new URL(name, path));
const read = (name: string) => readFileSync(new URL(name, path), 'utf8');
const ddl = read('bootstrap.sql'); const source = read('source-hold.sql');
const sha = (s: string | Uint8Array) => createHash('sha256').update(s).digest('hex');
function fixture(): Database.Database {
  const db = new Database(':memory:'); db.pragma('foreign_keys=ON'); db.pragma('synchronous=FULL');
  try { runMigrations(db); db.exec(source); return db; } catch (e) { db.close(); throw e; }
}
function tables(db: Database.Database): string[] { return (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND substr(name,1,7)<>'sqlite_' ORDER BY name").all() as {name:string}[]).map(r => r.name); }
const legacy = (db: Database.Database) => Object.fromEntries(tables(db).filter(t => !t.startsWith('operator_')).map(t => [t, db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all()]));
describe('J11 bootstrap candidate', () => {
  it('pins actual source version, exact DDL/fixture digests and complete table lineage', () => {
    expect(execFileSync('python3',['-I',fileURLToPath(new URL('../../../protocol/scripts/joint-reference-vectors.py',import.meta.url)),'--check','--recovery-root',fileURLToPath(path)],{encoding:'utf8',timeout:10000})).toContain('raw DDL/catalog hashes verified');
    const manifest = parseJointJson(read('manifest.json')) as {base_commit:string;spec:unknown;schema_spec_digest:string;future_storage_digest:string;source_lineage_tables:string[];source_schema:unknown;target_schema:unknown};
    expect(manifest.base_commit).toBe('69859eecfcc84af9d6eff755ed41243ca5f51f95');
    const spec = MigrationSpec.parse(manifest.spec);
    expect(CURRENT_SCHEMA_VERSION).toBe(47);
    expect(spec.source_schema).toBe(CURRENT_SCHEMA_VERSION);
    expect(spec.ddl_digest).toBe(sha(bytes('bootstrap.sql'))); expect(spec.fixture_digest).toBe(sha(bytes('source-hold.sql')));
    expect(manifest.schema_spec_digest).toBe(schemaSpecDigest(spec));
    expect(manifest.future_storage_digest).toBe(sha(bytes('future-storage.sql')));
    const db = fixture();
    try {
      expect(tables(db)).toEqual(manifest.source_lineage_tables);
      const before = legacy(db);
      const catalog = () => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE substr(name,1,7)<>'sqlite_' ORDER BY type,name").all();
      expect(catalog()).toEqual(manifest.source_schema);
      expect(sha(canonicalJointJson(catalog()))).toBe(spec.source_schema_digest);
      db.transaction(() => { db.exec(ddl); db.pragma('user_version=48'); })();
      expect(tables(db)).toEqual(spec.expected_lineage_tables);
      expect(catalog()).toEqual(manifest.target_schema);
      expect(sha(canonicalJointJson(catalog()))).toBe(spec.target_schema_digest);
      const oldObjects = (manifest.source_schema as Array<{name:string}>).map(o=>o.name);
      expect((catalog() as Array<{name:string;tbl_name:string}>).filter(o=>oldObjects.includes(o.name))).toEqual(manifest.source_schema);
      expect((catalog() as Array<{name:string;tbl_name:string}>).filter(o=>!oldObjects.includes(o.name)).every(o=>o.name.startsWith('operator_') && o.tbl_name.startsWith('operator_'))).toBe(true);
      expect(legacy(db)).toEqual(before);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(() => runMigrations(db)).toThrow('user_version=48');
    } finally { db.close(); }
  });
  it.each(['before_ddl','after_ddl','after_version'])('rolls back in-memory transaction interruption at %s atomically', step => {
    const db=fixture();
    try {
      const before=legacy(db);
      expect(() => db.transaction(() => {
        if (step==='before_ddl') throw Error('injected');
        db.exec(ddl);
        if (step==='after_ddl') throw Error('injected');
        db.pragma('user_version=48'); throw Error('injected');
      })()).toThrow('injected');
      expect(db.pragma('user_version',{simple:true})).toBe(47);
      expect(tables(db).some(t => t.startsWith('operator_'))).toBe(false);
      expect(legacy(db)).toEqual(before);
    } finally { db.close(); }
  });
  it('preserves immutable decisions and rejects request/revision collisions and invalid post-state', () => {
    const db=fixture();
    try {
      db.exec(ddl);
      const receipt = (revision=0, decision='preserve_unknown') => {
        const original = JSON.parse(readFileSync(new URL('../../../protocol/fixtures/joint/contracts.json', import.meta.url), 'utf8')).fixtures.find((f: {id:string})=>f.id==='valid-recovery-attention-subject').payload;
        const subject = {kind:'attention_action',home_id:'fixture-home',mission_id:'mission',action_id:'action',message_id:'msg'};
        return RecoveryReceipt.parse({...original, subject, subject_digest:recoverySubjectDigest(subject), if_revision:revision, request_id:`request-${revision}`, operator_ref:'operator', decision, proof_refs:[], proofs:[]});
      };
      const args = (r: ReturnType<typeof receipt>) => ['operator',r.request_id,'a'.repeat(64),r.subject_digest,canonicalJointJson(r.subject),r.if_revision,r.owner_generation,r.decision,'unknown',canonicalJointJson(r),r.observed_at_ms];
      const r=receipt(); const values=args(r);
      const sql='INSERT INTO operator_recovery_decisions VALUES(?,?,?,?,?,?,?,?,?,?,?)';
      db.prepare(sql).run(...values);
      // SQL rejects replay and conflict alike: J12 must look up and compare input_digest first.
      expect(()=>db.prepare(sql).run(...values.map((v,i)=>i===2?'b'.repeat(64):v))).toThrow('operator recovery history immutable or revision conflict');
      expect(db.prepare('SELECT input_digest FROM operator_recovery_decisions WHERE principal_ref=? AND request_id=?').get('operator',r.request_id)).toEqual({input_digest:'a'.repeat(64)});
      const stored=db.prepare('SELECT receipt_json FROM operator_recovery_decisions').get() as {receipt_json:string};
      expect(decodeJointContractAs('recovery_receipt', stored.receipt_json)).toEqual(r);
      for (const statement of [sql,sql.replace('INSERT','INSERT OR IGNORE'),sql+' ON CONFLICT DO NOTHING',sql.replace('INSERT','INSERT OR REPLACE'),sql.replace('INSERT INTO','REPLACE INTO'),sql+" ON CONFLICT(principal_ref,request_id) DO UPDATE SET post_state='unknown'"]) expect(()=>db.prepare(statement).run(...values)).toThrow();
      expect(()=>db.prepare(sql).run(...args(receipt(3)))).toThrow('revision conflict');
      expect(()=>db.prepare(sql).run(...args(receipt(1)).map((v,i)=>i===9?'{}':v))).toThrow();
      expect(()=>db.prepare(sql).run(...args(receipt(1)).map((v,i)=>i===5?1.5:v))).toThrow();
      expect(()=>db.prepare(sql).run(...args(receipt(1)).map((v,i)=>i===3?Buffer.from(String(v)):v))).toThrow();
      for(const field of ['if_revision','owner_generation','observed_at_ms','schema_version']) { const typed=receipt(1); const bad={...typed,[field]:String(typed[field as keyof typeof typed])}; expect(()=>db.prepare(sql).run(...args(typed).map((v,i)=>i===9?canonicalJointJson(bad):v))).toThrow(); }
      db.prepare(sql).run(...args(receipt(1)));
      expect(()=>db.exec("UPDATE operator_recovery_decisions SET post_state='unknown'")).toThrow('immutable');
      expect(()=>db.exec('DELETE FROM operator_recovery_decisions')).toThrow('immutable');
      // A terminal decision locks the chain, even if a later receipt claims unknown.
      const terminal = {...receipt(2),prior_phase:'dispatch_committed',decision:'proven_stopped',proof_refs:['proof'],proofs:[{record_ref:'proof',type:'invocation_contained',subject_digest:r.subject_digest,evidence_digest:'a'.repeat(64),producer_ref:'host'}]};
      const valid=RecoveryReceipt.parse(terminal);
      db.prepare(sql).run(...args(valid).map((v,i)=>i===8?'resolved_stopped':v));
      expect(()=>db.prepare(sql).run(...args(receipt(3)))).toThrow('revision conflict');
    } finally { db.close(); }
  });
  it('keeps method and goal templates separate from bootstrap and checks permit uniqueness', () => {
    const db=fixture();
    try {
      db.exec(ddl); expect(tables(db)).not.toContain('trial_permit_consumptions');
      db.exec(read('future-storage.sql'));
      const hash='a'.repeat(64);
      db.prepare("INSERT INTO joint_method_objects VALUES(?,'binding','immutable-ref',1,1)").run(hash);
      const insert=db.prepare("INSERT INTO trial_permit_consumptions(permit_id,scope_id,tenant_id,root_effect_id,binding_digest,request_id,input_digest,owner_generation,consumption_state,consumption_revision) VALUES(?,'scope','tenant',?,?,'request',?,1,'consumed',1)");
      insert.run('p','root',hash,hash);
      expect(()=>insert.run('p','root2',hash,hash)).toThrow();
      expect(()=>insert.run('p2','root',hash,hash)).toThrow();
      expect(()=>db.exec('DELETE FROM trial_permit_consumptions')).toThrow();
      for (const statement of [insert.source.replace('INSERT','INSERT OR REPLACE'),insert.source.replace('INSERT','INSERT OR IGNORE'),insert.source+' ON CONFLICT DO NOTHING']) expect(()=>db.prepare(statement).run('p','root',hash,hash)).toThrow();
      expect(()=>db.exec("UPDATE trial_permit_consumptions SET consumption_state='consumed',consumption_revision=2")).toThrow();
      expect(()=>db.exec("UPDATE joint_method_objects SET content_ref='changed'")).toThrow('immutable');
    } finally { db.close(); }
  });
});
it('enforces upgrade transition order, immutable owner and replacement resistance', () => {
  const db=fixture();
  try {
    db.exec(ddl);const sql='INSERT INTO operator_upgrade_journal VALUES(?,?,?,?,?,?,?)';
    const args=(revision:number,state:string,owner=1)=>['upgrade',revision,owner,'a'.repeat(64),state,'{}',1];
    expect(()=>db.prepare(sql).run(...args(0,'installed_inactive'))).toThrow();
    db.prepare(sql).run(...args(0,'fenced'));
    for (const s of [sql.replace('INSERT','INSERT OR IGNORE'),sql+' ON CONFLICT DO NOTHING',sql.replace('INSERT','INSERT OR REPLACE'),sql.replace('INSERT INTO','REPLACE INTO'),sql+" ON CONFLICT(operation_id,revision) DO UPDATE SET state='verified'"]) expect(()=>db.prepare(s).run(...args(0,'fenced'))).toThrow();
    expect(()=>db.prepare(sql).run(...args(1,'verified',2))).toThrow();
    expect(()=>db.prepare(sql).run(...args(1,'installed_inactive'))).toThrow();
    db.prepare(sql).run(...args(1,'verified'));db.prepare(sql).run(...args(2,'installed_inactive'));
    expect(()=>db.prepare(sql).run(...args(3,'failed'))).toThrow();
    expect(()=>db.exec('DELETE FROM operator_upgrade_journal')).toThrow('immutable');
  } finally {db.close();}
});
it('guards every immutable template table against replacement and foreign-kind pointers', () => {
  const db=fixture();
  try {
    db.exec(read('future-storage.sql'));const h='a'.repeat(64);
    const method="INSERT INTO joint_method_objects VALUES(?,'material','object-ref',1,1)";
    db.prepare(method).run(h);
    for(const sql of [method.replace('INSERT','INSERT OR IGNORE'),method+' ON CONFLICT DO NOTHING',method.replace('INSERT','INSERT OR REPLACE'),method.replace('INSERT INTO','REPLACE INTO'),method+" ON CONFLICT(digest) DO UPDATE SET content_ref='changed'"]) expect(()=>db.prepare(sql).run(h)).toThrow();
    const goal="INSERT INTO engineering_goal_specs VALUES('g',?,'{}',1)";db.prepare(goal).run(h);
    for(const sql of [goal.replace('INSERT','INSERT OR IGNORE'),goal+' ON CONFLICT DO NOTHING',goal.replace('INSERT','INSERT OR REPLACE'),goal.replace('INSERT INTO','REPLACE INTO'),goal+" ON CONFLICT(goal_id) DO UPDATE SET spec_json='null'"]) expect(()=>db.prepare(sql).run(h)).toThrow();
    db.prepare("INSERT INTO joint_method_objects VALUES(?,'binding','binding-ref',1,1)").run('b'.repeat(64));
    db.prepare("INSERT INTO joint_method_objects VALUES(?,'qualification','qualification-ref',1,1)").run('c'.repeat(64));
    db.prepare("INSERT INTO joint_method_active(scope_id,recipe_id,binding_digest,qualification_digest,revision,owner_generation) VALUES('valid','r',?,?,1,1)").run('b'.repeat(64),'c'.repeat(64));
    expect(()=>db.prepare("INSERT INTO joint_method_active(scope_id,recipe_id,binding_digest,qualification_digest,revision,owner_generation) VALUES('s','r',?,?,1,1)").run(h,h)).toThrow();
  } finally {db.close();}
});

it.each(["DROP TRIGGER attention_dispatch_no_rewind", "DELETE FROM attention_receipt_resolutions", "UPDATE attention_actions SET state='applied'"])('checks that the comparison oracle detects mutation of original state: %s', mutation => {
  const db=fixture();
  try {
    const before=legacy(db);
    const catalog=()=>db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE substr(name,1,7)<>'sqlite_' AND name NOT LIKE 'operator_%' ORDER BY type,name").all();
    const original=catalog(); db.exec(ddl);db.exec(mutation);
    expect(JSON.stringify({rows:legacy(db),catalog:catalog()})).not.toBe(JSON.stringify({rows:before,catalog:original}));
  } finally {db.close();}
});
it('rejects typed value mismatches and kills removed ledger equality/home guards', () => {
  const fixtures=JSON.parse(readFileSync(new URL('../../../protocol/fixtures/joint/contracts.json',import.meta.url),'utf8')).fixtures as Array<{id:string;payload:Record<string,unknown>}>;
  const base=RecoveryReceipt.parse({...fixtures.find(f=>f.id==='valid-recovery-attention-subject')!.payload,if_revision:0});
  const values=(receipt:unknown=base,subject:unknown=base.subject)=>[base.operator_ref,base.request_id,'a'.repeat(64),base.subject_digest,canonicalJointJson(subject),0,base.owner_generation,base.decision,'unknown',canonicalJointJson(receipt),base.observed_at_ms];
  const sql='INSERT INTO operator_recovery_decisions VALUES(?,?,?,?,?,?,?,?,?,?,?)';
  const probes: Array<{anchor:string;row:unknown[]}> = [
    ...(['decision','request_id','operator_ref','subject_digest','observed_at_ms','owner_generation','if_revision','kind','target','schema_version'] as const).map(field=>({
      anchor:`AND json_extract(receipt_json,'$.${field}')`,
      row:values({...base,[field]:typeof base[field]==='number'?Number(base[field])+1:field==='target'?'broker':field==='decision'?'proven_stopped':field==='subject_digest'?'b'.repeat(64):'different'}),
    })),
    {anchor:"AND json_extract(receipt_json,'$.target_home_id')=",row:values({...base,target_home_id:'other-home'})},
    {anchor:"AND json(subject_json)=",row:values({...base,subject:{...base.subject,action_id:'different'}})},
    {anchor:"AND json_type(receipt_json,'$.if_revision')",row:values({...base,if_revision:'0'})},
    {anchor:"AND json_extract(subject_json,'$.kind') IN",row:values({...base,subject:{kind:'broker_lease',home_id:'fixture-home',broker_id:'b',lease_id:'l'}},{kind:'broker_lease',home_id:'fixture-home',broker_id:'b',lease_id:'l'})},
  ];
  for(const probe of probes) {
    const db=new Database(':memory:'); const mutant=new Database(':memory:');
    try {
      db.exec(ddl);expect(()=>db.prepare(sql).run(...probe.row),probe.anchor).toThrow();
      const lines=ddl.split('\n');const hits=lines.filter(l=>l.trimStart().startsWith(probe.anchor));expect(hits,probe.anchor).toHaveLength(1);
      mutant.exec(lines.map(l=>l===hits[0]?(l.endsWith(') IS 1)')?'    AND 1) IS 1)':'    AND 1'):l).join('\n'));
      expect(()=>mutant.prepare(sql).run(...probe.row),`mutant survived: ${probe.anchor}`).not.toThrow();
    } finally {db.close();mutant.close();}
  }
  const db=new Database(':memory:');try {
    db.exec(ddl);
    const broker={...base,target:'broker',subject:{kind:'broker_lease',home_id:'fixture-home',broker_id:'b',lease_id:'l'}};
    expect(()=>db.prepare(sql).run(...values(broker,broker.subject))).toThrow();
  } finally {db.close();}
});

// Executable J12 boundary specification; this does not install a recovery handler.
it('joins host-loaded proofs using the merged J01 context before persisting a resolving receipt', () => {
  const fixtures = JSON.parse(readFileSync(new URL('../../../protocol/fixtures/joint/contracts.json', import.meta.url), 'utf8')).fixtures as Array<{id:string;payload:unknown}>;
  const base = RecoveryReceipt.parse(fixtures.find(f => f.id === 'valid-recovery-attention-subject')!.payload);
  const spec = JSON.parse(read('manifest.json')) as {base_commit:string;schema_spec_digest:string;spec:{ddl_digest:string;fixture_digest:string;target_schema:number}};
  // Synthetic authenticated-build input for this illustration; deliberately distinct from base_commit.
  const trustedCandidateSha = 'c'.repeat(40);
  const proof = {record_ref:'host-proof',type:'invocation_contained' as const,subject_digest:base.subject_digest,evidence_digest:'a'.repeat(64),producer_ref:'host'};
  const receipt = RecoveryReceipt.parse({...base,if_revision:0,prior_phase:'dispatch_committed',decision:'proven_stopped',schema_spec_digest:spec.schema_spec_digest,ddl_digest:spec.spec.ddl_digest,fixture_digest:spec.spec.fixture_digest,actual_target_schema:spec.spec.target_schema,candidate_sha:trustedCandidateSha,proof_refs:[proof.record_ref],proofs:[proof]});
  const envelope = {kind:'recovery_proof',schema_version:1,subject:receipt.subject,proof,record_ref:proof.record_ref,authorization_ref:'authenticated-host-grant',
    owner_generation:receipt.owner_generation,binding_generation:receipt.binding_generation,support_profile_digest:receipt.support_profile_digest,
    prior_phase:receipt.prior_phase,schema_spec_digest:receipt.schema_spec_digest,recovery_build_digest:receipt.recovery_build_digest,observed_at_ms:receipt.observed_at_ms};
  const db = fixture();
  try {
    db.exec(ddl);
    const persist = (loaded: unknown[],candidate=receipt) => {
      // Illustration of pinned-spec admission only; J12 still authenticates build/current state.
      if(candidate.ddl_digest!==spec.spec.ddl_digest || candidate.fixture_digest!==spec.spec.fixture_digest || candidate.actual_target_schema!==spec.spec.target_schema || candidate.schema_spec_digest!==spec.schema_spec_digest || candidate.candidate_sha!==trustedCandidateSha) throw Error('MIGRATION_SPEC_MISMATCH');
      const verified = verifyRecoveryProofEnvelopes(candidate,loaded);
      db.prepare('INSERT INTO operator_recovery_decisions VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(
        verified.operator_ref,verified.request_id,'a'.repeat(64),verified.subject_digest,canonicalJointJson(verified.subject),verified.if_revision,
        verified.owner_generation,verified.decision,'resolved_stopped',canonicalJointJson(verified),verified.observed_at_ms);
    };
    for (const patch of [
      {owner_generation:receipt.owner_generation+1},{binding_generation:17},{support_profile_digest:'f'.repeat(64)},
      {prior_phase:'reserved'},{schema_spec_digest:'f'.repeat(64)},{recovery_build_digest:'f'.repeat(64)},
    ]) expect(() => persist([{...envelope,...patch}])).toThrow('PROOF_CONTEXT_MISMATCH');
    expect(() => persist([{...envelope,observed_at_ms:receipt.observed_at_ms+1}])).toThrow('PROOF_AFTER_RECEIPT');
    expect(() => persist([])).toThrow('PROOF_REFERENCE_MISMATCH');
    expect(() => persist([envelope,envelope])).toThrow('PROOF_REFERENCE_MISMATCH');
    expect(() => decodeJointContractAs('recovery_request',canonicalJointJson(receipt))).toThrow('JOINT_KIND_MISMATCH');
    expect(db.prepare('SELECT COUNT(*) AS n FROM operator_recovery_decisions').get()).toEqual({n:0});
    for(const patch of [{ddl_digest:'f'.repeat(64)},{fixture_digest:'f'.repeat(64)},{actual_target_schema:49},{schema_spec_digest:'f'.repeat(64)},{candidate_sha:'f'.repeat(40)}]) {
      expect(()=>persist([envelope],{...receipt,...patch})).toThrow('MIGRATION_SPEC_MISMATCH');
    }
    expect(()=>persist([envelope],{...receipt,subject_digest:'f'.repeat(64)})).toThrow('SUBJECT_MISMATCH');
    const otherSubject = {...receipt.subject,home_id:'other-home'};
    expect(() => persist([{...envelope,subject:otherSubject,proof:{...proof,subject_digest:recoverySubjectDigest(otherSubject)}}])).toThrow('PROOF_CONTENT_MISMATCH');
    persist([envelope]);
    const stored=db.prepare('SELECT receipt_json FROM operator_recovery_decisions').get() as {receipt_json:string};
    expect(decodeJointContractAs('recovery_receipt',stored.receipt_json)).toEqual(receipt);
  } finally {db.close();}
});

it('checks only Attention phase/decision SQL predicates; proof and effect identity still require the protocol verifier', () => {
  const fixtures=JSON.parse(readFileSync(new URL('../../../protocol/fixtures/joint/contracts.json',import.meta.url),'utf8')).fixtures as Array<{id:string;payload:Record<string,unknown>}>;
  const base=RecoveryReceipt.parse({...fixtures.find(f=>f.id==='valid-recovery-attention-subject')!.payload,if_revision:0});
  const post={preserve_unknown:'unknown',proven_not_started:'cancelled_before_dispatch',proven_stopped:'resolved_stopped',applied_observed:'applied_observed'};
  for (const phase of ['reserved','dispatch_committed','legacy_unknown','broker_unknown','invalid']) {
    for (const resolution of ['none','abandoned_unknown']) {
      for (const decision of ['preserve_unknown','proven_not_started','proven_stopped','applied_observed'] as const) {
        const db=new Database(':memory:');
        try {
          db.exec(ddl);
          const receipt={...base,prior_phase:phase,prior_resolution:resolution,decision,binding_generation:null,support_profile_digest:null};
          const insert=()=>db.prepare('INSERT INTO operator_recovery_decisions VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(base.operator_ref,base.request_id,'a'.repeat(64),base.subject_digest,canonicalJointJson(base.subject),0,base.owner_generation,decision,post[decision],canonicalJointJson(receipt),base.observed_at_ms);
          const allowed=phase==='reserved' ? decision==='preserve_unknown'||(decision==='proven_not_started'&&resolution==='none') : phase==='dispatch_committed' ? decision!=='proven_not_started' : phase==='legacy_unknown'&&decision==='preserve_unknown';
          if(allowed) expect(insert,`${phase}/${resolution}/${decision}`).not.toThrow();
          else expect(insert,`${phase}/${resolution}/${decision}`).toThrow();
        } finally {db.close();}
      }
    }
  }
});


// JA20/JA47 composition material only. These helpers are test oracles, not runtime
// admission APIs, authenticated maintenance owners, or formal gate certificates.
const brokerPath = new URL('../../fixtures/broker-recovery/', import.meta.url);
const brokerRead = (name: string) => readFileSync(new URL(name, brokerPath), 'utf8');
const composedHomeSpec = JSON.parse(read('manifest.json'));
const composedBrokerSpec = JSON.parse(brokerRead('manifest.json'));
const protocolSchema = JSON.parse(readFileSync(new URL('../../../protocol/schemas/joint/joint-contract.schema.json', import.meta.url), 'utf8'));
type JsonShape = { required?: string[]; properties?: Record<string, JsonShape>; anyOf?: JsonShape[]; items?: JsonShape; const?: unknown };
const shapes = protocolSchema.definitions.JointContract.anyOf as JsonShape[];
const receiptShape = shapes.find(s => s.properties?.kind?.const === 'recovery_receipt')!;
const envelopeShape = shapes.find(s => s.properties?.kind?.const === 'recovery_proof')!;
const subjectKinds = ['attention_action', 'effect', 'broker_lease'] as const;
type SubjectKind = typeof subjectKinds[number];
function composedReceipt(kind: SubjectKind, stopped = true): RecoveryReceipt {
  const broker = kind === 'broker_lease'; const spec = broker ? composedBrokerSpec : composedHomeSpec;
  const subject = kind === 'attention_action'
    ? {kind,home_id:'fixture-home',mission_id:'mission',action_id:'action',message_id:'msg'}
    : kind === 'effect' ? {kind,home_id:'fixture-home',effect_id:'fixture-effect'}
    : {kind,home_id:'home-a',broker_id:'broker-fixture',lease_id:'lease-a'};
  const digest = recoverySubjectDigest(subject);
  const effect = kind === 'effect' ? {effect_id:'fixture-effect'} : {};
  // 7 is an unqualified synthetic maintenance owner, deliberately not daemon_owner=1.
  const owner = broker ? 2 : 7;
  const proof = {record_ref:'composition-proof',type:'invocation_contained',subject_digest:digest,
    evidence_digest:'e'.repeat(64),producer_ref:'synthetic-verifier',...effect,
    ...(broker ? {broker_identity:{broker_id:'broker-fixture',lease_id:'lease-a',schema:1,owner_generation:owner}} : {})};
  return RecoveryReceipt.parse({kind:'recovery_receipt',schema_version:1,...effect,
    binding_generation:kind==='effect'?1:null,support_profile_digest:kind==='effect'?'a'.repeat(64):null,
    owner_generation:owner, schema_spec_digest:spec.schema_spec_digest,proof_refs:stopped?[proof.record_ref]:[],
    operator_ref:'synthetic-maintainer',request_id:'composition-request',decision:stopped?'proven_stopped':'preserve_unknown',
    target:broker?'broker':'home',observed_at_ms:10,authorization_ref:'synthetic-grant',scope_id:broker?'scope-a':'scope',tenant_id:'fixture-tenant',
    target_home_id:subject.home_id,recovery_build_digest:'c'.repeat(64),prior_phase:broker?'broker_unknown':'dispatch_committed',
    if_revision:0,actual_target_schema:spec.spec.target_schema,ddl_digest:spec.spec.ddl_digest,fixture_digest:spec.spec.fixture_digest,
    candidate_sha:'c'.repeat(40),proofs:stopped?[proof]:[],subject,subject_digest:digest,prior_resolution:broker?'none':'abandoned_unknown'});
}
function composedEnvelope(r: RecoveryReceipt) {
  return {kind:'recovery_proof',schema_version:1,subject:r.subject,proof:r.proofs[0],
    owner_generation:r.owner_generation,observed_at_ms:r.observed_at_ms,binding_generation:r.binding_generation,
    support_profile_digest:r.support_profile_digest,prior_phase:r.prior_phase,schema_spec_digest:r.schema_spec_digest,
    recovery_build_digest:r.recovery_build_digest,record_ref:r.proof_refs[0],authorization_ref:r.authorization_ref};
}
function withoutField(value: unknown, path: string): unknown {
  const result: Record<string,unknown> = structuredClone(value) as Record<string,unknown>;
  const parts=path.split('.');let cursor=result;
  for(const part of parts.slice(0,-1))cursor=cursor[part] as Record<string,unknown>;
  delete cursor[parts.at(-1)!];return result;
}
const omissionCases = subjectKinds.flatMap(kind => {
  const subject = receiptShape.properties!.subject!.anyOf!.find(s => s.properties!.kind!.const===kind)!;
  const proof = receiptShape.properties!.proofs!.items!;
  const paths = [...receiptShape.required!, ...subject.required!.map(k=>'subject.'+k), ...proof.required!.map(k=>'proofs.0.'+k)];
  if(kind==='effect')paths.push('effect_id','proofs.0.effect_id');
  if(kind==='broker_lease')paths.push('proofs.0.broker_identity', ...proof.properties!.broker_identity!.required!.map(k=>'proofs.0.broker_identity.'+k));
  return paths.map(path=>({kind,path}));
});
type Gate = {id:string;requires:string[]};
function producerOrder(gates: Gate[]): string[] {
  const graph=new Map(gates.map(g=>[g.id,g.requires])); const done=new Set<string>(); const active:string[]=[];const order:string[]=[];
  const visit=(id:string):void=>{
    if(active.includes(id))throw Error('RECOVERY_PRODUCER_CYCLE: '+[...active.slice(active.indexOf(id)),id].join(' -> '));
    if(done.has(id))return;
    const dependencies=graph.get(id);if(!dependencies)throw Error('MISSING_PRODUCER: '+id);
    active.push(id);for(const dep of dependencies)visit(dep);active.pop();done.add(id);order.push(id);
  };
  for(const id of graph.keys())visit(id);return order;
}
function compositionGraph(): Gate[] {
  const input=JSON.parse(readFileSync(new URL('../../../../docs/design/2026-10-27-joint-engineering/execution-gates.json',import.meta.url),'utf8'));
  const gates=(input.gates as Gate[]).map(g=>({id:g.id,requires:[...g.requires]}));
  // Raw material producer nodes have no formal acceptance prerequisites. Material
  // existence is checked against both real SQLite fixtures below, not J17.schema_spec.
  gates.push({id:'fixture:home-spec',requires:[]},{id:'fixture:broker-spec',requires:[]});
  gates.find(g=>g.id==='J11.scoped')!.requires.push('fixture:home-spec','fixture:broker-spec');return gates;
}
function brokerFixture(): Database.Database {
  const db=new Database(':memory:');db.pragma('foreign_keys=ON');
  try{db.exec(brokerRead('schema.sql'));db.exec(brokerRead('held-orphan.sql'));return db;}catch(error){db.close();throw error;}
}
function pinnedReceipt(input: unknown, broker: boolean): RecoveryReceipt {
  const r=RecoveryReceipt.parse(input);const spec=broker?composedBrokerSpec:composedHomeSpec;
  if(r.target!==(broker?'broker':'home') || r.schema_spec_digest!==spec.schema_spec_digest || r.ddl_digest!==spec.spec.ddl_digest ||
    r.fixture_digest!==spec.spec.fixture_digest || r.actual_target_schema!==spec.spec.target_schema || r.candidate_sha!=='c'.repeat(40) || r.recovery_build_digest!=='c'.repeat(64))throw Error('PINNED_RECOVERY_TUPLE_MISMATCH');
  return r;
}
function homeAttentionFacts(db: Database.Database, r: RecoveryReceipt): void {
  if(r.subject.kind!=='attention_action')throw Error('NOT_ATTENTION_SUBJECT');
  const row=db.prepare(`SELECT o.home_id,p.phase,a.scope_id,m.scope_id AS mission_scope,m.session_id,
    msg.session_id AS message_session,w.state AS wait_state,res.disposition AS resolution
    FROM attention_dispatch_phases p JOIN attention_actions a ON a.action_id=p.action_id AND a.message_id=p.message_id
    JOIN engineering_missions m ON m.mission_id=p.mission_id
    JOIN session_messages msg ON msg.message_id=p.message_id
    JOIN engineering_waits w ON w.mission_id=p.mission_id AND w.action_id=p.action_id
    JOIN attention_receipt_resolutions res ON res.message_id=p.message_id AND res.session_id=msg.session_id
    JOIN daemon_owner o ON o.singleton=1
    WHERE p.action_id=? AND p.mission_id=? AND p.message_id=?`).get(r.subject.action_id,r.subject.mission_id,r.subject.message_id) as Record<string,unknown>|undefined;
  if(!row || row.home_id!==r.subject.home_id || row.phase!==r.prior_phase || row.scope_id!==r.scope_id ||
    row.mission_scope!==r.scope_id || row.session_id!==row.message_session || row.resolution!==r.prior_resolution || row.wait_state!=='delivery_unknown')throw Error('HOME_LIVE_SUBJECT_MISMATCH');
  // These pins illustrate the separately required trusted maintenance context. No
  // assertion equates daemon generation with maintenance authority or authenticates it.
  if(r.owner_generation!==7 || r.tenant_id!=='fixture-tenant')throw Error('SYNTHETIC_MAINTENANCE_CONTEXT_MISMATCH');
}

describe('JA20/JA47 home and broker composition material (unqualified)', () => {
  it('instantiates latest home47 catalog and real old hold alongside the separate broker orphan', () => {
    const home=fixture();const broker=brokerFixture();try{
      const catalog=(db:Database.Database)=>db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE substr(name,1,7)<>'sqlite_' ORDER BY type,name").all();
      expect(CURRENT_SCHEMA_VERSION).toBe(47);expect(catalog(home)).toEqual(composedHomeSpec.source_schema);
      expect(sha(canonicalJointJson(catalog(home)))).toBe(composedHomeSpec.spec.source_schema_digest);
      const before=legacy(home);home.exec(ddl);home.pragma('user_version=48');
      expect(catalog(home)).toEqual(composedHomeSpec.target_schema);expect(legacy(home)).toEqual(before);
      expect(home.prepare("SELECT phase FROM attention_dispatch_phases WHERE action_id='action'").get()).toEqual({phase:'dispatch_committed'});
      expect(home.prepare("SELECT state FROM engineering_waits WHERE wait_id='wait'").get()).toEqual({state:'delivery_unknown'});
      expect(home.prepare("SELECT disposition AS resolution FROM attention_receipt_resolutions WHERE message_id='msg'").get()).toEqual({resolution:'abandoned_unknown'});
      expect(home.prepare('SELECT COUNT(*) AS n FROM engineering_completions').get()).toEqual({n:0});
      expect(catalog(broker)).toEqual(JSON.parse(brokerRead('catalog.json')));
      expect(sha(canonicalJointJson(catalog(broker)))).toBe(composedBrokerSpec.spec.target_schema_digest);
      expect(broker.prepare('SELECT lease_id,grant_generation,state,recovery_revision FROM broker_leases').all()).toEqual([{lease_id:'lease-a',grant_generation:1,state:'held_orphan',recovery_revision:0}]);
      expect(broker.prepare('SELECT owner_generation FROM broker_identity').get()).toEqual({owner_generation:2});
      expect(composedBrokerSpec.storage).toMatchObject({allocation:'not_reserved',deployment_qualified:false,runtime_registered:false});
      expect(home.prepare("SELECT name FROM sqlite_master WHERE name='broker_leases'").get()).toBeUndefined();
      expect(broker.prepare("SELECT name FROM sqlite_master WHERE name='operator_recovery_decisions'").get()).toBeUndefined();
      expect(home.pragma('foreign_key_check')).toEqual([]);expect(broker.pragma('foreign_key_check')).toEqual([]);
    }finally{home.close();broker.close();}
  });
  it('orders the actual producer graph without qualifying raw broker material through J17.schema_spec', () => {
    const graph=compositionGraph();const order=producerOrder(graph);
    expect(graph.find(g=>g.id==='J11.scoped')!.requires).toEqual(['J01.contracts','fixture:home-spec','fixture:broker-spec']);
    for(const [before,after] of [['fixture:broker-spec','J11.scoped'],['J11.scoped','J17.schema_spec'],['J17.schema_spec','J17.recovery'],['J12.scoped','J17.recovery'],['J17.recovery','J17.scoped']])expect(order.indexOf(before!)).toBeLessThan(order.indexOf(after!));
  });
  it.each([['J11.scoped','J17.schema_spec'],['J12.scoped','J17.scoped']])('rejects reverse dependency %s -> %s with a concrete cycle trace', (from,to) => {
    const graph=compositionGraph();graph.find(g=>g.id===from)!.requires.push(to);
    let error:unknown;try{producerOrder(graph);}catch(e){error=e;}
    expect(error).toBeInstanceOf(Error);expect(String(error)).toContain('RECOVERY_PRODUCER_CYCLE');expect(String(error)).toContain(from);expect(String(error)).toContain(to);
  });
  it.each(omissionCases)('rejects $kind receipt omission $path through the real protocol decoder', ({kind,path}) => {
    const r=composedReceipt(kind);expect(decodeJointContractAs('recovery_receipt',canonicalJointJson(r))).toEqual(r);
    expect(()=>decodeJointContractAs('recovery_receipt',canonicalJointJson(withoutField(r,path)))).toThrow();
  });
  it.each(subjectKinds.flatMap(kind=>envelopeShape.required!.map(path=>({kind,path}))))('rejects $kind envelope omission $path through the real proof join', ({kind,path}) => {
    const r=composedReceipt(kind);const envelope=composedEnvelope(r);expect(verifyRecoveryProofEnvelopes(r,[envelope])).toEqual(r);
    expect(()=>verifyRecoveryProofEnvelopes(r,[withoutField(envelope,path)])).toThrow();
  });
  it('distinguishes explicit nullable identities and empty preserve proofs from missing fields', () => {
    for(const kind of ['attention_action','broker_lease'] as const){const r=composedReceipt(kind,false);
      expect(r.binding_generation).toBeNull();expect(r.support_profile_digest).toBeNull();expect(r.proofs).toEqual([]);
      expect(verifyRecoveryProofEnvelopes(r,[])).toEqual(r);
      for(const key of ['binding_generation','support_profile_digest','proofs','proof_refs'])expect(()=>RecoveryReceipt.parse(withoutField(r,key))).toThrow();
    }
    const effect=composedReceipt('effect');for(const key of ['binding_generation','support_profile_digest'])expect(()=>RecoveryReceipt.parse({...effect,[key]:null})).toThrow('EFFECT_IDENTITY_MISSING');
  });
  it('demonstrates that a readable receipt file is not a field-completeness validator', () => {
    const directory=createScratchDirSync('tests','ja47-file-existence');const file=join(directory,'receipt.json');
    try{writeFileSync(file,canonicalJointJson(withoutField(composedReceipt('effect'),'owner_generation')));
      expect(existsSync(file)).toBe(true);const raw=readFileSync(file,'utf8');expect(()=>JSON.parse(raw)).not.toThrow();
      expect(()=>decodeJointContractAs('recovery_receipt',raw)).toThrow();
    }finally{rmSync(directory,{recursive:true,force:true});}
  });
  it('joins real home hold rows before the illustrative ledger insert, without changing original obligations', () => {
    const home=fixture();try{home.exec(ddl);const before=legacy(home);const r=composedReceipt('attention_action');
      const verified=verifyRecoveryProofEnvelopes(pinnedReceipt(r,false),[composedEnvelope(r)]);homeAttentionFacts(home,verified);
      home.prepare('INSERT INTO operator_recovery_decisions VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(r.operator_ref,r.request_id,'a'.repeat(64),r.subject_digest,canonicalJointJson(r.subject),r.if_revision,r.owner_generation,r.decision,'resolved_stopped',canonicalJointJson(r),r.observed_at_ms);
      expect(legacy(home)).toEqual(before);expect(home.prepare('SELECT COUNT(*) AS n FROM operator_recovery_decisions').get()).toEqual({n:1});
    }finally{home.close();}
  });
  it.each(['home','mission','action','message','scope','phase','resolution','owner','tenant'])('rejects structurally valid but unjoined home %s without changing holds', bad => {
    const home=fixture();try{home.exec(ddl);const before=legacy(home);let r=composedReceipt('attention_action',false);
      if(r.subject.kind!=='attention_action')throw Error('test fixture kind');
      const subject={...r.subject};if(bad==='home')subject.home_id='other';if(bad==='mission')subject.mission_id='other';if(bad==='action')subject.action_id='other';if(bad==='message')subject.message_id='other';
      r=RecoveryReceipt.parse({...r,subject,target_home_id:subject.home_id,subject_digest:recoverySubjectDigest(subject),...(bad==='scope'?{scope_id:'other'}:{}),...(bad==='phase'?{prior_phase:'reserved'}:{}),...(bad==='resolution'?{prior_resolution:'none'}:{}),...(bad==='owner'?{owner_generation:8}:{}),...(bad==='tenant'?{tenant_id:'other'}:{})});
      // Protocol consistency alone accepts this adversarial input; actual rows/context reject it.
      expect(()=>homeAttentionFacts(home,r)).toThrow(/MISMATCH/);expect(legacy(home)).toEqual(before);
      expect(home.prepare('SELECT COUNT(*) AS n FROM operator_recovery_decisions').get()).toEqual({n:0});
    }finally{home.close();}
  });
  it.each(['schema_spec_digest','ddl_digest','fixture_digest','actual_target_schema','candidate_sha','recovery_build_digest'])('rejects a mutually agreeing proof/receipt with wrong pinned %s', field => {
    const r=composedReceipt('attention_action');const bad=RecoveryReceipt.parse({...r,[field]:field==='actual_target_schema'?49:field==='candidate_sha'?'f'.repeat(40):'f'.repeat(64)});
    expect(verifyRecoveryProofEnvelopes(bad,[composedEnvelope(bad)])).toEqual(bad);
    expect(()=>pinnedReceipt(bad,false)).toThrow('PINNED_RECOVERY_TUPLE_MISMATCH');
  });
  it('keeps a broker decision confined to its own catalog and proves SQL tuple rejection after protocol acceptance', () => {
    const home=fixture();const broker=brokerFixture();try{home.exec(ddl);const homeBefore=legacy(home);
      const original=broker.prepare('SELECT * FROM broker_leases').all();
      const sql='INSERT INTO broker_recovery_decisions VALUES(?,?,?,?,?,?,?,?,?)';
      const good=composedReceipt('broker_lease',false);
      // Scope/tenant are host facts: use the actual broker fixture tenant for this insert.
      const valid=RecoveryReceipt.parse({...good,tenant_id:'tenant-a'});
      for(const field of ['home','lease','broker','scope','tenant','owner'] as const){
        if(valid.subject.kind!=='broker_lease')throw Error('test fixture kind');
        const subject={...valid.subject};if(field==='home')subject.home_id='other';if(field==='lease')subject.lease_id='other';if(field==='broker')subject.broker_id='other';
        const bad=RecoveryReceipt.parse({...valid,subject,target_home_id:subject.home_id,subject_digest:recoverySubjectDigest(subject),...(field==='scope'?{scope_id:'other'}:{}),...(field==='tenant'?{tenant_id:'other'}:{}),...(field==='owner'?{owner_generation:1}:{})});
        const parameters=[bad.operator_ref,bad.request_id,'a'.repeat(64),'broker-fixture','lease-a',0,bad.owner_generation,bad.decision,canonicalJointJson(bad)];
        let error:unknown;try{broker.prepare(sql).run(...parameters);}catch(e){error=e;}expect(error).toBeInstanceOf(Database.SqliteError);expect(error).toMatchObject({code:expect.stringMatching(/^SQLITE_CONSTRAINT/)});
        expect(broker.prepare('SELECT * FROM broker_leases').all()).toEqual(original);
      }
      expect(()=>pinnedReceipt(valid,false)).toThrow('PINNED_RECOVERY_TUPLE_MISMATCH');
      pinnedReceipt(valid,true);expect(verifyRecoveryProofEnvelopes(valid,[])).toEqual(valid);
      broker.prepare(sql).run(valid.operator_ref,valid.request_id,'a'.repeat(64),'broker-fixture','lease-a',0,valid.owner_generation,valid.decision,canonicalJointJson(valid));
      expect(broker.prepare('SELECT state,recovery_revision FROM broker_leases').get()).toEqual({state:'held_orphan',recovery_revision:1});
      expect(legacy(home)).toEqual(homeBefore);expect(home.prepare('SELECT COUNT(*) AS n FROM operator_recovery_decisions').get()).toEqual({n:0});
    }finally{home.close();broker.close();}
  });
});
