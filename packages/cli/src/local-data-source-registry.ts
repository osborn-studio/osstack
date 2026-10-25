import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { z } from "zod";

const id = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const epoch = z.number().int().safe().nonnegative();
const absolute = z.string().min(1).max(4096).refine(isAbsolute);
const relativeFile = z.string().min(1).max(512).refine(value => !isAbsolute(value) && !value.includes("\\") && value.split("/").every(part => part !== "" && part !== "." && part !== ".."));
export const LocalSourceManifestSchema = z.object({
  schema_version: z.literal(1), id, version: z.string().regex(/^[a-zA-Z0-9._-]{1,64}$/), protocol: z.literal("local_json_snapshot_v1"),
  repo_path: absolute, default_tenant: z.literal(true), capabilities: z.tuple([z.literal("snapshot.read")]), file: relativeFile,
  max_bytes: z.number().int().min(1).max(65536), max_items: z.number().int().min(1).max(20), read_timeout_ms: z.number().int().min(10).max(1000),
  verified_at_ms: epoch, expires_at_ms: epoch, fresh_for_ms: z.number().int().min(1).max(86_400_000),
}).strict().refine(value => value.expires_at_ms > value.verified_at_ms && value.expires_at_ms - value.verified_at_ms <= 604_800_000);
const RegistrationSchema = z.object({source_root:absolute, manifest:LocalSourceManifestSchema, manifest_digest:sha, content_digest:sha}).strict();
const ConfigSchema = z.object({schema_version:z.literal(1),registrations:z.array(RegistrationSchema).max(32)}).strict()
  .refine(value => new Set(value.registrations.map(row => row.manifest.id)).size === value.registrations.length);
export type HostLocalSourceRegistration = z.infer<typeof RegistrationSchema>;
export const LocalSourceInspectParamsSchema = z.object({source_id:id,repo_path:absolute,default_tenant:z.literal(true)}).strict();
export type LocalSourceInspectParams = z.infer<typeof LocalSourceInspectParamsSchema>;
const EntrySchema = z.object({id,text:z.string().min(1).max(8192)}).strict();
const SnapshotSchema = z.object({schema_version:z.literal(1),source_id:id,version:z.string().max(64),revision:epoch,entries:z.array(EntrySchema).max(20)}).strict()
  .refine(value => new Set(value.entries.map(row => row.id)).size === value.entries.length);
const ReasonSchema = z.enum(["config_missing","config_invalid","not_registered","registration_expired","verification_in_future","registration_stale","invalid_clock","source_unavailable","source_escape","source_changed","source_too_large","content_pin_mismatch","invalid_snapshot","config_changed","read_timeout","cancelled","busy","invalid_request","response_too_large"]);
export const LocalSourceInspectResultSchema = z.object({
  schema_version:z.literal(1),source_id:id,scope:z.object({repo_path:absolute,tenant:z.literal("default")}).strict(),
  state:z.enum(["ready","disabled","not_registered","stale","unknown"]),reason:ReasonSchema.nullable(),
  freshness:z.enum(["recent","stale","unknown"]),qualification:z.enum(["pinned_local_snapshot_only","unqualified"]),actions:z.literal("unsupported"),
  provenance:z.object({version:z.string().max(64),manifest_digest:sha,content_digest:sha,verified_at_ms:epoch,expires_at_ms:epoch,revision:epoch}).strict().nullable(),
  entries:z.array(EntrySchema).max(20),
}).strict().refine(value => value.state === "ready"
  ? value.reason === null && value.freshness === "recent" && value.qualification === "pinned_local_snapshot_only" && value.provenance !== null
  : value.reason !== null && value.entries.length === 0 && value.provenance === null && value.qualification === "unqualified" && value.freshness === (value.state === "stale" ? "stale" : "unknown"));
