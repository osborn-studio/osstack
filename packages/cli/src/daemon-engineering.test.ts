import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import { createScratchDir, openDb, insertRun, insertTask } from "@osstack/core";
import type { AgentSessionEvent, AgentSessionInput, SessionCapableAdapter } from "@osstack/agents";
import { encodeFrame, FrameDecoder, type HermesEvent } from "@osstack/hermes-adapter";
import { afterEach, expect, it, vi } from "vitest";
import { startDaemon, type DaemonHandles } from "./daemon.js";
import { healthyAutonomyHealth } from "./test-healthy-autonomy.js";

class FixtureAdapter implements SessionCapableAdapter {
  readonly id = "engineering-fixture";
  readonly display_name = "Trusted in-process fixture";
  readonly cost_tier = "low" as const;
  readonly resumed: AgentSessionInput[] = [];
  mode: "complete" | "await_abort" | "await_release" | "unknown" = "complete";
  releaseTurn: (()=>void) | undefined;
  readonly aborted = new Set<string>();
  capabilities() { return []; }
  async isAvailable() { return {available:true,status:"available" as const,last_checked_at:Date.now()/1000}; }
  async *invoke(): AsyncIterable<HermesEvent> { yield* []; }
  sessionCapabilities() { return {resume:true,snapshot:true}; }
  async *startSession(): AsyncIterable<AgentSessionEvent> { yield* []; throw new Error("adoption must not start a worker"); }
  async confirmStopped() { return {stopped:true as const,evidence:"fixture iterator owns no process"}; }
  async *resumeSession(input: AgentSessionInput, signal: AbortSignal): AsyncIterable<AgentSessionEvent> {
    this.resumed.push(input);
    yield {type:"native_session.started",native_session_id:input.native_session_id};
    if (this.mode === "await_abort") {
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort",()=>{this.aborted.add(input.message_id);resolve();},{once:true}));
      yield {type:"session.terminal",state:"cancelled"};return;
    }
    if (this.mode === "await_release") await new Promise<void>(resolve=>{this.releaseTurn=resolve;signal.addEventListener("abort",()=>resolve(),{once:true});});
    if (this.mode === "unknown") throw new Error("lost response after invocation");
    yield {type:"assistant.message",message_id:"reply",text:"Reply turn complete"};
    yield {type:"session.terminal",state:"completed"};
  }
}
type Response = {ok:boolean;result?:Record<string,unknown>;error?:{code:string}};
let daemon: DaemonHandles | undefined;
let root: string | undefined;
let socket: string;
let authPath: string;
let repo: string;
let scope: string;
let adapter: FixtureAdapter;
let gate: Promise<void> | undefined;
let releaseGate: (()=>void) | undefined;
let admissionChecks=0;
const credential="engineering-owner-secret-".repeat(2);
const operatorCredential="engineering-operator-secret-".repeat(2);
const writerCredential="engineering-other-writer-".repeat(2);
function rows(write=true, ownerStop=true) {
  return [
    {credential_sha256:hash(credential),principal_id:"owner",client_session_id:"owner-ui",read_scopes:[scope],write_scopes:write?[scope]:[],stop_scopes:ownerStop?[scope]:[],operator_scopes:[]},
    {credential_sha256:hash(operatorCredential),principal_id:"operator",client_session_id:"ops-ui",read_scopes:[scope],write_scopes:[],stop_scopes:[scope],operator_scopes:[scope]},
    {credential_sha256:hash(writerCredential),principal_id:"writer",client_session_id:"writer-ui",read_scopes:[scope],write_scopes:[scope],stop_scopes:[],operator_scopes:[]},
  ];
}
function hash(value:string) {return createHash("sha256").update(value).digest("hex");}
function authority(value: unknown[]) {writeFileSync(authPath,JSON.stringify({version:1,principals:value}),{mode:0o600});}
function rpc(method:string,params:unknown={}):Promise<Response> {
  return new Promise((resolve,reject)=>{
    const sock=connect(socket);const decoder=new FrameDecoder();
    const timer=setTimeout(()=>{sock.destroy();reject(new Error("RPC timeout"));},5000);
    sock.on("connect",()=>sock.write(encodeFrame({id:1,method,params})));
    sock.on("error",error=>{clearTimeout(timer);reject(error);});
    sock.on("data",chunk=>{const frames=decoder.push(chunk);if(frames.length){clearTimeout(timer);sock.end();resolve(frames[0] as Response);}});
  });
}
async function until<T>(read:()=>T|Promise<T>,predicate:(value:T)=>boolean):Promise<T> {
  const deadline=Date.now()+5000;
  while(true){const value=await read();if(predicate(value))return value;if(Date.now()>deadline)throw new Error(`condition timeout: ${JSON.stringify(value)}`);await new Promise(resolve=>setTimeout(resolve,15));}
}
async function boot() {
  daemon=await startDaemon({socketPath:socket,adapters:[adapter],workspacePath:repo,autonomyHealth:async()=>{admissionChecks++;if(gate)await gate;return healthyAutonomyHealth();}});
}
async function fixture() {
  admissionChecks=0;root=await createScratchDir("tests","engineering-daemon");socket=join(root,"d.sock");authPath=join(root,"authority.json");repo=join(realpathSync(root),"repo");mkdirSync(repo);
  execFileSync("git",["init","--quiet",repo]);
  vi.stubEnv("OSSTACK_HOME",root);vi.stubEnv("OSSTACK_SOCKET",socket);vi.stubEnv("OSSTACK_UPDATE_CHECK","0");vi.stubEnv("OSSTACK_ATTENTION","1");vi.stubEnv("OSSTACK_ENGINEERING","1");vi.stubEnv("OSSTACK_ENGINEERING_AUTH_FILE",authPath);
  authority([]);adapter=new FixtureAdapter();await boot();
  const db=openDb({path:daemon!.dbPath});
  insertTask(db,daemon!.dbPath,{task_id:"task",title:"Session adoption fixture",created_at:1});
  insertRun(db,daemon!.dbPath,{run_id:"run",task_id:"task",session_id:"session",agent_id:adapter.id,capability_id:"code",phase:"execute",started_at:1});
  db.prepare("INSERT INTO agent_sessions(session_id,task_id,run_id,agent_id,request_sha256,native_session_id,repo_path,state,resume_supported,version,updated_at) VALUES('session','task','run',?,?,'private-native',?,'awaiting_decision',1,1,1)").run(adapter.id,"a".repeat(64),repo);
  db.prepare("INSERT INTO session_turns(turn_id,session_id,ordinal,state,decision_json,created_at,updated_at) VALUES('turn','session',1,'awaiting_decision',?,1,1)").run(JSON.stringify({decision_id:"decision",question:"Choose a compatible change",choices:[{choice_id:"keep",label:"Keep the field"},{choice_id:"remove",label:"Remove the field"}]}));
  db.close();
  const watch=await rpc("attention.watch",{task_id:"task",repo_path:repo,default_tenant:true});expect(watch.ok).toBe(true);
  const read=openDb({path:daemon!.dbPath});scope=(read.prepare("SELECT scope_id FROM attention_items LIMIT 1").get() as {scope_id:string}).scope_id;read.close();authority(rows());
}
function query(sql:string):Record<string,unknown>|undefined {const db=openDb({path:daemon!.dbPath});try{return db.prepare(sql).get() as Record<string,unknown>|undefined;}finally{db.close();}}
async function adopt(){const result=await rpc("engineering.adopt",{credential,scope_id:scope,task_id:"task",run_id:"run",session_id:"session",goal:"Observe one reply turn",request_id:"adopt"});expect(result).toMatchObject({ok:true});return result.result!["mission"] as {mission_id:string;revision:number};}
async function observe(mission_id:string){const result=await rpc("engineering.observe",{credential,mission_id});expect(result).toMatchObject({ok:true});return result.result!;}
async function answer(mission_id:string){const view=await observe(mission_id);const wait=(view["waits"] as Array<Record<string,unknown>>)[0]!;return {credential,mission_id,wait_id:wait["wait_id"],if_revision:(view["mission"] as {revision:number}).revision,decision_ref:wait["decision_ref"],action_id:"answer",answer:{kind:"choice",choice_id:"keep"},interaction_token:wait["interaction_token"]};}
afterEach(async()=>{releaseGate?.();gate=undefined;releaseGate=undefined;await daemon?.close();daemon=undefined;vi.unstubAllEnvs();if(root)rmSync(root,{recursive:true,force:true});root=undefined;});

