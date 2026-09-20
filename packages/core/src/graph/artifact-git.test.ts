import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { artifactBlobs, gitText, initArtifactRepo } from './artifact-git.js';
it('allows raw bytes exactly at the cap plus framing, including repeated, empty and binary objects', async () => {
  const repo = await mkdtemp(join(tmpdir(), 'artifact-batch-'));
  try {
    await initArtifactRepo(repo);
    const bytes = Buffer.from([0, 10, 255, 13, 0, 10, 255, 0]);
    const oid = await gitText(repo, ['hash-object', '-w', '--stdin'], bytes);
    const empty = await gitText(repo, ['hash-object', '-w', '--stdin'], Buffer.alloc(0));
    expect(await artifactBlobs(repo, [oid, empty, oid], 16)).toEqual([bytes, Buffer.alloc(0), bytes]);
    await expect(artifactBlobs(repo, [oid, oid], 15)).rejects.toThrow('artifact blob limit');
    await expect(artifactBlobs(repo, ['a'.repeat(40)], 16)).rejects.toThrow('identity mismatch');
  } finally { await rm(repo, { recursive: true, force: true }); }
});
