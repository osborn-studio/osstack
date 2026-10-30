from pathlib import Path
import re,json,hashlib,datetime,collections
R=Path(__file__).resolve().parent;P=R.parent
sha=lambda b:hashlib.sha256(b).hexdigest()
inputs=[{'path':n,'bytes':(P/n).stat().st_size,'sha256':sha((P/n).read_bytes())}for n in ['metadata.stdout','full-log.stdout','pr-before.stdout']]
(R/'input-hashes.json').write_text(json.dumps(inputs,indent=2)+'\n')
metadata=json.loads((P/'metadata.stdout').read_text());pr=json.loads((P/'pr-before.stdout').read_text())
assert metadata['headSha']==pr['headRefOid']=='f70f40265ddfb1e419d6b8f5145d46c71060b9bc'
assert metadata['conclusion']=='success'
jobs=[{'name':x['name'],'conclusion':x['conclusion'],'url':x['url']}for x in metadata['jobs']]
assert sum(x['conclusion']=='success'for x in jobs)==5
assert [x['name']for x in jobs if x['conclusion']=='skipped']==['Paid DeepSeek semantic smoke']
ansi=re.compile(r'(?:\x1b|\^\[)\[[0-?]*[ -/]*[@-~]')
steps=collections.defaultdict(list)
for number,line in enumerate((P/'full-log.stdout').read_text().splitlines(),1):
 parts=line.split('\t',2)
 if len(parts)!=3:continue
 job,step,payload=parts
 payload=re.sub(r'^\ufeff?\d{4}-\d\d-\d\dT\S+Z\s?', '',payload)
 payload=ansi.sub('',payload)
 steps[job,step].append({'line':number,'text':payload})
packages=[]
for x in steps['check','Test']:
 m=re.search(r'packages/([\w-]+) test:\s+Tests\s+(.+)$',x['text'])
 if not m:continue
 nums={key:int(value)for value,key in re.findall(r'(\d+) (passed|skipped|failed|todo)',m[2])}
 total=int(re.search(r'\((\d+)\)\s*$',m[2])[1]);assert total==sum(nums.values()),x
 packages.append({'package':m[1],'pass':nums.get('passed',0),'skip':nums.get('skipped',0),'fail':nums.get('failed',0),'todo':nums.get('todo',0),'total':total,'line':x['line'],'text':x['text']})
assert len(packages)==len({x['package']for x in packages})==22
sums={k:sum(x[k]for x in packages)for k in ['pass','skip','fail','todo','total']};assert sums['fail']==0
checks=['Method export contracts','Relevant feature-map selection contracts','Method material pagination contracts','Method verification journey contracts','Skills map maintenance contracts','Model evidence projection contracts','Session adoption decision smoke (local fixture)','Skills check verification (local Git fixtures)']
targeted=[]
for step in checks:
 counters={};refs=[]
 for x in steps['check',step]:
  m=re.fullmatch(r'# (tests|pass|fail|cancelled|skipped|todo) (\d+)',x['text'])
  if m:
   assert m[1]not in counters,(step,'duplicate TAP aggregate');counters[m[1]]=int(m[2]);refs.append(x)
 assert counters['tests']==sum(counters.get(k,0)for k in ['pass','fail','cancelled','skipped','todo']),(step,counters)
 assert counters['fail']==counters.get('cancelled',0)==0
 targeted.append({'step':step,**counters,'line_refs':refs,'skip_details':[x for x in steps['check',step]if '# SKIP' in x['text']]})
checkout=steps['check','Run actions/checkout@v7'];merge=[x for x in checkout if 'HEAD is now at' in x['text']];assert len(merge)==1
headlog=[i for i,x in enumerate(checkout)if 'git log -1 --format=%H' in x['text']];assert len(headlog)==1
actual=checkout[headlog[0]+1];assert re.fullmatch('[a-f0-9]{40}',actual['text']);assert metadata['headSha']in merge[0]['text']
(R/'package-summaries.json').write_text(json.dumps(packages,indent=2)+'\n');(R/'targeted.json').write_text(json.dumps(targeted,indent=2)+'\n')
def receipts(step):
 rows=steps['check',step];found=[]
 for i,row in enumerate(rows):
  if not row['text'].startswith('{'):continue
  text='\n'.join(x['text']for x in rows[i:])
  try:obj,end=json.JSONDecoder().raw_decode(text)
  except json.JSONDecodeError:continue
  found.append({'line':row['line'],'end_line':rows[i+text[:end].count('\n')]['line'],'value':obj})
 return found