it("adopts an existing Session, commits one reply turn and reads its observation proof",async()=>{
  await fixture();const mission=await adopt();const request=await answer(mission.mission_id);
  expect(await rpc("engineering.decide",request)).toMatchObject({ok:true});
  await until(()=>query("SELECT state FROM session_messages"),value=>value?.["state"]==="applied");
  const view=await observe(mission.mission_id);
  expect(view["observation_proof"]).not.toBeNull();
  expect(adapter.resumed).toHaveLength(1);expect(adapter.resumed[0]!.prompt).toBe("Keep the field");
  expect(await rpc("engineering.decide",request)).toMatchObject({ok:true,result:{replay:true}});
  expect(adapter.resumed).toHaveLength(1);
  expect(query("SELECT phase FROM attention_dispatch_phases")?.["phase"]).toBe("dispatch_committed");
});

it("rejects forged request roles and cross-owner steering while preserving scope-operator stop",async()=>{
  await fixture();const mission=await adopt();
  expect(await rpc("engineering.cancel",{credential:writerCredential,mission_id:mission.mission_id,if_revision:mission.revision,request_id:"bad-stop"})).toMatchObject({ok:false,error:{code:"permission_denied"}});
  expect(await rpc("engineering.observe",{credential,mission_id:mission.mission_id,actor:"operator"})).toMatchObject({ok:false,error:{code:"bad_request"}});
  authority(rows(false,false));
  expect(await rpc("engineering.cancel",{credential,mission_id:mission.mission_id,if_revision:mission.revision,request_id:"owner-stop"})).toMatchObject({ok:false,error:{code:"permission_denied"}});
  expect(await rpc("engineering.cancel",{credential:operatorCredential,mission_id:mission.mission_id,if_revision:mission.revision,request_id:"operator-stop"})).toMatchObject({ok:true});
  expect(adapter.resumed).toHaveLength(0);
});

