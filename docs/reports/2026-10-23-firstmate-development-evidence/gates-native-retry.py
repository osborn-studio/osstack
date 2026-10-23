import pathlib,json,subprocess,os,time
repo=pathlib.Path('/Volumes/AIMATE_WORK/Developer/CodeX/osstack');root=pathlib.Path('/Volumes/AIMATE_WORK/tmp/osstack/smoke/firstmate-development-20261023');evidence=repo/'docs/reports/2026-10-23-firstmate-development-evidence'
commands={
'd1':'pnpm --filter @osstack/cli exec vitest run src/daemon-lock-ownership.test.ts src/daemon-startup-ownership.test.ts',
'd2':'pnpm --filter @osstack/loop exec vitest run src/loop-engine.test.ts src/loop-worktree-preservation.test.ts',
'd3':'pnpm --filter @osstack/cli exec vitest run src/daemon-loop-recovery-preservation.test.ts src/daemon-daily.test.ts src/daemon-drain-recovery.test.ts',
's1-a':'pnpm --filter @osstack/supervisor exec vitest run src/attention.test.ts',
's1-b':'pnpm --filter @osstack/core exec vitest run src/state/attention-store.test.ts',
's1-c':'pnpm --filter @osstack/core exec vitest run src/state/attention-store.test.ts src/state/attention-actions.test.ts',
's1-d':'pnpm --filter @osstack/core exec vitest run src/state/attention-observer.test.ts',
's1-e':'pnpm --filter @osstack/cli exec vitest run src/session-rpc.test.ts',
's1-f':'pnpm --filter @osstack/cli exec vitest run src/session-rpc.test.ts src/attention-command.test.ts',
's1-g':'node scripts/bench-cli-startup.mjs',
's2-a':'pnpm --filter @osstack/core exec vitest run src/state/attention-actions.test.ts',
's2-b':'pnpm --filter @osstack/cli exec vitest run src/session-rpc.test.ts',
's2-c':'pnpm --filter @osstack/cli exec vitest run src/attention-local-delivery.test.ts',
's2-d':'pnpm --filter @osstack/core exec vitest run src/state/attention-experience.test.ts',
's2-e':'pnpm --filter @osstack/core exec vitest run src/state/attention-observer.test.ts',
's2-f':'pnpm --filter @osstack/cli exec vitest run src/attention-hook.test.ts',
's2-g':'pnpm --filter @osstack/cli exec vitest run src/attention-command.test.ts src/session-rpc.test.ts',
's3-a':'pnpm --filter @osstack/github exec vitest run src/attention-ci.test.ts',
's3-b':'pnpm --filter @osstack/supervisor exec vitest run src/attention-planning.test.ts',
's3-c':'pnpm --filter @osstack/supervisor exec vitest run src/attention-planning.test.ts',
's3-d':'pnpm --filter @osstack/loop exec vitest run src/lesson-draft.test.ts',
}
env={**os.environ,'OSSTACK_HOME':str(root/'home'),'OSSTACK_SCRATCH_ROOT':'/Volumes/AIMATE_WORK/tmp/osstack'}
results=[]
for stage,command in commands.items():
 previous=evidence/(stage+'-loop.json')
 if not previous.exists():continue
 old=json.loads(previous.read_text())
 if any(t.get('outcome')=='success' for t in old.get('completed_tasks',[])):continue
 retry=subprocess.run(['node',str(repo/'packages/cli/dist/bin.js'),'cockpit','retry','firstmate-'+stage,'--workspace',str(root/'queue'/stage),'--json'],cwd=repo,env=env,capture_output=True,text=True)
 (evidence/(stage+'-retry-enqueue.json')).write_text(retry.stdout)
 if retry.returncode:raise RuntimeError(retry.stderr)
 out=evidence/(stage+'-retry-loop.json');err=evidence/(stage+'-retry-loop.stderr.txt')
 with out.open('w') as o,err.open('w') as e:
  result=subprocess.run(['node',str(repo/'packages/cli/dist/bin.js'),'loop','run','--workspace',str(root/'queue'/stage),'--source','task_queue','--execute','cd '+str(repo)+' && '+command,'--verify','cd '+str(repo)+' && git diff --check','--archive-completed','--no-lesson-drafts','--json'],cwd=repo,env=env,stdout=o,stderr=e)
 data=json.loads(out.read_text());task=next(t for t in data['completed_tasks'] if t['task_id']=='firstmate-'+stage+'-retry')
 results.append({'stage':stage,'exit_code':result.returncode,'retry_outcome':task['outcome'],'command':command});print(stage,result.returncode,task['outcome'],flush=True)
 (evidence/'retry-stage-gates.json').write_text(json.dumps(results,indent=2))
