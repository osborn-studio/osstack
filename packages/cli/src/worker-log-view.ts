import { createHash, timingSafeEqual } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import type Database from "better-sqlite3";
import { CURRENT_SCHEMA_VERSION } from "@osstack/core";
import { z } from "zod";
import { readPrivateDeliveryFile } from "./follow-up-delivery-host.js";
import { serializeWorkerView } from "./worker-view-service.js";
const path = z.string().min(1).max(4096).refine(isAbsolute);
const capability = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const WorkerLogParams = z.object({repo_path:path,default_tenant:z.literal(true),capability,
  before_ordinal:z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional()}).strict();
const grant = z.object({repo_path:path,session_id:z.string().min(1).max(256),capability_sha256:z.string().regex(/^[a-f0-9]{64}$/),
  issued_at_ms:z.number().int().nonnegative(),expires_at_ms:z.number().int().nonnegative(),content:z.literal("persisted_assistant_text")}).strict();
export const WorkerLogRegistry = z.object({schema_version:z.literal(1),grants:z.array(grant).max(32)}).strict();
const digest = (bytes: Buffer|string)=>createHash("sha256").update(bytes).digest();
/** Separate, explicitly host-issued content capability. Ordinary worker view tokens cannot read text.
 * Reads only bounded persisted session output, never arbitrary paths, tool payloads or native process logs. */
export async function inspectWorkerLogs(db: Database.Database, home: string, raw: unknown, clock:()=>number=Date.now, signal?:AbortSignal) {
  const nowMs=clock();
  const params = WorkerLogParams.parse(raw); const repo=realpathSync(params.repo_path);
  if(repo!==params.repo_path || !Number.isSafeInteger(nowMs)) throw Error("worker_log_unavailable");
  const relativeHome=relative(repo,home);
  if(relativeHome==="" || (!isAbsolute(relativeHome) && relativeHome!==".." && !relativeHome.startsWith(`..${sep}`)))throw Error("worker_log_unavailable");
  const registryPath=join(home,"worker-log-grants.json");
  const bytes=await readPrivateDeliveryFile(registryPath,32768);
  const registry=WorkerLogRegistry.parse(JSON.parse(bytes.toString("utf8")));
  const tokenHash=digest(params.capability);
  const matches=registry.grants.filter(g=>timingSafeEqual(Buffer.from(g.capability_sha256,"hex"),tokenHash));
  if(matches.length!==1)throw Error("worker_log_unavailable");
  const auth=matches[0]!;
  if(auth.repo_path!==repo || auth.issued_at_ms>nowMs || auth.expires_at_ms<=nowMs || auth.expires_at_ms-auth.issued_at_ms>900000 || auth.expires_at_ms<=auth.issued_at_ms)throw Error("worker_log_unavailable");
  // Re-read authorization after asynchronous file work, before synchronous snapshot. No writes/migrations.
  if(!timingSafeEqual(digest(await readPrivateDeliveryFile(registryPath,32768)),digest(bytes)))throw Error("worker_log_unavailable");
  const current=clock();
  if(!Number.isSafeInteger(current)||current<nowMs||current>=auth.expires_at_ms)throw Error("worker_log_unavailable");
  if(signal?.aborted)throw Error("worker_log_unavailable");
  const result=db.transaction(()=>{
    const version=db.pragma("user_version",{simple:true});
    if(typeof version!=="number" || version<24 || version>CURRENT_SCHEMA_VERSION)throw Error("worker_log_unavailable");
    const bound=db.prepare(`SELECT s.session_id FROM agent_sessions s JOIN tasks t ON t.task_id=s.task_id
      JOIN runs r ON r.run_id=s.run_id AND r.task_id=s.task_id AND r.session_id=s.session_id AND r.agent_id=s.agent_id
      WHERE s.session_id=? AND s.repo_path=? AND t.tenant_id IS NULL AND r.tenant_id IS NULL`).get(auth.session_id,repo);
    if(!bound)throw Error("worker_log_unavailable");
    const rows=db.prepare(`SELECT ordinal, state, updated_at, length(CAST(assistant_text AS BLOB)) AS total_bytes,
      substr(CAST(assistant_text AS BLOB),1,2048) AS excerpt FROM session_turns
      WHERE session_id=? AND ordinal<? ORDER BY ordinal DESC LIMIT 5`).all(auth.session_id,params.before_ordinal??Number.MAX_SAFE_INTEGER) as {ordinal:number;state:string;updated_at:number;total_bytes:number;excerpt:Buffer}[];
    const page=rows.slice(0,4);
    return {schema_version:1,scope:{repo_path:repo,tenant:"default"},content:"persisted_assistant_text",sampled_at_ms:nowMs,
      trust:"untrusted_worker_output",process_liveness:"unknown",controls:"unsupported",snapshot_atomic:true,
      entries:page.map(row=>({ordinal:row.ordinal,state:row.state,updated_at:row.updated_at,text:row.excerpt.toString("utf8"),
        total_bytes:row.total_bytes,returned_bytes:row.excerpt.length,truncated:row.total_bytes>row.excerpt.length})).reverse(),
      next_before_ordinal:rows.length>4?page.at(-1)!.ordinal:null,grant_expires_at_ms:auth.expires_at_ms};
  })();
  if(Buffer.byteLength(serializeWorkerView(result))>65535)throw Error("worker_log_unavailable");
  return result;
}
export async function handleWorkerLogCommand(args:string[],deps:{rpc:(params:z.infer<typeof WorkerLogParams>)=>Promise<unknown>;out?:(value:string)=>void}){
  const out=deps.out??console.log;
  if((args.length===1 && args[0]==="--help") || (args.length===2 && args[0]==="logs" && args[1]==="--help")) {out("worker logs --grant-file PRIVATE_FILE [--before-ordinal N]\nSeparate host content grant; bounded persisted assistant output, not live process stdout. No worker controls.");return 0;}
  try{
    if(args[0]!=="logs" || ![3,5].includes(args.length) || args[1]!=="--grant-file" || !args[2])throw Error();
    if(args.length===5 && (args[3]!=="--before-ordinal" || !/^[1-9][0-9]*$/.test(args[4]!)))throw Error();
    const params=WorkerLogParams.parse({...JSON.parse((await readPrivateDeliveryFile(args[2],8192)).toString("utf8")),
      ...(args.length===5?{before_ordinal:Number(args[4])}:{})});
    const result=await deps.rpc(params);
    // RPC response is untrusted; scope and shape must be checked before showing any text.
    const schema=z.object({schema_version:z.literal(1),scope:z.object({repo_path:z.literal(params.repo_path),tenant:z.literal("default")}).strict(),
      content:z.literal("persisted_assistant_text"),sampled_at_ms:z.number().int(),trust:z.literal("untrusted_worker_output"),process_liveness:z.literal("unknown"),controls:z.literal("unsupported"),snapshot_atomic:z.literal(true),
      entries:z.array(z.object({ordinal:z.number().int().positive(),state:z.string().max(32),updated_at:z.number(),text:z.string().max(2048),total_bytes:z.number().int().nonnegative(),returned_bytes:z.number().int().max(2048),truncated:z.boolean()}).strict()).max(4),
      next_before_ordinal:z.number().int().positive().nullable(),grant_expires_at_ms:z.number().int()}).strict();
    const text=serializeWorkerView(schema.parse(result));if(Buffer.byteLength(text)>65535)throw Error();out(text);return 0;
  }catch{out(JSON.stringify({state:"unavailable",reason:"worker_log_unavailable"}));return 1;}
}