it("checks live authorization after admission and recovers only the uncommitted first dispatch",async()=>{
  await fixture();const mission=await adopt();const request=await answer(mission.mission_id);
  gate=new Promise<void>(resolve=>{releaseGate=resolve;});
  expect(await rpc("engineering.decide",request)).toMatchObject({ok:true});
  await until(()=>query("SELECT phase FROM attention_dispatch_phases"),value=>value?.["phase"]==="reserved");
  authority(rows(false));releaseGate!();gate=undefined;
  await new Promise(resolve=>setTimeout(resolve,50));expect(adapter.resumed).toHaveLength(0);
  await daemon!.close();daemon=undefined;authority(rows());await boot();
  await until(()=>adapter.resumed.length,value=>value===1);
  await until(()=>query("SELECT state FROM session_messages"),value=>value?.["state"]==="applied");
  await daemon!.close();daemon=undefined;await boot();await new Promise(resolve=>setTimeout(resolve,50));expect(adapter.resumed).toHaveLength(1);
});

it("cancels before dispatch through its independent channel and does not invoke the adapter",async()=>{
  await fixture();const mission=await adopt();const request=await answer(mission.mission_id);
  gate=new Promise<void>(resolve=>{releaseGate=resolve;});expect(await rpc("engineering.decide",request)).toMatchObject({ok:true});
  const view=await observe(mission.mission_id);const revision=(view["mission"] as {revision:number}).revision;
  expect(await rpc("engineering.cancel",{credential,mission_id:mission.mission_id,if_revision:revision,request_id:"stop"})).toMatchObject({ok:true});
  releaseGate!();gate=undefined;await new Promise(resolve=>setTimeout(resolve,50));
  expect(query("SELECT phase FROM attention_dispatch_phases")?.["phase"]).toBe("cancelled_before_dispatch");expect(adapter.resumed).toHaveLength(0);
  expect(query("SELECT COUNT(*) AS count FROM engineering_events WHERE kind='stop_unknown'")?.["count"]).toBe(0);
});

