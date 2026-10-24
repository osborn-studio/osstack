import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { connect } from 'node:net';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { privateDirectory, readPrivate, sha256, type ManagedInstallation } from './upgrade-native-files.js';
import { UpgradeTargetSchema, upgradeCanonical } from './upgrade-plan.js';
export interface UpgradeBackend {
  assertConsumers(config: ManagedInstallation, allowedPids: readonly number[], signal: AbortSignal): Promise<void>;
  service(label: string, signal: AbortSignal): Promise<'running' | 'absent'>;
  stop(label: string, signal: AbortSignal): Promise<void>;
  start(plist: string, signal: AbortSignal): Promise<void>;
}
/** Fixed executable and fixed subcommands only. Test harnesses inject a process-backed backend, never CLI inputs. */
export function launchdUpgradeBackend(): UpgradeBackend {
  if (process.platform !== 'darwin' || !process.getuid) throw Error('upgrade_backend_unsupported');
  const domain = `gui/${process.getuid()}`;
  const run = (args: string[], signal: AbortSignal): Promise<{ code: number; text: string }> => new Promise((resolve, reject) => {
    execFile('/bin/launchctl', args, { signal, timeout: 15000, maxBuffer: 131072, env: { PATH: '/usr/bin:/bin', LANG: 'C' } }, (error, stdout, stderr) => {
      if (signal.aborted || error && typeof error.code !== 'number') { reject(Error('upgrade_backend_unknown')); return; }
      resolve({ code: error?.code as number ?? 0, text: stdout + stderr });
    });
  });
  return {
    async assertConsumers(config,allowedPids,signal) {
      const listed=await run(['list'],signal);if(listed.code!==0)throw Error('upgrade_consumer_inventory_unknown');
      const labels=listed.text.split('\n').map(line=>line.trim().split(/\s+/).at(-1)!).filter(label=>label?.startsWith('ai.osstack.managed.'));
      if(labels.length>256)throw Error('upgrade_consumer_inventory_limit');
      for(const label of labels){const printed=await run(['print',`${domain}/${label}`],signal);if(printed.code!==0)throw Error('upgrade_consumer_inventory_unknown');
        const expected=config.consumers.find(c=>c.label===label);
        if(!expected&&printed.text.includes(config.root+'/'))throw Error('upgrade_unregistered_consumer');
        if(expected&&(!printed.text.includes(join(config.root,'current',config.entry))||!printed.text.includes(expected.home)||!printed.text.includes(config.node)))throw Error('upgrade_service_identity');
      }
      const processTable=await new Promise<string>((resolve,reject)=>execFile('/bin/ps',['-axo','pid=,command='],{signal,timeout:5000,maxBuffer:2097152,env:{PATH:'/usr/bin:/bin',LANG:'C'}},(error,stdout)=>error?reject(Error('upgrade_process_inventory_unknown')):resolve(stdout)));
      for(const line of processTable.split('\n')){const match=line.trim().match(/^(\d+)\s+(.*)$/);if(!match)continue;const pid=Number(match[1]);const command=match[2]!;
        if(pid!==process.pid&&(command.includes(config.root+'/current/')||command.includes(config.root+'/releases/'))&&!allowedPids.includes(pid))throw Error('upgrade_unregistered_process');
      }
    },
    async service(label, signal) { const r = await run(['print', `${domain}/${label}`], signal);
      if (r.code === 0) return 'running';
      // launchctl's fixed absence exit code; other failures are unknown, not permission to bootstrap.
      if (r.code === 113 && /Could not find service/.test(r.text)) return 'absent';
      throw Error('upgrade_backend_unknown');
    },
    async stop(label, signal) { if ((await run(['bootout', `${domain}/${label}`], signal)).code !== 0) throw Error('upgrade_stop_unknown'); },
    async start(plist, signal) { if ((await run(['bootstrap', domain, plist], signal)).code !== 0) throw Error('upgrade_restart_unknown'); },
  };
}
export function upgradeRpc(socketPath: string, method: 'deployment.identity' | 'daemon.drain' | 'health', signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) return Promise.reject(Error('upgrade_cancelled'));
  const info = lstatSync(socketPath); if (!info.isSocket() || realpathSync(socketPath) !== socketPath || process.getuid && info.uid !== process.getuid()) return Promise.reject(Error('upgrade_unsafe_socket'));
  return new Promise((resolve, reject) => {
    const socket = connect(socketPath); let buffer = Buffer.alloc(0); let settled = false;
    const finish = (error?: Error, value?: unknown) => { if (settled) return; settled = true; clearTimeout(timer); signal.removeEventListener('abort', abort); socket.destroy(); if (error) reject(error); else resolve(value); };
    const abort = () => finish(Error('upgrade_cancelled')); const timer = setTimeout(() => finish(Error('upgrade_rpc_unknown')), 15000);
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    socket.on('error', () => finish(Error('upgrade_rpc_unknown'))); socket.on('close', () => finish(Error('upgrade_rpc_unknown')));
    socket.on('connect', () => { if (settled) return; const body = Buffer.from(JSON.stringify({ id: 1, method, ...(method === 'daemon.drain' ? { params: { timeout_ms: 10000 } } : {}) })); const header = Buffer.alloc(4); header.writeUInt32BE(body.length); socket.write(Buffer.concat([header, body])); });
    socket.on('data', chunk => { if (buffer.length + chunk.length > 65536) { finish(Error('upgrade_rpc_invalid')); return; }
      buffer = Buffer.concat([buffer, chunk]); if (buffer.length < 4) return; const size = buffer.readUInt32BE();
      if (size > 65532 || buffer.length > size + 4) { finish(Error('upgrade_rpc_invalid')); return; } if (buffer.length < size + 4) return;
      try { const result = z.object({ id: z.literal(1), ok: z.literal(true), result: z.unknown() }).strict().parse(JSON.parse(buffer.subarray(4).toString())); finish(undefined, result.result); } catch { finish(Error('upgrade_rpc_invalid')); }
    });
  });
}
const ReleaseManifest = z.object({ schema_version: z.literal(1), target: UpgradeTargetSchema,
  files: z.array(z.object({ path: z.string(), mode: z.number(), sha256: z.string().regex(/^[a-f0-9]{64}$/) }).strict()).min(1).max(20000) }).strict();
