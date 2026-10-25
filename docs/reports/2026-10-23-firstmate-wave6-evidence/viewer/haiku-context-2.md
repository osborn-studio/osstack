Audit this exact revised terminal read-only viewer implementation. Return JSON with concrete confirmed findings severity P0/P1/P2 and verdict. No tools; do not assert runtime verification. Prior round: callback-only error listener now cleaned by setImmediate after Node nextTick error dispatch (immediate removal would crash native EPIPE); independent per-read 1000ms abort deadline added; guarded help output; distinct binding-change diagnostic. Tests include real WorkerViewService DB no changes, native SIGINT and closed stdout smoke separately passed. Backpressure keeps one pending write with error guard until eventual callback/error, deliberately does not destroy shared stdout. Do not invent worker control APIs: dependency only inspect. Parent wires production CLI separately. Review for actual bugs, incomplete cancellation, timeout, escaping, scope/token, error races.

## packages/cli/src/worker-presentation.ts
```
import type { Writable } from "node:stream";
import { z } from "zod";
import { WORKER_VIEW_ERROR_CODES, WORKER_VIEW_MAX_BYTES, WorkerInspectParamsSchema, WorkerInspectResultSchema, serializeWorkerView } from "./worker-view-service.js";
export type WorkerPresentationReference = z.infer<typeof WorkerInspectParamsSchema>;
export type ViewerStop = { reason: "closed" | "duration_elapsed" | "interrupted" | "unknown" | "output_closed"; detail?: string };
export interface PresentationHandle { readonly done: Promise<ViewerStop> }
export interface PresentationBackend {
  capabilities(): { view: true; focus: false; archive: false; output: "structured_snapshot" };
  open(reference: WorkerPresentationReference, options?: { interval_ms?: number; duration_ms?: number; signal?: AbortSignal }): PresentationHandle;
  focus(handle: PresentationHandle): "unsupported";
  closeView(handle: PresentationHandle): void;
}
const Budget = z.object({ interval_ms: z.number().int().min(1000).max(10000), duration_ms: z.number().int().min(1000).max(900000) }).strict();
function abortable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(Error("viewer_closed"));
  return new Promise((resolve,reject) => {
    const abort=()=>{signal.removeEventListener("abort",abort);reject(Error("viewer_closed"));}; signal.addEventListener("abort",abort,{once:true});
    Promise.resolve().then(()=>{if(signal.aborted)throw Error("viewer_closed");return operation();}).then(value=>{signal.removeEventListener("abort",abort);resolve(value);},error=>{signal.removeEventListener("abort",abort);reject(error);});
  });
}
async function readSnapshot(inspect: (signal: AbortSignal)=>Promise<unknown>, signal: AbortSignal): Promise<unknown> {
  const read=new AbortController();const close=()=>read.abort("viewer_closed");
  signal.addEventListener("abort",close,{once:true});if(signal.aborted)close();
  const timeout=setTimeout(()=>read.abort("worker_read_timeout"),1000);
  try {return await abortable(()=>inspect(read.signal),read.signal);}
  catch(error){if(read.signal.reason==="worker_read_timeout")throw Error("worker_read_timeout");throw error;}
  finally{clearTimeout(timeout);signal.removeEventListener("abort",close);}
}
export function writePresentationText(output: Writable, text: string, signal: AbortSignal): Promise<void> {
  if (Buffer.byteLength(text)>WORKER_VIEW_MAX_BYTES || output.destroyed) return Promise.reject(Error("output_closed"));
  if(signal.aborted)return Promise.reject(Error("viewer_closed"));
  // One pending chunk at a time. Closing the view never destroys shared stdout.
  // A pending write retains one error listener until its own callback/late error.
  return new Promise((resolve,reject)=>{
    const onError=()=>{signal.removeEventListener("abort",abort);reject(Error("output_closed"));};
    const abort=()=>{signal.removeEventListener("abort",abort);reject(Error("viewer_closed"));};
    output.once("error",onError); signal.addEventListener("abort",abort,{once:true});
    try { output.write(text,error=>{
      signal.removeEventListener("abort",abort);
      if(error) {
        // Node dispatches the corresponding stream error after its callback.
        // Keep the guard through that dispatch, then also clean callback-only errors.
        setImmediate(()=>output.removeListener("error",onError));
        reject(Error("output_closed")); return;
      }
      output.removeListener("error",onError);resolve();
    }); } catch {output.removeListener("error",onError);signal.removeEventListener("abort",abort);reject(Error("output_closed"));}
  });
}
function pause(ms:number,signal:AbortSignal):Promise<void>{
  return new Promise(resolve=>{const finish=()=>{clearTimeout(timer);signal.removeEventListener("abort",finish);resolve();};const timer=setTimeout(finish,ms);signal.addEventListener("abort",finish,{once:true});if(signal.aborted)finish();});
}
/** Local presentation only: the sole dependency is the existing read-only inspect endpoint. */
export function createTerminalPresentationBackend(deps: { inspect: (reference: WorkerPresentationReference, signal: AbortSignal) => Promise<unknown>; output: Writable }): PresentationBackend {
  const inspect=deps.inspect; const output=deps.output;
  const handles=new WeakMap<PresentationHandle,AbortController>();let opened=false;
  return {
    capabilities:()=>({view:true,focus:false,archive:false,output:"structured_snapshot"}),
    open(reference,options={}) {
      if(opened)throw Error("viewer_already_opened");
      const request=Object.freeze(WorkerInspectParamsSchema.parse(reference));const budget=Budget.parse({interval_ms:options.interval_ms??2000,duration_ms:options.duration_ms??60000});
      opened=true;const controller=new AbortController();const externalAbort=()=>controller.abort("interrupted");
      options.signal?.addEventListener("abort",externalAbort,{once:true});if(options.signal?.aborted)externalAbort();
      const timer=setTimeout(()=>controller.abort("duration_elapsed"),budget.duration_ms);
      const done=(async():Promise<ViewerStop>=>{
        let previous:string|undefined;let binding:string|undefined;
        try {
          while(!controller.signal.aborted){
            let raw:unknown;
            try {raw=await readSnapshot(signal=>inspect(request,signal),controller.signal);}catch(error){
              if(controller.signal.aborted)break;
              const message=error instanceof Error?error.message:"";const detail=(message==="worker_read_timeout"||(WORKER_VIEW_ERROR_CODES as readonly string[]).includes(message))?message:"worker_request_failed";
              await writePresentationText(output,`Worker observation unknown: ${detail}. Viewer closed; worker unchanged.\n`,controller.signal);return {reason:"unknown",detail};
            }
            if(Buffer.byteLength(serializeWorkerView(raw))>WORKER_VIEW_MAX_BYTES)throw Error("invalid_worker_response");
            const response=WorkerInspectResultSchema.parse(raw);
            const currentBinding=serializeWorkerView({scope:response.scope,kind:response.view.source_kind});
            if(binding!==undefined&&binding!==currentBinding)throw Error("worker_binding_changed"); binding=currentBinding;
            // The response may carry a freshly encoded token. Never renew the
            // user's original view reference or its 15-minute authority lifetime.
            const {view_id: _token,...view}=response.view;
            const snapshot=serializeWorkerView({scope:response.scope,...view});
            if(snapshot!==previous){await writePresentationText(output,`snapshot=${snapshot}\n`,controller.signal);previous=snapshot;}
            if(view.state==="unknown"||view.freshness==="unknown")return {reason:"unknown",detail:"source_observation_unknown"};
            await pause(budget.interval_ms,controller.signal);
          }
          return {reason:controller.signal.reason as "closed"|"duration_elapsed"|"interrupted"};
        }catch(error){
          if(controller.signal.aborted)return {reason:controller.signal.reason as "closed"|"duration_elapsed"|"interrupted"};
          if(error instanceof Error&&error.message==="output_closed")return {reason:"output_closed"};
          const detail=error instanceof Error&&error.message==="worker_binding_changed"?"worker_binding_changed":"invalid_worker_response";
          try {await writePresentationText(output,`Worker observation unknown: ${detail}. Viewer closed; worker unchanged.\n`,controller.signal);}catch{return {reason:"output_closed"};}
          return {reason:"unknown",detail};
        }finally{clearTimeout(timer);options.signal?.removeEventListener("abort",externalAbort);}
      })();
      const handle=Object.freeze({done});handles.set(handle,controller);return handle;
    },
    focus(handle){if(!handles.has(handle))throw Error("invalid_view_handle");return "unsupported";},
    closeView(handle){const controller=handles.get(handle);if(!controller)throw Error("invalid_view_handle");controller.abort("closed");},
  };
}

```

