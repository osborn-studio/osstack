import assert from 'node:assert/strict';
import {appendFileSync,readFileSync,writeFileSync,mkdtempSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {StateGraph,Annotation,START,END,interrupt,Command} from '@langchain/langgraph';
import {SqliteSaver} from '@langchain/langgraph-checkpoint-sqlite';

// Self-spawned subprocesses only; all DBs and effects live in a fresh temporary directory.
const [mode,dir]=process.argv.slice(2);
if(mode) {
  const interrupted=mode==='pause'||mode==='resume';
  const saver=SqliteSaver.fromConnString(join(dir,interrupted?'resume.sqlite':'kill.sqlite'));
  const State=Annotation.Root({prepared:Annotation(),approved:Annotation(),completed:Annotation()});
  const log=(s)=>appendFileSync(join(dir,interrupted?'resume.log':'kill.log'),s+'\n');
  let builder=new StateGraph(State);
  if(interrupted) {
    builder=builder.addNode('prepare',()=>{log('prepare');return {prepared:true};}).addNode('gate',()=>{log('before_interrupt');const a=interrupt('input requested');log('after_interrupt');return {approved:a};}).addEdge(START,'prepare').addEdge('prepare','gate').addEdge('gate',END);
  } else {
    builder=builder.addNode('effect',()=>{
      // Intentionally unprotected side effect to expose the replay window.
      log('external_effect');
      if(!existsSync(join(dir,'killed.marker'))){writeFileSync(join(dir,'killed.marker'),'yes');process.kill(process.pid,'SIGKILL');}
      return {completed:true};
    }).addEdge(START,'effect').addEdge('effect',END);
  }
  const graph=builder.compile({checkpointer:saver});
  const input=mode==='resume'?new Command({resume:true}):mode==='recover'?null:{};
  const out=await graph.invoke(input,{configurable:{thread_id:interrupted?'resume':'crash'},durability:'sync'});
  saver.db.close();console.log(JSON.stringify(out));
} else {
  const temp=mkdtempSync(join(tmpdir(),'osgraph-durable-probe-'));
  const run=(m)=>spawnSync(process.execPath,[fileURLToPath(import.meta.url),m,temp],{encoding:'utf8',timeout:15000});
  const paused=run('pause');assert.equal(paused.status,0,paused.stderr);assert.ok(JSON.parse(paused.stdout).__interrupt__.length);
  const resumed=run('resume');assert.equal(resumed.status,0,resumed.stderr);assert.equal(JSON.parse(resumed.stdout).approved,true);
  const resumeLog=readFileSync(join(temp,'resume.log'),'utf8').trim().split('\n');
  assert.deepEqual(resumeLog,['prepare','before_interrupt','before_interrupt','after_interrupt']);
  const killed=run('kill');assert.equal(killed.signal,'SIGKILL');
  const recovered=run('recover');assert.equal(recovered.status,0,recovered.stderr);assert.equal(JSON.parse(recovered.stdout).completed,true);
  const killLog=readFileSync(join(temp,'kill.log'),'utf8').trim().split('\n');assert.deepEqual(killLog,['external_effect','external_effect']);
  const result={node:process.version,temporaryDirectory:temp,offline:true,osstackIntegrationTested:false,results:[{name:'SQLite: pause in process A, resume in process B',pass:true,evidence:{resumeLog,completed:JSON.parse(resumed.stdout)}},{name:'SIGKILL after effect before checkpoint demonstrates duplicate external effect on recovery',pass:true,evidence:{firstSignal:killed.signal,externalEffectCount:killLog.length,note:'Intentional hazard demonstration; not an exactly-once success claim.'}}]};
  writeFileSync('durable-results.json',JSON.stringify(result,null,2)+'\n');console.log('2/2 persistence and replay probes passed');
}
