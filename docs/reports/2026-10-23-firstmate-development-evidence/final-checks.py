import pathlib,json,subprocess,os,time,sys
repo=pathlib.Path('/Volumes/AIMATE_WORK/Developer/CodeX/osstack');root=pathlib.Path('/Volumes/AIMATE_WORK/tmp/osstack/smoke/firstmate-development-20261023');e=repo/'docs/reports/2026-10-23-firstmate-development-evidence';out=[]
env={**os.environ,'OSSTACK_HOME':str(root/'home'),'OSSTACK_SCRATCH_ROOT':'/Volumes/AIMATE_WORK/tmp/osstack'}
for name,cmd in [('build',['pnpm','build']),('typecheck',['pnpm','typecheck']),('test',['pnpm','test']),('schemas',['pnpm','--filter','@osstack/protocol','check:schemas']),('startup',['node','scripts/bench-cli-startup.mjs']),('diff',['git','diff','--check']),('staged-diff',['git','diff','--cached','--check'])]:
 start=time.time();log=e/('final-'+name+'.log')
 with log.open('w') as f:r=subprocess.run(cmd,stdout=f,stderr=subprocess.STDOUT,env=env,cwd=repo)
 out.append({'command':' '.join(cmd),'exit_code':r.returncode,'elapsed_s':round(time.time()-start,3),'log':log.name});print(name,r.returncode,flush=True)
 (e/'final-checks.json').write_text(json.dumps(out,indent=2))
 if r.returncode:print(log.read_text()[-12000:]);sys.exit(r.returncode)