it("does not equate a committed abort request with proof that all effects stopped",async()=>{
  await fixture();adapter.mode="await_abort";const mission=await adopt();expect(await rpc("engineering.decide",await answer(mission.mission_id))).toMatchObject({ok:true});
  await until(()=>adapter.resumed.length,value=>value===1);
  authority(rows(false));const view=await observe(mission.mission_id);
  expect(await rpc("engineering.cancel",{credential,mission_id:mission.mission_id,if_revision:(view["mission"] as {revision:number}).revision,request_id:"stop"})).toMatchObject({ok:true});
  await until(()=>query("SELECT state FROM session_messages"),value=>value?.["state"]==="failed");
  expect(query("SELECT phase FROM attention_dispatch_phases")?.["phase"]).toBe("dispatch_committed");
  expect(JSON.stringify(await observe(mission.mission_id))).toContain("stop_unknown");
});

it("never repeats a committed unknown action across a real daemon restart",async()=>{
  await fixture();adapter.mode="unknown";const mission=await adopt();expect(await rpc("engineering.decide",await answer(mission.mission_id))).toMatchObject({ok:true});
  await until(()=>query("SELECT state FROM session_messages"),value=>value?.["state"]==="failed");await daemon!.close();daemon=undefined;await boot();
  await new Promise(resolve=>setTimeout(resolve,50));expect(adapter.resumed).toHaveLength(1);
  const result=await rpc("engineering.reconcile",{credential,kind:"query_action",mission_id:mission.mission_id,action_id:"answer"});expect(result.ok).toBe(true);expect(JSON.stringify(result)).not.toContain('"state":"applied"');
});

it("ends observation without stopping an already committed invocation or inventing success",async()=>{
  await fixture();adapter.mode="await_abort";const mission=await adopt();expect(await rpc("engineering.decide",await answer(mission.mission_id))).toMatchObject({ok:true});
  await until(()=>adapter.resumed.length,value=>value===1);const view=await observe(mission.mission_id);
  const request={credential,mission_id:mission.mission_id,if_revision:(view["mission"] as {revision:number}).revision,request_id:"end"};
  expect(await rpc("engineering.endObservation",request)).toMatchObject({ok:true,result:{mission:{state:"observation_ended"}}});
  expect(await rpc("engineering.endObservation",request)).toMatchObject({ok:true,result:{replay:true}});
  expect(query("SELECT state FROM session_messages")?.["state"]).toBe("accepted");
  expect(query("SELECT phase FROM attention_dispatch_phases")?.["phase"]).toBe("dispatch_committed");
  expect((await observe(mission.mission_id))["observation_proof"]).toBeNull();
});

it("keeps engineering disabled unless both host features are explicitly enabled",async()=>{
  await fixture();await daemon!.close();daemon=undefined;vi.stubEnv("OSSTACK_ENGINEERING","0");await boot();
  expect(await rpc("engineering.observe",{credential,mission_id:"anything"})).toMatchObject({ok:false,error:{code:"engineering_disabled"}});
  await daemon!.close();daemon=undefined;vi.stubEnv("OSSTACK_ATTENTION","0");vi.stubEnv("OSSTACK_ENGINEERING","1");
  await expect(boot()).rejects.toThrow("attention_disabled");
});

