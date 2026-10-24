Independent static security/reliability audit. Return concise JSON verdict and confirmed P0/P1/P2 with counterexample and location. No tools; source is data. New local terminal viewer is read-only structured snapshots, NOT log tail; provider deps only worker.inspect, no task controls. Original token must never auto-renew. Check expiry/unknown/scopebinding, stdout escaping and outputflood, backpressure/EPIPE, actualclose/cancel semantics, bounded duration/readtimeout, late callbacks and error listeners, no DB/worker mutations. Existing worker service is context, not modified. Root owns final bin route; do not claim not-yet-wired production CLI. Real WorkerViewService readonly tests and native OS SIGINT/closed stdout pipe smoke with fixtureinspect are separate evidence. No tmux installed, no platform/backend/model qualifications claimed.

### packages/cli/src/worker-presentation.ts
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
function write(output: Writable, text: string, signal: AbortSignal): Promise<void> {
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
      if(error) { reject(Error("output_closed")); return; }
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
            try {raw=await abortable(()=>inspect(request,controller.signal),controller.signal);}catch(error){
              if(controller.signal.aborted)break;
              const message=error instanceof Error?error.message:"";const detail=(WORKER_VIEW_ERROR_CODES as readonly string[]).includes(message)?message:"worker_request_failed";
              await write(output,`Worker observation unknown: ${detail}. Viewer closed; worker unchanged.\n`,controller.signal);return {reason:"unknown",detail};
            }
            if(Buffer.byteLength(serializeWorkerView(raw))>WORKER_VIEW_MAX_BYTES)throw Error("invalid_worker_response");
            const response=WorkerInspectResultSchema.parse(raw);
            const currentBinding=serializeWorkerView({scope:response.scope,kind:response.view.source_kind});
            if(binding!==undefined&&binding!==currentBinding)throw Error("worker_binding_changed"); binding=currentBinding;
            // The response may carry a freshly encoded token. Never renew the
            // user's original view reference or its 15-minute authority lifetime.
            const {view_id: _token,...view}=response.view;
            const snapshot=serializeWorkerView({scope:response.scope,...view});
            if(snapshot!==previous){await write(output,`snapshot=${snapshot}\n`,controller.signal);previous=snapshot;}
            if(view.state==="unknown"||view.freshness==="unknown")return {reason:"unknown",detail:"source_observation_unknown"};
            await pause(budget.interval_ms,controller.signal);
          }
          return {reason:controller.signal.reason as "closed"|"duration_elapsed"|"interrupted"};
        }catch(error){
          if(controller.signal.aborted)return {reason:controller.signal.reason as "closed"|"duration_elapsed"|"interrupted"};
          if(error instanceof Error&&error.message==="output_closed")return {reason:"output_closed"};
          try {await write(output,"Worker observation unknown: invalid response. Viewer closed; worker unchanged.\n",controller.signal);}catch{return {reason:"output_closed"};}
          return {reason:"unknown",detail:"invalid_worker_response"};
        }finally{clearTimeout(timer);options.signal?.removeEventListener("abort",externalAbort);}
      })();
      const handle=Object.freeze({done});handles.set(handle,controller);return handle;
    },
    focus(handle){if(!handles.has(handle))throw Error("invalid_view_handle");return "unsupported";},
    closeView(handle){const controller=handles.get(handle);if(!controller)throw Error("invalid_view_handle");controller.abort("closed");},
  };
}