export function verifyRelease(root: string, digest: string): z.infer<typeof ReleaseManifest> {
  const release = join(root, 'releases', digest); privateDirectory(release);
  const manifest = ReleaseManifest.parse(JSON.parse(readPrivate(join(release, '.osstack-release.json'), 8 * 1024 * 1024).toString()));
  if (manifest.target.build_digest !== digest) throw Error('upgrade_release_mismatch');
  const inventory: string[] = [];
  const walk = (directory: string, prefix = ''): void => { for (const name of readdirSync(directory)) { const path = join(directory,name); const relative = prefix + name; const info = lstatSync(path); if (info.isDirectory() && !info.isSymbolicLink()) walk(path,relative+'/'); else inventory.push(relative); if (inventory.length > 20001) throw Error('upgrade_release_limit'); } };
  walk(release);
  if (upgradeCanonical(inventory.sort()) !== upgradeCanonical([...manifest.files.map(f=>f.path),'.osstack-release.json'].sort())
    || sha256(upgradeCanonical([...manifest.files].sort((a,b)=>a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) !== digest) throw Error('upgrade_release_inventory');
  for (const file of manifest.files) {
    if (!file.path || file.path.split('/').some(p => !p || p === '.' || p === '..') || file.path.startsWith('/')) throw Error('upgrade_release_path');
    const path = join(release, file.path); const info = lstatSync(path);
    if (realpathSync(path) !== path || !info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== file.mode || process.getuid && info.uid !== process.getuid()
      || sha256(readFileSync(path)) !== file.sha256) throw Error('upgrade_release_changed');
  }
  return manifest;
}
export function managedPlist(config: ManagedInstallation, consumer: ManagedInstallation['consumers'][number]): string {
  const xml = (s: string) => s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&apos;');
  return `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${xml(consumer.label)}</string><key>ProgramArguments</key><array><string>${xml(config.node)}</string><string>${xml(join(config.root,'current',config.entry))}</string><string>serve</string></array><key>EnvironmentVariables</key><dict><key>OSSTACK_HOME</key><string>${xml(consumer.home)}</string><key>OSSTACK_SOCKET</key><string>${xml(consumer.socket)}</string><key>OSSTACK_MANAGED_INSTALLATION</key><string>${xml(config.root)}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><false/></dict></plist>`;
}
/** Called before opening a managed daemon's DB. Managed releases cannot serve unregistered homes. */
export function managedStartupIdentity(home: string, entry: string | undefined): { deployment_kind: 'npm'; build_digest: string; build_evidence: 'host_manifest'; version: string; protocol_version: number; database_schema: number } | null {
  const markerPath=join(home,'managed-consumer.json');
  const marker=existsSync(markerPath)?z.object({schema_version:z.literal(1),root:z.string(),home_id:z.string()}).strict().parse(JSON.parse(readPrivate(markerPath,8192).toString())):null;
  if (!entry) { if(marker)throw Error('upgrade_managed_entry_required');return null; } let probe = dirname(realpathSync(entry)); let release: string | undefined;
  for (let depth = 0; depth < 16; depth++) { if (existsSync(join(probe, '.osstack-release.json'))) { release = probe; break; } const parent = dirname(probe); if (parent === probe) break; probe = parent; }
  if (!release) { if (marker || process.env['OSSTACK_MANAGED_INSTALLATION']) throw Error('upgrade_unmanaged_entry'); return null; }
  const root = dirname(dirname(release)); if(marker && marker.root!==root)throw Error('upgrade_managed_entry_required'); if (dirname(release) !== join(root,'releases')) throw Error('upgrade_release_location');
  const raw = readPrivate(join(root,'installation.json')); const config = JSON.parse(raw.toString()) as ManagedInstallation;
  // Dynamic import is not available before startup; caller only uses validated factory below.
  return managedIdentityForConfig(config, root, home, entry);
}
function managedIdentityForConfig(raw: unknown, root: string, home: string, entry: string) {
  const config = managedInstallationParser(raw);
  if (realpathSync(process.execPath) !== config.node || sha256(readFileSync(config.node)) !== config.node_sha256) throw Error('upgrade_node_changed'); if (config.root !== root || realpathSync(join(root,'current',config.entry)) !== realpathSync(entry)) throw Error('upgrade_wrong_active_release');
  const consumer = config.consumers.find(c => c.home === home); if (!consumer || dirname(consumer.socket) !== home || process.env['OSSTACK_SOCKET'] !== consumer.socket) throw Error('upgrade_unregistered_consumer');
  const marker=JSON.parse(readPrivate(join(home,'managed-consumer.json'),8192).toString());if(marker.root!==root||marker.home_id!==consumer.home_id||marker.schema_version!==1)throw Error('upgrade_consumer_marker_changed');
  if (process.env['OSSTACK_MANAGED_INSTALLATION'] !== root) throw Error('upgrade_managed_environment_missing');
  privateDirectory(home); const registry = JSON.parse(readPrivate(join(root,'consumers',`${consumer.home_id}.json`)).toString());
  if (upgradeCanonical(registry) !== upgradeCanonical(consumer)) throw Error('upgrade_consumer_changed');
  const release = realpathSync(join(root,'current')); if(dirname(release)!==join(root,'releases'))throw Error('upgrade_release_location'); const digest = release.split('/').at(-1)!; const manifest = verifyRelease(root,digest);
  const operation = join(root,'upgrade-operation.json');
  if (existsSync(operation)) {
    const started = JSON.parse(readPrivate(operation).toString()) as { plan_digest?: unknown };
    const permit = JSON.parse(readPrivate(join(root,'restart-permit.json')).toString()) as { plan_digest?: unknown; build_digest?: unknown };
    if (permit.plan_digest !== started.plan_digest || permit.build_digest !== digest) throw Error('upgrade_start_blocked');
  }
  return { deployment_kind: 'npm' as const, build_digest: digest, build_evidence: 'host_manifest' as const,
    version: manifest.target.version, protocol_version: manifest.target.protocol_version, database_schema: manifest.target.database_schema };
}
import { ManagedInstallationSchema } from './upgrade-native-files.js';
const managedInstallationParser = (value: unknown) => ManagedInstallationSchema.parse(value);
/** Metadata is checked against the running code and opened DB, never used to override their version/schema. */
export function verifyManagedRuntime(expected: NonNullable<ReturnType<typeof managedStartupIdentity>>, actual: {version:string;protocol_version:number;database_schema:number}) {
  if (expected.version !== actual.version || expected.protocol_version !== actual.protocol_version || expected.database_schema !== actual.database_schema) throw Error('upgrade_running_build_mismatch');
  return {deployment_kind:expected.deployment_kind,build_digest:expected.build_digest,build_evidence:expected.build_evidence};
}

export function assertManagedHomeEntry(home:string,entry:string|undefined):void { managedStartupIdentity(home,entry); }
