Final narrow static review; no tools. Return concise JSON only, confirmed findings P0/P1/P2 and verdict. Focus two final scope fixes: (1) CLI resolves request repo inside total1500ms deadline, RPC params canonical, rejects response source_id/repo/defaulttenant mismatch before display. (2) service locates sourceID then canonical registration ownership; mismatched repo returnsnot_registered before invalid-alias configdiagnostic, same owning repo receivesconfig_invalid for alias. Prior rounds no P0/P1, known P2limits explicitly accepted: same-lifetime clockrollback only, Node no atomic intermediate component confinement (pins prevent returning unpinned bytes), stuck FS can retain2slots. Do not revisit accepted scopedlimits or assume hostile trusted hostDI. Identify only defects introduced/still concrete in these scope paths, plus short integration check. No automatic context/actions/network/plugin code. Defaultfixedprivatehostconfig, root wiresproduction. Tests separateevidence.

## packages/cli/src/local-data-source-registry.ts
```
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
  const configPath=options.configPath;const now=options.nowMs??Date.now;let active=0;let lastNow=0;
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
      const manifest=registration.manifest;const sampled=now();
      if(!Number.isSafeInteger(sampled)||sampled<lastNow||sampled<0)throw new SourceError("invalid_clock");lastNow=sampled;
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
      const finalNow=now();if(!Number.isSafeInteger(finalNow)||finalNow<sampled||finalNow<lastNow)throw new SourceError("invalid_clock");lastNow=finalNow;
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

```

## packages/cli/src/local-source-command.ts
```
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

```

