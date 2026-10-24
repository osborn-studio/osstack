import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { readSourceContextFile } from './source-context-fence.js';
import { assertDbAccessAllowed } from './control-plane-guard.js';
import { assertManagedHomeMarker } from './managed-home-guard.js';
import { assertSingleSqliteFiles } from './sqlite-file-guard.js';
import { VERSION, PROTOCOL_VERSION } from './version.js';
import Database from 'better-sqlite3';
import { CURRENT_SCHEMA_VERSION, SourceObservationLedger, SourceObservationScopeSchema, type SourceObservationScope, type SourceSnapshotEvidence } from '@osstack/core';
import { z } from 'zod';
import { createHostLocalDataSourceService, type LocalSourceInspectResult } from './local-data-source-registry.js';
export async function readPrivateSourcePolicy(path:string,maximum=32768):Promise<{value:unknown;digest:string}|null>{
 try{const bytes=readSourceContextFile(path,maximum,true);return {value:JSON.parse(bytes.toString()),digest:createHash('sha256').update(bytes).digest('hex')};}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw Error('source_policy_unavailable');}
}
function hostScope(home:string,input:unknown):SourceObservationScope{
 const scope=SourceObservationScopeSchema.parse(input);const repo=realpathSync(scope.repo_path),canonicalHome=realpathSync(home);if(repo!==scope.repo_path)throw Error('source_scope_not_canonical');const r=relative(repo,canonicalHome);if(r===''||(!isAbsolute(r)&&r!=='..'&&!r.startsWith(`..${sep}`)))throw Error('source_host_inside_repository');return scope;
}
export function sourceSnapshotEvidence(snapshot:LocalSourceInspectResult):SourceSnapshotEvidence{if(snapshot.state!=='ready'||!snapshot.provenance)throw Error('source_snapshot_unavailable');const p=snapshot.provenance;return {generation:p.version,revision:p.revision,manifest_digest:p.manifest_digest,content_digest:p.content_digest,verified_at_ms:p.verified_at_ms,expires_at_ms:p.expires_at_ms};}
const GrantSchema=z.object({id:z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),scope:SourceObservationScopeSchema,generation:z.string().max(64),revision:z.number().int().nonnegative().safe(),content_digest:z.string().regex(/^[a-f0-9]{64}$/),manifest_digest:z.string().regex(/^[a-f0-9]{64}$/),expected_record_revision:z.number().int().positive().safe(),clock_reset:z.object({expected_high_water_ms:z.number().int().nonnegative().safe(),not_before_ms:z.number().int().nonnegative().safe(),expires_at_ms:z.number().int().nonnegative().safe()}).strict().refine(v=>v.expires_at_ms>v.not_before_ms&&v.expires_at_ms-v.not_before_ms<=60000).optional(),expires_at_ms:z.number().int().nonnegative().safe()}).strict();
const GrantsSchema=z.object({schema_version:z.literal(1),grants:z.array(GrantSchema).max(32)}).strict().refine(v=>new Set(v.grants.map(g=>g.id)).size===v.grants.length);
/** Short-lived existing-DB connections. Construction never opens or migrates a database. */
export function createHostSourceObservationService(home:string,options:{nowMs?:()=>number}={}){
 const now=options.nowMs??Date.now;const inspector=createHostLocalDataSourceService({configPath:join(home,'source-registry.json'),nowMs:now});
 function ledger<T>(fn:(store:SourceObservationLedger)=>T,readonly=false):T{if(!isAbsolute(home))throw Error('source_home_required');const canonicalPath=join(realpathSync(home),'state.db');assertSingleSqliteFiles(canonicalPath);assertDbAccessAllowed({checkoutRoot:dirname(realpathSync(fileURLToPath(import.meta.url))),osstackHome:home});assertManagedHomeMarker(home,process.argv[1],{version:VERSION,protocol_version:PROTOCOL_VERSION,database_schema:CURRENT_SCHEMA_VERSION});const db=new Database(canonicalPath,{fileMustExist:true,readonly,timeout:readonly?0:1000});try{const schema=db.pragma('user_version',{simple:true}) as number;if(schema<46||schema>CURRENT_SCHEMA_VERSION)throw Error('source_ledger_migration_required');db.pragma('foreign_keys=ON');return fn(new SourceObservationLedger(db,canonicalPath,now));}finally{db.close();}}
 async function fresh(input:unknown,signal?:AbortSignal){const scope=hostScope(home,input);const snapshot=await inspector.inspect(scope,signal);if(signal?.aborted)throw Error('source_cancelled');return {scope,snapshot};}
 return {
  inspect:inspector.inspect,
  assertClockFresh(){ledger(store=>store.assertClockFresh(),true);},
  // Only admission refusal is ephemeral; lost freshness/authority quarantines accepted continuity until an exact acknowledgement.
  async observe(input:unknown,signal?:AbortSignal){const {scope,snapshot}=await fresh(input,signal);if(snapshot.reason==='busy'||snapshot.reason==='cancelled')throw Error('source_observation_not_admitted');const observation=ledger(store=>snapshot.state==='ready'?store.observe(scope,sourceSnapshotEvidence(snapshot)):store.unavailable(scope,snapshot.reason??'source_unavailable'));return {snapshot,observation};},
  status(input:unknown){const scope=hostScope(home,input);return ledger(store=>store.status(scope),true);},
  events(input:unknown,after=0,limit=100){const scope=hostScope(home,input);return ledger(store=>({...store.events(scope,after,limit),clock:store.clockStatus()}),true);},
  async acknowledge(input:unknown,grantId:string,signal?:AbortSignal){const {scope,snapshot}=await fresh(input,signal);const evidence=sourceSnapshotEvidence(snapshot);const path=join(home,'source-acknowledgements.json');const policy=await readPrivateSourcePolicy(path);if(!policy)throw Error('source_acknowledgement_required');const grant=GrantsSchema.parse(policy.value).grants.find(g=>g.id===grantId);if(!grant||JSON.stringify(grant.scope)!==JSON.stringify(scope)||grant.generation!==evidence.generation||grant.revision!==evidence.revision||grant.manifest_digest!==evidence.manifest_digest||grant.content_digest!==evidence.content_digest||grant.expires_at_ms<=now())throw Error('source_acknowledgement_mismatch');const refreshed=await inspector.inspect(scope,signal);if(JSON.stringify(sourceSnapshotEvidence(refreshed))!==JSON.stringify(evidence))throw Error('source_snapshot_changed');const after=await readPrivateSourcePolicy(path);if(signal?.aborted||after?.digest!==policy.digest||grant.expires_at_ms<=now())throw Error('source_policy_changed');return ledger(store=>store.acknowledge(scope,evidence,grant.expected_record_revision,grant.content_digest,grant.clock_reset?{...grant.clock_reset,grant_digest:createHash('sha256').update(JSON.stringify(grant)).digest('hex')}:undefined));},
 };
}
export type HostSourceObservationService=ReturnType<typeof createHostSourceObservationService>;
export type { SourceObservationScope };
