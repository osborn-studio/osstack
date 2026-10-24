import { constants, existsSync, readdirSync } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { ManagedInstallationSchema, loadBundle, privateDirectory, publishPrivate, readPrivate, sha256, stageRelease, switchRelease, syncDirectory } from './upgrade-native-files.js';
import { managedPlist, verifyRelease } from './upgrade-native-backend.js';
/** Creates a NEW private managed installation; never adopts or mutates an existing global installation.
 * Consumers are an immutable closed set. Changes require a new explicitly provisioned installation. */
export async function provisionManagedInstallation(input: { request: string; approvedRegistryDigest: string; artifact: string; artifactDigest: string }, signal: AbortSignal) {
  const bytes = readPrivate(input.request); if (sha256(bytes) !== input.approvedRegistryDigest) throw Error('upgrade_registry_approval');
  const config = ManagedInstallationSchema.parse(JSON.parse(bytes.toString())); privateDirectory(config.root);
  if (readdirSync(config.root).length !== 0) throw Error('upgrade_installation_not_empty');
  const bundle = loadBundle(input.artifact,input.artifactDigest);
  if (!bundle.files.some(f=>f.path===config.entry)) throw Error('upgrade_missing_entry');
  for(const c of config.consumers) { privateDirectory(c.home); const identity=JSON.parse(readPrivate(join(c.home,'deployment-identity.json'),512).toString());if(identity.home_id!==c.home_id||identity.schema_version!==1)throw Error('upgrade_home_identity_changed'); if(existsSync(c.socket)||existsSync(join(c.home,'daemon.pid'))) throw Error('upgrade_consumer_not_offline'); }
  // A create-only root claim excludes two concurrent provisioners before any release or registry publication.
  await publishPrivate(join(config.root,'provisioning.json'),{registry_digest:input.approvedRegistryDigest,artifact_digest:input.artifactDigest});
  for(const name of ['consumers','services'])await mkdir(join(config.root,name),{mode:0o700});
  for(const c of config.consumers){await publishPrivate(join(c.home,'managed-consumer.json'),{schema_version:1,root:config.root,home_id:c.home_id});await publishPrivate(join(config.root,'consumers',`${c.home_id}.json`),c);
    const fd=await open(join(config.root,'services',`${c.home_id}.plist`),constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|constants.O_NOFOLLOW,0o600);try{await fd.writeFile(managedPlist(config,c));await fd.sync();}finally{await fd.close();}}
  await syncDirectory(join(config.root,'services'));
  const release=await stageRelease(config.root,bundle,signal);verifyRelease(config.root,bundle.target.build_digest);await switchRelease(config.root,release,signal);
  await publishPrivate(join(config.root,'installation.json'),config);
  return{state:'provisioned_not_started',registry:join(config.root,'installation.json'),registry_sha256:sha256(readPrivate(join(config.root,'installation.json'))),build_digest:bundle.target.build_digest,
    services:config.consumers.map(c=>join(config.root,'services',`${c.home_id}.plist`))};
}
