import re,json,hashlib,datetime,stat
from pathlib import Path
R=Path(__file__).parent
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
run=json.loads((R/'run.json').read_text());pr=json.loads((R/'pr.json').read_text());assert run['status']=='completed' and run['conclusion']=='success';assert run['headSha']==pr['headRefOid']=='52f16faf9fdb73e0f8e815e8ee6987297c67d4da';assert pr['baseRefOid']=='185d283af23683ad084f81a6b049fcaab251a68f' and pr['isDraft']
steps={};rows=[];standalone={};checkout=[]
for l in (R/'full.log').read_text().splitlines():
 a=l.split('\t',2)
 if len(a)!=3 or a[0]!='check':continue
 step=a[1];txt=re.sub(r'^\ufeff?\d{4}-\S+Z\s?','',a[2]);txt=re.sub(r'(?:\x1b|\^\[)\[[0-9;]*m','',txt);steps.setdefault(step,[]).append(txt)
 if step=='Test':
  m=re.search(r'packages/([^ ]+) test:\s+Tests\s+(.*)',txt)
  if m:
   nums={k:int(n)for n,k in re.findall(r'(\d+) (passed|skipped|failed)',m[2])};rows.append({'package':m[1],**{k:nums.get(k,0)for k in ['passed','skipped','failed']}})
 m=re.fullmatch(r'# (tests|pass|fail|skipped) (\d+)',txt)
 if m:standalone.setdefault(step,{})[m[1]]=int(m[2])
 if step.startswith('Run actions/checkout') and ('HEAD is now at'in txt or re.fullmatch('[a-f0-9]{40}',txt)):checkout.append(txt)
assert len(rows)==22 and len({r['package']for r in rows})==22
totals={k:sum(r[k]for r in rows)for k in ['passed','skipped','failed']}
assert totals=={'passed':7142,'skipped':7,'failed':0}
journeys={};projections={}
for name,expected in [('Method verification journey (two real local cases)',[0,1]),('Full method verification journey (five real local cases)',[0,1,2,1,0])]:
 s='\n'.join(steps[name]);start=s.index('\n{\n')+1;j=json.JSONDecoder().raw_decode(s[start:])[0];assert j['status']=='passed' and [f['product_exit']for f in j['features']]==expected;assert all(f['verification']=='passed' and f['driver_exit']==0 and f['cleanup']['fixture_removed']is True for f in j['features']);journeys[name]=j
for name in ['Project and check actual method evidence','Project and check full five-case method evidence']:
 xs=[json.loads(x)for x in steps[name]if x.startswith('{"status"')];assert [x['status']for x in xs]==['projected','valid'] and xs[0]['packet_sha256']==xs[1]['packet_sha256'];assert xs[0]['formal_gate_pass']is False and xs[1]['formal_gate_pass']is False and xs[1]['original_evidence_revalidated']is False;projections[name]=xs
jobs=[{'name':j['name'],'status':j['status'],'conclusion':j['conclusion']}for j in run['jobs']];assert sum(j['conclusion']=='success'for j in jobs)==5 and sum(j['conclusion']=='skipped'for j in jobs)==1
selected={k:v for k,v in standalone.items()if k in ['Method export contracts','Method material pagination contracts','Method verification journey contracts','Model evidence projection contracts']};assert selected['Method export contracts']=={'tests':94,'pass':93,'fail':0,'skipped':1};assert selected['Model evidence projection contracts']=={'tests':88,'pass':88,'fail':0,'skipped':0}
v={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'run_id':40845007211,'head':run['headSha'],'base':pr['baseRefOid'],'base_branch':pr['baseRefName'],'pr_state':pr['state'],'draft':pr['isDraft'],'job_results':jobs,'actual_checkout':checkout,'package_count':22,'package_totals':totals,'unique_packages':rows,'requested_standalone_tests':selected,'all_standalone_summaries':standalone,'journeys':journeys,'projections':projections,'raw_bindings':{n:sha(R/n)for n in ['run.json','pr.json','full.log']},'limits':['No tests, models, CI retries or PR/ledger mutations executed by verifier.','Uploaded artifact contents not downloaded or rehashed; packet hashes are log-reported and compared only between project/check outputs.','Tests ran on synthetic PR merge shown in checkout, not an assertion that source head itself was checked out.','Full package7142/7 differs from local7144/5 due reported skips; no cross-run aggregation.','94exporter total is93passed+1skipped, not94passed.','PR remainsDraft against predecessor185d; noReady/merge decision inferred.']}
(R/'report.json').write_text(json.dumps(v,indent=2)+'\n');(R/'report.md').write_text('# PR305 new-head independent CI check\n\nRun40845007211 succeeded for head52f16faf9fdb73e0f8e815e8ee6987297c67d4da against185d283af23683ad084f81a6b049fcaab251a68f. Five applicable jobs succeeded; paid smoke skipped. PR remains Draft.\n\nActual checkout: '+str(checkout)+'\n\n22 unique package summaries total7,142passed/7skipped/0failed. Standalone: projector88/88, journey43/43, reader14/14; exporter94total=93passed+1skipped.\n\nThe real default2 and full5 journeys both passed with product exits0/1 and0/1/2/1/0; driver exits0 and fixture_removed true for each. Both corresponding projection/check pairs logged matching packet hashes and formal_gate_pass:false; --check explicitly original_evidence_revalidated:false.\n\nNo artifact downloaded/rehashed, no new test/model/CI execution or PR mutation. Log-reported artifact references are not independent artifact-byte verification. Full raw log and exact query commands are retained.\n')
files=[]
for p in sorted(R.iterdir()):
 if p.is_file()and p.name!='manifest.json':files.append({'path':p.name,'bytes':p.stat().st_size,'mode':stat.S_IMODE(p.stat().st_mode),'sha256':sha(p)})
(R/'manifest.json').write_text(json.dumps({'files':files},indent=2)+'\n');print('checkout',checkout);print('totals',totals);print('report',sha(R/'report.json'));print('manifest',sha(R/'manifest.json'));print('rawlog',sha(R/'full.log'))
