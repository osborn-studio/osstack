import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createScratchDir, type EngineeringStore } from "@osstack/core";
import { afterEach, expect, it, vi } from "vitest";
import { EngineeringAccess } from "./engineering-access.js";
import { EngineeringHost, type EngineeringHostPorts } from "./engineering-host.js";
let root: string | undefined;
let host: EngineeringHost | undefined;
afterEach(async()=>{vi.restoreAllMocks();await host?.close();host=undefined;if(root)rmSync(root,{recursive:true,force:true});root=undefined;});
it("pages beyond sixteen denied old reservations and retries temporary admission without resending committed work",async()=>{
  root=await createScratchDir("tests","engineering-fairness");const repo=join(root,"repo");mkdirSync(repo);const auth=join(root,"authority.json");
  writeFileSync(auth,JSON.stringify({version:1,principals:[{credential_sha256:createHash("sha256").update("test-credential".repeat(4)).digest("hex"),principal_id:"valid",client_session_id:"ui",read_scopes:[],write_scopes:[],stop_scopes:[],operator_scopes:[]}]}),{mode:0o600});
  const rows=Array.from({length:40},(_,index)=>({created_at:index,action_id:`a${index}`,message_id:`msg${index}`,mission_id:`m${index}`,session_id:`s${index}`,owner_principal_id:index<20?"revoked":"valid",client_session_id:"ui"}));
  let clock = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => clock);
  const committed=new Set<string>();const executed:string[]=[];const attempts=new Map<string,number>();
  const store={
    preflightDispatch:()=>{},recordDispatchBlocked:()=>{},
    listReserved:(limit:number,after?:{created_at:number;action_id:string})=>rows.filter(row=>!committed.has(row.action_id)&&(!after||row.created_at>after.created_at||(row.created_at===after.created_at&&row.action_id>after.action_id))).slice(0,limit),
    getReserved:(id:string)=>rows.find(row=>row.action_id===id&&!committed.has(id)),
    commitDispatch:(id:string)=>{const row=rows.find(value=>value.action_id===id)!;committed.add(id);return {action_id:id,session_id:row.session_id,message_id:row.message_id,turn_id:"turn",reservation_version:2,text:"answer",permit:{message_id:row.message_id,daemon_generation:1}};},
  } as unknown as EngineeringStore;
  const ports:EngineeringHostPorts={
    getSession:id=>({session_id:id,task_id:"task",run_id:id,agent_id:"fixture",request_sha256:"a".repeat(64),native_session_id:"native",repo_path:repo,state:"awaiting_decision",resume_supported:true,version:2,updated_at:1}),
    qualified:()=>true,draining:()=>false,active:()=>false,
    acquire:async(session)=>{const count=(attempts.get(session.session_id)??0)+1;attempts.set(session.session_id,count);if(session.session_id==="s20"&&count===1)throw Error("temporary admission failure");return {lease:{release:async()=>{},retain:()=>{}},controller:new AbortController(),release:async()=>{}};},
    execute:async dispatch=>{executed.push(dispatch.action_id);},stop:()=>false,
  };
  host=new EngineeringHost(store,new EngineeringAccess(auth),ports);
  for(let pass=0;pass<3;pass++){clock+=1000;host.recover();await new Promise(resolve=>setTimeout(resolve,10));}
  expect(store.getReserved("a20")).toBeDefined();expect(committed.has("a20")).toBe(false);expect(executed).not.toContain("a20");expect(attempts.get("s20")).toBe(1);
  for(let pass=0;pass<6;pass++){clock+=1000;host.recover();await new Promise(resolve=>setTimeout(resolve,10));}
  expect(attempts.has("s0")).toBe(false);expect(attempts.has("s19")).toBe(false);
  expect(executed).toHaveLength(20);expect(new Set(executed).size).toBe(20);expect(executed).toContain("a39");expect(attempts.get("s20")).toBe(2);
  for(let pass=0;pass<3;pass++){host.recover();await new Promise(resolve=>setTimeout(resolve,10));}
  expect(executed).toHaveLength(20);
});

