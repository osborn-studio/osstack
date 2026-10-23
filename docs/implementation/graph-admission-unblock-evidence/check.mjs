import {spawn} from 'node:child_process';
import {appendFileSync,writeFileSync} from 'node:fs';
const root='/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation',out='/Volumes/AIMATE_WORK/tmp/g25-claude-unblock';
const commands={
 reviewtests:['pnpm','--filter','@osstack/cli','test','src/graph-admission.test.ts','--maxWorkers=1','--reporter=default','--reporter=json','--outputFile='+out+'/review-tests.json'],
 focused:['pnpm','--filter','@osstack/cli','test',
 'src/graph-admission.test.ts','src/graph-action-broker.test.ts','src/graph-rpc.test.ts',
 'src/graph-host-config.test.ts','src/graph-execution-command.test.ts',
 'src/graph-delivery.integration.test.ts','src/graph-delivery-adversarial.test.ts',
 'src/graph-branch-broker.test.ts','src/graph-verification.test.ts','src/graph-delegation.integration.test.ts',
 '--maxWorkers=1','--reporter=default','--reporter=json','--outputFile='+out+'/focused-tests.json'],
 compatibility:['pnpm','--filter','@osstack/cli','test','src/daemon-loop.test.ts','src/session-rpc.test.ts','src/graph-command.test.ts',
 '--maxWorkers=1','--reporter=default','--reporter=json','--outputFile='+out+'/compatibility-tests.json'],
 loop:['pnpm','--filter','@osstack/loop','test','src/loop-engine.test.ts','--maxWorkers=1','--reporter=default','--reporter=json','--outputFile='+out+'/loop-tests.json'],
 protocol:['pnpm','--filter','@osstack/protocol','test','--maxWorkers=1','--reporter=default','--reporter=json','--outputFile='+out+'/protocol-tests.json'],
 typecheck:['pnpm','typecheck:check'],schemas:['pnpm','--filter','@osstack/protocol','check:schemas'],
 startup:['node','scripts/bench-cli-startup.mjs'],whitespace:['git','diff','--check']
};
const name=process.argv[2],command=commands[name];if(!command)throw Error('unknown check');
const log=out+'/accepted-'+name+'.txt';writeFileSync(log,'');let output='';
const child=spawn(command[0],command.slice(1),{cwd:root,env:process.env,stdio:['ignore','pipe','pipe']});
const record=x=>{output+=x;appendFileSync(log,x);};child.stdout.on('data',record);child.stderr.on('data',record);
child.on('error',e=>{console.error(e);process.exitCode=1;});child.on('close',code=>{console.log(name+': exit='+code+'\n'+output.slice(-2000));process.exitCode=code??1;});
