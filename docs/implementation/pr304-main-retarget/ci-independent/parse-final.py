import json,re,hashlib,datetime,stat
from pathlib import Path
R=Path(__file__).parent
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
run=json.loads((R/'run-final.json').read_text());assert run['status']=='completed' and run['conclusion']=='success'and run['headSha']=='7ef051ffa6c4bfa8d608eb41d9ea931622a10fb9';steps={};rows=[];tap={};checkout=[]
for line in(R/'full.log').read_text().splitlines():
 a=line.split('\t',2)
 if len(a)!=3 or a[0]!='check':continue
 step=a[1];txt=re.sub(r'^\ufeff?\d{4}-\S+Z\s?','',a[2]);txt=re.sub(r'(?:\x1b|\^\[)\[[0-9;]*m','',txt);steps.setdefault(step,[]).append(txt)
 if step=='Test':
  m=re.search(r'packages/([^ ]+) test:\s+Tests\s+(.*)',txt)
  if m:
   ns={k:int(n)for n,k in re.findall(r'(\d+) (passed|skipped|failed)',m[2])};rows.append({'package':m[1],**{k:ns.get(k,0)for k in ['passed','skipped','failed']}})
 m=re.fullmatch(r'# (tests|pass|fail|skipped) (\d+)',txt)
 if m:tap.setdefault(step,{})[m[1]]=int(m[2])
 if step.startswith('Run actions/checkout')and ('HEAD is now at'in txt or re.fullmatch('[a-f0-9]{40}',txt)):checkout.append(txt)
assert len(rows)==22 and len({x['package']for x in rows})==22;totals={k:sum(r[k]for r in rows)for k in ['passed','skipped','failed']};assert totals=={'passed':7142,'skipped':7,'failed':0}
journeys={}
for step,exits in [('Method verification journey (two real local cases)',[0,1]),('Full method verification journey (five real local cases)',[0,1,2,1,0])]:
 s='\n'.join(steps[step]);j=json.JSONDecoder().raw_decode(s[s.index('\n{\n')+1:])[0];assert j['status']=='passed';assert [x['product_exit']for x in j['features']]==exits;assert all(x['verification']=='passed'and x['driver_exit']==0 and x['cleanup']['fixture_removed']is True for x in j['features']);journeys[step]=j
p=[json.loads(x)for x in steps['Project and check actual method evidence']if x.startswith('{"status"')];assert [x['status']for x in p]==['projected','valid']and p[0]['packet_sha256']==p[1]['packet_sha256'];assert p[1]['original_evidence_revalidated']is False and p[1]['formal_gate_pass']is False
jobs=[{'name':j['name'],'status':j['status'],'conclusion':j['conclusion']}for j in run['jobs']];assert sum(j['conclusion']=='success'for j in jobs)==5 and sum(j['conclusion']=='skipped'for j in jobs)==1
for name,n in [('Method verification journey contracts',43),('Model evidence projection contracts',49),('Method material pagination contracts',14)]:assert tap[name]=={'tests':n,'pass':n,'fail':0,'skipped':0}
assert tap['Method export contracts']=={'tests':94,'pass':93,'fail':0,'skipped':1}
v={'observed_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'run':40855140718,'head':run['headSha'],'base':'a0ecd79dce9c215a19cadc9b6ccb0c6fa7331db7','job_results':jobs,'actual_checkout':checkout,'unique_package_count':22,'package_totals':totals,'package_summaries':rows,'standalone_summaries':tap,'actual_journeys':journeys,'default_projection_check':p,'full_projection_refusal':{'origin':'local prior B execution, C read-only byte/command inspection; not CI step','record':json.loads((R/'local-full-projection-refusal.json').read_text()),'ci_does_not_contain_full_projection_step':True},'diff_context':{'complete_diff_paths':18,'new_head_tree_equals_old_304':True,'filtered_scripts_skills_ci_diff_is_not_complete_pr_diff':True,'readme':json.loads((R/'readme-binding.json').read_text())},'raw_bindings':{n:sha(R/n)for n in ['run-final.json','full.log','pr-initial.json','local-full-projection-refusal.json']},'limits':['No product tests/models/CI rerun or PR/ledger mutation by C.','Artifact contents not downloaded or rehashed; CI log manifest references are not artifact integrity proof.','CI package totals7142/7 not substituted by local7144/5.','Exporter94total includes1skip; only93passed.','Tree equality alone was not used as validation; this report refers newhead actual freshCI.','Sonnet filtered diff excludes some files by construction; separately supplied README is real Gitblob, not a missing artifact.','No runtime/formalqualification inferred.']}
(R/'report.json').write_text(json.dumps(v,indent=2)+'\n');(R/'report.md').write_text('# PR304 new-main CI independent check\n\nRun40855140718 completed successfully for7ef051ffa6c4bfa8d608eb41d9ea931622a10fb9 againsta0ecd79d. Five applicable jobs succeeded; paid smoke skipped. Actual checkout: '+str(checkout)+'\n\n22unique package summaries:7,142passed/7skipped/0failed. Journey43/43, projector49/49, reader14/14; exporter94total=93passed+1skipped. Real default2 and full5 journeys passed (products0/1 and0/1/2/1/0, driver0, fixture_removedtrue). Default projector/check loggedmatchinghash.\n\nFulljourney refusal is a separately retained LOCAL validation at7ef:exit1 fixed_case_set/nooutput/unchangedinputs; it was not a CI projection step. No artifact was downloaded/rehashed.\n\nNewhead tree equals old304; complete PRdiff18paths. The audit scripts/skills/CI-filtered view was not the complete PRdiff; README exists as Gitblob b7355b42. No source omission/conflict identified from this relation. No tests/models or PR/ledger actions were run by this independent checker.\n')
files=[]
for q in sorted(R.iterdir()):
 if q.is_file()and q.name!='manifest.json':files.append({'path':q.name,'bytes':q.stat().st_size,'mode':stat.S_IMODE(q.stat().st_mode),'sha256':sha(q)})
(R/'manifest.json').write_text(json.dumps({'files':files},indent=2)+'\n');print(checkout);print('report',sha(R/'report.json'));print('manifest',sha(R/'manifest.json'));print('log',sha(R/'full.log'))
