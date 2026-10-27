from pathlib import Path
import sqlite3,hashlib,json,subprocess,copy
O=Path(__file__).resolve().parent;R=Path('/Users/osborn/Developer/CodeX/.worktrees/osstack/joint-broker-spec');SHA='5ac176cfc54be8c150b28db6a60003aef20f46a7';P='packages/core/fixtures/broker-recovery/'
def gitfile(path):return subprocess.check_output(['git','show',SHA+':'+path],cwd=R)
def h(b):return hashlib.sha256(b).hexdigest()
def canon(o):return json.dumps(o,sort_keys=True,separators=(',',':'),ensure_ascii=False)
inputs=O/'broker-input-5ac176cf';inputs.mkdir(exist_ok=True)
for name in ['schema.sql','held-orphan.sql','manifest.json','catalog.json']:(inputs/name).write_bytes(gitfile(P+name))
ddl=(inputs/'schema.sql').read_text();fixture=(inputs/'held-orphan.sql').read_text();manifest=json.loads((inputs/'manifest.json').read_text());assert manifest['spec']['ddl_digest']==h(ddl.encode()) and manifest['spec']['fixture_digest']==h(fixture.encode());assert manifest['storage']['runtime_registered'] is False and manifest['storage']['allocation']=='not_reserved'
traces={};results=[]
def fresh(label):
 db=sqlite3.connect(':memory:');db.execute('PRAGMA foreign_keys=ON');db.execute('PRAGMA recursive_triggers=OFF');traces[label]=[];db.set_trace_callback(traces[label].append);db.executescript(ddl);db.executescript(fixture);return db
def state(db):return {t:db.execute('SELECT * FROM '+t+' ORDER BY rowid').fetchall() for t in ['broker_identity','broker_leases','broker_recovery_decisions']}
def receipt(decision='preserve_unknown',rid='req-a',rev=0,gen=2):
 subject={'kind':'broker_lease','home_id':'home-a','broker_id':'broker-fixture','lease_id':'lease-a'};sd=h(('osstack.joint.recovery-subject.v1\n'+canon(subject)).encode())
 r=dict(kind='recovery_receipt',schema_version=1,binding_generation=None,owner_generation=gen,schema_spec_digest=manifest['schema_spec_digest'],support_profile_digest=None,proof_refs=[],operator_ref='operator-a',request_id=rid,decision=decision,target='broker',observed_at_ms=100,authorization_ref='auth-a',scope_id='scope-a',tenant_id='tenant-a',target_home_id='home-a',recovery_build_digest='b'*64,prior_phase='broker_unknown',if_revision=rev,actual_target_schema=1,ddl_digest=manifest['spec']['ddl_digest'],fixture_digest=manifest['spec']['fixture_digest'],candidate_sha=SHA,proofs=[],subject=subject,subject_digest=sd,prior_resolution='none')
 if decision=='proven_stopped':r.update(proof_refs=['proof:1'],proofs=[dict(record_ref='proof:1',type='invocation_contained',evidence_digest='c'*64,producer_ref='trusted-producer',subject_digest=sd,broker_identity=dict(broker_id='broker-fixture',lease_id='lease-a',schema=1,owner_generation=gen))])
 return r
def insert(db,r,verb='INSERT',digest='a'*64,suffix=''):
 db.execute(verb+' INTO broker_recovery_decisions VALUES(?,?,?,?,?,?,?,?,?) '+suffix,('operator-a',r['request_id'],digest,'broker-fixture','lease-a',r['if_revision'],r['owner_generation'],r['decision'],canon(r)))
def reject(label,action,prepare=None):
 db=fresh(label)
 if prepare:prepare(db)
 before=state(db)
 try:action(db)
 except sqlite3.DatabaseError as e:
  assert state(db)==before,label+' mutated rows despite rejection';results.append({'id':label,'expected':'reject_no_mutation','actual':'reject_no_mutation','error':str(e)})
 else:results.append({'id':label,'expected':'reject_no_mutation','actual':'ACCEPTED','before':before,'after':state(db)})
 db.close()
db=fresh('positive-preserve');initial=state(db);assert initial['broker_identity'][0][4]==2 and initial['broker_leases'][0][-2:]==('held_orphan',0);assert db.execute('PRAGMA integrity_check').fetchone()==('ok',);assert not db.execute('PRAGMA foreign_key_check').fetchall();cat=[dict(zip(['type','name','tbl_name','sql'],x)) for x in db.execute("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE substr(name,1,7)<>'sqlite_' ORDER BY type,name")];assert cat==json.loads((inputs/'catalog.json').read_text());assert h(canon(cat).encode())==manifest['spec']['target_schema_digest'];body={k:v for k,v in manifest['spec'].items() if k not in ['kind','schema_version']};assert h(('osstack.joint.schema-spec.v1\n'+canon(body)).encode())==manifest['schema_spec_digest'];insert(db,receipt());assert db.execute('SELECT state,recovery_revision FROM broker_leases').fetchone()==('held_orphan',1);results.append({'id':'positive-preserve','expected':'held_revision_1','actual':'held_revision_1'});db.close()
for val,label in [(-1,'negative'),(0,'zero'),(1,'stale'),(1.5,'fractional'),(2**53,'unsafe'),(None,'null')]:
 reject('decision-generation-'+label,lambda db,v=val:insert(db,receipt(gen=v)))
