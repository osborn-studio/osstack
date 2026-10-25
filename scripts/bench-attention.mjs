#!/usr/bin/env node
// Local deterministic observation qualification; never substitutes for socket RTT or a mixed-backend soak.
import { mkdirSync, writeFileSync, statSync, statfsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { arch, cpus, platform, release } from 'node:os';
import { execFileSync } from 'node:child_process';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
const requireCore = createRequire(new URL('../packages/core/package.json', import.meta.url));
import { setImmediate as yieldImmediate } from 'node:timers/promises';
import { AttentionStore, AttentionObserver, readAttentionRecovery, openDb, createScratchDirSync } from '../packages/core/dist/index.js';
const root = createScratchDirSync('smoke', 'attention-bench');
const path = join(root, 'state.db'); const db = openDb({ path });
const seed = 237; const scopeCount = 10; const runCount = 100; const baseEvents = 20; const burstEvents = 10000;
const sourceFiles = ['packages/core/src/state/attention-observer.ts','packages/core/src/state/attention-run-projection.ts','packages/core/src/state/attention-recovery-view.ts'];
const artifacts = ['packages/core/dist','packages/protocol/dist'].flatMap(dir => readdirSync(dir,{recursive:true}).filter(file=>file.endsWith('.js')).map(file=>join(dir,file)));
const artifactHashes = Object.fromEntries(artifacts.map(file=>[file,createHash('sha256').update(readFileSync(file)).digest('hex')]));
const sourceHashes = Object.fromEntries(sourceFiles.map(file => [file, createHash('sha256').update(readFileSync(file)).digest('hex')]));
const store = new AttentionStore(db, path); const owner = store.claimOwner('benchmark'); const scopes = [];
db.transaction(() => {
  for (let i=0;i<scopeCount;i++) {
    const repo = join(root, `repo-${i}`); mkdirSync(repo);
    db.prepare("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES(?,?,'running',1,1)").run(`task-${i}`, `fixture-${i}`);
    scopes.push(store.registerScope(owner, `task-${i}`, repo));
  }
  const insertRun = db.prepare("INSERT INTO runs(run_id,task_id,session_id,agent_id,capability_id,phase,started_at) VALUES(?,?,?,'fixture','code','execute',1)");
  const insertEvent = db.prepare("INSERT INTO events(event_id,run_id,session_id,seq,type,payload_json,terminal,created_at) VALUES(?,?,?,?,'status','{\"status\":\"running\"}',0,1)");
  for(let i=0;i<runCount;i++) {
    const run = `run-${String(i).padStart(3,'0')}`; const session = `session-${i}`;
    insertRun.run(run, `task-${i%scopeCount}`, session);
    for(let seq=0;seq<baseEvents+(i===0?burstEvents:0);seq++) insertEvent.run(`${run}:${seq}`,run,session,seq);
  }
})();
const observer = new AttentionObserver(store, owner); const steps=[]; const reads=[]; const totalCpu=process.cpuUsage(); const start=performance.now();
const eventLoop = monitorEventLoopDelay({resolution:10}); eventLoop.enable(); let passes=0; let convergence=false; let peakRss=process.memoryUsage().rss;
while(passes<1000) {
  let complete=false;
  while(!complete) {
    const result=observer.step({maxSubjects:25,maxEvents:200,maxDurationMs:5}); steps.push(result.durationMs); complete=result.passComplete;
    const t=performance.now(); readAttentionRecovery(store,owner,{scope_id:scopes[steps.length%scopeCount].scope_id,limit:20}); reads.push(performance.now()-t);
    peakRss=Math.max(peakRss,process.memoryUsage().rss); await yieldImmediate();
  }
  passes++;
  const count=db.prepare("SELECT COUNT(*) n FROM attention_run_cursors WHERE last_seq<through_seq").get().n;
  if(count===0 && db.prepare('SELECT COUNT(*) n FROM attention_run_cursors').get().n===runCount) {convergence=true;break;}
}
eventLoop.disable();
const quantiles = values => {const a=[...values].sort((a,b)=>a-b); return {count:a.length,p50_ms:a[Math.floor((a.length-1)*.5)],p95_ms:a[Math.floor((a.length-1)*.95)],p99_ms:a[Math.floor((a.length-1)*.99)],max_ms:a.at(-1)};};
const fileSize = file => {try{return statSync(file).size;}catch{return 0;}};
const report={source_sha:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim(),dirty:execFileSync('git',['status','--porcelain'],{encoding:'utf8'}).trim().split('\n').filter(Boolean),source_hashes:sourceHashes,measured_artifact_sha256:artifactHashes,lockfile_sha256:createHash("sha256").update(readFileSync("pnpm-lock.yaml")).digest("hex"),
  machine:{platform:platform(),release:release(),arch:arch(),cpu:cpus()[0]?.model,node:process.version,node_module_abi:process.versions.modules,filesystem_type:statfsSync(root).type,native_binding:requireCore("better-sqlite3/package.json").version,sqlite:db.prepare('SELECT sqlite_version() version').get().version},
  workload:{seed,scope_count:scopeCount,admitted_runs:runCount,base_events_per_run:baseEvents,single_source_burst:burstEvents,total_events:runCount*baseEvents+burstEvents,max_subjects:25,max_new_events:200,soft_step_budget_ms:5},
  convergence,passes,wall_ms:performance.now()-start,cpu:process.cpuUsage(totalCpu),peak_rss_bytes:peakRss,db_bytes:fileSize(path),wal_bytes:fileSize(path+'-wal'),
  observer:quantiles(steps),recovery_internal_handler:quantiles(reads),event_loop_delay:{p95_ms:eventLoop.percentile(95)/1e6,max_ms:eventLoop.max/1e6},
  socket_rpc_p95_ms:null,qualifications:{scope:'local_run_observation_fixture',socket:'pending_host_wiring_measurement',mixed_session_loop_soak:'pending',loop_overhead:'not_measured',platform_crash_matrix:'pending',model_calls:0},
  samples:{observer_ms:steps,recovery_internal_ms:reads}};
const output=join(root,'result.json'); writeFileSync(output,JSON.stringify(report,null,2)+'\n'); db.close();
console.log(JSON.stringify({output,convergence,passes,observer:report.observer,recovery_internal_handler:report.recovery_internal_handler,socket_rpc_p95_ms:null}));
if(!convergence) process.exitCode=1;
