import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as transport from "./github-transport.js";
import { main, type MainIo } from "./main.js";
import { config, FakeGithub, marker, now, request, uuid } from "./testkit/fixtures.js";

const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const origin = "https://api.github.com/";
const token = "fixture-private-token";
const binding = config();
const repo = binding.allow[0]!;
const install = origin + "repos/" + repo.repository + "/installation";
const mint = origin + "app/installations/" + binding.producer.installation_id + "/access_tokens";
const selection = { repository_selection: "selected", permissions: { checks: "write", metadata: "read" } };
let dir: string, key: string, ledger: string, configPath: string, requestPath: string;
let publish: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "publisher-main-"));
  key = join(dir, "key");
  ledger = join(dir, "ledger");
  configPath = join(dir, "config");
  requestPath = join(dir, "request");
  publish = ["publish", "--config", configPath, "--ledger", ledger, "--request", requestPath];
  await writeFile(key, pem, { mode: 0o600 });
  await writeFile(configPath, JSON.stringify(binding));
  await writeFile(requestPath, JSON.stringify(request()));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

function safeLine(lines: string[]) {
  expect(lines).toHaveLength(1);
  const line = lines[0]!;
  expect(line).not.toMatch(/[\r\n]/u);
  for (const secret of [dir, ...pem.trim().split("\n"), token, marker]) expect(line).not.toContain(secret);
  return line;
}

function setup() {
  const github = new FakeGithub();
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    const reply = (body: unknown, status: number) => new Response(JSON.stringify(body), { status });
    if (url === install && init?.method === "GET") {
      return reply({ ...selection, id: binding.producer.installation_id, app_id: binding.producer.app_id, suspended_at: null }, 200);
    }
    if (url === mint && init?.method === "POST") return reply({ ...selection, token, repositories: [{ id: repo.repository_id }] }, 201);
    const options = { signal: init!.signal! };
    if (url === origin + "repos/" + repo.repository + "/check-runs" && init?.method === "POST") {
      const result = await github.createCheckRun(repo.repository, JSON.parse(String(init.body)), options);
      return reply(result.body, result.ok ? 201 : 503);
    }
    if (!url.startsWith(origin) || init?.method !== "GET") return reply({}, 404);
    const result = await github.get(url.slice(origin.length), options);
    return reply(result.body, result.ok ? 200 : 404);
  });
  async function run(argv = [...publish, "--key", key], overrides: Partial<MainIo> = {}) {
    const lines: string[] = [];
    const code = await main(argv, { now, uuid: () => uuid(100), fetchImpl, stdout: line => lines.push(line), ...overrides });
    const line = safeLine(lines);
    return { code, line, body: JSON.parse(line) as unknown };
  }
  return { github, fetchImpl, run };
}

async function ledgerKinds() {
  const content = await readFile(ledger, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return "";
  });
  return content.split("\n").filter(Boolean).map(line => JSON.parse(line).kind);
}

it.each([1, 3, 7])("publishes with the key at argv index %i and recognizes a repeat", async index => {
  const h = setup();
  const argv = publish.slice();
  argv.splice(index, 0, "--key", key);
  expect(await h.run(argv)).toMatchObject({ code: 0, body: { status: "published" } });
  const urls = h.fetchImpl.mock.calls.map(([url]) => String(url));
  expect(urls.filter(url => url === install)).toHaveLength(1);
  expect(urls.filter(url => url === mint)).toHaveLength(1);
  expect(urls.every(url => url.startsWith(origin))).toBe(true);
  expect(await h.run(argv)).toMatchObject({ code: 0, body: { status: "already_published" } });
  expect(h.github.runs).toHaveLength(1);
  expect(await ledgerKinds()).toEqual(["intent", "published"]);
});

