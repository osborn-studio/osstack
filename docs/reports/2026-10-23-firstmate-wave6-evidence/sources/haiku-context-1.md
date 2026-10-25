Independent security/reliability audit, no tools. Return concise JSON confirmed P0/P1/P2 findings with concrete counterexamples, verdict, limitations. This is R3a host-registered readonly local snapshot registry. Host fixes configPath to OSSTACK_HOME/source-registry.json, never from repo/request. Parent will wire daemon source.inspect and sources inspect command; this branch intentionally no central wiring. Config private same UID strict pinned manifest/content, source root explicit host grant. No shell/network/model/plugin code/action/context injection. Bounds/timeout actual slots retained, late revoke recheck. Review actual bypass/TOCTOU/resource issues, no theoretical malicious trusted host DI. Existing worker output helper already audited and used for default stdout. Tests claimed separately, you must not claim runtime checks.

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
      const request={...params,repo_path:repo};const registration=config.registrations.find(row=>row.manifest.id===params.source_id&&row.manifest.repo_path===repo);
      if(!registration)return empty(request,"not_registered","not_registered");
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
  const service=createHostLocalDataSourceService({configPath:f.configPath,nowMs:()=>2000});let text='';const rpc=vi.fn(async(_method,params,_timeout,signal)=>service.inspect(params,signal));
  expect(await handleLocalSourceCommand(['inspect','notes','--repo',f.repo,'--default-tenant','--json'],{rpc,stdout:value=>{text+=value;}})).toBe(0);
  expect(rpc.mock.calls[0]![0]).toBe('source.inspect');expect(text).not.toContain(String.fromCharCode(27));expect(text).not.toContain(String.fromCharCode(0x202e));expect(JSON.parse(text).actions).toBe('unsupported');
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

```

## packages/cli/src/local-source-command.ts
```
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
      Promise.resolve().then(()=>deps.rpc("source.inspect",params,1500,controller.signal)).then(resolve,reject).finally(()=>controller.signal.removeEventListener("abort",abort));
    });
    if(Buffer.byteLength(serializeLocalSource(raw))>65535)throw new Error();
    const response=LocalSourceInspectResultSchema.parse(raw);if(response.source_id!==params.source_id)throw new Error();
    const text=json?serializeLocalSource(response):`Local source ${response.source_id}: ${response.state}; qualification=${response.qualification}; actions=unsupported\n${serializeLocalSource(response)}`;
    if(Buffer.byteLength(text)>65535)throw new Error();await out(`${text}\n`);return response.state==="ready"?0:1;
  }catch{err("source_observation_unknown\n");return 1;}
  finally{clearTimeout(timer);}
}

```

## packages/cli/src/local-source-command.test.ts
```
import { expect, it, vi } from "vitest";
import { handleLocalSourceCommand } from "./local-source-command.js";
it('rejects request-selected paths or actions before any RPC',async()=>{
  const rpc=vi.fn(async()=>({}));for(const args of [['inspect','notes','--repo','/repo'],['inspect','notes','--repo','/repo','--default-tenant','--file','secret'],['execute','notes','--repo','/repo','--default-tenant']])expect(await handleLocalSourceCommand(args,{rpc,stderr:()=>{}})).toBe(1);
  expect(rpc).not.toHaveBeenCalled();
});
it('reports unavailable registration as unknown with no raw transport error',async()=>{
  let text='';expect(await handleLocalSourceCommand(['inspect','notes','--repo','/repo','--default-tenant'],{rpc:async()=>{throw Error('secret credential');},stderr:value=>{text+=value;}})).toBe(1);expect(text).toBe('source_observation_unknown\n');
});

it('locally bounds a hung RPC without echoing malformed responses',async()=>{
  vi.useFakeTimers();let text='';let signal:AbortSignal|undefined;
  const result=handleLocalSourceCommand(['inspect','notes','--repo','/repo','--default-tenant'],{rpc:async(_method,_params,_timeout,readSignal)=>{signal=readSignal;return new Promise(()=>{});},stderr:value=>{text+=value;}});
  await vi.advanceTimersByTimeAsync(1500);expect(await result).toBe(1);expect(signal?.aborted).toBe(true);expect(text).toBe('source_observation_unknown\n');vi.useRealTimers();
});

```

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

```

