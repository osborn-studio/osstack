from pathlib import Path
import json,re,gzip,hashlib,datetime
p=Path(__file__).parent
raw=(p/'complete-log.stdout').read_bytes();assert gzip.decompress((p/'complete-log.log.gz').read_bytes())==raw
run=json.loads((p/'run.json').read_text());jobs=json.loads((p/'jobs.json').read_text());check=next(j for j in jobs['jobs']if j['name']=='check')
assert run['head_sha']=='9d54cfdc658ac137ae9e95d08499aad77ec529f0' and run['conclusion']=='failure'
rows=[]
for n,l in enumerate(raw.decode().splitlines(),1):
 z=l.split('\t',2)
 if len(z)==3 and z[0]=='check':rows.append((n,z[1],re.sub(r'(?:\x1b\[|\^\[\[)[0-?]*[ -/]*[@-~]','',z[2]).split('Z ',1)[-1].lstrip('\ufeff')))
checkout=[{'line':n,'text':t}for n,s,t in rows if s=='Run actions/checkout@v7' and ('HEAD is now at' in t or re.fullmatch('[a-f0-9]{40}',t))]
errors=[{'line':n,'text':t}for n,s,t in rows if s=='Lint (Biome)' and ('Found 'in t or 'Diagnostics not shown' in t or 'max-diagnostics' in t or 'Process completed' in t)]
counts=[]
for n,s,t in rows:
 if s=='Test' and re.search(r'packages/[^ ]+ test:\s+Tests\s+',t):counts.append(t)
assert counts==[]
assert next(s for s in check['steps']if s['name']=='Test')['conclusion']=='skipped'
report={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'run':run['id'],'head':run['head_sha'],'base':run['pull_requests'][0]['base'],'conclusion':'failure','jobs':[{'name':j['name'],'conclusion':j['conclusion']}for j in jobs['jobs']],'checkout':checkout,'failed_step':'Lint (Biome)','failure_lines':errors,'diagnosis':'Biome reports 2 errors and 21 warnings; 3 diagnostics hidden by max-diagnostics. Displayed diagnostic bodies are warnings, so exact error paths/rules not established by this original CI log. No pure-load/network explanation inferred.','changeset_coverage':'passed; 1 release-sensitive package','full_tests':{'status':'not_run','unique_package_summaries_observed':0,'pass':None,'skip':None,'fail':None},'requested152github14cli':'not_run in check job; prior local counts not rebound','actual_smokes':'not_run after lint failure','steps':check['steps'],'raw_bindings':[{'path':n,'bytes':(p/n).stat().st_size,'sha256':hashlib.sha256((p/n).read_bytes()).hexdigest()}for n in ['run.json','jobs.json','complete-log.stdout','complete-log.log.gz','failed-check.stdout','failed-check.log.gz']],'limits':['Read-only review; no rerun/cancel/source/PR mutation.','Four matrix jobs succeeded; their tests are not the skipped check/Test suite.','No artifact download/rehash, model calls or broad qualification.']}
(p/'report.json').write_text(json.dumps(report,indent=2)+'\n')
(p/'report.md').write_text('''# PR307 CI failure preserved

Run40926150260/head9d54cfdc658ac137ae9e95d08499aad77ec529f0 completed **failure**. Four platform matrices succeeded; paid DeepSeek skipped; main check failed at **Lint (Biome)**.

Raw lint records show **2 errors /21 warnings**, with **3 diagnostics hidden** by the default diagnostic limit. The displayed individual diagnostics are warnings. The exact two error locations/rules are therefore not established by this CI log; no speculative cause substituted. Changeset coverage did pass for one release-sensitive package.

Build/typecheck/full22-package Test/new14CLI and all later journey/map/projection checks were skipped after lint. Their counts are **not_run**, not zero passing and not inherited from previous local evidence. Matrix success does not replace those checks.

Full run/jobs JSON, failed-check log, entire-run log and lossless gzip retained. Exact synthetic checkout is recorded in report.json from original checkout lines. No rerun, cancellation, PR/source mutation, model call or artifact download performed.
''')
for name,names in [('final-manifest.json',['run.json','jobs.json','complete-log.log.gz','complete-log.command.json','complete-log.stderr','failed-check.log.gz','failed-check.command.json','failed-check.stderr','report.json','report.md','failure-report.py']),('manifest.json',[x.name for x in sorted(p.iterdir())if x.is_file() and x.name not in ['manifest.json','final-manifest.json']])]:
 fs=[{'path':n,'bytes':(p/n).stat().st_size,'sha256':hashlib.sha256((p/n).read_bytes()).hexdigest()}for n in names];(p/name).write_text(json.dumps({'files':fs},indent=2)+'\n')
print(json.dumps({'checkout':checkout,'report_sha256':hashlib.sha256((p/'report.json').read_bytes()).hexdigest(),'manifest_sha256':hashlib.sha256((p/'final-manifest.json').read_bytes()).hexdigest()}))
