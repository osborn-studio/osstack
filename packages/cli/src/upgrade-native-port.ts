import { constants, existsSync, readdirSync, realpathSync } from 'node:fs';
import { copyFile, mkdir, open, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { acquireDaemonLock, DaemonAlreadyRunningError } from './daemon-lock.js';
import { graphUpgradeHolds } from './graph-upgrade-guard.js';
import { DeploymentIdentitySchema } from './home-inventory.js';
import type { UpgradeJournal } from './upgrade-journal.js';
import type { NativeUpgradePort, UpgradeAuthority, UpgradeStopLease } from './upgrade-coordinator.js';
import { upgradeCanonical, upgradeDigest, type FrozenUpgradePlan, type UpgradePlanGroup, type UpgradePlanHome } from './upgrade-plan.js';
import { loadBundle, loadInstallation, privateDirectory, publishPrivate, readPrivate, sha256, stageRelease, switchRelease, syncDirectory, type ManagedInstallation, type ReleaseBundle } from './upgrade-native-files.js';
import { launchdUpgradeBackend, managedPlist, removeAbandonedUpgradeSocket, upgradeRpc, verifyRelease, type UpgradeBackend } from './upgrade-native-backend.js';
export interface NativeUpgradeInput { registry: string; registryDigest: string; artifact: string; artifactDigest: string; approvedPlanDigest: string }
const pause = (signal: AbortSignal) => new Promise<void>((resolve,reject) => { signal.throwIfAborted(); const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); },50); const abort = () => { clearTimeout(timer); reject(Error('upgrade_cancelled')); }; signal.addEventListener('abort',abort,{once:true}); });
/** Concrete opt-in managed launchd installation. Does not call npm, evaluate scripts or restore databases. */
export class ManagedNativeUpgradePort implements NativeUpgradePort {
  readonly config: ManagedInstallation;
  private readonly bundle: ReleaseBundle;
  private readonly backend: UpgradeBackend;
  private readonly stopLocks = new Map<string, () => void>();
  private ownerRelease: (() => void) | undefined;
  private plan: FrozenUpgradePlan | undefined;
  private group: UpgradePlanGroup | undefined;
  private closed=false;
  private readonly pending=new Set<Promise<unknown>>();
  private track<T>(work:()=>Promise<T>):Promise<T>{if(this.closed)return Promise.reject(Error('upgrade_port_closed'));const task=work();this.pending.add(task);void task.finally(()=>this.pending.delete(task)).catch(()=>{});return task;}

