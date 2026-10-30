from pathlib import Path
import json,re,hashlib,gzip,stat,datetime
root=Path(__file__).parent
sha=lambda b:hashlib.sha256(b).hexdigest()
reports=[]
for pr in (307,308):
 p=root/str(pr);d=json.loads((p/'report.json').read_text());raw=(p/'complete-log.stdout').read_bytes()
 assert gzip.decompress((p/'complete-log.log.gz').read_bytes())==raw
 assert sum(j['conclusion']=='success' for j in d['jobs'])==5
 assert sum(j['conclusion']=='skipped' for j in d['jobs'])==1
 assert d['totals']=={'passed':7189 if pr==307 else 7207,'skipped':7,'failed':0}
 steps={x['name']:x for x in d['check_steps']}
 for s in ('Lint (Biome)','Build','Inventory freshness','Typecheck','Test'):assert steps[s]['conclusion']=='success'
 obs=d['actual_steps'];compact={}
 for name,exits in [('Method verification journey (two real local cases)',[0,1]),('Full method verification journey (five real local cases)',[0,1,2,1,0])]:
  rs=obs[name]['json_records'];assert len(rs)==1
  o=rs[0]['value'];assert o['status']=='passed'
  assert [f['product_exit'] for f in o['features']]==exits
  assert all(f['verification']=='passed' and f['driver_exit']==0 and f['cleanup']['fixture_removed'] is True and f['cleanup']['descendant_termination']=='not_attested' for f in o['features'])
  compact[name]={'line':rs[0]['line'],'status':o['status'],'product_exits':exits,'driver_exits':[f['driver_exit'] for f in o['features']],'fixture_removed':True,'descendants':'not_attested'}
 for name in ['Project and check actual method evidence','Project and check full five-case method evidence']:
  rs=obs[name]['json_records'];assert len(rs)==2
  a,b=[r['value'] for r in rs];assert a['status']=='projected' and b['status']=='valid' and a['packet_sha256']==b['packet_sha256'] and b['original_evidence_revalidated'] is False
  compact[name]={'lines':[r['line'] for r in rs],'statuses':['projected','valid'],'logged_packet_sha256':a['packet_sha256'],'independently_rehashed_artifact':False}
 name='Maintain fixed skills map (five real local cases)';rs=obs[name]['json_records'];assert len(rs)==1
 o=rs[0]['value'];assert o['status']=='consistent' and o['exit_code']==0 and o['map']['unchanged'] is True and o['map']['before_sha256']==o['map']['after_sha256']
 assert [f['product_exit'] for f in o['journey']['features']]==[0,1,2,1,0]
 compact[name]={'line':rs[0]['line'],'status':o['status'],'exit_code':o['exit_code'],'map_unchanged':True,'map_sha256':o['map']['before_sha256'],'product_exits':[0,1,2,1,0]}
 for name in ['Session adoption decision smoke (local fixture)','Skills check verification (local Git fixtures)']:
  rs=obs[name]['json_records'];assert len(rs)==1 and rs[0]['value']['status']=='passed'
  o=rs[0]['value'];compact[name]={'line':rs[0]['line'],'status':o['status'],'provider_qualified':o['provider_qualified'],'cleanup':o['cleanup']}
  if 'cases' in o:assert [x['actual_exit'] for x in o['cases']]==[0,1,2,1,0] and o['driver_exit']==0
 d['actual_summary']=compact
 d['lint_inventory_raw_lines']=[{'line':i,'text':l} for i,l in enumerate(raw.decode().splitlines(),1) if l.startswith('check\tInventory freshness\t') or (l.startswith('check\tLint (Biome)\t') and ('Checked ' in l or 'error' in l.lower()))]
 (p/'report.json').write_text(json.dumps(d,indent=2)+'\n')
 gh=next(x for x in d['packages'] if x['package']=='github')
 md=f'''# PR {pr} completed CI record verification

- Run: {d['run_id']}; head `{d['head']}`; recorded base `{d['base']['ref']}` / `{d['base']['sha']}`.
- Actual checkout: `{d['checkout'][-1]['text']}`. {d['checkout'][0]['text']}. These are synthetic merge tests, not a claim that the bare PR head was checked out.
- Five jobs success; paid semantic smoke skipped. Lint, Build, Inventory freshness, Typecheck, Test and all subsequent applicable check steps succeeded.
- check/Test: 22 unique packages, **{d['totals']['passed']} passed / 7 skipped / 0 failed**. GitHub package: **{gh['passed']} passed**. Standalone PR snapshot CLI: **14 passed** (distinct from the CLI package's 2764 passed / 6 skipped).
- Standalone export: 94 total / 93 passed / 1 skipped; projection 88, journey 43, pagination 14, maintenance 24 all passed. Export skip is the absent global Codex skills-home case, preserved verbatim in report.json.
- Actual default and full journeys recorded expected product exits 0/1 and 0/1/2/1/0 respectively, with driver exit 0 and fixture removal. Both project/check pairs emitted matching packet hashes and valid status. Maintenance recorded consistent status, exit 0 and unchanged map. Engineering adoption and local Git skills-check smokes recorded passed.

This is independent parsing of complete CI records, not local test re-execution. Raw log bytes and lossless gzip are retained; ANSI is removed only in the parsing view. Logged packet hashes were not independently rehashed: no artifacts were downloaded. Fixture removal does not prove full-descendant termination. No model/native provider or formal gate qualification is inferred. PR state is only the collection-time snapshot; this task did not change it.
'''
 (p/'report.md').write_text(md)
 reports.append({'pr':pr,'run_id':d['run_id'],'head':d['head'],'base':d['base'],'checkout':d['checkout'],'totals':d['totals'],'github_passed':gh['passed'],'candidate_cli_passed':14,'report_sha256':sha((p/'report.json').read_bytes())})
(root/'summary.json').write_text(json.dumps({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'reports':reports,'scope':'Read-only CI record verification; no artifact downloads or test re-execution'},indent=2)+'\n')
files=[]
for f in sorted(root.rglob('*')):
 if f.is_file() and f.name!='final-manifest.json':
  b=f.read_bytes();files.append({'path':str(f.relative_to(root)),'bytes':len(b),'mode':oct(stat.S_IMODE(f.stat().st_mode)),'sha256':sha(b)})
(root/'final-manifest.json').write_text(json.dumps({'files':files,'file_count':len(files)},indent=2)+'\n')
print(json.dumps({'reports':reports,'manifest_sha256':sha((root/'final-manifest.json').read_bytes()),'files':len(files)},indent=2))