## packages/cli/src/worker-viewer-command.ts
```
import type { Writable } from "node:stream";
import { createTerminalPresentationBackend, writePresentationText, type PresentationHandle, type WorkerPresentationReference } from "./worker-presentation.js";
export const WORKER_VIEWER_HELP = "worker watch VIEW_ID --repo ABSOLUTE_PATH --default-tenant [--interval-ms 1000..10000] [--duration-ms 1000..900000]\nRead-only structured snapshots; no log tail or execution controls. Default duration: 60000ms. Ctrl-C closes only this viewer.\n";
export interface WorkerViewerCommandDependencies {
  rpc: (method: "worker.inspect", params: WorkerPresentationReference, timeoutMs: number, signal: AbortSignal) => Promise<unknown>;
  output?: Writable; stderr?: (text: string) => void;
  onInterrupt?: (listener: () => void) => () => void;
}
export async function handleWorkerViewerCommand(args: string[], deps: WorkerViewerCommandDependencies): Promise<number> {
  const output=deps.output??process.stdout;const err=deps.stderr??(text=>{process.stderr.write(text);});
  if(args.length===0||(args.length===1&&["--help","help"].includes(args[0]!))){
    const abort=new AbortController();const timeout=setTimeout(()=>abort.abort(),1000);
    try{await writePresentationText(output,WORKER_VIEWER_HELP,abort.signal);return 0;}catch{return 1;}finally{clearTimeout(timeout);}
  }
  let handle: PresentationHandle;const controller=new AbortController();let removeInterrupt: (()=>void)|undefined;
  try {
    if(args[0]!=="watch"||args.length>11||args.some(arg=>arg.length>4096))throw Error("invalid_request");
    const viewId=args[1];const flags=new Map<string,string|true>();
    const known=new Set(["--repo","--default-tenant","--interval-ms","--duration-ms"]);
    if(!viewId||known.has(viewId))throw Error("invalid_request");
    for(let index=2;index<args.length;index++){
      const flag=args[index]!;if(!known.has(flag)||flags.has(flag))throw Error("invalid_request");
      if(flag==="--default-tenant"){flags.set(flag,true);continue;}
      const value=args[++index];if(!value||known.has(value))throw Error("invalid_request");flags.set(flag,value);
    }
    const numeric=(name:string,fallback:number)=>{const raw=flags.get(name);if(raw===undefined)return fallback;if(typeof raw!=="string"||!/^[1-9][0-9]*$/.test(raw))throw Error("invalid_request");return Number(raw);};
    const backend=createTerminalPresentationBackend({inspect:(reference,signal)=>deps.rpc("worker.inspect",reference,1000,signal),output});
    const subscribe=deps.onInterrupt??(listener=>{process.once("SIGINT",listener);return ()=>{process.removeListener("SIGINT",listener);};});
    removeInterrupt=subscribe(()=>controller.abort());
    handle=backend.open({repo_path:flags.get("--repo") as string,default_tenant:flags.get("--default-tenant") as true,view_id:viewId},
      {interval_ms:numeric("--interval-ms",2000),duration_ms:numeric("--duration-ms",60000),signal:controller.signal});
  }catch{removeInterrupt?.();err("invalid_request\n");return 1;}
  try{const result=await handle.done;return result.reason==="interrupted"?130:["unknown","output_closed"].includes(result.reason)?1:0;}
  finally{removeInterrupt?.();}
}

```

