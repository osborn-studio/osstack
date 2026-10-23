import { mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import assert from 'node:assert/strict';
import { FrameDecoder, encodeFrame } from './prefix/lib/node_modules/@osstack/hermes-adapter/dist/index.js';
const root='/Volumes/AIMATE_WORK/tmp/g225-release';const home=root+'/home';const repo=root+'/repo';const bin=root+'/prefix/bin/osstack';
for(const p of [home,repo,repo+'/.osstack'])mkdirSync(p,{recursive:true,mode:0o700});
writeFileSync(repo+'/answer','0\n');writeFileSync(repo+'/.osstack/policy.yaml','schema_version: 1\nmode: execute\n');
const git=(...args)=>execFileSync('git',['-c','core.hooksPath=/dev/null',...args],{cwd:repo,encoding:'utf8'}).trim();
git('init','-q');git('add','.');git('-c','user.name=Graph Release','-c','user.email=release@invalid','commit','-qm','test: installed admission closed');
const scope={schemaVersion:1,tenantId:'internal-beta',principalId:'owner',workspaceId:'staged'};
const config={schemaVersion:1,admissionEnabled:false,registration:{id:'owner',scope,repositoryRef:'repo',repositoryPath:repo,taskRef:'task',task:'Set answer to 1',inputArtifactRef:'input',writer:{agentId:'deepseek-bounded-writer',capabilityId:'deepseek-bounded-writer.writer'},reviewer:{agentId:'deepseek-bounded-reviewer',capabilityId:'deepseek-bounded-reviewer.reviewer'},boundedMessages:{provider:'deepseek',model:'deepseek-v4-pro',files:['answer'],acceptance:'Answer is 1'},acceptanceRegistry:[{ref:'test',command:'test "$(cat answer)" = 1',passExitCodes:[0],failExitCodes:[1]}],grant:{scope,expiresAt:Date.now()+300000,operations:['read','execute','cancel','resume']}}};
writeFileSync(home+'/graph-host.json',JSON.stringify(config),{mode:0o600});
const env={...process.env,OSSTACK_HOME:home,OSSTACK_SOCKET:home+'/daemon.sock',OSSTACK_LAUNCH_AGENTS_DIR:root+'/LaunchAgents',OSSTACK_UPDATE_CHECK:'0',OSSTACK_POWER_POLICY:'none',OSSTACK_CLOCK_MONITOR:'monotonic-v1',OSSTACK_DASHBOARD_PORT:'0'};
for(const k of ['DEEPSEEK_API_KEY','ANTHROPIC_API_KEY','OSSTACK_AGENT_PROFILE'])delete env[k];
const report={sourceCommit:'fec0b1826abfcc6cf1b625f01f0881f9f7caf089',scope:'installed package isolated admission-closed rehearsal',productionChanged:false,passed:false};
report.version=execFileSync(bin,['--version'],{env,encoding:'utf8'}).trim();
report.install=JSON.parse(execFileSync(bin,['serve','--install','--no-load','--bin',bin,'--json'],{env,encoding:'utf8'}));
assert.equal(report.install.loaded,false);assert.equal(report.install.installed,true);
const child=spawn(bin,['serve'],{cwd:repo,env,stdio:['ignore','pipe','pipe']});
const exit=new Promise(resolve=>child.once('exit',(code,signal)=>resolve({code,signal})));
for(const stream of [child.stdout,child.stderr])stream.on('data',b=>appendFileSync(root+'/staged-daemon.txt',b,{mode:0o600}));
async function rpc(method,params={}){return new Promise((resolve,reject)=>{const s=connect(env.OSSTACK_SOCKET),decoder=new FrameDecoder();const timer=setTimeout(()=>{s.destroy();reject(Error('RPC_TIMEOUT'));},10000);const done=(err,result)=>{clearTimeout(timer);s.destroy();err?reject(err):resolve(result);};s.on('error',e=>done(e));s.on('connect',()=>s.write(encodeFrame({id:1,method,params})));s.on('data',b=>{for(const r of decoder.push(b)){done(null,r);break;}});});}
try{
 const until=Date.now()+20000;let health;
 while(Date.now()<until){if(child.exitCode!==null)throw Error('DAEMON_EXIT');try{health=await rpc('health');if(health.ok)break;}catch{}await delay(100);}
 assert.equal(health?.ok,true);report.health=true;report.legacy={};
 for(const name of ['session.list','loop.list','stats']){const reply=await rpc(name);assert.equal(reply.ok,true,JSON.stringify(reply));report.legacy[name]=true;}
 const request={schemaVersion:1,kind:'start',scope,idempotencyKey:'must-not-start',inputArtifactRef:'input',source:{product:'osstack',requestId:'staged'},spec:{schemaVersion:1,template:'code-delivery-v1',publication:'artifact_only',input:{taskRef:'task',repositoryRef:'repo',baseRevision:git('rev-parse','HEAD'),acceptanceRef:'test'},limits:{maxEpochs:1,maxBranchAttempts:1,maxConcurrentReaders:2,maxConcurrentWritersPerRepo:1,maxActionStarts:7,deadlineSeconds:60,tokenReservationLimit:49152}}};
 const denied=await rpc('graph.start',request);assert.equal(denied.ok,false);assert.equal(denied.error.code,'GRAPH_ADMISSION_DISABLED');report.deniedCode=denied.error.code;
 const req=createRequire(root+'/prefix/lib/node_modules/@osstack/core/package.json');const Database=req('better-sqlite3');const db=new Database(home+'/state.db',{readonly:true});
 try{report.schema=db.pragma('user_version',{simple:true});report.graphRuns=db.prepare('select count(*) n from graph_runs').get().n;report.integrity=db.pragma('integrity_check',{simple:true});assert.equal(report.schema,37);assert.equal(report.graphRuns,0);assert.equal(report.integrity,'ok');}finally{db.close();}
 assert.equal(readFileSync(repo+'/answer','utf8'),'0\n');report.passed=true;
}finally{child.kill('SIGTERM');report.exit=await exit;writeFileSync(root+'/staged-smoke.json',JSON.stringify(report,null,2)+'\n');}
console.log(JSON.stringify(report,null,2));
