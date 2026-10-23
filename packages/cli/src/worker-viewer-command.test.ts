import { realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { openDb, createScratchDirSync } from "@osstack/core";
import { WorkerViewService } from "./worker-view-service.js";
import { handleWorkerViewerCommand } from "./worker-viewer-command.js";
const cleanup:Array<()=>void>=[];
afterEach(()=>{vi.useRealTimers();for(const fn of cleanup.splice(0))fn();});
function fixture(){
  const repo=realpathSync(createScratchDirSync('tests','worker-viewer'));const db=openDb({path:join(repo,'state.db')});cleanup.push(()=>{db.close();rmSync(repo,{recursive:true,force:true});});
  db.exec("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','t','running',1,1);INSERT INTO runs(run_id,task_id,session_id,agent_id,capability_id,phase,started_at) VALUES('r','t','s','agent','code','execute',1)");
  db.prepare("INSERT INTO agent_sessions(session_id,task_id,run_id,agent_id,request_sha256,repo_path,state,resume_supported,version,updated_at) VALUES('s','t','r','agent',?,?,'running',1,1,1)").run('a'.repeat(64),repo);
  const service=new WorkerViewService(db,{nowMs:()=>1000});const view=service.list({repo_path:repo,default_tenant:true}).views.find(row=>row.source_kind==='session')!;
  return {repo,db,service,view};
}
it('reads the real bound worker service and Ctrl-C stops only local presentation',async()=>{
  const f=fixture();let interrupt!:()=>void;let removed=false;let text='';const methods:string[]=[];
  const output=new Writable({write(chunk,_enc,done){text+=String(chunk);done();}});
  const before=f.db.prepare('SELECT total_changes() n').get();
  const result=handleWorkerViewerCommand(['watch',f.view.view_id,'--repo',f.repo,'--default-tenant'],{
    output,rpc:async(method,params)=>{methods.push(method);return f.service.handle(method,params);},onInterrupt:listener=>{interrupt=listener;return()=>{removed=true;};},
  });
  await vi.waitFor(()=>expect(text).toContain('snapshot='));interrupt();expect(await result).toBe(130);expect(removed).toBe(true);
  expect(methods).toEqual(['worker.inspect']);expect(f.db.prepare('SELECT total_changes() n').get()).toEqual(before);
  expect(f.db.prepare("SELECT state FROM agent_sessions WHERE session_id='s'").get()).toEqual({state:'running'});
});
it('validates strict bounds and scope before making any RPC',async()=>{
  const rpc=vi.fn(async()=>({}));const output=new Writable({write(_chunk,_enc,done){done();}});
  for(const args of [ ['watch','token','--repo','/repo'],['watch','token','--repo','/repo','--default-tenant','--interval-ms','999'],['watch','token','--repo','/repo','--default-tenant','--duration-ms','900001'],['watch','token','--repo','/repo','--default-tenant','--cancel'] ])
    expect(await handleWorkerViewerCommand(args,{rpc,output,stderr:()=>{},onInterrupt:()=>()=>{}})).toBe(1);
  expect(rpc).not.toHaveBeenCalled();
});
it('ends at the configured duration with a bounded original-token read loop',async()=>{
  const f=fixture();vi.useFakeTimers();const rpc=vi.fn(async(method:string,params:unknown)=>f.service.handle(method,params));const output=new Writable({write(_chunk,_enc,done){done();}});
  const result=handleWorkerViewerCommand(['watch',f.view.view_id,'--repo',f.repo,'--default-tenant','--interval-ms','1000','--duration-ms','2000'],{rpc,output,onInterrupt:()=>()=>{}});
  await vi.advanceTimersByTimeAsync(2000);expect(await result).toBe(0);expect(rpc).toHaveBeenCalledTimes(2);
});

it('handles a closed help-output pipe without an unhandled stream error',async()=>{
  const output=new Writable({write(_chunk,_enc,done){done(Object.assign(Error('closed'),{code:'EPIPE'}));}});
  expect(await handleWorkerViewerCommand(['--help'],{output,rpc:async()=>{throw Error('must_not_call');}})).toBe(1);
});
