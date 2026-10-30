from pathlib import Path
import json,gzip,hashlib,datetime,stat
r=Path(__file__).parent;d=json.loads((r/'report.json').read_text());pr=json.loads((r/'pr-final.stdout').read_text());h=lambda b:hashlib.sha256(b).hexdigest()
assert d['head']=='f31e557a7d208815eeabd37d8dc9b4b7e3e352d1' and d['run_id']==40979844215 and d['base']['ref']==json.loads((r/'target-binding.json').read_bytes())['base'];assert pr['headRefOid']==d['head'] and pr['baseRefName']==d['base']['ref'] and pr['isDraft'] is True
assert d['conclusion']=='success' and d['totals']['failed']==0 and d['package_count']==22
assert sum(j['conclusion']=='success'for j in d['jobs'])==5 and sum(j['conclusion']=='skipped'for j in d['jobs'])==1
steps={x['name']:x for x in d['check_steps']};assert all(steps[n]['conclusion']=='success' for n in ['Lint (Biome)','Inventory freshness','Build','Typecheck','Test'])
for name,expected in [('Method verification journey (two real local cases)',[0,1]),('Full method verification journey (five real local cases)',[0,1,2,1,0])]:
 a=d['actual_steps'][name]['json_records'];assert len(a)==1;x=a[0]['value'];assert x['status']=='passed' and [f['product_exit']for f in x['features']]==expected;assert all(f['verification']=='passed' and f['driver_exit']==0 and f['cleanup']['fixture_removed'] is True for f in x['features'])
for name in ['Project and check actual method evidence','Project and check full five-case method evidence']:
 x,y=[a['value']for a in d['actual_steps'][name]['json_records']];assert x['status']=='projected' and y['status']=='valid' and x['packet_sha256']==y['packet_sha256'] and y['original_evidence_revalidated'] is False
x=d['actual_steps']['Maintain fixed skills map (five real local cases)']['json_records'][0]['value'];assert x['status']=='consistent' and x['exit_code']==0 and x['map']['before_sha256']==x['map']['after_sha256'] and x['map']['unchanged'] is True
for name in ['Session adoption decision smoke (local fixture)','Skills check verification (local Git fixtures)']:assert d['actual_steps'][name]['json_records'][0]['value']['status']=='passed'
assert gzip.decompress((r/'complete-log.log.gz').read_bytes())==(r/'complete-log.stdout').read_bytes()
d['current_pr_snapshot']={k:pr[k]for k in ['headRefOid','baseRefName','isDraft','mergeable','state']}
(r/'report.json').write_text(json.dumps(d,indent=2)+'\n')
gh=next(p for p in d['packages'] if p['package']=='github');cli=next(p for p in d['packages'] if p['package']=='cli')
(r/'report.md').write_text(f'''# PR309 parent-based CI independent record review

Run {d['run_id']}, head `{d['head']}`, base `{d['base']['ref']}` / `{d['base']['sha']}`. Actual synthetic checkout `{d['checkout'][-1]['text']}`; `{d['checkout'][0]['text']}`. This is not a bare-head checkout claim.

Five applicable jobs succeeded; paid smoke skipped. Lint, Inventory freshness, Build, Typecheck, Test and subsequent applicable smoke steps succeeded. check/Test contains 22 unique packages: {d['totals']['passed']} passed / {d['totals']['skipped']} skipped / {d['totals']['failed']} failed. GitHub package {gh['passed']} passed; CLI package {cli['passed']} passed / {cli['skipped']} skipped. The separate offline candidate CLI step passed 14. Export contracts:94 total/93 passed/1 skipped; projection88, journey43, pagination14, maintenance24 passed.

Logged actual two- and five-case journeys passed with expected product exits 0/1 and 0/1/2/1/0; driver exits all0, fixture removal recorded. Default/full projection and check each emitted matching logged packet SHA and valid status. Five-case maintenance was consistent, exit0, with unchanged map. Engineering decision and local Git skills-check smokes passed. Full structured values and source log line numbers are in report.json.

PR309 remains Draft against its parent; this parent-based CI does not establish actual-main readiness. The final run was not re-run or modified by this reviewer. Raw full logs plus lossless gzip and command/metadata records are retained. No artifacts were downloaded or independently rehashed. This is evidence parsing, not independent product test execution; no native-host, formal-gate or full-process-tree qualification is implied. PR metadata is a collection-time snapshot; only root changes Ready.
''')
files=[]
for p in sorted(r.rglob('*')):
 if p.is_file() and p.name not in ['manifest.json','final-manifest.json']:
  b=p.read_bytes();files.append({'path':str(p.relative_to(r)),'sha256':h(b),'bytes':len(b),'mode':oct(stat.S_IMODE(p.stat().st_mode))})
(r/'manifest.json').write_text(json.dumps({'files':files,'count':len(files)},indent=2)+'\n')
finalnames=['target-binding.json','run.stdout','jobs.stdout','pr-final.stdout','pr-final.command.json','pr-final.stderr','complete-log.stdout','complete-log.log.gz','complete-log.command.json','complete-log.stderr','report.json','report.md','parse.py','finalize.py']
final=[x for x in files if x['path'] in finalnames];assert len(final)==len(finalnames)
(r/'final-manifest.json').write_text(json.dumps({'files':final,'count':len(final)},indent=2)+'\n')
print(json.dumps({'totals':d['totals'],'github':gh['passed'],'checkout':d['checkout'],'report_sha256':h((r/'report.json').read_bytes()),'final_manifest_sha256':h((r/'final-manifest.json').read_bytes()),'manifest_sha256':h((r/'manifest.json').read_bytes())},indent=2))
