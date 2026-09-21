import {createHash} from 'node:crypto';
import {mkdirSync, writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {GraphActionStore} from '@osstack/core';
import {GraphAdmissionStore} from '@osstack/core/graph-recovery';
import {processFixture} from '/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation/packages/cli/src/graph-process-fixture.ts';
import {reopenGraphContainedTests} from '/Volumes/AIMATE_WORK/Developer/CodeX/osstack-graph-runtime-foundation/packages/cli/src/graph-contained-recovery.ts';
const root=process.argv[2];mkdirSync(root,{recursive:true});const f=processFixture(root);let run=f.run;
const fence=()=>({scope:run.scope,graphRunId:run.graphRunId,identity:run.identity,expectedGeneration:run.generation,expectedOwner:run.leaseOwner,expectedRevision:run.revision,now:Date.now()});
const actions=new GraphActionStore(f.db);const reserved=actions.reserve(fence(),{epoch:0,nodeId:'tests',effectSlot:'invoke',reservationTokens:10,action:{kind:'tests',candidateRevision:'a'.repeat(40),commandSpecRef:'accept',workspaceLeaseRef:'lease'}});run=reserved.run;
const effectKey=reserved.action.effectKey,invocation='fifo-invocation';new GraphAdmissionStore(f.db).hold(effectKey,Date.now());run=actions.markRunning(fence(),effectKey,'graph-execution:'+effectKey+':'+invocation).run;
const journalRoot=root+'/journal',directory=journalRoot+'/'+createHash('sha256').update(invocation).digest('hex');mkdirSync(directory,{recursive:true});execFileSync('mkfifo',[directory+'/binding.json']);
writeFileSync(root+'/ready.json',JSON.stringify({effectKey,invocation}));
try {
 await reopenGraphContainedTests(f.db,{socketPath:root+'/nonexistent.sock',daemonId:'daemon',baseImageId:'sha256:'+'b'.repeat(64),journalRoot,authorizeRead:()=>{},authorizeStop:()=>{throw Error('NO_STOP');}}, {fence:fence(),effectKey,binding:{scope:run.scope,graphRunId:run.graphRunId,specHash:run.identity.specHash,epoch:0,candidateRevision:'a'.repeat(40),artifactDigest:'f'.repeat(64),acceptanceRef:'accept'},command:'exit 0',contentDigest:'c'.repeat(64)});
 throw Error('UNEXPECTED_ACCEPT');
} catch(error) {
 if(!String(error).includes('CONTAINED_JOURNAL_INVALID'))throw error;
 const state=f.db.prepare('SELECT a.state,d.released_at FROM graph_actions a JOIN graph_action_admissions d ON d.effect_key=a.effect_key WHERE a.effect_key=?').get(effectKey);
 if(state.state!=='running'||state.released_at!==null||f.db.inTransaction)throw Error('MUTATED_STATE');
 console.log(JSON.stringify({rejected:true,state,transactionClosed:true}));
} finally {await f.runtime.close();await f.runtime.drainDatabaseUsers();f.db.close();}
