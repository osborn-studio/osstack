import { mkdir, readFile, writeFile, lstat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createScratchDir } from '@osstack/core';
import { afterEach, expect, it } from 'vitest';
import { readVerificationDirectory, readVerificationFile, VerificationInventoryBudget, verificationInventoryLimits } from './graph-verification-inventory.js';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
it('bounds aggregate bytes across opened files and refuses a stale inode size', async () => {
  const root = await createScratchDir('tests', 'verification-inventory'); roots.push(root);
  const a = join(root, 'a'); const b = join(root, 'b'); await writeFile(a, '12345'); await writeFile(b, '6789');
  const budget = new VerificationInventoryBudget(8, 10);
  expect(readVerificationFile(a, await lstat(a), budget)).toEqual(await readFile(a));
  const bStat = await lstat(b);
  expect(() => readVerificationFile(b, bStat, budget)).toThrow('budget exceeded');
  await writeFile(b, 'grown');
  expect(() => readVerificationFile(b, bStat, new VerificationInventoryBudget())).toThrow('changed during observation');
});
it('bounds directory enumeration before allocating a complete oversized listing', async () => {
  const root = await createScratchDir('tests', 'verification-entries'); roots.push(root);
  for (const name of ['a', 'b', 'c']) await mkdir(join(root, name));
  expect(() => readVerificationDirectory(root, 2)).toThrow('budget exceeded');
  expect(readVerificationDirectory(root, 3)).toEqual(['a', 'b', 'c']);
});

it('rejects a real directory at the repository 20001-entry boundary', async () => {
  const root = await createScratchDir('tests', 'verification-repository-limit'); roots.push(root);
  const limit = verificationInventoryLimits.repositoryEntries;
  for (let start = 0; start <= limit; start += 100) {
    await Promise.all(Array.from({ length: Math.min(100, limit + 1 - start) }, (_, index) => mkdir(join(root, `entry-${start + index}`))));
  }
  expect(() => readVerificationDirectory(root, limit)).toThrow('verification inventory budget exceeded');
}, 30000);
