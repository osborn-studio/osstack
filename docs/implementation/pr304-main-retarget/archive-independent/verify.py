from pathlib import Path,PurePosixPath
import tarfile,json,hashlib,subprocess,re,datetime
R=Path('/Volumes/AIMATE_WORK/tmp/osstack/runtime/pr304-main-retarget-20261029/archive-independent')
D=Path('/Users/osborn/Developer/CodeX/.worktrees/osstack/pr304-retarget-ledger/docs/implementation/pr304-main-retarget')
sha=lambda b:hashlib.sha256(b).hexdigest()
archive=D/'raw-verification.tar.gz'; expected=json.loads((D/'archive-receipt.json').read_text()); assert sha(archive.read_bytes())==expected['sha256']
with tarfile.open(archive) as t:
 ms=t.getmembers(); names=[m.name for m in ms];assert len(names)==len(set(names));assert all(m.isfile() and not PurePosixPath(m.name).is_absolute() and '..' not in PurePosixPath(m.name).parts for m in ms)
 data={m.name:t.extractfile(m).read() for m in ms}; meta={m.name:m for m in ms};j=lambda p:json.loads(data[p]);manifest=j('manifest.json');assert sha(data['manifest.json'])==expected['manifest_sha256']
 assert set(names)=={'manifest.json'}|{f['path']for f in manifest['files']}
 checked=[]
 for f in manifest['files']:
  b=data[f['path']];m=meta[f['path']];assert sha(b)==f['sha256'] and len(b)==f['bytes'] and m.mode==f['mode'];checked.append(f)
 assert len(checked)==375 and sum(x['bytes']for x in checked)==25001395
 nested=0
 for n in names:
  if not n.endswith('manifest.json') or n=='manifest.json':continue
  x=j(n)
  if not isinstance(x,dict) or not isinstance(x.get('files'),list):continue
  prefix=n.rsplit('/',1)[0]
  for f in x['files']:
   if not isinstance(f,dict) or not all(k in f for k in ['path','bytes','sha256']):continue
   p=prefix+'/'+f['path'];assert p in data,(n,p);assert len(data[p])==f['bytes'] and sha(data[p])==f['sha256'];nested+=1
 binding=j('audit/binding.json');response=j('audit/response.json');assert sha(data['audit/audit-input.txt'])==binding['prompt_sha256'];assert sha(data['audit/response.json'])==binding['response_sha256'];assert response['result'].strip()==data['audit/report.md'].decode().strip();assert response['result'].startswith('# PR304 retarget review: PASS');assert not response['is_error'] and binding['exit_code']==0;assert 'claude-sonnet-5-5' in response['modelUsage'];assert response['modelUsage']==binding['modelUsage']
 summary=j('validation/summary.json');counts={}
 for label,count in [('journey-tests',43),('projector-tests',49),('export-tests',94),('reader-tests',14)]:
  raw=data['validation/'+label+'.stdout'].decode(); actual={k:int(re.search(r'^# '+k+r' (\d+)$',raw,re.M)[1])for k in ['tests','pass','fail','skipped']};assert actual=={'tests':count,'pass':count,'fail':0,'skipped':0};assert actual==summary['counts'][label];counts[label]=actual
 assert 'Ran 241 tests' in data['validation/docs.stderr'].decode() and 'OK' in data['validation/docs.stderr'].decode();assert 'Tests  1 passed (1)' in data['validation/hygiene.stdout'].decode()
 commands=[]
 for n in names:
  if not n.startswith('validation/') or n.count('/')!=1 or not n.endswith('.command.json'):continue
  x=j(n);base=n.removesuffix('.command.json');assert sha(data[base+'.stdout'])==x['stdout_sha256'] and sha(data[base+'.stderr'])==x['stderr_sha256'];assert x['exit']==x['expected_exit'];assert x['code_sha']==summary['code_sha'];commands.append({'path':n,'exit':x['exit']})
 actual={}
 for scope,exits in [('default',[0,1]),('full',[0,1,2,1,0])]:
  prefix='validation/actual-'+scope;journey=j(prefix+'/journey.json');assert journey==j(prefix+'.stdout');assert journey['status']=='passed';assert [f['product_exit']for f in journey['features']]==exits
  for f in journey['features']:
   case=f['case_id'];p=prefix+'/cases/'+case;cmd=j(p+'/'+case+'.command.json');assert cmd['exit_code']==f['product_exit'] and f['driver_exit']==0 and f['verification']=='passed';assert sha(data[p+'/'+case+'.stdout'])==cmd['stdout_sha256'] and sha(data[p+'/'+case+'.stderr'])==cmd['stderr_sha256'];assert cmd['process_started'] and not cmd['timed_out'] and not cmd['output_limited']
  before=j('validation/'+scope+'-before-projection.json');after=j('validation/'+scope+'-after-projection.json');assert before==after
  for f in before:assert sha(data[prefix+'/'+f['path']])==f['sha256'] and len(data[prefix+'/'+f['path']])==f['bytes']
  actual[scope]={'product_exits':exits,'driver_exits':[f['driver_exit']for f in journey['features']],'unchanged_retained_members':len(before)}
 assert j('validation/project-full.stderr')=={'status':'rejected','error':'fixed_case_set'};assert j('validation/project-full.command.json')['exit']==1;assert j('validation/actual-summary.json')['full']['packet_created'] is False;assert 'assert not packet.exists()' in data['validation/run-actual.py'].decode();assert not any(n.startswith('validation/packet-full/')for n in names)
 assert j('validation/check-default.stdout')['status']=='valid';assert j('validation/project-default.command.json')['exit']==0
 git=[]
 def command(args):
  p=subprocess.run(['git','-C','/Volumes/AIMATE_WORK/Developer/CodeX/osstack',*args],capture_output=True);git.append({'argv':['git',*args],'exit':p.returncode,'stdout':p.stdout.decode(),'stderr':p.stderr.decode()});assert p.returncode==0;return p.stdout
 sb=j('audit/source-bindings.json');head=sb['source']
 for ref,tree in sb['trees'].items():assert command(['rev-parse',ref+'^{tree}']).decode().strip()==tree
 command(['merge-base','--is-ancestor','a0ecd79d',head])
 for f in sb['files']:assert sha(command(['show',head+':'+f['path']]))==f['sha256']
 newdiff=command(['diff','--no-renames','--binary','a0ecd79d',head]);olddiff=command(['diff','--no-renames','--binary','d05c9d91','185d283a']);assert newdiff==olddiff==data['independent/diff.stdout'];paths=command(['diff','--name-only','a0ecd79d',head]).decode().splitlines();assert len(paths)==18
 filtered=command(['diff','a0ecd79d',head,'--','.github/workflows/ci.yml','osstack-methods-skill','scripts']);assert filtered==data['audit/code.diff']
 report={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'status':'PASS_bounded_archive_consistency','archive_sha256':expected['sha256'],'archive_bytes':archive.stat().st_size,'payload_files':len(checked),'payload_bytes':sum(f['bytes']for f in checked),'internal_manifest_sha256':sha(data['manifest.json']),'all_hash_bytes_mode_verified':True,'nested_manifest_members_verified':nested,'actual':actual,'focused_counts':counts,'commands_bound':commands,'audit':{'raw_result':'PASS static read-only','modelUsage':response['modelUsage'],'prompt_response_hashes_valid':True,'report_exact_response':True},'git':{'candidate':head,'tree':summary['tree'],'base_ancestor':True,'18path_binary_diff_equal':True,'6_audit_source_bindings_equal':True,'filtered_audit_diff_exact':True},'readme_consistent':True,'full_rejection_no_output':'Recorded command exit1 fixed_case_set, orchestration asserts absent output, summary false and no archived output; no historic filesystem absence independently reconstructed.','limitations':['Read-only archive and fixed Git inspection; no tests/model calls/reruns or live CI/PR queries.','Sonnet PASS is supplied-text static review, not runtime qualification or independently attested provider identity.','No new local full-package test run claimed. CI remaining gate statement is historical document status, not current live status.','Manifest consistency does not authenticate evidence producer; fixture cleanup and no-output are retained observations, not live remeasurement.'],'confirmed_issues':[]}
 (R/'report.json').write_text(json.dumps(report,indent=2)+'\n');(R/'git-checks.json').write_text(json.dumps(git,indent=2)+'\n');(R/'members-verified.json').write_text(json.dumps(checked,indent=2)+'\n')
 (R/'report.md').write_text('# PR304 retarget archive independent check\n\nPASS within archive consistency scope. All 375 payload files (25,001,395 bytes) match the internal manifest by SHA-256, byte length and mode; no extra/duplicate or unsafe members. Archive and manifest hashes match the published receipt.\n\nRaw Sonnet response is static PASS, exact report text and prompt/response/modelUsage bindings match. Actual default2/full5 raw commands and journey rows confirm product exits 0/1 and 0/1/2/1/0, all driver exits zero. Default projection/check succeeds; full projection returns fixed_case_set, with recorded absent-output assertion and unchanged 75/183 retained members. Focused logs support 43+49+94+14 tests, 241 docs and 1 hygiene. Initial Python parse failure remains archived.\n\nRead-only Git checks confirm both tree equalities, main ancestor of 7ef051ff, exact 18-path binary diff equality, all six supplied source hashes and the filtered audit diff. README is consistent with these records. No confirmed issue.\n\nThis review did not rerun tests/models, query live CI/PR or attest producer identity. Historic no-output/cleanup are retained observations, not reconstructed live absence; CI pending language is historical and does not report current status.\n')
 print(json.dumps({'status':report['status'],'report_sha256':sha((R/'report.json').read_bytes()),'members':len(checked),'nested':nested}))
