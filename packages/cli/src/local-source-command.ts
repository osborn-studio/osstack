import { realpath } from "node:fs/promises";
import { writePresentationText } from "./worker-presentation.js";
import { LocalSourceInspectParamsSchema, LocalSourceInspectResultSchema, serializeLocalSource } from "./local-data-source-registry.js";
export const LOCAL_SOURCE_HELP = "sources inspect SOURCE_ID --repo ABSOLUTE_PATH --default-tenant [--json]\nRead only an explicitly host-registered, pinned local snapshot. No actions or automatic context injection.\n";
export async function handleLocalSourceCommand(args:string[],deps:{
  rpc:(method:"source.inspect",params:unknown,timeoutMs:number,signal:AbortSignal)=>Promise<unknown>;
  stdout?:(text:string)=>void;stderr?:(text:string)=>void;
}):Promise<number> {
  const out=async(text:string)=>{if(deps.stdout){deps.stdout(text);return;}const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),1000);try{await writePresentationText(process.stdout,text,controller.signal);}finally{clearTimeout(timer);}};const err=deps.stderr??(text=>{process.stderr.write(text);});
  if(args.length===0||(args.length===1&&["help","--help"].includes(args[0]!))){try{await out(LOCAL_SOURCE_HELP);return 0;}catch{return 1;}}
  let params:ReturnType<typeof LocalSourceInspectParamsSchema.parse>;let json=false;
  try{
    if(args[0]!=="inspect"||args.length>7||args.some(value=>value.length>4096))throw new Error();
    const flags=new Map<string,string|true>();
    for(let index=2;index<args.length;index++){
      const flag=args[index]!;if(flags.has(flag))throw new Error();
      if(flag==="--json"||flag==="--default-tenant"){flags.set(flag,true);continue;}
      if(flag!=="--repo")throw new Error();const value=args[++index];if(!value||value.startsWith("--"))throw new Error();flags.set(flag,value);
    }
    params=LocalSourceInspectParamsSchema.parse({source_id:args[1],repo_path:flags.get("--repo"),default_tenant:flags.get("--default-tenant")});json=flags.has("--json");
  }catch{err("invalid_request\n");return 1;}
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),1500);
  try{
    const raw=await new Promise<unknown>((resolve,reject)=>{
      const abort=()=>reject(Error("source_request_timeout"));controller.signal.addEventListener("abort",abort,{once:true});
      Promise.resolve().then(async()=>{
        const repo=await realpath(params.repo_path);if(controller.signal.aborted)throw Error("source_request_timeout");
        params={...params,repo_path:repo};return deps.rpc("source.inspect",params,1500,controller.signal);
      }).then(resolve,reject).finally(()=>controller.signal.removeEventListener("abort",abort));
    });
    if(Buffer.byteLength(serializeLocalSource(raw))>65535)throw new Error();
    const response=LocalSourceInspectResultSchema.parse(raw);if(response.source_id!==params.source_id||response.scope.repo_path!==params.repo_path||response.scope.tenant!=="default")throw new Error();
    const text=json?serializeLocalSource(response):`Local source ${response.source_id}: ${response.state}; qualification=${response.qualification}; actions=unsupported\n${serializeLocalSource(response)}`;
    if(Buffer.byteLength(text)>65535)throw new Error();await out(`${text}\n`);return response.state==="ready"?0:1;
  }catch{err("source_observation_unknown\n");return 1;}
  finally{clearTimeout(timer);}
}
