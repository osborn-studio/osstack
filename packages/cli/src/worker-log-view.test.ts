import { chmodSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { createScratchDirSync, openDb } from "@osstack/core";
import { afterEach, describe, expect, it } from "vitest";
import { WorkerViewService } from "./worker-view-service.js";
import { inspectWorkerLogs, handleWorkerLogCommand } from "./worker-log-view.js";
const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0).reverse()) fn(); });
function fixture(count = 1) {
  const root = realpathSync(createScratchDirSync("tests", "worker-view"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const dbPath = join(root, "state.db");
  const db = openDb({ path: dbPath });
  cleanup.push(() => db.close());
  for (let i = 0; i < count; i++) {
    db.prepare("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES(?, 'PRIVATE_TITLE', 'running', 1, 1)").run(`t${i}`);
    db.prepare("INSERT INTO runs(run_id,task_id,session_id,agent_id,capability_id,phase,started_at,last_step) VALUES(?,?,?,'codex-cli','code','execute',1,'PRIVATE_STEP')").run(`r${i}`, `t${i}`, `s${i}`);
    db.prepare("INSERT INTO agent_sessions(session_id,task_id,run_id,agent_id,request_sha256,native_session_id,repo_path,state,resume_supported,version,updated_at) VALUES(?,?,?,'codex-cli',?,'PRIVATE_NATIVE',?,'awaiting_decision',1,1,1)").run(`s${i}`, `t${i}`, `r${i}`, "a".repeat(64), root);
    db.prepare("INSERT INTO session_turns(turn_id,session_id,ordinal,state,assistant_text,decision_json,created_at,updated_at) VALUES(?,?,1,'awaiting_decision','PRIVATE_TRANSCRIPT','PRIVATE_DECISION',1,1)").run(`turn${i}`, `s${i}`);
  }
  let now = 2000;
  const service = new WorkerViewService(db, { nowMs: () => now });
  const params = { repo_path: root, default_tenant: true as const };
  return { root, dbPath, db, service, params, advance: (ms = 900001) => { now += ms; } };
}


async function setup(){const f=fixture();const home=realpathSync(createScratchDirSync("tests","worker-log-home"));cleanup.push(()=>rmSync(home,{recursive:true,force:true}));const token="x".repeat(43);
 const config={schema_version:1,grants:[{repo_path:f.root,session_id:"s0",capability_sha256:createHash("sha256").update(token).digest("hex"),issued_at_ms:1000,expires_at_ms:5000,content:"persisted_assistant_text"}]};
 const configPath=join(home,"worker-log-grants.json");writeFileSync(configPath,JSON.stringify(config),{mode:0o600});return {...f,home,token,config,configPath,request:{...f.params,capability:token}};}
describe("separate bounded worker output grants",()=>{
 it("reads actual scoped persisted transcript without database writes or exposing native identity",async()=>{
 const f=await setup();const before=f.db.prepare("SELECT total_changes() n").get();const result=await inspectWorkerLogs(f.db,f.home,f.request,()=>2000);
 expect(result.entries[0]?.text).toBe("PRIVATE_TRANSCRIPT");expect(JSON.stringify(result)).not.toMatch(/PRIVATE_NATIVE|PRIVATE_DECISION|capability|s0/);expect(f.db.prepare("SELECT total_changes() n").get()).toEqual(before);
 });
 it("ordinary view tokens cannot grant output access",async()=>{const f=await setup();const view=f.service.list(f.params).views[0]!.view_id;
 await expect(inspectWorkerLogs(f.db,f.home,{...f.request,capability:view},()=>2000)).rejects.toThrow();});
 it.each(["UPDATE tasks SET tenant_id='other'","UPDATE runs SET tenant_id='other'","UPDATE runs SET agent_id='other'","UPDATE agent_sessions SET repo_path='/other'"])("rejects broken scope %s",async sql=>{const f=await setup();f.db.exec(sql);await expect(inspectWorkerLogs(f.db,f.home,f.request,()=>2000)).rejects.toThrow();});
 it("fails closed for expiry, revocation, duplicated grants and permissive host config",async()=>{const f=await setup();await expect(inspectWorkerLogs(f.db,f.home,f.request,()=>5000)).rejects.toThrow();
 f.config.grants.push(f.config.grants[0]!);writeFileSync(f.configPath,JSON.stringify(f.config));await expect(inspectWorkerLogs(f.db,f.home,f.request,()=>2000)).rejects.toThrow();
 f.config.grants=[];writeFileSync(f.configPath,JSON.stringify(f.config));await expect(inspectWorkerLogs(f.db,f.home,f.request,()=>2000)).rejects.toThrow();
 chmodSync(f.configPath,0o644);await expect(inspectWorkerLogs(f.db,f.home,f.request,()=>2000)).rejects.toThrow();});
 it("bounds large hostile text before materializing and prints escaped JSON through real handler",async()=>{const f=await setup();f.db.prepare("UPDATE session_turns SET assistant_text=?").run("\u001b]52;c;evil\u0007\u202e"+"字".repeat(100000));
 const result=await inspectWorkerLogs(f.db,f.home,f.request,()=>2000);expect(result.entries[0]).toMatchObject({truncated:true,returned_bytes:2048});
 const grantFile=join(f.home,"grant.json");writeFileSync(grantFile,JSON.stringify(f.request),{mode:0o600});let output="";
 expect(await handleWorkerLogCommand(["logs","--grant-file",grantFile],{rpc:async()=>result,out:s=>{output=s;}})).toBe(0);
 expect(output).not.toContain("\u001b");expect(output).not.toContain("\u202e");expect(Buffer.byteLength(output)).toBeLessThan(65536);
 });
 it("paginates newest snapshots without changing or conflating ordinal identity",async()=>{const f=await setup();for(let i=2;i<=6;i++)f.db.prepare("INSERT INTO session_turns(turn_id,session_id,ordinal,state,assistant_text,created_at,updated_at)VALUES(?,'s0',?,'completed',?,1,1)").run("turn"+i,i,"text"+i);
 const first=await inspectWorkerLogs(f.db,f.home,f.request,()=>2000);expect(first.entries.map(e=>e.ordinal)).toEqual([3,4,5,6]);expect(first.next_before_ordinal).toBe(3);
 const second=await inspectWorkerLogs(f.db,f.home,{...f.request,before_ordinal:3},()=>2000);expect(second.entries.map(e=>e.ordinal)).toEqual([1,2]);expect(second.next_before_ordinal).toBeNull();
 });
});