## packages/cli/src/worker-presentation.test.ts
```
import { Writable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { createTerminalPresentationBackend, writePresentationText } from "./worker-presentation.js";
const request = { repo_path: '/repo', default_tenant: true as const, view_id: 'token' };
const response = () => ({ schema_version:1, mode:'readonly_state_view',scope:{repo_path:'/repo',tenant:'default',scope_id:'a'.repeat(64)},sampled_at_ms:1000,
  coverage:{graph:'unsupported_authenticated_registration_required',unbound_runs:'excluded_not_bound',repository_binding:'canonical_stored_paths_only',content:'structured_metadata_only',counting:'source_views_not_unique_workers'},
  view:{view_id:'fresh_token',source_kind:'session',state:'running',revision:1,latest_turn:null,last_updated_at_ms:1000,freshness:'recent',process_liveness:'unknown',wait_reason:'none',uncertain_delivery_recorded:false,controls:'unsupported'} });
afterEach(() => vi.useRealTimers());
function sink() {let text=''; const output=new Writable({write(chunk,_encoding,callback){text+=String(chunk);callback();}}); return {output,text:()=>text};}
it('reads only the original view token and suppresses unchanged metadata', async()=>{
  vi.useFakeTimers(); const out=sink(); const reads: unknown[]=[];
  const backend=createTerminalPresentationBackend({inspect:async value=>{reads.push(value);return response();},output:out.output});
  const handle=backend.open(request,{interval_ms:1000,duration_ms:3000});
  await vi.advanceTimersByTimeAsync(2001); backend.closeView(handle); const result=await handle.done;
  expect(result.reason).toBe('closed'); expect(reads).toHaveLength(3); expect(reads.every(value=>(value as typeof request).view_id==='token')).toBe(true);
  expect(out.text().match(/snapshot=/g)).toHaveLength(1); expect(backend.focus(handle)).toBe('unsupported');
  expect(backend.capabilities()).toMatchObject({view:true,focus:false,archive:false});
});
it('closes a pending reader without outputting its late result',async()=>{
  let resolve!: (value:unknown)=>void; const out=sink();
  const backend=createTerminalPresentationBackend({inspect:()=>new Promise(done=>{resolve=done;}),output:out.output});
  const handle=backend.open(request,{interval_ms:1000,duration_ms:5000}); await vi.waitFor(()=>expect(resolve).toBeTypeOf("function")); backend.closeView(handle); await handle.done;
  resolve(response()); await Promise.resolve(); expect(out.text()).not.toContain('snapshot=');
});
it('ends unknown on expired token without acquiring another token or invoking controls',async()=>{
  const out=sink(); const inspect=vi.fn(async()=>{throw Error('invalid_view');});
  const handle=createTerminalPresentationBackend({inspect,output:out.output}).open(request,{interval_ms:1000,duration_ms:3000});
  expect(await handle.done).toMatchObject({reason:'unknown',detail:'invalid_view'}); expect(inspect).toHaveBeenCalledTimes(1); expect(out.text()).toContain('unknown');
});
it('stops on unknown source observation and escapes terminal controls in paths',async()=>{
  const out=sink(); const raw=response();raw.scope.repo_path='/repo\u001b]0;title\u0007\u009b31m';raw.view.state='unknown';
  const result=await createTerminalPresentationBackend({inspect:async()=>raw,output:out.output}).open(request,{interval_ms:1000,duration_ms:3000}).done;
  expect(result.reason).toBe('unknown'); expect(out.text()).not.toContain(String.fromCharCode(27)); expect(out.text()).not.toContain(String.fromCharCode(155));
});
it('honors output backpressure and closing never destroys the shared terminal stream',async()=>{
  let callback!:()=>void;const output=new Writable({highWaterMark:1,write(_chunk,_encoding,done){callback=done;}});
  const inspect=vi.fn(async()=>response());const backend=createTerminalPresentationBackend({inspect,output});const handle=backend.open(request,{interval_ms:1000,duration_ms:5000});
  await vi.waitFor(()=>expect(callback).toBeTypeOf("function")); backend.closeView(handle);expect((await handle.done).reason).toBe('closed');expect(output.destroyed).toBe(false);callback();
});
it('handles EPIPE as local output closure, without a worker action',async()=>{
  const output=new Writable({write(_chunk,_encoding,done){const error=Object.assign(Error('pipe'),{code:'EPIPE'});done(error);}});
  const result=await createTerminalPresentationBackend({inspect:async()=>response(),output}).open(request,{interval_ms:1000,duration_ms:3000}).done;
  expect(result.reason).toBe('output_closed');
});
it('rejects a changed scope instead of following another worker observation',async()=>{
  vi.useFakeTimers();let calls=0;const out=sink();const backend=createTerminalPresentationBackend({output:out.output,inspect:async()=>{const raw=response();if(++calls>1)raw.scope.scope_id='b'.repeat(64);return raw;}});
  const handle=backend.open(request,{interval_ms:1000,duration_ms:5000});await vi.advanceTimersByTimeAsync(1001);
  expect(await handle.done).toMatchObject({reason:'unknown'});expect(out.text()).not.toContain('b'.repeat(64));
});
it('bounds response floods and does not echo unvalidated output',async()=>{
  const out=sink();const raw=response();raw.scope.repo_path='secret'.repeat(20000);
  const result=await createTerminalPresentationBackend({inspect:async()=>raw,output:out.output}).open(request).done;
  expect(result.reason).toBe('unknown');expect(out.text().length).toBeLessThan(200);expect(out.text()).not.toContain('secret');
});
it('ends a never-settling read on duration and ignores a pre-aborted viewer',async()=>{
  vi.useFakeTimers();const out=sink();const inspect=vi.fn(()=>new Promise<unknown>(()=>{}));
  const handle=createTerminalPresentationBackend({inspect,output:out.output}).open(request,{interval_ms:1000,duration_ms:1000});
  await vi.advanceTimersByTimeAsync(1000);expect(await handle.done).toMatchObject({reason:'duration_elapsed'});
  const aborted=new AbortController();aborted.abort();const before=inspect.mock.calls.length;
  expect(await createTerminalPresentationBackend({inspect,output:out.output}).open(request,{signal:aborted.signal}).done).toMatchObject({reason:'interrupted'});
  expect(inspect.mock.calls.length).toBe(before);
});

it('locally times out a hung transport as unknown and aborts its read signal',async()=>{
  vi.useFakeTimers();const out=sink();let signal:AbortSignal|undefined;
  const handle=createTerminalPresentationBackend({output:out.output,inspect:async(_reference,readSignal)=>{signal=readSignal;return new Promise(()=>{});}}).open(request,{duration_ms:5000});
  await vi.advanceTimersByTimeAsync(1001);
  expect(await handle.done).toMatchObject({reason:'unknown',detail:'worker_read_timeout'});expect(signal?.aborted).toBe(true);
});
it('cleans a callback-only write error listener after the Node error dispatch turn',async()=>{
  const out=sink();vi.spyOn(out.output,'write').mockImplementation((_chunk,_encodingOrCallback,callback)=>{
    const done=typeof _encodingOrCallback==='function'?_encodingOrCallback:callback;done?.(Error('destroyed'));return false;
  });
  await expect(writePresentationText(out.output,'hello',new AbortController().signal)).rejects.toThrow('output_closed');
  await new Promise(resolve=>setImmediate(resolve));expect(out.output.listenerCount('error')).toBe(0);
});

```

