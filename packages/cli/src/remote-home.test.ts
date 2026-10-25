import { expect, it } from "vitest";
import { RemoteClientRegistry, RemoteServerRegistry, encodeRemoteFrame } from "./remote-home-protocol.js";
import { buildRemoteSshArgs } from "./remote-home-reader.js";
const key = Buffer.concat([Buffer.from([0,0,0,11]),Buffer.from("ssh-ed25519"),Buffer.from([0,0,0,32]),Buffer.alloc(32,7)]).toString("base64");
const entry = { alias:"dev", host:"example.test",port:22,user:"reader",host_key:`ssh-ed25519 ${key}`,identity_file:"/private/key",home_id:`home_${"a".repeat(32)}`,daemon_protocol:1,registry_sha256:"a".repeat(64),scope:"project" };
it("accepts explicit pins, rejects shell options and implicit credentials", () => {
 expect(RemoteClientRegistry.parse({version:1,homes:[entry]}).homes).toHaveLength(1);
 for(const patch of [{host:"-oProxyCommand=evil"},{user:"a;id"},{host:"a b"},{port:0},{identity_file:undefined},{scope:"../x"},{host_key:"ssh-ed25519 bad"}]) expect(RemoteClientRegistry.safeParse({version:1,homes:[{...entry,...patch}]}).success).toBe(false);
 expect(RemoteServerRegistry.safeParse({version:1,home_id:entry.home_id,daemon_protocol:1,socket:"/socket",scopes:[{alias:"project",repo_path:"/repo",default_tenant:true}]}).success).toBe(true);
});
it("builds fixed shell-free local argv with explicit host-key and credential restrictions", () => {
 const args=buildRemoteSshArgs(entry,"/known_hosts");
 expect(args.slice(-2)).toEqual(["example.test","osstack remote-export --stdio"]);
 for(const option of ["BatchMode=yes","StrictHostKeyChecking=yes","IdentityAgent=none","ForwardAgent=no","ProxyCommand=none","ControlMaster=no","GlobalKnownHostsFile=/dev/null","UserKnownHostsFile=/known_hosts","HostKeyAlgorithms=ssh-ed25519"]) expect(args).toContain(option);
 expect(args).toContain("/private/key"); expect(args.slice(0,2)).toEqual(["-F","/dev/null"]);
});
it("bounds complete wire bytes",()=>{ expect(()=>encodeRemoteFrame({a:"x".repeat(65536)})).toThrow(); });

import { PassThrough } from "node:stream";
import { RemoteChannel } from "./remote-home-protocol.js";
it("accepts fragmented frames and rejects banners, invalid UTF8, overflow and multiple frames",async()=>{
 const input=new PassThrough(),output=new PassThrough();let channel=new RemoteChannel(input,output);
 const frame=encodeRemoteFrame({hello:"ok"});const pending=channel.receive();for(const byte of frame)input.write(Buffer.from([byte]));expect(await pending).toEqual({hello:"ok"});channel.close();
 for(const bytes of [Buffer.from("shell banner"),Buffer.from([0,1,0,0]),Buffer.concat([frame,frame]),Buffer.from([0,0,0,1,255])]){
 const a=new PassThrough(),b=new PassThrough();channel=new RemoteChannel(a,b);const read=channel.receive();a.write(bytes);await expect(read).rejects.toThrow("invalid_frame");channel.close();
 }
});
it("times out or disconnects with unknown transport state",async()=>{
 const input=new PassThrough(),output=new PassThrough(),channel=new RemoteChannel(input,output);await expect(channel.receive(5)).rejects.toThrow("transport_timeout");channel.close();
 const a=new PassThrough(),b=new PassThrough(),c=new RemoteChannel(a,b);const read=c.receive();a.end();await expect(read).rejects.toThrow("transport_closed");c.close();
});

import { execFileSync } from "node:child_process";
import { snapshotHash, type RemoteSnapshot } from "./remote-home-protocol.js";
it("canonical evidence is independent of object key insertion order",()=>{
 const a={scope:"project",total:0,views:[]} as unknown as Omit<RemoteSnapshot,"evidence_sha256">;
 const b={views:[],total:0,scope:"project"} as unknown as Omit<RemoteSnapshot,"evidence_sha256">;
 expect(snapshotHash(a)).toBe(snapshotHash(b));
});
it("OpenSSH's actual local parser accepts the argv and preserves restrictive effective settings",()=>{
 const config=execFileSync("/usr/bin/ssh",["-G",...buildRemoteSshArgs({...entry,identity_file:"/dev/null"},"/known_hosts")],{encoding:"utf8",timeout:3000});
 for(const line of ["batchmode yes","identityagent none","identitiesonly yes","stricthostkeychecking true","controlmaster false","forwardagent no","userknownhostsfile /known_hosts","globalknownhostsfile /dev/null","preferredauthentications publickey"])expect(config.split("\n")).toContain(line);
 expect(config).not.toMatch(/^proxy(?:command|jump) (?!none)/m);
});
it("rejects OpenSSH percent expansion, quoting, whitespace and backslash path ambiguity",()=>{
 for(const path of ["/a b","/a%h","/a'b",'/a"b',"/a\\b"]){expect(()=>buildRemoteSshArgs({...entry,identity_file:path},"/safe")).toThrow();expect(()=>buildRemoteSshArgs(entry,path)).toThrow();}
});
it("late stream errors after close do not escape as uncaught exceptions",()=>{
 const input=new PassThrough(),output=new PassThrough(),channel=new RemoteChannel(input,output);channel.close();expect(()=>input.emit("error",new Error("late"))).not.toThrow();expect(()=>output.emit("error",new Error("late"))).not.toThrow();
});
it("local daemon framing allows a bounded RPC envelope around a 64KiB projection, while the remote wire does not",async()=>{
 const body=Buffer.from(JSON.stringify({id:1,ok:true,result:{value:"x".repeat(65510)}})),h=Buffer.alloc(4);h.writeUInt32BE(body.length);const frame=Buffer.concat([h,body]);expect(frame.length).toBeGreaterThan(65536);
 for(const limit of [65536,66560]){const a=new PassThrough(),b=new PassThrough(),c=new RemoteChannel(a,b,limit),read=c.receive();a.write(frame);if(limit===65536)await expect(read).rejects.toThrow("invalid_frame");else expect(await read).toHaveProperty("result");c.close();}
});
