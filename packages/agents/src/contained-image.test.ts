import { createServer } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { prepareContainedImage, snapshotContainedCandidate } from './contained-image.js';
const baseImageId = 'sha256:' + 'a'.repeat(64); const imageId = 'sha256:' + 'b'.repeat(64);
const files = [{ path: 'test.sh', mode: '100755' as const, bytes: Buffer.from('exit 0') }];
it.each(['../bad', '/absolute', 'a//b', '.git/config', 'a/../b', 'a\\b', 'a\nb'])('rejects unsafe candidate path %j', path => {
  expect(() => snapshotContainedCandidate([{ ...files[0]!, path }])).toThrow();
});
it('snapshots bytes and rejects duplicate/file-parent conflicts and unsupported modes', () => {
  const local = [{ ...files[0]!, bytes: Buffer.from('ok') }]; const result = snapshotContainedCandidate(local); local[0]!.bytes.fill(0);
  expect(result.files[0]!.bytes.toString()).toBe('ok');
  expect(() => snapshotContainedCandidate([...files, ...files])).toThrow();
  expect(() => snapshotContainedCandidate(['a', 'a/b'].map(path => ({ ...files[0]!, path })))).toThrow();
  expect(() => snapshotContainedCandidate([{ ...files[0]!, mode: '120000' as '100644' }])).toThrow();
  expect(() => snapshotContainedCandidate([{ ...files[0]!, bytes: Buffer.alloc(32 * 1024 * 1024 + 1) }])).toThrow();
});
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); });
async function fixture(mode = 'normal') {
  const root = mkdtempSync(join(tmpdir(), 'image-api-')); const socketPath = join(root, 'docker.sock'); const calls: string[] = [];
  let archive = Buffer.alloc(0); let labels: Record<string, string>; let workingDirectory = ''; let allowed = true;
  const server = createServer(async (req, res) => {
    calls.push(req.url!); const url = new URL(req.url!, 'http://local');
    if (url.pathname.endsWith('/info')) { res.end(JSON.stringify({ ID: mode === 'daemon' ? 'wrong' : 'daemon', OSType: 'linux' })); return; }
    if (url.pathname.endsWith('/build')) {
      const chunks = []; for await (const chunk of req) chunks.push(chunk as Buffer); archive = Buffer.concat(chunks);
      expect(req.headers['content-type']).toBe('application/x-tar'); expect(url.searchParams.get('networkmode')).toBe('none'); expect(url.searchParams.get('pull')).toBe('false');
      labels = JSON.parse(url.searchParams.get('labels')!); workingDirectory = /WORKDIR (\/osstack-candidate-[a-z0-9-]+)/.exec(archive.toString())![1]!;
      if (mode === 'revoke') allowed = false;
      res.end(mode === 'build-error' ? '{"error":"failed"}\n' : mode === 'no-id' ? '{"stream":"ok"}\n' : JSON.stringify({ aux: { ID: imageId } }) + '\n'); return;
    }
    const base = url.pathname.includes(baseImageId);
    res.end(JSON.stringify({ Id: base ? baseImageId : imageId, Config: { OnBuild: mode === 'onbuild' ? ['RUN bad'] : null, Volumes: mode === 'volume' ? { '/candidate': {} } : null,
      WorkingDir: base ? '' : workingDirectory, Labels: base ? {} : mode === 'labels' ? {} : labels } }));
  });
  await new Promise<void>(r => server.listen(socketPath, r));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); rmSync(root, { force: true, recursive: true }); });
  return { options: { socketPath, daemonId: 'daemon', baseImageId, authorize: () => { if (!allowed) throw Error('REVOKED'); } }, calls, archive: () => archive };
}
it('builds only host instructions and copies candidate Dockerfile as inert data', async () => {
  const f = await fixture(); const receipt = await prepareContainedImage(f.options, [...files, { path: 'Dockerfile', mode: '100644', bytes: Buffer.from('RUN malicious') }]);
  expect(receipt.imageId).toBe(imageId); expect(receipt.contentDigest).toHaveLength(64); expect(receipt.archiveDigest).toHaveLength(64);
  expect(f.archive().subarray(512, 1024).toString().replace(/\0/g, '')).toBe(`FROM ${baseImageId}\nCOPY candidate/ ${receipt.workingDirectory}/\nWORKDIR ${receipt.workingDirectory}\n`);
  expect(f.archive().includes(Buffer.from('candidate/Dockerfile'))).toBe(true);
});
it.each(['daemon', 'onbuild', 'volume', 'build-error', 'no-id', 'labels', 'revoke'])('rejects %s without publishing an image receipt', async mode => {
  const f = await fixture(mode); await expect(prepareContainedImage(f.options, files)).rejects.toThrow();
  if (['daemon', 'onbuild', 'volume'].includes(mode)) expect(f.calls.some(p => p.includes('/build'))).toBe(false);
});
