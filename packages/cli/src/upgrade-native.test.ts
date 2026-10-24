import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { chmod, link, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createScratchDir } from '@osstack/core';
import Database from 'better-sqlite3';
import { createUpgradePlan, upgradeCanonical, upgradeDigest } from './upgrade-plan.js';
import { UpgradeJournal } from './upgrade-journal.js';
import { coordinateUpgrade } from './upgrade-coordinator.js';
import { ManagedNativeUpgradePort } from './upgrade-native-port.js';
import { bundleBuildDigest, loadBundle, loadInstallation, publishPrivate, sha256, stageRelease, switchRelease, type ManagedInstallation, type ReleaseBundle } from './upgrade-native-files.js';
import { provisionManagedInstallation } from './upgrade-managed-provision.js';
import { managedStartupIdentity, managedPlist, upgradeRpc, verifyRelease, type UpgradeBackend } from './upgrade-native-backend.js';
import { assertManagedHomeMarker } from './managed-home-guard.js';
import { DeploymentIdentitySchema, type HomeObservation } from './home-inventory.js';
const roots:string[]=[]; const children:ChildProcess[]=[];
afterEach(async()=>{for(const p of children.splice(0)){p.kill('SIGKILL');await new Promise<void>(r=>p.exitCode!==null||p.signalCode!==null?r():p.once('exit',()=>r()));}for(const path of roots.splice(0))await rm(path,{recursive:true,force:true});});
const script=`import net from 'node:net';import fs from 'node:fs';import path from 'node:path';import crypto from 'node:crypto';import{DatabaseSync}from'node:sqlite';
const home=process.env.OSSTACK_HOME,sock=process.env.OSSTACK_SOCKET,root=process.env.OSSTACK_MANAGED_INSTALLATION;
const target=JSON.parse(fs.readFileSync(path.join(fs.realpathSync(path.join(root,'current')),'.osstack-release.json'))).target;
const db=new DatabaseSync(path.join(home,'state.db'));db.exec('PRAGMA user_version='+target.database_schema);
const identity={schema_version:1,home_id:process.env.TEST_HOME_ID,generation:'instance_'+crypto.randomBytes(16).toString('hex'),version:target.version,protocol_version:target.protocol_version,database_schema:target.database_schema,started_at_ms:Date.now(),deployment_kind:'npm',build_digest:target.build_digest,build_evidence:'host_manifest'};
const server=net.createServer(s=>{let b=Buffer.alloc(0);s.on('data',c=>{b=Buffer.concat([b,c]);if(b.length<4||b.length<4+b.readUInt32BE())return;const q=JSON.parse(b.subarray(4));let result=q.method==='deployment.identity'?identity:q.method==='health'?{pid:process.pid,version:target.version,protocol_version:target.protocol_version}:{drained:true,graph_holds:0,active_runs:0};const body=Buffer.from(JSON.stringify({id:1,ok:true,result})),head=Buffer.alloc(4);head.writeUInt32BE(body.length);s.end(Buffer.concat([head,body]));});});server.listen(sock);
process.on('SIGTERM',()=>server.close(()=>{db.close();process.exit(0);}));`;
function bundle(version:string,schema:number):ReleaseBundle { const files=[{path:'bin.mjs',mode:0o600 as const,content_base64:Buffer.from(script+`\n// ${version}\n`).toString('base64')}];return{schema_version:1,target:{version,build_digest:bundleBuildDigest(files),protocol_version:1,database_schema:schema,readable_schema_min:40,readable_schema_max:45},files}; }
async function fixture() {
  const root=realpathSync(await createScratchDir('tests','native-upgrade'));roots.push(root);await chmod(root,0o700);
  const config:ManagedInstallation={schema_version:1,backend:'launchd',installation_id:'shared',root,node:realpathSync(process.execPath),node_sha256:createHash('sha256').update(readFileSync(realpathSync(process.execPath))).digest('hex'),entry:'bin.mjs',consumers:[]};
  // A short canonical directory is required for AF_UNIX; OSStack's test setup already owns TMPDIR.
  for(let i=1;i<=2;i++){const home=realpathSync(await createScratchDir('tests',`u${i}`));roots.push(home);await chmod(home,0o700);const db=new Database(join(home,'state.db'));db.pragma('user_version=40');db.exec('CREATE TABLE graph_runs(status TEXT);CREATE TABLE graph_action_admissions(released_at INTEGER);CREATE TABLE graph_actions(state TEXT);CREATE TABLE improvement_pr_deliveries(state TEXT);CREATE TABLE improvement_executions(state TEXT);');db.close();config.consumers.push({home_id:`home_${String(i).padStart(32,'0')}`,home,socket:join(home,'s'),label:`ai.osstack.managed.test${i}`});}
  await mkdir(join(root,'consumers'),{mode:0o700});await mkdir(join(root,'services'),{mode:0o700});await mkdir(join(root,'journal'),{mode:0o700});
  for(const c of config.consumers){await publishPrivate(join(c.home,'managed-consumer.json'),{schema_version:1,root,home_id:c.home_id});await publishPrivate(join(c.home,'deployment-identity.json'),{schema_version:1,home_id:c.home_id});await publishPrivate(join(root,'consumers',`${c.home_id}.json`),c);await writeFile(join(root,'services',`${c.home_id}.plist`),managedPlist(config,c),{mode:0o600});}
  await publishPrivate(join(root,'installation.json'),config);
  const old=bundle('1.0.0',40), next=bundle('2.0.0',41);await stageRelease(root,old,new AbortController().signal);await switchRelease(root,join(root,'releases',old.target.build_digest),new AbortController().signal);
  const artifact=join(root,'artifact.json');await publishPrivate(artifact,next);
  const running=new Map<string,ChildProcess>(); let starts=0;
  const backend:UpgradeBackend={async assertConsumers(config,pids){for(const[label,p]of running){if(p.exitCode===null&&p.signalCode===null&&(!config.consumers.some(c=>c.label===label)||!pids.includes(p.pid!)))throw Error('upgrade_unregistered_process');}},async service(label){const p=running.get(label);return p&&p.exitCode===null&&p.signalCode===null?'running':'absent';},async stop(label){const p=running.get(label);if(!p)throw Error('missing process');await new Promise<void>(r=>{p.once('exit',()=>r());p.kill('SIGTERM');});},async start(plist){const c=config.consumers.find(c=>plist.endsWith(`${c.home_id}.plist`))!;starts++;
    const p=spawn(config.node,[join(root,'current',config.entry)],{env:{OSSTACK_HOME:c.home,OSSTACK_SOCKET:c.socket,OSSTACK_MANAGED_INSTALLATION:root,TEST_HOME_ID:c.home_id},stdio:['ignore','ignore','pipe']});children.push(p);running.set(c.label,p);let stderr='';p.stderr!.on('data',b=>stderr+=b.toString());
    const end=Date.now()+5000;while(!existsSync(c.socket)&&Date.now()<end){if(p.exitCode!==null)throw Error(stderr);await new Promise(r=>setTimeout(r,20));}if(!existsSync(c.socket))throw Error('socket startup timeout '+stderr);
  }};
  for(const c of config.consumers)await backend.start(join(root,'services',`${c.home_id}.plist`),new AbortController().signal);
  const observations:HomeObservation[]=[];for(const c of config.consumers){const observed=DeploymentIdentitySchema.parse(await upgradeRpc(c.socket,'deployment.identity',new AbortController().signal));observations.push({desired:{home_id:c.home_id,socket:c.socket,enabled:true,desired:{version:'2.0.0'}},observed,observed_at_ms:Date.now(),status:'drift',reason:null});}
  const plan=createUpgradePlan({schema_version:1,expires_at_ms:Date.now()+120000,target:next.target,budget:{max_total_ms:100000,max_step_ms:20000,max_steps:32},groups:[{group_id:'first',installation_id:'shared',deployment_kind:'npm',home_ids:config.consumers.map(c=>c.home_id)}]},observations);
  const input={registry:join(root,'installation.json'),registryDigest:sha256(await readFile(join(root,'installation.json'))),artifact,artifactDigest:sha256(await readFile(artifact)),approvedPlanDigest:plan.digest};
  const journal=new UpgradeJournal(join(root,'journal'));await journal.create(plan);
  return{root,config,old,next,plan,input,backend,journal,starts:()=>starts};
}
describe('managed native upgrade actual filesystem/process boundaries',()=>{
  it('stops both real processes, snapshots unchanged databases, atomically switches exact release and verifies new generations',async()=>{
    const f=await fixture();const port=new ManagedNativeUpgradePort(f.input,f.backend);
    try {const result=await coordinateUpgrade({journal:f.journal,plan:f.plan,groupId:'first',port});expect(result).toMatchObject({state:'verified'});await port.complete();
      expect(f.starts()).toBe(4);expect(realpathSync(join(f.root,'current'))).toBe(join(f.root,'releases',f.next.target.build_digest));
      for(const c of f.config.consumers){const backup=new Database(join(c.home,'upgrade-snapshots',f.plan.digest,'state.db'),{readonly:true});expect(backup.pragma('user_version',{simple:true})).toBe(40);backup.close();const db=new Database(join(c.home,'state.db'),{readonly:true});expect(db.pragma('user_version',{simple:true})).toBe(41);db.close();}
      expect(existsSync(join(f.root,'upgrade-operation.json'))).toBe(false);
    }finally{await port.close();}
  },60000);
  it('preserves unknown restart, refuses implicit replay, and explicit history-bound recovery does not start an already-running consumer twice',async()=>{
    const f=await fixture();let first=true;const backend={...f.backend,start:async(p:string,s:AbortSignal)=>{await f.backend.start(p,s);if(first){first=false;throw Error('simulated response loss after physical restart');}}};
    const port=new ManagedNativeUpgradePort(f.input,backend);const result=await coordinateUpgrade({journal:f.journal,plan:f.plan,groupId:'first',port});await port.close();expect(result.state).toBe('recovery_required');
    expect((await coordinateUpgrade({journal:f.journal,plan:f.plan,groupId:'first',port})).state).toBe('recovery_required');expect(f.starts()).toBe(3);
    const recovery=new ManagedNativeUpgradePort(f.input,f.backend);try{const status=await f.journal.status(f.plan.digest,'first');const result=await recovery.reconcileForward(f.plan,f.plan.plan.groups[0]!,f.journal,upgradeDigest(status.records),AbortSignal.timeout(30000));expect(result.state).toBe('verified');expect(f.starts()).toBe(4);expect((await f.journal.status(f.plan.digest,'first')).completed).toBe(true);}finally{await recovery.close();}
  },60000);
  it('rejects additional consumers and changed pinned artifact before stopping a process',async()=>{
    const f=await fixture();await publishPrivate(join(f.root,'consumers','extra.json'),{});const port=new ManagedNativeUpgradePort(f.input,f.backend);
    try{const result=await coordinateUpgrade({journal:f.journal,plan:f.plan,groupId:'first',port});expect(result.state).toBe('qualification_pending');expect(f.starts()).toBe(2);expect(existsSync(join(f.root,'upgrade-operation.json'))).toBe(false);}finally{await port.close();}
    await writeFile(f.input.artifact,'{}');expect(()=>new ManagedNativeUpgradePort(f.input,f.backend)).toThrow('upgrade_artifact_changed');
  },30000);
  it('rejects traversal, altered content, and a registry path outside its managed root',async()=>{
    const f=await fixture();const parsed=JSON.parse(await readFile(f.input.artifact,'utf8'));parsed.files[0].path='../escape';await writeFile(f.input.artifact,JSON.stringify(parsed));expect(()=>loadBundle(f.input.artifact,sha256(readFileSync(f.input.artifact)))).toThrow();
    const alternate=join(f.root,'other.json');await writeFile(alternate,upgradeCanonical(f.config),{mode:0o600});expect(()=>loadInstallation(alternate,sha256(readFileSync(alternate)))).toThrow('upgrade_registry_location');
    await writeFile(join(f.root,'current','bin.mjs'),'changed');expect(()=>verifyRelease(f.root,f.old.target.build_digest)).toThrow('upgrade_release_changed');
  },30000);
  it('blocks managed startup before DB access unless registered and explicitly permitted after switch',async()=>{
    const f=await fixture();const c=f.config.consumers[0]!;const priorRoot=process.env['OSSTACK_MANAGED_INSTALLATION'];const priorSocket=process.env['OSSTACK_SOCKET'];
    try{process.env['OSSTACK_MANAGED_INSTALLATION']=f.root;process.env['OSSTACK_SOCKET']=c.socket;
      expect(managedStartupIdentity(c.home,join(f.root,'current','bin.mjs'))).toMatchObject({build_digest:f.old.target.build_digest});
      expect(()=>assertManagedHomeMarker(c.home,join(f.root,'current','bin.mjs'),{version:'1.0.0',protocol_version:1,database_schema:40})).not.toThrow();
      for(const mismatch of [{version:'2.0.0',protocol_version:1,database_schema:40},{version:'1.0.0',protocol_version:2,database_schema:40},{version:'1.0.0',protocol_version:1,database_schema:41}])expect(()=>assertManagedHomeMarker(c.home,join(f.root,'current','bin.mjs'),mismatch)).toThrow('upgrade_running_build_mismatch');
      expect(()=>managedStartupIdentity(f.config.consumers[1]!.home,join(f.root,'current','bin.mjs'))).toThrow('upgrade_unregistered_consumer');
      const before=sha256(readFileSync(join(c.home,'state.db')));await publishPrivate(join(f.root,'upgrade-operation.json'),{plan_digest:f.plan.digest});
      expect(()=>managedStartupIdentity(c.home,join(f.root,'current','bin.mjs'))).toThrow('upgrade_start_blocked');expect(()=>assertManagedHomeMarker(c.home,join(f.root,'current','bin.mjs'))).toThrow('upgrade_start_blocked');expect(sha256(readFileSync(join(c.home,'state.db')))).toBe(before);
      await publishPrivate(join(f.root,'restart-permit.json'),{plan_digest:f.plan.digest,build_digest:f.next.target.build_digest});
      expect(()=>managedStartupIdentity(c.home,join(f.root,'current','bin.mjs'))).toThrow('upgrade_start_blocked');
    }finally{if(priorRoot===undefined)delete process.env['OSSTACK_MANAGED_INSTALLATION'];else process.env['OSSTACK_MANAGED_INSTALLATION']=priorRoot;if(priorSocket===undefined)delete process.env['OSSTACK_SOCKET'];else process.env['OSSTACK_SOCKET']=priorSocket;}
  },30000);
  it('rejects injected extra modules even when all originally pinned files remain intact',async()=>{
    const f=await fixture();await writeFile(join(f.root,'current','extra.mjs'),'export default 1',{mode:0o600});expect(()=>verifyRelease(f.root,f.old.target.build_digest)).toThrow('upgrade_release_inventory');
  },30000);
  it('quarantines unresolved delivery after physical stop and refuses migration',async()=>{
    const f=await fixture();const c=f.config.consumers[0]!;const db=new Database(join(c.home,'state.db'));db.exec("CREATE TABLE follow_up_delivery_attempts(state TEXT); INSERT INTO follow_up_delivery_attempts VALUES('delivery_unknown')");db.close();
    const port=new ManagedNativeUpgradePort(f.input,f.backend);try{const result=await coordinateUpgrade({journal:f.journal,plan:f.plan,groupId:'first',port});expect(result).toMatchObject({state:'recovery_required',reason:'upgrade_unknown_delivery'});expect(realpathSync(join(f.root,'current'))).toBe(join(f.root,'releases',f.old.target.build_digest));expect(f.starts()).toBe(2);}finally{await port.close();}
  },30000);
  it('rejects stale reconciliation approval before a service can be started',async()=>{
    const f=await fixture();const port=new ManagedNativeUpgradePort(f.input,f.backend);await port.resolveAuthority(f.plan,f.plan.plan.groups[0]!,new AbortController().signal);await port.close();
    const recovery=new ManagedNativeUpgradePort(f.input,f.backend);try{await expect(recovery.reconcileForward(f.plan,f.plan.plan.groups[0]!,f.journal,'0'.repeat(64),AbortSignal.timeout(30000))).rejects.toThrow('upgrade_reconciliation_changed');expect(f.starts()).toBe(2);}finally{await recovery.close();}
  },30000);
  it('provisions a fresh exact installation without starting processes and resumes identical interrupted staging',async()=>{
    const f=await fixture();for(const c of f.config.consumers)await f.backend.stop(c.label,new AbortController().signal);
    const root=realpathSync(await createScratchDir('tests','provision'));roots.push(root);await chmod(root,0o700);const consumers=[];for(const previous of f.config.consumers){const home=realpathSync(await createScratchDir('tests','provision-home'));roots.push(home);await chmod(home,0o700);await publishPrivate(join(home,'deployment-identity.json'),{schema_version:1,home_id:previous.home_id});consumers.push({...previous,home,socket:join(home,'s')});}const config={...f.config,root,consumers};
    const request=join(f.root,'request.json');await publishPrivate(request,config);const input={request,approvedRegistryDigest:sha256(readFileSync(request)),artifact:f.input.artifact,artifactDigest:f.input.artifactDigest};
    // Fault before release staging: no consumer may point at an incomplete registry.
    await writeFile(join(root,'releases'),'blocked',{mode:0o600});
    // Keep the initial root admissible; the claim makes this an explicit resume fixture.
    await publishPrivate(join(root,'provisioning.json'),{registry_digest:input.approvedRegistryDigest,artifact_digest:input.artifactDigest});
    await expect(provisionManagedInstallation(input,AbortSignal.timeout(30000))).rejects.toThrow();
    expect(existsSync(join(root,'installation.json'))).toBe(false);
    for(const c of consumers)expect(existsSync(join(c.home,'managed-consumer.json'))).toBe(false);
    await rm(join(root,'releases'));
    await writeFile(join(root,'consumers','.publish-'+ 'b'.repeat(32)),'',{mode:0o600});
    const result=await provisionManagedInstallation(input,AbortSignal.timeout(30000));expect(result.state).toBe('provisioned_not_started');expect(f.starts()).toBe(2);expect(loadInstallation(result.registry,result.registry_sha256).root).toBe(root);expect(verifyRelease(root,f.next.target.build_digest).target.version).toBe('2.0.0');
    await rm(join(root,'installation.json'));await rm(join(root,'current'));expect((await provisionManagedInstallation(input,AbortSignal.timeout(30000))).state).toBe('provisioned_not_started');
  },30000);
  it('recovers forward after SIGKILL while a real stopped home and database are kernel-locked',async()=>{
    const f=await fixture();const runner=join(f.root,'crash-runner.ts');const executable=join(f.root,'crash-runner.cjs');
    const portSource=resolve('src/upgrade-native-port.ts'),journalSource=resolve('src/upgrade-journal.ts'),rpcSource=resolve('src/upgrade-native-backend.ts');
    await writeFile(runner,`import{ManagedNativeUpgradePort}from${JSON.stringify(portSource)};import{UpgradeJournal}from${JSON.stringify(journalSource)};import{upgradeRpc}from${JSON.stringify(rpcSource)};import fs from'node:fs';
const input=${JSON.stringify(f.input)},plan=${JSON.stringify(f.plan)},config=${JSON.stringify(f.config)};const signal=AbortSignal.timeout(30000);
const backend={async assertConsumers(){},async service(label){const c=config.consumers.find(c=>c.label===label);return fs.existsSync(c.socket)?'running':'absent';},async stop(label){const c=config.consumers.find(c=>c.label===label);const h=await upgradeRpc(c.socket,'health',signal);process.kill(h.pid,'SIGTERM');while(fs.existsSync(c.socket))await new Promise(r=>setTimeout(r,20));},async start(){throw Error('no restart before crash');}};
(async()=>{const port=new ManagedNativeUpgradePort(input,backend),journal=new UpgradeJournal(${JSON.stringify(join(f.root,'journal'))});await port.resolveAuthority(plan,plan.plan.groups[0],signal);const writer=await journal.claim(plan.digest,'first');await writer.append({phase:'draining',status:'started',at_ms:Date.now(),home_id:config.consumers[0].home_id,evidence_digest:null,evidence_ref:null,reason:null});await port.drain(plan.plan.groups[0].homes[0],signal);console.log('LOCKED');setInterval(()=>{},1000);})().catch(e=>{console.error(e);process.exit(1);});`,{mode:0o600});
    execFileSync(resolve('../../node_modules/.bin/esbuild'),[runner,'--bundle','--platform=node','--format=cjs','--packages=external',`--outfile=${executable}`],{stdio:'pipe'});
    await symlink(resolve('node_modules'),join(f.root,'node_modules'),'dir');
    const child=spawn(process.execPath,[executable],{env:{...process.env,NODE_PATH:resolve('node_modules')},stdio:['ignore','pipe','pipe']});children.push(child);
    await new Promise<void>((resolve,reject)=>{let output='',error='';const timer=setTimeout(()=>reject(Error('crash harness timeout '+error)),15000);child.stderr!.on('data',b=>error+=b.toString());child.once('exit',()=>{clearTimeout(timer);reject(Error('crash harness exited '+error));});child.stdout!.on('data',b=>{output+=b.toString();if(output.includes('LOCKED')){clearTimeout(timer);resolve();}});});
    await new Promise<void>(r=>{child.once('exit',()=>r());child.kill('SIGKILL');});expect(existsSync(join(f.root,'upgrade-operation.json'))).toBe(true);
    const recovery=new ManagedNativeUpgradePort(f.input,f.backend);try{const status=await f.journal.status(f.plan.digest,'first');expect(status.recovery.last_started_phase).toBe('draining');const result=await recovery.reconcileForward(f.plan,f.plan.plan.groups[0]!,f.journal,upgradeDigest(status.records),AbortSignal.timeout(30000));expect(result.state).toBe('verified');expect(f.starts()).toBe(4);}finally{await recovery.close();}
  },60000);
  it('keeps terminal history intact while explicitly cleaning a fence left after verification',async()=>{
    const f=await fixture();const port=new ManagedNativeUpgradePort(f.input,f.backend);expect((await coordinateUpgrade({journal:f.journal,plan:f.plan,groupId:'first',port})).state).toBe('verified');await port.close();const status=await f.journal.status(f.plan.digest,'first');
    const recovery=new ManagedNativeUpgradePort(f.input,f.backend);try{await recovery.reconcileForward(f.plan,f.plan.plan.groups[0]!,f.journal,upgradeDigest(status.records),AbortSignal.timeout(30000));expect((await f.journal.status(f.plan.digest,'first')).records).toEqual(status.records);expect(f.starts()).toBe(4);expect(existsSync(join(f.root,'upgrade-operation.json'))).toBe(false);}finally{await recovery.close();}
  },30000);
  it.each(['permit_missing','operation_missing','both_missing'] as const)('cleans completed history with stopped consumers after %s crash without restarting them',async missing=>{
    const f=await fixture();const port=new ManagedNativeUpgradePort(f.input,f.backend);
    expect((await coordinateUpgrade({journal:f.journal,plan:f.plan,groupId:'first',port})).state).toBe('verified');await port.close();
    const status=await f.journal.status(f.plan.digest,'first');
    for(const c of f.config.consumers)await f.backend.stop(c.label,new AbortController().signal);
    if(missing!=='operation_missing')await rm(join(f.root,'restart-permit.json'));
    if(missing!=='permit_missing')await rm(join(f.root,'upgrade-operation.json'));
    const recovery=new ManagedNativeUpgradePort(f.input,f.backend);
    try{expect(await recovery.reconcileForward(f.plan,f.plan.plan.groups[0]!,f.journal,upgradeDigest(status.records),AbortSignal.timeout(30000))).toMatchObject({state:'verified',reason:'verified_history_fence_cleanup_only',services_observed:false});
      await recovery.complete(); // Repeating cleanup under the same owner is idempotent.
      expect(f.starts()).toBe(4);expect((await f.journal.status(f.plan.digest,'first')).records).toEqual(status.records);
      expect(existsSync(join(f.root,'restart-permit.json'))).toBe(false);expect(existsSync(join(f.root,'upgrade-operation.json'))).toBe(false);
    }finally{await recovery.close();}
  },30000);
  it('clears an orphan permit from another plan before the next upgrade stops consumers',async()=>{
    const f=await fixture();await publishPrivate(join(f.root,'restart-permit.json'),{plan_digest:'f'.repeat(64),build_digest:f.old.target.build_digest});
    const port=new ManagedNativeUpgradePort(f.input,f.backend);
    try{expect((await coordinateUpgrade({journal:f.journal,plan:f.plan,groupId:'first',port})).state).toBe('verified');await port.complete();expect(f.starts()).toBe(4);expect(existsSync(join(f.root,'restart-permit.json'))).toBe(false);}finally{await port.close();}
  },30000);
  it('accepts only a single publication temp hardlink peer in the pre-DB managed guard',async()=>{
    const f=await fixture();const c=f.config.consumers[0]!,marker=join(c.home,'managed-consumer.json'),peer=join(c.home,'.publish-'+ 'a'.repeat(32));
    await link(marker,peer);expect(()=>assertManagedHomeMarker(c.home,join(f.root,'current','bin.mjs'))).not.toThrow();
    await rm(peer);await link(marker,join(c.home,'untrusted-peer'));
    expect(()=>assertManagedHomeMarker(c.home,join(f.root,'current','bin.mjs'))).toThrow('upgrade_managed_marker_invalid');
  },30000);
  it('removes a foreign orphan permit during historically verified cleanup when no operation exists',async()=>{
    const f=await fixture();const port=new ManagedNativeUpgradePort(f.input,f.backend);
    expect((await coordinateUpgrade({journal:f.journal,plan:f.plan,groupId:'first',port})).state).toBe('verified');await port.complete();await port.close();
    await publishPrivate(join(f.root,'restart-permit.json'),{plan_digest:'f'.repeat(64),build_digest:f.old.target.build_digest});
    const status=await f.journal.status(f.plan.digest,'first'),recovery=new ManagedNativeUpgradePort(f.input,f.backend);
    try{expect(await recovery.reconcileForward(f.plan,f.plan.plan.groups[0]!,f.journal,upgradeDigest(status.records),AbortSignal.timeout(30000))).toMatchObject({state:'verified',services_observed:false});expect(existsSync(join(f.root,'restart-permit.json'))).toBe(false);expect(f.starts()).toBe(4);}finally{await recovery.close();}
  },30000);
  it('waits for a physically pending stop before releasing owner locks and prevents late reacquisition after close',async()=>{
    const f=await fixture();let unblock!:()=>void;let arrived!:()=>void;const pending=new Promise<void>(r=>unblock=r);const started=new Promise<void>(r=>arrived=r);
    const port=new ManagedNativeUpgradePort(f.input,{...f.backend,stop:async(l,s)=>{await f.backend.stop(l,s);arrived();await pending;}});
    await port.resolveAuthority(f.plan,f.plan.plan.groups[0]!,new AbortController().signal);const stopped=port.drain(f.plan.plan.groups[0]!.homes[0]!,AbortSignal.timeout(30000));await started;let closed=false;const closing=port.close().then(()=>{closed=true;});await new Promise(r=>setTimeout(r,20));expect(closed).toBe(false);unblock();await expect(stopped).rejects.toThrow('upgrade_port_closed');await closing;expect(existsSync(join(f.root,'upgrade-operation.json'))).toBe(true);
  },30000);
  it('recovers a SIGKILL stale socket only after native ownership and connection refusal prove it is abandoned',async()=>{
    const f=await fixture();const port=new ManagedNativeUpgradePort(f.input,f.backend);await port.resolveAuthority(f.plan,f.plan.plan.groups[0]!,new AbortController().signal);await port.close();
    const consumer=f.config.consumers[0]!;const health=await upgradeRpc(consumer.socket,'health',new AbortController().signal) as {pid:number};const child=children.find(p=>p.pid===health.pid)!;await new Promise<void>(r=>{child.once('exit',()=>r());child.kill('SIGKILL');});expect(existsSync(consumer.socket)).toBe(true);
    const recovery=new ManagedNativeUpgradePort(f.input,f.backend);try{const status=await f.journal.status(f.plan.digest,'first');expect((await recovery.reconcileForward(f.plan,f.plan.plan.groups[0]!,f.journal,upgradeDigest(status.records),AbortSignal.timeout(30000))).state).toBe('verified');expect(f.starts()).toBe(4);}finally{await recovery.close();}
  },30000);
  it('mutually excludes different journals sharing one physical installation',async()=>{
    const f=await fixture();const port=new ManagedNativeUpgradePort(f.input,f.backend);await port.resolveAuthority(f.plan,f.plan.plan.groups[0]!,new AbortController().signal);
    const other=new ManagedNativeUpgradePort(f.input,f.backend);try{await expect(other.resolveAuthority(f.plan,f.plan.plan.groups[0]!,new AbortController().signal)).rejects.toThrow('ownership is held');expect((await readdir(join(f.root,'journal',f.plan.digest))).length).toBe(1);}finally{await other.close();await port.close();}
  },30000);
});
