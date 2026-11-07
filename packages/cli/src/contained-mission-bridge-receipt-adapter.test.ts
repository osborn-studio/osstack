import { describe, expect, it, vi } from 'vitest';
import { createReceiptReadAdapters } from './contained-mission-bridge-receipt-adapter.js';

const sha = 'a'.repeat(40);
async function fixture(url = 'https://github.com/a/b.git') {
  const abort = new AbortController();
  const git = vi.fn(async (args: readonly string[]) => ({ stdout: Buffer.from(args[0] === 'remote' ? `${url}\n` : args[0] === 'ls-remote' ? `${sha}\trefs/heads/topic\n` : ''), stderr: "", exitCode: 0 }));
  const inspect = vi.fn(async () => ({ gitDir: '/rig/git', digest: 'sha256:rig', entries: [], rejections: [] }));
  const ports = await createReceiptReadAdapters({ signal: abort.signal, git, inspect });
  return { ports, git, abort, inspect };
}
describe('receipt production read adapters', () => {
  it('pins the granted HTTPS repository and reads only the branch ref', async () => {
    const f = await fixture();
    expect(await f.ports.remoteHead('/rig', 'origin', 'topic', 'a/b')).toBe(sha);
    expect(f.git.mock.calls.map(([args]) => args)).toEqual([
      ['check-ref-format', 'refs/heads/topic'], ['remote', 'get-url', '--push', '--all', '--', 'origin'],
      ['ls-remote', '--refs', '--', 'https://github.com/a/b.git', 'refs/heads/topic'],
    ]);
  });
  for (const url of ['ext::unsafe', 'https://github.com/x/y.git', 'https://person@github.com/a/b.git', 'https://github.com/a/b.git\nhttps://github.com/x/y.git']) {
    it(`refuses configured remote target ${url.split(':')[0]}`, async () => {
      const f = await fixture(url);
      await expect(f.ports.remoteHead('/rig', 'origin', 'topic', 'a/b')).rejects.toThrow(/receipt_remote/);
      expect(f.git.mock.calls.some(([args]) => args[0] === 'ls-remote')).toBe(false);
    });
  }
  it('refuses git writes and command overrides without launching git', async () => {
    const f = await fixture();
    await expect(f.ports.localGit('/rig', ['push', 'origin', 'HEAD'])).rejects.toThrow('receipt_git_read_refused');
    await expect(f.ports.remoteHead('/rig', '--upload-pack=unsafe', 'topic', 'a/b')).rejects.toThrow('receipt_remote_target_invalid');
    expect(f.git).not.toHaveBeenCalled();
  });
  it('aborts before any command when shutdown has started', async () => {
    const f = await fixture(); f.abort.abort();
    await expect(f.ports.localGit('/rig', ['merge-base', '--is-ancestor', sha, sha])).rejects.toThrow('receipt_recovery_aborted');
    expect(f.git).not.toHaveBeenCalled();
  });
});
