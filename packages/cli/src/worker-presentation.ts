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
          try {await writePresentationText(output,`Worker observation unknown: ${detail}. Viewer closed; worker unchanged.\n`,controller.signal);}catch{
            if(controller.signal.aborted)return {reason:controller.signal.reason as "closed"|"duration_elapsed"|"interrupted"};
            return {reason:"output_closed"};
          }
          return {reason:"unknown",detail};
        }finally{clearTimeout(timer);options.signal?.removeEventListener("abort",externalAbort);}
      })();
      const handle=Object.freeze({done});handles.set(handle,controller);return handle;
    },
    focus(handle){if(!handles.has(handle))throw Error("invalid_view_handle");return "unsupported";},
    closeView(handle){const controller=handles.get(handle);if(!controller)throw Error("invalid_view_handle");controller.abort("closed");},
  };
}
