你是严格的 Sonnet 5.5 审计者。只读提供源码，不调用工具。找可证实 P0/P1 并发、scope、身份、source gap、幂等、权限、持久回执的错误；也指出高价值 P2。返回精确路径/触发/修复/测试。当前实验能力 opt-in，未生产启用。不要把独立后续 S3 未实现当缺陷。关注观察模式不冒充执行接管、未知不能自动发送。你未运行测试。不要奉承。

# FILE packages/core/src/state/attention-store.ts
import { createHash, randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import type Database from "better-sqlite3";
import { SessionDecision } from "@osstack/protocol";
import { withWrite } from "./db.js";

export function attentionDigest(value: unknown): string {
  const canonical = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
    if (v !== null && typeof v === "object") return `{${Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}`;
    return JSON.stringify(v);
  };
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export interface AttentionOwner { instance_id: string; generation: number; home_id: string }
export interface AttentionScope {
  scope_id: string; task_id: string; repo_path: string; discovery_after: string;
  scan_complete: number; sampled_at: number; deadline: number; generation: number; error: string | null;
}
export interface AttentionItem {
  item_id: string; scope_id: string; session_id: string; turn_id: string; decision_id: string;
  content_hash: string; decision: SessionDecision; source_version: number; revision: number;
  state: string; created_at: number; updated_at: number; external_message_id: string | null;
}
type ItemRow = Omit<AttentionItem, "decision"> & { decision_json: string };
function parseItem(row: ItemRow): AttentionItem {
  const { decision_json, ...rest } = row;
  return { ...rest, decision: SessionDecision.parse(JSON.parse(decision_json)) };
}
export class AttentionStore {
  constructor(readonly db: Database.Database, readonly path: string) {}
  /** Only called AFTER the daemon's process lock is acquired. Not an executor lease. */
  claimOwner(instanceId: string): AttentionOwner {
    return withWrite(this.db, this.path, () => {
      this.db.prepare(`INSERT INTO daemon_owner(singleton,home_id,instance_id,generation) VALUES(1,?,?,1)
        ON CONFLICT(singleton) DO UPDATE SET instance_id=excluded.instance_id,generation=generation+1`).run(randomUUID(), instanceId);
      return this.db.prepare("SELECT home_id,instance_id,generation FROM daemon_owner WHERE singleton=1").get() as AttentionOwner;
    });
  }
  assertOwner(owner: AttentionOwner): void {
    if (!this.db.prepare("SELECT 1 FROM daemon_owner WHERE singleton=1 AND home_id=? AND instance_id=? AND generation=?")
      .get(owner.home_id, owner.instance_id, owner.generation)) throw new Error("stale_owner");
  }
  write<T>(owner: AttentionOwner, fn: () => T): T {
    return withWrite(this.db, this.path, () => { this.assertOwner(owner); return fn(); });
  }
  registerScope(owner: AttentionOwner, taskId: string, repoPath: string): AttentionScope {
    const canonicalRepo = realpathSync(repoPath);
    if (!statSync(canonicalRepo).isDirectory()) throw new Error("repository_directory_required");
    return this.write(owner, () => {
      if (!this.db.prepare("SELECT 1 FROM tasks WHERE task_id=? AND tenant_id IS NULL").get(taskId)) throw new Error("not_found");
      const scopeId = attentionDigest([owner.home_id, taskId, canonicalRepo]);
      this.db.prepare(`INSERT INTO attention_scopes(scope_id,task_id,repo_path,generation) VALUES(?,?,?,?)
        ON CONFLICT(scope_id) DO NOTHING`).run(scopeId, taskId, canonicalRepo, owner.generation);
      return this.getScope(scopeId)!;
    });
  }
  getScope(scopeId: string): AttentionScope | undefined {
    return this.db.prepare("SELECT * FROM attention_scopes WHERE scope_id=?").get(scopeId) as AttentionScope | undefined;
  }
  listScopes(): AttentionScope[] { return this.db.prepare("SELECT * FROM attention_scopes ORDER BY scope_id").all() as AttentionScope[]; }
  getItem(scopeId: string, itemId: string): AttentionItem | undefined {
    const row = this.db.prepare("SELECT * FROM attention_items WHERE scope_id=? AND item_id=?").get(scopeId, itemId) as ItemRow | undefined;
    return row ? parseItem(row) : undefined;
  }
  listItems(scopeId: string, after = "", limit = 100): AttentionItem[] {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("invalid_limit");
    return (this.db.prepare("SELECT * FROM attention_items WHERE scope_id=? AND item_id>? ORDER BY item_id LIMIT ?")
      .all(scopeId, after, limit) as ItemRow[]).map(parseItem);
  }
  projectDecision(owner: AttentionOwner, input: { scopeId: string; sessionId: string; turnId: string; sourceVersion: number; decision: unknown; now: number }): AttentionItem {
    const decision = SessionDecision.parse(input.decision);
    const contentHash = attentionDigest(decision);
    const itemId = attentionDigest([input.scopeId, input.sessionId, input.turnId, decision.decision_id]);
    if (!Number.isSafeInteger(input.sourceVersion) || input.sourceVersion < 1 || !Number.isFinite(input.now)) throw new Error("invalid_source_version");
    return this.write(owner, () => {
      if (!this.getScope(input.scopeId)) throw new Error("not_found");
      const existing = this.getItem(input.scopeId, itemId);
      if (existing && existing.content_hash !== contentHash) throw new Error("decision_content_conflict");
      if (existing && existing.source_version > input.sourceVersion) throw new Error("stale_source");
      this.db.prepare(`INSERT INTO attention_items(item_id,scope_id,session_id,turn_id,decision_id,content_hash,decision_json,source_version,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(item_id) DO UPDATE SET
        revision=revision+CASE WHEN source_version<>excluded.source_version THEN 1 ELSE 0 END,
        source_version=excluded.source_version,updated_at=excluded.updated_at`).run(itemId, input.scopeId, input.sessionId,
          input.turnId, decision.decision_id, contentHash, JSON.stringify(decision), input.sourceVersion, input.now, input.now);
      return this.getItem(input.scopeId, itemId)!;
    });
  }
  markMissing(owner: AttentionOwner, scopeId: string, sessionId: string): void {
    this.write(owner, () => this.db.prepare(`UPDATE attention_items SET state='source_missing',revision=revision+1
      WHERE scope_id=? AND session_id=? AND state NOT IN ('answer_applied','source_missing')`).run(scopeId, sessionId));
  }
}

# FILE packages/core/src/state/attention-observer.ts
import { realpathSync } from 'node:fs';
import { attentionDigest, AttentionStore, type AttentionOwner, type AttentionScope } from './attention-store.js';
interface Subject { scope_id:string; kind:string; subject_id:string; binding_hash:string; source_version:number; ordinal_cursor:number; admitted:number; discovered_at:number; sampled_at:number; generation:number; payload_json:string }
interface Source { session_id:string; run_id:string; request_sha256:string; agent_id:string; native_session_id:string|null; repo_path:string; version:number; state:string }
interface Turn {turn_id:string;ordinal:number;decision_json:string|null;state:string}
/** Bounded synchronous transactions; no adapter, network, or model port. */
export class AttentionObserver {
  constructor(readonly store:AttentionStore, readonly owner:AttentionOwner) {}
  tick(now=Date.now()):void {
    if(!Number.isFinite(now)) throw new Error('invalid_clock');
    this.store.assertOwner(this.owner);
    for(const scope of this.store.listScopes()) {
      try { this.store.write(this.owner,()=>this.scan(scope,now)); }
      catch(error) {
        if(error instanceof Error && error.message==='stale_owner') throw error;
        this.store.write(this.owner,()=>this.store.db.prepare('UPDATE attention_scopes SET error=?,scan_complete=0 WHERE scope_id=?').run(error instanceof Error ? error.message.slice(0,300) : 'source_error',scope.scope_id));
      }
    }
  }
  private scan(scope:AttentionScope,now:number):void {
    const db=this.store.db;
    if(!db.prepare('SELECT 1 FROM tasks WHERE task_id=? AND tenant_id IS NULL').get(scope.task_id)) {
      db.prepare("UPDATE attention_items SET state='source_missing' WHERE scope_id=? AND state='open'").run(scope.scope_id); throw new Error('source_missing');
    }
    // A scan advances a durable keyset, then restarts from the beginning. New IDs
    // inserted behind the cursor are picked up on the next pass, never evicted.
    const rows=db.prepare(`SELECT 's:'||s.session_id AS key,s.session_id AS id,'session' AS kind FROM agent_sessions s JOIN runs r ON r.run_id=s.run_id AND r.task_id=s.task_id
      WHERE s.task_id=? AND r.tenant_id IS NULL AND 's:'||s.session_id>?
      UNION ALL SELECT 'r:'||run_id,run_id,'run' FROM runs WHERE task_id=? AND tenant_id IS NULL AND 'r:'||run_id>?
      ORDER BY key LIMIT 250`).all(scope.task_id,scope.discovery_after,scope.task_id,scope.discovery_after) as {key:string;id:string;kind:string}[];
    for(const row of rows) {
      if(db.prepare('SELECT 1 FROM attention_subjects WHERE scope_id=? AND kind=? AND subject_id=?').get(scope.scope_id,row.kind,row.id)) continue;
      const count=(db.prepare('SELECT COUNT(*) n FROM attention_subjects WHERE admitted=1').get() as {n:number}).n;
      const source=row.kind==='session' ? this.source(scope,row.id) : undefined;
      const bound=row.kind==='run'||source!==undefined;
      const admitted=bound && count<100 ? 1 : 0;
      db.prepare(`INSERT INTO attention_subjects(scope_id,kind,subject_id,binding_hash,source_version,admitted,discovered_at,sampled_at,generation,payload_json) VALUES(?,?,?,?,?,?,?,?,?,?)`)
        .run(scope.scope_id,row.kind,row.id,source ? this.binding(source) : attentionDigest([scope.scope_id,row.kind,row.id]),source?.version??0,admitted,now,now,this.owner.generation,
          JSON.stringify({state:source?.state??'unknown',awaiting_decision:source?.state==='awaiting_decision',reason:!bound?'binding_unknown':!admitted?'capacity_exceeded':'snapshot_only',unresolved_receipts:source?this.receipts(source.session_id):[]}));
    }
    const subjects=db.prepare('SELECT * FROM attention_subjects WHERE scope_id=? AND admitted=1 ORDER BY kind,subject_id').all(scope.scope_id) as Subject[];
    for(const subject of subjects) {
      if(subject.kind==='run') {
        const run=db.prepare('SELECT phase,outcome FROM runs WHERE run_id=? AND task_id=? AND tenant_id IS NULL').get(subject.subject_id,scope.task_id);
        this.update(subject,now,{state:run??'source_missing',repo_binding:'unverified',process_liveness:'unknown',gap:'snapshot_only'});continue;
      }
      if(subject.kind!=='session') continue;
      const source=this.source(scope,subject.subject_id);
      if(!source) {this.store.markMissing(this.owner,scope.scope_id,subject.subject_id);this.update(subject,now,{state:'source_missing',reason:'source_missing'});continue;}
      if(this.binding(source)!==subject.binding_hash || source.version<subject.source_version) {this.update(subject,now,{state:source.state,reason:'source_binding_conflict'});continue;}
      const turns=db.prepare('SELECT turn_id,ordinal,state,decision_json FROM session_turns WHERE session_id=? AND ordinal>? ORDER BY ordinal LIMIT 50').all(source.session_id,subject.ordinal_cursor) as Turn[];
      const latest=db.prepare('SELECT turn_id,ordinal,state,decision_json FROM session_turns WHERE session_id=? ORDER BY ordinal DESC LIMIT 1').get(source.session_id) as Turn|undefined;
      let cursor=subject.ordinal_cursor;let gap=JSON.parse(subject.payload_json).gap==='history_gap';
      for(const turn of turns) {if(turn.ordinal!==cursor+1)gap=true;this.project(scope,source,turn,now);cursor=turn.ordinal;}
      if(latest && latest.ordinal<=cursor)this.project(scope,source,latest,now);
      const backlogged=latest!==undefined && latest.ordinal>cursor;
      db.prepare('UPDATE attention_subjects SET source_version=?,ordinal_cursor=? WHERE scope_id=? AND kind=? AND subject_id=?').run(source.version,cursor,scope.scope_id,subject.kind,subject.subject_id);
      const unresolved=this.receipts(source.session_id);
      // Only an applied receipt referencing this exact origin turn establishes
      // external continuation. Authorization/risk obligations remain unresolved.
      const items=this.store.listItems(scope.scope_id).filter(i=>i.session_id===source.session_id && i.state==='open' && !['risk_approval','task_authorization'].includes(i.decision.continuation?.gate_kind??''));
      for(const item of items) {
        const applied=db.prepare("SELECT message_id FROM session_messages WHERE session_id=? AND turn_id=? AND direction='inbound' AND state='applied' ORDER BY created_at,message_id LIMIT 1").get(source.session_id,item.turn_id) as {message_id:string}|undefined;
        if(applied)db.prepare("UPDATE attention_items SET state='continued_externally',external_message_id=?,revision=revision+1 WHERE item_id=?").run(applied.message_id,item.item_id);
      }
      this.update(subject,now,{state:source.state,awaiting_decision:source.state==='awaiting_decision',version:source.version,turn_id:latest?.turn_id??null,process_liveness:'unknown',gap:gap?'history_gap':'mutable_snapshot_no_complete_event_log',reason:backlogged?'history_backlog':null,unresolved_receipts:unresolved});
    }
    const complete=rows.length<250;
    db.prepare('UPDATE attention_scopes SET discovery_after=?,scan_complete=?,sampled_at=?,deadline=?,generation=?,error=NULL WHERE scope_id=?')
      .run(complete?'':rows.at(-1)!.key,complete?1:0,now,now+65000,this.owner.generation,scope.scope_id);
  }
  private source(scope:AttentionScope,id:string):Source|undefined {
    const row=this.store.db.prepare(`SELECT s.* FROM agent_sessions s JOIN runs r ON r.run_id=s.run_id AND r.task_id=s.task_id JOIN tasks t ON t.task_id=s.task_id
      WHERE s.session_id=? AND s.task_id=? AND r.tenant_id IS NULL AND t.tenant_id IS NULL`).get(id,scope.task_id) as Source|undefined;
    try {return row && realpathSync(row.repo_path)===scope.repo_path ? row:undefined;} catch{return undefined;}
  }
  private binding(source:Source):string {return attentionDigest([source.session_id,source.run_id,source.request_sha256,source.agent_id,source.repo_path]);}
  private project(scope:AttentionScope,source:Source,turn:Turn,now:number):void {
    if(turn.decision_json===null)return;
    if(turn.decision_json.length>16384)throw new Error('oversized_decision');
    this.store.projectDecision(this.owner,{scopeId:scope.scope_id,sessionId:source.session_id,turnId:turn.turn_id,sourceVersion:source.version,decision:JSON.parse(turn.decision_json),now});
  }
  private receipts(id:string):unknown[] {return this.store.db.prepare("SELECT message_id,state FROM session_messages WHERE session_id=? AND direction='inbound' AND state IN ('accepted','failed') ORDER BY created_at LIMIT 10").all(id);}
  private update(s:Subject,now:number,payload:unknown):void {this.store.db.prepare('UPDATE attention_subjects SET sampled_at=?,generation=?,payload_json=? WHERE scope_id=? AND kind=? AND subject_id=?').run(now,this.owner.generation,JSON.stringify(payload),s.scope_id,s.kind,s.subject_id);}
  inventory(scopeId:string,now=Date.now(),after='',limit=100) {
    if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error('invalid_limit');
    const scope=this.store.getScope(scopeId);if(!scope)throw new Error('not_found');
    const db=this.store.db; const counts=db.prepare('SELECT COUNT(*) total,COALESCE(SUM(admitted),0) admitted FROM attention_subjects WHERE scope_id=?').get(scopeId) as {total:number;admitted:number};
    const rows=db.prepare("SELECT * FROM attention_subjects WHERE scope_id=? AND kind||':'||subject_id>? ORDER BY kind,subject_id LIMIT ?").all(scopeId,after,limit+1) as Subject[];
    const current=db.prepare('SELECT generation FROM daemon_owner WHERE singleton=1').get() as {generation:number};
    const faulty=db.prepare("SELECT 1 FROM attention_subjects WHERE scope_id=? AND (json_extract(payload_json,'$.reason') IS NOT NULL AND json_extract(payload_json,'$.reason')<>'snapshot_only' OR json_extract(payload_json,'$.gap')='history_gap') LIMIT 1").get(scopeId);
    const coverage=now<scope.sampled_at?'unknown':scope.generation!==current.generation||now>scope.deadline?'uncovered':!scope.scan_complete||scope.error||counts.total>counts.admitted||faulty?'degraded':'covered';
    return {scope,coverage,subject_total:counts.total,admitted:counts.admitted,returned:Math.min(limit,rows.length),truncated:rows.length>limit,next_after:rows.length>limit?`${rows[limit-1]!.kind}:${rows[limit-1]!.subject_id}`:null,
      subjects:rows.slice(0,limit).map(({payload_json,...r})=>({...r,facts:JSON.parse(payload_json)})),limitations:['No complete mutable-source history','Process liveness unknown','Coverage is observation, not execution ownership']};
  }
}

# FILE packages/core/src/state/attention-actions.ts
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { SessionDecision } from '@osstack/protocol';
import { withWrite } from './db.js';
import { SessionRepository, type SessionMessageInput } from './sessions.js';
import { AttentionStore, attentionDigest, type AttentionOwner } from './attention-store.js';
/** Common human reservation, serialized with collaborator writes in the same DB. */
export function reserveSessionInstruction(db:Database.Database,path:string,message:SessionMessageInput,version:number,now:number,takeover=false) {
 return withWrite(db,path,()=>{
  const sessions=new SessionRepository(db,path);
  if(sessions.getMessage(message.message_id))return sessions.applyInbound(message,version,now);
  if(db.prepare("SELECT 1 FROM session_messages WHERE session_id=? AND direction='inbound' AND state IN ('accepted','failed') LIMIT 1").get(message.session_id))throw new Error('delivery_uncertain');
  if(db.prepare("SELECT 1 FROM session_continuation_attempts a JOIN session_continuation_grants g ON a.grant_id=g.grant_id WHERE g.session_id=? AND a.status IN ('checking','reserved') LIMIT 1").get(message.session_id))throw new Error('continuation_in_flight');
  const grant=db.prepare("SELECT grant_id FROM session_continuation_grants WHERE session_id=? AND status='active'").get(message.session_id) as {grant_id:string}|undefined;
  if(grant && !takeover)throw new Error('grant_owned');
  const snapshot=sessions.latestSnapshot(message.session_id);
  const decision=SessionDecision.safeParse(snapshot.decision);
  if(decision.success && ['risk_approval','task_authorization'].includes(decision.data.continuation?.gate_kind??''))throw new Error('signed_approval_required');
  if(grant)db.prepare("UPDATE session_continuation_grants SET status='blocked',reason='human_takeover',updated_at=? WHERE grant_id=?").run(now,grant.grant_id);
  return sessions.applyInbound(message,version,now);
 });
}
interface Action {action_id:string;scope_id:string;item_id:string;payload_hash:string;message_id:string;state:string;created_at:number;updated_at:number}
export class AttentionActions {
 constructor(readonly store:AttentionStore,readonly owner:AttentionOwner){}
 reserve(input:{scope_id:string;item_id:string;action_id:string;revision:number;content_hash:string;text:string;takeover:boolean},now=Date.now()) {
  if(!input.action_id || input.action_id.length>256 || !input.text.trim() || input.text.length>16000)throw new Error('invalid_answer');
  return this.store.write(this.owner,()=>{
   const db=this.store.db;const digest=attentionDigest(input);const prior=db.prepare('SELECT * FROM attention_actions WHERE action_id=?').get(input.action_id) as Action|undefined;
   if(prior) {if(prior.payload_hash!==digest)throw new Error('action_id_conflict');return {...this.reconcile(prior,now),replay:true,reservation_version:0};}
   const item=this.store.getItem(input.scope_id,input.item_id);const scope=this.store.getScope(input.scope_id);
   if(!item||!scope)throw new Error('not_found');
   if(item.state!=='open'||item.revision!==input.revision||item.content_hash!==input.content_hash)throw new Error('stale_item');
   if(db.prepare('SELECT 1 FROM attention_actions WHERE item_id=?').get(item.item_id))throw new Error('action_already_reserved');
   const repo=new SessionRepository(db,this.store.path);const source=repo.getSession(item.session_id);const latest=repo.latestSnapshot(item.session_id);
   if(!source || source.task_id!==scope.task_id || source.repo_path!==scope.repo_path || latest.turn_id!==item.turn_id || source.version!==item.source_version || attentionDigest(latest.decision)!==item.content_hash)throw new Error('source_changed');
   if(!db.prepare('SELECT 1 FROM tasks t JOIN runs r ON r.task_id=t.task_id WHERE t.task_id=? AND r.run_id=? AND t.tenant_id IS NULL AND r.tenant_id IS NULL').get(scope.task_id,source.run_id))throw new Error('source_changed');
   const messageId=`attention-${randomUUID()}`;
   const reservation=reserveSessionInstruction(db,this.store.path,{message_id:messageId,session_id:item.session_id,turn_id:item.turn_id,direction:'inbound',kind:'instruction.send',payload:{text:input.text},state:'accepted',created_at:now/1000},source.version,now/1000,input.takeover);
   db.prepare("INSERT INTO attention_actions VALUES(?,?,?,?,?,'reserved',?,?)").run(input.action_id,input.scope_id,input.item_id,digest,messageId,now,now);
   db.prepare("UPDATE attention_items SET state='answer_reserved',revision=revision+1,updated_at=? WHERE item_id=?").run(now,item.item_id);
   return {action_id:input.action_id,scope_id:input.scope_id,item_id:input.item_id,payload_hash:digest,message_id:messageId,state:'reserved',created_at:now,updated_at:now,replay:false,reservation_version:reservation.session_version};
  });
 }
 reconcile(action:Action,now=Date.now()):Action {
  return this.store.write(this.owner,()=>{
   const receipt=this.store.db.prepare('SELECT state FROM session_messages WHERE message_id=?').get(action.message_id) as {state:string}|undefined;
   const state=receipt?.state==='applied'?'applied':receipt?.state==='failed'?'uncertain':'uncertain';
   this.store.db.prepare('UPDATE attention_actions SET state=?,updated_at=? WHERE action_id=?').run(state,now,action.action_id);
   this.store.db.prepare('UPDATE attention_items SET state=?,updated_at=? WHERE item_id=?').run(state==='applied'?'answer_applied':'answer_uncertain',now,action.item_id);
   return {...action,state,updated_at:now};
  });
 }
}

# FILE packages/core/src/state/attention-experience.ts
import { randomBytes,randomUUID,timingSafeEqual } from 'node:crypto';
import { AttentionStore,attentionDigest,type AttentionOwner } from './attention-store.js';
interface Delivery {delivery_id:string;scope_id:string;item_id:string;revision:number;state:string;attempts:number;next_at:number;error:string|null}
export type AttentionSender=(message:{delivery_id:string;scope_id:string;item_id:string;question:string},signal:AbortSignal)=>Promise<void>;
/** Local owner UX state; posture never changes any execution authority. */
export class AttentionExperience {
 constructor(readonly store:AttentionStore,readonly owner:AttentionOwner){}
 posture(scope:string,actor:string,posture:'attended'|'quiet'|'away'):void {
  this.actor(actor);if(!['attended','quiet','away'].includes(posture))throw new Error('invalid_posture');
  this.store.write(this.owner,()=>{this.scope(scope);this.store.db.prepare('INSERT INTO attention_postures VALUES(?,?,?) ON CONFLICT(scope_id,actor) DO UPDATE SET posture=excluded.posture').run(scope,actor,posture);});
 }
 brief(scope:string,actor:string) {
  this.actor(actor);this.scope(scope);
  const db=this.store.db;
  const items=db.prepare(`SELECT i.item_id,i.revision,i.state,i.decision_json,i.created_at FROM attention_items i LEFT JOIN attention_seen s ON s.scope_id=i.scope_id AND s.item_id=i.item_id AND s.actor=?
   WHERE i.scope_id=? AND COALESCE(s.revision,0)<i.revision ORDER BY CASE WHEN i.state LIKE '%uncertain%' THEN 0 WHEN json_extract(i.decision_json,'$.continuation.gate_kind') IN ('risk_approval','task_authorization') THEN 1 WHEN i.state='open' THEN 2 ELSE 3 END,i.created_at,i.item_id LIMIT 3`).all(actor,scope) as {item_id:string;revision:number;state:string;decision_json:string;created_at:number}[];
  const total=(db.prepare(`SELECT COUNT(*) n FROM attention_items i LEFT JOIN attention_seen s ON s.scope_id=i.scope_id AND s.item_id=i.item_id AND s.actor=? WHERE i.scope_id=? AND COALESCE(s.revision,0)<i.revision`).get(actor,scope) as {n:number}).n;
  const dead=(db.prepare("SELECT COUNT(*) n FROM attention_deliveries WHERE scope_id=? AND state='dead_letter'").get(scope) as {n:number}).n;
  return {scope_id:scope,actor,total,dead_letters:dead,items:items.map(({decision_json,...r})=>({...r,question:JSON.parse(decision_json).question})),read_is_not_seen:true};
 }
 seen(scope:string,actor:string,revisions:{item_id:string;revision:number}[]):void {
  this.actor(actor);if(revisions.length>100)throw new Error('too_many_items');
  this.store.write(this.owner,()=>{this.scope(scope);for(const r of revisions){const item=this.store.getItem(scope,r.item_id);if(!item||item.revision!==r.revision)throw new Error('stale_item');
   this.store.db.prepare('INSERT INTO attention_seen VALUES(?,?,?,?) ON CONFLICT(scope_id,actor,item_id) DO UPDATE SET revision=MAX(revision,excluded.revision)').run(scope,actor,r.item_id,r.revision);}});
 }
 enqueue(scope:string):void {
  this.store.write(this.owner,()=>{this.scope(scope);this.store.db.prepare(`INSERT OR IGNORE INTO attention_deliveries(delivery_id,scope_id,item_id,revision)
    SELECT item_id||':'||revision,scope_id,item_id,revision FROM attention_items WHERE scope_id=? AND state IN ('open','answer_uncertain','source_missing')`).run(scope);});
 }
 recoverDeliveries():void {this.store.write(this.owner,()=>this.store.db.prepare("UPDATE attention_deliveries SET state=CASE WHEN attempts>=5 THEN 'dead_letter' ELSE 'pending' END,error='interrupted_delivery' WHERE state='sending'").run());}
 async drain(sender:AttentionSender,now=Date.now(),timeoutMs=5000):Promise<void> {
  const db=this.store.db;
  const row=this.store.write(this.owner,()=>{
   const d=db.prepare(`SELECT d.* FROM attention_deliveries d WHERE d.state='pending' AND d.next_at<=? AND NOT EXISTS(SELECT 1 FROM attention_postures p WHERE p.scope_id=d.scope_id AND p.posture='quiet') ORDER BY d.next_at,d.delivery_id LIMIT 1`).get(now) as Delivery|undefined;
   if(d)db.prepare("UPDATE attention_deliveries SET state='sending',attempts=attempts+1 WHERE delivery_id=? AND state='pending'").run(d.delivery_id);return d;
  });
  if(!row)return;
  const item=this.store.getItem(row.scope_id,row.item_id);const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined;
  let error:string|null=null;
  try {
   if(!item)throw new Error('source_missing');
   await Promise.race([Promise.resolve().then(()=>sender({delivery_id:row.delivery_id,scope_id:row.scope_id,item_id:row.item_id,question:item.decision.question},controller.signal)),new Promise<never>((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('delivery_timeout'));},timeoutMs);})]);
  }catch(e){error=e instanceof Error?e.message.slice(0,300):'delivery_failed';}finally{if(timer)clearTimeout(timer);}
  this.store.write(this.owner,()=>db.prepare("UPDATE attention_deliveries SET state=?,next_at=?,error=? WHERE delivery_id=? AND attempts=? AND state='sending'")
   .run(error ? row.attempts+1>=5?'dead_letter':'pending':'delivered',now+Math.min(300000,1000*2**row.attempts),error,row.delivery_id,row.attempts+1));
 }
 foreground(scope:string,subjects:{subject_id:string;source_version:number}[],now=Date.now()) {
  if(!Array.isArray(subjects)||subjects.length<1||subjects.length>100||new Set(subjects.map(s=>s.subject_id)).size!==subjects.length)throw new Error('invalid_subject_set');
  const token=randomBytes(32).toString('hex');const clientId=randomUUID();
  this.store.write(this.owner,()=>{this.scope(scope);this.validateSubjects(scope,subjects);this.store.db.prepare('INSERT INTO attention_foregrounds(client_id,token_hash,scope_id,generation,expires_at,subjects_json) VALUES(?,?,?,?,?,?)').run(clientId,attentionDigest(token),scope,this.owner.generation,now+120000,JSON.stringify(subjects));});
  return {client_id:clientId,token,expires_at:now+120000,role:'foreground_owner'};
 }
 handoff(scope:string,client:string,token:string,now=Date.now()) {
  return this.store.write(this.owner,()=>{
   const row=this.authenticate(scope,client,token,now);
   const prior=this.store.db.prepare('SELECT * FROM attention_handoffs WHERE client_id=?').get(client);if(prior)return prior;
   const s=this.scope(scope);if(!s.scan_complete||s.generation!==this.owner.generation||s.deadline<now||s.sampled_at>now||s.error)throw new Error('coverage_not_ready');
   const subjects=JSON.parse(row.subjects_json) as {subject_id:string;source_version:number}[];this.validateSubjects(scope,subjects);
   const receipt={receipt_id:randomUUID(),client_id:client,scope_id:scope,generation:this.owner.generation,subjects_json:row.subjects_json,created_at:now};
   this.store.db.prepare('INSERT INTO attention_handoffs VALUES(?,?,?,?,?,?)').run(receipt.receipt_id,client,scope,this.owner.generation,row.subjects_json,now);
   this.store.db.prepare('UPDATE attention_foregrounds SET handed_off=1 WHERE client_id=?').run(client);return receipt;
  });
 }
 turnEnd(scope:string,client:string,token:string,role:string,now=Date.now()) {
  return this.store.write(this.owner,()=>{if(role!=='foreground_owner')throw new Error('wrong_role');const row=this.authenticate(scope,client,token,now);
   if(row.reminder_sent||row.handed_off)return {reminder:null};this.store.db.prepare('UPDATE attention_foregrounds SET reminder_sent=1 WHERE client_id=?').run(client);
   return {reminder:'Foreground ended. Check attention coverage and explicitly hand off unresolved work.',continues:false,offline_detection:false};});
 }
 private authenticate(scope:string,client:string,token:string,now:number) {
  const row=this.store.db.prepare('SELECT * FROM attention_foregrounds WHERE client_id=? AND scope_id=?').get(client,scope) as {token_hash:string;generation:number;expires_at:number;subjects_json:string;handed_off:number;reminder_sent:number}|undefined;
  if(typeof token!=='string'||token.length!==64||!row||!timingSafeEqual(Buffer.from(row.token_hash),Buffer.from(attentionDigest(token)))||row.generation!==this.owner.generation||row.expires_at<now)throw new Error('invalid_foreground');return row;
 }
 private validateSubjects(scope:string,subjects:{subject_id:string;source_version:number}[]):void {
  for(const s of subjects) {
   const row=this.store.db.prepare("SELECT source_version,admitted,payload_json FROM attention_subjects WHERE scope_id=? AND kind='session' AND subject_id=?").get(scope,s.subject_id) as {source_version:number;admitted:number;payload_json:string}|undefined;
   const live=this.store.db.prepare('SELECT version FROM agent_sessions WHERE session_id=?').get(s.subject_id) as {version:number}|undefined;
   if(!row||row.admitted!==1||row.source_version!==s.source_version||live?.version!==s.source_version||JSON.parse(row.payload_json).reason)throw new Error('subject_not_covered');
  }
 }
 private scope(scope:string){const s=this.store.getScope(scope);if(!s)throw new Error('not_found');return s;}
 private actor(actor:string):void {if(typeof actor!=='string'||actor.length<1||actor.length>256)throw new Error('invalid_actor');}
}

