import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { canonicalJointJson, MigrationSpec, RecoveryReceipt, recoverySubjectDigest, schemaSpecDigest } from '@osstack/protocol/joint';

// Executable offline storage candidate. This never imports the production DB opener.
const root = new URL('../../fixtures/broker-recovery/', import.meta.url);
const read = (name: string) => readFileSync(new URL(name, root), 'utf8');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const catalog = (db: Database.Database) => db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE substr(name,1,7)<>'sqlite_' ORDER BY type,name").all();
function fixture(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys=ON');
  db.pragma('recursive_triggers=OFF');
  try { db.exec(read('schema.sql')); db.exec(read('held-orphan.sql')); return db; }
  catch (error) { db.close(); throw error; }
}
function receipt(revision = 0, stopped = false): RecoveryReceipt {
  const subject = { kind: 'broker_lease' as const, home_id: 'home-a', broker_id: 'broker-fixture', lease_id: 'lease-a' };
  const manifest = JSON.parse(read('manifest.json'));
  return RecoveryReceipt.parse({
    kind: 'recovery_receipt', schema_version: 1, binding_generation: null, owner_generation: 2,
    schema_spec_digest: manifest.schema_spec_digest, support_profile_digest: null,
    proof_refs: stopped ? ['containment-a'] : [], operator_ref: 'operator-a', request_id: `request-${revision}`,
    decision: stopped ? 'proven_stopped' : 'preserve_unknown', target: 'broker', observed_at_ms: 10,
    authorization_ref: 'test-only-grant', scope_id: 'scope-a', tenant_id: 'tenant-a', target_home_id: 'home-a',
    recovery_build_digest: 'c'.repeat(64), prior_phase: 'broker_unknown', if_revision: revision,
    actual_target_schema: 1, ddl_digest: manifest.spec.ddl_digest, fixture_digest: manifest.spec.fixture_digest,
    candidate_sha: 'a'.repeat(40), subject, subject_digest: recoverySubjectDigest(subject), prior_resolution: 'none',
    proofs: stopped ? [{ record_ref: 'containment-a', type: 'invocation_contained', evidence_digest: 'e'.repeat(64),
      producer_ref: 'test-only-verifier', subject_digest: recoverySubjectDigest(subject),
      broker_identity: { broker_id: 'broker-fixture', lease_id: 'lease-a', schema: 1, owner_generation: 2 } }] : [],
  });
}
const insertSql = 'INSERT INTO broker_recovery_decisions(principal_ref,request_id,input_digest,broker_id,lease_id,prior_revision,owner_generation,decision,receipt_json) VALUES(?,?,?,?,?,?,?,?,?)';
function args(r: RecoveryReceipt) { return [r.operator_ref,r.request_id,'d'.repeat(64),'broker-fixture','lease-a',r.if_revision,r.owner_generation,r.decision,canonicalJointJson(r)]; }
function lease(db: Database.Database) { return db.prepare('SELECT * FROM broker_leases WHERE lease_id=?').get('lease-a') as Record<string, unknown>; }
const decisions = (db: Database.Database) => db.prepare('SELECT * FROM broker_recovery_decisions ORDER BY prior_revision').all();
const insert = (db: Database.Database, r: RecoveryReceipt) => db.prepare(insertSql).run(...args(r));

