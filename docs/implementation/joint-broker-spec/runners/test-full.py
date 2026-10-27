from pathlib import Path
import os,json,subprocess,hashlib,datetime,re
root=Path('/Users/osborn/Developer/CodeX/.worktrees/osstack/joint-broker-spec');out=Path('/Volumes/AIMATE_WORK/tmp/osstack/runtime/joint-nextwave-20261028/broker-spec')
v=json.loads((out/'verification.json').read_text());assert v['status']=='focused_passed_full_pending';sha=v['code_sha'];assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()==sha
env=os.environ.copy();env['PATH']='/opt/homebrew/opt/node@22/bin:'+env['PATH'];env['OSSTACK_HOME']=str(out/'home');env['OSSTACK_SCRATCH_ROOT']='/Volumes/AIMATE_WORK/tmp/osstack';env.pop('OSSTACK_SOCKET',None)
cmds=[('knowledge-preflight',['node','--input-type=module','-e',"const m=await import('./packages/knowledge/dist/index.js'); for (const key of ['executionContextDigest','assembleExecutionContext']) {if(typeof m[key]!=='function')throw Error(key+' not built');console.log(key+': function')}"]),('test-full',['pnpm','test'])]
for name,cmd in cmds:
 start=datetime.datetime.now(datetime.timezone.utc).isoformat();print(name,'started',flush=True)
 with (out/(name+'.log')).open('w') as f:r=subprocess.run(cmd,cwd=root,env=env,stdout=f,stderr=subprocess.STDOUT)
 v['commands'].append({'name':name,'command':cmd,'code_sha':sha,'started_at':start,'ended_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'exit_code':r.returncode,'log':name+'.log','log_sha256':hashlib.sha256((out/(name+'.log')).read_bytes()).hexdigest()});v['status']='failed' if r.returncode else 'running';(out/'verification.json').write_text(json.dumps(v,indent=2)+'\n');print(name,r.returncode,flush=True)
 if r.returncode:raise SystemExit(r.returncode)
assert subprocess.check_output(['git','rev-parse','HEAD'],cwd=root,text=True).strip()==sha
rows=[]
for line in (out/'test-full.log').read_text().splitlines():
 m=re.match(r'(packages/\S+) test:\s+Tests\s+(.+)$',line)
 if m:
  c={k:int(n) for n,k in re.findall(r'(\d+) (passed|failed|skipped)',m.group(2))};rows.append({'package':m.group(1),**{k:c.get(k,0) for k in ('passed','failed','skipped')}})
assert len(rows)==22 and len({r['package'] for r in rows})==22 and sum(r['failed'] for r in rows)==0
v['validation']={'packages':22,**{k:sum(r[k] for r in rows) for k in ('passed','failed','skipped')}};v['status']='passed';(out/'verification.json').write_text(json.dumps(v,indent=2)+'\n');(out/'test-summary.json').write_text(json.dumps({'base_sha':v['base_sha'],'code_sha':sha,'source':'test-full.log',**v['validation'],'detail':rows},indent=2)+'\n');print(json.dumps(v['validation']),flush=True)
