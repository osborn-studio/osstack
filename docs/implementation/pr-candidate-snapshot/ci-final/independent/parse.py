from pathlib import Path
import json,re,gzip,hashlib,datetime,traceback
import sys
root=Path(__file__).parent/sys.argv[1]
def sha(b):return hashlib.sha256(b).hexdigest()
def write(n,v):(root/n).write_text(json.dumps(v,indent=2)+'\n')
try:
 raw=gzip.decompress((root/'complete-log.log.gz').read_bytes());assert raw==(root/'complete-log.stdout').read_bytes()
 run=json.loads((root/'run.stdout').read_bytes());jobs=json.loads((root/'jobs.stdout').read_bytes())
 rows=[]
 for n,l in enumerate(raw.decode().splitlines(),1):
  p=l.split('\t',2)
  if len(p)==3 and p[0]=='check':
   t=re.sub(r'(?:\x1b\[|\^\[\[)[0-?]*[ -/]*[@-~]','',p[2]).split('Z ',1)[-1].lstrip('\ufeff')
   rows.append((n,p[1],t))
 packages=[]
 for n,s,t in rows:
  m=re.fullmatch(r'packages/([^ ]+) test:\s+Tests\s+(.+)',t)
  if s=='Test' and m:
   c={k:int(v) for v,k in re.findall(r'(\d+) (passed|skipped|failed)',m[2])}
   packages.append({'package':m[1],'line':n,**{k:c.get(k,0) for k in ['passed','skipped','failed']},'raw_summary':t})
 assert len(packages)==len({p['package'] for p in packages})==22
 totals={k:sum(p[k] for p in packages) for k in ['passed','skipped','failed']}
 standalone={}
 for s in ['Method export contracts','Model evidence projection contracts','Method verification journey contracts','Method material pagination contracts','Skills map maintenance contracts','Read-only PR snapshot contracts (offline)']:
  c={};loc=[]
  for n,step,t in rows:
   m=re.fullmatch(r'# (tests|pass|fail|skipped) (\d+)',t)
   if step==s and m:
    assert m[1] not in c;c[m[1]]=int(m[2]);loc.append(n)
  assert c['tests']==c['pass']+c['fail']+c['skipped']
  standalone[s]={'counts':c,'lines':loc}
 assert [standalone[s]['counts']['tests'] for s in standalone]==[94,88,43,14,24,14]
 observations={}
 for s in ['Method verification journey (two real local cases)','Full method verification journey (five real local cases)','Project and check actual method evidence','Project and check full five-case method evidence','Maintain fixed skills map (five real local cases)','Session adoption decision smoke (local fixture)','Skills check verification (local Git fixtures)']:
  rs=[(n,t) for n,step,t in rows if step==s]; found=[]
  for i,(n,t) in enumerate(rs):
   if t=='{' or t.startswith('{"'):
    try:
     obj,end=json.JSONDecoder().raw_decode('\n'.join(t for _,t in rs[i:]))
     found.append({'line':n,'value':obj})
    except json.JSONDecodeError:pass
  observations[s]={'commands':[{'line':n,'text':t} for n,t in rs if 'pnpm ' in t or t.startswith('> node')], 'json_records':found}
 check=next(j for j in jobs['jobs'] if j['name']=='check')
 stepmap={s['name']:s for s in check['steps']}
 for s in observations:assert stepmap[s]['conclusion']=='success'
 checkout=[{'line':n,'text':t} for n,s,t in rows if s=='Run actions/checkout@v7' and ('HEAD is now at' in t or re.fullmatch('[0-9a-f]{40}',t))]
 skip=[{'line':n,'text':t} for n,s,t in rows if s=='Method export contracts' and ('# SKIP' in t or 'global Codex' in t)]
 result={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'run_id':run['id'],'head':run['head_sha'],'base':run['pull_requests'][0]['base'],'status':run['status'],'conclusion':run['conclusion'],'jobs':[{'id':j['id'],'name':j['name'],'conclusion':j['conclusion']} for j in jobs['jobs']],'checkout':checkout,'check_steps':check['steps'],'package_count':len(packages),'totals':totals,'packages':packages,'standalone':standalone,'export_skip':skip,'actual_steps':observations,'raw_bindings':[{'path':n,'bytes':(root/n).stat().st_size,'sha256':sha((root/n).read_bytes())} for n in ['run.stdout','jobs.stdout','complete-log.stdout','complete-log.log.gz']],'limits':['Read-only verification of CI records, not independent test re-execution.','Raw GH CLI log bytes preserved without ANSI transformations; parser strips ANSI only in memory.','Actual command success inferred from successful bash-e CI step and result records; no separate numeric shell exit footer expected.','No artifact downloaded or independently rehashed. No model/native/runtime qualification, full-descendant cleanup or PR Ready inferred.']}
 write('report.json',result)
 print(json.dumps({'totals':totals,'standalone':standalone,'checkout':checkout},indent=2))
except Exception:
 (root/('parser-error-'+datetime.datetime.now().strftime('%H%M%S')+'.txt')).write_text(traceback.format_exc());raise