# FILE packages/cli/src/supervision-service.ts
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { AttentionStore, AttentionObserver, AttentionExperience, type AttentionSender } from '@osstack/core';
/** The daemon has already acquired its kernel process lock before construction. */
export class SupervisionService {
 readonly store:AttentionStore;
 readonly observer:AttentionObserver;
 readonly experience:AttentionExperience;
 private delivering=false;
 private timer:ReturnType<typeof setInterval>|undefined;
 constructor(db:Database.Database,path:string,readonly sender?:AttentionSender) {
  this.store=new AttentionStore(db,path);this.observer=new AttentionObserver(this.store,this.store.claimOwner(randomUUID()));
  this.experience=new AttentionExperience(this.store,this.observer.owner);this.experience.recoverDeliveries();
 }
 start():void {this.scan();this.timer=setInterval(()=>this.scan(),30000);this.timer.unref();}
 private scan():void {
  try{this.observer.tick();for(const scope of this.store.listScopes())this.experience.enqueue(scope.scope_id);
   if(this.sender&&!this.delivering){this.delivering=true;void this.experience.drain(this.sender).catch(()=>{/* delivery state retained */}).finally(()=>{this.delivering=false;});}
  }catch{/* coverage expires even if timer is alive */}
 }
 stop():void {if(this.timer)clearInterval(this.timer);this.timer=undefined;}
 handle(method:string,params:unknown):unknown {
  if(!params||typeof params!=='object')throw new Error('explicit_scope_required');
  const p=params as Record<string,unknown>;
  const str=(key:string)=>{const value=p[key];if(typeof value!=='string'||!value||value.length>4096)throw new Error(`invalid_${key}`);return value;};
  if(method==='attention.watch') {
   if(p['default_tenant']!==true)throw new Error('explicit_default_tenant_required');
   const scope=this.store.registerScope(this.observer.owner,str('task_id'),str('repo_path'));this.observer.tick();return this.observer.inventory(scope.scope_id);
  }
  const scopeId=str('scope_id');if(!this.store.getScope(scopeId))throw new Error('not_found');
  if(method==='attention.brief')return this.experience.brief(scopeId,str('actor'));
  if(method==='attention.posture') {const posture=str('posture');if(!['quiet','away','attended'].includes(posture))throw new Error('invalid_posture');this.experience.posture(scopeId,str('actor'),posture as 'quiet'|'away'|'attended');return {posture};}
  if(method==='attention.seen') {if(!Array.isArray(p['revisions']))throw new Error('invalid_revisions');this.experience.seen(scopeId,str('actor'),p['revisions']);return {marked:true};}
  if(method==='attention.foreground') {if(!Array.isArray(p['subjects']))throw new Error('invalid_subjects');return this.experience.foreground(scopeId,p['subjects']);}
  if(method==='attention.handoff')return this.experience.handoff(scopeId,str('client_id'),str('token'));
  if(method==='attention.turn-end')return this.experience.turnEnd(scopeId,str('client_id'),str('token'),str('role'));
  if(method==='attention.deliveries')return this.store.db.prepare('SELECT * FROM attention_deliveries WHERE scope_id=? AND delivery_id>? ORDER BY delivery_id LIMIT 100').all(scopeId,typeof p['after']==='string'?p['after']:'');
  if(method==='attention.inventory')return this.observer.inventory(scopeId,Date.now(),typeof p['after']==='string'?p['after']:'');
  if(method==='attention.inbox') {
   const items=this.store.listItems(scopeId,typeof p['after']==='string'?p['after']:'');
   const counts=this.store.db.prepare('SELECT state,COUNT(*) total FROM attention_items WHERE scope_id=? GROUP BY state').all(scopeId);
   return {scope_id:scopeId,items,counts,next_after:items.length===100?items.at(-1)!.item_id:null,coverage:this.observer.inventory(scopeId).coverage};
  }
  if(method==='attention.get') {const item=this.store.getItem(scopeId,str('item_id'));if(!item)throw new Error('not_found');return item;}
  throw new Error('unsupported_attention_method');
 }
}

# FILE packages/cli/src/attention-command.ts
import { readAttentionStatus } from "./attention-read-model.js";

const HELP = `Usage: osstack attention status --db /absolute/state.db --task ID --repo /absolute/repo --default-tenant [--json] [--cursor TOKEN]
Read-only snapshot. No daemon is started and no database is migrated.
Live process state is unknown; this command does not establish background supervision.
Opt-in daemon: OSSTACK_ATTENTION=1 osstack serve
  attention watch --task ID --repo PATH --default-tenant
  attention inbox|inventory|deliveries --scope ID [--after ID] [--json]
  attention get --scope ID --item ID
  attention answer --scope ID --item ID --action ID --revision N --content-hash HASH --text TEXT [--takeover]
  attention brief|cockpit --scope ID --actor NAME
  attention posture --scope ID --actor NAME --posture attended|quiet|away
  attention seen --scope ID --actor NAME --revisions JSON
  attention foreground --scope ID --subjects JSON
  attention handoff --scope ID --client ID --token TOKEN
  attention turn-end --scope ID --client ID --token TOKEN --role foreground_owner
No daemon is automatically started. Hooks are explicit calls; no offline watchdog is installed.`;
export async function handleAttentionCommand(args: string[], io: { stdout?: (s: string) => void; stderr?: (s: string) => void; rpc?: (method:string,params?:unknown,timeoutMs?:number)=>Promise<unknown> } = {}): Promise<number> {
  const out = io.stdout ?? console.log; const err = io.stderr ?? console.error;
  if (args.includes("--help") || args[0] === "help") { out(HELP); return 0; }
  try {
    if (args[0] !== "status") return await handleLive(args, io);
    const values = new Map<string, string>(); const flags = new Set<string>();
    for (let i = 1; i < args.length; i++) {
      const key = args[i]!;
      if (values.has(key) || flags.has(key)) throw new Error(`duplicate_flag:${key}`);
      if (["--json", "--default-tenant"].includes(key)) { flags.add(key); continue; }
      if (!["--db", "--task", "--repo", "--after-run", "--after-session", "--cursor"].includes(key)) throw new Error(`unknown_flag:${key}`);
      const value = args[++i]; if (!value || value.startsWith("--") || value.includes("\0")) throw new Error(`missing_value:${key}`);
      values.set(key, value);
    }
    const required = (key: string) => { const value = values.get(key); if (!value) throw new Error(`required:${key}`); return value; };
    if (!flags.has("--default-tenant")) throw new Error("explicit_default_tenant_required");
    const result = readAttentionStatus({ dbPath: required("--db"), repoPath: required("--repo"), taskId: required("--task"), defaultTenant: true,
      ...(values.has("--cursor") ? { cursor: values.get("--cursor")! } : {}),
      ...(values.has("--after-run") ? { afterRun: values.get("--after-run")! } : {}),
      ...(values.has("--after-session") ? { afterSession: values.get("--after-session")! } : {}) });
    out(flags.has("--json") ? JSON.stringify(result, null, 2) : [
      "单次状态快照 · 未后台接管", `Task: ${JSON.stringify(result.scope.task_id)}`,
      ...result.sessions.map((s) => `${JSON.stringify(s.session_id)}: ${JSON.stringify(s.state)} · ${JSON.stringify(s.wait.reason)}${s.decision ? ` · ${JSON.stringify(s.decision.question)}` : ""}`),
      `Runs: ${result.runs.length}; omitted: ${result.completeness.omitted_binding_unknown}; truncated: ${result.completeness.truncated}`,
      `Limitations: ${JSON.stringify(result.limitations)}`,
    ].join("\n"));
    return 0;
  } catch (error) { err(`osstack attention: ${error instanceof Error ? error.message : String(error)}`); return 1; }
}

async function handleLive(args:string[],io:{stdout?:(s:string)=>void;rpc?:(method:string,params?:unknown,timeoutMs?:number)=>Promise<unknown>}):Promise<number> {
 const command=args[0]!;const allowed=['watch','inventory','inbox','get','answer','brief','posture','seen','foreground','handoff','turn-end','deliveries','cockpit'];
 if(!allowed.includes(command))throw new Error('unknown_attention_command');if(!io.rpc)throw new Error('daemon_connection_required');
 const params:Record<string,unknown>={};let json=false;
 const keys=new Set(['task','repo','scope','after','item','action','revision','content-hash','text','actor','posture','revisions','subjects','client','token','role']);
 for(let i=1;i<args.length;i++) {
  const flag=args[i]!;if(flag==='--json'){json=true;continue;}if(flag==='--default-tenant'){params['default_tenant']=true;continue;}if(flag==='--takeover'){params['takeover']=true;continue;}
  const key=flag.slice(2);if(!flag.startsWith('--')||!keys.has(key))throw new Error('unknown_flag:'+flag);const value=args[++i];if(!value||value.startsWith('--'))throw new Error('missing_value:'+flag);
  const mapped:Record<string,string>={task:'task_id',repo:'repo_path',scope:'scope_id',item:'item_id',action:'action_id',client:'client_id','content-hash':'content_hash'};
  const name=mapped[key]??key;if(params[name]!==undefined)throw new Error('duplicate_flag:'+flag);
  params[name]=key==='revision'?Number(value):['revisions','subjects'].includes(key)?JSON.parse(value):value;
 }
 if(command==='answer')params['takeover']??=false;
 const call=async(method:string)=>{const response=await io.rpc!(method,params,120000) as {ok:boolean;result?:unknown;error?:{code?:string;message?:string}};if(!response.ok)throw new Error(response.error?.code??response.error?.message??'attention_failed');return response.result;};
 const result=command==='cockpit'?{inventory:await call('attention.inventory'),inbox:await call('attention.inbox'),brief:await call('attention.brief'),deliveries:await call('attention.deliveries')}:await call('attention.'+command);
 (io.stdout??console.log)(json?JSON.stringify(result,null,2):`Attention · ${command}\n${JSON.stringify(result,null,2)}\nDelivered means transport receipt; applied means instruction receipt; neither means task completed.`);return 0;
}

# FILE packages/cli/src/attention-read-model.ts
import { createHash } from "node:crypto";
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { AttentionStatus, SessionDecision, AttentionSessionFact, type AttentionWait } from "@osstack/protocol";
import { assertDbAccessAllowed, defaultOsstackHome } from "./control-plane-guard.js";

export interface AttentionReadInput {
  dbPath: string; taskId: string; repoPath: string; defaultTenant: true;
  cursor?: string; afterRun?: string; afterSession?: string;
}
export function attentionHash(value: unknown): string {
  const canonical = (v: unknown): string => {
    if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
    if (v !== null && typeof v === "object") return `{${Object.entries(v).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}`;
    return JSON.stringify(v);
  };
  return createHash("sha256").update(canonical(value)).digest("hex");
}
export function guardAttentionDatabase(path: string): string {
  if (!isAbsolute(path)) throw new Error("absolute_db_required");
  const dbPath = realpathSync(path);
  if (!statSync(dbPath).isFile()) throw new Error("regular_database_required");
  const checkoutRoot = dirname(realpathSync(fileURLToPath(import.meta.url)));
  const defaultPath = defaultOsstackHome(); const defaultHome = existsSync(defaultPath) ? realpathSync(defaultPath) : defaultPath;
  for (let home = dirname(dbPath); ; home = dirname(home)) {
    if (home === dirname(dbPath) || home === defaultHome || existsSync(join(home, "control-plane-reserved.json"))) {
      assertDbAccessAllowed({ checkoutRoot, osstackHome: home });
    }
    if (dirname(home) === home) break;
  }
  return dbPath;
}
interface Row {
  session_id: string; run_id: string; state: string; version: number; repo_path: string;
  updated_at: number; turn_id: string | null; turn_state: string | null; decision_json: string | null;
}
/** Persistent facts only; accepted is not proof that a live process is still sending. */
export function readStoredWait(db: Database.Database, row: Row): AttentionWait {
  const pending = db.prepare(`SELECT message_id,state FROM session_messages WHERE session_id=? AND direction='inbound'
    AND state IN ('accepted','failed') ORDER BY CASE state WHEN 'accepted' THEN 0 ELSE 1 END,created_at,message_id LIMIT 1`).get(row.session_id) as { message_id: string; state: string } | undefined;
  if (pending) return { reason: pending.state === "accepted" ? "accepted_in_flight_or_uncertain" : "delivery_failed", owner: "unknown", grant_id: null, message_id: pending.message_id };
  const grant = db.prepare(`SELECT grant_id,expected_turn_id,expected_version,body_json FROM session_continuation_grants
    WHERE session_id=? AND status='active' LIMIT 1`).get(row.session_id) as { grant_id: string; expected_turn_id: string; expected_version: number; body_json: string } | undefined;
  if (grant) {
    let expires: number;
    try { expires = Date.parse(JSON.parse(grant.body_json).expires_at); if (!Number.isFinite(expires)) throw new Error(); }
    catch { return { reason: "grant_unreadable", owner: "unknown", grant_id: grant.grant_id, message_id: null }; }
    const stale = expires <= Date.now() || grant.expected_turn_id !== row.turn_id || grant.expected_version !== row.version;
    return { reason: expires <= Date.now() ? "grant_expired_unswept" : stale ? "stale_grant" : "grant_coverage_unknown",
      owner: stale ? "human" : "unknown", grant_id: grant.grant_id, message_id: null };
  }
  if (!["idle", "awaiting_decision", "running", "completed", "failed", "cancelled"].includes(row.state))
    return { reason: "unknown_state", owner: "unknown", grant_id: null, message_id: null };
  return { reason: row.state === "awaiting_decision" ? "owner_decision" : row.state === "idle" ? "awaiting_instruction" : "none",
    owner: ["idle", "awaiting_decision"].includes(row.state) ? "human" : "none", grant_id: null, message_id: null };
}

export function readAttentionStatus(input: AttentionReadInput): AttentionStatus {
  if (!input.taskId || input.taskId.length > 512 || !input.defaultTenant || !isAbsolute(input.repoPath)) throw new Error("explicit_scope_required");
  const repoPath = realpathSync(input.repoPath);
  if (!statSync(repoPath).isDirectory()) throw new Error("repository_directory_required");
  const dbPath = guardAttentionDatabase(input.dbPath);
  const scopeId = attentionHash([dbPath, input.taskId, null, repoPath]);
  let page = { scope: scopeId, run: input.afterRun ?? "", session: input.afterSession ?? "", runDone: false, sessionDone: false };
  if (input.cursor !== undefined) {
    try {
      if (input.cursor.length > 4096 || input.afterRun !== undefined || input.afterSession !== undefined) throw new Error();
      const c = JSON.parse(Buffer.from(input.cursor, "base64url").toString());
      if (c.scope !== scopeId || typeof c.run !== "string" || typeof c.session !== "string" || c.run.length > 512 || c.session.length > 512
        || typeof c.runDone !== "boolean" || typeof c.sessionDone !== "boolean") throw new Error();
      page = c;
    } catch { throw new Error("invalid_cursor"); }
  }
  let db: Database.Database | undefined;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true, timeout: 1000 });
    const source = db;
    return source.transaction(() => {
      const schema = source.pragma("user_version", { simple: true });
      if (![24, 25].includes(Number(schema))) throw new Error("unsupported_schema");
      const task = source.prepare("SELECT task_id FROM tasks WHERE task_id=? AND tenant_id IS NULL").get(input.taskId);
      if (!task) throw new Error("task_not_found_in_scope");
      const runs = page.runDone ? [] : source.prepare(`SELECT r.run_id,r.phase,r.outcome FROM runs r JOIN tasks t ON r.task_id=t.task_id
        WHERE r.task_id=? AND t.tenant_id IS NULL AND r.tenant_id IS NULL AND r.run_id>? ORDER BY r.run_id LIMIT 101`)
        .all(input.taskId, page.run) as { run_id: string; phase: string; outcome: string | null }[];
      const rows = page.sessionDone ? [] : source.prepare(`SELECT s.session_id,s.run_id,s.state,s.version,s.repo_path,s.updated_at,
        st.turn_id,st.state AS turn_state,st.decision_json FROM agent_sessions s
        JOIN tasks t ON s.task_id=t.task_id JOIN runs r ON s.run_id=r.run_id AND r.task_id=s.task_id
        LEFT JOIN session_turns st ON st.session_id=s.session_id AND st.ordinal=(SELECT MAX(ordinal) FROM session_turns WHERE session_id=s.session_id)
        WHERE s.task_id=? AND t.tenant_id IS NULL AND r.tenant_id IS NULL AND s.session_id>?
        ORDER BY s.session_id LIMIT 101`).all(input.taskId, page.session) as Row[];
      const limitations = ["loop_unsupported_in_slice_0", "live_process_state_unknown", "latest_turn_not_complete_history", "run_repository_unverified"];
      const sessions: AttentionSessionFact[] = []; let omitted = 0;
      for (const row of rows.slice(0, 100)) {
        let bound = false;
        try { bound = isAbsolute(row.repo_path) && realpathSync(row.repo_path) === repoPath; } catch { /* disclose below */ }
        if (!bound) { omitted++; continue; }
        let decision: AttentionSessionFact["decision"] = null;
        if (row.decision_json !== null) {
          try {
            if (row.decision_json.length > 16384) throw new Error("oversized");
            decision = SessionDecision.parse(JSON.parse(row.decision_json));
          } catch { limitations.push(`invalid_decision:${row.session_id}`); }
        }
        const fact = AttentionSessionFact.safeParse({ session_id: row.session_id, run_id: row.run_id, state: row.state, version: row.version,
          turn_id: row.turn_id, turn_state: row.turn_state, decision, decision_hash: decision ? attentionHash(decision) : null,
          process_liveness: "unknown", wait: readStoredWait(source, row), updated_at: row.updated_at });
        if (fact.success) sessions.push(fact.data); else limitations.push(`corrupt_session:${row.session_id.slice(0,512)}`);
      }
      return AttentionStatus.parse({ schema_version: 1, mode: "snapshot_only",
        scope: { scope_id: scopeId, task_id: input.taskId, tenant_id: null, repo_path: repoPath },
        sampled_at_ms: Date.now(), coverage: { state: "not_monitored" },
        runs: runs.slice(0, 100).map((r) => ({ ...r, repo_binding: "unverified" })), sessions,
        completeness: { latest_turn_only: true, truncated: runs.length > 100 || rows.length > 100, omitted_binding_unknown: omitted,
          next_cursor: runs.length > 100 || rows.length > 100 ? Buffer.from(JSON.stringify({ scope: scopeId,
            run: runs[99]?.run_id ?? page.run, session: rows[99]?.session_id ?? page.session,
            runDone: runs.length <= 100, sessionDone: rows.length <= 100 })).toString("base64url") : null,
          next_after: { run: runs.length > 100 ? runs[99]!.run_id : null, session: rows.length > 100 ? rows[99]!.session_id : null } }, limitations });
    })();
  } catch (error) {
    if (error instanceof Database.SqliteError) throw new Error(`${error.code.startsWith("SQLITE_BUSY") || error.code.startsWith("SQLITE_LOCKED") ? "source_busy" : "unsupported_source"}: ${error.code}`);
    throw error;
  } finally { db?.close(); }
}

# FILE packages/cli/src/daemon-lock.ts
// The application DB is never used as a process mutex: opening it migrates it.
// This private, fixed-inode SQLite file holds a native exclusive lock until close.
import Database from "better-sqlite3";
import { lstatSync, mkdirSync, readFileSync, realpathSync, statfsSync, unlinkSync, writeFileSync, openSync, closeSync, constants } from "node:fs";
import { dirname, join, basename } from "node:path";

export class DaemonAlreadyRunningError extends Error {
  constructor(readonly pid: number, pidFile: string) {
    super(`osstack daemon ownership is held (pid ${pid || "unknown"}, pidfile ${pidFile}). Stop the owner before restarting; do not delete the lock file.`);
    this.name = "DaemonAlreadyRunningError";
  }
}
const held = new Set<string>();
function diagnosticPid(path: string): number {
  try { const pid = Number(readFileSync(path, "utf8").trim()); return Number.isSafeInteger(pid) && pid > 0 ? pid : 0; }
  catch { return 0; }
}
/** No application schema or migration. Kernel locks are released on process exit.
 * Supported local FS only; SQLite's POSIX VFS does not inherit locks across fork.
 * Never unlink/replace the lock DB: doing so would create two independent inodes.
 */
