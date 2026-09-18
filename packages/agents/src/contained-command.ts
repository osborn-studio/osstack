import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { ContainedDocker, dockerLogs } from './contained-docker.js';

const sha = (v: string) => createHash('sha256').update(v).digest('hex');
const id = z.string().regex(/^[a-f0-9]{64}$/);
const launchSchema = z.object({ version: z.literal(1), invocationId: z.string(), specDigest: id,
  daemonId: z.string(), containerId: id, nonce: z.string().uuid() }).strict();
type Launch = z.infer<typeof launchSchema>;
const receiptSchema = z.object({ version: z.literal(1), kind: z.literal('docker_removed'), launch: launchSchema,
  confirmedAt: z.number().int().positive() }).strict();
export type ContainedStopReceipt = z.infer<typeof receiptSchema>;
const isolationSchema = z.object({ version: z.literal(1), kind: z.literal('docker_isolated'), launch: launchSchema,
  policyDigest: id, verifiedAt: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) }).strict();
export interface ContainedCommandResult { exitCode: number; output: string; cancelled: boolean; evidence: string; stopReceipt: ContainedStopReceipt }
export interface ContainedCommandOptions {
  socketPath: string;
  daemonId: string;
  journalRoot: string;
  imageId: string;
  command: string;
  /** Host-selected immutable image directory; defaults preserve legacy /tmp behavior. */
  workingDirectory?: string;
  /** Digest of the host's exact scope/run/generation/action binding, not worker input. */
  bindingRef: string;
  /** Optional canonical host identity, durably published before any Docker create. */
  bindingData?: string;
  authorize: (operation: 'start' | 'stop' | 'read') => void;
  timeoutMs?: number;
}
function durable(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify(value)); fsyncSync(fd); } finally { closeSync(fd); }
  // Atomic no-replace publication; an incomplete temporary is never a receipt.
  try { linkSync(temporary, path); sync(dirname(path)); } finally { unlinkSync(temporary); }
}
function sync(path: string): void { const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } }
function read(path: string): unknown {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 65536) throw Error('CONTAINED_JOURNAL_INVALID');
    const bytes = Buffer.alloc(65537); let offset = 0;
    while (offset < bytes.length) { const n = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!n) break; offset += n; }
    if (offset > 65536) throw Error('CONTAINED_JOURNAL_INVALID');
    return JSON.parse(bytes.subarray(0, offset).toString('utf8')) as unknown;
  } finally { closeSync(fd); }
}

/** Opt-in contained local commands. Trust the daemon/admin and host-owned journal;
 * containers cannot access either. No restart, replay, host bind mounts or G15 authority. */