  constructor(readonly input: NativeUpgradeInput, backend?: UpgradeBackend) {
    this.config = loadInstallation(input.registry,input.registryDigest); this.bundle = loadBundle(input.artifact,input.artifactDigest);
    if (!this.bundle.files.some(f => f.path === this.config.entry)) throw Error('upgrade_missing_entry');
    this.backend = backend ?? launchdUpgradeBackend();
  }
  private assertPins(): void {
    const fresh = loadInstallation(this.input.registry,this.input.registryDigest);
    if (upgradeCanonical(fresh) !== upgradeCanonical(this.config)) throw Error('upgrade_registry_changed');
    if (sha256(readPrivate(this.input.artifact,128*1024*1024)) !== this.input.artifactDigest) throw Error('upgrade_artifact_changed');
    privateDirectory(join(this.config.root,'consumers'));
    const names = readdirSync(join(this.config.root,'consumers')).sort();
    if (upgradeCanonical(names) !== upgradeCanonical(this.config.consumers.map(c => `${c.home_id}.json`).sort())) throw Error('upgrade_consumers_incomplete');
    for (const c of this.config.consumers) {
      const marker=JSON.parse(readPrivate(join(c.home,'managed-consumer.json'),8192).toString());if(upgradeCanonical(marker)!==upgradeCanonical({schema_version:1,root:this.config.root,home_id:c.home_id}))throw Error('upgrade_consumer_marker_changed');
      if (upgradeCanonical(JSON.parse(readPrivate(join(this.config.root,'consumers',`${c.home_id}.json`)).toString())) !== upgradeCanonical(c)) throw Error('upgrade_consumer_changed');
      if (readPrivate(join(this.config.root,'services',`${c.home_id}.plist`)).toString() !== managedPlist(this.config,c)) throw Error('upgrade_service_changed');
    }
  }
  private consumer(home: UpgradePlanHome) {
    const c = this.config.consumers.find(c => c.home_id === home.home_id && c.socket === home.socket); if (!c) throw Error('upgrade_consumer_binding'); return c;
  }
  private assertOperation(): void {
    if(this.closed)throw Error('upgrade_port_closed'); this.assertPins(); const value = JSON.parse(readPrivate(join(this.config.root,'upgrade-operation.json')).toString());
    if (!this.plan || value.plan_digest !== this.plan.digest || value.group_id !== this.group?.group_id || value.registry_digest !== this.input.registryDigest || value.artifact_digest !== this.input.artifactDigest) throw Error('upgrade_operation_binding');
  }
  resolveAuthority(plan: FrozenUpgradePlan, group: UpgradePlanGroup, signal: AbortSignal):Promise<UpgradeAuthority>{return this.track(()=>this.doResolveAuthority(plan,group,signal));}
  private async doResolveAuthority(plan: FrozenUpgradePlan, group: UpgradePlanGroup, signal: AbortSignal): Promise<UpgradeAuthority> {
    signal.throwIfAborted(); this.assertPins();
    if (plan.digest !== this.input.approvedPlanDigest || this.config.installation_id !== group.installation_id
      || upgradeCanonical(plan.plan.target) !== upgradeCanonical(this.bundle.target)
      || upgradeCanonical(group.homes.map(h => h.home_id).sort()) !== upgradeCanonical(this.config.consumers.map(c => c.home_id).sort())) throw Error('upgrade_approval_binding');
    this.plan = plan; this.group = group;
    this.ownerRelease = acquireDaemonLock(join(this.config.root,'upgrade-owner.pid'));
    const staged=join(this.config.root,'releases',plan.plan.target.build_digest);if(!existsSync(staged))await stageRelease(this.config.root,this.bundle,signal);
    if(upgradeCanonical(verifyRelease(this.config.root,plan.plan.target.build_digest).target)!==upgradeCanonical(plan.plan.target))throw Error('upgrade_release_metadata_changed');
    signal.throwIfAborted();if(this.closed)throw Error('upgrade_port_closed');
    const pids:number[]=[];for(const c of this.config.consumers){const health=z.object({pid:z.number().int().positive()}).passthrough().parse(await upgradeRpc(c.socket,'health',signal));pids.push(health.pid);}
    await this.backend.assertConsumers(this.config,pids,signal);
    await publishPrivate(join(this.config.root,'upgrade-operation.json'), { plan_digest: plan.digest, group_id: group.group_id, registry_digest: this.input.registryDigest, artifact_digest: this.input.artifactDigest });
    this.assertOperation();
    return { plan_digest: plan.digest, group_id: group.group_id, installation_id: group.installation_id,
      consumer_home_ids: group.homes.map(h => h.home_id), expires_at_ms: plan.plan.expires_at_ms,
      completeness_evidence_ref: `managed-registry:${this.input.registryDigest}`, qualification_ref: 'managed_launchd_v1', authorization_ref: `explicit-plan:${plan.digest}`, assertCurrent: () => this.assertOperation() };
  }
  async observe(home: UpgradePlanHome, signal: AbortSignal) {
    this.assertOperation(); const c = this.consumer(home);
    if (await this.backend.service(c.label,signal) !== 'running') throw Error('upgrade_service_missing');
    const identity = DeploymentIdentitySchema.parse(await upgradeRpc(c.socket,'deployment.identity',signal));
    const health=z.object({version:z.string(),protocol_version:z.number()}).passthrough().parse(await upgradeRpc(c.socket,'health',signal));
    const {default:Database}=await import('better-sqlite3');const db=new Database(join(c.home,'state.db'),{readonly:true,fileMustExist:true});let schema:unknown;try{schema=db.pragma('user_version',{simple:true});}finally{db.close();}this.assertOperation();
    return { identity, healthy: identity.home_id === c.home_id && identity.version===health.version && identity.protocol_version===health.protocol_version && identity.database_schema===schema, receipt_ref: `identity:${upgradeDigest(identity)}` };
  }
  drain(home: UpgradePlanHome, signal: AbortSignal) { return this.track(()=>this.doDrain(home,signal)); }
  private async doDrain(home: UpgradePlanHome, signal: AbortSignal): Promise<UpgradeStopLease> {
    this.assertOperation(); const c = this.consumer(home);
    const identity = DeploymentIdentitySchema.parse(await upgradeRpc(c.socket,'deployment.identity',signal));
    if (upgradeCanonical(identity) !== upgradeCanonical(home.identity)) throw Error('upgrade_identity_changed');
    z.object({ pid: z.number().int().positive() }).passthrough().parse(await upgradeRpc(c.socket,'health',signal));
    const drain = z.object({ drained: z.literal(true), graph_holds: z.literal(0), active_runs: z.literal(0) }).passthrough().parse(await upgradeRpc(c.socket,'daemon.drain',signal));
    if (!drain.drained) throw Error('upgrade_not_drained'); this.assertOperation();
    await this.backend.stop(c.label,signal);
    if (await this.backend.service(c.label,signal) !== 'absent') throw Error('upgrade_stop_unknown');
    signal.throwIfAborted(); this.assertOperation();
    await this.holdStoppedHome(c.home,c.home_id,c.socket,signal);
    const assertHeld = () => { this.assertOperation(); if (!this.stopLocks.has(c.home_id) || existsSync(c.socket)) throw Error('upgrade_stop_lost'); };
    assertHeld(); return { receipt: { home_id: c.home_id, generation: identity.generation, stopped:true, graph_holds:0, unknown_actions:0, receipt_ref: `stopped:${identity.generation}` }, assertHeld };
  }
  private async holdStoppedHome(home:string,id:string,socketPath:string,signal:AbortSignal):Promise<void>{
    while(true){signal.throwIfAborted();this.assertOperation();try{this.stopLocks.set(id,acquireDaemonLock(join(home,'daemon.pid')));break;}catch(error){if(!(error instanceof DaemonAlreadyRunningError))throw error;await pause(signal);}}
    await this.lockHomeDatabase(home,id);this.assertOperation();signal.throwIfAborted();
    await removeAbandonedUpgradeSocket(socketPath,signal);this.assertOperation();
  }

