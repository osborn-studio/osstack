import assert from 'node:assert/strict';
import {fork,spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash} from 'node:crypto';
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
import {openDb,GraphRunStore,GraphActionStore} from '@osstack/core';
import {GraphAdmissionStore} from '@osstack/core/graph-recovery';
import {prepareContainedImage} from '@osstack/agents';
const root='/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation';
const out='/Volumes/AIMATE_WORK/tmp/g25-reopen';
const {ContainedDocker}=await import(root+'/packages/agents/dist/contained-docker.js');
const {verificationCanonical}=await import(root+'/packages/graph/dist/nodes/branch.js');
const host=JSON.parse(readFileSync(out+'/candidate-config.json'));
const api=new ContainedDocker(host.socketPath); const home=mkdtempSync(out+'/ledger-crash-'); const journalRoot=home+'/journal';mkdirSync(journalRoot);
const dbPath=home+'/state.db';const db=openDb({path:dbPath});const runs=new GraphRunStore(db);const actions=new GraphActionStore(db);
const scope={schemaVersion:1,tenantId:'t',principalId:'p',workspaceId:'w'};
let run=runs.create({schemaVersion:1,kind:'start',scope,idempotencyKey:'crash',inputArtifactRef:'input',source:{product:'osstack',requestId:'crash'},spec:{schemaVersion:1,template:'code-delivery-v1',publication:'artifact_only',input:{taskRef:'task',repositoryRef:'repo',baseRevision:'a'.repeat(40),acceptanceRef:'accept'},limits:{maxEpochs:1,maxBranchAttempts:2,maxConcurrentReaders:2,maxConcurrentWritersPerRepo:1,maxActionStarts:10,deadlineSeconds:120,tokenReservationLimit:100}}},{executionModel:'langgraph-functional-v1',durability:'sync',engineVersion:'1',checkpointVersion:'1',templateVersion:'1',registryVersion:'1',compilerVersion:'1',schemaVersion:'1',compiledProgramDigest:'b'.repeat(64)},Date.now());
const fence=()=>({scope,graphRunId:run.graphRunId,identity:run.identity,expectedGeneration:run.generation,expectedRevision:run.revision,expectedOwner:run.leaseOwner,now:Date.now()});
run=runs.acquireLease({...fence(),owner:'original-worker',leaseExpiresAt:Date.now()+120000});
const reserved=actions.reserve(fence(),{epoch:0,nodeId:'tests',effectSlot:'invoke',reservationTokens:10,action:{kind:'tests',candidateRevision:'a'.repeat(40),commandSpecRef:'accept',workspaceLeaseRef:'lease'}});run=reserved.run;
const effectKey=reserved.action.effectKey, invocationId='live-crashed-host';
new GraphAdmissionStore(db).hold(effectKey,Date.now());run=actions.markRunning(fence(),effectKey,`graph-execution:${effectKey}:${invocationId}`).run;
const binding={scope,graphRunId:run.graphRunId,specHash:run.identity.specHash,epoch:0,candidateRevision:'a'.repeat(40),artifactDigest:'f'.repeat(64),acceptanceRef:'accept'};
const image=await prepareContainedImage({...host,authorize:()=>{}},[{path:'file',mode:'100644',bytes:Buffer.from('candidate')}]);
const command="trap '' TERM; setsid sh -c 'while :; do sleep 1; done' & while :; do sleep 1; done";
const identity={version:1,scope,graphRunId:run.graphRunId,generation:run.generation,effectKey,invocationId,candidateRevision:binding.candidateRevision,artifactDigest:binding.artifactDigest,command,image};
const data=verificationCanonical(identity);const sha=s=>createHash('sha256').update(s).digest('hex');
const options={...host,journalRoot,imageId:image.imageId,workingDirectory:image.workingDirectory,command,bindingRef:sha(data),bindingData:data,timeoutMs:60000};
writeFileSync(home+'/producer.json',JSON.stringify(options));
let child,containerId;const report={scope:'Exact ledger-bound contained executor cleanup after supervisor SIGKILL; no Graph worker stop, outcome settlement, release or takeover authority',passed:false,checks:[]};
const inspect=async()=>{const r=await api.call('GET',`/containers/${containerId}/json`);return r.status===200?JSON.parse(r.bytes):null;};
try {
 child=fork(root+'/scripts/fixtures/contained-command-host.mjs',[home+'/producer.json','execute',invocationId],{stdio:['ignore','ignore','inherit','ipc']});
 const launchPath=journalRoot+'/'+sha(invocationId)+'/launch.json';
 for(let i=0;i<200;i++){if(existsSync(launchPath)){containerId=JSON.parse(readFileSync(launchPath)).containerId;if((await inspect())?.State.Running)break;}await delay(50);}
 assert.equal((await inspect())?.State.Running,true);
 const top=JSON.parse((await api.call('GET',`/containers/${containerId}/top?ps_args=-eo%20pid,ppid,pgid,sid,args`)).bytes);assert.ok(top.Processes.length>=3);report.processesBefore=top;
 const exit=once(child,'exit');child.kill('SIGKILL');await exit;assert.equal((await inspect()).State.Running,true);report.checks.push('container continues running after SIGKILL of original executor host');
 run=actions.markUncertain(fence(),effectKey,{state:'unknown',evidenceRef:'supervisor-killed',observedTokens:3}).run;
 const input={dbPath,options:{...host,journalRoot},request:{fence:fence(),effectKey,binding,command,contentDigest:image.contentDigest},operation:'stop'};
 writeFileSync(home+'/reopen-input.json',JSON.stringify(input));db.close();
 const recovery=spawn(process.execPath,[out+'/reopen-child.mjs',home+'/reopen-input.json'],{stdio:['ignore','pipe','pipe'],env:process.env});let stdout='',stderr='';recovery.stdout.on('data',x=>stdout+=x);recovery.stderr.on('data',x=>stderr+=x);
 const [code]=await once(recovery,'close');assert.equal(code,0,stderr);const result=JSON.parse(stdout);assert.equal(result.stopped,true);assert.equal(result.state,'unknown');assert.equal(result.held,true);report.result=result;
 assert.equal(await inspect(),null);assert.equal((await api.call('POST',`/containers/${containerId}/start`)).status,404);
 report.checks.push('fresh Node process reconstructs executor from action/admission/journal and removes live container','unknown business outcome and held admission retained','late start of exact deleted container returns 404');
 report.journal={binding:JSON.parse(readFileSync(journalRoot+'/'+sha(invocationId)+'/binding.json')),launch:JSON.parse(readFileSync(launchPath)),stopped:JSON.parse(readFileSync(journalRoot+'/'+sha(invocationId)+'/stopped.json'))};report.passed=true;
} finally {
 if(child&&child.exitCode===null&&child.signalCode===null){const exited=once(child,'exit');child.kill('SIGKILL');await exited;}
 if(containerId)await api.call('DELETE',`/containers/${containerId}?force=true&v=true`);
 if(db.open)db.close();writeFileSync(out+'/ledger-crash-result.json',JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,checks:report.checks}));
}
