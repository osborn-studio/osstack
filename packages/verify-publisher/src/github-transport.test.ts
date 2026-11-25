import { createVerify, generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AppKeyUnavailable, createAppJwtSigner } from "./app-key.js";
import { createFileAttemptLedger } from "./attempt-ledger.js";
import { createPublisherGithub, type PublisherGithubDeps } from "./github-transport.js";
import { publishVerification, type PublisherGithub } from "./publish.js";
import { config, FakeGithub, now, request, uuid } from "./testkit/fixtures.js";

const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const repo = config().allow[0]!.repository, root = "repos/" + repo;
const install = root + "/installation", mint = "app/installations/301/access_tokens";
const pr = root + "/pulls/7", create = root + "/check-runs", detail = create + "/1";
const list = root + "/commits/" + request().head_sha + "/check-runs?check_name=osstack%2Fverify-intake%2Ffixture-skill&filter=all&per_page=100";
const origin = "https://api.github.com/", token = "fixture-secret-token";
const permissions = { checks: "write", metadata: "read" };
const proof = { repository_selection: "selected", permissions, id: 301, app_id: 201, suspended_at: null };
const grant = { repository_selection: "selected", permissions, token, repositories: [{ id: 101 }] };
const run: Parameters<PublisherGithub["createCheckRun"]>[1] = { name: "fixture", head_sha: request().head_sha,
  external_id: uuid(1), status: "completed", conclusion: "success", output: { title: "", summary: "", text: "" } };
const options = { signal: new AbortController().signal };
let dir: string;
beforeEach(async () => {
  for (const name of ["log", "warn", "error"] as const) vi.spyOn(console, name).mockImplementation(() => {});
  dir = await mkdtemp(join(tmpdir(), "publisher-transport-"));
  const path = join(dir, "key");
  await writeFile(path, pair.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
  await chmod(path, 0o600);
});
afterEach(async () => {
  try { for (const name of ["log", "warn", "error"] as const) expect(console[name]).not.toHaveBeenCalled(); }
  finally { vi.restoreAllMocks(); await rm(dir, { recursive: true, force: true }); }
});

interface Call { url: string; method: string; headers: Headers; body: string | undefined; redirect: RequestInit["redirect"] }
type Route = (call: Call) => Response | Promise<Response>;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });

function setup(overrides: Partial<PublisherGithubDeps> = {}, binding = config()) {
  const fixture = new FakeGithub();
  const routes = new Map<string, Route>([
    [install, () => json(proof)], [mint, () => json(grant, 201)],
    ...[pr, list, detail].map((path): [string, Route] => [path, async () => {
      const result = await fixture.get(path, options);
      return json(result.body, result.ok ? 200 : 404);
    }]),
    [create, async call => json((await fixture.createCheckRun(repo, JSON.parse(call.body!), options)).body, 201)],
  ]);
  const calls: Call[] = [];
  const validSignatures: boolean[] = [];
  const signJwt = vi.fn(createAppJwtSigner(join(dir, "key"), 201));
  const github = createPublisherGithub(binding, { now: () => now().getTime(), signJwt,
    fetchImpl: async (input, init) => {
      const url = String(input), path = url.slice(origin.length);
      const call = { url, method: init!.method!, headers: new Headers(init!.headers),
        body: init!.body as string | undefined, redirect: init!.redirect };
      calls.push(call);
      if (path === install || path === mint) {
        const [head, payload, signature] = (call.headers.get("authorization") ?? "").slice(7).split(".");
        const valid = !!signature && createVerify("RSA-SHA256").update(head + "." + payload).verify(pair.publicKey, signature, "base64url");
        validSignatures.push(valid);
        if (!valid) return json({}, 401);
      }
      return routes.get(path)?.(call) ?? json({}, 404);
    }, ...overrides });
  async function refused(reply: ReturnType<PublisherGithub["get"]>) {
    const result = await reply;
    expect(result).toStrictEqual({ ok: false });
    const text = JSON.stringify(result);
    expect(text).not.toContain(token);
    for (const jwt of signJwt.mock.results) expect(text).not.toContain(await jwt.value);
  }
  return { routes, github, calls, validSignatures, signJwt, fixture, refused,
    get: (path = pr, opts = options) => github.get(path, opts),
    write: (name = repo, body = run) => github.createCheckRun(name, body, options),
    count: (path: string) => calls.filter(c => c.url === origin + path).length };
}

