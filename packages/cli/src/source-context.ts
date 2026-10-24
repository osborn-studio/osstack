import { join } from 'node:path';
import { z } from 'zod';
import { executionContextDigest, type ExecutionContextEntry, type ExecutionContextSource } from '@osstack/knowledge';
import type { ExecutionContextLoader } from './execution-context.js';
import { createHostSourceObservationService, readPrivateSourcePolicy, type HostSourceObservationService } from './source-observation-host.js';
const SourceContextPolicy=z.object({schema_version:z.literal(1),repo_path:z.string().max(4096),default_tenant:z.literal(true),source_ids:z.array(z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)).min(1).max(4),max_bytes:z.number().int().min(1).max(8192)}).strict().refine(v=>new Set(v.source_ids).size===v.source_ids.length);
interface Binding {policy_digest:string;source_id:string;generation:string;revision:number;record_revision:number;manifest_digest:string;content_digest:string}
/** Explicit host opt-in, never inferred from a repository pack or source registration. */
export function createHostSourceContext(home:string,service:HostSourceObservationService=createHostSourceObservationService(home)){
 const policyPath=join(home,'source-context.json');
 const load:ExecutionContextLoader=async(_task,{workspacePath,signal})=>{
  const file=await readPrivateSourcePolicy(policyPath);if(!file)return [];const policy=SourceContextPolicy.parse(file.value);if(policy.repo_path!==workspacePath)throw Error('source_context_scope_mismatch');
  const entries:ExecutionContextEntry[]=[];let bytes=0;
  for(const id of policy.source_ids){if(signal.aborted)throw Error('source_cancelled');const {snapshot,observation}=await service.observe({repo_path:workspacePath,source_id:id,default_tenant:true},signal);if(snapshot.state!=='ready'||!observation||observation.state!=='ready'||!snapshot.provenance)throw Error('source_context_not_ready');const p=snapshot.provenance;
   const binding:Binding={policy_digest:file.digest,source_id:id,generation:p.version,revision:p.revision,record_revision:observation.record_revision,manifest_digest:p.manifest_digest,content_digest:p.content_digest};
   // One bounded JSON entry per source preserves its complete snapshot; the normal prompt assembler may omit it and records that decision.
   const text=JSON.stringify({source_id:id,generation:p.version,revision:p.revision,entries:snapshot.entries});bytes+=Buffer.byteLength(text);if(bytes>policy.max_bytes)throw Error('source_context_budget_exceeded');
   entries.push({id:`source:${id}`,source_kind:'data_source',source_ref:JSON.stringify(binding),source_digest:p.content_digest,text_sha256:executionContextDigest(text),scope:{repo_path:workspacePath,tenant:'default'},tier:'optional',text,verified_at_ms:p.verified_at_ms,expires_at_ms:p.expires_at_ms,evidence_kind:'pinned_local_snapshot'});
  }
  if((await readPrivateSourcePolicy(policyPath))?.digest!==file.digest)throw Error('source_policy_changed');return entries;
 };
 async function validate(entries:readonly ExecutionContextSource[],signal:AbortSignal){
  for(const entry of entries.filter(e=>e.source_kind==='data_source')){const binding=JSON.parse(entry.source_ref) as Binding;const file=await readPrivateSourcePolicy(policyPath);if(!file||file.digest!==binding.policy_digest)throw Error('source_policy_changed');const policy=SourceContextPolicy.parse(file.value);if(policy.repo_path!==entry.scope.repo_path||!policy.source_ids.includes(binding.source_id))throw Error('source_context_scope_mismatch');
   const scope={repo_path:entry.scope.repo_path,source_id:binding.source_id,default_tenant:true as const};const {snapshot,observation:current}=await service.observe(scope,signal);const p=snapshot.provenance;
   if(signal.aborted||snapshot.state!=='ready'||!p||p.version!==binding.generation||p.revision!==binding.revision||p.manifest_digest!==binding.manifest_digest||p.content_digest!==binding.content_digest||current?.state!=='ready'||current.record_revision!==binding.record_revision)throw Error('source_context_changed_before_invoke');
   if((await readPrivateSourcePolicy(policyPath))?.digest!==binding.policy_digest)throw Error('source_policy_changed');
  }
 }
 return {load,validate};
}