## docs/guides/local-data-source-registry.md
```
# Host-registered local data sources

## Slice contract (R3a)

The host explicitly registers a typed local JSON snapshot reader. Registration is
not discovered from repository content or accepted from an inspect request.
Default registration is empty. No plugin code, shell, network, dynamic imports,
credentials, action grants, source-ledger writes, task completion or publication.

A registration binds a canonical repository/default tenant, an explicit source
root, one relative regular file, a strict versioned manifest, independently pinned
manifest and content SHA-256 values, fixed `snapshot.read` capability, maximum
bytes/items/read time, and host verification/expiry times. Canonical manifest
hashing has fixed field order. Content pin changes require host re-registration.
The root and path are private host configuration; responses expose only source ID,
version, manifest/content digest, and bounded typed data.

Snapshots use schema version 1 with source ID, version, a monotonically comparable
nonnegative revision, and unique `{id,text}` entries. Unknown fields, oversize,
identity mismatch, changed file, symlink escape, pin mismatch, stale/expired
registration, clock rollback or unsupported protocol fail closed. Content is
untrusted reference data; text never becomes instructions or authority. This
snapshot-only protocol has no event cursor: gaps/event replay are unsupported,
not silently converted to completion.

Limits: at most 32 registrations, 2 actual reads concurrently, 65536 source bytes,
20 entries, 1000ms local read deadline. Timed-out work retains its actual read slot
until underlying filesystem work settles; late results cannot be returned. Reads
use regular-file checks, no-follow/nonblocking open, bounded allocation, and
before/after file identity checks. Cancellation stops observation, never a worker.

Implementation order: strict schemas and digest; pinned local reader; registry
scope/expiry/budgets; inspect CLI handler; real-file integration and hostile input
regressions; isolated Haiku audit. No migration or central entrypoint edits.

Acceptance counterexamples include default-none, other repo/tenant, changed pin,
manifest expansion, malformed/oversize/duplicate data, symlink escape, stale and
future host verification, abort/timeouts with retained slots, output injection,
and an inspect request attempting to add file/shell/credentials. A source receipt
is neither evidence of worker completion nor proof of semantic correctness.

The existing execution-context loader accepts pinned knowledge-pack evidence;
this slice does not reclassify arbitrary local JSON as that evidence or inject it
automatically. A separate explicitly qualified adapter is pending. Parent wiring
owns the real daemon method and command dispatch.

## Host integration and configuration

Create one long-lived `createHostLocalDataSourceService({configPath})` per daemon,
with the fixed `OSSTACK_HOME/source-registry.json` path. Do not allow the request
to select this file, and do not recreate the service per request (its actual-read
slots must survive logical timeouts). `inspect(input, signal?)` accepts only
`{source_id,repo_path,default_tenant:true}` and returns a strict bounded result.
`loadHostLocalSources(configPath)` is the host-only configuration reader; the
service imposes the overall deadline. Missing configuration is `disabled`;
malformed, wrong-owner, symlink or group/other-readable configuration is `unknown`.
Both contain no entries. An explicit empty registration array is `not_registered`.

The file is a same-owner private regular file (for example mode 0600), at most
128 KiB, with `{schema_version:1,registrations:[...]}`. Each registration has
`source_root`, `manifest`, `manifest_digest`, and `content_digest`. The latter is
SHA-256 of exact source file bytes. Compute `manifest_digest` with
`localSourceManifestDigest(manifest)` after explicitly reviewing the manifest;
the manifest does not self-authorize. Every inspect reloads the configuration and
checks its bytes and file identity again after reading content. Revocation and
changes during a read return unknown. There is no automatic install or repinning.

Manifest fields: `schema_version:1`, a lowercase `id`, `version`,
`protocol:"local_json_snapshot_v1"`, canonical `repo_path`, `default_tenant:true`,
`capabilities:["snapshot.read"]`, relative `file`, `max_bytes` (1..65536),
`max_items` (1..20), `read_timeout_ms` (10..1000), host `verified_at_ms`,
`expires_at_ms` (after verification, at most seven days), and `fresh_for_ms`
(1..86400000). Freshness derives from this explicit host verification window;
file modification time and payload timestamps cannot refresh trust. Stale and
expired sources return no entries. Text is untrusted even when pins match.

The source JSON contains only `schema_version:1`, `source_id`, matching `version`,
nonnegative integer `revision`, and `entries:[{id,text}]`. Entry IDs must be unique.
Revision is metadata within the pinned snapshot, not a completion event or an
accepted history sequence. Unknown fields are rejected.

Central wiring calls `handleLocalSourceCommand(args,{rpc,stdout?,stderr?})` from
`sources inspect ID --repo ABS --default-tenant [--json]`. The RPC port is fixed
`('source.inspect',params,1500,signal)`; the handler also has a local 1500ms wait
bound. The service enforces its own total 1000ms bound independently. The handler
returns 0 only for a ready integrity-checked snapshot, 1 for unavailable or invalid
observations. This is not a source's semantic accuracy or worker health claim.

```
