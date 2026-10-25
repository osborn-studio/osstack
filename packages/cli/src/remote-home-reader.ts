import { randomBytes } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { RemoteChannel, RemoteGrant, RemoteHomeEntry, RemoteSnapshot, assertPrivateRemoteFile, snapshotHash } from "./remote-home-protocol.js";

/** The remote shell sees only this literal command; all variable fields are local SSH argv. */
export function buildRemoteSshArgs(raw:RemoteHomeEntry,knownHostsPath:string):string[]{
  const entry=RemoteHomeEntry.parse(raw);
  if(!knownHostsPath.startsWith("/")||/[\s%'"\\\p{C}]/u.test(knownHostsPath))throw new Error("unsafe_file");
  return ["-F","/dev/null","-T","-o","BatchMode=yes","-o","StrictHostKeyChecking=yes","-o","IdentitiesOnly=yes",
    "-o","IdentityAgent=none","-o","PreferredAuthentications=publickey","-o","PasswordAuthentication=no","-o","KbdInteractiveAuthentication=no","-o","GSSAPIAuthentication=no","-o","ForwardAgent=no","-o","ForwardX11=no","-o","ClearAllForwardings=yes",
    "-o","ProxyCommand=none","-o","ProxyJump=none","-o","ControlMaster=no","-o","ControlPath=none",
    "-o","PermitLocalCommand=no","-o","GlobalKnownHostsFile=/dev/null","-o",`UserKnownHostsFile=${knownHostsPath}`,
    "-o","HostKeyAlgorithms=ssh-ed25519","-o","UpdateHostKeys=no","-o","VerifyHostKeyDNS=no",
    "-o","CanonicalizeHostname=no","-o","ConnectionAttempts=1","-o","ConnectTimeout=5",
    "-o","ServerAliveInterval=5","-o","ServerAliveCountMax=1","-o","LogLevel=ERROR",
    "-i",entry.identity_file,"-p",String(entry.port),"-l",entry.user,"--",entry.host,"osstack remote-export --stdio"];
}
export interface RemoteReadDependencies {
  /** Host/test composition only, never loaded from a registry or remote request. */
  spawn?:typeof spawn;
  timeoutMs?:number;
}
export type RemoteReadResult = {
  schema_version:1;mode:"remote_readonly_snapshot";alias:string;status:"observed";snapshot:RemoteSnapshot;
  received_at_ms:number;round_trip_ms:number;freshness:"point_in_time_unverified_clock";remote_clock:"within_local_60s"|"skew_or_unknown";
  qualification:"remote_host_pending";
}|{schema_version:1;mode:"remote_readonly_snapshot";alias:string;status:"unknown";reason:"remote_observation_unavailable";qualification:"remote_host_pending";};
/** Invalid caller input throws before transport; runtime/remote failures return an allowlisted unknown result. */
export async function readRemoteHome(raw:RemoteHomeEntry,limit=25,deps:RemoteReadDependencies={}):Promise<RemoteReadResult>{
  const entry=RemoteHomeEntry.parse(raw);
  if(!Number.isInteger(limit)||limit<1||limit>50)throw new Error("invalid_request");
  const unknown:RemoteReadResult={schema_version:1,mode:"remote_readonly_snapshot",alias:entry.alias,status:"unknown",reason:"remote_observation_unavailable",qualification:"remote_host_pending"};
  let child:ChildProcessWithoutNullStreams|undefined,channel:RemoteChannel|undefined,dir:string|undefined,timer:NodeJS.Timeout|undefined;
  const started=performance.now();
  try {
    await assertPrivateRemoteFile(entry.identity_file);
    const { createScratchDir }=await import("@osstack/core");
    dir=await createScratchDir("runtime","remote-read");
    const known=join(dir,"known_hosts");const name=entry.port===22?entry.host:`[${entry.host}]:${entry.port}`;
    await writeFile(known,`${name} ${entry.host_key}\n`,{mode:0o600,flag:"wx"});
    const childEnv:NodeJS.ProcessEnv={PATH:"/usr/bin:/bin",LANG:"C",LC_ALL:"C"};
    child=(deps.spawn??spawn)("/usr/bin/ssh",buildRemoteSshArgs(entry,known),{stdio:["pipe","pipe","pipe"],shell:false,env:childEnv}) as ChildProcessWithoutNullStreams;
    channel=new RemoteChannel(child.stdout,child.stdin);
    child.stderr.on("error",()=>{child?.stdout.destroy();child?.stdin.destroy();});
    let stderrBytes=0;child.stderr.on("data",(chunk:Buffer)=>{stderrBytes+=chunk.length;if(stderrBytes>8192)child?.kill("SIGKILL");});
    child.on("error",()=>{child?.stdout.destroy();child?.stdin.destroy();});
    const timeoutMs=Math.max(1,Math.min(10000,deps.timeoutMs??10000));
    const active=channel;
    const exchange=async()=>{
      const nonce=randomBytes(32).toString("hex");
      const hello={type:"hello",protocol:1,nonce,home_id:entry.home_id,daemon_protocol:entry.daemon_protocol,registry_sha256:entry.registry_sha256,scope:entry.scope};
      await active.send(hello);const grant=RemoteGrant.parse(await active.receive(timeoutMs));
      if(grant.nonce!==nonce||grant.home_id!==entry.home_id||grant.daemon_protocol!==entry.daemon_protocol||grant.registry_sha256!==entry.registry_sha256||grant.scope!==entry.scope)throw new Error("binding_mismatch");
      await active.send({type:"snapshot",token:grant.token,sequence:1,limit});
      const snapshot=RemoteSnapshot.parse(await active.receive(timeoutMs));
      if(snapshot.nonce!==nonce||snapshot.home_id!==entry.home_id||snapshot.generation!==grant.generation||snapshot.daemon_protocol!==entry.daemon_protocol||snapshot.registry_sha256!==entry.registry_sha256||snapshot.scope!==entry.scope||snapshot.views.length>limit)throw new Error("binding_mismatch");
      const {evidence_sha256,...payload}=snapshot;if(snapshotHash(payload)!==evidence_sha256)throw new Error("evidence_mismatch");
      const now=Date.now();return {schema_version:1 as const,mode:"remote_readonly_snapshot" as const,alias:entry.alias,status:"observed" as const,snapshot,received_at_ms:now,round_trip_ms:Math.round(performance.now()-started),freshness:"point_in_time_unverified_clock" as const,remote_clock:Math.abs(now-snapshot.sampled_at_ms)<=60000?"within_local_60s" as const:"skew_or_unknown" as const,qualification:"remote_host_pending" as const};
    };
    return await Promise.race([exchange(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("transport_timeout")),timeoutMs);})]);
  }catch{return unknown;}finally{
    if(timer)clearTimeout(timer);channel?.close();
    if(child){child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();if(child.exitCode===null)child.kill("SIGKILL");}
    if(dir)await rm(dir,{recursive:true,force:true}).catch(()=>{});
  }
}