it("authenticates the first PR read", async () => {
  const h = setup();
  expect(await h.get()).toEqual({ ok: true, body: h.fixture.pr });
  expect(h.calls.map(c => [c.url, c.method])).toEqual([[origin + install, "GET"], [origin + mint, "POST"], [origin + pr, "GET"]]);
  const [a, b, c] = h.calls;
  expect(h.validSignatures).toEqual([true, true]);
  expect(a!.headers.get("authorization")).toBe("Bearer " + await h.signJwt.mock.results[0]!.value);
  expect(b!.headers.get("authorization")).toBe(a!.headers.get("authorization"));
  expect(b!.body).toBe('{"repository_ids":[101],"permissions":{"checks":"write","metadata":"read"}}');
  expect(b!.headers.get("content-type")).toBe("application/json");
  expect(c!.headers.get("authorization")).toBe("Bearer " + token);
  for (const call of h.calls) {
    expect(call.redirect).toBe("error");
    expect(call.headers.get("user-agent")).toBe("osstack-verify-publisher");
    expect(call.headers.get("accept")).toBe("application/vnd.github+json");
    expect(call.headers.get("x-github-api-version")).toBe("2022-11-28");
  }
});
it("reuses the token for list and detail", async () => {
  const h = setup();
  h.routes.set(detail, () => json({ id: 1 }));
  for (const path of [pr, list, detail]) expect((await h.get(path)).ok).toBe(true);
  expect(h.calls.map(c => c.url)).toEqual([install, mint, pr, list, detail].map(path => origin + path));
  for (const c of h.calls.slice(2)) expect(c.headers.get("authorization")).toBe("Bearer " + token);
});
it("shares the first mint", async () => {
  const h = setup();
  expect((await Promise.all([h.get(), h.get(list)])).every(r => r.ok)).toBe(true);
  expect(h.count(mint)).toBe(1);
  expect(h.count(install)).toBe(1);
});

it.each([
  ["installation id", { id: 302 }], ["app id", { app_id: 202 }], ["suspension", { suspended_at: "today" }],
  ["selection", { repository_selection: "all" }], ["third permission", { permissions: { ...permissions, issues: "read" } }],
  ["read-only checks", { permissions: { ...permissions, checks: "read" } }], ["404", {}], ["500", {}],
] as const)("refuses installation %s", async (name, fields) => {
  const h = setup();
  h.routes.set(install, () => json({ ...proof, ...fields }, Number(name) || 200));
  await h.refused(h.get());
  expect(h.calls).toHaveLength(1);
  expect(h.count(mint)).toBe(0);
});
it.each([
  ["200", {}], ["repository id", { repositories: [{ id: 102 }] }], ["two repos", { repositories: [{ id: 101 }, { id: 102 }] }],
  ["extra permission", { permissions: { ...permissions, issues: "read" } }], ["selection", { repository_selection: "all" }],
  ["missing", { token: undefined }], ["space", { token: "a b" }], ["empty", { token: "" }], ["long", { token: "a".repeat(513) }],
] as const)("refuses token %s", async (name, fields) => {
  const h = setup();
  h.routes.set(mint, () => json({ ...grant, ...fields }, name === "200" ? 200 : 201));
  await h.refused(h.get());
  expect(h.calls).toHaveLength(2);
});
it("allows a fresh attempt after a failed mint", async () => {
  const h = setup();
  h.routes.set(mint, () => json({}, 503));
  await h.refused(h.get());
  h.routes.set(mint, () => json(grant, 201));
  expect((await h.get()).ok).toBe(true);
  expect(h.count(mint)).toBe(2);
});

