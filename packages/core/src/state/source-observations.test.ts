import { realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createScratchDirSync } from '../scratch.js';
import { openDb } from './db.js';
import { SourceObservationLedger } from './source-observations.js';
const cleanup:Array<()=>void>=[];afterEach(()=>{for(const f of cleanup.splice(0).reverse())f();});
function fixture(){const root=realpathSync(createScratchDirSync('tests','source-ledger'));const path=join(root,'state.db');const db=openDb({path});cleanup.push(()=>{db.close();rmSync(root,{recursive:true,force:true});});let now=100;const ledger=new SourceObservationLedger(db,path,()=>now);const scope={repo_path:root,source_id:'calendar',default_tenant:true as const};const evidence={generation:'v1',revision:0,manifest_digest:'a'.repeat(64),content_digest:'b'.repeat(64),verified_at_ms:50,expires_at_ms:9999};return {root,path,db,ledger,scope,evidence,setNow:(n:number)=>{now=n;}};}
it('persists sequence gaps across connections and requires exact fresh snapshot approval',()=>{const f=fixture();expect(f.ledger.observe(f.scope,f.evidence).state).toBe('ready');const jump={...f.evidence,revision:3,content_digest:'c'.repeat(64)};const gap=f.ledger.observe(f.scope,jump);expect(gap).toMatchObject({state:'gap',record_revision:2});const db=openDb({path:f.path});try{const again=new SourceObservationLedger(db,f.path,()=>101);expect(again.observe(f.scope,jump)).toEqual(gap);expect(()=>again.acknowledge(f.scope,jump,1,jump.content_digest)).toThrow('source_revision_conflict');expect(()=>again.acknowledge(f.scope,jump,2,f.evidence.content_digest)).toThrow('source_acknowledgement_mismatch');expect(again.acknowledge(f.scope,jump,2,jump.content_digest)).toMatchObject({state:'ready',record_revision:3,accepted:{revision:3}});}finally{db.close();}expect(f.ledger.events(f.scope).events.map(e=>e.transition)).toEqual(['snapshot_baseline','snapshot_quarantined','snapshot_acknowledged']);});
it('quarantines generation changes and prevents resurrection of a retired generation',()=>{const f=fixture();f.ledger.observe(f.scope,f.evidence);const next={...f.evidence,generation:'v2'};expect(f.ledger.observe(f.scope,next).reason).toBe('generation_changed');f.ledger.acknowledge(f.scope,next,2,next.content_digest);expect(f.ledger.observe(f.scope,f.evidence).reason).toBe('retired_generation');expect(()=>f.ledger.acknowledge(f.scope,f.evidence,4,f.evidence.content_digest)).toThrow('source_retired_generation');});
it('rejects same-revision changed contents and cannot acknowledge a revision rollback',()=>{const f=fixture();f.ledger.observe(f.scope,{...f.evidence,revision:2});expect(f.ledger.observe(f.scope,{...f.evidence,revision:2,content_digest:'c'.repeat(64)}).reason).toBe('revision_conflict');expect(()=>f.ledger.acknowledge(f.scope,f.evidence,2,f.evidence.content_digest)).toThrow('source_revision_regression');});
it('persists unavailable state and monotonic clock across restarts without silently clearing quarantine',()=>{const f=fixture();f.ledger.observe(f.scope,f.evidence);f.ledger.unavailable(f.scope,'content_pin_mismatch');expect(f.ledger.observe(f.scope,f.evidence).state).toBe('unknown');f.setNow(99);expect(()=>f.ledger.observe(f.scope,f.evidence)).toThrow('source_clock_regression');const other=new SourceObservationLedger(f.db,f.path,()=>99);expect(()=>other.unavailable(f.scope,'source_unavailable')).toThrow('source_clock_regression');});
it('retains bounded metadata events, reports history gaps and never implies a missing cursor is current',()=>{const f=fixture();for(let revision=0;revision<505;revision++)f.ledger.observe(f.scope,{...f.evidence,revision});const page=f.ledger.events(f.scope,0,100);expect(page.history_gap).toBe(true);expect(page.events[0]!.sequence).toBe(6);expect(page.events).toHaveLength(100);expect(page.has_more).toBe(true);expect(()=>f.ledger.events(f.scope,506)).toThrow('source_cursor_ahead');expect(f.db.prepare('SELECT count(*) AS n FROM source_observation_events').get()).toEqual({n:500});});

it('keeps restored identical evidence quarantined, deduplicates repolls and permits explicit acknowledgement',()=>{
 const f=fixture();f.ledger.observe(f.scope,f.evidence);
 f.ledger.unavailable(f.scope,'read_timeout');
 const restored=f.ledger.observe(f.scope,f.evidence);
 expect(restored).toMatchObject({state:'unknown',reason:'read_timeout',record_revision:2,proposed:null});
 for(let i=0;i<5;i++)expect(f.ledger.observe(f.scope,f.evidence)).toEqual(restored);
 expect(f.ledger.events(f.scope).events.map(event=>event.transition)).toEqual(['snapshot_baseline','source_unavailable']);
 expect(f.ledger.acknowledge(f.scope,f.evidence,restored.record_revision,f.evidence.content_digest)).toMatchObject({state:'ready',record_revision:3,proposed:null});
});
it('recovers writes after wall time catches up without database editing or extending stale evidence trust',()=>{
 const f=fixture();f.ledger.observe(f.scope,f.evidence);f.setNow(99);
 expect(()=>f.ledger.observe(f.scope,f.evidence)).toThrow('source_clock_regression');
 expect(f.ledger.status(f.scope)?.record_revision).toBe(1);
 f.setNow(100);expect(f.ledger.observe(f.scope,f.evidence).state).toBe('ready');
 f.setNow(f.evidence.expires_at_ms);expect(()=>f.ledger.observe(f.scope,f.evidence)).toThrow('source_evidence_not_fresh');
});