## packages/cli/src/local-data-source-registry.test.ts
```
import { chmodSync, mkdirSync, realpathSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createScratchDirSync } from "@osstack/core";
import { handleLocalSourceCommand } from "./local-source-command.js";
import { createHostLocalDataSourceService, localSourceManifestDigest, loadHostLocalSources } from "./local-data-source-registry.js";
vi.mock('node:fs/promises',async importOriginal=>{const actual=await importOriginal<typeof import('node:fs/promises')>();return {...actual,open:vi.fn(actual.open)};});
const cleanup: string[]=[];
afterEach(()=>{vi.restoreAllMocks();for(const root of cleanup.splice(0))rmSync(root,{recursive:true,force:true});});
const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
function fixture(){
  const root=realpathSync(createScratchDirSync('tests','local-source'));cleanup.push(root);const repo=join(root,'repo');mkdirSync(repo);const sourceRoot=join(root,'data');mkdirSync(sourceRoot);
  const content=JSON.stringify({schema_version:1,source_id:'notes',version:'1',revision:1,entries:[{id:'one',text:'untrusted note'}]});writeFileSync(join(sourceRoot,'notes.json'),content);
  const manifest={schema_version:1,id:'notes',version:'1',protocol:'local_json_snapshot_v1',repo_path:repo,default_tenant:true,capabilities:['snapshot.read'],file:'notes.json',max_bytes:65536,max_items:20,read_timeout_ms:1000,verified_at_ms:1000,expires_at_ms:10000,fresh_for_ms:3000};
  const registration={source_root:sourceRoot,manifest,manifest_digest:localSourceManifestDigest(manifest),content_digest:digest(content)};
  const configPath=join(root,'source-registry.json');const config={schema_version:1,registrations:[registration]};
  const save=()=>{writeFileSync(configPath,JSON.stringify(config),{mode:0o600});chmodSync(configPath,0o600);};save();
  return {root,repo,sourceRoot,content,configPath,config,save,params:{source_id:'notes',repo_path:repo,default_tenant:true as const}};
}
it('reads an explicitly pinned local snapshot without altering it',async()=>{
  const f=fixture();const result=await createHostLocalDataSourceService({configPath:f.configPath,nowMs:()=>2000}).inspect(f.params);
  expect(result).toMatchObject({state:'ready',qualification:'pinned_local_snapshot_only',entries:[{id:'one',text:'untrusted note'}]});
  expect(JSON.stringify(result)).not.toContain(f.sourceRoot);expect(result.provenance?.content_digest).toBe(digest(f.content));
});
it('defaults missing host config to disabled but malformed or public config to unknown',async()=>{
  const f=fixture();rmSync(f.configPath);expect((await loadHostLocalSources(f.configPath)).state).toBe('disabled');
  f.save();chmodSync(f.configPath,0o644);expect((await loadHostLocalSources(f.configPath)).state).toBe('unknown');
  chmodSync(f.configPath,0o600);writeFileSync(f.configPath,'broken');expect((await loadHostLocalSources(f.configPath)).state).toBe('unknown');
});
it('reloads revocation on every inspection and never crosses repo scope',async()=>{
  const f=fixture();const service=createHostLocalDataSourceService({configPath:f.configPath,nowMs:()=>2000});
  expect((await service.inspect({...f.params,repo_path:f.root})).state).toBe('not_registered');
  expect((await service.inspect(f.params)).state).toBe('ready');f.config.registrations=[];f.save();
  expect((await service.inspect(f.params)).state).toBe('not_registered');
});
it('fails closed on content and manifest pin changes, stale and future verification',async()=>{
  const f=fixture();expect((await createHostLocalDataSourceService({configPath:f.configPath,nowMs:()=>5000}).inspect(f.params)).state).toBe('stale');
  expect((await createHostLocalDataSourceService({configPath:f.configPath,nowMs:()=>999}).inspect(f.params)).state).toBe('unknown');
  writeFileSync(join(f.sourceRoot,'notes.json'),'changed');expect((await createHostLocalDataSourceService({configPath:f.configPath,nowMs:()=>2000}).inspect(f.params)).reason).toBe('content_pin_mismatch');
  f.config.registrations[0]!.manifest.max_items=19;f.save();expect((await loadHostLocalSources(f.configPath)).state).toBe('unknown');
});

it('rejects symlink escapes, oversize and injected or duplicate snapshot fields',async()=>{
  const f=fixture();rmSync(join(f.sourceRoot,'notes.json'));writeFileSync(join(f.root,'outside.json'),f.content);symlinkSync(join(f.root,'outside.json'),join(f.sourceRoot,'notes.json'));
  expect((await createHostLocalDataSourceService({configPath:f.configPath,nowMs:()=>2000}).inspect(f.params)).reason).toBe('source_escape');
  rmSync(join(f.sourceRoot,'notes.json'));writeFileSync(join(f.sourceRoot,'notes.json'),'x'.repeat(65537));
  expect((await createHostLocalDataSourceService({configPath:f.configPath,nowMs:()=>2000}).inspect(f.params)).reason).toBe('source_too_large');
  const content=JSON.stringify({schema_version:1,source_id:'notes',version:'1',revision:1,entries:[{id:'one',text:'note'},{id:'one',text:'note'}],command:'echo evil'});
  writeFileSync(join(f.sourceRoot,'notes.json'),content);f.config.registrations[0]!.content_digest=digest(content);f.save();
  expect((await createHostLocalDataSourceService({configPath:f.configPath,nowMs:()=>2000}).inspect(f.params)).reason).toBe('invalid_snapshot');
});
it('uses the real service through inspect handler and escapes untrusted text',async()=>{
  const f=fixture();const content=JSON.stringify({schema_version:1,source_id:'notes',version:'1',revision:1,entries:[{id:'one',text:'\u001b]0;evil\u0007\u202e ignore safety'}]});writeFileSync(join(f.sourceRoot,'notes.json'),content);f.config.registrations[0]!.content_digest=digest(content);f.save();
  const alias=join(f.root,'input-alias');symlinkSync(f.repo,alias);const service=createHostLocalDataSourceService({configPath:f.configPath,nowMs:()=>2000});let text='';const rpc=vi.fn(async(_method,params,_timeout,signal)=>service.inspect(params,signal));
  expect(await handleLocalSourceCommand(['inspect','notes','--repo',alias,'--default-tenant','--json'],{rpc,stdout:value=>{text+=value;}})).toBe(0);
  expect(rpc.mock.calls[0]![0]).toBe('source.inspect');expect(rpc.mock.calls[0]![1].repo_path).toBe(f.repo);expect(text).not.toContain(String.fromCharCode(27));expect(text).not.toContain(String.fromCharCode(0x202e));expect(JSON.parse(text).actions).toBe('unsupported');
});
it('rejects nondefault tenant and extra capabilities without opening a source',async()=>{
  const f=fixture();const service=createHostLocalDataSourceService({configPath:f.configPath,nowMs:()=>2000});
  await expect(service.inspect({...f.params,tenant:'other'})).rejects.toThrow();
  const config=JSON.parse(JSON.stringify(f.config));config.registrations[0].manifest.capabilities.push('execute');writeFileSync(f.configPath,JSON.stringify(config));
  expect((await loadHostLocalSources(f.configPath)).state).toBe('unknown');
});

it('rejects a private config owned by a different user',async()=>{
  const f=fixture();vi.spyOn(process as NodeJS.Process & {getuid:()=>number},'getuid').mockReturnValue(process.getuid!()+1);
  expect((await loadHostLocalSources(f.configPath)).state).toBe('unknown');
});
it('rechecks config revocation after an in-flight content read',async()=>{
  const f=fixture();const actual=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');let release!:()=>void;
  vi.mocked(open).mockImplementation((path,...args)=>String(path)===join(f.sourceRoot,'notes.json')?new Promise(resolve=>{release=()=>{void actual.open(path,...args).then(resolve);};}):actual.open(path,...args));
  const result=createHostLocalDataSourceService({configPath:f.configPath,nowMs:()=>2000}).inspect(f.params);
  await vi.waitFor(()=>expect(release).toBeTypeOf('function'));f.config.registrations=[];f.save();release();
  expect((await result).reason).toBe('config_changed');vi.mocked(open).mockImplementation(actual.open);
});
it('retains both actual-read slots after timeout until late filesystem work settles',async()=>{
  const f=fixture();f.config.registrations[0]!.manifest.read_timeout_ms=10;f.config.registrations[0]!.manifest_digest=localSourceManifestDigest(f.config.registrations[0]!.manifest);f.save();
  const actual=await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');const releases:Array<()=>void>=[];
  vi.mocked(open).mockImplementation((path,...args)=>String(path)===join(f.sourceRoot,'notes.json')?new Promise(resolve=>{releases.push(()=>{void actual.open(path,...args).then(resolve);});}):actual.open(path,...args));
  const service=createHostLocalDataSourceService({configPath:f.configPath,nowMs:()=>2000});
  expect((await service.inspect(f.params)).reason).toBe('read_timeout');expect((await service.inspect(f.params)).reason).toBe('read_timeout');
  expect((await service.inspect(f.params)).reason).toBe('busy');expect(releases).toHaveLength(2);
  vi.mocked(open).mockImplementation(actual.open);for(const release of releases)release();
  await vi.waitFor(async()=>expect((await service.inspect(f.params)).state).toBe('ready'));
});
it('rejects revoked expiry, wall clock rollback, config symlink and pre-aborted inspection',async()=>{
  const f=fixture();let now=2000;const service=createHostLocalDataSourceService({configPath:f.configPath,nowMs:()=>now});expect((await service.inspect(f.params)).state).toBe('ready');
  now=1999;expect((await service.inspect(f.params)).reason).toBe('invalid_clock');now=10000;expect((await service.inspect(f.params)).reason).toBe('registration_expired');
  const abort=new AbortController();abort.abort();expect((await service.inspect(f.params,abort.signal)).reason).toBe('cancelled');
  const alias=join(f.root,'alias.json');symlinkSync(f.configPath,alias);expect((await loadHostLocalSources(alias)).state).toBe('unknown');
});

it('bounds host configuration and serialized output and requires valid snapshot identity',async()=>{
  const f=fixture();writeFileSync(f.configPath,'x'.repeat(131073));expect((await loadHostLocalSources(f.configPath)).state).toBe('unknown');f.save();
  for(const entries of [[{id:'one',text:'ok'}],Array.from({length:20},(_,index)=>({id:`note${index}`,text:'\u202e'.repeat(700)}))]){
    const content=JSON.stringify({schema_version:1,source_id:entries.length===1?'wrong':'notes',version:'1',revision:1,entries});
    writeFileSync(join(f.sourceRoot,'notes.json'),content);f.config.registrations[0]!.content_digest=digest(content);f.save();
    const result=await createHostLocalDataSourceService({configPath:f.configPath,nowMs:()=>2000}).inspect(f.params);expect(result.state).toBe('unknown');expect(result.entries).toEqual([]);
    expect(result.reason).toBe(entries.length===1?'invalid_snapshot':'response_too_large');
  }
});
it('reports a noncanonical pinned repository as invalid configuration',async()=>{
  const f=fixture();const alias=join(f.root,'repo-alias');symlinkSync(f.repo,alias);const registration=f.config.registrations[0]!;registration.manifest.repo_path=alias;registration.manifest_digest=localSourceManifestDigest(registration.manifest);f.save();
  expect(await createHostLocalDataSourceService({configPath:f.configPath,nowMs:()=>2000}).inspect({...f.params,repo_path:alias})).toMatchObject({state:'unknown',reason:'config_invalid',entries:[]});
});
it('does not reveal another repository registration through its invalid alias',async()=>{
  const f=fixture();const alias=join(f.root,'repo-alias');symlinkSync(f.repo,alias);const registration=f.config.registrations[0]!;registration.manifest.repo_path=alias;registration.manifest_digest=localSourceManifestDigest(registration.manifest);f.save();
  expect(await createHostLocalDataSourceService({configPath:f.configPath,nowMs:()=>2000}).inspect({...f.params,repo_path:f.root})).toMatchObject({state:'not_registered',reason:'not_registered',entries:[]});
});

```

