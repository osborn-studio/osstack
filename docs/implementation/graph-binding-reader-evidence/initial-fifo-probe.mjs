import {createRequire} from 'node:module';
import {symlinkSync,writeFileSync,existsSync} from 'node:fs';
import {spawnSync,execFileSync} from 'node:child_process';
const root='/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation',out='/Volumes/AIMATE_WORK/tmp/g25-binding-read';
const require=createRequire(root+'/package.json');const {build}=createRequire(require.resolve('tsup'))('esbuild');
try{symlinkSync(root+'/packages/cli/node_modules',out+'/node_modules','dir');}catch(e){if(e.code!=='EEXIST')throw e;}
const prior=execFileSync('git',['show','HEAD:packages/cli/src/graph-contained-recovery.ts'],{cwd:root,encoding:'utf8'});
const evidence={platform:process.platform,node:process.version,kind:'unmocked FIFO initial reopen child-process probe',runs:[]};
for(const version of ['before','after']){
 await build({entryPoints:[out+'/fifo-child-entry.mjs'],outfile:out+'/fifo-'+version+'.mjs',bundle:true,platform:'node',format:'esm',packages:'external',plugins:version==='before'?[{name:'prior-reader',setup(b){b.onLoad({filter:/\/graph-contained-recovery\.ts$/},()=>({contents:prior,loader:'ts',resolveDir:root+'/packages/cli/src'}));}}]:[]});
 const childRoot=out+'/fifo-'+version;const start=Date.now();const result=spawnSync(process.execPath,[out+'/fifo-'+version+'.mjs',childRoot],{cwd:root,env:{...process.env,OSSTACK_HOME:out+'/home',TMPDIR:out+'/tmp'},encoding:'utf8',timeout:3000});
 evidence.runs.push({version,elapsedMs:Date.now()-start,ready:existsSync(childRoot+'/ready.json'),exitCode:result.status,signal:result.signal,error:result.error?.code,stdout:result.stdout,stderr:result.stderr});
}
evidence.passed=evidence.runs[0].ready&&evidence.runs[0].error==='ETIMEDOUT'&&evidence.runs[1].exitCode===0&&JSON.parse(evidence.runs[1].stdout).rejected;
writeFileSync(out+'/fifo-probe.json',JSON.stringify(evidence,null,2)+'\n');console.log(JSON.stringify(evidence));if(!evidence.passed)process.exitCode=1;