it("keeps legacy attention and session routes receipt-only for engineering reservations",async()=>{
  await fixture();const mission=await adopt();const request=await answer(mission.mission_id);
  gate=new Promise<void>(resolve=>{releaseGate=resolve;});const accepted=await rpc("engineering.decide",request);expect(accepted.ok).toBe(true);
  const ref=request.decision_ref as {scope_id:string;item_id:string;item_revision:number;content_hash:string;source_version:number;turn_id:string};
  expect(await rpc("attention.answer",{scope_id:scope,item_id:ref.item_id,revision:ref.item_revision,content_hash:ref.content_hash,action_id:query("SELECT action_id FROM attention_dispatch_phases")!["action_id"],text:"Keep the field",takeover:false})).toMatchObject({ok:true,result:{state:"in_flight",replay:true}});
  const legacy={session_id:"session",runtime_id:adapter.id,turn_id:ref.turn_id,message_id:accepted.result!["message_id"],expected_version:ref.source_version,text:"Keep the field"};
  const replay=await rpc("session.send",legacy);expect(replay.ok).toBe(false);expect(["session_busy","delivery_uncertain"]).toContain(replay.error?.code);
  const view=await observe(mission.mission_id);expect(await rpc("engineering.cancel",{credential,mission_id:mission.mission_id,if_revision:(view["mission"] as {revision:number}).revision,request_id:"stop"})).toMatchObject({ok:true});
  releaseGate!();gate=undefined;await new Promise(resolve=>setTimeout(resolve,30));
  const abandoned=await until(()=>rpc("attention.abandon-receipt",{scope_id:scope,session_id:"session",message_id:accepted.result!["message_id"],expected_version:2,reason:"Do not reopen cancelled original",evidence_sha256:"a".repeat(64),acknowledge_unknown_effects:true}),value=>value.error?.code!=="delivery_in_flight");
  expect(abandoned,JSON.stringify(abandoned)).toMatchObject({ok:true,result:{disposition:"cancelled_before_dispatch",execution_outcome:"not_dispatched"}});
  expect(await rpc("session.send",legacy)).toMatchObject({ok:false,error:{code:"cancelled_original_answer"}});expect(adapter.resumed).toHaveLength(0);
});

it("retains read and stop access when the bound repository disappears",async()=>{
  await fixture();const mission=await adopt();rmSync(repo,{recursive:true,force:true});
  const view=await observe(mission.mission_id);expect((view["mission"] as {state:string}).state).toBe("awaiting_decision");
  expect(view["source_status"]).toBe("unavailable");
  expect(await rpc("engineering.cancel",{credential,mission_id:mission.mission_id,if_revision:(view["mission"] as {revision:number}).revision,request_id:"source-gone-stop"})).toMatchObject({ok:true});
  expect(adapter.resumed).toHaveLength(0);
});

it("rechecks deferred waits on the bounded observer without a model or an automatic answer",async()=>{
  await fixture();const mission=await adopt();const view=await observe(mission.mission_id);const wait=(view["waits"] as Array<Record<string,unknown>>)[0]!;
  expect(await rpc("engineering.defer",{credential,mission_id:mission.mission_id,wait_id:wait["wait_id"],if_revision:(view["mission"] as {revision:number}).revision,wait_revision:wait["revision"],request_id:"defer",revisit_at:new Date(Date.now()+100).toISOString(),reason:"Need time to inspect"})).toMatchObject({ok:true});
  await until(()=>query("SELECT COUNT(*) AS count FROM engineering_events WHERE kind='decision_reminder_due'"),value=>value?.["count"]===1);
  expect(adapter.resumed).toHaveLength(0);await observe(mission.mission_id);expect(query("SELECT COUNT(*) AS count FROM engineering_events WHERE kind='decision_reminder_due'")?.["count"]).toBe(1);
});