it.each([
  ["another repo", "repos/other/repo/pulls/7"], ["traversal", root + "/../pulls/7"], ["leading slash", "/" + pr],
  ["issues", root + "/issues/1"], ["check name", list.replace("verify-intake", "other")],
  ["another skill", list.replace("fixture-skill", "other-skill")], ["extra query", list + "&page=2"],
  ["uppercase SHA", list.replace(request().head_sha, "A".repeat(40))], ["zero PR", root + "/pulls/0"],
  ["full URL", origin + pr], ["aborted", pr],
])("rejects %s before signing", async (name, path) => {
  const binding = config();
  binding.allow.push({ ...binding.allow[0]!, repository: "second/repo", repository_id: 102, skill_id: "other-skill" });
  const h = setup({}, binding);
  await h.refused(h.get(path, name === "aborted" ? { signal: AbortSignal.abort() } : options));
  expect(h.calls).toHaveLength(0);
  expect(h.signJwt).not.toHaveBeenCalled();
});
it("refuses conflicting repository IDs", async () => {
  const binding = config();
  binding.allow.push({ ...binding.allow[0]!, repository_id: 102, skill_id: "other-skill" });
  const h = setup({}, binding);
  await h.refused(h.get());
  await h.refused(h.write());
  expect(h.calls).toHaveLength(0);
});
it.each(["unknown repo", "oversize JSON", "aborted"])("refuses create for %s", async kind => {
  const h = setup();
  if (kind === "aborted") await h.refused(h.github.createCheckRun(repo, run, { signal: AbortSignal.abort() }));
  else await h.refused(h.write(kind === "unknown repo" ? "other/repo" : repo,
    kind === "oversize JSON" ? { ...run, name: "é".repeat(32768) } : run));
  expect(h.calls).toHaveLength(0);
  expect(h.signJwt).not.toHaveBeenCalled();
});
it.each(["201", "200", "throw"])("sends one create for %s", async kind => {
  const h = setup();
  h.routes.set(create, () => { if (kind === "throw") throw new Error(token); return json({ id: 1 }, Number(kind)); });
  if (kind === "201") expect(await h.write()).toEqual({ ok: true, body: { id: 1 } });
  else await h.refused(h.write());
  expect(h.count(create)).toBe(1);
  const c = h.calls.at(-1)!;
  expect(c.method).toBe("POST");
  expect(c.headers.get("authorization")).toBe("Bearer " + token);
  expect(c.body).toBe(JSON.stringify(run));
  expect(c.redirect).toBe("error");
});

it.each([[install, 65536, 0], [install, 65536, 1], [pr, 1048576, 0], [pr, 1048576, 1]] as const)(
  "bounds %s to %i bytes (excess %i)", async (path, limit, excess) => {
    const h = setup(), value = path === install ? proof : { title: "é" };
    const bytes = Buffer.from(JSON.stringify(value)), cancelled = vi.fn();
    h.routes.set(path, () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.enqueue(Buffer.alloc(limit - bytes.length + excess, 32));
        if (!excess) controller.close();
      },
      cancel: cancelled,
    })));
    if (excess) { await h.refused(h.get()); expect(cancelled).toHaveBeenCalledOnce(); }
    else expect((await h.get()).ok).toBe(true);
  });
