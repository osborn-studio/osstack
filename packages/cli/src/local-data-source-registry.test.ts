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
it('keeps a dangling registered alias unregistered when ownership cannot be established',async()=>{
  const f=fixture();const alias=join(f.root,'dangling-repo');const registration=f.config.registrations[0]!;registration.manifest.repo_path=alias;registration.manifest_digest=localSourceManifestDigest(registration.manifest);f.save();
  expect(await createHostLocalDataSourceService({configPath:f.configPath,nowMs:()=>2000}).inspect(f.params)).toMatchObject({state:'not_registered',reason:'not_registered',entries:[]});
});
it('labels early disabled scope as the unverified request and includes no data authority',async()=>{
  const f=fixture();const alias=join(f.root,'repo-alias');symlinkSync(f.repo,alias);rmSync(f.configPath);
  expect(await createHostLocalDataSourceService({configPath:f.configPath}).inspect({...f.params,repo_path:alias})).toMatchObject({state:'disabled',scope:{repo_path:alias,tenant:'default'},qualification:'unqualified',provenance:null,entries:[]});
});