describe('JP-17a independent broker storage candidate', () => {
  it('pins real SQL/catalog bytes to a separate unreserved 0-to-1 candidate, never a deployed broker', () => {
    const manifest = JSON.parse(read('manifest.json'));
    expect(manifest.status).toBe('candidate_spec_only');
    expect(manifest.storage).toMatchObject({ deployment: 'dedicated_sqlite', namespace: 'osstack.resource-broker', allocation: 'not_reserved', deployment_qualified: false, runtime_registered: false });
    expect(manifest.base_commit).toBe('d3fa7ef681efc79a5fb2dff92172ef1be0978774');
    const spec = MigrationSpec.parse(manifest.spec);
    expect([spec.source_schema,spec.target_schema]).toEqual([0,1]);
    expect(spec.ddl_digest).toBe(hash(read('schema.sql')));
    expect(spec.fixture_digest).toBe(hash(read('held-orphan.sql')));
    expect(manifest.schema_spec_digest).toBe(schemaSpecDigest(spec));
    const db = fixture();
    try {
      expect(db.pragma('user_version',{simple:true})).toBe(1);
      expect(catalog(db)).toEqual(JSON.parse(read('catalog.json')));
      expect(hash(canonicalJointJson(catalog(db)))).toBe(spec.target_schema_digest);
      expect(spec.source_schema_digest).toBe(hash('[]'));
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(lease(db)).toMatchObject({ state:'held_orphan',recovery_revision:0,grant_generation:1,effect_id:null });
      expect(db.prepare('SELECT owner_generation FROM broker_identity').get()).toEqual({owner_generation:2});
      expect(db.prepare("SELECT name FROM sqlite_master WHERE name='operator_recovery_decisions'").get()).toBeUndefined();
      expect(execFileSync('python3',['-I',fileURLToPath(new URL('freeze.py',root)),'--check'],{encoding:'utf8'})).toContain('candidate bytes verified');
    } finally { db.close(); }
  });
  it.each([-1,0,1.5,9007199254740992])('rejects invalid owner generation %s', generation => {
    const db=fixture(); try {
      expect(()=>db.prepare('UPDATE broker_identity SET owner_generation=?,owner_ref=?').run(generation,'next-owner')).toThrow();
      expect(lease(db).state).toBe('held_orphan');
    } finally {db.close();}
  });
  it('retains the exclusive slot across takeover and preserve_unknown, releasing only with a matching stop decision', () => {
    const db=fixture(); try {
      const original=lease(db);
      insert(db,receipt());
      expect(lease(db)).toEqual({...original,recovery_revision:1});
      const clone="INSERT INTO broker_leases SELECT 'lease-b',broker_id,home_id,scope_id,tenant_id,resource_key,invocation_ref,effect_id,grant_generation,'held_orphan',0 FROM broker_leases WHERE lease_id='lease-a'";
      expect(()=>db.exec(clone)).toThrow();
      insert(db,receipt(1,true));
      expect(lease(db)).toEqual({...original,recovery_revision:2,state:'resolved_stopped'});
      expect(decisions(db)).toHaveLength(2);
      db.exec(clone);
      expect(db.prepare("SELECT COUNT(*) AS n FROM broker_leases WHERE state='held_orphan'").get()).toEqual({n:1});
      expect(()=>insert(db,receipt(2))).toThrow();
    } finally {db.close();}
  });
  it.each(['owner','broker','lease','home','scope','tenant','schema','phase','missing-proof','wrong-proof-generation'])('fails closed on %s without releasing or appending', bad => {
    const db=fixture(); try {
      const r=receipt(0,true); const input=structuredClone(r);
      if(bad==='owner') input.owner_generation=1;
      if(bad==='broker' && input.subject.kind==='broker_lease') input.subject.broker_id='other';
      if(bad==='lease' && input.subject.kind==='broker_lease') input.subject.lease_id='other';
      if(bad==='home') {input.subject.home_id='other';input.target_home_id='other';}
      if(bad==='scope') input.scope_id='other';
      if(bad==='tenant') input.tenant_id='other';
      if(bad==='schema') input.actual_target_schema=48;
      if(bad==='phase') input.prior_phase='dispatch_committed';
      if(bad==='missing-proof') {input.proofs=[];input.proof_refs=[];}
      if(bad==='wrong-proof-generation') {const proof=input.proofs[0];if(proof?.broker_identity) proof.broker_identity.owner_generation=1;}
      const original=lease(db);
      expect(()=>db.prepare(insertSql).run(...args(input))).toThrow();
      expect(lease(db)).toEqual(original);expect(decisions(db)).toEqual([]);
    } finally {db.close();}
  });
  it('rejects a stale owner after another generation takes over, without interpreting home ownership as broker authority', () => {
    const db=fixture(); try {
      db.exec("UPDATE broker_identity SET owner_generation=3,owner_ref='third-broker-owner'");
      expect(()=>insert(db,receipt(0,true))).toThrow();
      expect(lease(db).state).toBe('held_orphan');expect(decisions(db)).toEqual([]);
    } finally {db.close();}
  });
  it.each(['INSERT','INSERT OR IGNORE','INSERT OR REPLACE','REPLACE'])('does not let %s overwrite recovery history or replay an input', prefix => {
    const db=fixture(); try {
      const r=receipt();insert(db,r);const original=decisions(db);
      const sql=insertSql.replace('INSERT',prefix);
      expect(()=>db.prepare(sql).run(...args(r))).toThrow();
      const conflict=args(r);conflict[2]='f'.repeat(64);
      expect(()=>db.prepare(sql).run(...conflict)).toThrow();
      expect(decisions(db)).toEqual(original);expect(lease(db).recovery_revision).toBe(1);
    } finally {db.close();}
  });
  it('rejects skipped revisions, append-after-terminal, direct release, and mutable identity/history', () => {
    const db=fixture(); try {
      expect(()=>insert(db,receipt(2))).toThrow();
      expect(()=>db.exec("UPDATE broker_leases SET state='resolved_stopped',recovery_revision=1")).toThrow();
      expect(()=>db.exec("UPDATE broker_leases SET home_id='other'")).toThrow();
      expect(()=>db.exec("UPDATE broker_identity SET broker_id='other',owner_generation=3")).toThrow();
      expect(()=>db.exec('DELETE FROM broker_identity')).toThrow();
      expect(()=>db.exec('DELETE FROM broker_leases')).toThrow();
      insert(db,receipt(0,true));
      expect(()=>db.exec('DELETE FROM broker_recovery_decisions')).toThrow();
      expect(()=>db.exec("UPDATE broker_recovery_decisions SET input_digest='x'")).toThrow();
      expect(()=>insert(db,receipt(1))).toThrow();
    } finally {db.close();}
  });
  it('rolls back receipt and projection together after an injected transaction abort', () => {
    const db=fixture(); try {
      const original=lease(db);
      expect(()=>db.transaction(()=>{insert(db,receipt(0,true));throw Error('injected after projection');})()).toThrow('injected');
      expect(lease(db)).toEqual(original);expect(decisions(db)).toEqual([]);
    } finally {db.close();}
  });
  it.each(['before-ddl','after-ddl','after-fixture'])('rolls back offline bootstrap at %s', point => {
    const db=new Database(':memory:');db.pragma('foreign_keys=ON');try {
      expect(()=>db.transaction(()=>{
        if(point==='before-ddl')throw Error('injected');db.exec(read('schema.sql'));
        if(point==='after-ddl')throw Error('injected');db.exec(read('held-orphan.sql'));throw Error('injected');
      })()).toThrow('injected');
      expect(catalog(db)).toEqual([]);expect(db.pragma('user_version',{simple:true})).toBe(0);
    } finally {db.close();}
  });
});
