import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalJson, ContainedMissionStore } from "@osstack/core";
import { publishedRecheck, runFixture } from "@osstack/core/dist/state/local-failure-recheck.testkit.js";
import { LocalFailureRecheckRunStore } from "@osstack/core/verification-intake";
import * as results from "@osstack/core/dist/bridge/verification-result-fixtures.js";
import { afterEach, expect, it, vi } from "vitest";
import * as attempts from "./contained-mission-actions-attempt.js";
import { SANDBOX_CI_POLICY } from "./contained-mission-ci-policy.js";
import { collectLocalFailureRecheck } from "./contained-mission-local-failure-recheck-collect.js";
import { createRecheckCollectorPorts, createRecheckRunPorts } from "./contained-mission-local-failure-recheck-ports.js";
import { runRecheck } from "./contained-mission-local-failure-recheck-run.js";
import type { ContainedVerificationProfile } from "./contained-mission-verification-profile.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function fixture() {
  const profile: ContainedVerificationProfile = {
    version: 1,
    profile_id: "fixture-profile",
    checks: [{ check_id: "fixture-check", category: "test", failure_exit_codes: [1] }],
    harness: { path: "/osstack-trusted/check", content: "fixture" },
    fixtures: [],
    argv: ["/usr/bin/node", "/osstack-trusted/check"],
    image: `fixture@sha256:${"f".repeat(64)}`,
    working_directory: "candidate",
    network: "none",
    read_only_rootfs: true,
    no_new_privileges: true,
    limits: {
      memory_mb: 128,
      cpus: 1,
      pids: 64,
      timeout_seconds: 20,
      stdout_bytes: 500,
      stderr_bytes: 500,
    },
  };
  const bytes = JSON.stringify({
    version: 1,
    trusted_source: {
      repository: "fixture-owner/fixture-harness",
      commit: "e".repeat(40),
    },
    profile,
  });
  // Bind the accepted source and its signed grant to the Actions policy used by this test.
  vi.spyOn(results, "verificationFixture").mockReturnValueOnce({
    ...results.verificationFixture(),
    repository: SANDBOX_CI_POLICY.repository,
    repository_id: SANDBOX_CI_POLICY.repositoryId,
  });
  const d = publishedRecheck({
    recheck: { timeout_seconds: 20 },
    artifactDigest: sha(bytes),
    profileDigest: sha(canonicalJson(profile)),
  });
  const { f } = d;
  const repositoryPath = join(f.root, "repo");
  mkdirSync(repositoryPath);
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@example.invalid",
        "-c",
        "core.hooksPath=/dev/null",
        ...args,
      ],
      {
        cwd: repositoryPath,
        encoding: "utf8",
        env: { PATH: process.env.PATH, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
      },
    ).trim();
  git("init", "-q", "-b", "repair");
  const payload = Buffer.from([0, 255, 10]);
  writeFileSync(join(repositoryPath, "data"), payload);
  writeFileSync(join(repositoryPath, "tool"), "tool");
  chmodSync(join(repositoryPath, "tool"), 0o755);
  git("add", ".");
  git("commit", "-qm", "candidate");
  const head = git("rev-parse", "HEAD");
  d.payload.candidate = head;
  const installedRoot = join(f.root, "profiles");
  mkdirSync(installedRoot, { mode: 0o700 });
  const artifact = join(installedRoot, sha(bytes) + ".json");
  const install = () => writeFileSync(artifact, bytes, { mode: 0o600 });
  const config = {
    store: new ContainedMissionStore(f.attention, f.owner),
    now: () => d.now,
    keys: () =>
      new Map([
        [
          f.facts.grant.key_id,
          {
            key_id: f.facts.grant.key_id,
            public_key: f.keys.publicKey,
            max_validity_ms: 86400000,
          },
        ],
      ]),
    access: { refresh: () => f.principal },
    profileHost: { installedRoot, ownerUid: process.getuid!(), allowedArgv: [profile.argv] },
    repositoryPath,
    docker: {
      socketPath: join(f.root, "unused.sock"),
      daemonId: "fixture",
      baseImageId: "sha256:" + sha("base"),
      journalRoot: f.root,
    },
  };
  return { config, d, git, head, payload, install, artifact, profile };
}

