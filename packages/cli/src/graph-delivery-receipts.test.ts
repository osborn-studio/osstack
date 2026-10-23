import { mkdtemp, realpath, readFile, writeFile, readdir, rm, symlink, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { computeGraphEffectKey } from '@osstack/protocol';
import { loadDeliveryReceipt, publishDeliveryReceipt, type DeliveryReceiptBinding } from './graph-delivery-receipts.js';
const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'g21-receipt-'))); roots.push(root);
  const effect = { schemaVersion: 1 as const, scope: { schemaVersion: 1 as const, tenantId: 't', principalId: 'p', workspaceId: 'w' },
    graphRunId: 'run', specHash: 'a'.repeat(64), epoch: 0, nodeId: 'e0.implement', effectSlot: 'main', logicalAttempt: 1 };
  const binding: DeliveryReceiptBinding = { effect, effectKey: computeGraphEffectKey(effect), generation: 1, owner: 'host', workspacePath: root };
  return { root, binding };
}
it('publishes one digest receipt and verifies the exact stopped invocation binding', async () => {
  const f = await fixture(); const evidence = { status: 'completed' as const, stopped: true as const, workspace: { path: f.root } };
  const ref = await publishDeliveryReceipt(f.root, f.binding, evidence, () => {});
  expect(await publishDeliveryReceipt(f.root, f.binding, evidence, () => {})).toBe(ref);
  expect(await loadDeliveryReceipt(f.root, ref, f.binding)).toEqual(evidence);
  expect(await readdir(join(f.root, 'delivery-receipts'))).toEqual([`${ref.slice('graph-delivery:'.length)}.json`]);
  for (const changed of [{ ...f.binding, generation: 2 }, { ...f.binding, owner: 'replacement' }, { ...f.binding, workspacePath: '/' }]) {
    await expect(loadDeliveryReceipt(f.root, ref, changed)).rejects.toThrow(/BINDING/);
  }
});
it.each(['bytes', 'symlink'] as const)('rejects a receipt changed through %s', async kind => {
  const f = await fixture(); const ref = await publishDeliveryReceipt(f.root, f.binding, { status: 'completed', stopped: true }, () => {});
  const path = join(f.root, 'delivery-receipts', `${ref.slice('graph-delivery:'.length)}.json`);
  if (kind === 'bytes') await writeFile(path, (await readFile(path, 'utf8')).replace('completed', 'failed'));
  else { const other = join(f.root, 'other'); await writeFile(other, await readFile(path)); await unlink(path); await symlink(other, path); }
  await expect(loadDeliveryReceipt(f.root, ref, f.binding)).rejects.toThrow();
});
it('refuses oversized or unauthorized evidence before publication', async () => {
  const f = await fixture();
  await expect(publishDeliveryReceipt(f.root, f.binding, { status: 'completed', workspace: 'x'.repeat(128 * 1024) }, () => {})).rejects.toThrow();
  await expect(publishDeliveryReceipt(f.root, f.binding, { status: 'completed' }, () => { throw Error('revoked'); })).rejects.toThrow('revoked');
  await expect(publishDeliveryReceipt(f.root, f.binding, { status: 'completed' }, async () => {})).rejects.toThrow(/AUTHORITY/);
  expect(await readdir(f.root)).toEqual([]);
});
