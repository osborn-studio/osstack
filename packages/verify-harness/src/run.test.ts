import { mkdir, mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildVerificationResult, parseVerificationResultV1 } from "@osstack/core/verification-publish";
import { expect, it, vi } from "vitest";
import { runHarness, type HarnessInput, type HarnessPorts, type HarnessRefusal } from "./run.js";
import { base, binding, config, date, digest, entry, head, id, installed, marker, observation, prBody, prepared } from "./testkit/fixtures.js";

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "run-"));
  const input: HarnessInput = { repository_id: 101, pr: 3, config, signal: new AbortController().signal,
    dropDir: join(root, "drop"), evidenceDir: join(root, "evidence"), journalRoot: join(root, "journal") };
  await mkdir(input.dropDir);
  await mkdir(input.evidenceDir);
  const ports = {
    github: { get: vi.fn<HarnessPorts["github"]["get"]>().mockResolvedValue({ ok: true, body: prBody }) },
    fetchSource: vi.fn<HarnessPorts["fetchSource"]>().mockResolvedValue({ tree: head, files: [] }),
    ownerUid: vi.fn(() => 501),
    loadProfile: vi.fn<HarnessPorts["loadProfile"]>().mockReturnValue(installed),
    prepare: vi.fn<HarnessPorts["prepare"]>().mockResolvedValue(prepared),
    uuid: vi.fn(() => id), now: vi.fn(() => date),
    run: vi.fn<HarnessPorts["run"]>().mockResolvedValue(observation()),
  };
  return { ports, input };
}
type Setup = Awaited<ReturnType<typeof setup>>;
type Case = [string, HarnessRefusal, number, (s: Setup) => void];
const failure = Error("sensitive detail " + marker);
const cases: Case[] = [
  ["unknown repository", "not_configured", 0, s => { s.input.repository_id++; }],
  ["read error", "pr_read_failed", 1, s => s.ports.github.get.mockRejectedValue(failure)],
  ["closed", "pr_not_open", 1, s => s.ports.github.get.mockResolvedValue({ ok: true, body: { ...prBody, state: "closed" } })],
  ["other PR", "scope_mismatch", 1, s => { s.input.pr++; }],
  ["deleted fork", "fork", 1, s => s.ports.github.get.mockResolvedValue({ ok: true, body: { ...prBody, head: { sha: head, repo: null } } })],
  ["source", "source_unavailable", 2, s => s.ports.fetchSource.mockRejectedValue(failure)],
  ["load", "profile_unavailable", 4, s => s.ports.loadProfile.mockImplementation(() => { throw failure; })],
  ["multiple checks", "profile_unavailable", 4, s => s.ports.loadProfile.mockReturnValue({ ...installed,
    profile: { ...installed.profile, checks: [...installed.profile.checks, ...installed.profile.checks] } })],
  ["unrepresentable check id", "profile_unavailable", 4, s => s.ports.loadProfile.mockReturnValue({ ...installed,
    profile: { ...installed.profile, checks: [{ ...installed.profile.checks[0]!, check_id: "Check.1" }] } })],
  ["profile limits", "profile_unavailable", 5, s => s.ports.prepare.mockRejectedValue(Error("CONTAINED_PROFILE_LIMITS_UNSUPPORTED"))],
  ["runtime blockers", "profile_unavailable", 5, s => s.ports.prepare.mockResolvedValue({ ...prepared, runtimeBlockers: ["output_caps_exceed_runtime_maximum"] })],
  ["prepare", "isolation_unavailable", 5, s => s.ports.prepare.mockRejectedValue(failure)],
  ["run", "stop_unknown", 8, s => s.ports.run.mockRejectedValue(failure)],
  ["unknown stop", "stop_unknown", 8, s => s.ports.run.mockResolvedValue({ identity: observation().identity,
    result: { status: "stop_unknown", reason: marker } })],
  ["unproven receipt", "stop_unknown", 8, s => s.ports.run.mockResolvedValue(observation({ evidence: marker }))],
  ["evidence write", "request_write_failed", 9, s => { s.input.evidenceDir = join(s.input.evidenceDir, "missing"); }],
  ["request write", "request_write_failed", 9, s => { s.input.dropDir = join(s.input.dropDir, "missing"); }],
];
for (const code of ["CONTAINED_CANDIDATE_REGULAR_FILES_REQUIRED", "CONTAINED_CANDIDATE_LIMIT", "CONTAINED_CANDIDATE_FILE_LIMIT",
  "CONTAINED_CANDIDATE_SIZE_LIMIT", "CONTAINED_CANDIDATE_PATH_LIMIT"]) {
  cases.push([code, "candidate_unsupported", 2, s => s.ports.fetchSource.mockRejectedValue(Error(code))],
    [code, "candidate_unsupported", 5, s => s.ports.prepare.mockRejectedValue(Error(code))]);
}
it.each(cases)("stops at %s with %s", async (_case, reason, count, change) => {
  const s = await setup();
  const { dropDir, evidenceDir } = s.input;
  change(s);
  const { ports } = s;
  expect(await runHarness(s.input, ports)).toEqual({ ok: false, reason });
  const calls = Object.entries({ get: ports.github.get, source: ports.fetchSource, owner: ports.ownerUid, load: ports.loadProfile,
    prepare: ports.prepare, uuid: ports.uuid, now: ports.now, run: ports.run })
    .flatMap(([name, fn]) => fn.mock.invocationCallOrder.map(order => ({ name, order }))).sort((a, b) => a.order - b.order);
  expect(calls.map(c => c.name)).toEqual(["get", "source", "owner", "load", "prepare", "uuid", "now", "run", "now"].slice(0, count));
  expect(await readdir(dropDir)).toEqual([]);
  if (count < 9) expect(await readdir(evidenceDir)).toEqual([]);
});
it.each([[0, "passed", "success"], [12, "failed", "failure"], [125, "blocked", "action_required"]] as const)(
  "writes the contract for exit %i", async (exitCode, outcome, conclusion) => {
    const { ports, input } = await setup();
    ports.run.mockResolvedValue(observation({ exitCode }));
    const reply = await runHarness(input, ports);
    const file = id + ".json";
    expect(reply).toEqual({ ok: true, invocation_id: id, file, outcome });
    expect(ports.fetchSource).toHaveBeenCalledWith(entry.repository, head, input.signal);
    expect(ports.loadProfile).toHaveBeenCalledWith({ installedRoot: config.profiles_root, ownerUid: 501, allowedArgv: [entry.allowed_argv] }, binding);
    expect(ports.prepare).toHaveBeenCalledWith({ socketPath: config.docker.socket_path, daemonId: config.docker.daemon_id,
      baseImageId: entry.base_image_id }, [], installed, expect.any(Function));
    expect(ports.prepare.mock.calls[0]![3]()).toBeUndefined();
    const [plan, host, invocation] = ports.run.mock.calls[0]!;
    expect(plan).toBe(prepared);
    expect(host).toEqual({ socketPath: config.docker.socket_path, journalRoot: input.journalRoot,
      authorizeStop: expect.any(Function), authorizeRead: expect.any(Function) });
    expect(host.authorizeStop()).toBeUndefined();
    expect(host.authorizeRead()).toBeUndefined();
    expect(invocation).toEqual({ invocationId: id, signal: input.signal });
    const text = await readFile(join(input.dropDir, file), "utf8");
    expect(text).not.toContain(marker);
    expect(JSON.stringify(reply)).not.toContain(marker);
    const request = JSON.parse(text);
    expect(request).toEqual({ version: 1, repository_id: 101, pr: 3, skill_id: entry.skill_id, head_sha: head, base_sha: base,
      record: expect.objectContaining({ outcome, invocation_id: id }) });
    const built = buildVerificationResult({ record: request.record, result_id: "75140aa2-b474-454c-8129-b8d18de40ad3",
      attempt: 1, generated_at: "2026-11-24T12:00:02Z", supersedes_result_id: null, recheck: null,
      producer: { type: "App", app_id: 1, installation_id: 2 },
      target: { repository: entry.repository, repository_id: request.repository_id, pr: request.pr, branch: "feature",
        base_ref: "main", head_sha: request.head_sha, base_sha: request.base_sha },
      binding: { skill_id: request.skill_id, skill_version: "1.0.0", skill_blob: base, skill_manifest_digest: digest,
        profile_id: entry.profile_id, profile_digest: entry.profile_digest, trusted_source: entry.trusted_source } });
    expect(built.ok).toBe(true);
    if (!built.ok) throw Error(built.reason);
    expect(parseVerificationResultV1(built.publication.text).ok).toBe(true);
    expect(built.publication.check_run.conclusion).toBe(conclusion);
  });