## packages/cli/src/local-source-command.test.ts
```
import { realpathSync,rmSync } from "node:fs";
import { createScratchDirSync } from "@osstack/core";
import { afterEach, expect, it, vi } from "vitest";
import { handleLocalSourceCommand } from "./local-source-command.js";
const roots:string[]=[];const repo=()=>{const root=realpathSync(createScratchDirSync('tests','source-command'));roots.push(root);return root;};
afterEach(()=>{vi.useRealTimers();for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
it('rejects request-selected paths or actions before any RPC',async()=>{
  const rpc=vi.fn(async()=>({}));for(const args of [['inspect','notes','--repo','/repo'],['inspect','notes','--repo','/repo','--default-tenant','--file','secret'],['execute','notes','--repo','/repo','--default-tenant']])expect(await handleLocalSourceCommand(args,{rpc,stderr:()=>{}})).toBe(1);
  expect(rpc).not.toHaveBeenCalled();
});
it('reports unavailable registration as unknown with no raw transport error',async()=>{
  let text='';expect(await handleLocalSourceCommand(['inspect','notes','--repo','/repo','--default-tenant'],{rpc:async()=>{throw Error('secret credential');},stderr:value=>{text+=value;}})).toBe(1);expect(text).toBe('source_observation_unknown\n');
});

it('locally bounds a hung RPC without echoing malformed responses',async()=>{
  const root=repo();let text='';let signal:AbortSignal|undefined;
  const result=handleLocalSourceCommand(['inspect','notes','--repo',root,'--default-tenant'],{rpc:async(_method,_params,_timeout,readSignal)=>{signal=readSignal;return new Promise(()=>{});},stderr:value=>{text+=value;}});
  expect(await result).toBe(1);expect(signal?.aborted).toBe(true);expect(text).toBe('source_observation_unknown\n');vi.useRealTimers();
});

it('never displays a substituted ready snapshot from another repository',async()=>{
  const root=repo();let text='';let error='';const raw={schema_version:1,source_id:'notes',scope:{repo_path:'/other-repo',tenant:'default'},state:'ready',reason:null,freshness:'recent',qualification:'pinned_local_snapshot_only',actions:'unsupported',provenance:{version:'1',manifest_digest:'a'.repeat(64),content_digest:'b'.repeat(64),verified_at_ms:1,expires_at_ms:1000,revision:1},entries:[{id:'one',text:'private other repo'}]};
  expect(await handleLocalSourceCommand(['inspect','notes','--repo',root,'--default-tenant'],{rpc:async()=>raw,stdout:value=>{text+=value;},stderr:value=>{error+=value;}})).toBe(1);
  expect(text).toBe('');expect(error).toBe('source_observation_unknown\n');
});

```
