from pathlib import Path
import json,re,hashlib,gzip,datetime
p=Path(__file__).parent
run=json.loads((p/'run.json').read_text());jobs=json.loads((p/'jobs.json').read_text());check=next(j for j in jobs['jobs']if j['name']=='check');steps={s['name']:s for s in check['steps']}
assert run['head_sha']=='24bed464c321c5396f59adecaf72c116569ca768' and run['conclusion']=='failure'
assert steps['Lint (Biome)']['conclusion']==steps['Build']['conclusion']=='success'
assert steps['Inventory freshness']['conclusion']=='failure' and steps['Test']['conclusion']=='skipped'
raw=(p/'complete-log.stdout').read_bytes();assert gzip.decompress((p/'complete-log.log.gz').read_bytes())==raw
rows=[]
for n,l in enumerate(raw.decode().splitlines(),1):
 z=l.split('\t',2)
 if len(z)==3 and z[0]=='check':rows.append((n,z[1],re.sub(r'(?:\x1b\[|\^\[\[)[0-?]*[ -/]*[@-~]','',z[2]).split('Z ',1)[-1].lstrip('\ufeff')))
checkout=[{'line':n,'text':t}for n,s,t in rows if s=='Run actions/checkout@v7' and ('HEAD is now at' in t or re.fullmatch('[0-9a-f]{40}',t))]
errors=[{'line':n,'text':t}for n,s,t in rows if s=='Inventory freshness']
report={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'run':run['id'],'head':run['head_sha'],'base':run['pull_requests'][0]['base'],'conclusion':'failure','checkout':checkout,'jobs':[{'name':j['name'],'conclusion':j['conclusion']}for j in jobs['jobs']],'passed_lint_and_build':True,'failed_step':'Inventory freshness','failure_lines':errors,'diagnosis':'docs/inventory/PUBLIC_EXPORTS.md is stale according to the actual generate-inventory --check command. No generated inventory repair or CI retry performed by reviewer.','full_test_counts':{'status':'not_run','packages':None,'passed':None,'skipped':None,'failed':None},'github154_cli14':'not_run in this check job; old local evidence not relabeled','actual_smokes':'not_run','steps':check['steps'],'raw_bindings':[{'path':n,'bytes':(p/n).stat().st_size,'sha256':hashlib.sha256((p/n).read_bytes()).hexdigest()}for n in ['run.json','jobs.json','complete-log.stdout','complete-log.log.gz']],'limits':['Independent read-only CI records analysis, no product/test/model re-execution.','Matrix success does not substitute for skipped check/Test.','No artifact download or rehash, PR mutation, rerun or cancellation.']}
(p/'report.json').write_text(json.dumps(report,indent=2)+'\n')
(p/'report.md').write_text('''# PR307 repaired-head CI: inventory failure

Run **40928407347**, head **24bed464c321c5396f59adecaf72c116569ca768**, completed **failure** within the15-minute tracking bound. Four platform matrix jobs succeeded; paid DeepSeek skipped.

**Lint (Biome) and Build both actually succeeded.** Main check then failed at **Inventory freshness**:

`stale: docs/inventory/PUBLIC_EXPORTS.md — re-run scripts/generate-inventory.mjs`

Command `node scripts/generate-inventory.mjs --check` exited1 at18:14:54Z. Typecheck, full22-package tests, requested GitHub/CLI counts, and later actual smoke steps were skipped. They are not_run, not inherited passes. Original lint-failed run remains separately preserved and is not regraded.

Exact synthetic checkout and run/API base are retained in report.json. Complete original log is729829bytes, SHA256 `7788ebe508cc4c1a2a70552d9a0b4cc3066dd68560844e79669c00107761c995`; compressed copy was checked for lossless equality. No artifact downloaded, test rerun, model call, source/PR modification or cancellation.
''')
selected=['run.json','jobs.json','complete-log.log.gz','complete-log.command.json','complete-log.stderr','pr-initial.json','pr-initial.command.json','pr-initial.stderr','report.json','report.md','report-failure.py']
for name,names in [('final-manifest.json',selected),('manifest.json',[f.name for f in sorted(p.iterdir())if f.is_file()and f.name not in ['manifest.json','final-manifest.json']])]:
 (p/name).write_text(json.dumps({'files':[{'path':n,'bytes':(p/n).stat().st_size,'sha256':hashlib.sha256((p/n).read_bytes()).hexdigest()}for n in names]},indent=2)+'\n')
print(json.dumps({'checkout':checkout,'report_sha256':hashlib.sha256((p/'report.json').read_bytes()).hexdigest(),'manifest_sha256':hashlib.sha256((p/'final-manifest.json').read_bytes()).hexdigest()}))