export function acquireDaemonLock(pidFile: string): () => void {
  mkdirSync(dirname(pidFile), { recursive: true, mode: 0o700 });
  const path = join(realpathSync(dirname(pidFile)), `${basename(pidFile)}.lock.db`);
  const localTypes = new Set([0x1a, 0x11, 0xef53, 0x58465342, 0x9123683e, 0x01021994, 0x794c7630]);
  if (!["darwin", "linux"].includes(process.platform) || !localTypes.has(Number(statfsSync(dirname(path)).type) >>> 0)) {
    throw new Error(`daemon_lock_unsupported_filesystem:${statfsSync(dirname(path)).type.toString(16)}:${dirname(path)}`);
  }
  if (held.has(path)) throw new DaemonAlreadyRunningError(process.pid, pidFile);
  for (const candidate of [path, pidFile]) {
    try { const st = lstatSync(candidate); if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) throw new Error("daemon_lock_requires_regular_file"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
  const db = new Database(path, { timeout: 0 });
  try {
    if (db.pragma("journal_mode = DELETE", { simple: true }) !== "delete") throw new Error("daemon_lock_wrong_journal_mode");
    db.exec("BEGIN EXCLUSIVE");
    held.add(path);
    const fd = openSync(pidFile, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, `${process.pid}\n`); } finally { closeSync(fd); }
  } catch (error) {
    held.delete(path); db.close();
    if (error instanceof Database.SqliteError && ["SQLITE_BUSY", "SQLITE_LOCKED"].some((code) => error.code.startsWith(code))) {
      throw new DaemonAlreadyRunningError(diagnosticPid(pidFile), pidFile);
    }
    throw error;
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { if (diagnosticPid(pidFile) === process.pid) unlinkSync(pidFile); } catch { /* diagnostics only */ }
    // Closing rolls back the empty transaction and releases the OS lock.
    try { db.close(); } finally { held.delete(path); }
  };
}

# daemon integration (full current file)
// osstack daemon — Unix socket server.
//
// Wire protocol (length-prefixed JSON, see @osstack/hermes-adapter/framing):
//   Single-shot methods (version, health, agent.list, run.status, stats,
//     task.cancel): one request → one response.
//   Streaming methods (task.submit, task.observe): one request → many frames,
//     ending with a terminal HermesEvent (type "done" or "error" with
//     terminal=true).
//
// Each connection is independent; concurrent task.submit calls each get
// their own socket and event stream.

import { createServer, type Socket } from "node:net";
import { existsSync, unlinkSync, statSync, chmodSync, mkdirSync } from "node:fs";
import { readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { encodeFrame, FrameDecoder, type HermesEvent } from "@osstack/hermes-adapter";
import {
  DiscoveryPolicy,
  LessonDraftConfig,
  LoopBudget,
  LoopEngine,
  LoopWaitReason,
  LoopKnowledgeTrace,
  LoopProfileRoutingEvidence,
  checkBudget,
  nextCronDelayMs,
  validateCronExpression,
  readLoopState,
  renderLoopStateMarkdown,
  type LoopBudgetStatus,
  type LoopRunCyclesOptions,
  type LoopRunCyclesResult,
  type LoopRunOptions,
  type LoopRunResult,
  type LoopKnowledgeTrace as LoopKnowledgeTraceType,
  type LoopProfileRoutingEvidence as LoopProfileRoutingEvidenceType,
  type CompletedTask,
} from "@osstack/loop";
import {
  AgentOverrideError,
  reserveSessionInstruction,
  AttentionActions,
  countEvents,
  countRuns,
  countRunsSince,
  DEFAULT_RULES,
  GBrainAdapter,
  getBoard,
  HermesBridge,
  initOtel,
  KanbanNotifier,
  KanbanRepository,
  listEventsForRun,
  otelEnabled,
  PIIRedactor,
  PolicyEngine,
  routeCapability,
  SessionMessageIdConflict,
  SessionRepository,
  SessionContinuationRepository,
  SessionVersionConflict,
  shutdownOtel,
  sqliteHistory,
  traceSpan,
  type CardStatus,
  type OutboundMessage,
  type PolicyDecision,
  type RoutableAdapter,
} from "@osstack/core";
import { guardedOpenDb as openDb } from "./guarded-open-db.js";
import { RpcLatencyRecorder, type RpcMethodLatency } from "./rpc-latency.js";
import type Database from "better-sqlite3";
import {
  AgentSessionEventSchema,
  defaultAdapters,
  createControlledSessionAdapter,
  isControlledSessionAdapter,
  isSessionCapableAdapter,
  type AgentAdapter,
  type AgentSessionEvent,
  type AgentSessionInput,
  type AgentTask,
  type SessionCapableAdapter,
} from "@osstack/agents";
import { appendEvent, finalizeRun, insertRun, insertTask } from "./store.js";
import {
  getAutonomyRun,
  listResumableAutonomyRuns,
} from "@osstack/core";
import {
  acquireRepoWriteLock,
  DEFAULT_READ_CONCURRENCY,
  DEFAULT_WRITE_CONCURRENCY,
  FifoSemaphore,
  SemaphoreAcquireAbortedError,
  type GuardedDeliveryResult,
  type RepoWriteLock,
  type SemaphoreLease,
} from "@osstack/autonomy";
import {
  ScopedApprovalDecision,
  SessionDecision,
  type ScopedApprovalDecision as ScopedApprovalDecisionType,
} from "@osstack/protocol";
import { SessionCollaborator, readContinuationTrust } from "./session-collaborator.js";
import { describeSessionWait } from "./session-wait.js";
import { runDailyBrief } from "./daily-command.js";
import { makePolicyGate } from "./policy-gate.js";
import { osstackHome, pidFilePath, resolveSocketPath } from "./paths.js";
import { PROTOCOL_VERSION, VERSION } from "./version.js";
import { readUpdateCache, startUpdateChecker } from "./update-check.js";
import { acquireDaemonLock } from "./daemon-lock.js";
import {
  runAutonomyHealth,
  type AutonomyHealthReport,
} from "./autonomy-health.js";
import {
  drainAutonomyNotifications,
  type AutonomyNotificationSender,
} from "./autonomy-notification.js";
import {
  ClockJumpDetector,
  enforceAutonomyRetention,
} from "./autonomy-host.js";
import {
  createDashboardSnapshot,
  dashboardUrl,
  dashboardUrlFromEnv,
  startDashboardServer,
  type DashboardServerHandle,
} from "./dashboard.js";
import {
  runLoopNeatFinalizer,
  type LoopNeatFinalizerResultV1,
} from "./loop-neat-finalizer.js";

import { SupervisionService } from "./supervision-service.js";

const DAEMON_VERSION = VERSION;
const DAEMON_PHASE = "S1.5-controls";
const LOOP_FAILURE_STREAK_THRESHOLD = 3;
/** Auto-stop a daily session after this many consecutive brief failures (R2.3). */
const DAILY_FAILURE_STOP_THRESHOLD = 5;

interface ArtifactVerificationOptions {
  requireGitDiff?: boolean;
  targetPaths?: string[];
  forbiddenPaths?: string[];
}

interface DaemonRequest {
  id: string | number;
  method: string;
  params?: unknown;
}

interface SingleResponse {
  id: string | number;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

interface DaemonContext {
  dbPath: string;
  loopSessionsPath: string;
  dailySessionsPath: string;
  db: Database.Database;
  redactor: PIIRedactor;
  adapters: Map<string, AgentAdapter>;
  policy: PolicyEngine;
  hermes: HermesBridge;
  gbrain: GBrainAdapter;
  /** osstack's own kanban board (borrowed from Hermes; see core/src/kanban). */
  kanban: KanbanRepository;
  /** Durable, versioned control plane for resumable agent conversations. */
  sessions: SessionRepository;
  continuations: SessionContinuationRepository;
  collaborator: SessionCollaborator | undefined;
  supervision?: SupervisionService;
  /** Local browser dashboard, returned to chat bridges as a shareable URL. */
  dashboardUrl: string | null;
  /** Active runs by run_id → AbortController for cancellation. */
  activeRuns: Map<string, AbortController>;
  /** Sessions currently applying a non-duplicate inbound message. */
  activeSessionSends: Set<string>;
  /** Daemon-managed polling loop sessions, keyed by loop_session_id. */
  loopSessions: Map<string, LoopSession>;
  /** Daemon-managed daily-brief sessions, keyed by daily_session_id (R2.3). */
  dailySessions: Map<string, DailySession>;
  /** Kanban task_ids per osstack run_id, set when bridge create succeeds. */
  hermesKanbanByRun: Map<string, string>;
  /** Per-method RPC latency windows, surfaced via the stats method. */
  rpcLatency: RpcLatencyRecorder;
  /**
   * True when `draining` was raised by the autonomy health probe (low disk,
   * lost push/deploy) rather than by an operator/upgrade `daemon.drain`.
   * Only a health-raised drain may auto-clear — clearing an upgrade's drain
   * would resurrect the daemon mid-swap.
   */
  drainingFromHealth: boolean;
  /** When true (set by daemon.drain), new task.submit calls are rejected. */
  draining: boolean;
  /** Graceful shutdown trigger, wired up by startDaemon once the server is live. */
  requestShutdown: () => void;
  /** Durable guarded-delivery recovery port, configured by the product entrypoint. */
  guardedAutonomy: GuardedAutonomyDaemonRuntime | undefined;
  /** Whole-machine bounded concurrency, independent for writes and reads. */
  writeSemaphore: FifoSemaphore;
  readSemaphore: FifoSemaphore;
  /** Per-repository writer queues; file locks enforce cross-process ownership. */
  repoWriteSemaphores: Map<string, FifoSemaphore>;
  /** Latest operational gate and the probe used to refresh it. */
  autonomyHealth: () => Promise<AutonomyHealthReport>;
  lastAutonomyHealth: AutonomyHealthReport | undefined;
}

export interface GuardedAutonomyDaemonRuntime {
  resume(
    autonomyRunId: string,
    decision?: ScopedApprovalDecisionType,
    options?: { recoveryKind?: "restart" },
  ): Promise<GuardedDeliveryResult>;
}

type LoopSessionStatus = "running" | "stopping" | "stopped" | "failed";

interface LoopSession {
  loopSessionId: string;
  workspacePath: string;
  stateFilePath: string;
  intervalMs: number;
  stopWhenIdle: boolean;
  status: LoopSessionStatus;
  startedAt: number;
  updatedAt: number;
  cycleCount: number;
  discoveredTaskCount: number;
  executedTaskCount: number;
  skippedTaskCount: number;
  successfulTaskCount: number;
  failedTaskCount: number;
  escalatedTaskCount: number;
  tokensConsumed: number;
  costConsumed: number;
  totalCycleDurationMs: number;
  failureStreaks: Record<string, LoopFailureStreak>;
  /** Consecutive cycles that executed tasks without a success (budget input). */
  noProgressCycles: number;
  abort: AbortController;
  maxCycles?: number;
  /** Latest budget check when runOptions.budget is configured. */
  lastBudgetCheck?: LoopBudgetStatus;
  lastCycleDurationMs?: number;
  lastJsonPath?: string;
  lastMarkdownPath?: string;
  lastError?: string;
  stopReason?: string;
  waitReason?: LoopRunResult["state"]["wait_reason"];
  runOptions: LoopRunOptions;
  scheduleExpression?: string;
  shutdownRequested?: boolean;
  done?: Promise<void>;
}

interface LoopFailureStreak {
  capability: string;
  count: number;
  lastTaskId: string;
  updatedAt: number;
  lastEscalatedAtCount?: number;
}

interface PersistedLoopSessionsFile {
  version: 1;
  sessions: PersistedLoopSession[];
}

interface PersistedLoopSession {
  loopSessionId: string;
  status: LoopSessionStatus;
  runOptions: LoopRunOptions;
  intervalMs: number;
  stopWhenIdle: boolean;
  scheduleExpression?: string;
  startedAt: number;
  updatedAt: number;
  cycleCount: number;
  discoveredTaskCount: number;
  executedTaskCount: number;
  skippedTaskCount: number;
  successfulTaskCount?: number;
  failedTaskCount?: number;
  escalatedTaskCount?: number;
  tokensConsumed?: number;
  costConsumed?: number;
  totalCycleDurationMs?: number;
  failureStreaks?: Record<string, LoopFailureStreak>;
  noProgressCycles?: number;
  lastBudgetCheck?: LoopBudgetStatus;
  maxCycles?: number;
  lastCycleDurationMs?: number;
  lastJsonPath?: string;
  lastMarkdownPath?: string;
  lastError?: string;
  stopReason?: string;
  waitReason?: LoopRunResult["state"]["wait_reason"];
}

// ──────────────────────────────────────────────────────────────────────
// Daily-brief sessions (R2.3) — a read-only composition scheduled through the
// daemon, modeled on the loop-session pattern above (own map + JSON file +
// atomic persist + restore-on-start). NOT a LoopEngine: daily just re-runs the
// `runDailyBrief` core on an interval and records the latest result.
// ──────────────────────────────────────────────────────────────────────

type DailySessionStatus = "running" | "stopping" | "stopped" | "failed";

interface DailySession {
  dailySessionId: string;
  /** Repo registry path, resolved at schedule time and stored (survives restart). */
  registryPath: string;
  intervalMs: number;
  /** Recorded verbatim for humans; the interval is what drives execution. */
  scheduleExpression?: string;
  status: DailySessionStatus;
  startedAt: number;
  updatedAt: number;
  tickCount: number;
  lastBriefPath?: string;
  /** Status field of the latest strict AgentCommandResult (e.g. "ok"), or "error". */
  lastResultStatus?: string;
  consecutiveFailureCount: number;
  lastError?: string;
  stopReason?: string;
  abort: AbortController;
  shutdownRequested?: boolean;
  done?: Promise<void>;
}

interface PersistedDailySessionsFile {
  version: 1;
  sessions: PersistedDailySession[];
}

interface PersistedDailySession {
  dailySessionId: string;
  registryPath: string;
  intervalMs: number;
  scheduleExpression?: string;
  status: DailySessionStatus;
  startedAt: number;
  updatedAt: number;
  tickCount: number;
  lastBriefPath?: string;
  lastResultStatus?: string;
  consecutiveFailureCount: number;
  lastError?: string;
  stopReason?: string;
}

function singleOk(id: DaemonRequest["id"], result: unknown): SingleResponse {
  return { id, ok: true, result };
}
function singleErr(id: DaemonRequest["id"], code: string, message: string): SingleResponse {
  return { id, ok: false, error: { code, message } };
}

const TERMINAL_SESSION_STATES = new Set(["completed", "failed", "cancelled"]);

function publicSession(row: ReturnType<SessionRepository["getSession"]>): Record<string, unknown> | null {
  if (row === undefined) return null;
  return {
    session_id: row.session_id,
    task_id: row.task_id,
    run_id: row.run_id,
    agent_id: row.agent_id,
    runtime_id: row.agent_id,
    state: row.state,
    resume_supported: row.resume_supported,
    resume_ready: row.resume_supported
      && row.native_session_id !== null
      && !TERMINAL_SESSION_STATES.has(row.state),
    version: row.version,
    updated_at: row.updated_at,
  };
}

function publicSessionWait(ctx: DaemonContext, sessionId: string) {
  const row = ctx.sessions.getSession(sessionId);
  if (row === undefined) return null;
  const snapshot = ctx.sessions.latestSnapshot(sessionId);
  const pending = ctx.db.prepare(`
    SELECT message_id, state FROM session_messages
    WHERE session_id = ? AND direction = 'inbound'
      AND (state = 'accepted' OR (state = 'failed' AND turn_id = ?))
    ORDER BY CASE WHEN state = 'accepted' THEN 0 ELSE 1 END, created_at DESC, message_id LIMIT 1
  `).get(sessionId, snapshot.turn_id) as { message_id: string; state: "accepted" | "failed" } | undefined;
  const wait = describeSessionWait({
    state: row.state,
    decision: snapshot.decision,
    resume_ready: row.resume_supported && row.native_session_id !== null,
    applying: ctx.activeSessionSends.has(sessionId),
    ...(pending === undefined ? {} : { pending_message: pending }),
  });
  const grant = ctx.continuations.forSession(sessionId);
  if (wait?.reason === "phase_continue" && grant?.status === "active"
    && Date.parse(grant.body.expires_at) > Date.now()
    && ctx.collaborator?.isScheduled(grant.grant_id)) {
    return { ...wait, automatic_continuation: true, grant_id: grant.grant_id };
  }
  return wait;
}

function publicCollaborator(ctx: DaemonContext, sessionId: string) {
  const grant = ctx.continuations.forSession(sessionId);
  return grant === undefined ? null : {
    grant_id: grant.grant_id, status: grant.status, reason: grant.reason,
    step_index: grant.step_index, steps_total: grant.body.steps.length,
    checks_used: grant.checks_used, max_checks: grant.body.max_checks,
    resumes_used: grant.resumes_used, max_resumes: grant.body.max_resumes,
    expires_at: grant.body.expires_at,
    scheduled: ctx.collaborator?.isScheduled(grant.grant_id) ?? false,
  };
}

type DecisionRequestedEvent = Extract<AgentSessionEvent, { type: "decision.requested" }>;

function parseDecisionDirective(text: string): DecisionRequestedEvent | undefined {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof root !== "object" || root === null || Array.isArray(root)) return undefined;
  const outer = root as Record<string, unknown>;
  if (Object.keys(outer).length !== 1 || !("ostag_decision" in outer)) return undefined;
  const parsed = SessionDecision.safeParse(outer["ostag_decision"]);
  return parsed.success ? { type: "decision.requested", ...parsed.data } : undefined;
}

interface SessionSendParams {
  session_id: string;
  runtime_id: string;
  turn_id: string;
  message_id: string;
  expected_version: number;
  text: string;
  requested_by?: string;
}

interface SessionStartParams {
  request_id: string;
  prompt: string;
  title: string;
  agent_id: string;
  repo_path: string;
}

function parseSessionStartParams(value: unknown): SessionStartParams | Error {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return new Error("params must be an object");
  }
  const p = value as Record<string, unknown>;
  if (typeof p["request_id"] !== "string" || p["request_id"].trim() === "" || p["request_id"].length > 256) {
    return new Error("params.request_id must be a non-empty string of at most 256 characters");
  }
  if (typeof p["prompt"] !== "string" || p["prompt"].trim() === "" || p["prompt"].length > 16_000) {
    return new Error("params.prompt must be between 1 and 16000 characters");
  }
  if (typeof p["title"] !== "string" || p["title"].trim() === "" || p["title"].length > 160) {
    return new Error("params.title must be between 1 and 160 characters");
  }
  if (typeof p["agent_id"] !== "string" || p["agent_id"].trim() === "" || p["agent_id"].length > 256) {
    return new Error("params.agent_id must be a non-empty string of at most 256 characters");
  }
  if (typeof p["repo_path"] !== "string" || !isAbsolute(p["repo_path"]) || p["repo_path"].length > 4096) {
    return new Error("params.repo_path must be an absolute path of at most 4096 characters");
  }
  return {
    request_id: p["request_id"],
    prompt: p["prompt"],
    title: p["title"],
    agent_id: p["agent_id"],
    repo_path: p["repo_path"],
  };
}

async function handleSessionStart(
  ctx: DaemonContext,
  req: DaemonRequest,
): Promise<SingleResponse> {
  const p = parseSessionStartParams(req.params);
  if (p instanceof Error) return singleErr(req.id, "bad_request", p.message);
  if (ctx.draining) return singleErr(req.id, "draining", "daemon is not accepting new sessions");

  const adapter = ctx.adapters.get(p.agent_id);
  if (adapter === undefined || !isSessionCapableAdapter(adapter)) {
    return singleErr(req.id, "resume_unsupported", "agent does not support resumable sessions");
  }
  const capabilities = adapter.sessionCapabilities();
  if (!capabilities.resume) {
    return singleErr(req.id, "resume_unsupported", "agent does not support resume");
  }
  const availability = await adapter.isAvailable();
  if (!availability.available) {
    return singleErr(req.id, "agent_unavailable", "agent is unavailable");
  }

  const now = Date.now() / 1000;
  const stableId = createHash("sha256").update(p.request_id).digest("hex").slice(0, 24);
  const taskId = `task_${stableId}`;
  const runId = `run_${stableId}`;
  const sessionId = `sess_${stableId}`;
  const turnId = `turn_${randomUUID()}`;
  const requestSha256 = createHash("sha256").update(JSON.stringify({
    request_id: p.request_id,
    prompt: p.prompt,
    title: p.title,
    agent_id: p.agent_id,
    repo_path: p.repo_path,
  })).digest("hex");
  const existing = ctx.sessions.getSession(sessionId);
  if (existing !== undefined) {
    if (existing.request_sha256 !== requestSha256) {
      return singleErr(
        req.id,
        "request_id_conflict",
        "request_id was already used for a different session request",
      );
    }
    const snapshot = ctx.sessions.latestSnapshot(sessionId);
    return singleOk(req.id, {
      ...publicSession(existing),
      ...snapshot,
      events: [],
    });
  }
  try {
    ctx.db.transaction(() => {
      insertTask(ctx.db, ctx.dbPath, { task_id: taskId, title: p.title, created_at: now });
      insertRun(ctx.db, ctx.dbPath, {
        run_id: runId,
        task_id: taskId,
        session_id: sessionId,
        agent_id: adapter.id,
        capability_id: `${adapter.id}.session`,
        phase: "code",
        started_at: now,
      });
      ctx.sessions.createSession({
        session_id: sessionId,
        task_id: taskId,
        run_id: runId,
        agent_id: adapter.id,
        request_sha256: requestSha256,
        native_session_id: null,
        repo_path: p.repo_path,
        state: "starting",
        resume_supported: true,
        version: 1,
        updated_at: now,
      });
      ctx.kanban.createCard({
        card_id: `card_${runId}`,
        task_id: taskId,
        title: p.title,
        body: `agent: ${adapter.id}\ncapability: resumable-session`,
        status: "running",
        assignee: adapter.id,
      });
    })();
  } catch {
    return singleErr(req.id, "store_write_failed", "could not create resumable session");
  }

  const controller = new AbortController();
  ctx.activeRuns.set(runId, controller);
  const task: AgentTask = {
    run_id: runId,
    task_id: taskId,
    session_id: sessionId,
    capability_id: `${adapter.id}.session`,
    prompt: p.prompt,
    context: { repo_path: p.repo_path },
  };
  const publicEvents: AgentSessionEvent[] = [];
  let nativeSessionId: string | undefined;
  let assistantText = "";
  let decision: unknown = null;
  try {
    for await (const rawEvent of adapter.startSession(task, controller.signal)) {
      const event = AgentSessionEventSchema.parse(rawEvent);
      if (event.type === "native_session.started") {
        if (nativeSessionId !== undefined && nativeSessionId !== event.native_session_id) {
          throw new Error("adapter changed native session id");
        }
        nativeSessionId = event.native_session_id;
        continue;
      }
      if (nativeSessionId !== undefined && JSON.stringify(event).includes(nativeSessionId)) {
        throw new Error("adapter output contained protected session metadata");
      }
      if (event.type === "assistant.message") {
        // Controlled results are opaque data; their adapter emits decisions separately.
        const directive = isControlledSessionAdapter(adapter) ? undefined : parseDecisionDirective(event.text);
        if (directive !== undefined) {
          publicEvents.push(directive);
          decision = {
            decision_id: directive.decision_id,
            question: directive.question,
            choices: directive.choices,
            ...(directive.continuation === undefined ? {} : { continuation: directive.continuation }),
          };
          assistantText = directive.question;
          continue;
        }
        assistantText += event.text;
      }
      publicEvents.push(event);
      if (assistantText.length > 4_000) throw new Error("assistant output exceeded relay bound");
      if (event.type === "decision.requested") decision = {
        decision_id: event.decision_id,
        question: event.question,
        choices: event.choices,
        ...(event.continuation === undefined ? {} : { continuation: event.continuation }),
      };
      if (event.type === "session.terminal" && event.state !== "completed") {
        throw new Error("adapter terminated while starting the session");
      }
    }
    if (nativeSessionId === undefined) throw new Error("adapter did not return a native session id");

    const confirmedNativeSessionId = nativeSessionId;
    const finalState = decision === null ? "idle" : "awaiting_decision";
    const completedAt = Date.now() / 1000;
    const updated = ctx.db.transaction(() => {
      const recorded = ctx.sessions.recordNativeSession(
        sessionId,
        confirmedNativeSessionId,
        1,
        completedAt,
      );
      ctx.sessions.appendTurn({
        turn_id: turnId,
        session_id: sessionId,
        ordinal: 1,
        state: finalState,
        assistant_text: assistantText,
        decision,
        created_at: now,
        updated_at: completedAt,
      });
      const session = ctx.sessions.setState(
        sessionId,
        finalState,
        recorded.version,
        completedAt,
      );
      finalizeRun(ctx.db, ctx.dbPath, runId, "completed", completedAt);
      ctx.kanban.moveCard(`card_${runId}`, "done", { actor: adapter.id });
      return session;
    })();
    return singleOk(req.id, {
      ...publicSession(updated),
      turn_id: turnId,
      assistant_text: assistantText,
      decision,
      events: publicEvents,
    });
  } catch {
    try {
      const current = ctx.sessions.getSession(sessionId);
      if (current !== undefined) {
        ctx.sessions.setState(sessionId, "failed", current.version, Date.now() / 1000);
      }
      finalizeRun(ctx.db, ctx.dbPath, runId, "failed", Date.now() / 1000);
      ctx.kanban.moveCard(`card_${runId}`, "blocked", { actor: adapter.id, blocked_reason: "session start failed" });
    } catch { /* preserve the original bounded failure */ }
    return singleErr(req.id, "agent_failed", "agent failed while starting the session");
  } finally {
    ctx.activeRuns.delete(runId);
  }
}

function parseSessionSendParams(value: unknown): SessionSendParams | Error {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return new Error("params must be an object");
  }
  const p = value as Record<string, unknown>;
  for (const key of ["session_id", "runtime_id", "turn_id", "message_id"] as const) {
    if (typeof p[key] !== "string" || p[key].trim() === "" || p[key].length > 256) {
      return new Error(`params.${key} must be a non-empty string of at most 256 characters`);
    }
  }
  if (!Number.isInteger(p["expected_version"]) || (p["expected_version"] as number) < 1) {
    return new Error("params.expected_version must be a positive integer");
  }
  if (typeof p["text"] !== "string" || p["text"].trim() === "" || p["text"].length > 16_000) {
    return new Error("params.text must be between 1 and 16000 characters");
  }
  if (p["requested_by"] !== undefined && (
    typeof p["requested_by"] !== "string"
    || p["requested_by"].trim() === ""
    || p["requested_by"].length > 256
  )) {
    return new Error("params.requested_by must be a non-empty string of at most 256 characters");
  }
  return {
    session_id: p["session_id"] as string,
    runtime_id: p["runtime_id"] as string,
    turn_id: p["turn_id"] as string,
    message_id: p["message_id"] as string,
    expected_version: p["expected_version"] as number,
    text: p["text"] as string,
    ...(p["requested_by"] === undefined ? {} : { requested_by: p["requested_by"] as string }),
  };
}