it("keeps the independent stop channel reachable when all sixteen dispatch slots are waiting",async()=>{
  root=await createScratchDir("tests","engineering-stop-capacity");const repo=join(root,"repo");mkdirSync(repo);const auth=join(root,"authority.json");const credential="queue-stop-credential-".repeat(3);
  writeFileSync(auth,JSON.stringify({version:1,principals:[{credential_sha256:createHash("sha256").update(credential).digest("hex"),principal_id:"owner",client_session_id:"ui",read_scopes:[],write_scopes:[],stop_scopes:[],operator_scopes:[]}]}),{mode:0o600});
  const rows=Array.from({length:16},(_,i)=>({created_at:i,action_id:`a${i}`,message_id:`msg${i}`,mission_id:`m${i}`,session_id:`s${i}`,owner_principal_id:"owner",client_session_id:"ui"}));
  let stopCalls=0;let recorded=false;let unlock:()=>void=()=>{};const gate=new Promise<void>(resolve=>{unlock=resolve;});let cancelled=false;
  const mission={mission_id:"m0",repo_path:repo};
  const store={db:{prepare:()=>({get:()=>undefined})},preflightDispatch:()=>{},recordDispatchBlocked:()=>{},listReserved:()=>rows,getReserved:(id:string)=>rows.find(row=>row.action_id===id),getMission:()=>mission,readableMission:()=>mission,
    cancel:()=>{cancelled=true;return {mission,run_id:"run",session_id:"s0",stop_intent_id:"stop",action_ids:["a0"],committed_message_ids:["msg0"],replay:false};},
    recordStopReceipt:()=>{recorded=true;},commitDispatch:()=>{throw Error(cancelled?"cancelled_original_answer":"test must not dispatch");},
  } as unknown as EngineeringStore;
  const ports:EngineeringHostPorts={getSession:id=>({session_id:id,task_id:"task",run_id:"run",agent_id:"fixture",request_sha256:"a".repeat(64),native_session_id:"native",repo_path:repo,state:"awaiting_decision",resume_supported:true,version:2,updated_at:1}),qualified:()=>true,draining:()=>false,active:()=>false,
    acquire:async()=>{await gate;return {lease:{release:async()=>{},retain:()=>{}},controller:new AbortController(),release:async()=>{}};},execute:async()=>{throw Error("unexpected invocation");},stop:()=>{stopCalls++;return true;}};
  host=new EngineeringHost(store,new EngineeringAccess(auth),ports);host.recover();await new Promise(resolve=>setTimeout(resolve,10));
  try {
    await expect(host.handle("engineering.cancel",{credential,mission_id:"m0",if_revision:1,request_id:"stop"})).resolves.toMatchObject({stop_intent_id:"stop"});
    expect(stopCalls).toBe(1);expect(recorded).toBe(true);
  } finally {unlock();}
});

it("rejects revoked authority before admission with exponential retry intervals capped at sixty seconds",async()=>{
  root=await createScratchDir("tests","engineering-backoff");const repo=join(root,"repo");mkdirSync(repo);const auth=join(root,"authority.json");
  writeFileSync(auth,JSON.stringify({version:1,principals:[{credential_sha256:createHash("sha256").update("valid-host-credential".repeat(3)).digest("hex"),principal_id:"owner",client_session_id:"ui",read_scopes:[],write_scopes:[],stop_scopes:[],operator_scopes:[]}]}),{mode:0o600});
  let clock=Date.now();vi.spyOn(Date,"now").mockImplementation(()=>clock);let preflights=0;let admissions=0;
  const row={created_at:1,action_id:"action",message_id:"message",mission_id:"mission",session_id:"session",owner_principal_id:"owner",client_session_id:"ui"};
  const store={listReserved:()=>[row],getReserved:()=>row,preflightDispatch:()=>{preflights++;throw Error("permission_denied");},recordDispatchBlocked:()=>{}} as unknown as EngineeringStore;
  const ports:EngineeringHostPorts={getSession:()=>undefined,qualified:()=>true,draining:()=>false,active:()=>false,acquire:async()=>{admissions++;throw Error("must not acquire");},execute:async()=>{throw Error("must not execute");},stop:()=>false};
  host=new EngineeringHost(store,new EngineeringAccess(auth),ports);
  const tick=async()=>{host!.recover();await new Promise(resolve=>setTimeout(resolve,5));};
  await tick();expect(preflights).toBe(1);
  for(const delay of [1000,2000,4000,8000,16000,32000,60000,60000]){
    const before=preflights;clock+=delay-1;await tick();expect(preflights).toBe(before);clock++;await tick();expect(preflights).toBe(before+1);
  }
  expect(admissions).toBe(0);
});
