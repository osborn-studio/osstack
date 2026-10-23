import {spawn} from 'node:child_process';
import {appendFileSync,writeFileSync} from 'node:fs';
const root='/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation',out='/Volumes/AIMATE_WORK/tmp/g25-proof-bridge';
const commands={
 real:['pnpm','--filter','@osstack/cli','test','src/graph-contained-recovery.test.ts','-t','contained proof bridge','--maxWorkers=1','--testTimeout=30000'],
 matrix:['node',out+'/verify-current-matrix.mjs'],
 typecheck:['pnpm','typecheck:check'],schemas:['pnpm','--filter','@osstack/protocol','check:schemas'],
 startup:['node','scripts/bench-cli-startup.mjs'],whitespace:['git','diff','--check']
};
const name=process.argv[2],command=commands[name];if(!command)throw Error('unknown check');
if(name==='real'){process.env.G25_CONTAINED_CONFIG=out+'/candidate-config.json';process.env.G25_REOPEN_CHILD=out+'/proof-child.mjs';}
const log=out+'/accepted-'+name+'.txt';writeFileSync(log,'');let output='';
const child=spawn(command[0],command.slice(1),{cwd:root,env:process.env,stdio:['ignore','pipe','pipe']});
const record=x=>{output+=x;appendFileSync(log,x);};child.stdout.on('data',record);child.stderr.on('data',record);
child.on('error',e=>{console.error(e);process.exitCode=1;});child.on('close',code=>{console.log(name+': exit='+code+'\n'+output.slice(-2000));process.exitCode=code??1;});
