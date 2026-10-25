import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { Readable, Writable } from "node:stream";
import { z } from "zod";

export const REMOTE_MAX_BYTES = 65536;
export const REMOTE_PROTOCOL = 1;
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const alias = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
const path = z.string().min(1).max(4096).refine(isAbsolute).refine(s => !/[\p{C}]/u.test(s));
const home = z.string().regex(/^home_[a-f0-9]{32}$/);
const generation = z.string().regex(/^instance_[a-f0-9]{32}$/);
const epoch = z.number().int().safe().nonnegative();
const nonce = z.string().regex(/^[a-f0-9]{64}$/);
const hostKey = z.string().max(128).refine(s => {
  if (!/^ssh-ed25519 [A-Za-z0-9+/]+={0,2}$/.test(s)) return false;
  const encoded = s.slice(12), bytes = Buffer.from(encoded, "base64");
  return bytes.toString("base64") === encoded && bytes.length === 51 && bytes.readUInt32BE(0) === 11 && bytes.subarray(4,15).toString() === "ssh-ed25519" && bytes.readUInt32BE(15) === 32;
});
export const RemoteHomeEntry = z.object({
  alias, host: z.string().max(253).regex(/^[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?$/),
  port: z.number().int().min(1).max(65535), user: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_-]{0,63}$/),
  host_key: hostKey, identity_file: path.refine(s => !/[\s%'"\\]/u.test(s)), home_id: home, daemon_protocol: z.number().int().positive(), registry_sha256: digest, scope: alias,
}).strict();
export type RemoteHomeEntry = z.infer<typeof RemoteHomeEntry>;
export const RemoteClientRegistry = z.object({version:z.literal(1),homes:z.array(RemoteHomeEntry).min(1).max(32)}).strict()
  .refine(r => new Set(r.homes.map(h=>h.alias)).size===r.homes.length);
export const RemoteServerRegistry = z.object({version:z.literal(1),home_id:home,daemon_protocol:z.number().int().positive(),socket:path,
  scopes:z.array(z.object({alias,repo_path:path,default_tenant:z.literal(true)}).strict()).min(1).max(16),
}).strict().refine(r=>new Set(r.scopes.map(s=>s.alias)).size===r.scopes.length);
export type RemoteServerRegistry = z.infer<typeof RemoteServerRegistry>;
export const RemoteHello = z.object({type:z.literal("hello"),protocol:z.literal(1),nonce,home_id:home,daemon_protocol:z.number().int().positive(),registry_sha256:digest,scope:alias}).strict();
export const RemoteRead = z.object({type:z.literal("snapshot"),token:nonce,sequence:z.literal(1),limit:z.number().int().min(1).max(50)}).strict();
const binding = {protocol:z.literal(1),nonce,home_id:home,generation,daemon_protocol:z.number().int().positive(),registry_sha256:digest,scope:alias};
export const RemoteGrant = z.object({...binding,type:z.literal("grant"),token:nonce,methods:z.tuple([z.literal("snapshot")]),max_page:z.literal(50)}).strict();
const state = z.enum(["starting","running","awaiting_decision","idle","completed","failed","cancelled","expired","outcome_pending","unknown"]);
export const RemoteView = z.object({observation_ref:z.string().regex(/^view_[0-9]{1,2}$/),source_kind:z.enum(["run","session"]),state,
  revision:z.number().int().safe().positive().nullable(),last_updated_at_ms:epoch.nullable(),
  source_freshness:z.enum(["recent","stale","unknown"]),process_liveness:z.literal("unknown"),
  wait_reason:z.enum(["decision_record_present","delivery_unknown","awaiting_instruction","none","unknown"]),
  decision_present:z.boolean(),uncertain_delivery_recorded:z.boolean(),controls:z.literal("unsupported"),
}).strict();
export const RemoteSnapshot = z.object({...binding,type:z.literal("snapshot"),sequence:z.literal(1),sampled_at_ms:epoch,
  total:z.number().int().safe().nonnegative(),views:z.array(RemoteView).max(50),has_more:z.boolean(),complete:z.boolean(),
  coverage:z.literal("default_tenant_bound_session_run_only"),evidence_sha256:digest,
}).strict().refine(s=>s.complete===!s.has_more && s.total>=s.views.length && (s.has_more || s.total===s.views.length))
  .refine(s=>s.views.every((v,i)=>v.observation_ref===`view_${i+1}`));
export type RemoteSnapshot = z.infer<typeof RemoteSnapshot>;
export const remoteHash = (value: string | Buffer): string => createHash("sha256").update(value).digest("hex");
function canonical(value:unknown):string {
  if(Array.isArray(value))return `[${value.map(canonical).join(",")}]`;
  if(value!==null&&typeof value==="object")return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical((value as Record<string,unknown>)[key])}`).join(",")}}`;
  const encoded=JSON.stringify(value);if(encoded===undefined)throw new Error("invalid_snapshot");return encoded;
}
export function snapshotHash(value: Omit<RemoteSnapshot,"evidence_sha256">): string { return remoteHash(canonical(value)); }
export function encodeRemoteFrame(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  if(body.length>REMOTE_MAX_BYTES-4) throw new Error("invalid_frame");
  const header=Buffer.alloc(4);header.writeUInt32BE(body.length);return Buffer.concat([header,body]);
}

