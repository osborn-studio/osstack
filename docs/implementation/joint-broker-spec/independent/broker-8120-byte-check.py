from pathlib import Path
import json, subprocess, hashlib
O=Path(__file__).resolve().parent
R='/Users/osborn/Developer/CodeX/.worktrees/osstack/joint-broker-spec'
SHA='812080ae697e82362e74e43df5c67e55c921d38b'
TESTED='858316061196ebb7a195d7e9aa5261fea874d968'
PRIOR='c454c0d02108255dcb77395be25034b6911b9bf5'
def raw(sha,path):return subprocess.check_output(['git','show',sha+':'+path],cwd=R)
files=[]
for name in ['schema.sql','held-orphan.sql','catalog.json']:
 path='packages/core/fixtures/broker-recovery/'+name;a=raw(SHA,path);b=raw(TESTED,path);assert a==b
 files.append({'path':path,'sha256':hashlib.sha256(a).hexdigest(),'compared_to':TESTED,'identical':True})
for name in ['manifest.json','freeze.py']:
 path='packages/core/fixtures/broker-recovery/'+name;a=raw(SHA,path);b=raw(PRIOR,path);assert a==b
 files.append({'path':path,'sha256':hashlib.sha256(a).hexdigest(),'compared_to':PRIOR,'identical':True})
assert raw(SHA,'packages/core/fixtures/broker-recovery/oracle-freeze.json')==(O/'oracle-freeze.json').read_bytes()
result={'new_candidate_sha':SHA,'tested_sql_candidate_sha':TESTED,'prior_freeze_checked_candidate_sha':PRIOR,'files':files,'oracle_bytes_exact_match':True,'sql_checks_rerun':False,'scope':'35 independent SQL observations inherit only identical SQL/fixture/catalog bytes. Original freeze helper and manifest also identical to executed c454 check; no new runtime qualification or independent verification of owner-reported 76 tests.'}
(O/'broker-8120-byte-equivalence.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
