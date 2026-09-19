import {spawn} from 'node:child_process';
import {appendFileSync,writeFileSync} from 'node:fs';
const root='/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation',out='/Volumes/AIMATE_WORK/tmp/g25-public-reconcile';
const commands={
 focused:['pnpm','--filter','@osstack/cli','test','src/graph-reconcile-rpc.test.ts','src/graph-unstarted-recovery.test.ts',
 'src/graph-reconciler.test.ts','src/graph-rpc.test.ts','src/graph-admission.test.ts','src/graph-delegation.integration.test.ts',
 'src/graph-execution-command.test.ts','src/graph-command.test.ts','src/graph-shutdown.test.ts',
 '--maxWorkers=1','--reporter=default','--reporter=json','--outputFile='+out+'/focused-tests.json'],
 typecheck:['pnpm','typecheck:check'],schemas:['pnpm','--filter','@osstack/protocol','check:schemas'],
 startup:['node','scripts/bench-cli-startup.mjs'],whitespace:['git','diff','--check']
};
const name=process.argv[2],command=commands[name];if(!command)throw Error('unknown check');
const log=out+'/accepted-'+name+'.txt';writeFileSync(log,'');let output='';
const child=spawn(command[0],command.slice(1),{cwd:root,env:process.env,stdio:['ignore','pipe','pipe']});
const record=x=>{output+=x;appendFileSync(log,x);};child.stdout.on('data',record);child.stderr.on('data',record);
child.on('error',e=>{console.error(e);process.exitCode=1;});child.on('close',code=>{console.log(name+': exit='+code+'\n'+output.slice(-2000));process.exitCode=code??1;});
