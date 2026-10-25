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