it("exports bytes and modes from the commit tree and rejects other revisions without exposing the path", async () => {
  const { config, git, head, payload } = fixture();
  const ports = createRecheckRunPorts(config);
  const tree = git("rev-parse", head + "^{tree}");
  writeFileSync(join(config.repositoryPath, "data"), "worktree");
  vi.stubEnv("GIT_DIR", join(config.repositoryPath, "missing.git"));
  expect(await ports.readCandidate(head)).toEqual({
    tree,
    files: [
      { path: "data", mode: "100644", bytes: payload },
      { path: "tool", mode: "100755", bytes: Buffer.from("tool") },
    ],
  });
  git("tag", "-am", "tag", "annotated", head);
  symlinkSync("data", join(config.repositoryPath, "link"));
  git("add", ".");
  git("commit", "-qm", "link");
  const symlinkHead = git("rev-parse", "HEAD");
  for (const revision of [
    "HEAD",
    "repair",
    head.slice(0, 8),
    head + "^{tree}",
    head.toUpperCase(),
    "0".repeat(40),
    git("rev-parse", "annotated"),
    symlinkHead,
    tree,
  ]) {
    await expect(ports.readCandidate(revision)).rejects.toMatchObject({
      message: expect.not.stringContaining(config.repositoryPath),
    });
  }
  git("replace", head, symlinkHead);
  await expect(ports.readCandidate(head)).rejects.toMatchObject({
    message: expect.not.stringContaining(config.repositoryPath),
  });
});

it("loads the installed profile on each call", () => {
  const { config, d, install, artifact } = fixture();
  const ports = createRecheckRunPorts(config);
  const pin = d.f.facts.profile;
  expect(() => ports.loadInstalledProfile(pin)).toThrow();
  install();
  expect(ports.loadInstalledProfile(pin).binding).toEqual(pin);
  unlinkSync(artifact);
  expect(() => ports.loadInstalledProfile(pin)).toThrow();
});

