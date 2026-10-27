from pathlib import Path
import subprocess,json,hashlib
O=Path(__file__).resolve().parent;R=Path('/Users/osborn/Developer/CodeX/.worktrees/osstack/joint-broker-spec');SHA='e8770e3c8dee5b2e57c5c3ca9a7d551607e1a59c';PRIOR='812080ae697e82362e74e43df5c67e55c921d38b';MAIN='d3fa7ef681efc79a5fb2dff92172ef1be0978774'
def raw(sha,path):return subprocess.check_output(['git','show',sha+':'+path],cwd=R)
root='packages/core/fixtures/broker-recovery/'
files=[]
for name in ['schema.sql','held-orphan.sql','catalog.json']:
 a=raw(SHA,root+name);assert a==raw(PRIOR,root+name);assert a==raw('858316061196ebb7a195d7e9aa5261fea874d968',root+name);(O/name).write_bytes(a);files.append({'path':root+name,'sha256':hashlib.sha256(a).hexdigest(),'identical_to_8120_and_tested_858':True})
a=json.loads(raw(SHA,root+'manifest.json'));b=json.loads(raw(PRIOR,root+'manifest.json'));requires=next(g for g in json.loads(raw(MAIN,'docs/design/2026-10-27-joint-engineering/execution-gates.json'))['gates'] if g['id']=='J17.scoped')['requires'];assert a['dependencies']['runtime_storage_requires']==requires;old=b['dependencies']['runtime_storage_requires'];b['dependencies']['runtime_storage_requires']=requires;assert a==b
for path in [root+'manifest.json',root+'freeze.py','packages/core/src/state/broker-recovery-spec.test.ts']:
 v=raw(SHA,path);assert (R/path).read_bytes()==v;(O/Path(path).name).write_bytes(v);files.append({'path':path,'sha256':hashlib.sha256(v).hexdigest(),'working_tree_exact_sha':True})
for name in ['round3-raw.md','round3-dispositions.json']:
 v=(O.parent.parent/'broker-spec'/name).read_bytes();(O/name).write_bytes(v)
diff=subprocess.check_output(['git','diff',PRIOR,SHA,'--',root,'packages/core/src/state/broker-recovery-spec.test.ts','docs/design/broker-recovery-schema.md'],cwd=R);(O/'candidate.diff').write_bytes(diff)
result={'candidate_sha':SHA,'previous_candidate_sha':PRIOR,'main_sha':MAIN,'files':files,'manifest_only_delta':'dependencies.runtime_storage_requires','old_requires':old,'new_requires':requires,'new_requires_equal_main_J17_scoped':True,'original_SQL_checks_rerun':False,'scope':'35 SQL observations inherited by exact bytes; supplement separately executes only new owner test cases and freeze helper'}
(O/'byte-metadata-result.json').write_text(json.dumps(result,indent=2)+'\n');print(json.dumps(result,indent=2))