async function handleSessionSend(
  ctx: DaemonContext,
  req: DaemonRequest,
): Promise<SingleResponse> {
  const p = parseSessionSendParams(req.params);
  if (p instanceof Error) return singleErr(req.id, "bad_request", p.message);
  // Completed receipt replay remains read-only while drained; no new/retried
  // instruction may reserve a message or invoke an adapter during an upgrade.
  if (ctx.draining && ctx.sessions.getMessage(p.message_id)?.state !== "applied") {
    return singleErr(req.id, "draining", "daemon is not accepting session instructions");
  }

  const session = ctx.sessions.getSession(p.session_id);
  if (session === undefined) return singleErr(req.id, "not_found", "session not found");
  if (p.runtime_id !== session.agent_id) {
    return singleErr(req.id, "runtime_mismatch", "session belongs to another runtime");
  }
  // Idempotency wins over moving state: a retry may arrive after the first
  // delivery already appended a newer turn or completed the conversation.
  // Let the repository compare the complete canonical envelope before any
  // current-turn/current-state guards reject it.
  const existingMessage = ctx.sessions.getMessage(p.message_id);
  let recoveredReservationVersion: number | undefined;
  if (existingMessage !== undefined) {
    try {
      const replay = ctx.sessions.applyInbound({
        message_id: p.message_id,
        session_id: p.session_id,
        turn_id: p.turn_id,
        direction: "inbound",
        kind: "instruction.send",
        payload: { text: p.text, ...(p.requested_by === undefined ? {} : { requested_by: p.requested_by }) },
        state: "accepted",
        created_at: Date.now() / 1000,
      }, p.expected_version, Date.now() / 1000);
      if (existingMessage.state === "applied") {
        return singleOk(req.id, { state: replay.outcome, session_version: replay.session_version });
      }
      if (replay.session_version !== p.expected_version + 1) {
        return singleErr(req.id, "version_conflict", "accepted message cannot be recovered safely");
      }
      if (existingMessage.state === "accepted") {
        return ctx.activeSessionSends.has(session.session_id)
          ? singleErr(req.id, "session_busy", "session is already applying another instruction")
          : singleErr(
              req.id,
              "delivery_uncertain",
              "the previous delivery may have reached the agent; inspect the session before using a new message_id",
            );
      }
      if (existingMessage.state !== "failed") {
        return singleErr(req.id, "version_conflict", "reserved message is not retryable");
      }
      ctx.sessions.retryFailedMessage(p.message_id);
      recoveredReservationVersion = replay.session_version;
    } catch (err) {
      if (err instanceof SessionMessageIdConflict) {
        return singleErr(req.id, "message_id_conflict", "message_id was already used for different content");
      }
      throw err;
    }
  }
  if (recoveredReservationVersion === undefined && TERMINAL_SESSION_STATES.has(session.state)) {
    return singleErr(req.id, "session_terminal", `session state=${session.state}`);
  }
  if (!session.resume_supported || session.native_session_id === null) {
    return singleErr(req.id, "resume_unsupported", "session cannot be resumed");
  }
  const snapshot = ctx.sessions.latestSnapshot(p.session_id);
  if (recoveredReservationVersion === undefined && snapshot.turn_id !== p.turn_id) {
    return singleErr(req.id, "turn_conflict", "message does not target the current turn");
  }
  const adapter = ctx.adapters.get(session.agent_id);
  if (adapter === undefined || !isSessionCapableAdapter(adapter) || !adapter.sessionCapabilities().resume) {
    return singleErr(req.id, "resume_unsupported", "agent does not support resume");
  }
  if (ctx.activeSessionSends.has(session.session_id)) {
    return singleErr(req.id, "session_busy", "session is already applying another instruction");
  }

  let applied: { outcome: "applied" | "duplicate"; session_version: number };
  const now = Date.now() / 1000;
  if (recoveredReservationVersion !== undefined) {
    applied = { outcome: "applied", session_version: recoveredReservationVersion };
  } else {
    try {
      applied = reserveSessionInstruction(ctx.db, ctx.dbPath, {
        message_id: p.message_id,
        session_id: p.session_id,
        turn_id: p.turn_id,
        direction: "inbound",
        kind: "instruction.send",
        payload: { text: p.text, ...(p.requested_by === undefined ? {} : { requested_by: p.requested_by }) },
        state: "accepted",
        created_at: now,
      }, p.expected_version, now);
    } catch (err) {
      if (err instanceof SessionVersionConflict) {
        return singleErr(req.id, "version_conflict", "session version changed; refresh before retrying");
      }
      if (err instanceof SessionMessageIdConflict) {
        return singleErr(req.id, "message_id_conflict", "message_id was already used for different content");
      }
      throw err;
    }
  }
  if (applied.outcome === "duplicate") {
    return singleOk(req.id, { state: "duplicate", session_version: applied.session_version });
  }

  return await executeReservedSessionTurn(ctx, req, p, session, adapter, applied.session_version);
}

/** Private port: only an already persisted reservation may invoke the runtime. */
async function executeReservedSessionTurn(
  ctx: DaemonContext,
  req: DaemonRequest,
  p: SessionSendParams,
  session: NonNullable<ReturnType<SessionRepository["getSession"]>>,
  adapter: SessionCapableAdapter,
  reservationVersion: number,
  options: {
    controller?: AbortController;
    completed?: (turnId: string, version: number, now: number) => void;
  } = {},
): Promise<SingleResponse> {
  if (session.native_session_id === null) return singleErr(req.id, "resume_unsupported", "session cannot resume");
  const applied = { session_version: reservationVersion };
  ctx.activeSessionSends.add(session.session_id);
  const controller = options.controller ?? new AbortController();
  const now = Date.now() / 1000;
  ctx.activeRuns.set(session.run_id, controller);
  try {
    const failReservedMessage = (
      code: string,
      message: string,
    ): SingleResponse => {
      try {
        ctx.sessions.markMessageFailed(p.message_id);
      } catch {
        return singleErr(
          req.id,
          "delivery_uncertain",
          "the agent failed and the reservation could not be finalized; inspect the session before retrying",
        );
      }
      return singleErr(req.id, code, message);
    };
    const context: Record<string, unknown> = {};
    if (session.repo_path !== "") context["repo_path"] = session.repo_path;
    if (p.requested_by !== undefined) context["requested_by"] = p.requested_by;
    const input: AgentSessionInput = {
      session_id: session.session_id,
      task_id: session.task_id,
      run_id: session.run_id,
      turn_id: p.turn_id,
      native_session_id: session.native_session_id,
      expected_version: applied.session_version,
      message_id: p.message_id,
      prompt: p.text,
      ...(Object.keys(context).length === 0 ? {} : { context }),
    };
    const publicEvents: AgentSessionEvent[] = [];
    let assistantText = "";
    let decision: unknown = null;
    let terminalCompleted = false;
    try {
      for await (const rawEvent of adapter.resumeSession(input, controller.signal)) {
        const event = AgentSessionEventSchema.parse(rawEvent);
        if (event.type === "native_session.started") {
          if (event.native_session_id !== session.native_session_id) {
            return failReservedMessage(
              "adapter_protocol",
              "agent resumed an unexpected native session",
            );
          }
          continue;
        }
        if (JSON.stringify(event).includes(session.native_session_id)) {
          return failReservedMessage(
            "adapter_protocol",
            "agent output contained protected session metadata",
          );
        }
        if (event.type === "session.terminal") {
          if (event.state !== "completed") {
            const rawCode = event.error_code ?? "unknown";
            const safeCode = /^[a-z0-9_]{1,64}$/.test(rawCode) ? rawCode : "unknown";
            return failReservedMessage(
              "agent_failed",
              `agent failed while applying the instruction (${safeCode})`,
            );
          }
          terminalCompleted = true;
        }
        if (event.type === "assistant.message") {
          // Controlled results are opaque data; their adapter emits decisions separately.
          const directive = isControlledSessionAdapter(adapter) ? undefined : parseDecisionDirective(event.text);
          if (directive !== undefined) {
            publicEvents.push(directive);
            decision = {
              decision_id: directive.decision_id,
              question: directive.question,
              choices: directive.choices,
              ...(directive.continuation === undefined ? {} : { continuation: directive.continuation }),
            };
            assistantText = directive.question;
            continue;
          }
          assistantText += event.text;
        }
        publicEvents.push(event);
        if (event.type === "decision.requested") decision = {
          decision_id: event.decision_id,
          question: event.question,
          choices: event.choices,
          ...(event.continuation === undefined ? {} : { continuation: event.continuation }),
        };
      }
      if (!terminalCompleted) {
        return failReservedMessage(
          "agent_failed",
          "agent ended without completing the instruction",
        );
      }
    } catch {
      return failReservedMessage(
        "agent_failed",
        "agent failed while applying the instruction",
      );
    }

    const finalState = publicEvents.some((event) => event.type === "decision.requested")
      ? "awaiting_decision"
      : "idle";
    const completedAt = Date.now() / 1000;
    const turnId = `turn_${randomUUID()}`;
    const updatedSession = ctx.db.transaction(() => {
      const updated = ctx.sessions.completeInboundTurn({
        turn: {
          turn_id: turnId,
          session_id: session.session_id,
          ordinal: (ctx.db.prepare(
            "SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal FROM session_turns WHERE session_id = ?",
          ).get(session.session_id) as { ordinal: number }).ordinal,
          state: finalState,
          assistant_text: assistantText,
          decision,
          created_at: now,
          updated_at: completedAt,
        },
        message_id: p.message_id,
        expected_version: applied.session_version,
        applied_at: completedAt,
      });
      options.completed?.(turnId, updated.version, completedAt);
      return updated;
    })();
    return singleOk(req.id, {
      state: "applied",
      session_version: updatedSession.version,
      events: publicEvents,
    });
  } finally {
    ctx.activeSessionSends.delete(session.session_id);
    if (ctx.activeRuns.get(session.run_id) === controller) ctx.activeRuns.delete(session.run_id);
  }
}

// ──────────────────────────────────────────────────────────────────────
// Single-shot methods
// ──────────────────────────────────────────────────────────────────────

