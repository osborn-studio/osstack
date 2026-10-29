from pathlib import Path
import json,re,hashlib,datetime
p=Path(__file__).parent
h=lambda b:hashlib.sha256(b).hexdigest()
raw=(p/'full.log').read_text();clean=re.sub(r'(?:\x1b|\^\[)\[[0-9;]*m','',raw);groups={};rows=[]
for no,l in enumerate(clean.splitlines(),1):
 parts=l.split('\t',2)
 if len(parts)!=3 or parts[0]!='check':continue
 step=parts[1];content=re.sub(r'^\ufeff?\S+Z ','',parts[2]);groups.setdefault(step,[]).append((no,content))
 if step=='Test':
  m=re.search(r'packages/(\S+) test:\s+Tests\s+(.*)',content)
  if m:rows.append({'package':m[1],'line':no,**{k:sum(map(int,re.findall(r'(\d+) '+k,m[2]))) for k in ['passed','skipped','failed']}})
assert len(rows)==22 and len({x['package'] for x in rows})==22
run=json.loads((p/'run.json').read_text());pr=json.loads((p/'pr300.json').read_text());parent=json.loads((p/'pr299.json').read_text())
assert run['headSha']==pr['headRefOid']=='0e5d2c9800ddc657c11580a5e80ff4d7ea342bf7'
assert pr['baseRefOid']==parent['headRefOid']=='7deee3af868c50958dcc651f2a5a7599e4750c60'
assert pr['isDraft'] and pr['state']==parent['state']=='OPEN'
assert pr['baseRefName']=='codex/method-continuity-delivery'
checks=[x for x in pr['statusCheckRollup'] if x['conclusion']!='SKIPPED'];assert len(checks)==5 and all(x['conclusion']=='SUCCESS' for x in checks)
assert run['status']=='completed' and run['conclusion']=='success'
steps={x['name']:x['conclusion'] for j in run['jobs'] if j['name']=='check' for x in j['steps']}
related=['Method export contracts','Session adoption decision smoke (local fixture)','Skills check verification (local Git fixtures)','Method verification journey contracts','Method verification journey (two real local cases)','Model evidence projection contracts','Project and check actual method evidence']
summaries={}
for name in related:
 assert steps[name]=='success'
 data=groups[name];s={'step_conclusion':steps[name],'line_start':data[0][0],'line_end':data[-1][0]}
 for no,c in data:
  m=re.fullmatch(r'# (tests|pass|fail|cancelled|skipped|todo) (\d+)',c)
  if m:s[m[1]]=int(m[2])
 s['skip_details']=[{'line':no,'text':c} for no,c in data if '# SKIP' in c]
 summaries[name]=s
assert summaries['Method export contracts']['tests']==91 and summaries['Method export contracts']['pass']==90 and summaries['Method export contracts']['skipped']==1
# Parse emitted JSON records from full, untruncated CI text; these remain CI claims, not a download/reverification of artifact contents.
objects={}
for name in related:
 data=groups[name]
 for index,(no,c) in enumerate(data):
  if c=='{' or c.startswith('{"status"'):
   try:o,end=json.JSONDecoder().raw_decode('\n'.join(x[1] for x in data[index:]));objects.setdefault(name,[]).append({'line':no,'value':o})
   except json.JSONDecodeError:pass
(p/'smoke-receipts-from-log.json').write_text(json.dumps(objects,indent=2)+'\n')
adoption=objects[related[1]][0]['value'];skills=objects[related[2]][0]['value'];journey=objects[related[4]][0]['value'];projection=[x['value'] for x in objects[related[6]]]
assert adoption['status']=='passed' and adoption['action_receipt']=='applied' and adoption['completion_level']=='observed_turn' and adoption['cleanup']['scratch_removed']
assert skills['status']=='passed' and skills['driver_exit']==0 and skills['selected_cases']==['healthy','missing-ref','drift','mixed','empty']
assert journey['status']=='passed' and [(x['case_id'],x['product_exit'],x['driver_exit']) for x in journey['features']]==[('healthy',0,0),('missing-ref',1,0)]
assert all(x['verification']=='passed' and x['cleanup']['fixture_removed'] and x['cleanup']['descendant_termination']=='not_attested' for x in journey['features'])
assert [x['status'] for x in projection]==['projected','valid'] and projection[0]['packet_sha256']==projection[1]['packet_sha256']
report={'observed_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'run_id':40789146519,'attempt':run['attempt'],'head_sha':pr['headRefOid'],'base':{'name':pr['baseRefName'],'sha':pr['baseRefOid']},'pr300':{'state':pr['state'],'isDraft':pr['isDraft']},'pr299':parent,'applicable_checks':[{'name':x['name'],'conclusion':x['conclusion']} for x in checks],'package_summaries':rows,'package_totals':{k:sum(x[k] for x in rows) for k in ['passed','skipped','failed']},'counting_scope':'One final Tests line for each of 22 unique packages within check/Test only; matrix, smoke and individual cases excluded from package total.','related_steps':summaries,'smoke_observations':{'adoption':{'status':adoption['status'],'receipt':adoption['action_receipt'],'completion':adoption['completion_level'],'cleanup_removed':adoption['cleanup']['scratch_removed']},'skills':{'status':skills['status'],'driver_exit':skills['driver_exit'],'selected_cases':skills['selected_cases'],'cases':skills.get('cases'),'cleanup':skills.get('cleanup')},'journey':{'status':journey['status'],'features':journey['features'],'host_execution':journey['host_execution'],'formal_gate_pass':journey['formal_gate_pass']},'projection':projection},'limitations':['Current branch-base CI success does not substitute for post-parent-merge main revalidation. #300 remains Draft; #299 was OPEN at observation.','Exporter has 91 total, 90 passed, 1 skipped because global Codex home is absent; do not report 91 passed.','Smoke receipts are observed in complete CI log; artifact file contents were not independently downloaded/rehashed in this task.','No model calls, tests, CI dispatch/retry, product changes, PR/ledger mutations, or runtime qualification by this reviewer.']}
(p/'report.json').write_text(json.dumps(report,indent=2)+'\n')
manifest={'created_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'members':[{'path':x.name,'bytes':x.stat().st_size,'sha256':h(x.read_bytes())} for x in sorted(p.iterdir()) if x.is_file() and x.name!='manifest.json']}
(p/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
print(json.dumps({'totals':report['package_totals'],'exporter':summaries['Method export contracts'],'report_sha256':h((p/'report.json').read_bytes()),'manifest_sha256':h((p/'manifest.json').read_bytes())},indent=2))