it("abandons the open intent when its check run is absent", async () => {
  const h = setup();
  h.github.failCreate = 1;
  expect(await h.run()).toMatchObject({ code: 1, body: { reason: "write_unconfirmed" } });
  expect(await h.run(["abandon", "--invocation", uuid(2), "--config", configPath, "--ledger", ledger, "--key", key]))
    .toMatchObject({ code: 0, body: { status: "abandoned" } });
  expect(await ledgerKinds()).toEqual(["intent", "abandoned"]);
});

it.each([[], ["--key", "one", "--key", "two"], ["--key"], ["--key", "--operator"]].map(flags => ({ flags })))(
  "rejects invalid key arguments %# before fetch", async ({ flags }) => {
    const h = setup();
    expect(await h.run([...publish, ...flags])).toMatchObject({ code: 2, line: '{"ok":false,"reason":"usage","detail":null}' });
    expect(h.fetchImpl).not.toHaveBeenCalled();
  });

it.each(["missing", "0644", "invalid", "relative"])("reports a %s key before minting or writing", async kind => {
  const h = setup();
  if (kind === "missing") await rm(key);
  if (kind === "0644") await chmod(key, 0o644);
  if (kind === "invalid") await writeFile(key, marker);
  expect(await h.run([...publish, "--key", kind === "relative" ? "key" : key])).toMatchObject({
    code: 2, line: '{"ok":false,"reason":"key_unavailable","detail":null}',
  });
  expect(h.fetchImpl).not.toHaveBeenCalled();
  expect(h.github.runs).toHaveLength(0);
  expect(await ledgerKinds()).toEqual([]);
});

it.each([
  ["config_invalid", 2], ["request_invalid", 2], ["not_allowlisted", 1],
] as const)("preserves %s with a missing key", async (reason, code) => {
  const h = setup();
  if (reason === "not_allowlisted") await writeFile(requestPath, JSON.stringify({ ...request(), repository_id: 102 }));
  else await writeFile(reason === "config_invalid" ? configPath : requestPath, marker);
  expect(await h.run([...publish, "--key", join(dir, "missing")])).toMatchObject({ code, body: { ok: false, reason, detail: null } });
  expect(h.fetchImpl).not.toHaveBeenCalled();
});

it("preserves the refusal when fetch throws", async () => {
  const h = setup();
  h.fetchImpl.mockRejectedValue(new Error(marker));
  expect(await h.run()).toMatchObject({ code: 1, body: { reason: "read_failed" } });
  expect(h.fetchImpl).toHaveBeenCalledOnce();
});

it("preserves the refusal when uuid throws inside the ledger lock", async () => {
  const uuidFailure = vi.fn(() => { throw new Error(marker); });
  expect(await setup().run(undefined, { uuid: uuidFailure })).toMatchObject({ code: 1, body: { reason: "ledger_unavailable" } });
  expect(uuidFailure).toHaveBeenCalledOnce();
});

it("redacts an exception during transport construction", async () => {
  vi.spyOn(transport, "createPublisherGithub").mockImplementationOnce(() => { throw new Error(marker); });
  expect(await setup().run()).toMatchObject({ code: 1, line: '{"ok":false,"reason":"internal","detail":null}' });
});

it("propagates stdout errors without a second write", async () => {
  const error = new Error(marker);
  const stdout = vi.fn(() => { throw error; });
  await expect(main([], { now, uuid: () => uuid(100), fetchImpl: vi.fn(), stdout })).rejects.toBe(error);
  expect(stdout).toHaveBeenCalledOnce();
});

it("prints usage from the built executable", () => {
  const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
  expect(existsSync(bin), "Build @osstack/verify-publisher first: dist/bin.js is required").toBe(true);
  const child = spawnSync(process.execPath, [bin], { encoding: "utf8" });
  expect(child.error).toBeUndefined();
  expect(child.stderr).toBe("");
  expect(child.status).toBe(2);
  expect(child.stdout).toBe('{"ok":false,"reason":"usage","detail":null}\n');
  safeLine([child.stdout.trimEnd()]);
});
