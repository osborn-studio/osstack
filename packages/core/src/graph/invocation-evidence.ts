import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { z } from 'zod';
import { GraphJsonValue, GraphScope, workerCanonical } from '@osstack/protocol';
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const bindingSchema = z.object({ schemaVersion: z.literal(1), scope: GraphScope, runId: z.string().regex(/^[A-Za-z0-9_-]{1,256}$/),
  effectKey: digest, generation: z.number().int().positive().safe(), requestDigest: digest, kind: z.enum(['request', 'response', 'terminal', 'apply_journal', 'apply_complete', 'apply_quarantine']) }).strict();
export type GraphInvocationEvidenceBinding = z.infer<typeof bindingSchema>;
const MAX_BYTES = 524_288;
const MAX_ENVELOPE_BYTES = 710_000;
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const parse = (value: unknown) => bindingSchema.parse(GraphJsonValue.parse(value));
const keyOf = (binding: GraphInvocationEvidenceBinding) => sha(`osstack.invocation-evidence.binding.v1\n${workerCanonical(binding)}`);
const hashOf = (bytes: Buffer) => sha(Buffer.concat([Buffer.from('osstack.invocation-evidence.envelope.v1\n'), bytes]));
const reference = (key: string, bytes: Buffer) => `graph-invocation-evidence:${key}:${hashOf(bytes)}`;
function syncDir(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
/** Host-only private immutable evidence. Root and its parent must be owned and
 * controlled by the host, outside producer-accessible workspaces. This does not
 * sandbox a hostile same-UID process. Files/parent directory are synced before
 * return; unsupported sync fails closed. No automatic GC or stale-temp cleanup. */
export class GraphInvocationEvidenceStore {
  private readonly identity: { dev: number; ino: number };
  constructor(private readonly root: string) {
    if (!isAbsolute(root) || resolve(root) !== root) throw Error('INVOCATION_EVIDENCE_ROOT');
    // Existing canonical parent required; never recursively follow producer paths.
    if (realpathSync(dirname(root)) !== dirname(root)) throw Error('INVOCATION_EVIDENCE_ROOT');
    try { mkdirSync(root, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
    const info = lstatSync(root);
    if (!info.isDirectory() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o700 || (process.getuid && info.uid !== process.getuid())) throw Error('INVOCATION_EVIDENCE_ROOT');
    this.identity = { dev: info.dev, ino: info.ino };
    syncDir(root); syncDir(dirname(root));
  }
  private checkRoot(): void {
    const info = lstatSync(this.root);
    if (!info.isDirectory() || info.isSymbolicLink() || info.dev !== this.identity.dev || info.ino !== this.identity.ino || (info.mode & 0o777) !== 0o700 || (process.getuid && info.uid !== process.getuid())) throw Error('INVOCATION_EVIDENCE_ROOT');
  }
  private published(key: string): boolean {
    this.checkRoot();
    try { lstatSync(join(this.root, key)); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
  }
  private load(key: string): Buffer {
    this.checkRoot();
    const directory = join(this.root, key); const identity = lstatSync(directory);
    if (!identity.isDirectory() || identity.isSymbolicLink() || (identity.mode & 0o777) !== 0o700
      || (process.getuid && identity.uid !== process.getuid())) throw Error('INVOCATION_EVIDENCE_FILE');
    const fd = openSync(join(directory, 'evidence.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600 || info.size > MAX_ENVELOPE_BYTES
        || (process.getuid && info.uid !== process.getuid())) throw Error('INVOCATION_EVIDENCE_FILE');
      const buffer = Buffer.alloc(info.size + 1); let length = 0;
      while (length < buffer.length) { const n = readSync(fd, buffer, length, buffer.length - length, length); if (n === 0) break; length += n; }
      const bytes = buffer.subarray(0, length); const after = fstatSync(fd);
      if (bytes.length !== info.size || info.size !== after.size || info.mtimeMs !== after.mtimeMs || info.ctimeMs !== after.ctimeMs) throw Error('INVOCATION_EVIDENCE_CORRUPT');
      const directoryAfter = lstatSync(directory);
      if (directoryAfter.isSymbolicLink() || directoryAfter.ino !== identity.ino || directoryAfter.dev !== identity.dev) throw Error('INVOCATION_EVIDENCE_FILE');
      this.checkRoot(); return bytes;
    } finally { closeSync(fd); }
  }
  put(value: unknown, body: Uint8Array): string {
    const binding = parse(value);
    if (!(body instanceof Uint8Array) || body.byteLength > MAX_BYTES) throw Error('INVOCATION_EVIDENCE_LIMIT');
    const bytes = Buffer.from(workerCanonical({ schemaVersion: 1, binding, bodyBase64: Buffer.from(body).toString('base64') }));
    if (bytes.length > MAX_ENVELOPE_BYTES) throw Error('INVOCATION_EVIDENCE_LIMIT');
    const key = keyOf(binding); this.checkRoot();
    if (this.published(key)) {
      if (!this.load(key).equals(bytes)) throw Error('INVOCATION_EVIDENCE_CONFLICT');
      syncDir(this.root); return reference(key, bytes);
    }
    const target = join(this.root, key); const staging = join(this.root, `.${randomUUID()}.tmp`);
    mkdirSync(staging, { mode: 0o700 });
    try {
      const fd = openSync(join(staging, 'evidence.json'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
      syncDir(staging); this.checkRoot();
      // A published directory is nonempty: POSIX rename cannot replace it.
      // Readers see either no target or a fully written private directory.
      try { renameSync(staging, target); }
      catch (error) {
        if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        if (!this.load(key).equals(bytes)) throw Error('INVOCATION_EVIDENCE_CONFLICT');
      }
    } finally { rmSync(staging, { recursive: true, force: true }); }
    syncDir(this.root); this.checkRoot();
    if (!this.load(key).equals(bytes)) throw Error('INVOCATION_EVIDENCE_CORRUPT');
    return reference(key, bytes);
  }
  /** Find retained evidence after a lost publication ACK. This only reads; it
   * never permits dispatch. Consumers must still verify request/response digests
   * against the authoritative ledger and authenticate host stop evidence. */
  lookup(value: unknown): string | null {
    const binding = parse(value); const key = keyOf(binding); this.checkRoot();
    if (!this.published(key)) return null;
    const bytes = this.load(key); const ref = reference(key, bytes); this.read(ref, binding); return ref;
  }
  read(ref: string, value: unknown): Buffer {
    const binding = parse(value); const key = keyOf(binding);
    if (typeof ref !== 'string' || !new RegExp(`^graph-invocation-evidence:${key}:[a-f0-9]{64}$`).test(ref)) throw Error('INVOCATION_EVIDENCE_BINDING');
    const bytes = this.load(key);
    if (reference(key, bytes) !== ref) throw Error('INVOCATION_EVIDENCE_CORRUPT');
    try {
      const envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as { schemaVersion: unknown; binding: unknown; bodyBase64: unknown };
      if (envelope.schemaVersion !== 1 || workerCanonical(parse(envelope.binding)) !== workerCanonical(binding) || typeof envelope.bodyBase64 !== 'string') throw Error();
      const body = Buffer.from(envelope.bodyBase64, 'base64');
      if (body.length > MAX_BYTES || body.toString('base64') !== envelope.bodyBase64
        || !Buffer.from(workerCanonical({ schemaVersion: 1, binding, bodyBase64: envelope.bodyBase64 })).equals(bytes)) throw Error();
      return body;
    } catch { throw Error('INVOCATION_EVIDENCE_CORRUPT'); }
  }
}