it('corrects a forward-excursion clock only with exact short-lived authority and quarantines every other stream',()=>{
 const f=fixture(),other={...f.scope,source_id:'other'};f.ledger.observe(f.scope,f.evidence);f.ledger.observe(other,f.evidence);
 f.setNow(1_000_000);f.ledger.unavailable(f.scope,'invalid_clock');f.setNow(100);
 const reset={grant_digest:'a'.repeat(64),expected_high_water_ms:1_000_000,not_before_ms:90,expires_at_ms:200};
 expect(()=>f.ledger.assertClockFresh()).toThrow('source_clock_regression');
 expect(()=>f.ledger.acknowledge(f.scope,f.evidence,2,f.evidence.content_digest)).toThrow('source_clock_regression');
 expect(()=>f.ledger.acknowledge(f.scope,f.evidence,1,f.evidence.content_digest,reset)).toThrow('source_revision_conflict');
 expect(()=>f.ledger.assertClockFresh()).toThrow('source_clock_regression');expect(f.ledger.status(other)?.record_revision).toBe(1);
 const restored=f.ledger.acknowledge(f.scope,f.evidence,2,f.evidence.content_digest,reset);
 expect(restored).toMatchObject({state:'ready',record_revision:4});expect(()=>f.ledger.assertClockFresh()).not.toThrow();
 expect(f.ledger.status(other)).toMatchObject({state:'unknown',reason:'clock_reset',record_revision:2});
 expect(f.ledger.events(f.scope).events.map(e=>e.transition)).toEqual(['snapshot_baseline','source_unavailable','clock_reset','snapshot_acknowledged']);
 expect(()=>f.ledger.acknowledge(other,f.evidence,1,f.evidence.content_digest)).toThrow('source_revision_conflict');
 expect(()=>f.ledger.acknowledge(f.scope,f.evidence,2,f.evidence.content_digest,reset)).toThrow('source_clock_reset_mismatch');
});
it('rolls back reset clock and every stream event if any quarantine write fails',()=>{
 const f=fixture(),other={...f.scope,source_id:'other'};f.ledger.observe(f.scope,f.evidence);f.ledger.observe(other,f.evidence);
 f.setNow(1_000_000);f.ledger.unavailable(f.scope,'invalid_clock');f.setNow(100);
 f.db.exec("CREATE TRIGGER reject_clock_reset BEFORE INSERT ON source_observation_events WHEN json_extract(NEW.event_json,'$.scope.source_id')='other' BEGIN SELECT RAISE(ABORT,'fault'); END");
 expect(()=>f.ledger.acknowledge(f.scope,f.evidence,2,f.evidence.content_digest,{grant_digest:'a'.repeat(64),expected_high_water_ms:1_000_000,not_before_ms:90,expires_at_ms:200})).toThrow('fault');
 expect(()=>f.ledger.assertClockFresh()).toThrow('source_clock_regression');expect(f.ledger.status(f.scope)?.record_revision).toBe(2);expect(f.ledger.status(other)?.record_revision).toBe(1);
});

it('does not poison an empty ledger clock when the first unavailable observation occurs during a forward excursion',()=>{
 const f=fixture();f.setNow(1_000_000);expect(f.ledger.unavailable(f.scope,'source_unavailable')).toBeNull();
 expect(f.ledger.clockStatus().high_water_ms).toBe(0);
 f.setNow(100);expect(f.ledger.observe(f.scope,f.evidence)).toMatchObject({state:'ready',record_revision:1});
});

it('records an actual proposed-to-accepted return once without keeping identical proposed evidence',()=>{
 const f=fixture();f.ledger.observe(f.scope,f.evidence);f.ledger.observe(f.scope,{...f.evidence,revision:3});
 const restored=f.ledger.observe(f.scope,f.evidence);expect(restored).toMatchObject({state:'gap',proposed:null,record_revision:3});
 expect(f.ledger.observe(f.scope,f.evidence)).toEqual(restored);
 expect(f.ledger.events(f.scope).events.at(-1)?.transition).toBe('snapshot_returned_to_accepted');
});
it('retains exact clock-reset authority audit beyond ordinary event pruning and exposes history gaps',()=>{
 const f=fixture();f.ledger.observe(f.scope,f.evidence);f.setNow(1_000_000);f.ledger.unavailable(f.scope,'invalid_clock');f.setNow(100);
 f.ledger.acknowledge(f.scope,f.evidence,2,f.evidence.content_digest,{grant_digest:'a'.repeat(64),expected_high_water_ms:1_000_000,not_before_ms:90,expires_at_ms:200});
 for(let revision=1;revision<=505;revision++)f.ledger.observe(f.scope,{...f.evidence,revision});
 const page=f.ledger.events(f.scope,0,100);expect(page.history_gap).toBe(true);
 const audit=f.db.prepare("SELECT event_json FROM source_observation_events WHERE json_extract(event_json,'$.transition')='clock_reset'").get() as {event_json:string};
 expect(JSON.parse(audit.event_json).clock_reset).toEqual({old_high_water_ms:1_000_000,new_time_ms:100,grant_digest:'a'.repeat(64),not_before_ms:90,expires_at_ms:200,prior_reason:'invalid_clock'});
 expect(page.events[0]?.transition).toBe('clock_reset');expect(f.ledger.events(f.scope,2,4).history_gap).toBe(true);
});
