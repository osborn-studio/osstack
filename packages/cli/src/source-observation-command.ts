import { writePresentationText } from './worker-presentation.js';
import { realpath } from 'node:fs/promises';
import { z } from 'zod';
import { SourceObservationScopeSchema, SourceSnapshotEvidenceSchema } from '@osstack/core';
import { serializeLocalSource } from './local-data-source-registry.js';
import type { HostSourceObservationService } from './source-observation-host.js';
const revision=z.number().int().nonnegative().safe();
const Observation=z.object({scope:SourceObservationScopeSchema,record_revision:revision,state:z.enum(['ready','gap','unknown']),reason:z.string().max(64).nullable(),accepted:SourceSnapshotEvidenceSchema,proposed:SourceSnapshotEvidenceSchema.nullable(),updated_at_ms:revision}).strict();
export const SourceObserveParams=SourceObservationScopeSchema;
export const SourceEventsParams=SourceObservationScopeSchema.extend({after_sequence:revision.default(0),limit:z.number().int().min(1).max(4).default(4)}).strict();
export const SourceAcknowledgeParams=SourceObservationScopeSchema.extend({grant_id:z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/)}).strict();
export type SourceObservationMethod='source.observe'|'source.events'|'source.acknowledge';
const Event=Observation.extend({sequence:revision,transition:z.string().max(64),clock_reset:z.object({old_high_water_ms:revision,new_time_ms:revision,grant_digest:z.string().regex(/^[a-f0-9]{64}$/),not_before_ms:revision,expires_at_ms:revision,prior_reason:z.string().max(64).nullable()}).strict().optional()}).strict();
const Response=z.object({schema_version:z.literal(1),scope:SourceObservationScopeSchema,observation:Observation.nullable(),clock:z.object({high_water_ms:revision,current_time_ms:revision}).strict().optional(),snapshot_state:z.string().max(32).optional(),snapshot_reason:z.string().max(64).nullable().optional(),history_gap:z.boolean().optional(),events:z.array(Event).max(4).optional(),next_sequence:revision.optional(),has_more:z.boolean().optional()}).strict();
/** Caller supplies the authenticated host service; request data cannot supply a snapshot or approval. */
export async function handleSourceObservationRpc(method:SourceObservationMethod,input:unknown,service:HostSourceObservationService,signal?:AbortSignal){
 const schema=method==='source.observe'?SourceObserveParams:method==='source.events'?SourceEventsParams:SourceAcknowledgeParams;
 if(!schema.safeParse(input).success)throw Error('invalid_request');
 let output:unknown;
 if(method==='source.observe'){const scope=SourceObserveParams.parse(input);const result=await service.observe(scope,signal);output={schema_version:1,scope,observation:result.observation,snapshot_state:result.snapshot.state,snapshot_reason:result.snapshot.reason};}
 else if(method==='source.events'){const {after_sequence,limit,...scope}=SourceEventsParams.parse(input);const result=service.events(scope,after_sequence,limit);output={schema_version:1,scope,observation:result.checkpoint,clock:result.clock,history_gap:result.history_gap,events:result.events,next_sequence:result.next_sequence,has_more:result.has_more};}
 else if(method==='source.acknowledge'){const {grant_id,...scope}=SourceAcknowledgeParams.parse(input);output={schema_version:1,scope,observation:await service.acknowledge(scope,grant_id,signal)};}else throw Error('source_method_unsupported');
 const parsed=Response.parse(output);if(Buffer.byteLength(serializeLocalSource(parsed))>65535)throw Error('source_response_too_large');return parsed;
}
export const SOURCE_OBSERVATION_HELP='sources observe|events|acknowledge SOURCE_ID --repo ABSOLUTE_PATH --default-tenant [--after SEQUENCE] [--grant GRANT_ID] [--json]\nObserve persists sequence evidence; events reads its bounded journal. Acknowledge requires an exact private host grant. Events reports clock high-water; a short-lived clock_reset grant quarantines other streams while recovering the approved source. Clock recovery requires a fresh registered snapshot for an existing stream; source-context dispatch and acknowledgement require an OSSTACK_HOME path with no symlink components (use its resolved path). Observe/status/events do not enforce this canonical-path rule.\n';
export async function handleSourceObservationCommand(args:string[],deps:{rpc:(method:SourceObservationMethod,params:unknown,timeoutMs:number,signal:AbortSignal)=>Promise<unknown>;stdout?:(text:string)=>void;stderr?:(text:string)=>void}):Promise<number>{
 const out=async(s:string)=>{if(deps.stdout){deps.stdout(s);return;}const cancel=new AbortController();const timer=setTimeout(()=>cancel.abort(),1000);try{await writePresentationText(process.stdout,s,cancel.signal);}finally{clearTimeout(timer);}};const err=deps.stderr??(s=>{process.stderr.write(s);});
 if(args.length===0||args.includes('--help')){try{await out(SOURCE_OBSERVATION_HELP);return 0;}catch{return 1;}}
 const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),2000);
 try{const action=args[0];if(!['observe','events','acknowledge'].includes(action??'')||args.length>11)throw Error();const flags=new Map<string,string|true>();for(let i=2;i<args.length;i++){const flag=args[i]!;if(flags.has(flag))throw Error();if(flag==='--default-tenant'||flag==='--json'){flags.set(flag,true);continue;}if(!['--repo','--after','--grant'].includes(flag))throw Error();const value=args[++i];if(!value||value.length>4096||value.startsWith('--'))throw Error();flags.set(flag,value);}
  const scope=SourceObservationScopeSchema.parse({repo_path:flags.get('--repo'),source_id:args[1],default_tenant:flags.get('--default-tenant')});scope.repo_path=await realpath(scope.repo_path);let params:unknown=scope;
  if(action==='events'){if(flags.has('--grant'))throw Error();const after=flags.get('--after')??'0';if(typeof after!=='string'||!/^\d{1,16}$/.test(after))throw Error();params=SourceEventsParams.parse({...scope,after_sequence:Number(after)});}else if(action==='acknowledge'){if(flags.has('--after'))throw Error();params=SourceAcknowledgeParams.parse({...scope,grant_id:flags.get('--grant')});}else if(flags.has('--after')||flags.has('--grant'))throw Error();
  if(controller.signal.aborted)throw Error();const method=`source.${action}` as SourceObservationMethod;const raw=await new Promise<unknown>((resolve,reject)=>{const abort=()=>reject(Error("source_timeout"));controller.signal.addEventListener("abort",abort,{once:true});Promise.resolve().then(()=>deps.rpc(method,params,2000,controller.signal)).then(resolve,reject).finally(()=>controller.signal.removeEventListener("abort",abort));if(controller.signal.aborted)abort();});if(controller.signal.aborted||Buffer.byteLength(serializeLocalSource(raw))>65535)throw Error();const result=Response.parse(raw);if(JSON.stringify(result.scope)!==JSON.stringify(scope))throw Error();await out(serializeLocalSource(result)+'\n');return action==='events'||result.observation?.state==='ready'?0:1;
 }catch{err('source_observation_unknown\n');return 1;}finally{clearTimeout(timer);}
}