async function handleSingle(ctx: DaemonContext, req: DaemonRequest): Promise<SingleResponse | null> {
  if (req.method.startsWith("attention.")) {
    if (!ctx.supervision) return singleErr(req.id,"attention_disabled","Start daemon with OSSTACK_ATTENTION=1 to opt in");
    if (ctx.draining) return singleErr(req.id,"draining","Daemon is draining");
    try {
      if (req.method === "attention.answer") {
        const p=req.params as {scope_id:string;item_id:string;action_id:string;revision:number;content_hash:string;text:string;takeover:boolean};
        if (!p || typeof p.takeover!=="boolean" || typeof p.text!=="string")throw new Error("bad_request");
        const item=ctx.supervision.store.getItem(p.scope_id,p.item_id);if(!item)throw new Error("not_found");
        const session=ctx.sessions.getSession(item.session_id);if(!session)throw new Error("source_missing");
        const adapter=ctx.adapters.get(session.agent_id);
        if(!session.resume_supported||!session.native_session_id||!adapter||!isSessionCapableAdapter(adapter)||!adapter.sessionCapabilities().resume)throw new Error("resume_unsupported");
        if(ctx.activeSessionSends.has(session.session_id))throw new Error("session_busy");
        const actions=new AttentionActions(ctx.supervision.store,ctx.supervision.observer.owner);
        const action=actions.reserve(p);
        if(action.replay)return singleOk(req.id,action);
        await executeReservedSessionTurn(ctx,req,{session_id:session.session_id,runtime_id:session.agent_id,turn_id:item.turn_id,message_id:action.message_id,expected_version:action.reservation_version-1,text:p.text},session,adapter,action.reservation_version);
        return singleOk(req.id,actions.reconcile(action));
      }
      return singleOk(req.id,ctx.supervision.handle(req.method,req.params));
    } catch(error) {return singleErr(req.id,error instanceof Error?error.message:"attention_error","Attention request failed; refresh source facts before retrying");}
  }
  switch (req.method) {
    case "version":
      return singleOk(req.id, {
        version: DAEMON_VERSION,
        phase: DAEMON_PHASE,
        protocol_version: PROTOCOL_VERSION,
      });

    case "health": {
      const update = readUpdateCache();
      return singleOk(req.id, {
        version: DAEMON_VERSION,
        phase: DAEMON_PHASE,
        protocol_version: PROTOCOL_VERSION,
        pid: process.pid,
        uptime_s: Math.round(process.uptime()),
        memory_rss_mb: Math.round(process.memoryUsage.rss() / 1024 / 1024),
        db_path: ctx.dbPath,
        adapters: Array.from(ctx.adapters.keys()),
        active_runs: ctx.activeRuns.size,
        draining: ctx.draining,
        concurrency: {
          writes: {
            limit: ctx.writeSemaphore.capacity,
            active: ctx.writeSemaphore.in_use,
            queued: ctx.writeSemaphore.pending,
          },
          reads: {
            limit: ctx.readSemaphore.capacity,
            active: ctx.readSemaphore.in_use,
            queued: ctx.readSemaphore.pending,
          },
          repository_write_queues: ctx.repoWriteSemaphores.size,
        },
        active_loops: activeLoopCount(ctx),
        otel_enabled: otelEnabled(),
        hermes_enabled: ctx.hermes.enabled,
        gbrain_enabled: ctx.gbrain.enabled,
        dashboard_url: ctx.dashboardUrl,
        update_available: update?.update_available ?? false,
        latest_version: update?.latest ?? null,
      });
    }

    case "update.status":
      return singleOk(req.id, {
        current: DAEMON_VERSION,
        cache: readUpdateCache(),
      });

    case "daemon.drain": {
      // Stop accepting new tasks, then wait (bounded) for active runs to end.
      // Used by `osstack upgrade` so a release never kills work mid-flight.
      const p = (req.params ?? {}) as { timeout_ms?: number };
      const timeoutMs = Math.min(Math.max(p.timeout_ms ?? 30_000, 0), 300_000);
      ctx.draining = true;
      ctx.drainingFromHealth = false;
      const deadline = Date.now() + timeoutMs;
      while (ctx.activeRuns.size > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
      }
      return singleOk(req.id, {
        draining: true,
        drained: ctx.activeRuns.size === 0,
        active_runs: ctx.activeRuns.size,
      });
    }

    case "daemon.resume":
      ctx.draining = false;
      ctx.drainingFromHealth = false;
      ctx.collaborator?.resumePending();
      return singleOk(req.id, { draining: false });

    case "daemon.shutdown":
      // Respond first, then exit on the next tick so the frame gets flushed.
      setTimeout(() => ctx.requestShutdown(), 50);
      return singleOk(req.id, { shutting_down: true, pid: process.pid });

    case "agent.list":
      return singleOk(
        req.id,
        await Promise.all(
          Array.from(ctx.adapters.values()).map(async (a) => ({
            id: a.id,
            display_name: a.display_name,
            cost_tier: a.cost_tier,
            available: await a.isAvailable(),
            capabilities: a.capabilities().map((c) => ({ id: c.id, kind: c.kind })),
          })),
        ),
      );

    case "run.status": {
      const p = (req.params ?? {}) as { run_id?: string };
      if (typeof p.run_id !== "string") return singleErr(req.id, "bad_request", "params.run_id required");
      const row = ctx.db.prepare(
        `SELECT r.run_id, r.task_id, r.session_id, r.agent_id, r.capability_id, r.phase,
                r.outcome, r.started_at, r.completed_at, r.duration_ms,
                r.tokens_in, r.tokens_out, r.retry_count, r.human_intervention_count,
                r.pii_redacted_count, t.title, t.status AS task_status
         FROM runs r JOIN tasks t ON t.task_id = r.task_id
         WHERE r.run_id = ?`,
      ).get(p.run_id);
      if (row === undefined) return singleErr(req.id, "not_found", `no run with id=${p.run_id}`);
      const active = ctx.activeRuns.has(p.run_id);
      return singleOk(req.id, { ...(row as object), active });
    }

    case "session.list": {
      const p = (req.params ?? {}) as { limit?: number };
      const limit = p.limit ?? 100;
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        return singleErr(req.id, "bad_request", "params.limit must be an integer between 1 and 200");
      }
      return singleOk(req.id, {
        sessions: ctx.sessions.listSessions({ limit }).map((row) => ({
          ...publicSession(row), wait: publicSessionWait(ctx, row.session_id), collaborator: publicCollaborator(ctx, row.session_id),
        })),
      });
    }

    case "session.start":
      return await handleSessionStart(ctx, req);

    case "session.status": {
      const p = (req.params ?? {}) as { session_id?: string };
      if (typeof p.session_id !== "string" || p.session_id.trim() === "") {
        return singleErr(req.id, "bad_request", "params.session_id required");
      }
      const session = publicSession(ctx.sessions.getSession(p.session_id));
      return session === null
        ? singleErr(req.id, "not_found", "session not found")
        : singleOk(req.id, { ...session, wait: publicSessionWait(ctx, p.session_id), collaborator: publicCollaborator(ctx, p.session_id) });
    }

    case "session.snapshot": {
      const p = (req.params ?? {}) as { session_id?: string };
      if (typeof p.session_id !== "string" || p.session_id.trim() === "") {
        return singleErr(req.id, "bad_request", "params.session_id required");
      }
      if (ctx.sessions.getSession(p.session_id) === undefined) {
        return singleErr(req.id, "not_found", "session not found");
      }
      return singleOk(req.id, {
        ...ctx.sessions.latestSnapshot(p.session_id),
        wait: publicSessionWait(ctx, p.session_id),
        collaborator: publicCollaborator(ctx, p.session_id),
      });
    }

    case "collaborator.inspect": {
      const p = req.params as Record<string, unknown> | undefined;
      if (typeof p?.["session_id"] !== "string") return singleErr(req.id, "bad_request", "session_id is required");
      const session = ctx.sessions.getSession(p["session_id"]);
      if (session === undefined) return singleErr(req.id, "not_found", "session not found");
      try {
        const policy = await ctx.collaborator!.policy(session.agent_id);
        return singleOk(req.id, {
          ...ctx.sessions.latestSnapshot(session.session_id), repo_path: session.repo_path,
          runtime_policy: policy, collaborator: ctx.continuations.forSession(session.session_id) ?? null,
        });
      } catch { return singleErr(req.id, "controlled_runtime_required", "start a claude-controlled-session before installing a continuation grant"); }
    }
    case "collaborator.install": {
      try { return singleOk(req.id, await ctx.collaborator!.install(req.params)); }
      catch { return singleErr(req.id, "grant_rejected", "grant signature, runtime policy, session cursor, or time window is invalid; inspect the session and signed grant"); }
    }
    case "collaborator.status":
    case "collaborator.revoke": {
      const p = req.params as Record<string, unknown> | undefined;
      if (typeof p?.["grant_id"] !== "string") return singleErr(req.id, "bad_request", "grant_id is required");
      const grant = ctx.continuations.get(p["grant_id"]);
      if (grant === undefined) return singleErr(req.id, "not_found", "grant not found");
      return singleOk(req.id, req.method === "collaborator.revoke" ? ctx.collaborator!.revoke(p["grant_id"]) : grant);
    }

    case "session.send":
      return await handleSessionSend(ctx, req);

    case "task.cancel": {
      const p = (req.params ?? {}) as { run_id?: string };
      if (typeof p.run_id !== "string") return singleErr(req.id, "bad_request", "params.run_id required");
      const ac = ctx.activeRuns.get(p.run_id);
      if (!ac) return singleErr(req.id, "not_active", `run_id=${p.run_id} is not currently active`);
      ac.abort();
      return singleOk(req.id, { cancelled: true, run_id: p.run_id });
    }

    case "stats":
      return singleOk(req.id, computeStats(ctx.db, ctx.loopSessions, ctx.rpcLatency));

    case "autonomy.status": {
      const params = (req.params ?? {}) as { autonomy_run_id?: unknown };
      if (
        typeof params.autonomy_run_id !== "string"
        || params.autonomy_run_id.length === 0
      ) {
        return singleErr(
          req.id,
          "bad_request",
          "params.autonomy_run_id required",
        );
      }
      const row = getAutonomyRun(ctx.db, params.autonomy_run_id);
      return row === undefined
        ? singleErr(
            req.id,
            "not_found",
            `no autonomy run with id=${params.autonomy_run_id}`,
          )
        : singleOk(req.id, row);
    }

    case "autonomy.health": {
      try {
        const report = await ctx.autonomyHealth();
        ctx.lastAutonomyHealth = report;
        applyAutonomyDrainSignal(ctx, report.drain_required);
        return singleOk(req.id, report);
      } catch (error) {
        return singleErr(
          req.id,
          "autonomy_health_failed",
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    case "autonomy.resume": {
      if (ctx.guardedAutonomy === undefined) {
        return singleErr(
          req.id,
          "unavailable",
          "guarded autonomy runtime is not configured",
        );
      }
      const params = (req.params ?? {}) as {
        autonomy_run_id?: unknown;
        decision?: unknown;
      };
      if (
        typeof params.autonomy_run_id !== "string"
        || params.autonomy_run_id.length === 0
      ) {
        return singleErr(
          req.id,
          "bad_request",
          "params.autonomy_run_id required",
        );
      }
      const parsedDecision =
        params.decision === undefined
          ? undefined
          : ScopedApprovalDecision.safeParse(params.decision);
      if (
        parsedDecision !== undefined
        && !parsedDecision.success
      ) {
        return singleErr(
          req.id,
          "bad_request",
          "params.decision must be a valid signed scoped approval",
        );
      }
      try {
        return singleOk(
          req.id,
          await resumeGuardedAutonomy(
            ctx,
            params.autonomy_run_id,
            parsedDecision?.data,
          ),
        );
      } catch (error) {
        return singleErr(
          req.id,
          "autonomy_resume_failed",
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    case "loop.run": {
      const parsed = parseLoopRunParams(req.params);
      if (parsed instanceof Error) return singleErr(req.id, "bad_request", parsed.message);
      const engine = new LoopEngine(withLoopAdapters(ctx, parsed.runOptions));
      if (parsed.cyclesOptions === undefined) {
        const raw = await engine.runOnce();
        // Kernel gate (R2.2): the engine consulted the injected policy gate at
        // entry. A deny (e.g. mode: observe) refuses before any work — surface
        // it as a `policy_denied` RPC error (A-006 blocked code), no evidence.
        if (raw.policy?.denied === true) {
          return singleErr(req.id, "policy_denied", raw.policy.reason);
        }
        const knowledgeHygiene = await finalizeLoopKnowledgeHygiene(
          parsed.neatFinalize,
          parsed.runOptions.workspacePath ?? process.cwd(),
          raw,
        );
        const runId = persistLoopRunEvidence(ctx, raw);
        return singleOk(req.id, loopRunSummary(raw, runId, knowledgeHygiene));
      }
      const raw = await engine.runCycles(parsed.cyclesOptions);
      if (raw.policy?.denied === true) {
        return singleErr(req.id, "policy_denied", raw.policy.reason);
      }
      const knowledgeHygiene = await finalizeLoopKnowledgeHygiene(
        parsed.neatFinalize,
        parsed.runOptions.workspacePath ?? process.cwd(),
        raw,
      );
      const runId = persistLoopRunEvidence(ctx, raw);
      return singleOk(req.id, loopRunCyclesSummary(raw, runId, knowledgeHygiene));
    }

    case "loop.start": {
      const parsed = parseLoopStartParams(req.params);
      if (parsed instanceof Error) return singleErr(req.id, "bad_request", parsed.message);
      return singleOk(req.id, await startLoopSession(ctx, parsed.runOptions, parsed.schedule));
    }

    case "loop.list":
      return singleOk(req.id, {
        loops: Array.from(ctx.loopSessions.values()).map(loopSessionSummary),
      });

    case "loop.stop": {
      const p = objectParams(req.params);
      if (p instanceof Error) return singleErr(req.id, "bad_request", p.message);
      const loopSessionId = optionalString(p, "loopSessionId");
      if (loopSessionId === undefined) return singleErr(req.id, "bad_request", "params.loopSessionId required");
      const session = ctx.loopSessions.get(loopSessionId);
      if (session === undefined) return singleErr(req.id, "not_found", `no loop session with id=${loopSessionId}`);
      stopLoopSession(session, "stopped by request");
      await persistLoopSessions(ctx);
      return singleOk(req.id, loopSessionSummary(session));
    }

    case "daily.schedule": {
      const parsed = parseDailyScheduleParams(req.params);
      if (parsed instanceof Error) return singleErr(req.id, "bad_request", parsed.message);
      return singleOk(req.id, await startDailySession(ctx, parsed));
    }

    case "daily.list":
      return singleOk(req.id, {
        daily: Array.from(ctx.dailySessions.values()).map(dailySessionSummary),
      });

    case "daily.stop": {
      const p = objectParams(req.params);
      if (p instanceof Error) return singleErr(req.id, "bad_request", p.message);
      const dailySessionId = optionalString(p, "dailySessionId");
      if (dailySessionId === undefined) return singleErr(req.id, "bad_request", "params.dailySessionId required");
      const session = ctx.dailySessions.get(dailySessionId);
      if (session === undefined) return singleErr(req.id, "not_found", `no daily session with id=${dailySessionId}`);
      stopDailySession(session, "stopped by request");
      await persistDailySessions(ctx);
      return singleOk(req.id, dailySessionSummary(session));
    }

    case "loop.status": {
      const parsed = parseLoopStatusParams(req.params);
      if (parsed instanceof Error) return singleErr(req.id, "bad_request", parsed.message);
      const state = await readLoopState(parsed.stateFilePath);
      if (state !== null) {
        return singleOk(req.id, {
          state,
          state_json: parsed.stateFilePath,
          markdown: renderLoopStateMarkdown(state),
        });
      }
      const markdownPath = parsed.stateFilePath.endsWith(".json")
        ? parsed.stateFilePath.replace(/[^/]+$/, "STATE.md")
        : join(parsed.workspacePath, "STATE.md");
      try {
        return singleOk(req.id, {
          state: null,
          state_json: parsed.stateFilePath,
          state_markdown: markdownPath,
          markdown: await readFile(markdownPath, "utf-8"),
        });
      } catch {
        return singleErr(req.id, "not_found", `no loop state found at ${parsed.stateFilePath}`);
      }
    }

    case "hermes.health":
      return singleOk(req.id, {
        enabled: ctx.hermes.enabled,
        bin: ctx.hermes.bin,
        board: ctx.hermes.board,
        check: await ctx.hermes.healthCheck(),
        active_kanban_links: ctx.hermesKanbanByRun.size,
      });

    case "dashboard.url":
      return singleOk(req.id, {
        url: ctx.dashboardUrl,
        available: ctx.dashboardUrl !== null,
      });

    case "dashboard.snapshot": {
      const p = objectParams(req.params);
      if (p instanceof Error) return singleErr(req.id, "bad_request", p.message);
      const workspacePath = optionalString(p, "workspacePath");
      return singleOk(req.id, createDashboardSnapshot({
        db: ctx.db,
        kanban: ctx.kanban,
        dbPath: ctx.dbPath,
        ...(workspacePath === undefined ? {} : { workspacePath: resolve(workspacePath) }),
        version: DAEMON_VERSION,
        phase: DAEMON_PHASE,
        dashboardUrl: ctx.dashboardUrl ?? dashboardUrl(dashboardUrlFromEnv()),
        adapters: Array.from(ctx.adapters.values()).map((a) => ({
          id: a.id,
          display_name: a.display_name,
          cost_tier: a.cost_tier,
        })),
        activeRuns: ctx.activeRuns.size,
        activeLoops: activeLoopCount(ctx),
      }));
    }

    case "killswitch.check": {
      // F4: if policy hasn't been making decisions over a meaningful window,
      // the project-manager Agent isn't earning its keep. Report TRIPPED so
      // the user can decide whether to demote osstack back to a thin proxy.
      const windowDays = 30;
      const minFires = 30;
      const cutoff = Date.now() / 1000 - windowDays * 86400;
      // "policy decision" proxy: runs with >=2 candidate adapters available
      // and an outcome recorded. For S5 we approximate by counting runs in
      // the window, since every recent task went through the policy engine.
      const observed = countRunsSince(ctx.db, cutoff);
      const armed = observed >= minFires;
      const recommendation = armed
        ? "Policy is firing enough to learn from. Keep going."
        : `Only ${observed} runs in the last ${windowDays} days (need ${minFires}). Either submit more work through osstack, or consider demoting it to a thin proxy.`;
      return singleOk(req.id, {
        window_days: windowDays,
        min_fires: minFires,
        observed,
        armed,
        recommendation,
      });
    }

    // ── 7 Hermes controls: cancel (above) + approval/clarify/queue/goal ──

    case "approval.resolve": {
      const p = (req.params ?? {}) as { approval_id?: string; choice?: string };
      if (typeof p.approval_id !== "string" || typeof p.choice !== "string") {
        return singleErr(req.id, "bad_request", "params.approval_id and params.choice required");
      }
      const r = ctx.db.prepare("SELECT status FROM approvals WHERE approval_id = ?").get(p.approval_id) as { status?: string } | undefined;
      if (!r) return singleErr(req.id, "not_found", `no approval with id=${p.approval_id}`);
      if (r.status !== "pending") return singleErr(req.id, "already_resolved", `approval status=${r.status}`);
      ctx.db.prepare(
        "UPDATE approvals SET status = 'accepted', resolved_at = ?, choice = ? WHERE approval_id = ?",
      ).run(Date.now() / 1000, p.choice, p.approval_id);
      return singleOk(req.id, { resolved: true, approval_id: p.approval_id, choice: p.choice });
    }

    case "approval.list": {
      const p = (req.params ?? {}) as { run_id?: string; status?: string };
      let sql = "SELECT approval_id, run_id, status, action_summary, risk, requested_at, resolved_at, choice FROM approvals WHERE 1=1";
      const args: unknown[] = [];
      if (typeof p.run_id === "string") { sql += " AND run_id = ?"; args.push(p.run_id); }
      if (typeof p.status === "string") { sql += " AND status = ?"; args.push(p.status); }
      sql += " ORDER BY requested_at DESC LIMIT 200";
      return singleOk(req.id, ctx.db.prepare(sql).all(...args));
    }

    case "clarify.resolve": {
      const p = (req.params ?? {}) as { clarify_id?: string; answer?: string };
      if (typeof p.clarify_id !== "string" || typeof p.answer !== "string") {
        return singleErr(req.id, "bad_request", "params.clarify_id and params.answer required");
      }
      const r = ctx.db.prepare("SELECT status FROM clarifies WHERE clarify_id = ?").get(p.clarify_id) as { status?: string } | undefined;
      if (!r) return singleErr(req.id, "not_found", `no clarify with id=${p.clarify_id}`);
      if (r.status !== "pending") return singleErr(req.id, "already_resolved", `clarify status=${r.status}`);
      ctx.db.prepare(
        "UPDATE clarifies SET status = 'answered', resolved_at = ?, answer = ? WHERE clarify_id = ?",
      ).run(Date.now() / 1000, p.answer, p.clarify_id);
      return singleOk(req.id, { resolved: true, clarify_id: p.clarify_id });
    }

    case "clarify.list": {
      const p = (req.params ?? {}) as { run_id?: string; status?: string };
      let sql = "SELECT clarify_id, run_id, status, question, requested_at, resolved_at, answer FROM clarifies WHERE 1=1";
      const args: unknown[] = [];
      if (typeof p.run_id === "string") { sql += " AND run_id = ?"; args.push(p.run_id); }
      if (typeof p.status === "string") { sql += " AND status = ?"; args.push(p.status); }
      sql += " ORDER BY requested_at DESC LIMIT 200";
      return singleOk(req.id, ctx.db.prepare(sql).all(...args));
    }

    // ── Kanban (osstack's own board; the Telegram-subscribable surface) ──

    case "kanban.board": {
      const p = (req.params ?? {}) as { board?: string; assignee?: string; include_archived?: boolean; since?: number };
      const view = getBoard(ctx.kanban, {
        ...(p.board !== undefined ? { board: p.board } : {}),
        ...(p.assignee !== undefined ? { assignee: p.assignee } : {}),
        ...(p.include_archived !== undefined ? { includeArchived: p.include_archived } : {}),
        ...(p.since !== undefined ? { since: p.since } : {}),
      });
      return singleOk(req.id, view);
    }

    case "kanban.create": {
      const p = (req.params ?? {}) as { title?: string; body?: string; board?: string; priority?: number; assignee?: string; status?: CardStatus };
      if (typeof p.title !== "string" || p.title.trim() === "") {
        return singleErr(req.id, "bad_request", "params.title required");
      }
      const card = ctx.kanban.createCard({
        card_id: `card_${randomUUID().slice(0, 8)}`,
        title: p.title,
        ...(p.body !== undefined ? { body: p.body } : {}),
        ...(p.board !== undefined ? { board: p.board } : {}),
        ...(p.priority !== undefined ? { priority: p.priority } : {}),
        ...(p.assignee !== undefined ? { assignee: p.assignee } : {}),
        ...(p.status !== undefined ? { status: p.status } : {}),
      });
      return singleOk(req.id, card);
    }

    case "kanban.move": {
      const p = (req.params ?? {}) as { card_id?: string; status?: CardStatus; blocked_reason?: string; actor?: string };
      if (typeof p.card_id !== "string" || typeof p.status !== "string") {
        return singleErr(req.id, "bad_request", "params.card_id and params.status required");
      }
      try {
        const card = ctx.kanban.moveCard(p.card_id, p.status, {
          ...(p.blocked_reason !== undefined ? { blocked_reason: p.blocked_reason } : {}),
          ...(p.actor !== undefined ? { actor: p.actor } : {}),
        });
        return singleOk(req.id, card);
      } catch (err) {
        return singleErr(req.id, "move_failed", (err as Error).message);
      }
    }

    case "kanban.comment": {
      const p = (req.params ?? {}) as { card_id?: string; author?: string; body?: string };
      if (typeof p.card_id !== "string" || typeof p.body !== "string") {
        return singleErr(req.id, "bad_request", "params.card_id and params.body required");
      }
      try {
        const c = ctx.kanban.addComment(p.card_id, p.author ?? "user", p.body);
        return singleOk(req.id, c);
      } catch (err) {
        return singleErr(req.id, "comment_failed", (err as Error).message);
      }
    }

    case "kanban.subscribe": {
      const p = (req.params ?? {}) as { card_id?: string; platform?: string; chat_id?: string; thread_id?: string; user_id?: string };
      if (typeof p.card_id !== "string" || typeof p.platform !== "string" || typeof p.chat_id !== "string") {
        return singleErr(req.id, "bad_request", "params.card_id, params.platform, params.chat_id required");
      }
      try {
        const sub = ctx.kanban.subscribe({
          card_id: p.card_id, platform: p.platform, chat_id: p.chat_id,
          ...(p.thread_id !== undefined ? { thread_id: p.thread_id } : {}),
          ...(p.user_id !== undefined ? { user_id: p.user_id } : {}),
        });
        return singleOk(req.id, sub);
      } catch (err) {
        return singleErr(req.id, "subscribe_failed", (err as Error).message);
      }
    }

    case "kanban.unsubscribe": {
      const p = (req.params ?? {}) as { card_id?: string; platform?: string; chat_id?: string; thread_id?: string };
      if (typeof p.card_id !== "string" || typeof p.platform !== "string" || typeof p.chat_id !== "string") {
        return singleErr(req.id, "bad_request", "params.card_id, params.platform, params.chat_id required");
      }
      const removed = ctx.kanban.unsubscribe(p.card_id, p.platform, p.chat_id, p.thread_id ?? "");
      return singleOk(req.id, { removed });
    }

    case "kanban.events": {
      // Drain pending events per subscription; returns the messages a caller
      // (e.g. the Hermes Telegram relay) should deliver, then advances cursors.
      const p = (req.params ?? {}) as { since?: number; card_id?: string; board?: string };
      const sinceId = typeof p.since === "number" ? p.since : 0;
      const events = ctx.kanban.eventsSince(sinceId, {
        ...(p.card_id !== undefined ? { card_id: p.card_id } : {}),
        ...(p.board !== undefined ? { board: p.board } : {}),
        limit: 200,
      });
      return singleOk(req.id, {
        events,
        latest_event_id: ctx.kanban.latestEventId(p.board ?? "default"),
      });
    }

    case "kanban.subscriptions": {
      const p = (req.params ?? {}) as { card_id?: string };
      return singleOk(req.id, ctx.kanban.listSubscriptions(
        p.card_id !== undefined ? { card_id: p.card_id } : {},
      ));
    }

    case "kanban.drain": {
      // Run the notifier server-side with a COLLECTING transport: it formats
      // each subscription's pending events into a message, advances the
      // per-sub cursor, and we return the messages for the caller (the
      // Hermes Telegram relay) to deliver. This is the simplest path for
      // "push osstack board progress to a chat".
      const collected: OutboundMessage[] = [];
      const notifier = new KanbanNotifier(ctx.kanban, async (msg) => { collected.push(msg); });
      const delivered = await notifier.drain();
      return singleOk(req.id, { delivered, messages: collected });
    }

    case "task.submit":
    case "task.observe":
      // Streaming; not handled here.
      return null;

    default:
      return singleErr(req.id, "unknown_method", `unknown method: ${req.method}`);
  }
}

// ──────────────────────────────────────────────────────────────────────
// stats query
// ──────────────────────────────────────────────────────────────────────

interface AgentStat {
  agent_id: string;
  capability_id: string;
  runs: number;
  completed: number;
  failed: number;
  cancelled: number;
  in_flight: number;
  avg_duration_ms: number | null;
  total_tokens_in: number;
  total_tokens_out: number;
  total_pii_redacted: number;
}

interface DaemonStats {
  total_runs: number;
  total_events: number;
  per_agent: AgentStat[];
  loops: LoopStats;
  /** Per-method socket RPC latency (p50/p95 over a recent window). */
  rpc: RpcMethodLatency[];
  generated_at: number;
}

interface LoopStats {
  total_sessions: number;
  running: number;
  stopping: number;
  stopped: number;
  failed: number;
  total_cycles: number;
  total_discovered: number;
  total_executed: number;
  total_skipped: number;
  total_successful: number;
  total_failed: number;
  total_escalated: number;
  total_tokens_consumed: number;
  total_cycle_duration_ms: number;
  avg_cycle_duration_ms: number | null;
  per_loop: LoopStat[];
}

interface LoopStat {
  loop_session_id: string;
  status: LoopSessionStatus;
  workspace_path: string;
  cycle_count: number;
  discovered_task_count: number;
  executed_task_count: number;
  skipped_task_count: number;
  successful_task_count: number;
  failed_task_count: number;
  escalated_task_count: number;
  tokens_consumed: number;
  total_cycle_duration_ms: number;
  avg_cycle_duration_ms: number | null;
  failure_streaks: LoopFailureStreak[];
  budget?: LoopBudgetStat;
  last_cycle_duration_ms?: number;
  schedule?: string;
  stop_reason?: string;
  last_error?: string;
}

/** Budget limits + latest usage for one daemon loop session. */
interface LoopBudgetStat {
  limits: NonNullable<LoopRunOptions["budget"]>;
  exceeded: boolean;
  limit?: string;
  reason?: string;
  usage?: LoopBudgetStatus["usage"];
}

function loopBudgetStat(session: LoopSession): LoopBudgetStat | undefined {
  const limits = session.runOptions.budget;
  if (limits === undefined) return undefined;
  const check = session.lastBudgetCheck;
  return {
    limits,
    exceeded: check?.exceeded ?? false,
    ...(check?.limit !== undefined ? { limit: check.limit } : {}),
    ...(check?.reason !== undefined ? { reason: check.reason } : {}),
    ...(check !== undefined ? { usage: check.usage } : {}),
  };
}

function computeStats(
  db: Database.Database,
  loopSessions: Map<string, LoopSession>,
  rpcLatency: RpcLatencyRecorder,
): DaemonStats {
  const total_runs = countRuns(db);
  const total_events = countEvents(db);
  const rows = db.prepare(
    `SELECT agent_id, capability_id,
            COUNT(*) AS runs,
            SUM(CASE WHEN outcome = 'completed' THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN outcome = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
            SUM(CASE WHEN outcome IS NULL THEN 1 ELSE 0 END) AS in_flight,
            AVG(duration_ms) AS avg_duration_ms,
            SUM(tokens_in) AS total_tokens_in,
            SUM(tokens_out) AS total_tokens_out,
            SUM(pii_redacted_count) AS total_pii_redacted
     FROM runs
     GROUP BY agent_id, capability_id
     ORDER BY agent_id, capability_id`,
  ).all() as AgentStat[];
  return {
    total_runs,
    total_events,
    per_agent: rows,
    loops: computeLoopStats(loopSessions),
    rpc: rpcLatency.snapshot(),
    generated_at: Date.now() / 1000,
  };
}

function computeLoopStats(loopSessions: Map<string, LoopSession>): LoopStats {
  const perLoop = Array.from(loopSessions.values()).map(loopStat);
  const totalCycles = perLoop.reduce((sum, loop) => sum + loop.cycle_count, 0);
  const totalCycleDurationMs = perLoop.reduce((sum, loop) => sum + loop.total_cycle_duration_ms, 0);
  return {
    total_sessions: perLoop.length,
    running: perLoop.filter((loop) => loop.status === "running").length,
    stopping: perLoop.filter((loop) => loop.status === "stopping").length,
    stopped: perLoop.filter((loop) => loop.status === "stopped").length,
    failed: perLoop.filter((loop) => loop.status === "failed").length,
    total_cycles: totalCycles,
    total_discovered: perLoop.reduce((sum, loop) => sum + loop.discovered_task_count, 0),
    total_executed: perLoop.reduce((sum, loop) => sum + loop.executed_task_count, 0),
    total_skipped: perLoop.reduce((sum, loop) => sum + loop.skipped_task_count, 0),
    total_successful: perLoop.reduce((sum, loop) => sum + loop.successful_task_count, 0),
    total_failed: perLoop.reduce((sum, loop) => sum + loop.failed_task_count, 0),
    total_escalated: perLoop.reduce((sum, loop) => sum + loop.escalated_task_count, 0),
    total_tokens_consumed: perLoop.reduce((sum, loop) => sum + loop.tokens_consumed, 0),
    total_cycle_duration_ms: totalCycleDurationMs,
    avg_cycle_duration_ms: totalCycles === 0 ? null : totalCycleDurationMs / totalCycles,
    per_loop: perLoop,
  };
}

function loopStat(session: LoopSession): LoopStat {
  const budget = loopBudgetStat(session);
  return {
    loop_session_id: session.loopSessionId,
    status: session.status,
    workspace_path: session.workspacePath,
    cycle_count: session.cycleCount,
    discovered_task_count: session.discoveredTaskCount,
    executed_task_count: session.executedTaskCount,
    skipped_task_count: session.skippedTaskCount,
    successful_task_count: session.successfulTaskCount,
    failed_task_count: session.failedTaskCount,
    escalated_task_count: session.escalatedTaskCount,
    tokens_consumed: session.tokensConsumed,
    total_cycle_duration_ms: session.totalCycleDurationMs,
    avg_cycle_duration_ms: session.cycleCount === 0 ? null : session.totalCycleDurationMs / session.cycleCount,
    failure_streaks: Object.values(session.failureStreaks),
    ...(session.runOptions.profileRouting !== undefined
      ? { profile: session.runOptions.profileRouting }
      : {}),
    ...(budget !== undefined ? { budget } : {}),
    ...(session.lastCycleDurationMs !== undefined ? { last_cycle_duration_ms: session.lastCycleDurationMs } : {}),
    ...(session.scheduleExpression !== undefined ? { schedule: session.scheduleExpression } : {}),
    ...(session.stopReason !== undefined ? { stop_reason: session.stopReason } : {}),
    ...(session.lastError !== undefined ? { last_error: session.lastError } : {}),
  };
}

// ──────────────────────────────────────────────────────────────────────
// loop.run / loop.status
// ──────────────────────────────────────────────────────────────────────

function loopRunSummary(
  result: LoopRunResult,
  runId?: string,
  knowledgeHygiene?: LoopNeatFinalizerResultV1,
): Record<string, unknown> {
  return {
    ...(runId !== undefined ? { run_id: runId } : {}),
    loop_id: result.loop_id,
    json_path: result.jsonPath,
    markdown_path: result.markdownPath,
    completed_tasks: result.state.completed_tasks,
    metrics: result.state.key_metrics,
    events: result.events,
    state: result.state,
    ...(result.goal !== undefined ? { goal: result.goal } : {}),
    ...(result.budget !== undefined ? { budget: result.budget } : {}),
    ...(knowledgeHygiene !== undefined ? { knowledge_hygiene: knowledgeHygiene } : {}),
  };
}

function loopRunCyclesSummary(
  result: LoopRunCyclesResult,
  runId?: string,
  knowledgeHygiene?: LoopNeatFinalizerResultV1,
): Record<string, unknown> {
  return {
    ...(runId !== undefined ? { run_id: runId } : {}),
    loop_id: result.loop_id,
    json_path: result.jsonPath,
    markdown_path: result.markdownPath,
    completed_tasks: result.state.completed_tasks,
    metrics: result.state.key_metrics,
    events: result.events,
    state: result.state,
    ...(result.cycles.at(-1)?.goal !== undefined ? { goal: result.cycles.at(-1)?.goal } : {}),
    ...(result.budget !== undefined ? { budget: result.budget } : {}),
    ...(knowledgeHygiene !== undefined ? { knowledge_hygiene: knowledgeHygiene } : {}),
    cycles: result.cycles.map((cycle) => ({
      discovered_task_count: cycle.discoveredTaskCount,
      executed_task_count: cycle.executedTaskCount,
      skipped_task_count: cycle.skippedTaskCount,
      ...(cycle.goal !== undefined ? { goal: cycle.goal } : {}),
    })),
  };
}

async function finalizeLoopKnowledgeHygiene(
  enabled: boolean,
  workspacePath: string,
  result: LoopRunResult | LoopRunCyclesResult,
): Promise<LoopNeatFinalizerResultV1 | undefined> {
  return runLoopNeatFinalizer({
    enabled,
    loop_succeeded: result.state.completed_tasks.length > 0
      && result.state.completed_tasks.every((task) => task.outcome === "success")
      && result.budget?.exceeded !== true,
    workspace_path: workspacePath,
  });
}

function persistLoopRunEvidence(ctx: DaemonContext, result: LoopRunResult | LoopRunCyclesResult): string {
  const runId = `loop_run_${randomUUID().slice(0, 8)}`;
  const taskId = `loop_task_${runId}`;
  const now = Date.now() / 1000;
  const outcome = result.state.completed_tasks.some((task) => task.outcome !== "success")
    ? "failed"
    : "completed";

  insertTask(ctx.db, ctx.dbPath, {
    task_id: taskId,
    title: `Loop run ${result.loop_id}`,
    description: `Persisted evidence for loop ${result.loop_id}`,
    created_at: now,
  });
  insertRun(ctx.db, ctx.dbPath, {
    run_id: runId,
    task_id: taskId,
    session_id: result.loop_id,
    agent_id: "osstack-loop",
    capability_id: "loop.engine",
    phase: "loop",
    started_at: now,
  });

  for (const event of result.events) {
    appendEvent(ctx.db, ctx.dbPath, {
      event_id: `${runId}:${event.seq}`,
      run_id: runId,
      session_id: result.loop_id,
      seq: event.seq,
      type: event.type,
      created_at: event.created_at,
      terminal: event.type === "loop.stopped",
      payload: {
        ...(event.payload ?? {}),
        loop_event_id: event.event_id,
      },
    } as unknown as HermesEvent);
  }
  finalizeRun(ctx.db, ctx.dbPath, runId, outcome, Date.now() / 1000);
  return runId;
}

interface LoopStartSchedule {
  intervalMs: number;
  stopWhenIdle: boolean;
  cycles?: number;
  scheduleExpression?: string;
}

async function startLoopSession(
  ctx: DaemonContext,
  runOptions: LoopRunOptions,
  schedule: LoopStartSchedule,
): Promise<Record<string, unknown>> {
  const workspacePath = runOptions.workspacePath ?? process.cwd();
  const stateFilePath = resolveDaemonLoopPath(runOptions.stateFilePath ?? "LOOP-STATE.json", workspacePath);
  const normalizedRunOptions: LoopRunOptions = {
    ...withoutRuntimeAdapters(runOptions),
    workspacePath,
    stateFilePath,
  };
  const now = Date.now();
  const session: LoopSession = {
    loopSessionId: `loop_session_${randomUUID().slice(0, 8)}`,
    workspacePath,
    stateFilePath,
    intervalMs: schedule.intervalMs,
    stopWhenIdle: schedule.stopWhenIdle,
    status: "running",
    startedAt: now,
    updatedAt: now,
    cycleCount: 0,
    discoveredTaskCount: 0,
    executedTaskCount: 0,
    skippedTaskCount: 0,
    successfulTaskCount: 0,
    failedTaskCount: 0,
    escalatedTaskCount: 0,
    tokensConsumed: 0,
    costConsumed: 0,
    totalCycleDurationMs: 0,
    failureStreaks: {},
    noProgressCycles: 0,
    abort: new AbortController(),
    runOptions: normalizedRunOptions,
    ...(schedule.cycles !== undefined ? { maxCycles: schedule.cycles } : {}),
    ...(schedule.scheduleExpression !== undefined ? { scheduleExpression: schedule.scheduleExpression } : {}),
  };
  ctx.loopSessions.set(session.loopSessionId, session);
  await persistLoopSessions(ctx);
  session.done = runLoopSession(ctx, session);
  return loopSessionSummary(session);
}

async function runLoopSession(ctx: DaemonContext, session: LoopSession): Promise<void> {
  const budget = session.runOptions.budget;
  try {
    while (!session.abort.signal.aborted) {
      if (session.maxCycles !== undefined && session.cycleCount >= session.maxCycles) {
        await markLoopSessionStopped(ctx, session, "max cycles reached");
        return;
      }

      if (session.scheduleExpression !== undefined) {
        const delayMs = nextCronDelayMs(session.scheduleExpression, new Date(), {
          includeCurrentMinute: session.cycleCount === 0,
        });
        if (delayMs instanceof Error) throw delayMs;
        if (delayMs > 0) await sleep(delayMs, undefined, { signal: session.abort.signal });
      }

      const cycleStartedAt = Date.now();
      const result = await new LoopEngine(withLoopAdapters(ctx, session.runOptions)).runOnce();
      // Kernel gate (R2.2): the per-tick engine consulted the policy gate at
      // entry (the gate re-reads policy.yaml each consult). A mid-session flip
      // to `mode: observe` denies here — stop the session cleanly with a
      // `policy_denied` stop_reason, persisted exactly like a budget stop.
      // Checked before counters advance so a refused tick is not counted.
      if (result.policy?.denied === true) {
        // The observe reason already carries the `policy_denied:` marker; a
        // fail-closed reason (loader error) gets it prefixed so every policy
        // stop is greppable, matching the loop's own loop.stopped wording.
        const stopReason = result.policy.reason.startsWith("policy_denied")
          ? result.policy.reason
          : `policy_denied: ${result.policy.reason}`;
        await markLoopSessionStopped(ctx, session, stopReason);
        return;
      }
      const cycleDurationMs = Date.now() - cycleStartedAt;
      session.cycleCount += 1;
      session.discoveredTaskCount += result.discoveredTaskCount;
      session.executedTaskCount += result.executedTaskCount;
      session.skippedTaskCount += result.skippedTaskCount;
      for (const completedTask of result.completedTasks) {
        if (completedTask.outcome === "success") session.successfulTaskCount += 1;
        else if (completedTask.outcome === "failed") session.failedTaskCount += 1;
        else {
          session.escalatedTaskCount += 1;
          notifyLoopEscalation(ctx, session, result, completedTask);
        }
        const streak = updateLoopFailureStreak(session, completedTask);
        if (streak !== undefined) notifyLoopFailureStreak(ctx, session, streak);
      }
      session.tokensConsumed = result.state.key_metrics?.tokens_consumed ?? session.tokensConsumed;
      session.costConsumed = result.state.key_metrics?.cost_consumed ?? session.costConsumed;
      session.totalCycleDurationMs += cycleDurationMs;
      session.lastCycleDurationMs = cycleDurationMs;
      session.lastJsonPath = result.jsonPath;
      session.lastMarkdownPath = result.markdownPath;
      if (result.state.wait_reason === undefined) delete session.waitReason;
      else session.waitReason = result.state.wait_reason;
      session.updatedAt = Date.now();
      await persistLoopSessions(ctx);

      if (budget !== undefined) {
        if (result.executedTaskCount > 0) {
          const madeProgress = result.completedTasks.some((task) => task.outcome === "success");
          session.noProgressCycles = madeProgress ? 0 : session.noProgressCycles + 1;
        }
        const usage = {
          cycles: session.cycleCount,
          runtime_ms: Date.now() - session.startedAt,
          tokens: session.tokensConsumed,
          estimated_cost_usd: session.costConsumed,
          no_progress_cycles: session.noProgressCycles,
        };
        const check = checkBudget(budget, usage);
        session.lastBudgetCheck = { ...check, usage };
        await persistLoopSessions(ctx);
        if (check.exceeded) {
          await markLoopSessionStopped(ctx, session, `budget exceeded: ${check.reason}`);
          return;
        }
      }

      if (result.goal?.pass === true) {
        await markLoopSessionStopped(ctx, session, "goal command passed");
        return;
      }
      if (session.stopWhenIdle && result.executedTaskCount === 0) {
        await markLoopSessionStopped(ctx, session, result.state.wait_reason === undefined
          ? "idle cycle completed"
          : `discovery_deferred: needs_approval=${result.state.wait_reason.needs_approval}, suggest_only=${result.state.wait_reason.suggest_only}, blocked=${result.state.wait_reason.blocked}`);
        return;
      }
      if (session.maxCycles !== undefined && session.cycleCount >= session.maxCycles) {
        await markLoopSessionStopped(ctx, session, "max cycles reached");
        return;
      }

      if (session.scheduleExpression === undefined) {
        await sleep(session.intervalMs, undefined, { signal: session.abort.signal });
      }
    }
    if (!session.shutdownRequested) await markLoopSessionStopped(ctx, session, session.stopReason ?? "stopped by request");
  } catch (err) {
    if (session.abort.signal.aborted || (err as Error).name === "AbortError") {
      if (!session.shutdownRequested) await markLoopSessionStopped(ctx, session, session.stopReason ?? "stopped by request");
      return;
    }
    session.status = "failed";
    session.lastError = err instanceof Error ? err.message : String(err);
    session.updatedAt = Date.now();
    await persistLoopSessions(ctx);
  }
}

function stopLoopSession(session: LoopSession, reason: string): void {
  if (session.status === "running") session.status = "stopping";
  session.stopReason = reason;
  session.updatedAt = Date.now();
  session.abort.abort();
}

function notifyLoopEscalation(
  ctx: DaemonContext,
  session: LoopSession,
  result: LoopRunResult,
  completedTask: CompletedTask,
): void {
  const payload = result.events.find((event) => (
    event.type === "loop.escalated"
    && (event.payload as { task_id?: unknown } | undefined)?.task_id === completedTask.task_id
  ))?.payload as {
    reason?: unknown;
    iteration?: unknown;
    max_iterations?: unknown;
    escalate_to?: unknown;
    agent_id?: unknown;
  } | undefined;
  const reason = typeof payload?.reason === "string"
    ? payload.reason
    : `Loop task ${completedTask.task_id} escalated after ${completedTask.iterations} iteration(s).`;
  const cardId = loopEscalationCardId(session.loopSessionId, completedTask.task_id);
  const body = [
    `Workspace: ${session.workspacePath}`,
    `Loop session: ${session.loopSessionId}`,
    `Loop id: ${result.loop_id}`,
    `Task: ${completedTask.task_id}`,
    `Iterations: ${completedTask.iterations}`,
    `Escalate to: ${typeof payload?.escalate_to === "string" ? payload.escalate_to : "hermes"}`,
    `Reason: ${reason}`,
  ].join("\n");

  try {
    const existing = ctx.kanban.getCard(cardId);
    if (existing === undefined) {
      ctx.kanban.createCard({
        card_id: cardId,
        task_id: `loop:${session.loopSessionId}:${completedTask.task_id}`,
        title: `Loop escalation: ${completedTask.task_id}`,
        body,
        status: "triage",
        priority: 90,
        assignee: "osstack-loop",
      });
      ctx.kanban.moveCard(cardId, "blocked", {
        actor: "osstack-loop",
        blocked_reason: reason,
      });
    } else {
      ctx.kanban.patchCard(cardId, {
        body,
        priority: 90,
        assignee: "osstack-loop",
      });
      ctx.kanban.addComment(cardId, "osstack-loop", reason);
      if (existing.status !== "blocked") {
        ctx.kanban.moveCard(cardId, "blocked", {
          actor: "osstack-loop",
          blocked_reason: reason,
        });
      }
    }
  } catch (err) {
    process.stderr.write(`osstack: loop escalation kanban notification failed: ${(err as Error).message}\n`);
  }
}

function loopEscalationCardId(loopSessionId: string, taskId: string): string {
  const stable = createHash("sha1").update(`${loopSessionId}:${taskId}`).digest("hex").slice(0, 12);
  return `card_loop_${stable}`;
}

function updateLoopFailureStreak(session: LoopSession, completedTask: CompletedTask): LoopFailureStreak | undefined {
  const capability = completedTask.capability;
  if (capability === undefined || capability.trim() === "") return undefined;

  if (completedTask.outcome === "success") {
    delete session.failureStreaks[capability];
    return undefined;
  }

  const previous = session.failureStreaks[capability];
  const next: LoopFailureStreak = {
    capability,
    count: (previous?.count ?? 0) + 1,
    lastTaskId: completedTask.task_id,
    updatedAt: Date.now(),
    ...(previous?.lastEscalatedAtCount !== undefined ? { lastEscalatedAtCount: previous.lastEscalatedAtCount } : {}),
  };
  const shouldEscalate = next.count >= LOOP_FAILURE_STREAK_THRESHOLD
    && next.count % LOOP_FAILURE_STREAK_THRESHOLD === 0
    && next.lastEscalatedAtCount !== next.count;
  if (shouldEscalate) next.lastEscalatedAtCount = next.count;
  session.failureStreaks[capability] = next;
  return shouldEscalate ? next : undefined;
}

function notifyLoopFailureStreak(ctx: DaemonContext, session: LoopSession, streak: LoopFailureStreak): void {
  const cardId = loopFailureStreakCardId(session.loopSessionId, streak.capability);
  const reason = `${streak.count} consecutive ${streak.capability} loop task failures; latest task ${streak.lastTaskId}.`;
  const body = [
    `Workspace: ${session.workspacePath}`,
    `Loop session: ${session.loopSessionId}`,
    `Capability: ${streak.capability}`,
    `Consecutive failures: ${streak.count}`,
    `Latest task: ${streak.lastTaskId}`,
    `Reason: ${reason}`,
  ].join("\n");

  try {
    const existing = ctx.kanban.getCard(cardId);
    if (existing === undefined) {
      ctx.kanban.createCard({
        card_id: cardId,
        task_id: `loop-streak:${session.loopSessionId}:${streak.capability}`,
        title: `Loop failure streak: ${streak.capability}`,
        body,
        status: "triage",
        priority: 95,
        assignee: "osstack-loop",
      });
      ctx.kanban.moveCard(cardId, "blocked", {
        actor: "osstack-loop",
        blocked_reason: reason,
      });
    } else {
      ctx.kanban.patchCard(cardId, {
        body,
        priority: 95,
        assignee: "osstack-loop",
      });
      ctx.kanban.addComment(cardId, "osstack-loop", reason);
      if (existing.status !== "blocked") {
        ctx.kanban.moveCard(cardId, "blocked", {
          actor: "osstack-loop",
          blocked_reason: reason,
        });
      }
    }
  } catch (err) {
    process.stderr.write(`osstack: loop failure streak kanban notification failed: ${(err as Error).message}\n`);
  }
}

function loopFailureStreakCardId(loopSessionId: string, capability: string): string {
  const stable = createHash("sha1").update(`${loopSessionId}:${capability}`).digest("hex").slice(0, 12);
  return `card_loop_streak_${stable}`;
}

async function markLoopSessionStopped(ctx: DaemonContext, session: LoopSession, reason: string): Promise<void> {
  session.status = "stopped";
  session.stopReason = reason;
  session.updatedAt = Date.now();
  await persistLoopSessions(ctx);
}

function activeLoopCount(ctx: DaemonContext): number {
  return Array.from(ctx.loopSessions.values())
    .filter((session) => session.status === "running" || session.status === "stopping")
    .length;
}

function loopSessionSummary(session: LoopSession): Record<string, unknown> {
  const budget = loopBudgetStat(session);
  return {
    loop_session_id: session.loopSessionId,
    workspace_path: session.workspacePath,
    state_json: session.stateFilePath,
    status: session.status,
    interval_ms: session.intervalMs,
    stop_when_idle: session.stopWhenIdle,
    ...(session.scheduleExpression !== undefined ? { schedule: session.scheduleExpression } : {}),
    started_at: session.startedAt,
    updated_at: session.updatedAt,
    cycle_count: session.cycleCount,
    discovered_task_count: session.discoveredTaskCount,
    executed_task_count: session.executedTaskCount,
    skipped_task_count: session.skippedTaskCount,
    successful_task_count: session.successfulTaskCount,
    failed_task_count: session.failedTaskCount,
    escalated_task_count: session.escalatedTaskCount,
    tokens_consumed: session.tokensConsumed,
    total_cycle_duration_ms: session.totalCycleDurationMs,
    avg_cycle_duration_ms: session.cycleCount === 0 ? null : session.totalCycleDurationMs / session.cycleCount,
    failure_streaks: Object.values(session.failureStreaks),
    ...(session.runOptions.profileRouting !== undefined
      ? { profile: session.runOptions.profileRouting }
      : {}),
    ...(budget !== undefined ? { budget } : {}),
    ...(session.lastCycleDurationMs !== undefined ? { last_cycle_duration_ms: session.lastCycleDurationMs } : {}),
    ...(session.maxCycles !== undefined ? { max_cycles: session.maxCycles } : {}),
    ...(session.lastJsonPath !== undefined ? { last_json_path: session.lastJsonPath } : {}),
    ...(session.lastMarkdownPath !== undefined ? { last_markdown_path: session.lastMarkdownPath } : {}),
    ...(session.stopReason !== undefined ? { stop_reason: session.stopReason } : {}),
    ...(session.waitReason !== undefined ? { wait_reason: session.waitReason } : {}),
    ...(session.lastError !== undefined ? { last_error: session.lastError } : {}),
  };
}

async function persistLoopSessions(ctx: DaemonContext): Promise<void> {
  const payload: PersistedLoopSessionsFile = {
    version: 1,
    sessions: Array.from(ctx.loopSessions.values()).map((session) => ({
      loopSessionId: session.loopSessionId,
      status: session.status,
      runOptions: withoutRuntimeAdapters(session.runOptions),
      intervalMs: session.intervalMs,
      stopWhenIdle: session.stopWhenIdle,
      ...(session.scheduleExpression !== undefined ? { scheduleExpression: session.scheduleExpression } : {}),
      startedAt: session.startedAt,
      updatedAt: session.updatedAt,
      cycleCount: session.cycleCount,
      discoveredTaskCount: session.discoveredTaskCount,
      executedTaskCount: session.executedTaskCount,
      skippedTaskCount: session.skippedTaskCount,
      successfulTaskCount: session.successfulTaskCount,
      failedTaskCount: session.failedTaskCount,
      escalatedTaskCount: session.escalatedTaskCount,
      tokensConsumed: session.tokensConsumed,
      costConsumed: session.costConsumed,
      totalCycleDurationMs: session.totalCycleDurationMs,
      failureStreaks: session.failureStreaks,
      noProgressCycles: session.noProgressCycles,
      ...(session.lastBudgetCheck !== undefined ? { lastBudgetCheck: session.lastBudgetCheck } : {}),
      ...(session.maxCycles !== undefined ? { maxCycles: session.maxCycles } : {}),
      ...(session.lastCycleDurationMs !== undefined ? { lastCycleDurationMs: session.lastCycleDurationMs } : {}),
      ...(session.lastJsonPath !== undefined ? { lastJsonPath: session.lastJsonPath } : {}),
      ...(session.lastMarkdownPath !== undefined ? { lastMarkdownPath: session.lastMarkdownPath } : {}),
      ...(session.lastError !== undefined ? { lastError: session.lastError } : {}),
      ...(session.stopReason !== undefined ? { stopReason: session.stopReason } : {}),
      ...(session.waitReason !== undefined ? { waitReason: session.waitReason } : {}),
    })),
  };
  // Atomic write (temp + rename): loop-sessions.json is read concurrently by
  // tests and tooling while the daemon persists after every cycle; a plain
  // writeFile lets readers observe a truncated file mid-write ("Unexpected end
  // of JSON input"), and a crash mid-write would corrupt restore state. The
  // monotonic counter keeps tmp names unique across same-millisecond persists
  // (Date.now() alone can collide, making the second rename fail). Persistence
  // is a best-effort snapshot — restore tolerates a missing file — so a failed
  // write (e.g. home dir removed during shutdown) must never reject a loop
  // session's completion promise.
  const tmpPath = join(
    dirname(ctx.loopSessionsPath),
    `.${basename(ctx.loopSessionsPath)}.${process.pid}.${persistCounter++}.tmp`,
  );
  try {
    await writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
    await rename(tmpPath, ctx.loopSessionsPath);
  } catch {
    // best-effort: swallow snapshot failures (next persist will retry)
  }
}

let persistCounter = 0;

async function restoreLoopSessions(ctx: DaemonContext): Promise<void> {
  let parsed: PersistedLoopSessionsFile;
  try {
    parsed = JSON.parse(await readFile(ctx.loopSessionsPath, "utf-8")) as PersistedLoopSessionsFile;
  } catch {
    return;
  }
  if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) return;

  for (const saved of parsed.sessions) {
    const workspacePath = saved.runOptions.workspacePath ?? process.cwd();
    const stateFilePath = resolveDaemonLoopPath(saved.runOptions.stateFilePath ?? "LOOP-STATE.json", workspacePath);
    const restoredRunOptions: LoopRunOptions = {
      ...withoutRuntimeAdapters(saved.runOptions),
      workspacePath,
      stateFilePath,
    };
    // A snapshot cannot prove the previous writer stopped or a side effect failed.
    // Preserve worktrees and pending tasks; recovery requires explicit inspection.
    const restoredWait = LoopWaitReason.safeParse(saved.waitReason);
    const session: LoopSession = {
      loopSessionId: saved.loopSessionId,
      workspacePath,
      stateFilePath,
      intervalMs: saved.intervalMs,
      stopWhenIdle: saved.stopWhenIdle,
      status: saved.status === "running" || saved.status === "stopping" ? "stopped" : saved.status,
      startedAt: saved.startedAt,
      updatedAt: Date.now(),
      cycleCount: saved.cycleCount,
      discoveredTaskCount: saved.discoveredTaskCount,
      executedTaskCount: saved.executedTaskCount,
      skippedTaskCount: saved.skippedTaskCount,
      successfulTaskCount: saved.successfulTaskCount ?? 0,
      failedTaskCount: saved.failedTaskCount ?? 0,
      escalatedTaskCount: saved.escalatedTaskCount ?? 0,
      tokensConsumed: saved.tokensConsumed ?? 0,
      costConsumed: saved.costConsumed ?? 0,
      totalCycleDurationMs: saved.totalCycleDurationMs ?? 0,
      failureStreaks: saved.failureStreaks ?? {},
      noProgressCycles: saved.noProgressCycles ?? 0,
      abort: new AbortController(),
      runOptions: restoredRunOptions,
      ...(restoredWait.success ? { waitReason: restoredWait.data } : {}),
      ...(saved.lastBudgetCheck !== undefined ? { lastBudgetCheck: saved.lastBudgetCheck } : {}),
      ...(saved.maxCycles !== undefined ? { maxCycles: saved.maxCycles } : {}),
      ...(saved.lastCycleDurationMs !== undefined ? { lastCycleDurationMs: saved.lastCycleDurationMs } : {}),
      ...(saved.scheduleExpression !== undefined ? { scheduleExpression: saved.scheduleExpression } : {}),
      ...(saved.lastJsonPath !== undefined ? { lastJsonPath: saved.lastJsonPath } : {}),
      ...(saved.lastMarkdownPath !== undefined ? { lastMarkdownPath: saved.lastMarkdownPath } : {}),
      ...(saved.lastError !== undefined ? { lastError: saved.lastError } : {}),
      ...(saved.status === "running" || saved.status === "stopping"
        ? { stopReason: "recovery_required: previous writer and side effects are unconfirmed; work retained" }
        : saved.stopReason !== undefined ? { stopReason: saved.stopReason } : {}),
    };
    ctx.loopSessions.set(session.loopSessionId, session);
  }
  await persistLoopSessions(ctx);
}

// ──────────────────────────────────────────────────────────────────────
// Daily-brief session lifecycle (R2.3)
// ──────────────────────────────────────────────────────────────────────

interface DailySchedule {
  registryPath: string;
  intervalMs: number;
  scheduleExpression?: string;
}

function parseDailyScheduleParams(params: unknown): DailySchedule | Error {
  const p = objectParams(params);
  if (p instanceof Error) return p;
  const registryPath = optionalString(p, "registryPath");
  if (registryPath === undefined) return new Error("params.registryPath required");
  const intervalMs = optionalNonNegativeInteger(p, "intervalMs");
  if (intervalMs instanceof Error) return intervalMs;
  if (intervalMs === undefined) return new Error("params.intervalMs required");
  // Unlike loop sessions (where 0 means "run cycles back-to-back on purpose"),
  // a 0-interval daily session would just hot-loop re-generating the same
  // brief — always a mistake, so refuse it here.
  if (intervalMs === 0) return new Error("params.intervalMs must be greater than 0");
  const scheduleExpression = optionalString(p, "schedule");
  return {
    registryPath,
    intervalMs,
    ...(scheduleExpression !== undefined ? { scheduleExpression } : {}),
  };
}

async function startDailySession(ctx: DaemonContext, schedule: DailySchedule): Promise<Record<string, unknown>> {
  const now = Date.now();
  const session: DailySession = {
    dailySessionId: `daily_session_${randomUUID().slice(0, 8)}`,
    registryPath: schedule.registryPath,
    intervalMs: schedule.intervalMs,
    status: "running",
    startedAt: now,
    updatedAt: now,
    tickCount: 0,
    consecutiveFailureCount: 0,
    abort: new AbortController(),
    ...(schedule.scheduleExpression !== undefined ? { scheduleExpression: schedule.scheduleExpression } : {}),
  };
  ctx.dailySessions.set(session.dailySessionId, session);
  await persistDailySessions(ctx);
  session.done = runDailySession(ctx, session);
  return dailySessionSummary(session);
}

async function runDailySession(ctx: DaemonContext, session: DailySession): Promise<void> {
  try {
    while (!session.abort.signal.aborted) {
      let stop = false;
      // Policy (R2.3): daily is a READ-ONLY composition — its only write is the
      // dated brief JSON — so it is intentionally NOT observe-gated. Observing
      // is precisely what `mode: observe` permits, so no makePolicyGate consult
      // happens here; a scheduled brief runs regardless of workspace policy.
      try {
        const run = await runDailyBrief({ registryPath: session.registryPath });
        session.lastBriefPath = run.briefPath;
        session.lastResultStatus = run.result.status;
        session.consecutiveFailureCount = 0;
        delete session.lastError;
      } catch (err) {
        // A tick failure must never crash the daemon or kill the session: record
        // it, count it, keep ticking — until the consecutive-failure ceiling.
        session.consecutiveFailureCount += 1;
        session.lastResultStatus = "error";
        session.lastError = err instanceof Error ? err.message : String(err);
        if (session.consecutiveFailureCount >= DAILY_FAILURE_STOP_THRESHOLD) stop = true;
      }
      session.tickCount += 1;
      session.updatedAt = Date.now();
      await persistDailySessions(ctx);
      if (stop) {
        await markDailySessionStopped(
          ctx,
          session,
          `stopped after ${DAILY_FAILURE_STOP_THRESHOLD} consecutive failures: ${session.lastError}`,
        );
        return;
      }
      await sleep(session.intervalMs, undefined, { signal: session.abort.signal });
    }
    if (!session.shutdownRequested) await markDailySessionStopped(ctx, session, session.stopReason ?? "stopped by request");
  } catch (err) {
    if (session.abort.signal.aborted || (err as Error).name === "AbortError") {
      if (!session.shutdownRequested) await markDailySessionStopped(ctx, session, session.stopReason ?? "stopped by request");
      return;
    }
    session.status = "failed";
    session.lastError = err instanceof Error ? err.message : String(err);
    session.updatedAt = Date.now();
    await persistDailySessions(ctx);
  }
}

function stopDailySession(session: DailySession, reason: string): void {
  if (session.status === "running") session.status = "stopping";
  session.stopReason = reason;
  session.updatedAt = Date.now();
  session.abort.abort();
}

async function markDailySessionStopped(ctx: DaemonContext, session: DailySession, reason: string): Promise<void> {
  session.status = "stopped";
  session.stopReason = reason;
  session.updatedAt = Date.now();
  await persistDailySessions(ctx);
}

function dailySessionSummary(session: DailySession): Record<string, unknown> {
  return {
    daily_session_id: session.dailySessionId,
    registry_path: session.registryPath,
    status: session.status,
    interval_ms: session.intervalMs,
    ...(session.scheduleExpression !== undefined ? { schedule: session.scheduleExpression } : {}),
    started_at: session.startedAt,
    updated_at: session.updatedAt,
    tick_count: session.tickCount,
    consecutive_failure_count: session.consecutiveFailureCount,
    ...(session.lastBriefPath !== undefined ? { last_brief_path: session.lastBriefPath } : {}),
    ...(session.lastResultStatus !== undefined ? { last_result_status: session.lastResultStatus } : {}),
    ...(session.stopReason !== undefined ? { stop_reason: session.stopReason } : {}),
    ...(session.lastError !== undefined ? { last_error: session.lastError } : {}),
  };
}

async function persistDailySessions(ctx: DaemonContext): Promise<void> {
  const payload: PersistedDailySessionsFile = {
    version: 1,
    sessions: Array.from(ctx.dailySessions.values()).map((session) => ({
      dailySessionId: session.dailySessionId,
      registryPath: session.registryPath,
      intervalMs: session.intervalMs,
      ...(session.scheduleExpression !== undefined ? { scheduleExpression: session.scheduleExpression } : {}),
      status: session.status,
      startedAt: session.startedAt,
      updatedAt: session.updatedAt,
      tickCount: session.tickCount,
      consecutiveFailureCount: session.consecutiveFailureCount,
      ...(session.lastBriefPath !== undefined ? { lastBriefPath: session.lastBriefPath } : {}),
      ...(session.lastResultStatus !== undefined ? { lastResultStatus: session.lastResultStatus } : {}),
      ...(session.lastError !== undefined ? { lastError: session.lastError } : {}),
      ...(session.stopReason !== undefined ? { stopReason: session.stopReason } : {}),
    })),
  };
  // Atomic write (temp + rename), same rationale as persistLoopSessions: readers
  // (tests/tooling) must never observe a truncated daily-sessions.json, and a
  // failed snapshot (e.g. home removed mid-shutdown) must never reject a tick.
  const tmpPath = join(
    dirname(ctx.dailySessionsPath),
    `.${basename(ctx.dailySessionsPath)}.${process.pid}.${persistCounter++}.tmp`,
  );
  try {
    await writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
    await rename(tmpPath, ctx.dailySessionsPath);
  } catch {
    // best-effort snapshot (next persist will retry)
  }
}

async function restoreDailySessions(ctx: DaemonContext): Promise<void> {
  let parsed: PersistedDailySessionsFile;
  try {
    parsed = JSON.parse(await readFile(ctx.dailySessionsPath, "utf-8")) as PersistedDailySessionsFile;
  } catch {
    return;
  }
  if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) return;

  for (const saved of parsed.sessions) {
    const session: DailySession = {
      dailySessionId: saved.dailySessionId,
      registryPath: saved.registryPath,
      intervalMs: saved.intervalMs,
      // An interrupted "stopping" session is treated as stopped on restore (its
      // abort never completed), mirroring loop-session restore semantics.
      status: saved.status === "running" || saved.status === "stopping" ? "stopped" : saved.status,
      startedAt: saved.startedAt,
      updatedAt: Date.now(),
      tickCount: saved.tickCount ?? 0,
      consecutiveFailureCount: saved.consecutiveFailureCount ?? 0,
      abort: new AbortController(),
      ...(saved.scheduleExpression !== undefined ? { scheduleExpression: saved.scheduleExpression } : {}),
      ...(saved.lastBriefPath !== undefined ? { lastBriefPath: saved.lastBriefPath } : {}),
      ...(saved.lastResultStatus !== undefined ? { lastResultStatus: saved.lastResultStatus } : {}),
      ...(saved.lastError !== undefined ? { lastError: saved.lastError } : {}),
      ...(saved.status === "running" || saved.status === "stopping"
        ? { stopReason: "recovery_required: previous writer and side effects are unconfirmed; work retained" }
        : saved.stopReason !== undefined ? { stopReason: saved.stopReason } : {}),
    };
    ctx.dailySessions.set(session.dailySessionId, session);
    if (session.status === "running") session.done = runDailySession(ctx, session);
  }
  await persistDailySessions(ctx);
}

function parseLoopRunParams(
  params: unknown,
): { runOptions: LoopRunOptions; cyclesOptions?: LoopRunCyclesOptions; neatFinalize: boolean } | Error {
  const p = objectParams(params);
  if (p instanceof Error) return p;

  const workspacePath = optionalString(p, "workspacePath") ?? process.cwd();
  const stateFilePath = optionalString(p, "stateFilePath") ?? "LOOP-STATE.json";
  const markdownPath = optionalString(p, "markdownPath");
  const loopId = optionalString(p, "loopId");
  const executeCommand = optionalString(p, "executeCommand");
  const agentId = optionalString(p, "agentId");
  const goalCommand = optionalString(p, "goalCommand");
  const worktreeRoot = optionalString(p, "worktreeRoot");
  const archiveCompletedTasks = optionalBoolean(p, "archiveCompletedTasks");
  if (archiveCompletedTasks instanceof Error) return archiveCompletedTasks;
  const autoAgent = optionalBoolean(p, "autoAgent");
  if (autoAgent instanceof Error) return autoAgent;
  const useWorktree = optionalBoolean(p, "useWorktree");
  if (useWorktree instanceof Error) return useWorktree;
  const enforceRoleSeparation = optionalBoolean(p, "enforceRoleSeparation");
  if (enforceRoleSeparation instanceof Error) return enforceRoleSeparation;
  const sources = optionalStringArray(p, "sources");
  if (sources instanceof Error) return sources;
  const verifyCommands = optionalStringArray(p, "verifyCommands");
  if (verifyCommands instanceof Error) return verifyCommands;
  const verifierAgentIds = optionalStringArray(p, "verifierAgentIds");
  if (verifierAgentIds instanceof Error) return verifierAgentIds;
  const artifactVerification = optionalArtifactVerification(p, "artifactVerification");
  if (artifactVerification instanceof Error) return artifactVerification;
  const profileRouting = optionalProfileRouting(p, "profileRouting");
  if (profileRouting instanceof Error) return profileRouting;
  const maxIterations = optionalPositiveInteger(p, "maxIterations");
  if (maxIterations instanceof Error) return maxIterations;
  const commandTimeoutMs = optionalPositiveInteger(p, "commandTimeoutMs");
  if (commandTimeoutMs instanceof Error) return commandTimeoutMs;
  const outputLimit = optionalPositiveInteger(p, "outputLimit");
  if (outputLimit instanceof Error) return outputLimit;
  const cycles = optionalPositiveInteger(p, "cycles");
  if (cycles instanceof Error) return cycles;
  const intervalMs = optionalNonNegativeInteger(p, "intervalMs");
  if (intervalMs instanceof Error) return intervalMs;
  const stopWhenIdle = optionalBoolean(p, "stopWhenIdle");
  if (stopWhenIdle instanceof Error) return stopWhenIdle;
  const knowledge = optionalKnowledgeTrace(p, "knowledge");
  if (knowledge instanceof Error) return knowledge;
  const discoveryPolicy = optionalDiscoveryPolicy(p, "discoveryPolicy");
  if (discoveryPolicy instanceof Error) return discoveryPolicy;
  const budget = optionalLoopBudget(p, "budget");
  if (budget instanceof Error) return budget;
  const lessonDrafts = optionalLessonDrafts(p, "lessonDrafts");
  if (lessonDrafts instanceof Error) return lessonDrafts;
  const neatFinalize = optionalBoolean(p, "neatFinalize");
  if (neatFinalize instanceof Error) return neatFinalize;

  const runOptions: LoopRunOptions = {
    workspacePath,
    stateFilePath,
    ...(markdownPath !== undefined ? { markdownPath } : {}),
    ...(loopId !== undefined ? { loopId } : {}),
    ...(executeCommand !== undefined ? { executeCommand } : {}),
    ...(agentId !== undefined ? { agentId } : {}),
    ...(autoAgent !== undefined ? { autoAgent } : {}),
    ...(goalCommand !== undefined ? { goalCommand } : {}),
    ...(archiveCompletedTasks !== undefined ? { archiveCompletedTasks } : {}),
    ...(useWorktree !== undefined ? { useWorktree } : {}),
    ...(enforceRoleSeparation !== undefined ? { enforceRoleSeparation } : {}),
    ...(worktreeRoot !== undefined ? { worktreeRoot } : {}),
    ...(sources !== undefined ? { sources } : {}),
    ...(verifyCommands !== undefined ? { verifyCommands } : {}),
    ...(verifierAgentIds !== undefined ? { verifierAgentIds } : {}),
    ...(artifactVerification !== undefined ? { artifactVerification } : {}),
    ...(profileRouting !== undefined ? { profileRouting } : {}),
    ...(discoveryPolicy !== undefined ? { discoveryPolicy } : {}),
    ...(budget !== undefined ? { budget } : {}),
    ...(lessonDrafts !== undefined ? { lessonDrafts } : {}),
    ...(maxIterations !== undefined ? { maxIterations } : {}),
    ...(commandTimeoutMs !== undefined ? { commandTimeoutMs } : {}),
    ...(outputLimit !== undefined ? { outputLimit } : {}),
    ...(knowledge !== undefined ? { knowledge } : {}),
  };
  const cyclesOptions = cycles !== undefined || intervalMs !== undefined || stopWhenIdle !== undefined
    ? {
        ...(cycles !== undefined ? { cycles } : {}),
        ...(intervalMs !== undefined ? { intervalMs } : {}),
        ...(stopWhenIdle !== undefined ? { stopWhenIdle } : {}),
      }
    : undefined;

  return {
    runOptions,
    neatFinalize: neatFinalize === true,
    ...(cyclesOptions !== undefined ? { cyclesOptions } : {}),
  };
}

function withLoopAdapters(ctx: DaemonContext, runOptions: LoopRunOptions): LoopRunOptions {
  // Kernel policy gate (R2.2): injected fresh on EVERY engine construction. The
  // gate re-reads `.osstack/policy.yaml` per consult (no caching), so a
  // long-lived session honors a mid-flight flip to `mode: observe` on its next
  // tick — the scheduler builds a new engine via this helper each cycle. Never
  // persisted into runOptions (it is a function; see withoutRuntimeAdapters).
  const policyGate = makePolicyGate(runOptions.workspacePath ?? process.cwd());
  if (
    runOptions.agentId === undefined
    && runOptions.autoAgent !== true
    && (runOptions.verifierAgentIds?.length ?? 0) === 0
  ) {
    return { ...runOptions, policyGate };
  }
  return {
    ...runOptions,
    adapters: Array.from(ctx.adapters.values()),
    policyEngine: ctx.policy,
    policyHistory: sqliteHistory(ctx.db),
    policyGate,
  };
}

function withoutRuntimeAdapters(runOptions: LoopRunOptions): LoopRunOptions {
  const copy: LoopRunOptions = { ...runOptions };
  delete copy.adapters;
  delete copy.policyEngine;
  delete copy.policyHistory;
  // Never persist the injected gate (a function): it is re-injected per engine
  // construction by withLoopAdapters, and JSON.stringify would drop it anyway.
  delete copy.policyGate;
  return copy;
}

function parseLoopStartParams(
  params: unknown,
): { runOptions: LoopRunOptions; schedule: LoopStartSchedule } | Error {
  const parsed = parseLoopRunParams(params);
  if (parsed instanceof Error) return parsed;
  const p = objectParams(params);
  if (p instanceof Error) return p;
  const intervalMs = optionalNonNegativeInteger(p, "intervalMs");
  if (intervalMs instanceof Error) return intervalMs;
  const scheduleExpression = optionalString(p, "schedule");
  if (scheduleExpression !== undefined) {
    const invalid = validateCronExpression(scheduleExpression);
    if (invalid !== undefined) return new Error(`params.schedule ${invalid.message}`);
  }
  const schedule: LoopStartSchedule = {
    intervalMs: intervalMs ?? 5_000,
    stopWhenIdle: parsed.cyclesOptions?.stopWhenIdle === true,
    ...(parsed.cyclesOptions?.cycles !== undefined ? { cycles: parsed.cyclesOptions.cycles } : {}),
    ...(scheduleExpression !== undefined ? { scheduleExpression } : {}),
  };
  return { runOptions: parsed.runOptions, schedule };
}

function parseLoopStatusParams(params: unknown): { workspacePath: string; stateFilePath: string } | Error {
  const p = objectParams(params);
  if (p instanceof Error) return p;
  const workspacePath = optionalString(p, "workspacePath") ?? process.cwd();
  const stateFilePath = optionalString(p, "stateFilePath") ?? "LOOP-STATE.json";
  return {
    workspacePath,
    stateFilePath: resolveDaemonLoopPath(stateFilePath, workspacePath),
  };
}

function resolveDaemonLoopPath(path: string, cwd: string): string {
  return isAbsolute(path) ? path : join(cwd, path);
}

function objectParams(params: unknown): Record<string, unknown> | Error {
  if (params === undefined || params === null) return {};
  if (typeof params !== "object" || Array.isArray(params)) {
    return new Error("params must be an object");
  }
  return params as Record<string, unknown>;
}

function optionalLessonDrafts(
  params: Record<string, unknown>,
  key: string,
): Partial<LessonDraftConfig> | undefined | Error {
  const value = params[key];
  if (value === undefined) return undefined;
  const parsed = LessonDraftConfig.partial().safeParse(value);
  if (!parsed.success) return new Error(`params.${key} must be a valid lesson draft config`);
  return {
    ...(parsed.data.enabled !== undefined ? { enabled: parsed.data.enabled } : {}),
    ...(parsed.data.dir !== undefined ? { dir: parsed.data.dir } : {}),
  };
}

function optionalLoopBudget(params: Record<string, unknown>, key: string): LoopBudget | undefined | Error {
  const value = params[key];
  if (value === undefined) return undefined;
  const parsed = LoopBudget.safeParse(value);
  if (!parsed.success) return new Error(`params.${key} must be a valid loop budget`);
  return parsed.data;
}

function optionalDiscoveryPolicy(params: Record<string, unknown>, key: string): DiscoveryPolicy | undefined | Error {
  const value = params[key];
  if (value === undefined) return undefined;
  const parsed = DiscoveryPolicy.safeParse(value);
  if (!parsed.success) return new Error(`params.${key} must be a valid discovery policy`);
  return parsed.data;
}

function optionalKnowledgeTrace(params: Record<string, unknown>, key: string): LoopKnowledgeTraceType | undefined | Error {
  const value = params[key];
  if (value === undefined) return undefined;
  const parsed = LoopKnowledgeTrace.safeParse(value);
  if (!parsed.success) return new Error(`params.${key} must be a valid loop knowledge trace`);
  return parsed.data;
}

function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" ? value : undefined;
}

function optionalStringArray(params: Record<string, unknown>, key: string): string[] | undefined | Error {
  const value = params[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    return new Error(`params.${key} must be an array of strings`);
  }
  return value;
}

function optionalArtifactVerification(
  params: Record<string, unknown>,
  key: string,
): ArtifactVerificationOptions | undefined | Error {
  const value = params[key];
  if (value === undefined) return undefined;
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    return new Error(`${key} must be an object`);
  }
  const object = value as Record<string, unknown>;
  const requireGitDiff = optionalBoolean(object, "requireGitDiff");
  if (requireGitDiff instanceof Error) return requireGitDiff;
  const targetPaths = optionalStringArray(object, "targetPaths");
  if (targetPaths instanceof Error) return targetPaths;
  const forbiddenPaths = optionalStringArray(object, "forbiddenPaths");
  if (forbiddenPaths instanceof Error) return forbiddenPaths;
  return {
    ...(requireGitDiff !== undefined ? { requireGitDiff } : {}),
    ...(targetPaths !== undefined ? { targetPaths } : {}),
    ...(forbiddenPaths !== undefined ? { forbiddenPaths } : {}),
  };
}

function optionalProfileRouting(
  params: Record<string, unknown>,
  key: string,
): LoopProfileRoutingEvidenceType | undefined | Error {
  const value = params[key];
  if (value === undefined) return undefined;
  const parsed = LoopProfileRoutingEvidence.safeParse(value);
  if (!parsed.success) {
    return new Error(
      `params.${key} must be valid profile routing evidence`,
    );
  }
  const {
    designer_agent_id: designerAgentId,
    designer_identity: designerIdentity,
    ...required
  } = parsed.data;
  return {
    ...required,
    ...(designerAgentId !== undefined
      ? { designer_agent_id: designerAgentId }
      : {}),
    ...(designerIdentity !== undefined
      ? { designer_identity: designerIdentity }
      : {}),
  };
}

function optionalPositiveInteger(params: Record<string, unknown>, key: string): number | undefined | Error {
  const value = params[key];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || typeof value !== "number" || value < 1) {
    return new Error(`params.${key} must be a positive integer`);
  }
  return value;
}

