import {spawn} from 'node:child_process';
import {appendFileSync,writeFileSync} from 'node:fs';
const root='/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation',out='/Volumes/AIMATE_WORK/tmp/g25-quiescence';
const commands={
 delivery:['pnpm','--filter','@osstack/cli','test','src/graph-delivery.integration.test.ts','src/graph-delivery-adversarial.test.ts','src/graph-delivery-broker.test.ts','src/graph-delivery-receipts.test.ts','src/graph-shutdown.test.ts','src/graph-execution-command.test.ts','--maxWorkers=1'],
 matrix:['node','scripts/verify-graph-runtime.mjs','--seed','250922','--repeat','2','--output',out+'/matrix.json'],
 typecheck:['pnpm','typecheck:check'],schemas:['pnpm','--filter','@osstack/protocol','check:schemas'],
 startup:['node','scripts/bench-cli-startup.mjs'],whitespace:['git','diff','--check'],
 child:['pnpm','--filter','@osstack/cli','test','src/graph-worker-exit-proof.test.ts','--maxWorkers=1'],
 candidate:['pnpm','--filter','@osstack/cli','test','src/graph-delivery.integration.test.ts','--maxWorkers=1']
};
const name=process.argv[2],command=commands[name];if(!command)throw Error('Unknown check');
if(name==='child')process.env.G25_EXIT_CHILD=out+'/exit-proof-child.mjs';
if(name==='candidate'){process.env.G25_CONTAINED_CONFIG=out+'/candidate-config.json';process.env.G25_CONTAINED_REPORT_DIR=out+'/real-evidence';}
const log=out+'/accepted-'+name+'.txt';writeFileSync(log,'');let output='';
const child=spawn(command[0],command.slice(1),{cwd:root,env:process.env,stdio:['ignore','pipe','pipe']});
const record=x=>{output+=x;appendFileSync(log,x);};child.stdout.on('data',record);child.stderr.on('data',record);
child.on('error',e=>{console.error(e);process.exitCode=1;});
child.on('close',code=>{console.log(name+': exit='+code+'\n'+output.slice(-2000));process.exitCode=code??1;});
