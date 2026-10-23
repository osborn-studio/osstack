import { RemoteClientRegistry, readPinnedRemoteRegistry, REMOTE_MAX_BYTES } from "./remote-home-protocol.js";
import { readRemoteHome, type RemoteReadDependencies } from "./remote-home-reader.js";
export const REMOTE_HOME_HELP=`remote-home inspect --registry FILE --sha256 HASH --alias NAME [--limit 1..50]\nRead a pinned remote home through fixed SSH stdio; partial pages and transport failures remain explicit.\n`;
export async function handleRemoteHomeCommand(args:string[],deps:RemoteReadDependencies&{stdout?:(text:string)=>void;stderr?:(text:string)=>void}={}):Promise<number>{
  const out=deps.stdout??(text=>{process.stdout.write(text);}),err=deps.stderr??(text=>{process.stderr.write(text);});
  if(args.length===1&&args[0]==="--help"){out(REMOTE_HOME_HELP);return 0;}
  try {
    if(args[0]!=="inspect"||args.length>9||args.some(a=>a.length>4096))throw new Error();
    const flags=new Map<string,string>();
    for(let i=1;i<args.length;i+=2){const key=args[i]!,value=args[i+1];if(!["--registry","--sha256","--alias","--limit"].includes(key)||flags.has(key)||!value)throw new Error();flags.set(key,value);}
    const limit=flags.get("--limit")??"25";if(!/^[1-9][0-9]?$/.test(limit)||Number(limit)>50)throw new Error();
    const registry=RemoteClientRegistry.parse(await readPinnedRemoteRegistry(flags.get("--registry")??"",flags.get("--sha256")??""));
    const entry=registry.homes.find(h=>h.alias===flags.get("--alias"));if(!entry)throw new Error();
    const result=await readRemoteHome(entry,Number(limit),deps);const text=JSON.stringify(result)+"\n";
    if(Buffer.byteLength(text)>REMOTE_MAX_BYTES)throw new Error();out(text);
    return result.status==="observed"&&result.snapshot.complete?0:1;
  }catch{err("invalid_remote_request\n");return 1;}
}