it("keeps a healthy slow reply in flight across two observer ticks and finalizes the original attention ledger",async()=>{
  await fixture();adapter.mode="await_release";const mission=await adopt();const accepted=await rpc("engineering.decide",await answer(mission.mission_id));expect(accepted.ok).toBe(true);
  await until(()=>adapter.resumed.length,value=>value===1);
  await new Promise(resolve=>setTimeout(resolve,2100));
  const view=await observe(mission.mission_id);expect((view["mission"] as {state:string}).state).not.toBe("needs_reconciliation");
  expect(query("SELECT state FROM attention_actions")?.["state"]).not.toBe("uncertain");
  expect(await rpc("engineering.reconcile",{credential,kind:"query_action",mission_id:mission.mission_id,action_id:"answer"})).toMatchObject({ok:true,result:{state:"in_flight"}});
  adapter.releaseTurn!();await until(()=>query("SELECT state FROM session_messages"),value=>value?.["state"]==="applied");
  expect(query("SELECT state FROM attention_actions")?.["state"]).toBe("applied");
  expect(query("SELECT state FROM attention_items")?.["state"]).toBe("answer_applied");
});

it("does not reveal whether an unreadable Mission or Session exists",async()=>{
  await fixture();const mission=await adopt();authority(rows().map(row=>({...row,read_scopes:[]})));
  for(const missionId of [mission.mission_id,"missing"]){
    expect(await rpc("engineering.observe",{credential,mission_id:missionId})).toMatchObject({ok:false,error:{code:"permission_denied"}});
  }
  for(const sessionId of ["session","missing"]){
    expect(await rpc("engineering.adopt",{credential,scope_id:scope,task_id:"task",run_id:"run",session_id:sessionId,goal:"Probe",request_id:"probe"})).toMatchObject({ok:false,error:{code:"permission_denied"}});
  }
});

it("does not abort a later manual Session instruction when cancelling the original Mission",async()=>{
  await fixture();adapter.mode="unknown";const mission=await adopt();const accepted=await rpc("engineering.decide",await answer(mission.mission_id));expect(accepted.ok).toBe(true);
  await until(()=>query("SELECT state FROM session_messages"),value=>value?.["state"]==="failed");
  expect(await rpc("attention.abandon-receipt",{scope_id:scope,session_id:"session",message_id:accepted.result!["message_id"],expected_version:2,reason:"Host inspected the prior fixture exit",evidence_sha256:"a".repeat(64),acknowledge_unknown_effects:true})).toMatchObject({ok:true});
  adapter.mode="await_abort";
  const manual=rpc("session.send",{session_id:"session",runtime_id:adapter.id,turn_id:"turn",message_id:"manual-later",expected_version:2,text:"Continue under separate manual authority"});
  await until(()=>adapter.resumed.length,value=>value===2);const view=await observe(mission.mission_id);
  const cancelled=await rpc("engineering.cancel",{credential,mission_id:mission.mission_id,if_revision:(view["mission"] as {revision:number}).revision,request_id:"stop-old"});
  expect(cancelled.ok || cancelled.error?.code==="mission_terminal").toBe(true);
  expect(adapter.aborted.has("manual-later")).toBe(false);
  expect(query("SELECT state FROM session_messages WHERE message_id='manual-later'")?.["state"]).toBe("accepted");
  await rpc("task.cancel",{run_id:"run"});await manual;
});

