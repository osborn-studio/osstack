import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
// J11 executable storage specification. No runtime recovery entry point is installed.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
  it.each(['before_ddl','after_ddl','after_version'])('rolls back interruption at %s atomically', step => {
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
  const proof = {record_ref:'host-proof',type:'invocation_contained' as const,subject_digest:base.subject_digest,evidence_digest:'a'.repeat(64),producer_ref:'host'};
  const receipt = RecoveryReceipt.parse({...base,if_revision:0,prior_phase:'dispatch_committed',decision:'proven_stopped',schema_spec_digest:spec.schema_spec_digest,ddl_digest:spec.spec.ddl_digest,fixture_digest:spec.spec.fixture_digest,actual_target_schema:spec.spec.target_schema,candidate_sha:spec.base_commit,proof_refs:[proof.record_ref],proofs:[proof]});
  const envelope = {kind:'recovery_proof',schema_version:1,subject:receipt.subject,proof,record_ref:proof.record_ref,authorization_ref:'authenticated-host-grant',
    owner_generation:receipt.owner_generation,binding_generation:receipt.binding_generation,support_profile_digest:receipt.support_profile_digest,
    prior_phase:receipt.prior_phase,schema_spec_digest:receipt.schema_spec_digest,recovery_build_digest:receipt.recovery_build_digest,observed_at_ms:receipt.observed_at_ms};
  const db = fixture();
  try {
    db.exec(ddl);
    const persist = (loaded: unknown[],candidate=receipt) => {
      // Illustration of pinned-spec admission only; J12 still authenticates build/current state.
      if(candidate.ddl_digest!==spec.spec.ddl_digest || candidate.fixture_digest!==spec.spec.fixture_digest || candidate.actual_target_schema!==spec.spec.target_schema || candidate.schema_spec_digest!==spec.schema_spec_digest || candidate.candidate_sha!==spec.base_commit) throw Error('MIGRATION_SPEC_MISMATCH');
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