  private async lockHomeDatabase(home: string, homeId:string): Promise<void> {
    const path = join(home,'state.db'); if (!existsSync(path)) throw Error('upgrade_database_missing');
    const { default: Database } = await import('better-sqlite3'); this.assertOperation();
    const db = new Database(path,{ fileMustExist:true,timeout:0 }); const release=this.stopLocks.get(homeId)!;
    try {
      db.exec('BEGIN EXCLUSIVE');
      const schema=db.pragma('user_version',{simple:true}) as number;
      if(schema<33||schema>46)throw Error('upgrade_schema_unqualified');
      const tables = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {name:string}[]).map(r=>r.name));
      const expected=['graph_runs','graph_action_admissions','graph_actions','improvement_pr_deliveries','improvement_executions'];
      if(schema>=45)expected.push('follow_up_delivery_attempts');
      if(expected.some(name=>!tables.has(name)))throw Error('upgrade_schema_tables_missing');
      if((db.prepare("SELECT count(*) n FROM improvement_executions WHERE state IN ('claimed','running')").get() as {n:number}).n>0)throw Error('upgrade_unknown_actions');
      if(graphUpgradeHolds(db)>0)throw Error('upgrade_graph_holds');
      if((db.prepare("SELECT count(*) n FROM graph_actions WHERE state IN ('running','unknown','cancel_pending')").get() as {n:number}).n>0
        ||(db.prepare("SELECT count(*) n FROM improvement_pr_deliveries WHERE state IN ('push_dispatched','pr_dispatched')").get() as {n:number}).n>0)throw Error('upgrade_unknown_actions');
      if(tables.has('follow_up_delivery_attempts')&&(db.prepare("SELECT count(*) n FROM follow_up_delivery_attempts WHERE state IN ('started','delivery_unknown')").get() as {n:number}).n>0)throw Error('upgrade_unknown_delivery');
      this.stopLocks.set(homeId,()=>{try{db.exec('ROLLBACK');}finally{db.close();release();}});
    }catch(error){db.close();throw error;}
  }
  snapshot(home: UpgradePlanHome, signal: AbortSignal, suffix = '') { return this.track(()=>this.doSnapshot(home,signal,suffix)); }
  private async doSnapshot(home: UpgradePlanHome, signal: AbortSignal, suffix = '') {
    this.assertOperation(); const c = this.consumer(home); if (!this.stopLocks.has(c.home_id)) throw Error('upgrade_stop_lost'); signal.throwIfAborted();
    const base = join(c.home,'upgrade-snapshots'); await mkdir(base,{mode:0o700}).catch(e=>{if(e.code!=='EEXIST')throw e;}); privateDirectory(base);
    const dir = join(base,this.plan!.digest + suffix); await mkdir(dir,{mode:0o700});
    for (const name of ['state.db','state.db-wal','state.db-shm']) {
      signal.throwIfAborted(); const path = join(c.home,name); if (!existsSync(path)) continue;
      if (realpathSync(path) !== path) throw Error('upgrade_snapshot_symlink'); await copyFile(path,join(dir,name),constants.COPYFILE_EXCL);
      const fd = await open(join(dir,name),constants.O_RDONLY|constants.O_NOFOLLOW); try { await fd.sync(); } finally { await fd.close(); }
    }
    await syncDirectory(dir); await syncDirectory(base); this.assertOperation();
    return { home_id:c.home_id,source_generation:home.identity!.generation,receipt_ref:`snapshot:${this.plan!.digest}:${c.home_id}` };
  }
  install(plan: FrozenUpgradePlan, group: UpgradePlanGroup, signal: AbortSignal) { return this.track(()=>this.doInstall(plan,group,signal)); }
  private async doInstall(plan: FrozenUpgradePlan, group: UpgradePlanGroup, signal: AbortSignal) {
    this.assertOperation(); if (this.stopLocks.size !== group.homes.length) throw Error('upgrade_all_consumers_required');
    for (const c of this.config.consumers) if (await this.backend.service(c.label,signal) !== 'absent') throw Error('upgrade_stop_lost');
    await this.backend.assertConsumers(this.config,[],signal);
    const release = join(this.config.root,'releases',plan.plan.target.build_digest); this.assertOperation();
    if(upgradeCanonical(verifyRelease(this.config.root,plan.plan.target.build_digest).target)!==upgradeCanonical(plan.plan.target))throw Error('upgrade_release_metadata_changed'); await switchRelease(this.config.root,release,signal); this.assertOperation();
    return {plan_digest:plan.digest,installation_id:group.installation_id,version:plan.plan.target.version,build_digest:plan.plan.target.build_digest,receipt_ref:`release:${plan.plan.target.build_digest}`};
  }
  restart(home: UpgradePlanHome, signal: AbortSignal) { return this.track(()=>this.doRestart(home,signal)); }
  private async doRestart(home: UpgradePlanHome, signal: AbortSignal) {
    this.assertOperation(); const c = this.consumer(home); if (!this.stopLocks.has(c.home_id)) throw Error('upgrade_stop_lost');
    const permit = join(this.config.root,'restart-permit.json');
    if (!existsSync(permit)) await publishPrivate(permit,{plan_digest:this.plan!.digest,build_digest:this.plan!.plan.target.build_digest});
    const expected = JSON.parse(readPrivate(permit).toString()); if (expected.plan_digest !== this.plan!.digest || expected.build_digest !== this.plan!.plan.target.build_digest) throw Error('upgrade_restart_permit_binding');
    this.stopLocks.get(c.home_id)!(); this.stopLocks.delete(c.home_id);
    await this.backend.start(join(this.config.root,'services',`${c.home_id}.plist`),signal);
    while (!existsSync(c.socket)) { this.assertOperation(); await pause(signal); }
    this.assertOperation(); return {home_id:c.home_id,source_generation:home.identity!.generation,receipt_ref:`restart:${this.plan!.digest}:${c.home_id}`};
  }
  /** Fresh explicit approval performs forward repair from observed facts, never a blind rerun.
   * A successful target is kept; absent services alone may be bootstrapped. Unknown observations stop. */
  reconcileForward(plan: FrozenUpgradePlan, group: UpgradePlanGroup, journal: UpgradeJournal, expectedHistory: string, signal: AbortSignal){return this.track(()=>this.doReconcileForward(plan,group,journal,expectedHistory,signal));}
  private async doReconcileForward(plan: FrozenUpgradePlan, group: UpgradePlanGroup, journal: UpgradeJournal, expectedHistory: string, signal: AbortSignal) {
    this.plan = plan; this.group = group;
    if (this.input.approvedPlanDigest !== plan.digest || this.config.installation_id !== group.installation_id
      || upgradeCanonical(this.bundle.target) !== upgradeCanonical(plan.plan.target)
      || upgradeCanonical(group.homes.map(h=>h.home_id).sort()) !== upgradeCanonical(this.config.consumers.map(c=>c.home_id).sort())) throw Error('upgrade_approval_binding');
    this.ownerRelease = acquireDaemonLock(join(this.config.root,'upgrade-owner.pid')); this.assertPins();
    const previous=await journal.status(plan.digest,group.group_id);
    if(previous.completed){
      if(upgradeDigest(previous.records)!==expectedHistory)throw Error('upgrade_reconciliation_changed');
      if(realpathSync(join(this.config.root,'current'))!==join(this.config.root,'releases',plan.plan.target.build_digest)||upgradeCanonical(verifyRelease(this.config.root,plan.plan.target.build_digest).target)!==upgradeCanonical(plan.plan.target))throw Error('upgrade_release_metadata_changed');
      // Terminal history already contains verified identities. This only repairs
      // interrupted fence cleanup, never replays work or claims current health.
      signal.throwIfAborted();
      await journal.cleanupVerifiedClaims(plan.digest,group.group_id,expectedHistory);
      await this.complete();return{state:'verified' as const,history_digest:expectedHistory,reason:'verified_history_fence_cleanup_only'};
    }
    this.assertOperation();
    let history = await journal.recordReconciliation(plan.digest,group.group_id,expectedHistory,{verified:false,evidence:{registry:this.input.registryDigest,artifact:this.input.artifactDigest},reason:'explicit_forward_reconciliation'});
    try {
      const current = realpathSync(join(this.config.root,'current'));
      const target = join(this.config.root,'releases',plan.plan.target.build_digest);
      if(!existsSync(target))await stageRelease(this.config.root,this.bundle,signal);
      if(upgradeCanonical(verifyRelease(this.config.root,plan.plan.target.build_digest).target)!==upgradeCanonical(plan.plan.target))throw Error('upgrade_release_metadata_changed');
      signal.throwIfAborted();this.assertOperation();const targetActive = current === target;
      const toStart: UpgradePlanHome[] = [];
      for (const home of group.homes) {
        signal.throwIfAborted(); this.assertOperation(); const c = this.consumer(home);
        const state = await this.backend.service(c.label,signal);
        if (state === 'running') {
          const observed = await this.observe(home,signal);
          if (targetActive && observed.identity.build_digest === plan.plan.target.build_digest) continue;
          if (targetActive) throw Error('upgrade_reconciliation_running_wrong_build');
          await this.drain(home,signal);
        } else {
          await this.holdStoppedHome(c.home,c.home_id,c.socket,signal);
        }
        toStart.push(home);
      }
      const runningPids:number[]=[];for(const home of group.homes){const c=this.consumer(home);if(await this.backend.service(c.label,signal)==='running'){const health=z.object({pid:z.number().int().positive()}).passthrough().parse(await upgradeRpc(c.socket,'health',signal));runningPids.push(health.pid);}}await this.backend.assertConsumers(this.config,runningPids,signal);
      if (!targetActive) {
        for (const home of group.homes) {
          await this.snapshot(home,signal,`-reconcile-${history.slice(0,16)}`);
        }
        if (!existsSync(target)) await stageRelease(this.config.root,this.bundle,signal);
        if(upgradeCanonical(verifyRelease(this.config.root,plan.plan.target.build_digest).target)!==upgradeCanonical(plan.plan.target))throw Error('upgrade_release_metadata_changed'); this.assertOperation();
        await switchRelease(this.config.root,target,signal);
      }
      if(upgradeCanonical(verifyRelease(this.config.root,plan.plan.target.build_digest).target)!==upgradeCanonical(plan.plan.target))throw Error('upgrade_release_metadata_changed');
      for (const home of toStart) await this.restart(home,signal);
      const identities = [];
      for (const home of group.homes) {
        const observed = await this.observe(home,signal); const i = observed.identity;
        if (!observed.healthy || i.version !== plan.plan.target.version || i.build_digest !== plan.plan.target.build_digest
          || i.protocol_version !== plan.plan.target.protocol_version || i.database_schema !== plan.plan.target.database_schema
          || i.generation === home.identity?.generation || i.build_evidence !== 'host_manifest' || i.deployment_kind !== 'npm') throw Error('upgrade_version_mismatch');
        identities.push(i);
      }
      this.assertOperation(); history = await journal.recordReconciliation(plan.digest,group.group_id,history,{verified:true,evidence:identities,reason:'reconciled_target_verified'});
      await this.complete(); return {state:'verified' as const,history_digest:history};
    } catch (error) {
      await journal.recordReconciliation(plan.digest,group.group_id,history,{verified:false,evidence:{error:'reconciliation_unknown'},reason:'reconciliation_unknown'}).catch(()=>{});
      throw error;
    }
  }
  /** Kernel locks may be released; the persistent operation fence survives every failure. */
  async close(): Promise<void> { this.closed=true;await Promise.allSettled([...this.pending]);for (const release of this.stopLocks.values()) release(); this.stopLocks.clear(); this.ownerRelease?.(); this.ownerRelease=undefined; }
  complete():Promise<void>{return this.track(()=>this.doComplete());}
  private async doComplete(): Promise<void> {
    this.assertPins();
    if(!this.plan||!this.group||!this.ownerRelease)throw Error('upgrade_operation_binding');
    const operation=join(this.config.root,'upgrade-operation.json'),permit=join(this.config.root,'restart-permit.json');
    if(existsSync(operation))this.assertOperation();
    if(existsSync(permit)){const value=JSON.parse(readPrivate(permit).toString());if(value.plan_digest!==this.plan.digest||value.build_digest!==this.plan.plan.target.build_digest)throw Error('upgrade_restart_permit_binding');}
    // Make absence of the blocking fence durable before removing startup permission.
    // A crash at either boundary is safe and the same authorized cleanup is resumable.
    await unlink(operation).catch(e=>{if(e.code!=='ENOENT')throw e;});await syncDirectory(this.config.root);
    await unlink(permit).catch(e=>{if(e.code!=='ENOENT')throw e;});await syncDirectory(this.config.root);
  }
}