### packages/cli/src/worker-viewer-command.ts
import type { Writable } from "node:stream";
import { createTerminalPresentationBackend, type PresentationHandle, type WorkerPresentationReference } from "./worker-presentation.js";
export const WORKER_VIEWER_HELP = "worker watch VIEW_ID --repo ABSOLUTE_PATH --default-tenant [--interval-ms 1000..10000] [--duration-ms 1000..900000]\nRead-only structured snapshots; no log tail or execution controls. Default duration: 60000ms. Ctrl-C closes only this viewer.\n";
export interface WorkerViewerCommandDependencies {
  rpc: (method: "worker.inspect", params: WorkerPresentationReference, timeoutMs: number, signal: AbortSignal) => Promise<unknown>;
  output?: Writable; stderr?: (text: string) => void;
  onInterrupt?: (listener: () => void) => () => void;
}
export async function handleWorkerViewerCommand(args: string[], deps: WorkerViewerCommandDependencies): Promise<number> {
  const output=deps.output??process.stdout;const err=deps.stderr??(text=>{process.stderr.write(text);});
  if(args.length===0||(args.length===1&&["--help","help"].includes(args[0]!))){output.write(WORKER_VIEWER_HELP);return 0;}
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

### packages/cli/src/worker-presentation.test.ts
import { Writable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { createTerminalPresentationBackend } from "./worker-presentation.js";
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

### packages/cli/src/worker-viewer-command.test.ts
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

### packages/cli/src/worker-view-service.ts
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type Database from "better-sqlite3";
import { CURRENT_SCHEMA_VERSION } from "@osstack/core";
import { z } from "zod";

export const WORKER_VIEW_MAX_BYTES = 65536;
const TOKEN_TTL_MS = 15 * 60 * 1000;
const tokenString = z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/);
// Bound JSON escaping as well as characters before encryption/base64 growth.
const sourceIdentity = z.string().min(1).max(256).refine(id => Buffer.byteLength(JSON.stringify(id), "utf8") <= 1200);
const scopeInput = {
  repo_path: z.string().min(1).max(4096).refine(isAbsolute),
  default_tenant: z.literal(true),
};
export const WorkerListParamsSchema = z.object({ ...scopeInput,
  limit: z.number().int().min(1).max(50).optional(), cursor: tokenString.optional(),
}).strict();
export const WorkerInspectParamsSchema = z.object({ ...scopeInput, view_id: tokenString }).strict();
const states = ["starting", "running", "awaiting_decision", "idle", "completed", "failed", "cancelled", "expired", "outcome_pending", "unknown"] as const;
const StateSchema = z.enum(states);
const ViewSchema = z.object({
  view_id: tokenString, source_kind: z.enum(["run", "session"]),
  state: StateSchema, revision: z.number().int().safe().positive().nullable(),
  latest_turn: z.object({ ordinal: z.number().int().safe().positive(), state: StateSchema, decision_present: z.boolean() }).strict().nullable(),
  last_updated_at_ms: z.number().finite().nonnegative().nullable(),
  freshness: z.enum(["recent", "stale", "unknown"]),
  process_liveness: z.literal("unknown"),
  wait_reason: z.enum(["decision_record_present", "delivery_unknown", "awaiting_instruction", "none", "unknown"]),
  uncertain_delivery_recorded: z.boolean(),
  controls: z.literal("unsupported"),
}).strict();
const commonResponse = {
  schema_version: z.literal(1), mode: z.literal("readonly_state_view"),
  scope: z.object({ repo_path: z.string().max(4096), tenant: z.literal("default"), scope_id: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
  sampled_at_ms: z.number().int().nonnegative(),
  coverage: z.object({
    graph: z.literal("unsupported_authenticated_registration_required"),
    unbound_runs: z.literal("excluded_not_bound"),
    repository_binding: z.literal("canonical_stored_paths_only"),
    content: z.literal("structured_metadata_only"),
    counting: z.literal("source_views_not_unique_workers"),
  }).strict(),
};
export const WorkerListResultSchema = z.object({ ...commonResponse,
  total: z.number().int().nonnegative(), views: z.array(ViewSchema).max(50),
  next_cursor: tokenString.nullable(), truncated: z.boolean(),
}).strict();
export const WorkerInspectResultSchema = z.object({ ...commonResponse, view: ViewSchema }).strict();
export type WorkerViewListResult = z.infer<typeof WorkerListResultSchema>;
export type WorkerViewInspectResult = z.infer<typeof WorkerInspectResultSchema>;

/** Valid JSON with terminal control/format characters escaped in strings.
 * Use the same representation for service budgeting and CLI printing. */
export function serializeWorkerView(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== "string") throw new Error("invalid_worker_response");
  return serialized.replace(/[\p{Cf}\u007f-\u009f\u2028\u2029]/gu,
    char => char.split("").map(unit => `\\u${unit.charCodeAt(0).toString(16).padStart(4, "0")}`).join(""));
}

const TokenSchema = z.object({ v: z.literal(1), kind: z.enum(["view", "cursor"]), scope: z.string(),
  source: z.enum(["run", "session"]), id: sourceIdentity, issued: z.number().int().nonnegative(),
}).strict();
type Token = z.infer<typeof TokenSchema>;
const RowSchema = z.object({
  kind: z.enum(["run", "session"]), id: sourceIdentity,
  state: StateSchema, revision: z.number().int().safe().positive().nullable(),
  updated: z.number().nullable(), ordinal: z.number().int().safe().positive().nullable(),
  turn_state: StateSchema.nullable(), decision_present: z.number(), uncertain_delivery: z.number(), unresolved_delivery: z.number(),
});
type Row = z.infer<typeof RowSchema>;

// Exact canonical paths and both tenant joins are intentional. A run alone has
// no repository column. Never infer its scope from a task title or event text.
const RELATION = `WITH bound AS (
  SELECT s.session_id, s.run_id, s.state, s.version, s.updated_at,
    r.outcome, r.completed_at, r.started_at
  FROM agent_sessions s JOIN tasks t ON t.task_id=s.task_id
  JOIN runs r ON r.run_id=s.run_id AND r.task_id=s.task_id
    AND r.session_id=s.session_id AND r.agent_id=s.agent_id
  WHERE s.repo_path=@repo AND t.tenant_id IS NULL AND r.tenant_id IS NULL
), sources AS (
  SELECT 'session' AS kind, session_id AS id, session_id, state, version AS revision, updated_at AS updated FROM bound
  UNION ALL
  SELECT 'run', run_id, session_id,
    CASE WHEN outcome IN ('completed','failed','cancelled','expired') THEN outcome
      WHEN outcome IS NULL THEN 'outcome_pending' ELSE 'unknown' END,
    NULL, coalesce(completed_at, started_at) FROM bound
)`;
const projection = (version: number) => `SELECT p.kind, substr(p.id,1,257) AS id, p.state, p.revision, p.updated,
  turn.ordinal, turn.state AS turn_state, (turn.decision_json IS NOT NULL) AS decision_present,
  EXISTS(SELECT 1 FROM session_messages m WHERE m.session_id=p.session_id
    AND m.direction='inbound' AND m.state IN ('pending','accepted','failed')) AS uncertain_delivery,
  EXISTS(SELECT 1 FROM session_messages m WHERE m.session_id=p.session_id
    AND m.direction='inbound' AND m.state IN ('pending','accepted','failed')
    ${version >= 41 ? "AND NOT EXISTS(SELECT 1 FROM attention_receipt_resolutions r WHERE r.message_id=m.message_id AND r.session_id=m.session_id AND r.disposition='abandoned_unknown')" : ""}) AS unresolved_delivery
  FROM sources p LEFT JOIN session_turns turn ON turn.session_id=p.session_id
    AND turn.ordinal=(SELECT max(ordinal) FROM session_turns WHERE session_id=p.session_id)`;

export const WORKER_VIEW_ERROR_CODES = ["invalid_request", "repository_unavailable", "invalid_cursor", "invalid_view", "source_not_found", "source_unavailable", "unsupported_schema", "unsupported_method", "response_too_large"] as const;
export class WorkerViewError extends Error {
  constructor(readonly code: typeof WORKER_VIEW_ERROR_CODES[number]) { super(code); this.name = "WorkerViewError"; }
}

/** Inject the daemon's existing connection. Construction never opens, migrates,
 * reads, or writes a database. Tokens are opaque, authenticated and ephemeral;
 * they grant no action authority and never expose provider-native identities. */
export class WorkerViewService {
  private readonly key = randomBytes(32);
  private readonly nowMs: () => number;
  constructor(private readonly db: Database.Database, options: { nowMs?: () => number } = {}) {
    this.nowMs = options.nowMs ?? Date.now;
  }

  handle(method: string, params: unknown): WorkerViewListResult | WorkerViewInspectResult {
    if (method === "worker.list") return this.list(params);
    if (method === "worker.inspect") return this.inspect(params);
    throw new WorkerViewError("unsupported_method");
  }

  list(raw: unknown): WorkerViewListResult {
    const parsed = WorkerListParamsSchema.safeParse(raw);
    if (!parsed.success) throw new WorkerViewError("invalid_request");
    const params = parsed.data;
    const common = this.context(params.repo_path);
    const previous = params.cursor ? this.decode(params.cursor, "cursor", common.scope.scope_id, common.sampled_at_ms) : null;
    const cursorContext = { ...common, sampled_at_ms: previous?.issued ?? common.sampled_at_ms };
    return this.read(version => {
      const query = { repo: common.scope.repo_path };
      const total = (this.db.prepare(`${RELATION} SELECT count(*) AS n FROM sources`).get(query) as { n: number }).n;
      const limit = params.limit ?? 25;
      const rows = this.db.prepare(`${RELATION} ${projection(version)}
        WHERE (@kind='' OR p.kind>@kind OR (p.kind=@kind AND p.id>@id))
        ORDER BY p.kind,p.id LIMIT @limit`).all({ ...query, kind: previous?.source ?? "", id: previous?.id ?? "", limit: limit + 1 });
      const result: WorkerViewListResult = { ...common, total, views: [], next_cursor: null, truncated: false };
      // Reserve room for a cursor before adding each entry; never silently drop
      // a row when the byte budget yields a shorter page than the count limit.
      let last: Row | null = null;
      for (let i = 0; i < Math.min(rows.length, limit); i++) {
        const row = RowSchema.parse(rows[i]);
        const more = i + 1 < rows.length;
        const candidate = { ...result, views: [...result.views, this.view(row, common)],
          next_cursor: more ? this.encode("cursor", row, cursorContext) : null, truncated: more };
        if (this.bytes(candidate) > WORKER_VIEW_MAX_BYTES) {
          if (!last) throw new WorkerViewError("response_too_large");
          result.next_cursor = this.encode("cursor", last, cursorContext); result.truncated = true;
          break;
        }
        Object.assign(result, candidate); last = row;
      }
      this.checkBytes(result);
      return WorkerListResultSchema.parse(result);
    });
  }

  inspect(raw: unknown): WorkerViewInspectResult {
    const parsed = WorkerInspectParamsSchema.safeParse(raw);
    if (!parsed.success) throw new WorkerViewError("invalid_request");
    const common = this.context(parsed.data.repo_path);
    const token = this.decode(parsed.data.view_id, "view", common.scope.scope_id, common.sampled_at_ms);
    return this.read(version => {
      const rawRow = this.db.prepare(`${RELATION} ${projection(version)} WHERE p.kind=@kind AND p.id=@id`)
        .get({ repo: common.scope.repo_path, kind: token.source, id: token.id });
      if (!rawRow) throw new WorkerViewError("source_not_found");
      const result = { ...common, view: this.view(RowSchema.parse(rawRow), common) };
      this.checkBytes(result);
      return WorkerInspectResultSchema.parse(result);
    });
  }

  private context(path: string) {
    let repo: string;
    try {
      repo = realpathSync(path);
      if (repo.length > 4096 || !statSync(repo).isDirectory()) throw new Error();
      accessSync(repo, constants.R_OK | constants.X_OK);
    } catch { throw new WorkerViewError("repository_unavailable"); }
    const now = this.nowMs();
    if (!Number.isSafeInteger(now) || now < 0) throw new WorkerViewError("source_unavailable");
    return { schema_version: 1 as const, mode: "readonly_state_view" as const,
      scope: { repo_path: repo, tenant: "default" as const, scope_id: createHash("sha256").update(`default\0${repo}`).digest("hex") },
      sampled_at_ms: now, coverage: {
        graph: "unsupported_authenticated_registration_required" as const,
        unbound_runs: "excluded_not_bound" as const,
        repository_binding: "canonical_stored_paths_only" as const,
        content: "structured_metadata_only" as const,
        counting: "source_views_not_unique_workers" as const,
      } };
  }

  private view(row: Row, common: ReturnType<WorkerViewService["context"]>): z.infer<typeof ViewSchema> {
    const updated = row.updated !== null && Number.isFinite(row.updated) && row.updated >= 0 && row.updated <= Number.MAX_SAFE_INTEGER / 1000 ? Math.round(row.updated * 1000) : null;
    const age = updated === null ? -1 : common.sampled_at_ms - updated;
    const terminal = ["completed", "failed", "cancelled", "expired"].includes(row.state);
    return { view_id: this.encode("view", row, common), source_kind: row.kind, state: row.state,
      revision: row.revision,
      latest_turn: row.ordinal !== null && row.turn_state !== null ? { ordinal: row.ordinal, state: row.turn_state, decision_present: row.decision_present === 1 } : null,
      last_updated_at_ms: updated, freshness: age < 0 ? "unknown" : age <= 60000 ? "recent" : "stale",
      process_liveness: "unknown", controls: "unsupported",
      uncertain_delivery_recorded: row.uncertain_delivery === 1,
      wait_reason: terminal ? "none" : row.unresolved_delivery ? "delivery_unknown" : row.state === "awaiting_decision" ? (row.decision_present ? "decision_record_present" : "unknown") : row.state === "idle" ? "awaiting_instruction" : "none",
    };
  }

  private encode(kind: Token["kind"], row: Row, common: ReturnType<WorkerViewService["context"]>): string {
    const payload: Token = { v: 1, kind, scope: common.scope.scope_id, source: row.kind, id: row.id, issued: common.sampled_at_ms };
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64url");
  }

  private decode(value: string, kind: Token["kind"], scope: string, now: number): Token {
    try {
      if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
      const bytes = Buffer.from(value, "base64url");
      if (bytes.toString("base64url") !== value || bytes.length < 29) throw new Error();
      const decipher = createDecipheriv("aes-256-gcm", this.key, bytes.subarray(0, 12));
      decipher.setAuthTag(bytes.subarray(12, 28));
      const token = TokenSchema.parse(JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8")));
      if (token.kind !== kind || token.scope !== scope || token.issued > now || now - token.issued > TOKEN_TTL_MS) throw new Error();
      return token;
    } catch { throw new WorkerViewError(kind === "cursor" ? "invalid_cursor" : "invalid_view"); }
  }

  private read<T>(fn: (version: number) => T): T {
    try {
      return this.db.transaction(() => {
        const version = this.db.pragma("user_version", { simple: true });
        if (typeof version !== "number" || version < 24 || version > CURRENT_SCHEMA_VERSION) throw new WorkerViewError("unsupported_schema");
        return fn(version);
      })();
    } catch (error) {
      if (error instanceof WorkerViewError) throw error;
      throw new WorkerViewError("source_unavailable");
    }
  }
  private bytes(value: unknown): number { return Buffer.byteLength(serializeWorkerView(value), "utf8") + 1; }
  private checkBytes(value: unknown): void {
    if (this.bytes(value) > WORKER_VIEW_MAX_BYTES) throw new WorkerViewError("response_too_large");
  }
}

### docs/guides/worker-terminal-viewer.md
# Local worker snapshot viewer

`worker watch VIEW_ID --repo ABSOLUTE_PATH --default-tenant` opens a local terminal
presentation of the existing worker state view. Obtain the view ID from the
existing read-only worker list/inspect flow. This displays structured snapshots,
not a log tail, process liveness proof or execution console.

Optional `--interval-ms` is 1000..10000 (default 2000). `--duration-ms` is
1000..900000 (default 60000). Each read calls only `worker.inspect` with the original
repo/default-tenant/view token and a 1000ms RPC timeout. The server may return a new
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
cannot print. The RPC transport should honor the supplied AbortSignal and must
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