it("reports a reserved dispatch as an upgrade hold while permitting its explicit cancellation",async()=>{
  await fixture();const mission=await adopt();gate=new Promise<void>(resolve=>{releaseGate=resolve;});
  const accepted=await rpc("engineering.decide",await answer(mission.mission_id));expect(accepted.ok).toBe(true);
  authority(rows(false));releaseGate!();gate=undefined;
  await until(()=>rpc("daemon.drain",{timeout_ms:0}),value=>value.result?.["active_runs"]===0);
  expect(await rpc("daemon.drain",{timeout_ms:0})).toMatchObject({ok:true,result:{drained:false,attention_dispatch_holds:1,active_runs:0}});
  const view=await observe(mission.mission_id);expect(await rpc("engineering.cancel",{credential,mission_id:mission.mission_id,if_revision:(view["mission"] as {revision:number}).revision,request_id:"cancel-drained"})).toMatchObject({ok:true});
  expect(await rpc("daemon.drain",{timeout_ms:0})).toMatchObject({ok:true,result:{drained:true,attention_dispatch_holds:0}});
  expect(adapter.resumed).toHaveLength(0);
});

it("persists one blocked reason and avoids reacquiring writer admission while authority stays revoked",async()=>{
  await fixture();const mission=await adopt();gate=new Promise<void>(resolve=>{releaseGate=resolve;});
  expect(await rpc("engineering.decide",await answer(mission.mission_id))).toMatchObject({ok:true});
  await until(()=>admissionChecks,value=>value>0);authority(rows(false));releaseGate!();gate=undefined;
  await until(()=>query("SELECT COUNT(*) AS count FROM engineering_events WHERE kind='dispatch_blocked'"),value=>value?.["count"]===1);
  const checks=admissionChecks;await new Promise(resolve=>setTimeout(resolve,2200));
  expect(admissionChecks).toBe(checks);expect(query("SELECT COUNT(*) AS count FROM engineering_events WHERE kind='dispatch_blocked'")?.["count"]).toBe(1);
  expect(query("SELECT phase FROM attention_dispatch_phases")?.["phase"]).toBe("reserved");expect(adapter.resumed).toHaveLength(0);
});

it.each(["engineering.cancel","engineering.endObservation"])("%s releases only its proven unstarted queue reservation",async(method)=>{
  await fixture();const mission=await adopt();const request=await answer(mission.mission_id);
  const db=openDb({path:daemon!.dbPath});
  insertTask(db,daemon!.dbPath,{task_id:"held-task",title:"Existing manual writer",created_at:1});
  insertRun(db,daemon!.dbPath,{run_id:"held-run",task_id:"held-task",session_id:"held-session",agent_id:adapter.id,capability_id:"code",phase:"execute",started_at:1});
  db.prepare("INSERT INTO agent_sessions(session_id,task_id,run_id,agent_id,request_sha256,native_session_id,repo_path,state,resume_supported,version,updated_at) VALUES('held-session','held-task','held-run',?,?,'held-native',?,'idle',1,1,1)").run(adapter.id,"b".repeat(64),repo);
  db.prepare("INSERT INTO session_turns(turn_id,session_id,ordinal,state,created_at,updated_at) VALUES('held-turn','held-session',1,'idle',1,1)").run();db.close();
  adapter.mode="await_abort";
  const holder=rpc("session.send",{session_id:"held-session",runtime_id:adapter.id,turn_id:"held-turn",message_id:"held-message",expected_version:1,text:"Occupy the existing repository writer lease"});
  await until(()=>adapter.resumed.length,value=>value===1);
  expect(await rpc("engineering.decide",request)).toMatchObject({ok:true});
  await until(()=>rpc("health"),value=>value.result?.["active_runs"]===2);
  const view=await observe(mission.mission_id);const stop={credential,mission_id:mission.mission_id,if_revision:(view["mission"] as {revision:number}).revision,request_id:"queue-stop"};
  expect(await rpc(method,stop)).toMatchObject({ok:true});
  await until(()=>rpc("health"),value=>value.result?.["active_runs"]===1);
  expect(query("SELECT phase FROM attention_dispatch_phases")?.["phase"]).toBe("cancelled_before_dispatch");
  expect(adapter.resumed).toHaveLength(1);expect(adapter.aborted.has("held-message")).toBe(false);
  const later=rpc("session.send",{session_id:"session",runtime_id:adapter.id,turn_id:"turn",message_id:"later-manual",expected_version:2,text:"A separate manually authorized instruction"});
  await until(()=>rpc("health"),value=>value.result?.["active_runs"]===2);
  expect(await rpc(method,stop)).toMatchObject({ok:true,result:{replay:true}});
  await rpc("task.cancel",{run_id:"held-run"});await holder;
  await until(()=>adapter.resumed.length,value=>value===2);
  expect(adapter.resumed[1]!.message_id).toBe("later-manual");expect(adapter.aborted.has("later-manual")).toBe(false);
  await rpc("task.cancel",{run_id:"run"});await later;
});

