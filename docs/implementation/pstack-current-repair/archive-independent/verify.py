import json,hashlib,tarfile,stat,os,re,subprocess,datetime
from pathlib import Path,PurePosixPath
R=Path('/Volumes/AIMATE_WORK/tmp/osstack/runtime/pstack-current-repair-20261029');W=Path('/Users/osborn/Developer/CodeX/.worktrees/osstack/pstack-current-repair-control');A=W/'docs/implementation/pstack-current-repair/evidence/raw-verification.tar.gz';O=R/'archive-independent'
def sha(b):return hashlib.sha256(b).hexdigest()
assert sha(A.read_bytes())=='3a895404c2b50b4b110f632582a0ec7a1c870782040f80e049083278c43ca1c6'
with tarfile.open(A)as t:
 ms=t.getmembers();assert len(ms)==2135;assert len({m.name for m in ms})==len(ms)
 for m in ms:
  p=PurePosixPath(m.name);assert not p.is_absolute() and '..'not in p.parts and (m.isfile()or m.isdir()),m.name
 data={m.name:t.extractfile(m).read()for m in ms if m.isfile()};manifest=json.loads(data['archive-manifest.json']);look={m.name:m for m in ms};assert set(look)=={x['path']for x in manifest['files']}|{'archive-manifest.json'}
 total=0
 for f in manifest['files']:
  m=look[f['path']];assert m.mode==f['mode'];assert ('file'if m.isfile()else'directory')==f['type']
  if m.isfile():assert len(data[m.name])==f['bytes'] and sha(data[m.name])==f['sha256'];total+=len(data[m.name])
 assert total==17258317
 # Entire C original manifest and its335 files remain byte-exact.
 cm=json.loads(data['independent/final-manifest.json']);assert len(cm['files'])==335
 assert data['independent/final-manifest.json']==(R/'independent/final-manifest.json').read_bytes()
 for f in cm['files']:
  n='independent/'+f['path'];assert data[n]==(R/n).read_bytes();assert sha(data[n])==f['sha256'] and len(data[n])==f['bytes'] and look[n].mode==f['mode']
 # Archived workspaces, streams and guards are exact live retained bytes/types/modes.
 livecount=0
 for f in manifest['files']:
  n=f['path']
  if n.startswith('host/runs/') or n.startswith('host/harness/dispatch-') or n.startswith('audit/')or n.startswith('audit-closure/'):
   p=R/n;s=p.lstat();assert stat.S_IMODE(s.st_mode)==f['mode'];assert ('file'if p.is_file()else'directory')==f['type']
   if f['type']=='file':assert p.read_bytes()==data[n];livecount+=1
 dispatch=json.loads(data['control/root-dispatch.json']);chron=[]
 for host in ['codex','claude']:
  n=f'host/harness/dispatch-{host}-repair.json';g=json.loads(data[n]);run=json.loads(data[f'host/runs/{host}/evidence/run-result.json']);assert sha(data[n])==dispatch[host]['sha256'];assert datetime.datetime.fromisoformat(dispatch[host]['authorized_at'])<datetime.datetime.fromisoformat(run['at']);assert g['approved']
  fs={f['path']:f['sha256']for f in g['frozen_files']}
  for short in ['criteria.json','dispatch-supplement.json']:assert fs[str(R/'independent'/short)]==sha(data['independent/'+short])
  chron.append({'host':host,'approved_at':dispatch[host]['authorized_at'],'run_at':run['at'],'guard_sha256':sha(data[n])})
 audits=[]
 for prefix in ['audit','audit-closure']:
  b=json.loads(data[prefix+'/binding.json']);assert b['prompt_sha256']==sha(data[prefix+'/audit-input.txt']);assert b['response_sha256']==sha(data[prefix+'/response.json']);resp=json.loads(data[prefix+'/response.json']);assert resp['modelUsage']==b['modelUsage'];assert data[prefix+'/report.md'].decode().strip()==resp['result'].strip();assert 'PASS'in resp['result'];audits.append({'scope':prefix,'prompt_sha256':b['prompt_sha256'],'response_sha256':b['response_sha256'],'exit':b['exit_code']})
 full=json.loads(data['control/full-binding.json']);bef=json.loads(data['control/full-before.json']);aft=json.loads(data['control/full-after.json']);assert bef==aft and not full['tracked_changed_during_run'];assert sha(data['control/full.log'])==full['log_sha256'];rows=[]
 text=re.sub(r'(?:\x1b|\^\[)\[[0-9;]*m','',data['control/full.log'].decode())
 for line in text.splitlines():
  m=re.search(r'packages/([^ ]+) test:\s+Tests\s+(.*)',line)
  if m:
   ns={k:int(n)for n,k in re.findall(r'(\d+) (passed|skipped|failed)',m[2])};rows.append({'package':m[1],**{k:ns.get(k,0)for k in ['passed','skipped','failed']}})
 assert len(rows)==22 and len({x['package']for x in rows})==22;totals={k:sum(x[k]for x in rows)for k in ['passed','skipped','failed']};assert totals=={'passed':7144,'skipped':5,'failed':0}
 commit=full['head'];assert commit=='681cf6e92a5b33ef9d931662ad94d4b2f9fdfad8'
 sources={}
 for p in ['scripts/project-method-journey-evidence.mjs','scripts/project-method-journey-evidence.test.mjs']:
  b=subprocess.check_output(['git','show',commit+':'+p],cwd=W);assert sha(b)==bef[p];assert b==(W/p).read_bytes();sources[p]=sha(b)
 assert sources['scripts/project-method-journey-evidence.mjs']==sha(data['host/runs/codex/workspace/scripts/project-method-journey-evidence.mjs'])
 post=json.loads(data['control/post-run-code-binding.json']);assert post['committed_checker_sha256']==sources['scripts/project-method-journey-evidence.mjs'];assert post['committed_repository_test_sha256']==sources['scripts/project-method-journey-evidence.test.mjs']
 # Check original audit input bindings have archived exact bytes even where later report prose superseded.
 bindingchecks=[]
 for prefix in ['audit','audit-closure']:
  ib=json.loads(data[prefix+'/input-bindings.json']);missing=[]
  for f in (ib['files'] if isinstance(ib,dict) else ib):
   matching=[n for n,b in data.items()if sha(b)==f['sha256'] and len(b)==f['bytes']]
   if not matching:
    prompt=data[prefix+'/audit-input.txt'];marker=('FILE '+f['path']+'\n').encode()
    if marker in prompt:
     start=prompt.index(marker)+len(marker); embedded=prompt[start:start+f['bytes']]
     if sha(embedded)==f['sha256']:matching=['embedded_exact_in_'+prefix+'/audit-input.txt']
    if not matching:missing.append(f['path'])
  assert not missing,(prefix,missing)
  bindingchecks.append({'audit':prefix,'input_files':len(ib['files'] if isinstance(ib,dict) else ib),'all_input_bytes_retained':True})
