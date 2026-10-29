from pathlib import Path
import subprocess,json,gzip,hashlib,datetime,concurrent.futures
root=Path(__file__).parent
cases=[(307,40929858660,'8fd2891174964bb539f5ca9b094549a090517d5e'),(308,40930144304,'b4a2fc30711d9c3ad5cddbc846839948f1810c56')]
def one(case):
 pr,run,head=case;p=root/str(pr);p.mkdir()
 def call(n,args):
  start=datetime.datetime.now(datetime.timezone.utc).isoformat();r=subprocess.run(args,capture_output=True,timeout=180)
  (p/(n+'.stdout')).write_bytes(r.stdout);(p/(n+'.stderr')).write_bytes(r.stderr)
  (p/(n+'.command.json')).write_text(json.dumps({'argv':args,'started_at':start,'ended_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'exit_code':r.returncode},indent=2)+'\n');assert r.returncode==0,(pr,n,r.stderr)
  return r.stdout
 r=call('run',['gh','api',f'repos/osborn-studio/osstack/actions/runs/{run}']);v=json.loads(r);assert v['head_sha']==head and v['status']=='completed' and v['conclusion']=='success'
 j=call('jobs',['gh','api',f'repos/osborn-studio/osstack/actions/runs/{run}/jobs?per_page=100']);jj=json.loads(j);assert len(jj['jobs'])==jj['total_count']
 call('pr',['gh','pr','view',str(pr),'--repo','osborn-studio/osstack','--json','headRefOid,baseRefName,isDraft,state,mergeable,statusCheckRollup,url'])
 log=call('complete-log',['gh','run','view',str(run),'--repo','osborn-studio/osstack','--log']);(p/'complete-log.log.gz').write_bytes(gzip.compress(log,mtime=0));assert gzip.decompress((p/'complete-log.log.gz').read_bytes())==log
 return {'pr':pr,'run':run,'log_bytes':len(log),'sha256':hashlib.sha256(log).hexdigest()}
with concurrent.futures.ThreadPoolExecutor(max_workers=2) as ex:
 for result in ex.map(one,cases):print(json.dumps(result),flush=True)
