import subprocess,json,time,pathlib,sys
repo=pathlib.Path('/Users/osborn/Developer/CodeX/.worktrees/osstack/firstmate-next-wave')
root=pathlib.Path('/Volumes/AIMATE_WORK/tmp/osstack/smoke/pr237-integration')
commands=[('build',['pnpm','build']),('inventory-generate',['node','scripts/generate-inventory.mjs']),('typecheck',['pnpm','typecheck:check']),('test',['pnpm','-r','--workspace-concurrency=1','--no-bail','test','--maxWorkers=2','--testTimeout=20000']),('lint',['pnpm','lint']),('schemas',['pnpm','--filter','@osstack/protocol','check:schemas']),('inventory',['node','scripts/generate-inventory.mjs','--check']),('startup',['node','scripts/bench-cli-startup.mjs'])]
results=[]
for name,cmd in commands:
 t=time.time()
 with (root/'wave1-final-logs'/(name+'.log')).open('w') as f:res=subprocess.run(cmd,cwd=repo,stdout=f,stderr=subprocess.STDOUT)
 results.append(dict(name=name,command=cmd,exit_code=res.returncode,seconds=time.time()-t));print(name,res.returncode,flush=True)
 (root/'wave1-final-checks.json').write_text(json.dumps(results,indent=2)+'\n')
 if name=='build' and res.returncode:break
sys.exit(int(any(x['exit_code'] for x in results)))
