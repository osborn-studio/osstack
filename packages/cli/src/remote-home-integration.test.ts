import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { chmod, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { PassThrough } from "node:stream";
import { createServer, type Socket } from "node:net";
import { build } from "esbuild";
import Database from "better-sqlite3";
import { createScratchDir, openDb } from "@osstack/core";
import { afterEach, beforeAll, afterAll, expect, it, vi } from "vitest";
import { RemoteChannel, remoteHash, readPinnedRemoteRegistry } from "./remote-home-protocol.js";
import { readRemoteHome } from "./remote-home-reader.js";
import { handleRemoteHomeCommand } from "./remote-home-command.js";
import { handleRemoteExportCommand } from "./remote-home-exporter.js";
import { WorkerViewService } from "./worker-view-service.js";
import { startDaemon, type DaemonHandles } from "./daemon.js";
import { readHomeIdentity, DeploymentIdentitySchema } from "./home-inventory.js";

const key=Buffer.concat([Buffer.from([0,0,0,11]),Buffer.from("ssh-ed25519"),Buffer.from([0,0,0,32]),Buffer.alloc(32,7)]).toString("base64");
const homeId=`home_${"a".repeat(32)}`, generation=`instance_${"b".repeat(32)}`;
const identity={schema_version:1,home_id:homeId,generation,version:"0.21.0",protocol_version:1,database_schema:44,started_at_ms:1,deployment_kind:"unknown",build_digest:null,build_evidence:"unavailable"};
const cleanup:Array<()=>Promise<unknown>>=[];
let compiled:string,bundleRoot:string;
beforeAll(async()=>{
 bundleRoot=await realpath(await createScratchDir("tests","remote-bundle"));compiled=join(bundleRoot,"exporter.mjs");
 await symlink(resolve("node_modules"),join(bundleRoot,"node_modules"));
 await build({stdin:{contents:'import {main} from "./bin.js"; process.exitCode=await main(["remote-export",...process.argv.slice(2)]);',resolveDir:resolve("src"),sourcefile:"remote-runner.ts",loader:"ts"},bundle:true,platform:"node",target:"node22",format:"esm",packages:"external",outfile:compiled,logLevel:"silent"});
});
afterAll(async()=>{await rm(bundleRoot,{recursive:true,force:true});});
afterEach(async()=>{for(const fn of cleanup.splice(0).reverse())await fn();vi.unstubAllEnvs();});
async function fixture(count=1){
 const root=await realpath(await createScratchDir("tests","remote-home"));cleanup.push(()=>rm(root,{recursive:true,force:true}));
 const repo=join(root,"private-repo");await mkdir(repo);
 const db=openDb({path:join(root,"state.db")});cleanup.push(async()=>db.close());
 for(let i=0;i<count;i++){
 db.prepare("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES(?, 'SECRET_PROMPT', 'running', 1, 1)").run(`t${i}`);
 db.prepare("INSERT INTO runs(run_id,task_id,session_id,agent_id,capability_id,phase,started_at) VALUES(?,?,?,'codex-cli','code','execute',1)").run(`r${i}`,`t${i}`,`s${i}`);
 db.prepare("INSERT INTO agent_sessions(session_id,task_id,run_id,agent_id,request_sha256,native_session_id,repo_path,state,resume_supported,version,updated_at) VALUES(?,?,?,'codex-cli',?,'SECRET_NATIVE',?,'idle',1,1,1)").run(`s${i}`,`t${i}`,`r${i}`,"a".repeat(64),repo);
 }
 const service=new WorkerViewService(db);
 let identityCalls=0;const methods:string[]=[];let mutation:(value:unknown,method:string)=>unknown=v=>v;
 const sockets=new Set<Socket>();
 const socket=join(root,"d.sock");const server=createServer(s=>{sockets.add(s);s.on("close",()=>sockets.delete(s));const c=new RemoteChannel(s,s);void(async()=>{try{const request=await c.receive() as {method:string;params?:unknown};methods.push(request.method);let result:unknown;if(request.method==="deployment.identity"){identityCalls++;result=identity;}else if(request.method==="worker.list")result=service.list(request.params);else throw Error();await c.send({id:1,ok:true,result:mutation(result,request.method)});}catch{}finally{c.close();s.end();}})();});
 await new Promise<void>(r=>server.listen(socket,r));await chmod(socket,0o600);
 cleanup.push(async()=>{for(const s of sockets)s.destroy();await new Promise<void>(r=>server.close(()=>r()));});
 const config={version:1,home_id:homeId,daemon_protocol:1,socket,scopes:[{alias:"project",repo_path:repo,default_tenant:true}]};
 const registry=join(root,"export.json");const body=JSON.stringify(config);await writeFile(registry,body,{mode:0o600});
 const keyFile=join(root,"identity");await writeFile(keyFile,"FAKE_TEST_PRIVATE_IDENTITY_NOT_USED_FOR_SSH",{mode:0o600});
 const entry={alias:"dev",host:"example.test",port:22,user:"reader",host_key:`ssh-ed25519 ${key}`,identity_file:keyFile,home_id:homeId,daemon_protocol:1,registry_sha256:remoteHash(body),scope:"project"};
 const exporterEnv={OSSTACK_REMOTE_EXPORT_REGISTRY:registry,OSSTACK_REMOTE_EXPORT_SHA256:entry.registry_sha256};
 const children:ChildProcessWithoutNullStreams[]=[];cleanup.push(async()=>{for(const c of children){if(c.exitCode===null)c.kill("SIGKILL");}});
 const spawnLocal=((_binary:string,_args:readonly string[],_options:unknown)=>{const child=spawn(process.execPath,[compiled,"--stdio"],{stdio:["pipe","pipe","pipe"],env:{...process.env,...exporterEnv,OSSTACK_HOME:join(root,"never-open")}});children.push(child);return child;}) as typeof spawn;
 return {root,repo,db,service,methods,registry,body,entry,exporterEnv,spawnLocal,get identityCalls(){return identityCalls;},mutate:(fn:typeof mutation)=>{mutation=fn;},server};
}
it("reads real source rows over an isolated child exporter without text, native IDs, paths or DB writes",async()=>{
 const f=await fixture();const before=remoteHash(f.db.serialize());
 expect(f.db.prepare("SELECT title FROM tasks LIMIT 1").get()).toEqual({title:"SECRET_PROMPT"});
 expect(f.db.prepare("SELECT native_session_id FROM agent_sessions LIMIT 1").get()).toEqual({native_session_id:"SECRET_NATIVE"});
 const raw=f.service.list({repo_path:f.repo,default_tenant:true});expect(raw.scope.repo_path).toBe(f.repo);expect(raw.views[0]?.view_id).toBeTruthy();
 const result=await readRemoteHome(f.entry,50,{spawn:f.spawnLocal});
 expect(result.status).toBe("observed");if(result.status!=="observed")throw Error(JSON.stringify(result));
 expect(result.snapshot).toMatchObject({complete:true,total:2,coverage:"default_tenant_bound_session_run_only",views:[{source_kind:"run",process_liveness:"unknown",controls:"unsupported"},{source_kind:"session",state:"idle"}]});
 expect(JSON.stringify(result)).not.toMatch(/SECRET_|private-repo|repo_path|view_id|token|cursor|native_session/);
 expect(remoteHash(f.db.serialize())).toBe(before);
 expect(f.methods).toEqual(["deployment.identity","deployment.identity","worker.list","deployment.identity"]);
 expect(await readFile(f.registry,"utf8")).toBe(f.body);
});
it("CLI command performs the real child exchange and reports incomplete first pages",async()=>{
 const f=await fixture(26);const client=join(f.root,"client.json"),body=JSON.stringify({version:1,homes:[f.entry]});await writeFile(client,body,{mode:0o600});
 let output="";const status=await handleRemoteHomeCommand(["inspect","--registry",client,"--sha256",remoteHash(body),"--alias","dev","--limit","50"],{spawn:f.spawnLocal,stdout:text=>{output+=text;}});
 expect(status).toBe(1);const result=JSON.parse(output);expect(result).toMatchObject({status:"observed",snapshot:{complete:false,has_more:true,total:52}});expect(result.snapshot.views).toHaveLength(50);expect(Buffer.byteLength(output)).toBeLessThan(65536);
});
it("an empty complete page does not claim healthy or live execution",async()=>{
 const f=await fixture(0);const result=await readRemoteHome(f.entry,25,{spawn:f.spawnLocal});expect(result).toMatchObject({status:"observed",freshness:"point_in_time_unverified_clock",snapshot:{complete:true,total:0,views:[]}});expect(JSON.stringify(result)).not.toMatch(/healthy|live_execution/);
});
it.each(["home","generation","scope","scope_digest","count","future_clock"])("rejects or marks unknown the %s boundary",async(kind)=>{
 const f=await fixture();f.mutate((raw,method)=>{const v=structuredClone(raw) as Record<string,unknown>;
 if(method==="deployment.identity"&&kind==="home")v.home_id=`home_${"c".repeat(32)}`;
 if(method==="deployment.identity"&&kind==="generation"&&f.identityCalls>=3)v.generation=`instance_${"c".repeat(32)}`;
 if(method==="worker.list"){
 if(kind==="scope")v.scope={...(v.scope as object),repo_path:"/other"};
 if(kind==="scope_digest")v.scope={...(v.scope as object),scope_id:"c".repeat(64)};
 if(kind==="count")v.total=0;
 if(kind==="future_clock")v.sampled_at_ms=Date.now()+999999999;
 }return v;});
 const result=await readRemoteHome(f.entry,25,{spawn:f.spawnLocal});
 if(kind==="future_clock")expect(result).toMatchObject({status:"observed",remote_clock:"skew_or_unknown",freshness:"point_in_time_unverified_clock"});else expect(result.status).toBe("unknown");
});
it("wrong request pins and scope fail before worker reads and never fall back",async()=>{
 const f=await fixture();for(const patch of [{home_id:`home_${"c".repeat(32)}`},{registry_sha256:"c".repeat(64)},{daemon_protocol:99},{scope:"other"}])expect((await readRemoteHome({...f.entry,...patch},25,{spawn:f.spawnLocal})).status).toBe("unknown");
 expect(f.methods).toEqual([]);
});
it("read-only grant cannot authorize start/send/cancel, token substitution or replay",async()=>{
 const f=await fixture();for(const patch of [{},{type:"start"},{type:"send"},{type:"cancel"},{token:"d".repeat(64)},{sequence:2},{socket:"/other"}]){
 const input=new PassThrough(),output=new PassThrough();const server=handleRemoteExportCommand(["--stdio"],{input,output,env:f.exporterEnv});const client=new RemoteChannel(output,input);
 await client.send({type:"hello",protocol:1,nonce:"e".repeat(64),home_id:f.entry.home_id,daemon_protocol:1,registry_sha256:f.entry.registry_sha256,scope:"project"});const grant=await client.receive() as {token:string};
 await client.send({type:"snapshot",token:grant.token,sequence:1,limit:1,...patch});expect(await server).toBe(Object.keys(patch).length===0?0:1);if(Object.keys(patch).length===0)expect(await client.receive()).toMatchObject({type:"snapshot"});client.close();input.destroy();output.destroy();
 }
 expect(f.methods.filter(m=>m==="worker.list")).toHaveLength(1);
});
it("rejects registry tampering, public permissions, symlinks and special files",async()=>{
 const f=await fixture();expect(await readPinnedRemoteRegistry(f.registry,remoteHash(f.body))).toBeTruthy();
 await expect(readPinnedRemoteRegistry(f.registry,"f".repeat(64))).rejects.toThrow("invalid_registry");
 await chmod(f.registry,0o644);await expect(readPinnedRemoteRegistry(f.registry,remoteHash(f.body))).rejects.toThrow("invalid_registry");await chmod(f.registry,0o600);
 const link=join(f.root,"link");await symlink(f.registry,link);await expect(readPinnedRemoteRegistry(link,remoteHash(f.body))).rejects.toThrow("invalid_registry");
 await expect(readPinnedRemoteRegistry(f.repo,remoteHash(f.body))).rejects.toThrow("invalid_registry");
});
it("real running daemon identity and worker RPC support child exporter, without opening the child's OSSTACK_HOME",async()=>{
 const f=await fixture(0);vi.stubEnv("OSSTACK_HOME",join(f.root,"daemon-home"));
 let daemon:DaemonHandles|undefined;try{
 daemon=await startDaemon({socketPath:join(f.root,"actual.sock"),adapters:[]});
 const id=DeploymentIdentitySchema.parse(await readHomeIdentity(daemon.socketPath));
 const body=JSON.stringify({version:1,home_id:id.home_id,daemon_protocol:id.protocol_version,socket:daemon.socketPath,scopes:[{alias:"project",repo_path:f.repo,default_tenant:true}]});await writeFile(f.registry,body,{mode:0o600});
 f.exporterEnv.OSSTACK_REMOTE_EXPORT_SHA256=remoteHash(body);
 const observer=new Database(daemon.dbPath,{readonly:true});const before=remoteHash(observer.serialize());
 try{expect(await readRemoteHome({...f.entry,home_id:id.home_id,daemon_protocol:id.protocol_version,registry_sha256:remoteHash(body)},25,{spawn:f.spawnLocal})).toMatchObject({status:"observed",snapshot:{home_id:id.home_id,generation:id.generation,total:0}});expect(remoteHash(observer.serialize())).toBe(before);}
 finally{observer.close();}
 await expect(readFile(join(f.root,"never-open","state.db"))).rejects.toThrow();
 }finally{await daemon?.close();}
});
it("invalid CLI flags fail without spawning",async()=>{
 const call=vi.fn();for(const args of [["inspect","--limit","0"],["inspect","--send","x"],["inspect","--registry","x","--registry","y"]])expect(await handleRemoteHomeCommand(args,{spawn:call as typeof spawn,stderr:()=>{}})).toBe(1);expect(call).not.toHaveBeenCalled();
});

const hostilePeer=`
import {createHash} from 'node:crypto';
const mode=process.argv[1];let buffer=Buffer.alloc(0),step=0,hello;
const send=value=>{const b=Buffer.from(JSON.stringify(value));const h=Buffer.alloc(4);h.writeUInt32BE(b.length);process.stdout.write(Buffer.concat([h,b]));};
process.stdin.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);if(buffer.length<4||buffer.length<4+buffer.readUInt32BE())return;const v=JSON.parse(buffer.subarray(4).toString());buffer=Buffer.alloc(0);
if(step++===0){hello=v;if(mode==='disconnect'){process.exit(1);}if(mode==='hang')return;if(mode==='stderr'){process.stderr.write('PRIVATE_KEY_SHOULD_NOT_SURFACE'.repeat(1000));return;}
const grant={protocol:1,nonce:v.nonce,home_id:v.home_id,generation:'instance_'+ 'b'.repeat(32),daemon_protocol:v.daemon_protocol,registry_sha256:v.registry_sha256,scope:v.scope,type:'grant',token:'f'.repeat(64),methods:['snapshot'],max_page:50};
if(mode==='nonce')grant.nonce='a'.repeat(64);if(mode==='protocol')grant.protocol=2;if(mode==='registry')grant.registry_sha256='b'.repeat(64);if(mode==='scope')grant.scope='wrong';if(mode==='methods')grant.methods=['send'];send(grant);return;}
const s={protocol:1,nonce:hello.nonce,home_id:hello.home_id,generation:'instance_'+ 'b'.repeat(32),daemon_protocol:hello.daemon_protocol,registry_sha256:hello.registry_sha256,scope:hello.scope,type:'snapshot',sequence:1,sampled_at_ms:Date.now(),total:0,views:[],has_more:false,complete:true,coverage:'default_tenant_bound_session_run_only'};
if(mode==='generation')s.generation='instance_'+ 'c'.repeat(32);if(mode==='replay')s.sequence=0;if(mode==='home')s.home_id='home_'+ 'c'.repeat(32);if(mode==='private_path')s.repo_path='/private/secret';
const canonical=v=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v!==null&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v);
s.evidence_sha256=createHash('sha256').update(canonical(s)).digest('hex');if(mode==='digest')s.evidence_sha256='a'.repeat(64);send(s);
});
`;
it.each(["nonce","protocol","registry","scope","methods","generation","replay","home","private_path","digest","disconnect","hang","stderr"])("client fails closed on an actual hostile child: %s",async(mode)=>{
 const f=await fixture();const spawnPeer=((_binary:string,_args:readonly string[],_options:unknown)=>spawn(process.execPath,["--input-type=module","-e",hostilePeer,mode],{stdio:["pipe","pipe","pipe"]})) as typeof spawn;
 const result=await readRemoteHome(f.entry,25,{spawn:spawnPeer,timeoutMs:mode==="hang"?100:2000});
 expect(result).toEqual({schema_version:1,mode:"remote_readonly_snapshot",alias:"dev",status:"unknown",reason:"remote_observation_unavailable",qualification:"remote_host_pending"});expect(f.methods).toEqual([]);
});
it("private identity permissions fail closed before starting any SSH process",async()=>{
 const f=await fixture();await chmod(f.entry.identity_file,0o644);const start=vi.fn();expect((await readRemoteHome(f.entry,25,{spawn:start as typeof spawn})).status).toBe("unknown");expect(start).not.toHaveBeenCalled();
});
it("exporter rejects environment absence, extra arguments and a socket symlink",async()=>{
 const f=await fixture();expect(await handleRemoteExportCommand(["--stdio"],{env:{}})).toBe(1);expect(await handleRemoteExportCommand(["--stdio","--socket","/untrusted"],{env:f.exporterEnv})).toBe(1);
 const raw=JSON.parse(f.body);const link=join(f.root,"linked.sock");await symlink(raw.socket,link);raw.socket=link;const body=JSON.stringify(raw);await writeFile(f.registry,body,{mode:0o600});f.exporterEnv.OSSTACK_REMOTE_EXPORT_SHA256=remoteHash(body);
 expect((await readRemoteHome({...f.entry,registry_sha256:remoteHash(body)},25,{spawn:f.spawnLocal})).status).toBe("unknown");expect(f.methods).toEqual([]);
});

it("exporter process exits after its one-page response even if the reader leaves stdin open",async()=>{
 const f=await fixture();const child=f.spawnLocal("ignored",[],{}) as ChildProcessWithoutNullStreams;const c=new RemoteChannel(child.stdout,child.stdin);
 try{await c.send({type:"hello",protocol:1,nonce:"e".repeat(64),home_id:f.entry.home_id,daemon_protocol:1,registry_sha256:f.entry.registry_sha256,scope:"project"});const grant=await c.receive() as {token:string};
 const exited=new Promise<number|null>(resolve=>child.once("close",resolve));await c.send({type:"snapshot",token:grant.token,sequence:1,limit:1});await c.receive();
 const result=await Promise.race([exited,new Promise<string>(resolve=>setTimeout(()=>resolve("still_running"),1000))]);expect(result).toBe(0);
 }finally{c.close();if(child.exitCode===null)child.kill("SIGKILL");}
});

it("a previous connection's read token is rejected by a fresh exporter instance",async()=>{
 const f=await fixture();let prior="";
 for(let i=0;i<2;i++){
 const input=new PassThrough(),output=new PassThrough(),server=handleRemoteExportCommand(["--stdio"],{input,output,env:f.exporterEnv}),c=new RemoteChannel(output,input);
 await c.send({type:"hello",protocol:1,nonce:"e".repeat(64),home_id:f.entry.home_id,daemon_protocol:1,registry_sha256:f.entry.registry_sha256,scope:"project"});const grant=await c.receive() as {token:string};
 if(i===0){prior=grant.token;input.end();}else{expect(grant.token).not.toBe(prior);await c.send({type:"snapshot",token:prior,sequence:1,limit:1});}
 expect(await server).toBe(1);c.close();input.destroy();output.destroy();
 }expect(f.methods.filter(m=>m==="worker.list")).toHaveLength(0);
});
it("upstream bound scope filters other tenants and repositories through the real exporter",async()=>{
 const f=await fixture(3);f.db.exec("UPDATE tasks SET tenant_id='another-tenant' WHERE task_id='t1'; UPDATE agent_sessions SET state='failed',version=9 WHERE session_id='s1'; UPDATE runs SET outcome='failed' WHERE run_id='r1'; UPDATE agent_sessions SET state='completed',version=8 WHERE session_id='s2'; UPDATE runs SET outcome='completed' WHERE run_id='r2'");f.db.prepare("UPDATE agent_sessions SET repo_path=? WHERE session_id='s2'").run(f.root);
 const result=await readRemoteHome(f.entry,50,{spawn:f.spawnLocal});expect(result).toMatchObject({status:"observed",snapshot:{total:2,complete:true}});if(result.status!=="observed")throw Error();expect(result.snapshot.views.map(v=>[v.source_kind,v.state,v.revision])).toEqual([["run","outcome_pending",null],["session","idle",1]]);
});
it("the hostile peer test harness has a successful unmodified control",async()=>{
 const f=await fixture();const spawnPeer=((_binary:string,_args:readonly string[],_options:unknown)=>spawn(process.execPath,["--input-type=module","-e",hostilePeer,"valid"],{stdio:["pipe","pipe","pipe"]})) as typeof spawn;
 expect((await readRemoteHome(f.entry,25,{spawn:spawnPeer})).status).toBe("observed");
});

it("exporter exits on invalid startup configuration and arguments without ever reading stdin",async()=>{
 const f=await fixture();
 for(const args of [["--stdio"],["--invalid"]]){
 const child=spawn(process.execPath,[compiled,...args],{stdio:["pipe","pipe","pipe"],env:{...process.env,...f.exporterEnv,OSSTACK_REMOTE_EXPORT_SHA256:"a".repeat(64)}});
 let output="";child.stdout.on("data",b=>{output+=b;});let timer:NodeJS.Timeout|undefined;
 try{const code=await Promise.race([new Promise<number|null>(resolve=>child.once("close",resolve)),new Promise<string>(resolve=>{timer=setTimeout(()=>resolve("still_running"),1000);})]);expect(code).toBe(1);expect(output).toBe("");}
 finally{if(timer)clearTimeout(timer);if(child.exitCode===null)child.kill("SIGKILL");}
 }expect(f.methods).toEqual([]);
});