it("keeps a refused drain live and resumes the original reserved first dispatch only after explicit resume",async()=>{
  await fixture();const mission=await adopt();gate=new Promise<void>(resolve=>{releaseGate=resolve;});
  expect(await rpc("engineering.decide",await answer(mission.mission_id))).toMatchObject({ok:true});
  await until(()=>rpc("health"),value=>value.result?.["active_runs"]===1);
  expect(await rpc("daemon.drain",{timeout_ms:0})).toMatchObject({ok:true,result:{drained:false,attention_dispatch_holds:1}});
  releaseGate!();gate=undefined;
  await until(()=>rpc("daemon.drain",{timeout_ms:0}),value=>value.result?.["active_runs"]===0);
  expect(await rpc("daemon.drain",{timeout_ms:0})).toMatchObject({ok:true,result:{drained:false,attention_dispatch_holds:1,active_runs:0}});
  expect(await rpc("version")).toMatchObject({ok:true});expect(adapter.resumed).toHaveLength(0);
  expect(query("SELECT phase FROM attention_dispatch_phases")?.["phase"]).toBe("reserved");
  expect(await rpc("daemon.resume")).toMatchObject({ok:true,result:{draining:false}});
  await until(()=>query("SELECT state FROM session_messages"),value=>value?.["state"]==="applied");
  expect(adapter.resumed).toHaveLength(1);
  // Persisting the completed turn precedes async writer-lease cleanup. Wait
  // for actual drainage, not just the durable answer receipt (CI can be slower).
  const drained=await until(()=>rpc("daemon.drain",{timeout_ms:0}),value=>value.result?.["drained"]===true);
  expect(drained).toMatchObject({ok:true,result:{drained:true,attention_dispatch_holds:0,active_runs:0,graph_holds:0}});
});

it("returns dispatch_inconsistent for a new manual send when original cancellation evidence is missing",async()=>{
  await fixture();const mission=await adopt();gate=new Promise<void>(resolve=>{releaseGate=resolve;});
  expect(await rpc("engineering.decide",await answer(mission.mission_id))).toMatchObject({ok:true});
  const view=await observe(mission.mission_id);expect(await rpc("engineering.cancel",{credential,mission_id:mission.mission_id,if_revision:(view["mission"] as {revision:number}).revision,request_id:"stop"})).toMatchObject({ok:true});
  releaseGate!();gate=undefined;await until(()=>rpc("health"),value=>value.result?.["active_runs"]===0);
  // Deliberately damage only this disposable fixture to exercise the proof guard.
  const db=openDb({path:daemon!.dbPath});db.prepare("DELETE FROM engineering_events WHERE kind='stop_requested'").run();db.close();
  expect(await rpc("session.send",{session_id:"session",runtime_id:adapter.id,turn_id:"turn",message_id:"new-manual",expected_version:2,text:"Do not trust a missing proof"})).toMatchObject({ok:false,error:{code:"dispatch_inconsistent"}});
  expect(adapter.resumed).toHaveLength(0);expect(query("SELECT message_id FROM session_messages WHERE message_id='new-manual'")).toBeUndefined();
});