D='Method verification journey (two real local cases)';F='Full method verification journey (five real local cases)';M='Maintain fixed skills map (five real local cases)'
received={}
for key,step in [('default',D),('full',F),('map',M)]:
 objs=receipts(step);assert len(objs)==1,(step,len(objs));received[key]=objs[0];(R/f'{key}-receipt.json').write_text(json.dumps(objs[0],indent=2)+'\n')
expected=[('healthy',0,'healthy'),('missing-ref',1,'failed'),('drift',2,'drift'),('mixed',1,'failed'),('empty',0,'empty')]
def check_features(rows,want):
 assert [(x['case_id'],x['product_exit'],x['product_status'])for x in rows]==want
 for x in rows:
  assert x['driver_exit']==0 and x['verification']=='passed',x
  assert x['cleanup']['status']=='passed' and x['cleanup']['fixture_removed']is True,x
 return [{k:x[k]for k in ['case_id','product_exit','product_status','driver_exit','verification','cleanup']}for x in rows]
for key,want in [('default',expected[:2]),('full',expected)]:
 obj=received[key]['value'];assert obj['status']=='passed'and obj['formal_gate_pass']is False;received[key]['verified_rows']=check_features(obj['features'],want)
obj=received['map']['value'];assert obj['status']=='consistent' and obj['exit_code']==0 and obj['map']['unchanged']is True and obj['map']['before_sha256']==obj['map']['after_sha256'];assert obj['failure']is None and obj['subsequent_failures']==[];assert obj['journey']['status']=='passed';assert len(obj['rows'])==5 and all(x['matches']is True for x in obj['rows']);received['map']['verified_rows']=check_features(obj['journey']['features'],expected)
projection=[]
for step in ['Project and check actual method evidence','Project and check full five-case method evidence']:
 objs=receipts(step);assert [x['value']['status']for x in objs]==['projected','valid'];assert objs[0]['value']['packet_sha256']==objs[1]['value']['packet_sha256'];assert objs[0]['value']['input_opened_read_only']is True and objs[1]['value']['original_evidence_revalidated']is False;assert all(x['value']['formal_gate_pass']is False for x in objs);projection.append({'step':step,'receipts':objs,'commands':[x for x in steps['check',step]if x['text'].startswith('$ node ')]})
(R/'projection-receipts.json').write_text(json.dumps(projection,indent=2)+'\n')
checksteps={x['name']:x['conclusion']for j in metadata['jobs']if j['name']=='check'for x in j['steps']}
for step in checks+[D,F,M]+[x['step']for x in projection]:assert checksteps[step]=='success'
report={'recorded_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'run_id':41014856944,'head':metadata['headSha'],'pr_snapshot':{'number':pr['number'],'state':pr['state'],'isDraft':pr['isDraft'],'baseRefName':pr['baseRefName'],'mergeable':pr['mergeable']},'jobs':jobs,'actual_checkout':actual,'merge_line':merge[0],'packages':{'unique_count':len(packages),**sums,'counting_scope':'check/Test exact Tests summaries only; excludes Test Files, runtime matrices and later focused suites'},'targeted':targeted,'journeys':{key:{'line':value['line'],'end_line':value['end_line'],'status':value['value']['status'],'rows':value['verified_rows']}for key,value in received.items()},'map':{'unchanged':obj['map']['unchanged'],'all_rows_match':True},'projection':projection,'input_hashes':inputs,'limits':['Read supplied complete logs and snapshots only; no live GitHub query, PR mutation or product/test/model rerun.','Artifact archives not downloaded; no independent member hash/cleanup filesystem/source-build revalidation. Logged packet SHA equality is only equality of two logged receipts.','CI actual checkout is synthetic merge SHA, distinct from PR head. PR state is input snapshot, not a later status assertion.','Expected-negative product exits1/2 coexist with successful driver verification; no fullA35/A48/C0 or formal gate approval.']}
(R/'report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n');print(json.dumps({'packages':report['packages'],'checkout':actual['text'],'targeted':[{k:v for k,v in x.items()if k not in ['line_refs','skip_details']}for x in targeted]},ensure_ascii=False))