readme=(W/'docs/implementation/pstack-current-repair/README.md').read_text();assert 'six baseline helpers total'in readme and 'compound source inspection' in readme and 'main itself was not patched or revalidated'in readme
v={'checked_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'archive_sha256':sha(A.read_bytes()),'members':len(ms),'listed_payload_file_bytes':total,'all_member_hash_size_mode_type_verified':True,'path_safety':'unique relative regular files/directories only; no links or traversal','independent_original_manifest_files':335,'independent_original_bytes_exact':True,'host_and_audit_live_files_compared':livecount,'guard_chronology':chron,'audits':audits,'audit_input_bindings':bindingchecks,'full':{'head':commit,'exit':full['exit_code'],'unique_packages':22,'totals':totals,'tracked_before_after_files':len(bef),'tracked_bytes_unchanged':True,'source_hashes':sources,'clean_committed_tree_claim':False,'qualification':'fresh generateddist and ledger working changes explicitly recorded; targeted runs postbound, not relabeled as originally started on681'},'readme':{'sha256':sha(readme.encode()),'scope_wording_consistent':True,'claude':'six total baseline helpers, first compoundsource read executed; next denied; no sourceinspection retroactiveatomicrule; incomplete repair','codex':'boundedrepair, requiredpages delivery; nativeunavailable selfreport unproven','main':'493 baseline not patched/revalidated'},'confirmed_issues':[],'verification_notes':['Initial verifier assumed both audit input-binding files were dictionaries; closure uses list, original script preserved.','Closure5501-byte report-draft snapshot is retained byte-exact inside audit-input.txt (SHA66ccca26...), while live report-draft later changed. Initial separate-member-only check was incomplete; original verifier preserved.'],'limits':['Archive integrity and retained-byte comparison, not independent provenance authentication.','No test/model rerun. Full counts derive from preserved raw log; executionbinding is owner-observed evidence.','Both static audits retained; later full result and final prose are not silently added to earlier audit scope.','No OS containment/all-descendant/native-methodcausality/formalgate claim.']}
(O/'receipt.json').write_text(json.dumps(v,indent=2)+'\n');(O/'receipt.md').write_text('# Final archive independent check\n\nAll2,135members verified for safe path/type/mode and listed payload hash/bytes (17,258,317filebytes, manifest excluded). Original335 C files+manifest unchanged; retained hostworkspaces, streams, guards and both audit rounds match originalbytes. Approvedguards preceded both starts.\n\nFull log independently totals22unique packages:7,144passed/5skipped/0failed. All'+str(len(bef))+'tracked before/after hashes are equal; checker/test match681cf6e9 Git and currentfiles. Freshdist/ledger workingchanges mean this is not a clean-commit-only run. Targeted evidence remains post-bound accurately.\n\nFinalREADME distinguishes Claude incomplete repair and actual compound-source reads, sourceprefix nonexclusivity, Codex explicitdelivery/nativeattributionlimits, and main493baseline unchanged. No confirmed defect in this bounded check. No tests/models rerun.\n');print('PASS',len(ms),total,'full',totals,'tracked',len(bef));print('receiptsha',sha((O/'receipt.json').read_bytes()))
