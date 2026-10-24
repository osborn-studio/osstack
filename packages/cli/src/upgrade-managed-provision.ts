import { existsSync, readdirSync } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { acquireDaemonLock } from './daemon-lock.js';
import { upgradeCanonical } from './upgrade-plan.js';
import { ManagedInstallationSchema, finishPrivatePublication, loadBundle, privateDirectory, publishPrivate, publishPrivateBytes, readPrivate, sha256, stageRelease, switchRelease, syncDirectory } from './upgrade-native-files.js';
import { managedPlist, removeAbandonedUpgradeSocket, verifyRelease } from './upgrade-native-backend.js';
/** Creates a NEW private managed installation; interrupted identical provisioning is explicitly resumable. */
export async function provisionManagedInstallation(input: { request: string; approvedRegistryDigest: string; artifact: string; artifactDigest: string }, signal: AbortSignal) {
  const bytes = readPrivate(input.request); if (sha256(bytes) !== input.approvedRegistryDigest) throw Error('upgrade_registry_approval');
  const config = ManagedInstallationSchema.parse(JSON.parse(bytes.toString())); privateDirectory(config.root);
  const claim={registry_digest:input.approvedRegistryDigest,artifact_digest:input.artifactDigest};
  const names=readdirSync(config.root);const resumed=existsSync(join(config.root,'provisioning.json'));
  if(names.length&&(!resumed||upgradeCanonical(JSON.parse(readPrivate(join(config.root,'provisioning.json')).toString()))!==upgradeCanonical(claim)))throw Error('upgrade_installation_not_empty');
  const allowed=new Set(['provisioning.json','provision-owner.pid','provision-owner.pid.lock.db','consumers','services','releases','current','installation.json']);
  if(resumed&&names.some(name=>!allowed.has(name)&&!/^\.publish-[a-f0-9]{32}$/.test(name)))throw Error('upgrade_provision_unknown_file');
  const homeLocks:Array<()=>void>=[];
  const publishSame=async(path:string,value:unknown)=>{try{await publishPrivate(path,value);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST'||upgradeCanonical(JSON.parse(readPrivate(path).toString()))!==upgradeCanonical(value))throw error;}await finishPrivatePublication(path);};
  await publishSame(join(config.root,'provisioning.json'),claim);
  const releaseOwner=acquireDaemonLock(join(config.root,'provision-owner.pid'));
  try{
    const bundle = loadBundle(input.artifact,input.artifactDigest);if(!bundle.files.some(f=>f.path===config.entry))throw Error('upgrade_missing_entry');
    for(const c of config.consumers){privateDirectory(c.home);const identity=JSON.parse(readPrivate(join(c.home,'deployment-identity.json'),512).toString());if(identity.home_id!==c.home_id||identity.schema_version!==1)throw Error('upgrade_home_identity_changed');homeLocks.push(acquireDaemonLock(join(c.home,'daemon.pid')));await removeAbandonedUpgradeSocket(c.socket,signal);}
    await publishSame(join(config.root,'provisioning.json'),claim);
    for(const name of ['consumers','services']){await mkdir(join(config.root,name),{mode:0o700}).catch(error=>{if(error.code!=='EEXIST')throw error;});privateDirectory(join(config.root,name));}
    if(readdirSync(join(config.root,'consumers')).some(name=>!config.consumers.some(c=>name===`${c.home_id}.json`)&&!/^\.publish-[a-f0-9]{32}$/.test(name)))throw Error('upgrade_provision_unknown_consumer');
    if(readdirSync(join(config.root,'services')).some(name=>!config.consumers.some(c=>name===`${c.home_id}.plist`)&&!/^\.publish-[a-f0-9]{32}$/.test(name)))throw Error('upgrade_provision_unknown_service');
    for(const c of config.consumers){await publishSame(join(c.home,'managed-consumer.json'),{schema_version:1,root:config.root,home_id:c.home_id});await publishSame(join(config.root,'consumers',`${c.home_id}.json`),c);
      const plist=join(config.root,'services',`${c.home_id}.plist`),text=managedPlist(config,c);
      if(existsSync(plist)){if(readPrivate(plist).toString()!==text)throw Error('upgrade_service_changed');}
      else await publishPrivateBytes(plist,Buffer.from(text));await finishPrivatePublication(plist);
    }
    for(const [directory,expected] of [[join(config.root,'consumers'),config.consumers.map(c=>Buffer.from(upgradeCanonical(c)))],[join(config.root,'services'),config.consumers.map(c=>Buffer.from(managedPlist(config,c)))]] as const){for(const name of readdirSync(directory).filter(n=>/^\.publish-[a-f0-9]{32}$/.test(n))){const path=join(directory,name);const bytes=readPrivate(path);if(!expected.some(value=>value.equals(bytes)))throw Error('upgrade_provision_unknown_file');await unlink(path);}await syncDirectory(directory);}
    await syncDirectory(join(config.root,'services'));
    const release=join(config.root,'releases',bundle.target.build_digest);if(!existsSync(release))await stageRelease(config.root,bundle,signal);
    if(upgradeCanonical(verifyRelease(config.root,bundle.target.build_digest).target)!==upgradeCanonical(bundle.target))throw Error('upgrade_release_metadata_changed');
    await switchRelease(config.root,release,signal);await publishSame(join(config.root,'installation.json'),config);
    return{state:'provisioned_not_started',registry:join(config.root,'installation.json'),registry_sha256:sha256(readPrivate(join(config.root,'installation.json'))),build_digest:bundle.target.build_digest,services:config.consumers.map(c=>join(config.root,'services',`${c.home_id}.plist`))};
  }finally{for(const release of homeLocks.reverse())release();releaseOwner();}
}
