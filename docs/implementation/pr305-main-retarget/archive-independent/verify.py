from pathlib import Path,PurePosixPath
import tarfile,hashlib,json,re,subprocess,datetime
R=Path(__file__).parent;W=Path('/Users/osborn/Developer/CodeX/.worktrees/osstack/pr305-retarget-ledger')
D=W/'docs/implementation/pr305-main-retarget';P=D/'raw-verification.tar.gz';sha=lambda b:hashlib.sha256(b).hexdigest()
expected='f09333bf83781bd5c563289ec921b867e03f31b9ef2a3b3aa5d49bc541cfc63c'
assert sha(P.read_bytes())==expected
receipt=json.loads((D/'archive-receipt.json').read_text());assert receipt['archive_sha256']==expected
with tarfile.open(P,'r:gz')as t:
 members=t.getmembers();assert len(members)==len({m.name for m in members})==430
 assert all(m.isfile() and not PurePosixPath(m.name).is_absolute() and '..'not in PurePosixPath(m.name).parts for m in members)
 byname={m.name:m for m in members};raw={m.name:t.extractfile(m).read()for m in members}
 manifest=json.loads(raw['archive-manifest.json']);assert sha(raw['archive-manifest.json'])==receipt['manifest_sha256']=='a9b6edcf378c2fb9b200cf6fc7823c88b451cdf952ffdc1bf67e2dcb931d44bd'
 rows=manifest['files'];assert len(rows)==len({x['path']for x in rows})==429
 assert {x['path']for x in rows}==set(raw)-{'archive-manifest.json'}
 checked=[]
 for x in rows:
  p=x['path'];b=raw[p];m=byname[p]
  assert len(b)==m.size==x['bytes'] and sha(b)==x['sha256'] and m.mode==x['mode'],p
  checked.append({'path':p,'bytes':len(b),'sha256':sha(b),'mode':m.mode})
 assert sum(x['bytes']for x in rows)==receipt['payload_bytes']==43823248
 audits=[]
 for folder,want in [('audit','PASS'),('audit-closure','REVISE'),('audit-closure-final','PASS')]:
  binding=json.loads(raw[folder+'/binding.json']);response=json.loads(raw[folder+'/response.json']);report=raw[folder+'/report.md'].decode()
  assert sha(raw[folder+'/audit-input.txt'])==binding['prompt_sha256']
  assert sha(raw[folder+'/response.json'])==binding['response_sha256']
  assert response['result'].strip()==report.strip()
  verdict=re.search(r'Verdict:\s*(PASS|REVISE)',report)[1];assert verdict==want
  assert binding['exit_code']==0 and binding['is_error']is False
  audits.append({'directory':folder,'verdict':verdict,'report_sha256':sha(raw[folder+'/report.md']),'response_sha256':sha(raw[folder+'/response.json']),'input_sha256':sha(raw[folder+'/audit-input.txt']),'started':binding['started_at'],'finished':binding['finished_at'],'model_usage_keys':list(binding['modelUsage']),'static_read_only':True})
 assert 'broken sentence' in raw['audit-closure/report.md'].decode() and 'my earlier PASS on the code and CI stands' in raw['audit-closure/report.md'].decode()
 assert 'two hunks' in raw['audit-closure-final/report.md'].decode()
 vm=json.loads(raw['validation/manifest.json']);assert sha(raw['validation/manifest.json'])=='bfd739891a1361c7d5a62baabe5787447a7378ff6484db30c6c97e12a0666335'
 for row in vm['files']:
  b=raw['validation/'+row['path']];assert len(b)==row['bytes'] and sha(b)==row['sha256']
 summary=json.loads(raw['validation/summary.json']);assert summary['code_sha']=='6f79d125711e898862786fc0268ec20b0b89f24b'
 assert sha(raw['validation/summary.json'])=='3cea818236ab5c09b9ff9b9adbc3e2dcc9f27fde3e8a96821e5ac2b6ed71abf2'
 assert all(c['code_sha']==summary['code_sha'] and c['exit']==c['expected_exit']for c in summary['commands'])
 changes=[]
 for commit in ['d0c77fbcf90e31aab7bfcc4599b97c3ef7e2d3ca','b0ea4e7836dd4be640b4f7c140befba73977837d']:
  delta=subprocess.check_output(['git','show','--format=fuller','--binary',commit],cwd=W)
  names=subprocess.check_output(['git','diff-tree','--no-commit-id','--name-only','-r',commit],cwd=W,text=True).splitlines()
  assert names and all(x.endswith('.md')and(x.startswith('docs/')or x.startswith('osstack-methods-skill/references/'))for x in names)
  (R/(commit[:8]+'.diff')).write_bytes(delta)
  changes.append({'commit':commit,'paths':names,'diff_sha256':sha(delta),'classification':'documentation only, method reference prose included; not product test rerun'})
 control=PARENT=Path('/Volumes/AIMATE_WORK/tmp/osstack/runtime/pr305-main-retarget-20261030/control')
 external=[]
 for name in ['docs-export.log','docs-export-final.log']:
  p=control/name;b=p.read_bytes();counts={k:int(v)for k,v in re.findall(r'^# (tests|pass|fail|skipped) (\d+)$',b.decode(),re.M)}
  assert counts=={'tests':94,'pass':94,'fail':0,'skipped':0}
  assert not any(x.endswith('/'+name)or x==name for x in raw)
  external.append({'path':str(p),'bytes':len(b),'sha256':sha(b),'counts':counts,'inside_this_archive':False,'binding_limit':'Log bytes confirm counts; own log does not independently encode the doc candidate SHA. Root context associates docs-only reruns; raw log preservation is pending separate collection.'})
 report={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'review_type':'independent archive byte/metadata verification; author of prior6f test execution, no independent test reexecution claimed','archive':{'path':str(P),'sha256':expected,'compressed_bytes':P.stat().st_size,'payload_members':429,'all_tar_members':430,'payload_bytes':43823248,'manifest_sha256':sha(raw['archive-manifest.json']),'all_payload_hash_size_mode_match':True,'safe_unique_regular_members':True},'audits':audits,'validation_binding':{'sha':summary['code_sha'],'summary_sha256':sha(raw['validation/summary.json']),'manifest_sha256':sha(raw['validation/manifest.json']),'nested_members_verified':len(vm['files']),'test_counts':summary['counts'],'fresh_ci_not_inferred':True},'docs_only_commits':changes,'outside_archive_docs_export_logs':external,'limits':['No model, product, tests, network or CI reruns. Prior executions remain at original SHA.','PASS→REVISE→PASS documents audit chronology; middle REVISE was introduced prose splice, not withdrawal of source/CI PASS.','Scoped final PASS reads two doc hunks only; no independent model/provider attestation.','Only tar members/manifest/mode and selected payload bindings verified; no claim all repository documents or future CI are covered.']}
 (R/'report.json').write_text(json.dumps(report,indent=2)+'\n')
 (R/'verified-members.json').write_text(json.dumps(checked,indent=2)+'\n')
 (R/'report.md').write_text('''# PR305 retarget archive verification

Archive hash matches f09333bf…fc63c. All429 payloads (43,823,248 uncompressed bytes), plus the archive manifest itself, are430 unique regular members. Every recorded SHA256, size and mode matches; archive manifest hash a9b6edcf…d44bd. No extraction was needed.

Three full audit input/response/report/binding sets are preserved. Reports exactly match response result text: source/CI static PASS, docs-only REVISE for the introduced “check it does not” splice, then limited two-hunk PASS. Intermediate REVISE explicitly preserves the original source/CI PASS; it is not erased or upgraded. Each audit input/response hash matches its original binding.

The nested357-member validation manifest and summary remain exact and bind fresh88/43/94/14 checks and actual default/full paths to6f79d125. This review is archive verification by the prior validation author, not a new independent product execution. d0c77fbc and b0ea4e78 actual Git deltas touch only three/two Markdown files respectively; no package/script changes are implied or newly tested.

Both control/docs-export.log and control/docs-export-final.log contain94/94 pass,0fail/skip. Neither log is in this tar; their hashes/locations are separately recorded in report.json for the root's additional collection. This omission is explicit, not a claim that these doc follow-up logs are already archived. Their bare stdout logs do not independently encode candidate SHA.

No model/test/CI/network/repository mutation performed. No new runtime, provider, or formal-gate qualification.
''')
files=[p for p in R.iterdir()if p.is_file() and p.name!='manifest.json']
(R/'manifest.json').write_text(json.dumps({'files':[{'path':p.name,'bytes':p.stat().st_size,'sha256':sha(p.read_bytes())}for p in sorted(files)]},indent=2)+'\n')
print(json.dumps({'report_sha256':sha((R/'report.json').read_bytes()),'manifest_sha256':sha((R/'manifest.json').read_bytes()),'verified_payloads':429}))
