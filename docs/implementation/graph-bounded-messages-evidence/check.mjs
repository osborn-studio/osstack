import {spawn} from 'node:child_process';
import {appendFileSync,writeFileSync} from 'node:fs';
const root='/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation',out='/Volumes/AIMATE_WORK/tmp/g25-bounded-messages';
const commands={
 focused:[['pnpm','--filter','@osstack/agents','test','src/adapters/bounded-messages.test.ts','--reporter=default','--reporter=json','--outputFile='+out+'/agents-tests.json'],
 ['pnpm','--filter','@osstack/cli','test','src/graph-bounded-messages.test.ts','src/graph-host-config.test.ts','src/graph-admission.test.ts','src/graph-rpc.test.ts','src/graph-delegation.integration.test.ts','src/graph-reconcile-rpc.test.ts','src/graph-shutdown.test.ts','src/graph-action-broker.test.ts','--maxWorkers=1','--reporter=default','--reporter=json','--outputFile='+out+'/cli-tests.json'],
 ['pnpm','--filter','@osstack/loop','test','src/candidate-execution.test.ts','src/executor.test.ts','--maxWorkers=1','--reporter=default','--reporter=json','--outputFile='+out+'/loop-tests.json']],
 typecheck:[['pnpm','typecheck:check']],schemas:[['pnpm','--filter','@osstack/protocol','check:schemas']],
 startup:[['node','scripts/bench-cli-startup.mjs']],whitespace:[['git','diff','--check']]
};
const name=process.argv[2],batch=commands[name];if(!batch)throw Error('unknown check');
const log=out+'/accepted-'+name+'.txt';writeFileSync(log,'');let output='';
for(const command of batch){
 const code=await new Promise(resolve=>{
 const child=spawn(command[0],command.slice(1),{cwd:root,env:process.env,stdio:['ignore','pipe','pipe']});
 const record=x=>{output+=x;appendFileSync(log,x);};child.stdout.on('data',record);child.stderr.on('data',record);
 child.on('error',e=>{console.error(e);resolve(1);});child.on('close',code=>resolve(code??1));});
 if(code!==0){console.log(output.slice(-7000));process.exit(code);}}
console.log(name+': passed\n'+output.slice(-2500));
