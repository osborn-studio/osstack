from pathlib import Path
import subprocess,json,hashlib
O=Path(__file__).resolve().parent;R='/Users/osborn/Developer/CodeX/.worktrees/osstack/joint-broker-spec';SHA='bc25b1cf1889f89178f29a309d7b8c6191d01d40';PRIOR='e8770e3c8dee5b2e57c5c3ca9a7d551607e1a59c';root='packages/core/fixtures/broker-recovery/'
def raw(sha,path):return subprocess.check_output(['git','show',sha+':'+path],cwd=R)
files=[]
for name in ['schema.sql','held-orphan.sql','catalog.json']:
 a=raw(SHA,root+name);assert a==raw(PRIOR,root+name)==raw('858316061196ebb7a195d7e9aa5261fea874d968',root+name);files.append({'path':root+name,'sha256':hashlib.sha256(a).hexdigest(),'identical_e877_and_tested858':True})
a=json.loads(raw(SHA,root+'manifest.json'));b=json.loads(raw(PRIOR,root+'manifest.json'));oracle=json.loads(raw(SHA,root+'oracle-freeze.json'));assert raw(SHA,root+'oracle-freeze.json')==(O/'oracle-freeze.json').read_bytes();old=b['oracle_prefreeze']['frozen_at'];b['oracle_prefreeze']['frozen_at']=oracle['frozen_at'];assert a==b
paths=subprocess.check_output(['git','diff','--name-only',PRIOR,SHA],cwd=R).decode().splitlines();expected=[root+'freeze.py',root+'manifest.json','packages/core/src/state/broker-recovery-spec.test.ts','docs/design/broker-recovery-schema.md'];assert set(paths)==set(expected)
for path in paths:
 value=raw(SHA,path);(O/Path(path).name).write_bytes(value);files.append({'path':path,'sha256':hashlib.sha256(value).hexdigest()})
(O/'candidate.diff').write_bytes(subprocess.check_output(['git','diff',PRIOR,SHA],cwd=R))
for path,digest in [('independent-evidence-final.tar.gz','9c676a17abbb0d0855f6e14235f4ddaad1d64842ddecb49d84f8db5d2db30b95'),('broker-e877-supplement/broker-e877-supplement.tar.gz','190ae1b1d70ffedfd3490dfe9e6d94578be81b07efc0b1122a6ec91ae61ec996')]:assert hashlib.sha256((O.parent/path).read_bytes()).hexdigest()==digest
result={'candidate_sha':SHA,'prior_candidate_sha':PRIOR,'files':files,'exact_changed_paths':paths,'manifest_only_delta':'oracle_prefreeze.frozen_at','old_timestamp':old,'new_timestamp':a['oracle_prefreeze']['frozen_at'],'new_timestamp_matches_exact_oracle':True,'spec_and_schema_spec_digest_unchanged':True,'qualification_and_dependencies_unchanged':True,'tests_rerun':False,'freeze_check_rerun':False,'old_archives_unchanged':True};(O/'byte-metadata-result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
