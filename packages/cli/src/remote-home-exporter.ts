import { randomBytes } from "node:crypto";
import { access, lstat, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { connect } from "node:net";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";
import { DeploymentIdentitySchema, type DeploymentIdentity } from "./home-inventory.js";
import { WorkerListResultSchema } from "./worker-view-service.js";
import { RemoteChannel, RemoteHello, RemoteRead, RemoteServerRegistry, RemoteSnapshot,
  readPinnedRemoteRegistry, remoteHash, snapshotHash } from "./remote-home-protocol.js";

async function endpoint(socketPath:string):Promise<string>{
  if(await realpath(socketPath)!==socketPath)throw new Error("unsafe_endpoint");
  const info=await lstat(socketPath);
  if(!info.isSocket()||(process.getuid&&info.uid!==process.getuid())||(info.mode&0o022)!==0)throw new Error("unsafe_endpoint");
  return `${info.dev}:${info.ino}`;
}
/** Deliberately private, and the method union is not an externally supplied RPC name. */
async function localRead(socketPath:string,method:"deployment.identity"|"worker.list",params?:unknown):Promise<unknown>{
  const before=await endpoint(socketPath);
  const socket=connect(socketPath);const channel=new RemoteChannel(socket,socket,65536+1024);
  try {
    await channel.send({id:1,method,...(params===undefined?{}:{params})});
    const raw=await channel.receive();
    if(await endpoint(socketPath)!==before)throw new Error("endpoint_changed");
    return z.object({id:z.literal(1),ok:z.literal(true),result:z.unknown()}).strict().parse(raw).result;
  }finally{channel.close();socket.destroy();}
}
function sameIdentity(actual:DeploymentIdentity,registry:RemoteServerRegistry,generation?:string):void{
  if(actual.home_id!==registry.home_id||actual.protocol_version!==registry.daemon_protocol||(generation!==undefined&&generation!==actual.generation))throw new Error("identity_mismatch");
}
export interface RemoteExporterDependencies {input?:Readable;output?:Writable;env?:NodeJS.ProcessEnv;}
/** Call only from the dedicated stdio CLI branch. No DB imports/open, starts, or generic dispatch. */
export async function handleRemoteExportCommand(args:string[],deps:RemoteExporterDependencies={}):Promise<number>{
  if(args.length!==1||args[0]!=="--stdio")return 1;
  const input=deps.input??process.stdin,output=deps.output??process.stdout,env=deps.env??process.env;
  let registry:RemoteServerRegistry;let registryHash:string;
  try {
    registryHash=env["OSSTACK_REMOTE_EXPORT_SHA256"]??"";
    registry=RemoteServerRegistry.parse(await readPinnedRemoteRegistry(env["OSSTACK_REMOTE_EXPORT_REGISTRY"]??"",registryHash));
  }catch{return 1;}
  const channel=new RemoteChannel(input,output);
  try {
    const hello=RemoteHello.parse(await channel.receive());
    if(hello.home_id!==registry.home_id||hello.daemon_protocol!==registry.daemon_protocol||hello.registry_sha256!==registryHash)throw new Error("identity_mismatch");
    const scope=registry.scopes.find(s=>s.alias===hello.scope);if(!scope)throw new Error("scope_mismatch");
    if(await realpath(scope.repo_path)!==scope.repo_path||!(await stat(scope.repo_path)).isDirectory())throw new Error("scope_unavailable");
    await access(scope.repo_path,constants.R_OK|constants.X_OK);
    const identity=DeploymentIdentitySchema.parse(await localRead(registry.socket,"deployment.identity"));sameIdentity(identity,registry);
    const binding={protocol:1 as const,nonce:hello.nonce,home_id:identity.home_id,generation:identity.generation,daemon_protocol:identity.protocol_version,registry_sha256:registryHash,scope:scope.alias};
    const token=randomBytes(32).toString("hex");
    await channel.send({...binding,type:"grant",token,methods:["snapshot"],max_page:50});
    const request=RemoteRead.parse(await channel.receive());if(request.token!==token)throw new Error("invalid_token");
    const before=DeploymentIdentitySchema.parse(await localRead(registry.socket,"deployment.identity"));sameIdentity(before,registry,identity.generation);
    const result=WorkerListResultSchema.parse(await localRead(registry.socket,"worker.list",{repo_path:scope.repo_path,default_tenant:true,limit:request.limit}));
    const after=DeploymentIdentitySchema.parse(await localRead(registry.socket,"deployment.identity"));sameIdentity(after,registry,identity.generation);
    if(result.scope.repo_path!==scope.repo_path||result.scope.scope_id!==remoteHash(`default\0${scope.repo_path}`)||result.views.length>request.limit||result.truncated!==(result.next_cursor!==null))throw new Error("scope_mismatch");
    const snapshot={...binding,type:"snapshot" as const,sequence:1 as const,sampled_at_ms:result.sampled_at_ms,total:result.total,
      views:result.views.map((v,i)=>({observation_ref:`view_${i+1}`,source_kind:v.source_kind,state:v.state,revision:v.revision,
        last_updated_at_ms:v.last_updated_at_ms===null||!Number.isSafeInteger(v.last_updated_at_ms)?null:v.last_updated_at_ms,
        source_freshness:v.last_updated_at_ms!==null&&v.last_updated_at_ms>result.sampled_at_ms?"unknown" as const:v.freshness,
        process_liveness:v.process_liveness,wait_reason:v.wait_reason,decision_present:v.latest_turn?.decision_present??false,
        uncertain_delivery_recorded:v.uncertain_delivery_recorded,controls:v.controls})),
      has_more:result.truncated,complete:!result.truncated,coverage:"default_tenant_bound_session_run_only" as const};
    await channel.send(RemoteSnapshot.parse({...snapshot,evidence_sha256:snapshotHash(snapshot)}));
    return 0;
  }catch{return 1;}finally{channel.close();input.pause();}
}
