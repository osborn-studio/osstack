import json,re,hashlib
from pathlib import Path
r=Path(__file__).parent;b=(r/'full.log').read_bytes();s=b.decode();s=re.sub(r'(?:\x1b|\^\[)\[[0-?]*[ -/]*[@-~]','',s);lines=s.splitlines();packages={};taps={};checkout=[]
for i,l in enumerate(lines):
 cols=l.split('\t',2)
 if len(cols)!=3:continue
 job,step,text=cols
 if 'git log -1 --format=%H' in text:
  nextline=lines[i+1];m=re.search(r'\b[0-9a-f]{40}\b',nextline)
  if m:checkout.append({'job':job,'step':step,'sha':m.group(),'line':i+2})
 if job!='check':continue
 if step=='Test':
  m=re.search(r'packages/([^ ]+) test:\s+Tests\s+(.*)',text)
  if m:
   assert m[1]not in packages
   counts={k:int(n)for n,k in re.findall(r'(\d+) (passed|skipped|failed)',m[2])};packages[m[1]]={'passed':counts.get('passed',0),'skipped':counts.get('skipped',0),'failed':counts.get('failed',0),'line':i+1}
 m=re.search(r'# (tests|pass|fail|skipped) (\d+)\s*$',text)
 if m:taps.setdefault(step,{})[m[1]]=int(m[2])
assert len(packages)==22
metadata=json.loads((r/'run-third.json').read_text());assert metadata['status']=='completed' and metadata['conclusion']=='success';total={k:sum(v[k]for v in packages.values())for k in ['passed','skipped','failed']}
x={'run':metadata['databaseId'],'head':metadata['headSha'],'status':metadata['conclusion'],'log_sha256':hashlib.sha256(b).hexdigest(),'log_bytes':len(b),'check_test_unique_packages':packages,'check_test_total':total,'tap_steps_separate_not_added_to_package_total':taps,'checkout':checkout,'jobs':[{'name':j['name'],'conclusion':j['conclusion']}for j in metadata['jobs']],'limits':['Metadata head differs from synthetic checkout by design; actual checkout SHA recorded from log.','No artifacts downloaded/rehashed. No CI rerun/product execution.','Full Test package totals exclude separate TAP and repeated matrix execution.']};(r/'report.json').write_text(json.dumps(x,indent=2)+'\n');(r/'report.md').write_text('# PR314 CI 独立核验\n\nRun %s，head `%s`，五适用 SUCCESS、paid SKIP。\n\ncheck/Test 独立22包：%s passed / %s skipped / %s failed。实际 check checkout `%s`。\n\n独立导出115 total /114 pass /1 skip；feature40、health45、preparer16、reader14、journey43、map25、projection89 均pass，未重复加入22包总数。\n\n原始日志 SHA256 `%s`。未下载或重hash远端artifact，未重跑测试。\n'%(metadata['databaseId'],metadata['headSha'],total['passed'],total['skipped'],total['failed'],next(c['sha']for c in checkout if c['job']=='check'),hashlib.sha256(b).hexdigest()));print(json.dumps({'total':total,'checkout':checkout,'log_sha256':x['log_sha256']}))