export type LocalSourceInspectResult = z.infer<typeof LocalSourceInspectResultSchema>;
type Reason = z.infer<typeof ReasonSchema>;
class SourceError extends Error { constructor(readonly code:Reason){super(code);} }
const hash = (value:string|Buffer) => createHash("sha256").update(value).digest("hex");
/** Parse reconstructs fields in a fixed order; arbitrary input object key order is not authority. */
export function localSourceManifestDigest(value:unknown):string {return hash(JSON.stringify(LocalSourceManifestSchema.parse(value)));}
export function serializeLocalSource(value:unknown):string {
  return JSON.stringify(value).replace(/[\u007f-\u009f\p{Cf}\u2028\u2029]/gu,character => character.split("").map(unit=>`\\u${unit.charCodeAt(0).toString(16).padStart(4,"0")}`).join(""));
}
function inside(root:string,path:string):boolean {const rel=relative(root,path);return rel!==".."&&!rel.startsWith(`..${sep}`)&&!isAbsolute(rel);}
async function boundedFile(path:string,maximum:number,privateConfig=false):Promise<{raw:Buffer;identity:string}> {
  let file:Awaited<ReturnType<typeof open>>|undefined;
  try {
    file=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const before=await file.stat();
    if(!before.isFile())throw new SourceError("source_unavailable");
    if(privateConfig && (typeof process.getuid!=="function" || before.uid!==process.getuid() || (before.mode&0o077)!==0))throw new SourceError("config_invalid");
    if(before.size>maximum)throw new SourceError("source_too_large");
    const buffer=Buffer.alloc(maximum+1);let length=0;
    while(length<buffer.length){const part=await file.read(buffer,length,buffer.length-length,null);if(!part.bytesRead)break;length+=part.bytesRead;}
    const after=await file.stat();const current=await lstat(path);
    if(!current.isFile()||current.isSymbolicLink()||before.ino!==after.ino||before.dev!==after.dev||before.size!==after.size||before.mtimeMs!==after.mtimeMs||before.ctimeMs!==after.ctimeMs||before.ino!==current.ino||before.dev!==current.dev||before.mtimeMs!==current.mtimeMs||before.ctimeMs!==current.ctimeMs)throw new SourceError("source_changed");
    if(length>maximum)throw new SourceError("source_too_large");
    return {raw:buffer.subarray(0,length),identity:JSON.stringify([before.dev,before.ino,before.size,before.mtimeMs,before.ctimeMs])};
  }finally{await file?.close();}
}
export type HostLocalSources = {state:"ready";registrations:HostLocalSourceRegistration[];fingerprint:string}|{state:"disabled"|"unknown";registrations:[];reason:"config_missing"|"config_invalid"};
/** Only the host calls this with its fixed OSSTACK_HOME/source-registry.json. */
export async function loadHostLocalSources(configPath:string):Promise<HostLocalSources> {
  try {
    if(!absolute.safeParse(configPath).success)throw new Error();
    const file=await boundedFile(configPath,131072,true);const config=ConfigSchema.parse(JSON.parse(file.raw.toString("utf8")));
    if(config.registrations.some(row=>localSourceManifestDigest(row.manifest)!==row.manifest_digest))throw new Error();
    return {state:"ready",registrations:config.registrations,fingerprint:hash(file.raw)+file.identity};
  }catch(error){
    if(error instanceof Error&&"code" in error&&error.code==="ENOENT")return {state:"disabled",registrations:[],reason:"config_missing"};
    return {state:"unknown",registrations:[],reason:"config_invalid"};
  }
}
function empty(params:LocalSourceInspectParams,state:LocalSourceInspectResult["state"],reason:Reason):LocalSourceInspectResult {
  return {schema_version:1,source_id:params.source_id,scope:{repo_path:params.repo_path,tenant:"default"},state,reason,freshness:state==="stale"?"stale":"unknown",qualification:"unqualified",actions:"unsupported",provenance:null,entries:[]};
}
function check(signal:AbortSignal):void {if(signal.aborted)throw new SourceError(signal.reason==="read_timeout"?"read_timeout":"cancelled");}
/** Service lifetime owns actual in-flight slots, including timed-out filesystem reads. */
export function createHostLocalDataSourceService(options:{configPath:string;nowMs?:()=>number}):{
  inspect(input:unknown,signal?:AbortSignal):Promise<LocalSourceInspectResult>;
} {
  const configPath=options.configPath;const now=options.nowMs??Date.now;let active=0;
  return {async inspect(input,externalSignal){
    const parsed=LocalSourceInspectParamsSchema.safeParse(input);if(!parsed.success)throw Error("invalid_request");const params=parsed.data;
    if(active>=2)return empty(params,"unknown","busy");
    if(externalSignal?.aborted)return empty(params,"unknown","cancelled");
    const controller=new AbortController();const cancel=()=>controller.abort("cancelled");externalSignal?.addEventListener("abort",cancel,{once:true});
    const deadline=performance.now()+1000;const timer=setTimeout(()=>controller.abort("read_timeout"),1000);active++;
    const operation=(async()=>{
      check(controller.signal);const config=await loadHostLocalSources(configPath);check(controller.signal);
      if(config.state!=="ready")return empty(params,config.state,config.reason);
      let repo:string;try{repo=await realpath(params.repo_path);if(!(await stat(repo)).isDirectory())throw new Error();}catch{throw new SourceError("source_unavailable");}
      const request={...params,repo_path:repo};const registration=config.registrations.find(row=>row.manifest.id===params.source_id);
      if(!registration)return empty(request,"not_registered","not_registered");
      let registeredRepo:string;
      try{registeredRepo=await realpath(registration.manifest.repo_path);}catch{
        if(registration.manifest.repo_path!==repo)return empty(request,"not_registered","not_registered");
        throw new SourceError("config_invalid");
      }
      if(registeredRepo!==repo)return empty(request,"not_registered","not_registered");
      if(registeredRepo!==registration.manifest.repo_path)throw new SourceError("config_invalid");
      // Cross-request clock continuity belongs to the persistent ledger, which has
      // an explicit audited reset; only this read must reject time moving backwards.
      const manifest=registration.manifest;const sampled=now();
      if(!Number.isSafeInteger(sampled)||sampled<0)throw new SourceError("invalid_clock");
      if(manifest.verified_at_ms>sampled)return empty(request,"unknown","verification_in_future");
      if(manifest.expires_at_ms<=sampled)return empty(request,"unknown","registration_expired");
      if(manifest.verified_at_ms+manifest.fresh_for_ms<sampled)return empty(request,"stale","registration_stale");
      check(controller.signal);const sourceRoot=await realpath(registration.source_root);const rootIdentity=await stat(sourceRoot);if(!rootIdentity.isDirectory())throw new SourceError("source_unavailable");
      const path=resolve(sourceRoot,manifest.file);const canonical=await realpath(path);if(!inside(sourceRoot,canonical)||canonical!==path)throw new SourceError("source_escape");
      const contentStart=performance.now();const contentTimer=setTimeout(()=>controller.abort("read_timeout"),manifest.read_timeout_ms);
      let file:Awaited<ReturnType<typeof boundedFile>>;
      try{file=await boundedFile(path,manifest.max_bytes);}finally{clearTimeout(contentTimer);}
      check(controller.signal);const rootAfter=await stat(sourceRoot);
      if(await realpath(path)!==path||await realpath(registration.source_root)!==sourceRoot||rootAfter.ino!==rootIdentity.ino||rootAfter.dev!==rootIdentity.dev)throw new SourceError("source_escape");
      if(performance.now()-contentStart>=manifest.read_timeout_ms)throw new SourceError("read_timeout");
      if(hash(file.raw)!==registration.content_digest)throw new SourceError("content_pin_mismatch");
      let snapshot:z.infer<typeof SnapshotSchema>;try{snapshot=SnapshotSchema.parse(JSON.parse(file.raw.toString("utf8")));}catch{throw new SourceError("invalid_snapshot");}
      if(snapshot.source_id!==manifest.id||snapshot.version!==manifest.version||snapshot.entries.length>manifest.max_items)throw new SourceError("invalid_snapshot");
      const after=await loadHostLocalSources(configPath);check(controller.signal);
      if(after.state!=="ready"||after.fingerprint!==config.fingerprint)throw new SourceError("config_changed");
      const finalNow=now();if(!Number.isSafeInteger(finalNow)||finalNow<sampled)throw new SourceError("invalid_clock");
      if(finalNow>=manifest.expires_at_ms)throw new SourceError("registration_expired");
      if(finalNow>manifest.verified_at_ms+manifest.fresh_for_ms)return empty(request,"stale","registration_stale");
      if(performance.now()>=deadline)throw new SourceError("read_timeout");
      const result:LocalSourceInspectResult={schema_version:1,source_id:manifest.id,scope:{repo_path:repo,tenant:"default"},state:"ready",reason:null,freshness:"recent",qualification:"pinned_local_snapshot_only",actions:"unsupported",provenance:{version:manifest.version,manifest_digest:registration.manifest_digest,content_digest:registration.content_digest,verified_at_ms:manifest.verified_at_ms,expires_at_ms:manifest.expires_at_ms,revision:snapshot.revision},entries:snapshot.entries};
      if(Buffer.byteLength(serializeLocalSource(result))>65535)throw new SourceError("response_too_large");
      return result;
    })().finally(()=>{active--;});
    try {
      return await new Promise<LocalSourceInspectResult>((resolvePromise,reject)=>{
        const abort=()=>reject(new SourceError(controller.signal.reason==="read_timeout"?"read_timeout":"cancelled"));controller.signal.addEventListener("abort",abort,{once:true});
        operation.then(resolvePromise,reject).finally(()=>controller.signal.removeEventListener("abort",abort));if(controller.signal.aborted)abort();
      });
    }catch(error){return empty(params,"unknown",error instanceof SourceError?error.code:"source_unavailable");}
    finally{clearTimeout(timer);externalSignal?.removeEventListener("abort",cancel);}
  }};
}
