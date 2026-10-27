"""Record a bounded independently chosen command; writes only under this scratch dir."""
import argparse,datetime,hashlib,json,os,subprocess
from pathlib import Path
p=argparse.ArgumentParser();p.add_argument('--label',required=True);p.add_argument('--cwd',required=True);p.add_argument('--code-sha',required=True);p.add_argument('command',nargs=argparse.REMAINDER);a=p.parse_args()
root=Path(__file__).resolve().parent
assert a.label and all(x.isalnum() or x in '-_' for x in a.label)
cmd=a.command[1:] if a.command[:1]==['--'] else a.command
assert cmd
stdout=root/(a.label+'.stdout');stderr=root/(a.label+'.stderr');record=root/(a.label+'.command.json')
assert not any(x.exists() for x in [stdout,stderr,record]),'do not overwrite prior observations'
start=datetime.datetime.now(datetime.timezone.utc).isoformat()
with stdout.open('wb') as out,stderr.open('wb') as err:
 result=subprocess.run(cmd,cwd=a.cwd,stdout=out,stderr=err,env=os.environ.copy())
data={'command':cmd,'cwd':a.cwd,'code_sha':a.code_sha,'started_at':start,'ended_at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'exit_code':result.returncode,'stdout':stdout.name,'stdout_sha256':hashlib.sha256(stdout.read_bytes()).hexdigest(),'stderr':stderr.name,'stderr_sha256':hashlib.sha256(stderr.read_bytes()).hexdigest(),'oracle_sha256':hashlib.sha256((root/'oracle-freeze.json').read_bytes()).hexdigest()}
record.write_text(json.dumps(data,indent=2)+'\n');print(json.dumps(data,indent=2));raise SystemExit(result.returncode)