function optionalNonNegativeInteger(params: Record<string, unknown>, key: string): number | undefined | Error {
  const value = params[key];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || typeof value !== "number" || value < 0) {
    return new Error(`params.${key} must be a non-negative integer`);
  }
  return value;
}

function optionalBoolean(params: Record<string, unknown>, key: string): boolean | undefined | Error {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") return new Error(`params.${key} must be a boolean`);
  return value;
}

// ──────────────────────────────────────────────────────────────────────
// task.submit (streaming)
// ──────────────────────────────────────────────────────────────────────

interface TaskSubmitParams {
  prompt: string;
  title?: string;
  hermes_session_id?: string | null;
  capability_id?: string;
  /** CapabilityKind shortcut (e.g. "code.write"). Router picks the cheapest matching adapter. */
  kind?: string;
  agent_id?: string;
  /** Structured context handed to the adapter (e.g. autoresearch tag/max_iterations). */
  context?: Record<string, unknown>;
}

interface DaemonRunSlot {
  release(): Promise<void>;
}

const READ_ONLY_CAPABILITY_KINDS = new Set([
  "code.review",
  "review.code",
  "design.review",
  "doc.summarize",
  "plan.estimate",
  "research.web",
  "research.code",
  "release.check",
  "release.verify",
  "client.summarize",
  "matter.summarize",
  "risk.check",
  "verify.acceptance",
  "verify.alignment",
  "memory.read",
]);

