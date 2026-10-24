import { connect } from 'node:net';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { expect, it, vi } from 'vitest';
import { FrameDecoder, encodeFrame } from '@osstack/hermes-adapter';
import { LoopEngine, runShellCommand, type CommandResult } from '@osstack/loop';
import { GraphDelegationStatus } from '@osstack/protocol';
import { GraphRpcService } from './graph-rpc.js';
import { graphRpcFixture } from './graph-test-fixture.js';
import { SupervisionService } from './supervision-service.js';
import { readAttentionLoop } from './attention-loop-source.js';
import { startDaemon } from './daemon.js';

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const shell = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const stats = (values: number[]) => {
  const sorted = [...values].sort((a,b) => a-b);
  return { count: sorted.length, p50: sorted[Math.floor(sorted.length / 2)] ?? 0,
    p95: sorted[Math.max(0, Math.ceil(sorted.length * .95)-1)] ?? 0, max: sorted.at(-1) ?? 0 };
};
function rpc(path: string): Promise<unknown> {
  return new Promise((resolve,reject) => {
    const socket=connect(path);const decoder=new FrameDecoder();
    const timeout=setTimeout(()=>{socket.destroy();reject(Error('RPC timeout'));},5000);
    socket.on('error',error=>{clearTimeout(timeout);reject(error);});
    socket.on('connect',()=>socket.write(encodeFrame({id:1,method:'version'})));
    socket.on('data',chunk=>{const frame=decoder.push(chunk)[0] as {ok:boolean;result:unknown}|undefined;
      if(frame){clearTimeout(timeout);socket.destroy();frame.ok?resolve(frame.result):reject(Error('RPC failed'));}});
  });
}
it.skipIf(!process.env['OSSTACK_SUPERVISION_QUALIFICATION_REPORT'])('qualifies active child execution, observer restart, cancellation, socket latency and Loop overhead together', async () => {
  const f=await graphRpcFixture();await f.service.close();
  const dirtyIntervalMs=Number(process.env['OSSTACK_SUPERVISION_DIRTY_INTERVAL_MS']??100);
  if(!Number.isSafeInteger(dirtyIntervalMs)||dirtyIntervalMs<10||dirtyIntervalMs>1000)throw Error('invalid dirty interval');
  const oldHome=process.env['OSSTACK_HOME'];process.env['OSSTACK_HOME']=join(f.root,'qualification-home');
  const script=join(f.root,'actual-child.cjs');const gate=join(f.root,'release');const started=join(f.root,'started.json');
  await writeFile(script, `const fs=require('node:fs');const path=require('node:path');const [repo,gate,started]=process.argv.slice(2);fs.writeFileSync(started,JSON.stringify({pid:process.pid,repo}));const timer=setInterval(()=>{if(fs.existsSync(gate)){clearInterval(timer);fs.writeFileSync(path.join(repo,'answer'),'1\\n');}},20);`);
  const proofs=new Map<string,CommandResult>();const pendingProofs=new Map<string,Promise<CommandResult>>();let starts=0;
  const adapter: typeof f.writer={...f.writer,invoke:async function* (task: Parameters<typeof f.writer.invoke>[0],signal:Parameters<typeof f.writer.invoke>[1]){
    starts++;const pending=runShellCommand([process.execPath,script,String(task.context?.['repo_path']),gate,started].map(shell).join(' '),{cwd:String(task.context?.['repo_path']),timeoutMs:60000,outputLimit:16000,...(signal?{signal}:{})});
    pendingProofs.set(task.run_id,pending);const result=await pending;
    proofs.set(task.run_id,result);
    yield {event_id:task.run_id,run_id:task.run_id,session_id:task.session_id,seq:1,created_at:Date.now()/1000,type:'done' as const,terminal:true,
      payload:{status:result.exitCode===0?'completed':'failed',last_seq:0,result_summary:'real local child',usage:{tokens_in:0,tokens_out:0,duration_ms:result.durationMs}}};
  },confirmStopped:async(id:string)=>{const proof=proofs.get(id)??await pendingProofs.get(id);return {stopped:proof?.termination?.stop_confirmed===true,evidence:proof?.termination?.evidence??'unconfirmed'};}};
  f.registration.delivery.writer={...f.registration.delivery.writer,adapter};
  let graph=new GraphRpcService(f.options);let supervision:SupervisionService|undefined;let daemon:Awaited<ReturnType<typeof startDaemon>>|undefined;
  let scanTimer:ReturnType<typeof setInterval>|undefined;let traffic:Promise<void>|undefined;let sampling=false;
  const samples={rpc:[] as number[],scan:[] as number[],observer:[] as number[]};
  const observerSpies:Array<{mockRestore:()=>void}>=[];
  const instrument=(service:SupervisionService)=>{const step=service.observer.step.bind(service.observer);observerSpies.push(vi.spyOn(service.observer,'step').mockImplementation((...args)=>{const value=step(...args);samples.observer.push(value.durationMs);return value;}));};
  const status=(id:string)=>graph.handle(f.connection,'graph.status',{schemaVersion:1,scope:f.request.scope,graphRunId:id}).then(GraphDelegationStatus.parse);
  const until=async(id:string,predicate:(value:GraphDelegationStatus)=>boolean)=>{const deadline=Date.now()+25000;for(;;){const value=await status(id);if(predicate(value))return value;if(Date.now()>deadline)throw Error(`graph timeout ${value.status}`);await delay(10);}};
  const start=async(key:string)=>GraphDelegationStatus.parse(await graph.handle(f.connection,'graph.start',{...f.request,idempotencyKey:key}));
  let lateResolve:(()=>void)|undefined;
  try{
    f.db.exec("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('supervision-load','mixed retained fixtures','running',1,1)");
    f.db.exec("INSERT INTO runs(run_id,task_id,session_id,agent_id,capability_id,phase,started_at) VALUES('retained-run','supervision-load','retained','fixture','review','execute',1)");
    for(let index=0;index<60;index++){
      const id=`retained-${index}`;
      f.db.prepare("INSERT INTO agent_sessions(session_id,task_id,run_id,agent_id,request_sha256,repo_path,state,resume_supported,version,updated_at) VALUES(?,'supervision-load','retained-run','fixture',?,?,'awaiting_decision',1,1,1)").run(id,'a'.repeat(64),f.root);
      f.db.prepare("INSERT INTO session_turns(turn_id,session_id,ordinal,state,decision_json,created_at,updated_at) VALUES(?,?,1,'awaiting_decision',?,1,1)").run(`turn-${index}`,id,JSON.stringify({decision_id:`decision-${index}`,question:'Retained load fixture',choices:[]}));
    }
    const loopPath=join(f.root,'LOOP-STATE.json');const loop=new LoopEngine({workspacePath:f.root,sources:[],inputTasks:[],useWorktree:false,stateFilePath:loopPath,markdownPath:join(f.root,'STATE.md')});
    const firstLoop=await loop.runOnce();
    let blockLate=false;let physicalStarted=false;
    const late=new Promise<void>(resolve=>{lateResolve=resolve;});
    supervision=new SupervisionService(f.db,f.db.name,undefined,{loopReader:async input=>{
      const result=await readAttentionLoop(input);if(blockLate){physicalStarted=true;await late;}return result;
    }});instrument(supervision);
    const scope=supervision.store.registerScope(supervision.observer.owner,'supervision-load',f.root);
    const loopParams={scope_id:scope.scope_id,loop_id:firstLoop.loop_id,state_path:loopPath};
    await supervision.handle('attention.loop',loopParams);await supervision.requestScan();
    const first=await start('active-complete');
    await until(first.graphRunId,()=>existsSync(started));
    const actual=JSON.parse(await readFile(started,'utf8')) as {pid:number};process.kill(actual.pid,0);
    daemon=await startDaemon({socketPath:join(f.root,'rpc.sock')});await rpc(daemon.socketPath);
    sampling=true;traffic=(async()=>{while(sampling){const at=performance.now();await rpc(daemon!.socketPath);samples.rpc.push(performance.now()-at);await delay(5);}})();
    scanTimer=setInterval(()=>{const service=supervision;if(!service)return;const at=performance.now();void service.requestScan('active-mixed-load').then(()=>samples.scan.push(performance.now()-at),()=>{});},dirtyIntervalMs);
    // Stop/restart while the real Graph child is still executing. An old physical
    // read can finish later but must not write into the replacement generation.
    blockLate=true;const old=supervision;const pending=old.handle('attention.loop',loopParams);
    for(let i=0;!physicalStarted&&i<100;i++)await delay(5);expect(physicalStarted).toBe(true);
    await old.stop();expect(await pending).toMatchObject({state:'unknown',reason:'aborted'});
    supervision=new SupervisionService(f.db,f.db.name);instrument(supervision);
    expect(supervision.observer.owner.generation).toBeGreaterThan(old.observer.owner.generation);
    expect(()=>old.observer.step()).toThrow('stale_owner');
    await supervision.handle('attention.loop',loopParams);const generation=supervision.observer.owner.generation;
    lateResolve?.();await delay(20);
    expect(f.db.prepare("SELECT generation FROM attention_subjects WHERE kind='loop' AND subject_id=?").get(firstLoop.loop_id)).toEqual({generation});
    const tickMs:number[]=[];
    const timedLoop=loop as unknown as {runCycle:(...args:unknown[])=>Promise<unknown>};const runCycle=timedLoop.runCycle;
    const cycleSpy=vi.spyOn(timedLoop,'runCycle').mockImplementation(async(...args)=>{const at=performance.now();try{return await runCycle.apply(loop,args);}finally{tickMs.push(performance.now()-at);}});observerSpies.push(cycleSpy);
    const at=performance.now();const cycles=await loop.runCycles({cycles:6,intervalMs:1000});const wallMs=performance.now()-at;cycleSpy.mockRestore();
    const overheadRatio=Math.max(0,wallMs-5000)/wallMs;
    expect(cycles.cycles).toHaveLength(6);process.kill(actual.pid,0);
    await writeFile(gate,'release');await until(first.graphRunId,value=>value.status==='ready');
    sampling=false;await traffic;clearInterval(scanTimer);scanTimer=undefined;
    await writeFile(process.env['OSSTACK_SUPERVISION_QUALIFICATION_REPORT']!+'.active-phase.json',JSON.stringify({timingsMs:Object.fromEntries(Object.entries(samples).map(([key,value])=>[key,stats(value)])),rawSamplesMs:samples,loop:{wallMs,scheduledIdleMs:5000,overheadRatio},actualGraphReady:true,lateGenerationReadDiscarded:true,qualificationComplete:false},null,2)+'\n');
    // A second real process is cancelled through the real graph control path.
    const {unlink}=await import('node:fs/promises');await unlink(gate);await unlink(started);
    const second=await start('active-cancel');await until(second.graphRunId,()=>existsSync(started));
    const cancelledPid=(JSON.parse(await readFile(started,'utf8')) as {pid:number}).pid;
    const before=await status(second.graphRunId);
    await graph.handle(f.connection,'graph.cancel',{schemaVersion:1,kind:'cancel',scope:f.request.scope,idempotencyKey:'cancel-active',graphRunId:second.graphRunId,expectedRevision:before.revision});
    const cancelled=await until(second.graphRunId,value=>value.status==='cancelled');
    expect(()=>process.kill(cancelledPid,0)).toThrow();expect(proofs.size).toBe(2);
    await graph.close();graph=new GraphRpcService(f.options);
    expect((await status(second.graphRunId)).status).toBe('cancelled');expect(starts).toBe(2);
    expect(f.db.prepare('SELECT count(*) n FROM graph_action_admissions WHERE released_at IS NULL').get()).toEqual({n:0});
    const report={node:process.version,platform:process.platform,at:new Date().toISOString(),load:{dirtyIntervalMs,label:process.env['OSSTACK_QUALIFICATION_LOAD_LABEL']??'uncontrolled_shared_development_host'},source:{retainedSyntheticSessions:60,actualGraphRuns:2,actualLocalAdapterChildren:starts,loopCycles:6,externalProviders:0},
      timingsMs:Object.fromEntries(Object.entries(samples).map(([key,value])=>[key,stats(value)])),rawSamplesMs:samples,
      loop:{wallMs,scheduledIdleMs:5000,overheadRatio,tickMs,tickTotalMs:tickMs.reduce((sum,value)=>sum+value,0),schedulerExcessMs:wallMs-5000-tickMs.reduce((sum,value)=>sum+value,0)},functionalAssertionsPassed:true,budgetsPassed:stats(samples.rpc).p95<10&&overheadRatio<.01,restart:{oldGeneration:old.observer.owner.generation,newGeneration:generation,lateReadDiscarded:true},
      graph:{completed:first.graphRunId,cancelled:cancelled.graphRunId,cancelGeneration:cancelled.generation,confirmedStops:[...proofs.values()].map(value=>value.termination)},
      limits:{rpcP95Ms:10,loopOverheadRatio:.01,observerSoftSliceMs:5},
      notes:['Graph workers and adapter child processes were active during socket/observer/Loop measurement.','Retained sessions are labelled fixtures; they are not sixty live providers.','Graph ledger is separate from attention run/session subjects; same host event-loop contention is measured.','scan samples measure requestScan-to-quiescence latency; overlapping calls may share a coalesced physical pass.', 'Loop budget uses wall time minus scheduled sleep; per-tick times diagnose work versus timer scheduling delay, not a substitute pass threshold.', 'Single-machine qualification; no remote/model/Docker/live notification guarantee.']};
    await writeFile(process.env['OSSTACK_SUPERVISION_QUALIFICATION_REPORT']!,JSON.stringify(report,null,2)+'\n');
    expect(samples.rpc.length).toBeGreaterThan(100);expect(samples.observer.length).toBeGreaterThan(20);
    expect(stats(samples.rpc).p95).toBeLessThan(10);expect(overheadRatio).toBeLessThan(.01);
  }finally{
    sampling=false;lateResolve?.();if(scanTimer)clearInterval(scanTimer);await traffic?.catch(()=>{});
    await supervision?.stop();await graph.close();await daemon?.close();for(const spy of observerSpies)spy.mockRestore();await f.close();
    if(oldHome===undefined)delete process.env['OSSTACK_HOME'];else process.env['OSSTACK_HOME']=oldHome;
  }
},120000);