it.each([install, mint, pr])("times out a stalled fetch at %s", async path => {
  const controller = new AbortController(), times: number[] = [];
  const h = setup({ timeout: ms => { times.push(ms); return controller.signal; } });
  h.routes.set(path, () => {
    queueMicrotask(() => controller.abort());
    return new Promise<Response>(() => {});
  });
  await h.refused(h.get());
  expect(times).toEqual([5000, 10000, 15000].slice(0, [install, mint, pr].indexOf(path) + 1));
});
it("times out the body read", async () => {
  const controller = new AbortController(), cancelled = vi.fn();
  const h = setup({ timeout: () => controller.signal });
  h.routes.set(pr, () => new Response(new ReadableStream({
    pull() { setTimeout(() => controller.abort(), 0); }, cancel: cancelled,
  })));
  await h.refused(h.get());
  expect(cancelled).toHaveBeenCalledOnce();
});
it.each(["redirect", "invalid JSON", "missing body"])("refuses %s", async kind => {
  const h = setup();
  h.routes.set(pr, () => {
    if (kind === "invalid JSON") return new Response(token);
    if (kind === "missing body") return new Response(null);
    return Object.defineProperty(json({}), "redirected", { value: true });
  });
  await h.refused(h.get());
  expect(h.calls.every(c => c.url.startsWith(origin) && c.redirect === "error")).toBe(true);
});
it("reads anonymously and authenticates writes", async () => {
  const h = setup({ anonymousReads: true });
  h.routes.set(detail, () => json({ id: 1 }));
  for (const path of [pr, list, detail]) expect((await h.get(path)).ok).toBe(true);
  expect(h.calls.map(c => c.url)).toEqual([pr, list, detail].map(path => origin + path));
  expect(h.calls.every(c => !c.headers.has("authorization"))).toBe(true);
  expect(h.signJwt).not.toHaveBeenCalled();
  expect((await h.write()).ok).toBe(true);
  expect(h.calls.slice(3).map(c => c.url)).toEqual([install, mint, create].map(path => origin + path));
  expect(h.calls.at(-1)!.headers.get("authorization")).toBe("Bearer " + token);
});
it("remembers an unavailable key", async () => {
  const signJwt = vi.fn().mockRejectedValueOnce(new AppKeyUnavailable()).mockRejectedValue(new Error(token));
  const h = setup({ signJwt });
  expect(h.github.keyUnavailable()).toBe(false);
  await h.refused(h.get());
  expect(h.github.keyUnavailable()).toBe(true);
  await h.refused(h.get());
  expect(h.github.keyUnavailable()).toBe(true);
  expect(h.calls).toHaveLength(0);
});
it("publishes with a file ledger", async () => {
  const h = setup(), ledger = createFileAttemptLedger(join(dir, "ledger"));
  expect(await h.get(list)).toMatchObject({ ok: true, body: { total_count: 0, check_runs: [] } });
  expect(await publishVerification({ github: h.github, ledger, now, uuid: () => uuid(10) }, config(), request(), options))
    .toEqual({ ok: true, status: "published", result_id: uuid(10), attempt: 1, check_run_id: 1 });
  expect(h.count(create)).toBe(1);
  expect(h.count(detail)).toBe(1);
  expect(await h.get(list)).toMatchObject({ ok: true, body: { total_count: 1, check_runs: [{ app: { id: 201 } }] } });
});

it("rejects an overriding read method", async () => {
  const h = setup(), other = { ...options, method: "POST" };
  await h.refused(h.get(pr, other));
  expect(h.calls).toHaveLength(0);
  expect(h.signJwt).not.toHaveBeenCalled();
});
it.each(["JWT", "token"])("refuses an echoed %s", async kind => {
  const h = setup();
  h.routes.set(pr, async () => json({ message: kind === "JWT" ? await h.signJwt.mock.results[0]!.value : token }));
  await h.refused(h.get());
});
it("mints separate tokens for two repositories", async () => {
  const binding = config(), second = "other/repo", otherRoot = "repos/" + second;
  binding.allow.push({ ...binding.allow[0]!, repository: second, repository_id: 102 });
  const h = setup({}, binding);
  h.routes.set(otherRoot + "/installation", () => json(proof));
  h.routes.set(mint, call => {
    const id = JSON.parse(call.body!).repository_ids[0];
    return json({ ...grant, token: token + id, repositories: [{ id }] }, 201);
  });
  const otherPr = otherRoot + "/pulls/1";
  h.routes.set(otherPr, () => json({ number: 1 }));
  for (const path of [pr, otherPr, pr, otherPr]) expect((await h.get(path)).ok).toBe(true);
  expect(h.count(mint)).toBe(2);
  for (const call of h.calls.filter(c => c.url.endsWith(pr) || c.url.endsWith(otherPr))) {
    expect(call.headers.get("authorization")).toBe("Bearer " + token + (call.url.endsWith(pr) ? 101 : 102));
  }
});
