import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { link, mkdir, open, realpath, unlink, type FileHandle } from 'node:fs/promises';
import { GraphEffectIdentity, GraphJsonValue, computeGraphEffectKey, freezeWorkerData, workerCanonical } from '@osstack/protocol';
import type { GraphActionEvidence } from './graph-action-broker.js';

export interface DeliveryReceiptBinding {
  effect: GraphEffectIdentity; effectKey: string; generation: number; owner: string; workspacePath: string;
}
const limit = 128 * 1024;
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
function binding(value: DeliveryReceiptBinding): DeliveryReceiptBinding {
  const data = GraphJsonValue.parse(value) as unknown as DeliveryReceiptBinding;
  const effect = GraphEffectIdentity.parse(data.effect);
  if (Object.keys(data).sort().join() !== 'effect,effectKey,generation,owner,workspacePath'
    || data.effectKey !== computeGraphEffectKey(effect) || !Number.isSafeInteger(data.generation) || data.generation < 1
    || typeof data.owner !== 'string' || !data.owner.trim() || data.owner.length > 256
    || typeof data.workspacePath !== 'string' || !isAbsolute(data.workspacePath) || data.workspacePath.includes('\0')) throw Error('DELIVERY_RECEIPT_BINDING');
  return freezeWorkerData({ ...data, effect });
}
function evidence(value: unknown): GraphActionEvidence {
  const data = GraphJsonValue.parse(value);
  if (!data || typeof data !== 'object' || Array.isArray(data) || !['completed', 'failed'].includes(String(data.status))
    || (data.stopped !== undefined && data.stopped !== true)) throw Error('DELIVERY_RECEIPT_EVIDENCE');
  return freezeWorkerData(data as unknown as GraphActionEvidence);
}
async function directory(root: string, create: boolean): Promise<string> {
  if (!isAbsolute(root) || await realpath(root) !== root) throw Error('DELIVERY_RECEIPT_ROOT');
  const dir = join(root, 'delivery-receipts');
  if (create) await mkdir(dir, { recursive: true, mode: 0o700 });
  if (await realpath(dir) !== dir) throw Error('DELIVERY_RECEIPT_ROOT');
  return dir;
}
async function syncDirectory(path: string): Promise<void> {
  const file = await open(path, 'r'); try { await file.sync(); } finally { await file.close(); }
}
async function readBounded(file: FileHandle): Promise<Buffer> {
  const stat = await file.stat(); if (!stat.isFile() || stat.size > limit) throw Error('DELIVERY_RECEIPT_LIMIT');
  const buffer = Buffer.alloc(limit + 1); let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await file.read(buffer, offset, buffer.length - offset, offset);
    if (!bytesRead) break; offset += bytesRead;
  }
  if (offset > limit) throw Error('DELIVERY_RECEIPT_LIMIT');
  return buffer.subarray(0, offset);
}
/** Host observations only. The caller supplies the actual RUNNING ledger identity.
 * Successful publication is durable before the broker may confirm the effect. */
export async function publishDeliveryReceipt(root: string, identity: DeliveryReceiptBinding, value: GraphActionEvidence, authorize: () => void): Promise<string> {
  const check = () => { const result: unknown = authorize(); if (result !== undefined) { void Promise.resolve(result).catch(() => {}); throw Error('DELIVERY_RECEIPT_AUTHORITY'); } };
  check();
  // Executor optional properties may be undefined. Persist the JSON representation,
  // then validate it before hashing, so reads verify exactly the bytes published.
  const body = { schemaVersion: 1, binding: binding(identity), evidence: evidence(JSON.parse(JSON.stringify(value))) };
  const bytes = Buffer.from(workerCanonical(body)); if (bytes.length > limit) throw Error('DELIVERY_RECEIPT_LIMIT');
  const checked = async <T>(fn: () => Promise<T>): Promise<T> => { check(); const result = await fn(); check(); return result; };
  const dir = await checked(() => directory(root, true)); const digest = sha(bytes);
  const temporary = join(dir, `.${randomUUID()}`); const final = join(dir, `${digest}.json`);
  check(); const file = await open(temporary, 'wx', 0o600);
  try { check(); await checked(() => file.writeFile(bytes)); await checked(() => file.sync()); } finally { await file.close(); }
  try {
    await checked(async () => {
      try { await link(temporary, final); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = await open(final, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { if (sha(await readBounded(existing)) !== digest) throw Error('DELIVERY_RECEIPT_DIGEST'); }
        finally { await existing.close(); }
      }
    });
    await checked(() => syncDirectory(dir)); await checked(() => syncDirectory(root)); await checked(() => syncDirectory(dirname(root)));
  } finally { await unlink(temporary); }
  check(); return `graph-delivery:${digest}`;
}

export async function loadDeliveryReceipt(root: string, ref: string, expected: DeliveryReceiptBinding): Promise<GraphActionEvidence> {
  const target = binding(expected);
  if (!/^graph-delivery:[a-f0-9]{64}$/.test(ref)) throw Error('DELIVERY_RECEIPT_REF');
  const digest = ref.slice('graph-delivery:'.length); const dir = await directory(root, false);
  const file = await open(join(dir, `${digest}.json`), constants.O_RDONLY | constants.O_NOFOLLOW);
  let bytes: Buffer;
  try { bytes = await readBounded(file); }
  finally { await file.close(); }
  if (bytes.length > limit || sha(bytes) !== digest) throw Error('DELIVERY_RECEIPT_DIGEST');
  const body = GraphJsonValue.parse(JSON.parse(bytes.toString('utf8')));
  if (!body || typeof body !== 'object' || Array.isArray(body) || body.schemaVersion !== 1
    || Object.keys(body).sort().join() !== 'binding,evidence,schemaVersion'
    || workerCanonical(body.binding) !== workerCanonical(target)) throw Error('DELIVERY_RECEIPT_BINDING');
  return evidence(body.evidence);
}
