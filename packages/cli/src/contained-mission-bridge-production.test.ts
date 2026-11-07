import { describe, expect, it, vi } from 'vitest';
import { readBridgeAncestry } from './contained-mission-bridge-production.js';

const base = 'a'.repeat(40), head = 'b'.repeat(40);
const chain = { repository: 'o/r', published_head: base };
describe('production remote ancestry', () => {
  for (const [status, mergeBase, expected] of [['ahead', base, true], ['ahead', head, false], ['diverged', base, false], ['behind', head, false]] as const) {
    it(`checks status and merge base: ${status}/${mergeBase[0]}`, async () => {
      const exec = vi.fn(async () => ({ exitCode: 0, stdout: JSON.stringify({ status, merge_base_commit: { sha: mergeBase } }), stderr: '' }));
      expect(await readBridgeAncestry(chain, head, new AbortController().signal, exec)).toBe(expected);
      expect(exec).toHaveBeenCalledWith(['api', `repos/o/r/compare/${base}...${head}?per_page=1`], { timeoutMs: 30_000 });
    });
  }
  it('discards late read results after cancellation', async () => {
    const abort = new AbortController();
    await expect(readBridgeAncestry(chain, head, abort.signal, async () => {
      abort.abort(); return { exitCode: 0, stdout: '{}', stderr: '' };
    })).rejects.toThrow();
  });
  it('refuses malformed targets before a process is launched', async () => {
    const exec = vi.fn();
    await expect(readBridgeAncestry(chain, '../oops', new AbortController().signal, exec)).rejects.toThrow('bridge_ancestry_target_invalid');
    expect(exec).not.toHaveBeenCalled();
  });
});