export class ContainedCommandExecutor {
  private readonly options: Readonly<ContainedCommandOptions>;
  private readonly api: ContainedDocker;
  private readonly specDigest: string;
  constructor(options: ContainedCommandOptions) {
    if (![options.socketPath, options.journalRoot].every(p => isAbsolute(p) && !p.includes('\0'))
      || !/^sha256:[a-f0-9]{64}$/.test(options.imageId) || !/^[a-f0-9]{64}$/.test(options.bindingRef)
      || (options.workingDirectory !== undefined && !/^\/osstack-candidate-[a-f0-9-]{36}$/.test(options.workingDirectory))
      || (options.bindingData !== undefined && (Buffer.byteLength(options.bindingData) > 32768 || sha(options.bindingData) !== options.bindingRef))
      || !options.daemonId || !options.command || options.command.length > 64000 || typeof options.authorize !== 'function'
      || (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 120000))) throw Error('CONTAINED_CONFIG_INVALID');
    this.options = Object.freeze({ ...options }); this.api = new ContainedDocker(options.socketPath);
    this.specDigest = sha(JSON.stringify({ image: options.imageId, command: options.command, binding: options.bindingRef, policy: 1, ...(options.workingDirectory ? { workingDirectory: options.workingDirectory } : {}) }));
  }
  private authorize(operation: 'start' | 'stop' | 'read'): void {
    const value: unknown = this.options.authorize(operation);
    if (value !== undefined) { void Promise.resolve(value).catch(() => {}); throw Error('CONTAINED_AUTHORITY_MUST_BE_SYNC'); }
  }
  private directory(invocationId: string): string {
    if (!/^[a-zA-Z0-9_.:-]{1,256}$/.test(invocationId)) throw Error('CONTAINED_INVOCATION_INVALID');
    if (realpathSync(this.options.journalRoot) !== this.options.journalRoot) throw Error('CONTAINED_ROOT_CHANGED');
    const path = join(this.options.journalRoot, sha(invocationId));
    return path;
  }
  private launch(invocationId: string): Launch {
    const dir = this.directory(invocationId);
    if (!lstatSync(dir).isDirectory() || realpathSync(dir) !== dir) throw Error('CONTAINED_JOURNAL_INVALID');
    const value = launchSchema.parse(read(join(dir, 'launch.json')));
    if (value.invocationId !== invocationId || value.specDigest !== this.specDigest || value.daemonId !== this.options.daemonId) throw Error('CONTAINED_BINDING_MISMATCH');
    return value;
  }
  async probe(): Promise<void> { this.authorize('read'); await this.daemon(); this.authorize('read'); }
  private async daemon(): Promise<void> {
    const r = await this.api.call('GET', '/info');
    if (r.status !== 200) throw Error('CONTAINED_DAEMON_MISMATCH');
    const info = JSON.parse(r.bytes.toString()) as { ID?: string; OSType?: string };
    if (info.ID !== this.options.daemonId || info.OSType !== 'linux') throw Error('CONTAINED_DAEMON_MISMATCH');
  }
  private config(nonce: string) {
    return { Image: this.options.imageId, Entrypoint: ['/bin/sh', '-c'], Cmd: [this.options.command], User: '65534:65534',
      WorkingDir: this.options.workingDirectory ?? '/tmp', NetworkDisabled: true, Tty: false, OpenStdin: false,
      Labels: { 'osstack.contained.spec': this.specDigest, 'osstack.contained.nonce': nonce },
      HostConfig: { NetworkMode: 'none', PidMode: '', IpcMode: 'private', Privileged: false, ReadonlyRootfs: true,
        CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'], RestartPolicy: { Name: 'no' }, AutoRemove: false,
        PidsLimit: 64, Memory: 134217728, NanoCpus: 1000000000, Tmpfs: { '/tmp': 'rw,noexec,nosuid,nodev,size=16m,mode=1777' },
        LogConfig: { Type: 'json-file', Config: { 'max-size': '1m', 'max-file': '1' } } } };
  }
  private async inspect(launch: Launch) {
    const r = await this.api.call('GET', `/containers/${launch.containerId}/json`);
    if (r.status !== 200) throw Error('CONTAINED_SCOPE_UNCONFIRMED');
    const v = z.object({ Id: id, Image: z.string(), Config: z.object({ Entrypoint: z.array(z.string()), Cmd: z.array(z.string()), User: z.string(),
      Labels: z.record(z.string(), z.string()), Tty: z.boolean(), OpenStdin: z.boolean(), WorkingDir: z.string(), NetworkDisabled: z.boolean() }),
      HostConfig: z.object({ NetworkMode: z.string(), PidMode: z.string(), IpcMode: z.string(), Privileged: z.boolean(), ReadonlyRootfs: z.boolean(),
        CapAdd: z.array(z.string()).nullable(), CapDrop: z.array(z.string()), SecurityOpt: z.array(z.string()), RestartPolicy: z.object({ Name: z.string() }),
        AutoRemove: z.boolean(), Tmpfs: z.record(z.string(), z.string()), PidsLimit: z.number(), Memory: z.number(), NanoCpus: z.number(),
        LogConfig: z.object({ Type: z.string(), Config: z.record(z.string(), z.string()) }) }), Mounts: z.array(z.unknown()),
      State: z.object({ Status: z.string(), Running: z.boolean(), ExitCode: z.number().int() }) }).parse(JSON.parse(r.bytes.toString()));
    const expected = this.config(launch.nonce); const h = v.HostConfig;
    if (v.Id !== launch.containerId || v.Image !== this.options.imageId || v.Config.User !== expected.User
      || JSON.stringify(v.Config.Entrypoint) !== JSON.stringify(expected.Entrypoint) || JSON.stringify(v.Config.Cmd) !== JSON.stringify(expected.Cmd)
      || v.Config.Labels['osstack.contained.spec'] !== this.specDigest || v.Config.Labels['osstack.contained.nonce'] !== launch.nonce
      || v.Config.Tty || v.Config.OpenStdin || v.Config.WorkingDir !== expected.WorkingDir || !v.Config.NetworkDisabled || v.Mounts.length
      || h.NetworkMode !== 'none' || h.PidMode !== '' || h.IpcMode !== 'private' || h.Privileged || !h.ReadonlyRootfs
      || (h.CapAdd?.length ?? 0) !== 0 || JSON.stringify(h.CapDrop) !== '["ALL"]' || !h.SecurityOpt.includes('no-new-privileges')
      || h.RestartPolicy.Name !== 'no' || h.AutoRemove || JSON.stringify(h.Tmpfs) !== JSON.stringify(expected.HostConfig.Tmpfs)
      || h.PidsLimit !== 64 || h.Memory !== 134217728 || h.NanoCpus !== 1000000000 || h.LogConfig.Type !== 'json-file'
      || h.LogConfig.Config['max-size'] !== '1m' || h.LogConfig.Config['max-file'] !== '1' || Object.keys(h.LogConfig.Config).length !== 2) throw Error('CONTAINED_SCOPE_MISMATCH');
    return v.State;
  }
  private isolation(launch: Launch) {
    const receipt = isolationSchema.parse(read(join(this.directory(launch.invocationId), 'isolated.json')));
    if (JSON.stringify(receipt.launch) !== JSON.stringify(launch) || receipt.policyDigest !== sha(JSON.stringify(this.config(launch.nonce)))) throw Error('CONTAINED_ISOLATION_MISMATCH');
    return receipt;
  }
  /** Called only after actual inspect validates the exact immutable container policy. */
  private recordIsolation(launch: Launch): void {
    try { this.isolation(launch); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      durable(join(this.directory(launch.invocationId), 'isolated.json'), { version: 1, kind: 'docker_isolated', launch,
        policyDigest: sha(JSON.stringify(this.config(launch.nonce))), verifiedAt: Date.now() });
    }
  }
  /** Captures two independent receipts for ONE contained invocation. The closure
   * rechecks current authority and immutable journals synchronously, including in
   * a host's final DB transaction. No network in recheck: acknowledged deletion of
   * this exact Docker ID is irreversible under the trusted daemon/admin boundary.
   * Does not prove other producers stopped or authorize graph-wide recovery. */
  async captureQuiescence(invocationId: string) {
    const observe = () => {
      const launch = this.launch(invocationId); const isolation = this.isolation(launch);
      const stopped = receiptSchema.parse(read(join(this.directory(invocationId), 'stopped.json')));
      if (JSON.stringify(stopped.launch) !== JSON.stringify(launch) || isolation.verifiedAt > stopped.confirmedAt
        || stopped.confirmedAt > Date.now()) throw Error('CONTAINED_RECEIPT_MISMATCH');
      return { executorEvidenceRef: `docker-removed:${sha(JSON.stringify(stopped))}`, isolationEvidenceRef: `docker-isolated:${sha(JSON.stringify(isolation))}` };
    };
    this.authorize('read'); const initial = observe();
    const live = await this.confirmStopped(invocationId);
    if (!live.stopped || live.evidence !== initial.executorEvidenceRef) throw Error('CONTAINED_STOP_UNCONFIRMED');
    const recheck = (): void => {
      this.authorize('read');
      if (JSON.stringify(observe()) !== JSON.stringify(initial)) throw Error('CONTAINED_PROOF_CHANGED');
    };
    recheck();
    return Object.freeze({ ...initial, scope: 'contained-invocation' as const, recheck });
  }
  /** Never interprets missing containers, expired leases or old PIDs as proof. */
  async confirmStopped(invocationId: string): Promise<{ stopped: false } | { stopped: true; evidence: string }> {
    try {
      this.authorize('read'); const launch = this.launch(invocationId);
      const receipt = receiptSchema.parse(read(join(this.directory(invocationId), 'stopped.json')));
      if (JSON.stringify(receipt.launch) !== JSON.stringify(launch)) throw Error('CONTAINED_RECEIPT_MISMATCH');
      await this.daemon();
      const r = await this.api.call('GET', `/containers/${launch.containerId}/json`);
      if (r.status !== 404) throw Error('CONTAINED_NOT_REMOVED');
      await this.daemon(); this.authorize('read'); sync(this.directory(invocationId));
      return { stopped: true, evidence: `docker-removed:${sha(JSON.stringify(receipt))}` };
    } catch { return { stopped: false }; }
  }
  /** Explicit administrative stop, safe in a fresh host. A lost DELETE ACK stays unknown. */
  async stop(invocationId: string): Promise<{ stopped: true; evidence: string }> {
    this.authorize('stop'); const launch = this.launch(invocationId);
    const prior = await this.confirmStopped(invocationId); if (prior.stopped) return prior;
    await this.daemon(); await this.inspect(launch); this.authorize('stop'); this.recordIsolation(launch);
    const result = await this.api.call('DELETE', `/containers/${launch.containerId}?force=true&v=true`);
    if (result.status !== 204) throw Error('CONTAINED_DELETE_UNCONFIRMED');
    await this.daemon();
    if ((await this.api.call('GET', `/containers/${launch.containerId}/json`)).status !== 404) throw Error('CONTAINED_NOT_REMOVED');
    const receipt: ContainedStopReceipt = { version: 1, kind: 'docker_removed', launch, confirmedAt: Date.now() };
    durable(join(this.directory(invocationId), 'stopped.json'), receipt); sync(this.directory(invocationId));
    const proof = await this.confirmStopped(invocationId); if (!proof.stopped) throw Error('CONTAINED_STOP_UNCONFIRMED'); return proof;
  }
  async execute(invocationId: string, signal: AbortSignal): Promise<ContainedCommandResult> {
    this.authorize('start'); if (signal.aborted) throw Error('CONTAINED_CANCELLED_BEFORE_CREATE');
    const dir = this.directory(invocationId); mkdirSync(dir, { mode: 0o700 }); sync(this.options.journalRoot);
    // Permanent exclusive consumption: an interrupted invocation is never auto-recreated.
    if (this.options.bindingData !== undefined) durable(join(dir, 'binding.json'), { version: 1, bindingRef: this.options.bindingRef, data: this.options.bindingData });
    const nonce = randomUUID(); await this.daemon(); this.authorize('start');
    if (signal.aborted) throw Error('CONTAINED_CANCELLED_BEFORE_CREATE');
    const created = await this.api.call('POST', '/containers/create', this.config(nonce));
    if (created.status !== 201) throw Error('CONTAINED_CREATE_UNCONFIRMED');
    const containerId = z.object({ Id: id }).parse(JSON.parse(created.bytes.toString())).Id;
    const launch: Launch = { version: 1, invocationId, specDigest: this.specDigest, daemonId: this.options.daemonId, containerId, nonce };
    durable(join(dir, 'launch.json'), launch); sync(dir);
    try {
      await this.daemon(); await this.inspect(launch); this.authorize('start'); this.recordIsolation(launch);
      if (signal.aborted) throw Error('CONTAINED_CANCELLED');
      if ((await this.api.call('POST', `/containers/${containerId}/start`)).status !== 204) throw Error('CONTAINED_START_UNCONFIRMED');
      const deadline = Date.now() + (this.options.timeoutMs ?? 120000);
      for (;;) {
        if (signal.aborted) throw Error('CONTAINED_CANCELLED');
        if (Date.now() >= deadline) throw Error('CONTAINED_TIMEOUT');
        await this.daemon(); const state = await this.inspect(launch); this.authorize('start');
        if (!state.Running && state.Status === 'exited') {
          const logs = await this.api.call('GET', `/containers/${containerId}/logs?stdout=true&stderr=true&tail=100`);
          if (logs.status !== 200) throw Error('CONTAINED_LOGS_UNAVAILABLE');
          const output = dockerLogs(logs.bytes); const proof = await this.stop(invocationId);
          return { exitCode: state.ExitCode, output, cancelled: false, evidence: proof.evidence, stopReceipt: receiptSchema.parse(read(join(dir, 'stopped.json'))) };
        }
        await delay(50);
      }
    } catch (error) {
      const proof = await this.stop(invocationId); // Failure to prove stop stays an error/unknown.
      if (!signal.aborted) throw error;
      return { exitCode: 1, output: '', cancelled: true, evidence: proof.evidence, stopReceipt: receiptSchema.parse(read(join(dir, 'stopped.json'))) };
    }
  }
}