const ignoreLateStreamError=()=>{};

/** Bounded channel: two sequential messages per direction, no generic RPC or buffering backlog. */
export class RemoteChannel {
  private bytes=Buffer.alloc(0);
  private queue: unknown[]=[];
  private failure: Error | null=null;
  private count=0;
  private sent=0;
  private closed=false;
  private pending: {resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout} | null=null;
  constructor(private readonly input:Readable,private readonly output:Writable,private readonly inputLimit=REMOTE_MAX_BYTES,private readonly maxFrames=2) {
    if(!Number.isInteger(maxFrames)||maxFrames<2||maxFrames>8)throw new Error("invalid_frame");
    if(!Number.isInteger(inputLimit)||inputLimit<REMOTE_MAX_BYTES||inputLimit>REMOTE_MAX_BYTES+1024)throw new Error("invalid_frame");
    input.on("data",this.data);input.on("end",this.end);input.on("error",this.error);output.on("error",this.error);
  }
  private error=()=>this.fail("transport_unavailable");
  private end=()=>this.fail("transport_closed");
  private data=(chunk:Buffer)=>{
    if(this.failure)return;
    if(this.bytes.length+chunk.length>this.inputLimit){this.fail("invalid_frame");return;}
    this.bytes=Buffer.concat([this.bytes,chunk]);
    if(this.bytes.length<4)return;
    const length=this.bytes.readUInt32BE();
    if(length===0||length>this.inputLimit-4){this.fail("invalid_frame");return;}
    if(this.bytes.length<length+4)return;
    if(this.bytes.length!==length+4||++this.count>this.maxFrames){this.fail("invalid_frame");return;}
    let parsed:unknown;
    try {parsed=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(this.bytes.subarray(4)));}
    catch {this.fail("invalid_frame");return;}
    this.bytes=Buffer.alloc(0);
    if(this.pending){const p=this.pending;this.pending=null;clearTimeout(p.timer);p.resolve(parsed);}
    else if(this.queue.length===0)this.queue.push(parsed);else this.fail("invalid_frame");
  };
  private fail(reason:string){
    if(this.failure)return;this.failure=new Error(reason);
    if(this.pending){clearTimeout(this.pending.timer);this.pending.reject(this.failure);this.pending=null;}
  }
  async receive(timeoutMs=3000):Promise<unknown>{
    if(this.failure)throw this.failure;
    if(this.queue.length)return this.queue.shift();
    if(this.pending)throw new Error("invalid_frame");
    return new Promise((resolve,reject)=>{const timer=setTimeout(()=>this.fail("transport_timeout"),Math.max(1,Math.min(10000,timeoutMs)));this.pending={resolve,reject,timer};});
  }
  async send(value:unknown):Promise<void>{
    if(this.failure)throw this.failure;
    if(++this.sent>this.maxFrames)throw new Error("invalid_frame");
    const frame=encodeRemoteFrame(value);
    await new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>{this.fail("transport_timeout");reject(new Error("transport_timeout"));},3000);
      this.output.write(frame,error=>{clearTimeout(timer);error?reject(new Error("transport_unavailable")):resolve();});
    });
  }
  close(){if(this.closed)return;this.closed=true;this.fail("transport_closed");this.input.off("data",this.data);this.input.off("end",this.end);this.input.off("error",this.error);this.output.off("error",this.error);this.input.on("error",ignoreLateStreamError);if((this.output as object)!==(this.input as object))this.output.on("error",ignoreLateStreamError);}
}

/** Owner-controlled local config; no symlinks, special files, unbounded reads or raw error text. */
export async function readPinnedRemoteRegistry(filePath:string,expectedDigest:string):Promise<unknown>{
  try {
    if(!path.safeParse(filePath).success||!digest.safeParse(expectedDigest).success)throw new Error();
    await assertPrivateRemoteFile(filePath);
    const file=await open(filePath,constants.O_RDONLY|constants.O_NONBLOCK|constants.O_NOFOLLOW);
    try {
      const info=await file.stat();
      if(!info.isFile()||(process.getuid&&info.uid!==process.getuid())||(info.mode&0o077)!==0||info.size>16384)throw new Error();
      const buffer=Buffer.alloc(16385);let n=0;
      while(n<buffer.length){const read=await file.read(buffer,n,buffer.length-n,n);if(!read.bytesRead)break;n+=read.bytesRead;}
      const body=buffer.subarray(0,n);if(n>16384||remoteHash(body)!==expectedDigest)throw new Error();
      return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(body));
    }finally{await file.close();}
  }catch{throw new Error("invalid_registry");}
}
export async function assertPrivateRemoteFile(filePath:string):Promise<void>{
  if(!path.safeParse(filePath).success||await realpath(filePath)!==filePath)throw new Error("unsafe_file");
  const info=await lstat(filePath);
  if(!info.isFile()||(process.getuid&&info.uid!==process.getuid())||(info.mode&0o077)!==0)throw new Error("unsafe_file");
}
