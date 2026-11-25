import { expect, it, vi } from "vitest";
import { readPullRequest, type PullRequestPort } from "./pull-request.js";
import { base, entry, head, prBody } from "./testkit/fixtures.js";

async function read(reply: Awaited<ReturnType<PullRequestPort["get"]>>) {
  const get = vi.fn().mockResolvedValue(reply);
  const options = { signal: new AbortController().signal };
  const result = await readPullRequest(entry, 3, { get }, options);
  expect(get.mock.calls).toEqual([["repos/fixture/repo/pulls/3", options]]);
  return result;
}
it("reads both SHAs once and accepts extra GitHub fields", async () => {
  expect(await read({ ok: true, body: { ...prBody, labels: [] } })).toEqual({ ok: true, head_sha: head, base_sha: base });
});
it.each([
  [{ state: "closed", number: 4 }, "pr_not_open"],
  [{ number: 4, head: { ...prBody.head, repo: null } }, "scope_mismatch"],
  [{ base: { sha: base, repo: { ...prBody.base.repo, id: 2 } } }, "scope_mismatch"],
  [{ base: { sha: base, repo: { ...prBody.base.repo, full_name: "other/repo" } } }, "scope_mismatch"],
  [{ head: { sha: head, repo: { id: 2 } } }, "fork"],
  [{ head: { sha: head, repo: null } }, "fork"],
  [{ head: { sha: "invalid", repo: null } }, "pr_read_failed"],
] as const)("classifies PR response %#", async (change, reason) => {
  expect(await read({ ok: true, body: { ...prBody, ...change } })).toEqual({ ok: false, reason });
});
it("closes transport errors", async () => {
  expect(await read({ ok: false })).toEqual({ ok: false, reason: "pr_read_failed" });
  expect(await readPullRequest(entry, 3, { get: vi.fn().mockRejectedValue(Error("detail")) },
    { signal: new AbortController().signal })).toEqual({ ok: false, reason: "pr_read_failed" });
});