function daemonAccessKind(capabilityKind: string): "read" | "write" {
  return READ_ONLY_CAPABILITY_KINDS.has(capabilityKind)
    ? "read"
    : "write";
}

function repoWriteSemaphore(
  ctx: DaemonContext,
  repoId: string,
): FifoSemaphore {
  const existing = ctx.repoWriteSemaphores.get(repoId);
  if (existing !== undefined) return existing;
  const created = new FifoSemaphore(1);
  ctx.repoWriteSemaphores.set(repoId, created);
  return created;
}

async function acquireDaemonRunSlot(
  ctx: DaemonContext,
  input: {
    kind: "read" | "write";
    run_id: string;
    repo_id?: string;
    signal?: AbortSignal;
  },
): Promise<DaemonRunSlot> {
  if (input.kind === "read") {
    const lease = await ctx.readSemaphore.acquire(input.signal);
    return {
      release: async () => {
        lease.release();
      },
    };
  }
  if (
    ctx.guardedAutonomy !== undefined
    && ctx.lastAutonomyHealth === undefined
  ) {
    throw new Error(
      "autonomy writes are blocked until the initial health check completes",
    );
  }
  if (ctx.lastAutonomyHealth?.can_run_local === false) {
    throw new Error(
      `autonomy writes are blocked by ${
        ctx.lastAutonomyHealth.write_blockers.join(",")
      }`,
    );
  }

  let repoSemaphore: FifoSemaphore | undefined;
  let repoLease: SemaphoreLease | undefined;
  let writeLease: SemaphoreLease | undefined;
  let fileLock: RepoWriteLock | undefined;
  try {
    if (input.repo_id !== undefined) {
      repoSemaphore = repoWriteSemaphore(ctx, input.repo_id);
      repoLease = await repoSemaphore.acquire(input.signal);
    }
    writeLease = await ctx.writeSemaphore.acquire(input.signal);
    if (input.repo_id !== undefined) {
      fileLock = await acquireRepoWriteLock({
        root_dir: join(osstackHome(), "locks", "repos"),
        repo_id: input.repo_id,
        autonomy_run_id: input.run_id,
        on_audit: (event) => {
          process.stderr.write(
            `osstack: ${JSON.stringify(event)}\n`,
          );
        },
      });
    }
  } catch (error) {
    writeLease?.release();
    repoLease?.release();
    if (
      input.repo_id !== undefined
      && repoSemaphore?.in_use === 0
      && repoSemaphore.pending === 0
    ) {
      ctx.repoWriteSemaphores.delete(input.repo_id);
    }
    throw error;
  }

  let released = false;
  return {
    release: async () => {
      if (released) return;
      released = true;
      try {
        await fileLock?.release();
      } finally {
        writeLease?.release();
        repoLease?.release();
        if (
          input.repo_id !== undefined
          && repoSemaphore?.in_use === 0
          && repoSemaphore.pending === 0
        ) {
          ctx.repoWriteSemaphores.delete(input.repo_id);
        }
      }
    },
  };
}

async function resumeGuardedAutonomy(
  ctx: DaemonContext,
  autonomyRunId: string,
  decision?: ScopedApprovalDecisionType,
  recoveryKind?: "restart",
): Promise<GuardedDeliveryResult> {
  if (ctx.guardedAutonomy === undefined) {
    throw new Error("guarded autonomy runtime is not configured");
  }
  const row = getAutonomyRun(ctx.db, autonomyRunId);
  if (row === undefined) {
    throw new Error(`no autonomy run with id=${autonomyRunId}`);
  }
  const slot = await acquireDaemonRunSlot(ctx, {
    kind: "write",
    run_id: autonomyRunId,
    repo_id: row.repo_id,
  });
  try {
    return await ctx.guardedAutonomy.resume(
      autonomyRunId,
      decision,
      recoveryKind === undefined ? undefined : { recoveryKind },
    );
  } finally {
    await slot.release();
  }
}

