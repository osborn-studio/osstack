import { ReadableStream } from "node:stream/web";
import { expect, it, vi } from "vitest";
import { createPullRequestPort } from "./github-read.js";

const path = "repos/fixture-owner/repo.name/pulls/3";
const options = { signal: new AbortController().signal };
const limit = 1048576;

it("makes one anonymous GET and accepts JSON at the byte limit", async () => {
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response("{}".padEnd(limit)));
  expect(await createPullRequestPort({ fetchImpl }).get(path, options)).toEqual({ ok: true, body: {} });
  expect(fetchImpl.mock.calls).toEqual([["https://api.github.com/" + path, {
    method: "GET", redirect: "error", signal: expect.any(AbortSignal),
    headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
  }]]);
});
it.each(["", "/" + path, path + "/", path + "?q=1", path + "#fragment", path + "\n", path.replace("3", "0"),
  path.replace("3", "03"), path.replace("3", "-1"), path.replace("3", "1.5"), path.replace("pulls", "issues"),
  path.replace("fixture-owner", "Bad"), path.replace("repo.name", "../other"), path.replace("repo.name", "%2f"),
  path.replace("repo.name", "a".repeat(201)), "https://api.github.com/" + path])("rejects bad path %# before GET", async bad => {
  const fetchImpl = vi.fn<typeof fetch>();
  expect(await createPullRequestPort({ fetchImpl }).get(bad, options)).toEqual({ ok: false });
  expect(fetchImpl).not.toHaveBeenCalled();
});
it.each([() => new Response("{}", { status: 404 }), () => Response.redirect("https://example.invalid/", 302),
  () => new Response("{"), () => { throw Error("detail"); }])("closes transport failure %# without retry", async response => {
  const fetchImpl = vi.fn<typeof fetch>(async () => response());
  expect(await createPullRequestPort({ fetchImpl }).get(path, options)).toEqual({ ok: false });
  expect(fetchImpl).toHaveBeenCalledOnce();
});
it("cancels the stream as soon as it exceeds the limit", async () => {
  const cancel = vi.fn();
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(8192)); }, cancel });
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream));
  expect(await createPullRequestPort({ fetchImpl }).get(path, options)).toEqual({ ok: false });
  expect(cancel).toHaveBeenCalledOnce();
});
it.each(["caller", "timeout"])("aborts a pending GET on %s cancellation", async which => {
  const caller = new AbortController();
  const timer = new AbortController();
  const timeout = vi.fn(() => timer.signal);
  const fetchImpl = vi.fn<typeof fetch>((_url, init) => new Promise((_resolve, reject) => {
    init!.signal!.addEventListener("abort", () => reject(Error("aborted")), { once: true });
  }));
  const pending = createPullRequestPort({ fetchImpl, timeout }).get(path, { signal: caller.signal });
  (which === "caller" ? caller : timer).abort();
  expect(await pending).toEqual({ ok: false });
  expect(timeout.mock.calls).toEqual([[15000]]);
  expect(fetchImpl).toHaveBeenCalledOnce();
});