## packages/cli/src/worker-viewer-command.test.ts
```
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

```

## docs/guides/worker-terminal-viewer.md
```
# Local worker snapshot viewer

`worker watch VIEW_ID --repo ABSOLUTE_PATH --default-tenant` opens a local terminal
presentation of the existing worker state view. Obtain the view ID from the
existing read-only worker list/inspect flow. This displays structured snapshots,
not a log tail, process liveness proof or execution console.

Optional `--interval-ms` is 1000..10000 (default 2000). `--duration-ms` is
1000..900000 (default 60000). Each read calls only `worker.inspect` with the original
repo/default-tenant/view token and a 1000ms RPC timeout. A separate local 1000ms deadline ends a hung read
as unknown even if the transport ignores its timeout. The server may return a new
token, but the viewer never adopts it to renew authority. Expiry, daemon restart,
source unavailable/unknown, invalid response or scope changes end observation
without acquiring another token. Stale observations remain visibly stale. All
snapshots retain `process_liveness:unknown` and `controls:unsupported`.

`PresentationBackend` exposes `capabilities`, `open`, `focus`, and `closeView`.
The terminal backend supports view only; focus and archive are unsupported. A
backend instance opens one view. Its opaque local handle has no worker control
authority. Closing the view or pressing Ctrl-C only stops local reads/display;
it never invokes cancel/resume, changes a task, removes logs or closes stdout.
No tmux/cmux/desktop integration is installed or claimed qualified.

Output is serialized with the existing worker-view terminal escape policy,
including ANSI, C1, OSC and Unicode format controls. Identical metadata snapshots
are suppressed. Each bounded write completes before another poll, so backpressure
cannot accumulate an unbounded output queue. EPIPE ends only the presentation.
A pending read/write is logically cancelled at duration/close; late read results
cannot print. The local deadline aborts the read signal. The RPC transport should honor the supplied AbortSignal and must
retain the bounded timeout even if cancellation is unavailable.

Host integration is `handleWorkerViewerCommand(args,{rpc,output?,stderr?,onInterrupt?})`
where args begins with `watch` and rpc receives
`('worker.inspect',params,1000,signal)`. Wire this lazily beside existing worker
list/inspect routing. The handler returns 130 on Ctrl-C, 1 on unknown/output failure,
and 0 on configured duration or normal local close. It never opens/migrates a DB
or starts a daemon. Existing worker scope/tenant validation stays authoritative.

Tests exercise real WorkerViewService reads with no DB row changes, fixed-token
polling, changed scope, invalid/flood responses, unknown/expired data, terminal
escaping, output backpressure, EPIPE, duration and interruption. A separate native
smoke uses fixture read responses with the compiled viewer code to verify actual
OS SIGINT and closed stdout pipe behavior; full CLI/daemon routing is integrated
and qualified separately. No real model or external display backend is involved.

```