it("passes the configured authority and Docker settings and generates fresh UUIDs", () => {
  const { config } = fixture();
  const ports = createRecheckRunPorts(config);
  const { journalRoot, ...imageOptions } = config.docker;
  expect(ports.keys).toBe(config.keys);
  expect(ports.access).toBe(config.access);
  expect(ports.imageOptions).toEqual(imageOptions);
  expect(ports.host).toEqual({
    socketPath: imageOptions.socketPath,
    journalRoot,
    authorizeRead: expect.any(Function),
    authorizeStop: expect.any(Function),
  });
  const fence = vi.spyOn(config.store.attention, "assertOwner");
  ports.host.authorizeStop();
  ports.host.authorizeRead();
  expect(fence.mock.calls).toEqual([[config.store.owner], [config.store.owner]]);
  const ids = [ports.randomId(), ports.randomId()];
  expect(new Set(ids).size).toBe(2);
  for (const id of ids) expect(id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  for (const name of ["prepare", "run", "fault"]) expect(ports).not.toHaveProperty(name);
});

function actionsFixture(head: string, base: string, branch: string, pr: number) {
  const policy = { ...SANDBOX_CI_POLICY, jobs: [SANDBOX_CI_POLICY.jobs[0]!] };
  const repo = { full_name: policy.repository, id: policy.repositoryId };
  const query = { repository: repo.full_name, repository_id: repo.id, head, base, branch, pr };
  const run = {
    id: 2,
    workflow_id: policy.workflowId,
    run_number: 1,
    run_attempt: 1,
    head_sha: head,
    status: "completed",
    repository: repo,
    head_repository: repo,
  };
  const job = {
    id: 3,
    run_id: 2,
    run_attempt: 1,
    head_sha: head,
    status: "completed",
    conclusion: "success",
    name: policy.jobs[0]!.name,
    check_run_url: "https://api.github.com/repos/" + repo.full_name + "/check-runs/4",
  };
  const ci = {
    rest: vi.fn(async (path: string) => {
      let body: unknown;
      if (path.endsWith("/pulls/" + pr))
        body = {
          number: pr,
          state: "open",
          merged: false,
          user: { id: policy.publisherActorId, type: "Bot" },
          head: { sha: head, ref: branch, repo },
          base: { sha: base, ref: "main", repo },
        };
      else if (path.includes("/contents/")) body = { sha: policy.workflowBlob, type: "file" };
      else if (path.includes("/check-suites?")) body = { total_count: 0, check_suites: [] };
      else if (path.includes("/actions/runs?")) body = { total_count: 1, workflow_runs: [run] };
      else if (path.includes("/attempts/1/jobs?")) body = { total_count: 1, jobs: [job] };
      else throw Error("unexpected path");
      return { ok: true as const, body };
    }),
    latestAttempt: vi.fn(),
    observeLatestJob: vi.fn(async () => ({
      outcome: "success" as const,
      run_id: 2,
      workflow_id: policy.workflowId,
      attempt: 1,
      check_run_id: 4,
      job_id: 3,
      job_name: job.name,
      check_suite_id: 5,
      runner_labels: [],
      matrix: {},
      workflow_path: policy.workflowPath,
      head,
      base,
      app_id: policy.actionsAppId,
    })),
  };
  return { actions: { ci, policy }, query };
}

it("reads Actions only for the configured repository and forwards the target, signal and fact", async () => {
  const { config, head } = fixture();
  const { actions, query } = actionsFixture(head, "b".repeat(40), "repair", 7);
  const signal = new AbortController().signal;
  const adapter = vi.spyOn(attempts, "readActionsAttemptFact");
  const ports = createRecheckCollectorPorts({ ...config, actions });
  expect(Object.keys(ports).sort()).toEqual(["hostProof", "readActions"]);
  expect(ports.hostProof("unknown")).toBeNull();
  expect(await createRecheckCollectorPorts(config).readActions(query, signal)).toBeNull();
  expect(await ports.readActions({ ...query, repository: "other/repo" }, signal)).toBeNull();
  expect(await ports.readActions({ ...query, repository_id: 1 }, signal)).toBeNull();
  expect(adapter).not.toHaveBeenCalled();
  expect(actions.ci.rest).not.toHaveBeenCalled();
  const fact = await ports.readActions(query, signal);
  expect(fact).toMatchObject({ head_sha: head, conclusion: "success", complete: true });
  expect(adapter).toHaveBeenCalledWith(
    actions.ci,
    actions.policy,
    { pr: 7, head, base: query.base, branch: "repair" },
    { signal },
  );
  expect(fact).toBe(await adapter.mock.results[0]!.value);
});

it("passes the settled store proof unchanged to ledger evaluation", () => {
  const { d, config } = fixture();
  d.recordConfirmation();
  d.confirm();
  const row = d.open();
  const { runs, input, settle } = runFixture(d, row);
  const { run } = runs.reserve(input);
  settle(runs.start(run.run_id, run.revision));
  const issued = vi.spyOn(LocalFailureRecheckRunStore.prototype, "hostProof");
  const host = createRecheckCollectorPorts(config).hostProof(row.recheck_id);
  if (!host) throw Error("Expected a settled proof");
  expect(host).toBe(issued.mock.results[0]!.value);
  expect(d.ledger.evaluate({ recheck_id: row.recheck_id, now: d.now, host }).missing_json).toBe('["result","actions"]');
});

it("reaches the furthest D5a state: host_passed and reverify_pending with only the Watcher result missing", async () => {
  const { config, d, install, profile, head } = fixture();
  d.recordConfirmation();
  d.confirm();
  const row = d.open();
  runFixture(d, row);
  install();
  const ports = createRecheckRunPorts(config);
  const outcome = await runRecheck(
    {
      ...ports,
      prepare: async (options, files, installed, authorize) => {
        authorize();
        expect(files.map((f) => f.path)).toEqual(["data", "tool"]);
        return {
          binding: installed.binding,
          command: "fixture",
          argv_digest: sha("argv"),
          timeoutMs: 20000,
          outputLimits: { stdoutBytes: 500, stderrBytes: 500 },
          runtimeBlockers: [],
          image: {
            version: 1,
            daemonId: options.daemonId,
            baseImageId: options.baseImageId,
            imageId: "sha256:" + sha("image"),
            workingDirectory: "/osstack-candidate-" + randomUUID(),
            archiveDigest: sha("tar"),
            contentDigest: sha("files"),
            trustedProfile: {
              baseImageReference: profile.image,
              profileDigest: row.profile_digest,
              artifactDigest: installed.binding.trusted_source.artifact_digest,
              contentDigest: sha("harness"),
            },
          },
        };
      },
      run: async (plan, _host, { invocationId }) => {
        const stopReceipt = {
          version: 1 as const,
          kind: "docker_removed" as const,
          confirmedAt: config.now(),
          launch: {
            version: 1 as const,
            invocationId,
            specDigest: sha("spec"),
            daemonId: plan.image.daemonId,
            containerId: sha("container"),
            nonce: randomUUID(),
          },
        };
        const capture = { bytes: Buffer.alloc(0), observedBytes: 0, sha256: sha("") };
        return {
          identity: { ...plan, version: 1, kind: "contained_profile_run", invocationId },
          result: {
            status: "stopped",
            termination: "exited",
            started: true,
            exitCode: 0,
            oomKilled: false,
            reason: null,
            stdout: capture,
            stderr: capture,
            stopReceipt,
            evidence: "docker-removed:" + sha(JSON.stringify(stopReceipt)),
          },
        };
      },
    },
    row.recheck_id,
    "automatic",
    new AbortController().signal,
  );
  expect(outcome).toMatchObject({ status: "concluded", run: { conclusion_state: "host_passed" } });
  const { actions } = actionsFixture(head, row.base_sha, d.chain().branch, row.pr_number);
  const collector = createRecheckCollectorPorts({ ...config, actions });
  const collected = await collectLocalFailureRecheck(
    {
      ...collector,
      store: config.store,
      now: config.now,
      readOriginalContract: async () => d.f.input.contract_text,
      readRecheckContracts: async () => null,
    },
    d.dispatch.child_mission_id,
  );
  expect(collected.presented).toEqual({ result: false, actions: true, host: true });
  expect(d.ledger.get(row.recheck_id)).toMatchObject({ state: "reverify_pending", missing_json: '["result"]' });
});