for field,value in [('broker_id','other-broker'),('lease_id','other-lease'),('home_id','other-home')]:
 def badtuple(db,f=field,v=value):
  r=receipt();r['subject'][f]=v
  if f=='home_id':r['target_home_id']=v
  insert(db,r)
 reject('wrong-subject-'+field,badtuple)
for field in ['scope_id','tenant_id']:
 def badfield(db,f=field):r=receipt();r[f]='other';insert(db,r)
 reject('wrong-'+field,badfield)
reject('duplicate-held-resource',lambda db:db.execute("INSERT INTO broker_leases VALUES('lease-b','broker-fixture','home-b','scope-b','tenant-b','exclusive-resource-a','invocation-b',NULL,2,'held_orphan',0)"))

for verb,label in [('INSERT OR REPLACE','or-replace'),('REPLACE','replace')]:
 reject('held-resource-'+label,lambda db,v=verb:db.execute(v+" INTO broker_leases VALUES('lease-b','broker-fixture','home-b','scope-b','tenant-b','exclusive-resource-a','invocation-b',NULL,2,'held_orphan',0)"))

reject('direct-release',lambda db:db.execute("UPDATE broker_leases SET state='resolved_stopped',recovery_revision=1"))
reject('skip-revision',lambda db:insert(db,receipt(rev=1)))
for verb,label in [('INSERT','plain'),('INSERT OR REPLACE','replace'),('INSERT OR IGNORE','ignore')]:
 reject('same-request-'+label,lambda db,v=verb:insert(db,receipt(),verb=v),lambda db:insert(db,receipt()))
reject('request-digest-conflict',lambda db:insert(db,receipt(),digest='d'*64),lambda db:insert(db,receipt()))
reject('request-upsert',lambda db:insert(db,receipt(),suffix="ON CONFLICT(principal_ref,request_id) DO UPDATE SET input_digest=excluded.input_digest"),lambda db:insert(db,receipt()))
reject('same-revision-other-request',lambda db:insert(db,receipt(rid='req-b')),lambda db:insert(db,receipt()))
reject('history-delete',lambda db:db.execute('DELETE FROM broker_recovery_decisions'),lambda db:insert(db,receipt()))
reject('history-update',lambda db:db.execute("UPDATE broker_recovery_decisions SET input_digest=?",('d'*64,)),lambda db:insert(db,receipt()))
reject('lease-delete',lambda db:db.execute('DELETE FROM broker_leases'))
for field in ['proof_refs','proofs']:
 def missingproof(db,f=field):r=receipt('proven_stopped');r.pop(f);insert(db,r)
 reject('stop-missing-'+field,missingproof)
for field in ['broker_id','lease_id','schema','owner_generation']:
 def mismatchedproof(db,f=field):r=receipt('proven_stopped');r['proofs'][0]['broker_identity'][f]='wrong' if f.endswith('_id') else 99;insert(db,r)
 reject('stop-wrong-proof-'+field,mismatchedproof)
def staleaftertakeover(db):db.execute("UPDATE broker_identity SET owner_generation=3,owner_ref='next-owner'")
reject('takeover-does-not-release-or-admit-stale-proof',lambda db:insert(db,receipt('proven_stopped')),staleaftertakeover)
db=fresh('positive-stop-reuse');insert(db,receipt('proven_stopped'));assert db.execute('SELECT state,recovery_revision FROM broker_leases').fetchone()==('resolved_stopped',1);db.execute("INSERT INTO broker_leases VALUES('lease-b','broker-fixture','home-b','scope-b','tenant-b','exclusive-resource-a','invocation-b',NULL,2,'held_orphan',0)");assert db.execute("SELECT count(*) FROM broker_leases WHERE state='held_orphan'").fetchone()==(1,);results.append({'id':'positive-stop-reuse','expected':'old_resolved_new_held','actual':'old_resolved_new_held'});db.close()
reject('sealed-stopped-chain',lambda db:insert(db,receipt(rid='req-b',rev=1)),lambda db:insert(db,receipt('proven_stopped')))
(inputs/'valid-preserve-receipt.json').write_text(json.dumps(receipt(),indent=2)+'\n');(inputs/'valid-stop-receipt.json').write_text(json.dumps(receipt('proven_stopped'),indent=2)+'\n')
(O/'broker-expanded-original-sql-traces.json').write_text(json.dumps(traces,ensure_ascii=False,indent=2)+'\n');output={'candidate_sha':SHA,'sqlite_version':sqlite3.sqlite_version,'oracle_sha256':h((O/'oracle-freeze.json').read_bytes()),'catalog_manifest_hashes_verified':True,'initial_real_sqlite_rows':initial,'results':results,'limits':'Synthetic structurally matching proof is not authentic containment; SQL is subset only. No runtime, gate or formal principal qualification.'};(O/'broker-expanded-original-result.json').write_text(json.dumps(output,ensure_ascii=False,indent=2)+'\n');print(json.dumps(output,ensure_ascii=False,indent=2));raise SystemExit(any(x['actual']=='ACCEPTED' for x in results))