async function handleTaskSubmit(
  ctx: DaemonContext,
  req: DaemonRequest,
  sock: Socket,
): Promise<void> {
  const params = (req.params ?? {}) as TaskSubmitParams;
  if (typeof params.prompt !== "string" || params.prompt.length === 0) {
    sock.write(encodeFrame(singleErr(req.id, "bad_request", "params.prompt (non-empty string) required")));
    return;
  }
  if (ctx.draining) {
    sock.write(encodeFrame(singleErr(req.id, "draining", "daemon is draining for shutdown/upgrade; retry after restart")));
    return;
  }

  // S2 router gives us a baseline candidate. S3 policy refines it.
  type RouteReq = Parameters<typeof routeCapability>[0];
  type RouteKind = NonNullable<RouteReq["kind"]>;
  const routeReq: RouteReq = {};
  if (params.capability_id !== undefined) routeReq.capability_id = params.capability_id;
  if (typeof params.kind === "string") routeReq.kind = params.kind as RouteKind;
  if (params.agent_id !== undefined) {
    // FAIL-CLOSED type boundary: a non-string/empty agent_id is a client bug,
    // never a reason to fall back to default routing (G1.1 review F3).
    if (typeof params.agent_id !== "string" || params.agent_id.length === 0) {
      sock.write(encodeFrame(singleErr(req.id, "bad_request", "params.agent_id must be a non-empty string when provided")));
      return;
    }
    routeReq.agent_id = params.agent_id;
  }
  let routerPick: Awaited<ReturnType<typeof routeCapability>>;
  try {
    routerPick = await routeCapability(
      routeReq,
      Array.from(ctx.adapters.values()) as readonly RoutableAdapter[],
    );
  } catch (err) {
    // Explicit agent_id override could not be honored — FAIL-CLOSED to the
    // client; no run is created and no silent fallback occurs (G1.1).
    if (err instanceof AgentOverrideError) {
      sock.write(encodeFrame(singleErr(req.id, "agent_override_failed", err.message)));
      return;
    }
    throw err;
  }
  if (routerPick === null) {
    sock.write(encodeFrame(singleErr(req.id, "no_route", "no available adapter can serve this task")));
    return;
  }

  let chosenAgentId = routerPick.adapter.id;
  let chosenCapId = routerPick.capability.id;
  let routingReason = routerPick.reason;
  let policyDecision: PolicyDecision | null = null;
  let handoffNotice: string | undefined;

  // Run policy when the choice was kind-based (i.e. multiple adapters could
  // potentially have served the task). Skip for explicit overrides since
  // those represent a deliberate user choice.
  const isOverride = params.agent_id !== undefined
    || (params.capability_id !== undefined && routerPick.reason.startsWith("exact"));
  if (!isOverride) {
    const kind = routerPick.capability.kind;
    const candidates = Array.from(ctx.adapters.values()).map((a) => ({
      agent_id: a.id,
      cost_tier: a.cost_tier,
      capabilities: a.capabilities(),
    }));
    // Filter to adapters that actually advertise the kind AND are available.
    const eligible: typeof candidates = [];
    for (const c of candidates) {
      if (!c.capabilities.some((cap) => cap.kind === kind)) continue;
      const adapter = ctx.adapters.get(c.agent_id);
      if (!adapter) continue;
      const a = await adapter.isAvailable();
      if (a.available) eligible.push(c);
    }
    if (eligible.length >= 2) {
      policyDecision = ctx.policy.decide(
        { capability_id: routerPick.capability.id, kind, phase: "code", prompt: params.prompt },
        eligible,
        sqliteHistory(ctx.db),
      );
      if (policyDecision.winner) {
        chosenAgentId = policyDecision.winner.candidate.agent_id;
        // Find the capability with the matching kind on the chosen adapter.
        const chosenAdapter = ctx.adapters.get(chosenAgentId);
        const cap = chosenAdapter?.capabilities().find((c) => c.kind === kind);
        if (cap) chosenCapId = cap.id;
        const breakdownStr = policyDecision.winner.breakdown
          .map((b) => `${b.rule_id}=${b.value > 0 ? "+" : ""}${b.value.toFixed(1)}`)
          .join(", ");
        routingReason = `policy[${breakdownStr || "no rule scored"}], total=${policyDecision.winner.total.toFixed(1)}`;
        if (policyDecision.handoff.triggered) {
          handoffNotice = policyDecision.handoff.reason ?? "handoff_triggered";
        }
      }
    }
  }

  const adapter = ctx.adapters.get(chosenAgentId);
  if (!adapter) {
    sock.write(encodeFrame(singleErr(req.id, "internal", `router selected agent_id=${chosenAgentId} but no adapter found`)));
    return;
  }
  const agentId = adapter.id;
  const selectedCapId = chosenCapId;
  const selectedCapability = adapter.capabilities().find(
    (capability) => capability.id === selectedCapId,
  );
  if (selectedCapability === undefined) {
    sock.write(encodeFrame(singleErr(
      req.id,
      "internal",
      `selected capability ${selectedCapId} is not advertised by ${agentId}`,
    )));
    return;
  }

  const redact = ctx.redactor.redact(params.prompt);
  const cleanPrompt = redact.text;
  const piiRedactedCount = Object.values(redact.stats.counts).reduce((a, b) => a + b, 0);

  const task_id = `task_${randomUUID().slice(0, 8)}`;
  const run_id = `run_${randomUUID().slice(0, 8)}`;
  const session_id = params.hermes_session_id ?? `sess_${randomUUID().slice(0, 8)}`;
  const capability_id = selectedCapId;
  const startedAt = Date.now() / 1000;

  try {
    insertTask(ctx.db, ctx.dbPath, {
      task_id,
      title: params.title ?? cleanPrompt.slice(0, 80),
      ...(params.hermes_session_id != null ? { hermes_session_id: params.hermes_session_id } : {}),
      created_at: startedAt,
    });
    insertRun(ctx.db, ctx.dbPath, {
      run_id, task_id, session_id, agent_id: agentId, capability_id,
      phase: "code", started_at: startedAt,
      ...(params.hermes_session_id != null ? { hermes_session_id: params.hermes_session_id } : {}),
    });
    if (piiRedactedCount > 0) {
      ctx.db.prepare("UPDATE runs SET pii_redacted_count = ? WHERE run_id = ?")
        .run(piiRedactedCount, run_id);
    }
  } catch (err) {
    sock.write(encodeFrame(singleErr(req.id, "store_write_failed", (err as Error).message)));
    return;
  }

  const accepted: Record<string, unknown> = {
    type: "accepted",
    task_id, run_id, session_id,
    agent_id: agentId, capability_id,
    routing_reason: routingReason,
    pii_redacted_count: piiRedactedCount,
  };
  if (handoffNotice !== undefined) accepted["handoff_notice"] = handoffNotice;
  if (policyDecision !== null) {
    accepted["policy"] = {
      breakdown: policyDecision.winner?.breakdown ?? [],
      total: policyDecision.winner?.total ?? 0,
      handoff: policyDecision.handoff,
    };
  }
  sock.write(encodeFrame({ id: req.id, ok: true, result: accepted }));

  // osstack's own kanban: create a card for this run in the `running` lane.
  // This is the board Hermes/Telegram subscribes to. Best-effort; a card
  // write must never sink the run.
  try {
    ctx.kanban.createCard({
      card_id: `card_${run_id}`,
      task_id,
      title: params.title ?? cleanPrompt.slice(0, 80),
      body: `agent: ${agentId}\ncapability: ${capability_id}\nreason: ${routingReason}`,
      status: "running",
      assignee: agentId,
    });
  } catch (err) {
    process.stderr.write(`osstack: kanban.createCard failed: ${(err as Error).message}\n`);
  }

  // S4: mirror this task to Hermes kanban (best-effort, never blocks).
  void ctx.hermes.createKanbanTask({
    title: params.title ?? cleanPrompt.slice(0, 80),
    body: `osstack run\n• run_id: ${run_id}\n• agent: ${agentId}\n• capability: ${capability_id}\n• reason: ${routingReason}`,
    idempotencyKey: `osstack:${run_id}`,
    skills: ["osstack"],
  }).then((r) => {
    if (r.ok && r.task_id) ctx.hermesKanbanByRun.set(run_id, r.task_id);
    else if (!r.ok && r.reason !== "bridge_disabled") {
      process.stderr.write(`osstack: hermes.createKanbanTask failed: ${r.reason ?? "unknown"}\n`);
    }
  });

  const task: AgentTask = {
    run_id, task_id, session_id, capability_id, prompt: cleanPrompt,
    ...(params.context && typeof params.context === "object" ? { context: params.context } : {}),
  };
  const ac = new AbortController();
  ctx.activeRuns.set(run_id, ac);
  const onClose = (): void => ac.abort();
  sock.once("close", onClose);

  let lastOutcome: "completed" | "failed" | "cancelled" = "completed";
  let lastUsageTokensIn = 0;
  let lastUsageTokensOut = 0;
  let executionSlot: DaemonRunSlot | undefined;
  try {
    const repoId =
      typeof params.context?.["repo_id"] === "string"
      && params.context["repo_id"].length > 0
        ? params.context["repo_id"]
        : undefined;
    executionSlot = await acquireDaemonRunSlot(ctx, {
      kind: daemonAccessKind(selectedCapability.kind),
      run_id,
      ...(repoId === undefined ? {} : { repo_id: repoId }),
      signal: ac.signal,
    });
    for await (const ev of adapter.invoke(task, ac.signal)) {
      try {
        appendEvent(ctx.db, ctx.dbPath, ev);
      } catch (err) {
        process.stderr.write(`osstack: event persist failed: ${(err as Error).message}\n`);
      }
      if (ev.type === "usage.final") {
        const p = ev.payload as { tokens_in?: number; tokens_out?: number };
        lastUsageTokensIn = p.tokens_in ?? 0;
        lastUsageTokensOut = p.tokens_out ?? 0;
      }
      try { sock.write(encodeFrame(ev)); } catch { break; }
      if (ev.terminal) {
        if (ev.type === "done") {
          const status = (ev.payload as { status?: string }).status;
          if (status === "completed" || status === "failed" || status === "cancelled") lastOutcome = status;
        } else if (ev.type === "error") {
          lastOutcome = "failed";
        }
        break;
      }
    }
  } catch (err) {
    try {
      sock.write(encodeFrame({
        event_id: `${run_id}:err`,
        seq: -1, run_id, session_id,
        created_at: Date.now() / 1000, terminal: true, type: "error",
        payload: {
          code:
            err instanceof SemaphoreAcquireAbortedError
              ? "cancelled"
              : "adapter_threw",
          message: (err as Error).message,
          terminal: true,
        },
      }));
    } catch { /* socket gone */ }
    lastOutcome =
      err instanceof SemaphoreAcquireAbortedError
        ? "cancelled"
        : "failed";
  } finally {
    try {
      await executionSlot?.release();
    } catch (error) {
      process.stderr.write(
        `osstack: execution lock release failed for ${run_id}: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
    sock.off("close", onClose);
    ctx.activeRuns.delete(run_id);
    try {
      finalizeRun(ctx.db, ctx.dbPath, run_id, lastOutcome, Date.now() / 1000);
      if (lastUsageTokensIn || lastUsageTokensOut) {
        ctx.db.prepare("UPDATE runs SET tokens_in = ?, tokens_out = ? WHERE run_id = ?")
          .run(lastUsageTokensIn, lastUsageTokensOut, run_id);
      }
    } catch { /* keep going */ }

    // osstack kanban: move the card to its terminal lane. completed → done,
    // failed/cancelled → blocked (with the reason) so the board shows what
    // needs attention. Any subscriber (Telegram via Hermes) gets the event.
    try {
      const cardId = `card_${run_id}`;
      if (ctx.kanban.getCard(cardId)) {
        const summary = `${lastOutcome} — tokens=${lastUsageTokensIn}/${lastUsageTokensOut}`;
        if (lastOutcome === "completed") {
          ctx.kanban.moveCard(cardId, "done", { actor: agentId });
        } else {
          ctx.kanban.moveCard(cardId, "blocked", { actor: agentId, blocked_reason: summary });
        }
      }
    } catch (err) {
      process.stderr.write(`osstack: kanban move failed: ${(err as Error).message}\n`);
    }

    // S4: post terminal status to Hermes kanban if we have a tracked task.
    const kanbanId = ctx.hermesKanbanByRun.get(run_id);
    if (kanbanId !== undefined) {
      ctx.hermesKanbanByRun.delete(run_id);
      const summary = `osstack run ${lastOutcome} — tokens=${lastUsageTokensIn}/${lastUsageTokensOut}`;
      if (lastOutcome === "completed") {
        void ctx.hermes.complete(kanbanId, summary);
      } else {
        void ctx.hermes.comment(kanbanId, `[osstack] ${summary}`);
      }
    }

    // S5b: write the run to gbrain's knowledge graph (best-effort).
    const completedAt = Date.now() / 1000;
    void ctx.gbrain.writeRunPage({
      run_id,
      task_title: params.title ?? cleanPrompt.slice(0, 80),
      agent_id: agentId,
      capability_id,
      outcome: lastOutcome,
      duration_ms: (completedAt - startedAt) * 1000,
      tokens_in: lastUsageTokensIn,
      tokens_out: lastUsageTokensOut,
      started_at: startedAt,
    }).then((r) => {
      if (!r.ok && r.reason !== "gbrain_disabled") {
        process.stderr.write(`osstack: gbrain.writeRunPage failed: ${r.reason ?? "unknown"}\n`);
      }
    });
  }
}

// ──────────────────────────────────────────────────────────────────────
// task.observe (streaming replay)
// ──────────────────────────────────────────────────────────────────────

interface TaskObserveParams {
  run_id: string;
  after_seq?: number;
  /** Alternative cursor format compatible with the Hermes Run Adapter spec. */
  last_event_id?: string;
}

function handleTaskObserve(
  ctx: DaemonContext,
  req: DaemonRequest,
  sock: Socket,
): void {
  const params = (req.params ?? {}) as TaskObserveParams;
  if (typeof params.run_id !== "string") {
    sock.write(encodeFrame(singleErr(req.id, "bad_request", "params.run_id required")));
    return;
  }

  let afterSeq = params.after_seq ?? -1;
  if (typeof params.last_event_id === "string") {
    const m = params.last_event_id.match(/:(\d+)$/);
    if (m?.[1]) afterSeq = Math.max(afterSeq, Number.parseInt(m[1], 10));
  }

  // Acknowledge first.
  sock.write(encodeFrame({
    id: req.id, ok: true,
    result: { type: "accepted", run_id: params.run_id, after_seq: afterSeq, active: ctx.activeRuns.has(params.run_id) },
  }));

  // Snapshot replay from the events log. S1 is snapshot-only; S2 will add
  // live subscription via an internal event bus. Snapshot still works for
  // terminal runs (Hermes RFC Slice-1 success criterion).
  const rows = listEventsForRun(ctx.db, params.run_id, { afterSeq });

  for (const row of rows) {
    const ev = {
      event_id: row.event_id,
      seq: row.seq,
      run_id: row.run_id,
      session_id: row.session_id,
      created_at: row.created_at,
      terminal: row.terminal === 1,
      type: row.type,
      payload: safeParse(row.payload_json),
    };
    try { sock.write(encodeFrame(ev)); } catch { return; }
    if (row.terminal === 1) return;
  }

  // No terminal event in the log: tell the caller whether we expect more
  // (active) or whether replay is exhausted (orphaned / interrupted run).
  if (!ctx.activeRuns.has(params.run_id)) {
    try {
      sock.write(encodeFrame({
        event_id: `${params.run_id}:replay-end`,
        seq: rows.length > 0 ? rows[rows.length - 1]!.seq + 1 : 0,
        run_id: params.run_id, session_id: "",
        created_at: Date.now() / 1000, terminal: true, type: "error",
        payload: { code: "replay_no_terminal", message: "log ended without terminal event (likely a previous daemon crash)", terminal: true },
      }));
    } catch { /* socket gone */ }
  }
  // If the run is active but we have no live subscriber, the caller can
  // re-issue task.observe with the new after_seq cursor — RFC reconnect.
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return { _raw: s }; }
}

// ──────────────────────────────────────────────────────────────────────
// boot / shutdown
// ──────────────────────────────────────────────────────────────────────

function cleanupStaleSocket(path: string): void {
  if (!existsSync(path)) return;
  try {
    const st = statSync(path);
    if (!st.isSocket()) throw new Error(`Refusing to remove non-socket file at ${path}`);
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

function configuredConcurrency(
  value: number | undefined,
  envName: string,
  fallback: number,
): number {
  const raw = value ?? (
    process.env[envName] === undefined
      ? fallback
      : Number(process.env[envName])
  );
  if (!Number.isInteger(raw) || raw < 1 || raw > 128) {
    throw new Error(`${envName} must be an integer between 1 and 128`);
  }
  return raw;
}

function buildContext(
  options: {
    writeConcurrency?: number;
    readConcurrency?: number;
    socketPath?: string;
    adapters?: readonly AgentAdapter[];
  } = {},
): DaemonContext {
  const home = osstackHome();
  if (!existsSync(home)) mkdirSync(home, { recursive: true });
  const dbPath = join(home, "state.db");
  const loopSessionsPath = join(home, "loop-sessions.json");
  const dailySessionsPath = join(home, "daily-sessions.json");
  if (!existsSync(dirname(dbPath))) mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDb({ path: dbPath });
  try {
  const redactor = new PIIRedactor();
  const adapters = new Map<string, AgentAdapter>();

  // Register adapters from the shared default registry (also used by the OS
  // Deck CLI, so daemon and `osstack deck` agree on which agents exist). Order
  // doesn't matter once policy ranks them; each adapter's isAvailable() gates
  // whether it's a viable route on this machine.
  for (const a of options.adapters ?? [...defaultAdapters(), createControlledSessionAdapter({ state_directory: join(home, "controlled-sessions") })]) {
    adapters.set(a.id, a);
  }

  const policy = new PolicyEngine({ rules: DEFAULT_RULES });
  const hermes = new HermesBridge();   // disabled unless HERMES_KANBAN_BOARD is set
  const gbrain = new GBrainAdapter();  // disabled unless OSSTACK_GBRAIN=1
  const kanban = new KanbanRepository(db, dbPath);
  const sessions = new SessionRepository(db, dbPath);
  const continuations = new SessionContinuationRepository(db, dbPath);
  return {
    dbPath, loopSessionsPath, dailySessionsPath, db, redactor, adapters, policy, hermes, gbrain, kanban, sessions, continuations, collaborator: undefined,
    dashboardUrl: null,
    activeRuns: new Map(),
    activeSessionSends: new Set(),
    loopSessions: new Map(),
    dailySessions: new Map(),
    hermesKanbanByRun: new Map(),
    rpcLatency: new RpcLatencyRecorder(),
    draining: false,
    drainingFromHealth: false,
    requestShutdown: () => { /* wired up in startDaemon */ },
    guardedAutonomy: undefined,
    writeSemaphore: new FifoSemaphore(configuredConcurrency(
      options.writeConcurrency,
      "OSSTACK_WRITE_CONCURRENCY",
      DEFAULT_WRITE_CONCURRENCY,
    )),
    readSemaphore: new FifoSemaphore(configuredConcurrency(
      options.readConcurrency,
      "OSSTACK_READ_CONCURRENCY",
      DEFAULT_READ_CONCURRENCY,
    )),
    repoWriteSemaphores: new Map(),
    autonomyHealth: async () => await runAutonomyHealth({
      db,
      db_path: dbPath,
      home,
      socket_path: options.socketPath ?? resolveSocketPath(),
      power_policy:
        process.env["OSSTACK_POWER_POLICY"] === "process_assertion"
          ? "process_assertion"
          : "none",
      clock_monitor:
        process.env["OSSTACK_CLOCK_MONITOR"] === "monotonic-v1",
      require_launchd:
        process.platform === "darwin"
        && process.env["OSSTACK_AGENT_PROFILE"] === "mac-mini",
    }),
    lastAutonomyHealth: undefined,
  };
  } catch (error) { db.close(); throw error; }
}

export interface DaemonHandles {
  close: () => Promise<void>;
  socketPath: string;
  dbPath: string;
}

export interface StartDaemonOptions {
  /** Trusted owner public keys only; absent means read continuation-trust.json. */
  continuationTrustedPublicKeys?: ReadonlyMap<string, string>;
  socketPath?: string;
  /** Test/embedding hook; production continues to use the default registry. */
  adapters?: readonly AgentAdapter[];
  writeConcurrency?: number;
  readConcurrency?: number;
  autonomyHealth?: () => Promise<AutonomyHealthReport>;
  healthPollIntervalMs?: number;
  notificationSender?: AutonomyNotificationSender;
  wallClockMs?: () => number;
  monotonicClockMs?: () => number;
  clockJumpThresholdMs?: number;
  guardedAutonomyFactory?: (
    db: Database.Database,
    dbPath: string,
  ) =>
    | GuardedAutonomyDaemonRuntime
    | Promise<GuardedAutonomyDaemonRuntime>;
}

function environmentPositiveInteger(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`${name} must be a positive integer`);
  }
  return Number(raw);
}

async function restoreGuardedAutonomy(
  ctx: DaemonContext,
  health: AutonomyHealthReport | undefined = ctx.lastAutonomyHealth,
): Promise<void> {
  if (ctx.guardedAutonomy === undefined) return;
  if (health?.can_run_local === false) return;
  const githubRecoveryStates = new Set([
    "blocked_delivery",
    "pushing",
    "opening_pr",
    "waiting_ci",
    "merging",
  ]);
  await Promise.all(
    listResumableAutonomyRuns(ctx.db)
      .filter((row) => row.state !== "awaiting_approval")
      .filter(
        (row) =>
          health?.can_push_deploy !== false
          || !githubRecoveryStates.has(row.state),
      )
      .map(async (row) => {
        try {
          await resumeGuardedAutonomy(
            ctx,
            row.autonomy_run_id,
            undefined,
            "restart",
          );
        } catch (error) {
          process.stderr.write(
            `osstack: autonomy recovery failed for ${row.autonomy_run_id}: ${
              error instanceof Error ? error.message : String(error)
            }\n`,
          );
        }
      }),
  );
}

async function refreshAutonomyHealthAndRecover(
  ctx: DaemonContext,
  recover: boolean,
  notificationSender?: AutonomyNotificationSender,
): Promise<void> {
  try {
    const maxLogBytes = environmentPositiveInteger(
      "OSSTACK_LOG_MAX_BYTES",
    );
    const maxLogFiles = environmentPositiveInteger(
      "OSSTACK_LOG_MAX_FILES",
    );
    const proofRetentionDays = environmentPositiveInteger(
      "OSSTACK_PROOF_RETENTION_DAYS",
    );
    const proofMinKeep = environmentPositiveInteger(
      "OSSTACK_PROOF_MIN_KEEP",
    );
    await enforceAutonomyRetention({
      home: osstackHome(),
      db: ctx.db,
      ...(maxLogBytes === undefined
        ? {}
        : { max_log_bytes: maxLogBytes }),
      ...(maxLogFiles === undefined
        ? {}
        : { max_log_files: maxLogFiles }),
      ...(proofRetentionDays === undefined
        ? {}
        : { proof_retention_days: proofRetentionDays }),
      ...(proofMinKeep === undefined
        ? {}
        : { proof_min_keep: proofMinKeep }),
    });
  } catch (error) {
    process.stderr.write(
      `osstack: autonomy retention failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  }
  if (notificationSender !== undefined) {
    try {
      await drainAutonomyNotifications({
        db: ctx.db,
        db_path: ctx.dbPath,
        sender: notificationSender,
      });
    } catch (error) {
      process.stderr.write(
        `osstack: autonomy notification drain failed: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
  }
  if (ctx.guardedAutonomy === undefined) return;
  const previous = ctx.lastAutonomyHealth;
  let current: AutonomyHealthReport;
  try {
    current = await ctx.autonomyHealth();
  } catch (error) {
    process.stderr.write(
      `osstack: autonomy health probe failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return;
  }
  ctx.lastAutonomyHealth = current;
  applyAutonomyDrainSignal(ctx, current.drain_required);
  ctx.collaborator?.resumePending();
  const externalRecovered =
    previous !== undefined
    && !previous.can_push_deploy
    && current.can_push_deploy;
  if (recover || externalRecovered) {
    await restoreGuardedAutonomy(ctx, current);
  }
}

/**
 * Raise or clear `draining` from an autonomy health verdict.
 *
 * The drain used to be a one-way latch: a dip below the 2 GiB autonomy floor
 * set `draining` and nothing ever cleared it, so the daemon kept refusing
 * work long after the disk recovered and only a restart brought it back
 * (observed 2026-08-13 — 19 GB of unpruned shadow checkpoints filled the
 * disk, and the daemon stayed drained for 12 h after space was freed).
 * An operator/upgrade drain is never auto-cleared.
 */
function applyAutonomyDrainSignal(ctx: DaemonContext, drainRequired: boolean): void {
  if (drainRequired) {
    // Only claim ownership on the transition INTO draining. Marking an
    // already-draining daemon would relabel an operator/upgrade drain as
    // health-raised, and the next healthy probe would then lift it — the
    // exact sequence (operator drain → bad probe → good probe) that Kimi K3
    // reproduced against the first cut of this fix.
    if (!ctx.draining) ctx.drainingFromHealth = true;
    ctx.draining = true;
    return;
  }
  if (ctx.draining && ctx.drainingFromHealth) {
    ctx.draining = false;
    ctx.drainingFromHealth = false;
    ctx.collaborator?.resumePending();
    process.stderr.write("osstack: autonomy health recovered — daemon resumed accepting work\n");
  }
}

function collaboratorPaused(ctx: DaemonContext): boolean {
  return ctx.draining || (ctx.guardedAutonomy !== undefined
    && (ctx.lastAutonomyHealth === undefined || !ctx.lastAutonomyHealth.can_run_local || ctx.lastAutonomyHealth.drain_required));
}

export async function startDaemon(
  opts: StartDaemonOptions = {},
): Promise<DaemonHandles> {
  const socketPath = opts.socketPath ?? resolveSocketPath();
  const continuationTrust = new Map(opts.continuationTrustedPublicKeys
    ?? await readContinuationTrust(join(osstackHome(), "continuation-trust.json")));
  // Refuse to start when another daemon already owns the pidfile — two
  // daemons would race for the socket and share the SQLite writer.
  const releaseLock = acquireDaemonLock(pidFilePath());
  let failedContext: DaemonContext | undefined;
  let stopUpdates: (() => void) | undefined;
  let failedServer: ReturnType<typeof createServer> | undefined;
  try {
  cleanupStaleSocket(socketPath);
  // Bring up OTel before the daemon context so spans capture everything.
  await initOtel({ serviceVersion: DAEMON_VERSION });
  const ctx = buildContext({
    socketPath,
    ...(opts.adapters === undefined ? {} : { adapters: opts.adapters }),
    ...(opts.writeConcurrency === undefined
      ? {}
      : { writeConcurrency: opts.writeConcurrency }),
    ...(opts.readConcurrency === undefined
      ? {}
      : { readConcurrency: opts.readConcurrency }),
  });
  failedContext = ctx;
  if (process.env["OSSTACK_ATTENTION"] === "1") { ctx.supervision = new SupervisionService(ctx.db, ctx.dbPath); ctx.supervision.start(); }
  ctx.collaborator = new SessionCollaborator({
    repository: ctx.continuations,
    adapters: ctx.adapters,
    trustedPublicKeys: continuationTrust,
    draining: () => collaboratorPaused(ctx),
    send: async (reservation, controller) => {
      const session = ctx.sessions.getSession(reservation.grant.body.session_id);
      const adapter = ctx.adapters.get(reservation.grant.body.runtime_id);
      if (collaboratorPaused(ctx) || controller.signal.aborted) return { ok: false, error: { code: "continuation_cancelled" } };
      if (session === undefined || adapter === undefined || !isSessionCapableAdapter(adapter)) {
        return { ok: false, error: { code: "resume_unsupported" } };
      }
      if (ctx.activeSessionSends.has(session.session_id)) return { ok: false, error: { code: "session_busy" } };
      return await executeReservedSessionTurn(ctx, { id: reservation.attempt.attempt_id, method: "collaborator.resume" }, {
        session_id: session.session_id,
        runtime_id: session.agent_id,
        turn_id: reservation.message.turn_id,
        message_id: reservation.message.message_id,
        expected_version: reservation.reservation_version - 1,
        text: reservation.prompt,
        requested_by: `agent:collaborator:${reservation.grant.body.grant_id}`,
      }, session, adapter, reservation.reservation_version, {
        controller,
        completed: (turnId, version, now) => {
          // Timers are cooperative: a blocked event loop can deliver completion
          // before an overdue abort callback. Keep the real receipt, but expire
          // the delegation inside this same completion transaction.
          const grant = reservation.grant;
          if (now * 1000 >= Date.parse(grant.body.expires_at)) ctx.continuations.block(grant.grant_id, "expired", now);
          else if ((now - reservation.message.created_at) * 1000 >= grant.body.turn_timeout_ms) ctx.continuations.block(grant.grant_id, "turn_timeout", now);
          ctx.continuations.completeAttempt(reservation.attempt.attempt_id, turnId, version, now);
        },
      });
    },
  });
  if (opts.autonomyHealth !== undefined) {
    ctx.autonomyHealth = opts.autonomyHealth;
  }
  if (opts.guardedAutonomyFactory !== undefined) {
    ctx.guardedAutonomy = await opts.guardedAutonomyFactory(
      ctx.db,
      ctx.dbPath,
    );
  }
  const stopUpdateChecker = startUpdateChecker();
  stopUpdates = stopUpdateChecker;
  let dashboard: DashboardServerHandle | null = null;

  const server = createServer((sock: Socket) => {
    const decoder = new FrameDecoder();

    sock.on("data", (chunk) => {
      try {
        const frames = decoder.push(chunk);
        for (const raw of frames) {
          const req = raw as DaemonRequest;
          if (typeof req !== "object" || req === null || typeof req.method !== "string") {
            sock.write(encodeFrame(singleErr(req?.id ?? 0, "bad_request", "request must have a 'method' string")));
            continue;
          }

          // Wall-clock per request, recorded into the per-method latency
          // window that `osstack stats` reports. For the streaming methods
          // (task.submit/task.observe) this measures the full handler
          // lifetime, not time-to-first-byte.
          const startedAt = performance.now();
          const recordLatency = (): void => {
            ctx.rpcLatency.record(req.method, performance.now() - startedAt);
          };

          if (req.method === "task.submit") {
            void traceSpan(
              "osstack.task.submit",
              { "osstack.method": req.method },
              () => handleTaskSubmit(ctx, req, sock),
            ).finally(recordLatency);
            continue;
          }
          if (req.method === "task.observe") {
            void traceSpan(
              "osstack.task.observe",
              { "osstack.method": req.method },
              async () => handleTaskObserve(ctx, req, sock),
            ).finally(recordLatency);
            continue;
          }

          void traceSpan(
            "osstack.rpc",
            { "osstack.method": req.method },
            async () => {
              const resp = await handleSingle(ctx, req);
              if (resp === null) return;
              try { sock.write(encodeFrame(resp)); } catch { /* socket gone */ }
            },
          ).finally(recordLatency);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        try { sock.write(encodeFrame({ id: 0, ok: false, error: { code: "framing", message } })); } catch { /* socket dead */ }
        sock.destroy();
      }
    });

    sock.on("error", () => { /* don't crash on client hangups */ });
  });

  failedServer = server;
  ctx.collaborator?.recover();
  return await new Promise((resolve, reject) => {
    server.once("error", reject);
    void Promise.all([restoreLoopSessions(ctx), restoreDailySessions(ctx)]).then(() => {
      server.listen(socketPath, () => {
      try { chmodSync(socketPath, 0o600); } catch { /* best effort */ }

      let healthPollPending = true;
      let guardedRecovery = refreshAutonomyHealthAndRecover(
        ctx,
        true,
        opts.notificationSender,
      )
        .finally(() => {
          healthPollPending = false;
        });
      const healthPollIntervalMs = Math.max(
        10,
        opts.healthPollIntervalMs ?? 30_000,
      );
      const wallClockMs = opts.wallClockMs ?? Date.now;
      const monotonicClockMs =
        opts.monotonicClockMs ?? (() => performance.now());
      const clockDetector = new ClockJumpDetector(
        opts.clockJumpThresholdMs ?? 120_000,
      );
      clockDetector.observe(wallClockMs(), monotonicClockMs());
      const healthMonitor =
        ctx.guardedAutonomy === undefined
          && opts.notificationSender === undefined
          ? undefined
          : setInterval(() => {
              if (healthPollPending) return;
              healthPollPending = true;
              const clock = clockDetector.observe(
                wallClockMs(),
                monotonicClockMs(),
              );
              if (clock.jump_detected) {
                process.stderr.write(
                  `osstack: clock jump detected drift_ms=${clock.drift_ms}; re-running external health and recovery probes\n`,
                );
              }
              guardedRecovery = refreshAutonomyHealthAndRecover(
                ctx,
                clock.jump_detected,
                opts.notificationSender,
              )
                .catch((error) => {
                  process.stderr.write(
                    `osstack: autonomy recovery monitor failed: ${
                      error instanceof Error ? error.message : String(error)
                    }\n`,
                  );
                })
                .finally(() => {
                  healthPollPending = false;
                });
            }, healthPollIntervalMs);
      healthMonitor?.unref();
      let shutdownPromise: Promise<void> | undefined;
      const shutdown = async (): Promise<void> => {
        if (shutdownPromise !== undefined) return await shutdownPromise;
        process.off("SIGTERM", onSig);
        process.off("SIGINT", onSig);
        try { stopUpdateChecker(); } catch { /* cleanup must continue */ }
        if (healthMonitor !== undefined) clearInterval(healthMonitor);
        shutdownPromise = (async () => {
          ctx.draining = true;
          ctx.supervision?.stop();
          const collaboratorStopped = Promise.resolve().then(() => ctx.collaborator?.stop());
          // Abort any active runs so adapters get a chance to clean up.
          for (const ac of ctx.activeRuns.values()) ac.abort();
          for (const session of ctx.loopSessions.values()) {
            session.shutdownRequested = true;
            session.abort.abort();
          }
          for (const session of ctx.dailySessions.values()) {
            session.shutdownRequested = true;
            session.abort.abort();
          }
          const loopCompletions = Array.from(ctx.loopSessions.values())
            .map((session) => session.done)
            .filter((done): done is Promise<void> => done !== undefined);
          const dailyCompletions = Array.from(ctx.dailySessions.values())
            .map((session) => session.done)
            .filter((done): done is Promise<void> => done !== undefined);
          await Promise.allSettled([
            ...loopCompletions,
            ...dailyCompletions,
            guardedRecovery,
            collaboratorStopped,
          ]);
          await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
          try { if (dashboard !== null) await dashboard.close(); }
          finally {
            try { ctx.db.close(); }
            finally {
              try { cleanupStaleSocket(socketPath); } catch { /* diagnostics only */ }
              try { await shutdownOtel(); } finally { releaseLock(); }
            }
          }
        })();
        return await shutdownPromise;
      };
      const onSig = (): void => { void shutdown().then(() => process.exit(0)); };
      process.once("SIGTERM", onSig);
      process.once("SIGINT", onSig);
      ctx.requestShutdown = onSig;

      const dashOpts = dashboardUrlFromEnv();
      void startDashboardServer(
        () => createDashboardSnapshot({
          db: ctx.db,
          kanban: ctx.kanban,
          dbPath: ctx.dbPath,
          version: DAEMON_VERSION,
          phase: DAEMON_PHASE,
          dashboardUrl: ctx.dashboardUrl ?? dashboardUrl(dashOpts),
          adapters: Array.from(ctx.adapters.values()).map((a) => ({
            id: a.id,
            display_name: a.display_name,
            cost_tier: a.cost_tier,
          })),
          activeRuns: ctx.activeRuns.size,
          activeLoops: activeLoopCount(ctx),
        }),
        dashOpts,
      ).then((handle) => {
        dashboard = handle;
        ctx.dashboardUrl = handle.url;
      }).catch((err) => {
        process.stderr.write(`osstack: dashboard server failed: ${(err as Error).message}\n`);
      });

      resolve({ close: shutdown, socketPath, dbPath: ctx.dbPath });
      });
    }).catch(reject);
  });
  } catch (error) {
    // Preserve the startup error; every acquired resource gets its own cleanup.
    try { stopUpdates?.(); } catch { /* continue cleanup */ }
    if (failedContext) {
      failedContext.draining = true;
      failedContext.supervision?.stop();
      const stopped = Promise.resolve().then(() => failedContext!.collaborator?.stop());
      for (const session of [...failedContext.dailySessions.values(), ...failedContext.loopSessions.values()]) {
        session.shutdownRequested = true; session.abort.abort();
      }
      await Promise.allSettled([stopped, ...[...failedContext.dailySessions.values(), ...failedContext.loopSessions.values()].map((session) => session.done)]);
    }
    try { if (failedServer) await new Promise<void>((done) => failedServer!.close(() => done())); } catch { /* unbound */ }
    try { failedContext?.db.close(); } catch { /* continue cleanup */ }
    try { await shutdownOtel(); } catch { /* preserve original error */ }
    finally { releaseLock(); }
    throw error;
  }
}

