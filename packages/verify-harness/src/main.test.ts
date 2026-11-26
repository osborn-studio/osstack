import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadInstalledVerificationProfile, verificationProfileDigest } from "@osstack/agents/contained-profile";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { main, type MainIo } from "./main.js";
import type { HarnessPorts, HarnessRefusal } from "./run.js";
import { base, config, date, entry, hash, head, id, installed, marker, observation, prBody, prepared } from "./testkit/fixtures.js";

let root: string, configPath: string, data: string, drop: string, evidence: string, argv: string[];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "harness-"));
  configPath = join(root, "config");
  data = join(root, "data");
  drop = join(root, "drop");
  evidence = join(root, "evidence");
  for (const dir of [data, drop, evidence]) await mkdir(dir);
  await writeFile(configPath, JSON.stringify(config));
  argv = ["--pr", "3", "--data", data, "--repository-id", "101", "--config", configPath, "--evidence", evidence, "--drop", drop];
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

function setup() {
  const ports = {
    fetchSource: vi.fn<HarnessPorts["fetchSource"]>().mockResolvedValue({ tree: head, files: [] }),
    loadProfile: vi.fn<HarnessPorts["loadProfile"]>().mockReturnValue(installed),
    prepare: vi.fn<HarnessPorts["prepare"]>().mockResolvedValue(prepared),
    run: vi.fn<HarnessPorts["run"]>().mockResolvedValue(observation()),
  };
  const fetchImpl = vi.fn<typeof fetch>(async () => Response.json(prBody));
  const io: MainIo = { fetchImpl, now: () => date, uuid: () => id, getuid: () => 501, stdout: vi.fn(), ports };
  async function call(args = argv) {
    const stdout = vi.fn();
    const code = await main(args, { ...io, stdout });
    expect(stdout).toHaveBeenCalledOnce();
    const line: string = stdout.mock.calls[0]![0];
    expect(line).not.toMatch(/[\r\n]/u);
    for (const forbidden of [root, marker, "out" + marker, "err" + marker]) expect(line).not.toContain(forbidden);
    return { code, line };
  }
  return { call, ports, io, fetchImpl };
}
const failure = (reason: string, code: number) => ({ code, line: JSON.stringify({ ok: false, reason }) });
it("requires six unique flag-value pairs with absolute paths and canonical positive IDs", async () => {
  const h = setup();
  const bad = [[], [...argv, "extra"], [...argv, "--head", head], argv.slice(0, -1)];
  for (let i = 0; i < argv.length; i += 2) {
    bad.push(argv.filter((_, index) => index !== i && index !== i + 1));
    for (const flag of ["--unknown", argv[(i + 2) % argv.length]!]) bad.push(argv.map((x, j) => j === i ? flag : x));
    const numeric = ["--pr", "--repository-id"].includes(argv[i]!);
    for (const value of ["", "--value", ...(numeric ? ["0", "01", "+1", "-1", " 1", "1 ", "1.2", "1e2", "9007199254740992"] : ["relative", "/bad\0"])])
      bad.push(argv.map((x, j) => j === i + 1 ? value : x));
  }
  for (const args of bad) expect(await h.call(args)).toEqual(failure("usage", 2));
  expect(h.fetchImpl).not.toHaveBeenCalled();
});
it.each(["missing", "oversize", "JSON", "schema", "encoding"])("reports invalid config for %s", async kind => {
  if (kind === "missing") await rm(configPath);
  else if (kind === "oversize") await writeFile(configPath, JSON.stringify(config).padEnd(262145));
  else if (kind === "encoding") await writeFile(configPath, Buffer.concat([Buffer.from('"'), Buffer.from([255]), Buffer.from('"')]));
  else await writeFile(configPath, kind === "JSON" ? "{" : "{}");
  const h = setup();
  expect(await h.call()).toEqual(failure("config_invalid", 2));
  expect(h.fetchImpl).not.toHaveBeenCalled();
});
it("writes one request and creates the two private data directories", async () => {
  const h = setup();
  expect(await h.call()).toEqual({ code: 0, line: JSON.stringify({ ok: true, invocation_id: id, file: id + ".json", outcome: "passed" }) });
  const request = JSON.parse(await readFile(join(drop, id + ".json"), "utf8"));
  expect(request).toMatchObject({ head_sha: head, base_sha: base, record: { invocation_id: id, outcome: "passed" } });
  expect(await readdir(data)).toEqual(["journal", "repos"]);
  for (const name of ["journal", "repos"]) expect((await stat(join(data, name))).mode & 0o777).toBe(0o700);
});
type Harness = ReturnType<typeof setup>;
const cases: [HarnessRefusal, (h: Harness) => unknown][] = [
  ["not_configured", () => { argv[5] = "102"; }],
  ["pr_read_failed", h => h.fetchImpl.mockRejectedValue(Error(marker))],
  ["pr_not_open", h => h.fetchImpl.mockResolvedValue(Response.json({ ...prBody, state: "closed" }))],
  ["scope_mismatch", () => { argv[1] = "4"; }],
  ["fork", h => h.fetchImpl.mockResolvedValue(Response.json({ ...prBody, head: { repo: null, sha: head } }))],
  ["source_unavailable", h => h.ports.fetchSource.mockRejectedValue(Error(marker))],
  ["candidate_unsupported", h => h.ports.fetchSource.mockRejectedValue(Error("CONTAINED_CANDIDATE_LIMIT"))],
  ["profile_unavailable", h => h.ports.loadProfile.mockImplementation(() => { throw Error(marker); })],
  ["isolation_unavailable", h => h.ports.prepare.mockRejectedValue(Error(marker))],
  ["stop_unknown", h => h.ports.run.mockRejectedValue(Error(marker))],
  ["request_write_failed", () => writeFile(join(drop, id + ".json"), marker)],
];
it.each(cases)("prints the closed refusal %s", async (reason, change) => {
  const h = setup();
  await change(h);
  expect(await h.call()).toEqual(failure(reason, 1));
});
it("redacts an unexpected exception while accessing a port", async () => {
  const h = setup();
  Object.defineProperty(h.ports, "prepare", { get() { throw Error(root + marker); } });
  expect(await h.call()).toEqual(failure("internal", 1));
});
it.each(["data", "drop", "evidence"])("requires an existing %s directory", async name => {
  const dir = join(root, name);
  await rm(dir, { recursive: true });
  expect(await setup().call()).toEqual(failure("internal", 1));
  await expect(stat(dir)).rejects.toMatchObject({ code: "ENOENT" });
});
it("refuses the missing socket with the real container ports", async () => {
  const h = setup();
  // Real preparation revalidates the capability issued by the installed-profile loader.
  const trusted_source = { repository: entry.trusted_source.repository, commit: base };
  const bytes = JSON.stringify({ version: 1, trusted_source, profile: installed.profile });
  const artifact_digest = hash(bytes);
  const profile_digest = verificationProfileDigest(installed.profile);
  await writeFile(join(root, artifact_digest + ".json"), bytes, { mode: 0o600 });
  const capability = loadInstalledVerificationProfile({ installedRoot: await realpath(root), ownerUid: (await stat(root)).uid,
    allowedArgv: [entry.allowed_argv] }, { profile_id: entry.profile_id, profile_digest, trusted_source: { ...trusted_source, artifact_digest } });
  const socket_path = join(root, "missing.sock");
  await expect(stat(socket_path)).rejects.toMatchObject({ code: "ENOENT" });
  await writeFile(configPath, JSON.stringify({ ...config, docker: { ...config.docker, socket_path },
    entries: [{ ...entry, profile_digest, trusted_source: { ...entry.trusted_source, artifact_digest } }] }));
  h.ports.fetchSource.mockResolvedValue({ tree: head, files: [{ path: "plain", mode: "100644", bytes: Buffer.from("content") }] });
  h.io.ports = { fetchSource: h.ports.fetchSource, loadProfile: () => capability };
  expect(await h.call()).toEqual(failure("isolation_unavailable", 1));
  expect(await readdir(drop)).toEqual([]);
});
it("prints usage and exits 2 from the built executable", () => {
  const path = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
  const child = spawnSync(process.execPath, [path], { encoding: "utf8" });
  expect(child.error).toBeUndefined();
  expect(child.stderr).toBe("");
  expect(child.status).toBe(2);
  expect(child.stdout).toBe('{"ok":false,"reason":"usage"}\n');
});
