import { createHash } from 'node:crypto';
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type Database from 'better-sqlite3';
import { z } from 'zod';
import { withWrite } from './db.js';
const epoch=z.number().int().nonnegative().max(8_640_000_000_000_000);
const digest=z.string().regex(/^[a-f0-9]{64}$/);
export const SourceObservationScopeSchema=z.object({repo_path:z.string().max(4096).refine(isAbsolute),source_id:z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),default_tenant:z.literal(true)}).strict();
export type SourceObservationScope=z.infer<typeof SourceObservationScopeSchema>;
export const SourceSnapshotEvidenceSchema=z.object({generation:z.string().regex(/^[a-zA-Z0-9._-]{1,64}$/),revision:z.number().int().nonnegative().safe(),manifest_digest:digest,content_digest:digest,verified_at_ms:epoch,expires_at_ms:epoch}).strict();
export type SourceSnapshotEvidence=z.infer<typeof SourceSnapshotEvidenceSchema>;
export interface SourceObservation {scope:SourceObservationScope;record_revision:number;state:'ready'|'gap'|'unknown';reason:string|null;accepted:SourceSnapshotEvidence;proposed:SourceSnapshotEvidence|null;updated_at_ms:number}
interface Row {stream_key:string;repo_path:string;source_id:string;record_revision:number;state:SourceObservation['state'];reason:string|null;accepted_json:string;proposed_json:string|null;updated_at_ms:number}
function scope(input:unknown){const value=SourceObservationScopeSchema.parse(input);if(realpathSync(value.repo_path)!==value.repo_path||!statSync(value.repo_path).isDirectory())throw Error('source_scope_not_canonical');return value;}
function key(value:SourceObservationScope){return createHash('sha256').update(JSON.stringify(value)).digest('hex');}
function observation(row:Row):SourceObservation{return {scope:{repo_path:row.repo_path,source_id:row.source_id,default_tenant:true},record_revision:row.record_revision,state:row.state,reason:row.reason,accepted:SourceSnapshotEvidenceSchema.parse(JSON.parse(row.accepted_json)),proposed:row.proposed_json===null?null:SourceSnapshotEvidenceSchema.parse(JSON.parse(row.proposed_json)),updated_at_ms:row.updated_at_ms};}
/** Host-owned DB and migrations. No source reads or network activity happen in this ledger. */
export class SourceObservationLedger {
 constructor(private readonly db:Database.Database,private readonly dbPath:string,private readonly nowMs:()=>number=Date.now){}
 private row(k:string){return this.db.prepare('SELECT * FROM source_observation_streams WHERE stream_key=?').get(k) as Row|undefined;}
 // A backwards wall clock must not extend snapshot trust. Writes resume when
 // epoch time reaches the persisted high-water mark; no DB repair is required.
 private write<T>(fn:(now:number)=>T):T{return withWrite(this.db,this.dbPath,()=>{const now=epoch.parse(this.nowMs());const clock=this.db.prepare('SELECT observed_at_ms FROM source_observation_clock WHERE singleton=1').get() as {observed_at_ms:number};if(now<clock.observed_at_ms)throw Error('source_clock_regression');this.db.prepare('UPDATE source_observation_clock SET observed_at_ms=? WHERE singleton=1').run(now);return fn(now);});}
 private save(k:string,value:SourceObservation,transition:string):SourceObservation{
  if(value.record_revision>=Number.MAX_SAFE_INTEGER-1)throw Error('source_revision_exhausted');
  this.db.prepare(`INSERT INTO source_observation_streams VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(stream_key) DO UPDATE SET record_revision=excluded.record_revision,state=excluded.state,reason=excluded.reason,accepted_json=excluded.accepted_json,proposed_json=excluded.proposed_json,updated_at_ms=excluded.updated_at_ms`).run(k,value.scope.repo_path,value.scope.source_id,value.record_revision,value.state,value.reason,JSON.stringify(value.accepted),value.proposed?JSON.stringify(value.proposed):null,value.updated_at_ms);
  const event={sequence:value.record_revision,transition,...value};this.db.prepare('INSERT INTO source_observation_events VALUES(?,?,?)').run(k,value.record_revision,JSON.stringify(event));this.db.prepare('DELETE FROM source_observation_events WHERE stream_key=? AND sequence<=?').run(k,value.record_revision-500);return value;
 }
 status(input:unknown):SourceObservation|null{const row=this.row(key(scope(input)));return row?observation(row):null;}
 observe(input:unknown,evidenceInput:unknown):SourceObservation{
  const s=scope(input),e=SourceSnapshotEvidenceSchema.parse(evidenceInput),k=key(s);
  return this.write(now=>{if(e.verified_at_ms>now||e.expires_at_ms<=now)throw Error('source_evidence_not_fresh');const row=this.row(k);
   if(!row){if((this.db.prepare('SELECT count(*) AS n FROM source_observation_streams').get() as {n:number}).n>=128)throw Error('source_stream_limit');return this.save(k,{scope:s,record_revision:1,state:'ready',reason:null,accepted:e,proposed:null,updated_at_ms:now},'snapshot_baseline');}
   const old=observation(row);const same=e.generation===old.accepted.generation;let reason:string|null=null;
   if(!same)reason=this.db.prepare('SELECT 1 FROM source_observation_generations WHERE stream_key=? AND generation=?').get(k,e.generation)?'retired_generation':'generation_changed';
   else if(e.revision<old.accepted.revision)reason='revision_regression';else if(e.revision===old.accepted.revision&&e.content_digest!==old.accepted.content_digest)reason='revision_conflict';else if(e.revision>old.accepted.revision+1)reason='sequence_gap';
   // Missing observations break continuity even if the next bytes are identical.
   // Only an exact host acknowledgement clears quarantine; repolls are deduplicated.
   if(old.state!=='ready')reason=old.reason??'reconciliation_required';
   const state=reason?(reason==='sequence_gap'?'gap':'unknown'):'ready';
   if(state===old.state&&reason===old.reason&&JSON.stringify(reason?old.proposed:old.accepted)===JSON.stringify(e))return old;
   return this.save(k,{...old,record_revision:old.record_revision+1,state,reason,accepted:reason?old.accepted:e,proposed:reason?e:null,updated_at_ms:now},reason?'snapshot_quarantined':'snapshot_observed');
  });
 }
 unavailable(input:unknown,reason:string):SourceObservation|null{
  const s=scope(input),k=key(s);if(!/^[a-z_]{1,64}$/.test(reason))throw Error('source_reason_invalid');
  return this.write(now=>{const row=this.row(k);if(!row)return null;const old=observation(row);if(old.state!=='ready')return old;return this.save(k,{...old,record_revision:old.record_revision+1,state:'unknown',reason,proposed:null,updated_at_ms:now},'source_unavailable');});
 }
 /** Call only after the host verifies an exact private operator acknowledgement and freshly reads the pinned snapshot. */
 acknowledge(input:unknown,evidenceInput:unknown,expectedRevision:number,approvedDigest:string):SourceObservation{
  const s=scope(input),e=SourceSnapshotEvidenceSchema.parse(evidenceInput),k=key(s);digest.parse(approvedDigest);if(!Number.isSafeInteger(expectedRevision)||expectedRevision<1)throw Error('source_revision_invalid');
  return this.write(now=>{const row=this.row(k);if(!row||row.record_revision!==expectedRevision)throw Error('source_revision_conflict');const old=observation(row);
   if(e.content_digest!==approvedDigest||e.verified_at_ms>now||e.expires_at_ms<=now)throw Error('source_acknowledgement_mismatch');
   if(e.generation===old.accepted.generation){if(e.revision<old.accepted.revision||(e.revision===old.accepted.revision&&e.content_digest!==old.accepted.content_digest))throw Error('source_revision_regression');}
   else {if(this.db.prepare('SELECT 1 FROM source_observation_generations WHERE stream_key=? AND generation=?').get(k,e.generation))throw Error('source_retired_generation');if((this.db.prepare('SELECT count(*) AS n FROM source_observation_generations WHERE stream_key=?').get(k) as {n:number}).n>=32)throw Error('source_generation_limit');this.db.prepare('INSERT INTO source_observation_generations VALUES(?,?)').run(k,old.accepted.generation);}
   return this.save(k,{...old,record_revision:old.record_revision+1,state:'ready',reason:null,accepted:e,proposed:null,updated_at_ms:now},'snapshot_acknowledged');
  });
 }
 events(input:unknown,after=0,limit=100){const s=scope(input),k=key(s);if(!Number.isSafeInteger(after)||after<0||!Number.isSafeInteger(limit)||limit<1||limit>100)throw Error('source_cursor_invalid');return this.db.transaction(()=>{const row=this.row(k);if(after>(row?.record_revision??0))throw Error('source_cursor_ahead');const first=this.db.prepare('SELECT min(sequence) AS n FROM source_observation_events WHERE stream_key=?').get(k) as {n:number|null};const rows=this.db.prepare('SELECT event_json FROM source_observation_events WHERE stream_key=? AND sequence>? ORDER BY sequence LIMIT ?').all(k,after,limit) as {event_json:string}[];const events=rows.map(r=>JSON.parse(r.event_json) as SourceObservation&{sequence:number;transition:string});return {scope:s,checkpoint:row?observation(row):null,history_gap:first.n!==null&&after<first.n-1,events,next_sequence:events.at(-1)?.sequence??after,has_more:(events.at(-1)?.sequence??after)<(row?.record_revision??0)};})();}
}
