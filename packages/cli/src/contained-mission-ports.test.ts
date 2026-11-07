import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash, generateKeyPairSync } from "node:crypto";
import { dirname, join } from "node:path";
import { hardenedGitEnvironment } from "@osstack/agents";
import { AttentionStore, ContainedMissionStore, createScratchDirSync, openDb } from "@osstack/core";
import { parseMissionPatch } from "@osstack/governance";
import { afterEach, describe, expect, it } from "vitest";
import type { ContainedMissionSpec } from "./contained-mission-runner.js";
import { ensureHostProcessLedger, hostProcessOptions } from "./contained-mission-host-process.testkit.js";
import { containedVerifyInvocationId, createContainedMissionPorts, fencedDeliveryRunner, githubRepositoryOf, removalProven } from "./contained-mission-ports.js";

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach(fn => { fn(); }); });
const env = { ...hardenedGitEnvironment(process.env), GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
const AUTHOR = { name: "Mission Host", email: "host@example.invalid", date: "1700000000 +0000" };

function fixture() {
  const root = realpathSync(createScratchDirSync("tests", "contained-ports"));
  const repo = join(root, "repo"); mkdirSync(repo);
  const files: Record<string, string> = { "src/a.txt": "hi\n", "src/b.txt": "bye\n", "bin/run.sh": "#!/bin/sh\necho run\n", "README.md": "readme\n" };
  for (const [path, content] of Object.entries(files)) { mkdirSync(dirname(join(repo, path)), { recursive: true }); writeFileSync(join(repo, path), content); }
  chmodSync(join(repo, "bin/run.sh"), 0o755);
  sh(repo, "init", "-q", "-b", "main"); sh(repo, "add", "-A"); sh(repo, "commit", "-q", "-m", "initial");
  const start = sh(repo, "rev-parse", "HEAD");
  const path = join(root, "state.db"); const db = openDb({ path }); db.pragma("synchronous=FULL"); ensureHostProcessLedger(db);
  cleanup.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  db.exec("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','t','running',1,1)");
  const attention = new AttentionStore(db, path); const owner = attention.claimOwner("owner");
  const scope = attention.registerScope(owner, "t", root);
  const store = new ContainedMissionStore(attention, owner);
  const journalRoot = join(root, "journal"); mkdirSync(journalRoot);
  let clock = 1000;
  const ports = createContainedMissionPorts({ store, hostProcess: hostProcessOptions(root), now: () => ++clock, codex: { bin: join(root, "no-codex"), sourceCodexHome: root }, runtimeRoot: join(root, "runtime"),
    verification: { socketPath: join(root, "docker.sock"), daemonId: "d", baseImageId: "sha256:" + "0".repeat(64), journalRoot }, author: AUTHOR });
  const spec: ContainedMissionSpec = { goal: "g", repo_path: repo, base_ref: "main", start_commit: start, branch: "osstack/mission/t1", worktree_path: join(root, "worktrees", "mission-t1"),
    allowed_paths: ["src/**"], verify: { argv: ["true"] } };
  const principal = { principal_id: "human", client_session_id: "cli", read_scopes: [scope.scope_id], write_scopes: [scope.scope_id], stop_scopes: [], operator_scopes: [] };
  const authorizeOnce = () => store.authorize(principal, { scope_id: scope.scope_id, spec: spec as unknown as Record<string, unknown>, claim: { repo_identity: repo, branch: spec.branch, worktree_identity: spec.worktree_path } }, ++clock);
  let current: ReturnType<typeof authorizeOnce> | undefined;
  const authorize = () => (current ??= authorizeOnce());
  /** The Mission the direct port calls belong to (authorized on first use); fences never trip here. */
  const write = () => ({ mission_id: authorize().mission_id, fence: () => {} });
  return { root, repo, start, store, ports, spec, authorize, write, journalRoot, now: () => ++clock };
}
const signal = () => new AbortController().signal;
const indexDigest = (worktree: string) => createHash("sha256").update(readFileSync(join(sh(worktree, "rev-parse", "--absolute-git-dir"), "index"))).digest("hex");

describe("contained Mission ports: workspace", () => {
  it("creates a no-checkout worktree at start_commit and reports the common git dir", async () => {
    const f = fixture();
    const ws = await f.ports.createWorkspace(f.spec, signal(), f.write());
    expect(ws).toMatchObject({ worktree: f.spec.worktree_path, gitDir: realpathSync(join(f.repo, ".git")), head: f.start });
    expect(ws.configDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(readFileSync(join(ws.worktree, "src/a.txt"), "utf8")).toBe("hi\n");
    expect(sh(ws.worktree, "status", "--porcelain")).toBe("");
  });

  it("rejects a repository whose config declares a filter, before creating anything", async () => {
    const f = fixture();
    sh(f.repo, "config", "filter.x.clean", "cat");
    await expect(f.ports.createWorkspace(f.spec, signal(), f.write())).rejects.toThrow("CONTAINED_REPO_CONFIG_REJECTED:REPO_CONFIG_FILTER");
    expect(existsSync(f.spec.worktree_path)).toBe(false);
  });

  it("rejects a start_commit the repository does not have", async () => {
    const f = fixture();
    await expect(f.ports.createWorkspace({ ...f.spec, start_commit: "f".repeat(40) }, signal(), f.write())).rejects.toThrow("CONTAINED_START_COMMIT_MISSING");
  });
});

describe("contained Mission ports: files and commits", () => {
  it("reads files safely and maps a missing file to null", async () => {
    const f = fixture();
    const ws = await f.ports.createWorkspace(f.spec, signal(), f.write());
    expect(await f.ports.readFile(ws.worktree, "src/a.txt")).toBe("hi\n");
    expect(await f.ports.readFile(ws.worktree, "src/none.txt")).toBeNull();
    expect(await f.ports.readFile(ws.worktree, "nodir/none.txt")).toBeNull();
    symlinkSync(join(f.root, "outside"), join(ws.worktree, "src/link.txt"));
    await expect(f.ports.readFile(ws.worktree, "src/link.txt")).rejects.toThrow("SAFE_PATH_SYMLINK");
  });

  it("computes the cumulative diff on a temp index without touching worktree, index, HEAD or branch", async () => {
    const f = fixture();
    const ws = await f.ports.createWorkspace(f.spec, signal(), f.write());
    const before = { a: readFileSync(join(ws.worktree, "src/a.txt"), "utf8"), index: indexDigest(ws.worktree), head: sh(ws.worktree, "rev-parse", "HEAD"), status: sh(ws.worktree, "status", "--porcelain") };
    const diff = await f.ports.cumulativeDiff({ worktree: ws.worktree, startCommit: f.start, expectedHead: f.start,
      files: [{ path: "src/a.txt", action: "write", content: "hello\n" }, { path: "src/b.txt", action: "delete" }, { path: "src/new.txt", action: "write", content: "n\n" }] });
    const parsed = parseMissionPatch(diff);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) expect(parsed.files.map(file => [file.path, file.kind])).toEqual([["src/a.txt", "modify"], ["src/b.txt", "delete"], ["src/new.txt", "add"]]);
    expect(diff).toContain("+hello"); expect(diff).toContain("deleted file mode 100644"); expect(diff).toContain("new file mode 100644");
    expect({ a: readFileSync(join(ws.worktree, "src/a.txt"), "utf8"), index: indexDigest(ws.worktree), head: sh(ws.worktree, "rev-parse", "HEAD"), status: sh(ws.worktree, "status", "--porcelain") }).toEqual(before);
    expect(existsSync(join(ws.worktree, "src/new.txt"))).toBe(false);
    expect(sh(f.repo, "rev-parse", `refs/heads/${f.spec.branch}`)).toBe(f.start);
  });

  it("never runs a configured clean filter while hashing", async () => {
    const f = fixture();
    const ws = await f.ports.createWorkspace(f.spec, signal(), f.write());
    const canary = join(f.root, "canary");
    writeFileSync(join(ws.worktree, ".gitattributes"), "* filter=x\n");
    sh(f.repo, "config", "filter.x.clean", `touch "${canary}"; cat`);
    sh(f.repo, "config", "filter.x.process", `touch "${canary}"`);
    sh(f.repo, "config", "filter.x.required", "true");
    const diff = await f.ports.cumulativeDiff({ worktree: ws.worktree, startCommit: f.start, expectedHead: f.start, files: [{ path: "src/a.txt", action: "write", content: "hello\n" }] });
    expect(diff).toContain("+hello");
    expect(existsSync(canary)).toBe(false);
  });

  it("keeps an executable file's mode in the cumulative diff", async () => {
    const f = fixture();
    const ws = await f.ports.createWorkspace(f.spec, signal(), f.write());
    const diff = await f.ports.cumulativeDiff({ worktree: ws.worktree, startCommit: f.start, expectedHead: f.start, files: [{ path: "bin/run.sh", action: "write", content: "#!/bin/sh\necho ok\n" }] });
    expect(diff).toContain("index "); expect(diff).not.toContain("old mode");
  });

  it("commits with plumbing against the recorded config digest, keeping file modes", async () => {
    const f = fixture();
    const m = f.authorize();
    const ws = await f.ports.createWorkspace(f.spec, signal(), f.write());
    // Without a recorded workspace the commit has no digest to check and is refused.
    await expect(f.ports.commit({ mission_id: f.write().mission_id, worktree: ws.worktree, branch: f.spec.branch, expectedHead: f.start, files: [{ path: "src/a.txt", action: "write", content: "x\n" }], message: "m", fence: () => {} })).rejects.toThrow("CONTAINED_WORKSPACE_UNRECORDED");
    f.store.transition(m.mission_id, { if_revision: m.revision, to: "workspace_ready", event: { kind: "workspace_created", payload: { worktree: ws.worktree, git_dir: ws.gitDir, config_digest: ws.configDigest } } }, f.now());
    const files = [{ path: "src/a.txt", action: "write" as const, content: "hello\n" }, { path: "src/b.txt", action: "delete" as const }, { path: "bin/run.sh", action: "write" as const, content: "#!/bin/sh\necho ok\n" }];
    // The fence runs before each file and before the ref update; refusing at the last one leaves the branch where it was.
    let fences = 0;
    await expect(f.ports.commit({ mission_id: f.write().mission_id, worktree: ws.worktree, branch: f.spec.branch, expectedHead: f.start, message: "contained", files,
      fence: () => { if (++fences === files.length + 1) throw new Error("stale_owner"); } })).rejects.toThrow("stale_owner");
    expect(sh(f.repo, "rev-parse", `refs/heads/${f.spec.branch}`)).toBe(f.start);
    const commit = await f.ports.commit({ mission_id: f.write().mission_id, worktree: ws.worktree, branch: f.spec.branch, expectedHead: f.start, message: "contained", files, fence: () => {} });
    expect(sh(f.repo, "rev-parse", `refs/heads/${f.spec.branch}`)).toBe(commit.head);
    expect(sh(f.repo, "show", `${commit.head}:src/a.txt`)).toBe("hello");
    expect(sh(f.repo, "ls-tree", "--name-only", "-r", commit.head)).not.toContain("src/b.txt");
    expect(sh(f.repo, "ls-tree", commit.head, "bin/run.sh")).toMatch(/^100755 /);
    sh(f.repo, "config", "core.sshCommand", "evil");
    await expect(f.ports.commit({ mission_id: f.write().mission_id, worktree: ws.worktree, branch: f.spec.branch, expectedHead: commit.head, files: [{ path: "src/a.txt", action: "write", content: "x\n" }], message: "m", fence: () => {} })).rejects.toThrow("REPO_CONFIG_CHANGED");
  });
});

describe("contained Mission ports: verification", () => {
  it("accepts only a removal receipt whose evidence names it", () => {
    const launch = { version: 1, invocationId: "i", specDigest: "a".repeat(64), daemonId: "d", containerId: "b".repeat(64), nonce: "n" };
    const stopReceipt = { version: 1, kind: "docker_removed", launch, confirmedAt: 5 };
    const evidence = `docker-removed:${createHash("sha256").update(JSON.stringify(stopReceipt)).digest("hex")}`;
    expect(removalProven({ evidence, stopReceipt })).toBe(true);
    expect(removalProven({ evidence: "docker-removed:x", stopReceipt })).toBe(false);
    expect(removalProven({ evidence, stopReceipt: { ...stopReceipt, confirmedAt: 6 } })).toBe(false);
    expect(removalProven({ evidence })).toBe(false);
  });

  it("refuses to run when Docker is unavailable, so the runner holds stop_unknown", async () => {
    const f = fixture();
    let m = f.authorize();
    const ws = await f.ports.createWorkspace(f.spec, signal(), f.write());
    m = f.store.transition(m.mission_id, { if_revision: m.revision, to: "workspace_ready", event: { kind: "workspace_created", payload: { worktree: ws.worktree, git_dir: ws.gitDir, config_digest: ws.configDigest } } }, f.now());
    m = f.store.transition(m.mission_id, { if_revision: m.revision, to: "executing", expected_head: f.start, event: { kind: "executor_launch_intent", payload: {} } }, f.now());
    m = f.store.recordStopEvidence(m.mission_id, m.revision, { stop_proof: "never_launched" }, f.now());
    m = f.store.transition(m.mission_id, { if_revision: m.revision, to: "candidate_ready", expected_head: f.start, candidate: { head: f.start, tree: sh(f.repo, "rev-parse", `${f.start}^{tree}`), diff_digest: "c".repeat(64) }, event: { kind: "candidate_committed", payload: {} } }, f.now());
    m = f.store.transition(m.mission_id, { if_revision: m.revision, to: "verifying", event: { kind: "verify_intent", payload: {} } }, f.now());
    await expect(f.ports.verify(m, ["true"], signal())).rejects.toThrow();
    // The invocation was journaled but nothing reached Docker: recovery may prove it never launched.
    expect(f.store.events(m.mission_id, 0, 500).map(e => e.kind)).toContain("verify_invocation");
    expect(await f.ports.verificationStopped(f.store.get(m.mission_id))).toEqual({ stopped: true, proof: "never_launched", evidence: "journal_absent" });
    mkdirSync(join(f.journalRoot, createHash("sha256").update(containedVerifyInvocationId(m)).digest("hex")));
    expect(await f.ports.verificationStopped(f.store.get(m.mission_id))).toEqual({ stopped: false });
  });
});

describe("fencedDeliveryRunner", () => {
  it("fences every push and PR creation, hardens git and refuses PR-changing gh commands", async () => {
    const seen: Array<[string, readonly string[]]> = []; const fences: string[] = [];
    const inner = { run: async (command: string, args: readonly string[]) => { seen.push([command, args]); return { exitCode: 0, stdout: "", stderr: "" }; } };
    const runner = fencedDeliveryRunner(inner, kind => { fences.push(kind); });
    await runner.run("git", ["push", "origin", "x:refs/heads/b"], { cwd: "/", timeoutMs: 1 });
    await runner.run("gh", ["pr", "create", "--base", "main"], { cwd: "/", timeoutMs: 1 });
    await runner.run("gh", ["pr", "view", "1"], { cwd: "/", timeoutMs: 1 });
    expect(fences).toEqual(["push", "pr_create"]);
    expect(seen[0]![1]).toEqual(["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "protocol.ssh.allow=always", "push", "origin", "x:refs/heads/b"]);
    for (const sub of ["merge", "edit", "close", "ready", "review", "comment"]) await expect(runner.run("gh", ["pr", sub, "1"], { cwd: "/", timeoutMs: 1 })).rejects.toThrow("CONTAINED_PUBLICATION_FORBIDDEN");
    const refusing = fencedDeliveryRunner(inner, () => { throw new Error("CONTAINED_PUBLICATION_FENCE"); });
    const before = seen.length;
    await expect(refusing.run("git", ["push", "origin", "b"], { cwd: "/", timeoutMs: 1 })).rejects.toThrow("CONTAINED_PUBLICATION_FENCE");
    expect(seen.length).toBe(before);
  });
});

describe("githubRepositoryOf", () => {
  it("reads owner/name from github.com https, ssh and scp-like URLs only", () => {
    for (const url of ["https://github.com/o/r.git", "https://x-access-token@github.com/o/r", "git@github.com:o/r.git", "ssh://git@github.com/o/r", "https://github.com/o/r/"]) expect(githubRepositoryOf(url)).toBe("o/r");
    for (const url of ["https://evil.example/o/r.git", "git@gitlab.com:o/r.git", "https://github.com.evil/o/r", "file:///tmp/r", "https://github.com/o/r/extra"]) expect(githubRepositoryOf(url)).toBeUndefined();
  });
});

describe("contained Mission ports: publication destination", () => {
  async function prepared(configure: (repo: string) => void, specOver: Record<string, unknown> = {}) {
    const f = fixture(); configure(f.repo);
    const calls: Array<[string, readonly string[]]> = [];
    const ports = createContainedMissionPorts({ store: f.store, hostProcess: hostProcessOptions(f.root), now: f.now, codex: { bin: join(f.root, "no-codex"), sourceCodexHome: f.root }, runtimeRoot: join(f.root, "runtime"),
      verification: { socketPath: join(f.root, "docker.sock"), daemonId: "d", baseImageId: "sha256:" + "0".repeat(64), journalRoot: f.journalRoot }, author: AUTHOR,
      delivery: { runner: { run: async (command, args) => { calls.push([command, args]); throw new Error("stop-here"); } } } });
    const spec = { ...f.spec, publication: { remote: "origin", repository: "o/r", base: "main", draft: true }, ...specOver };
    let m = f.authorize();
    const ws = await ports.createWorkspace(spec, signal(), { mission_id: m.mission_id, fence: () => {} });
    m = f.store.transition(m.mission_id, { if_revision: m.revision, to: "workspace_ready", event: { kind: "workspace_created", payload: { worktree: ws.worktree, git_dir: ws.gitDir, config_digest: ws.configDigest } } }, f.now());
    const permit = { mission_id: m.mission_id, revision: m.revision, head: f.start, tree: "t", spec_digest: m.spec_digest };
    const publish = () => ports.publish({ mission: m, spec, permit, body: "b", beforeRemoteMutation: () => {}, signal: signal() });
    return { calls, publish };
  }
  it("refuses a remote whose push URL leaves the granted repository, before any push", async () => {
    const p = await prepared(repo => { sh(repo, "remote", "add", "origin", "https://github.com/o/r.git"); sh(repo, "remote", "set-url", "--add", "--push", "origin", "https://evil.example/x.git"); });
    await expect(p.publish()).rejects.toThrow("CONTAINED_PUBLICATION_DESTINATION");
    expect(p.calls).toEqual([]);
  });
  it("refuses a revision spec outright: this path opens PRs and never serves a publish_target, before any command runs", async () => {
    const target = { kind: "revision", chain_id: "rc_00000000-0000-4000-8000-000000000001", pr: 7, remote_branch: "topic", round: 1, chain_start_commit: "a".repeat(40) };
    const p = await prepared(repo => { sh(repo, "remote", "add", "origin", "git@github.com:o/r.git"); }, { publish_target: target });
    await expect(p.publish()).rejects.toThrow("CONTAINED_PUBLISH_TARGET_REQUIRES_REVISION");
    expect(p.calls).toEqual([]);
  });
  it("proceeds to delivery when every push URL is the granted repository", async () => {
    const p = await prepared(repo => { sh(repo, "remote", "add", "origin", "git@github.com:o/r.git"); });
    await expect(p.publish()).rejects.toThrow("stop-here");
    expect(p.calls.length).toBeGreaterThan(0);
  });
});

describe("fencedDeliveryRunner destination", () => {
  it("re-resolves every push URL with the push's own configuration and refuses a rewrite away from the grant", async () => {
    const pushes: string[][] = [];
    const inner = (pushUrl: string) => ({ run: async (_c: string, args: readonly string[]) => {
      const a = args.filter((_, i) => i >= 10);
      if (a[0] === "remote" && a[1] === "get-url") return { exitCode: 0, stdout: `${pushUrl}\n`, stderr: "" };
      if (a[0] === "push") pushes.push([...a]);
      return { exitCode: 0, stdout: "", stderr: "" };
    } });
    const evil = fencedDeliveryRunner(inner("https://evil.example/o/r.git"), () => {}, { remote: "origin", repository: "o/r" });
    await expect(evil.run("git", ["push", "origin", "x:refs/heads/b"], { cwd: "/", timeoutMs: 1 })).rejects.toThrow("CONTAINED_PUBLICATION_DESTINATION");
    expect(pushes).toEqual([]);
    const good = fencedDeliveryRunner(inner("git@github.com:O/R.git"), () => {}, { remote: "origin", repository: "o/r" });
    await good.run("git", ["push", "origin", "x:refs/heads/b"], { cwd: "/", timeoutMs: 1 });
    expect(pushes).toEqual([["push", "origin", "x:refs/heads/b"]]);
  });
  it("in bridge mode refuses, at push time, a push URL that is no longer https", async () => {
    const pushes: string[][] = [];
    const inner = (pushUrl: string) => ({ run: async (_c: string, args: readonly string[]) => {
      const a = args.filter((_, i) => i >= 10);
      if (a[0] === "remote" && a[1] === "get-url") return { exitCode: 0, stdout: `${pushUrl}\n`, stderr: "" };
      if (a[0] === "push") pushes.push([...a]);
      return { exitCode: 0, stdout: "", stderr: "" };
    } });
    const switched = fencedDeliveryRunner(inner("git@github.com:o/r.git"), () => {}, { remote: "origin", repository: "o/r", httpsOnly: true });
    await expect(switched.run("git", ["push", "origin", "x:refs/heads/b"], { cwd: "/", timeoutMs: 1 })).rejects.toThrow("CONTAINED_BRIDGE_REQUIRES_HTTPS");
    expect(pushes).toEqual([]);
    const https = fencedDeliveryRunner(inner("https://github.com/o/r.git"), () => {}, { remote: "origin", repository: "o/r", httpsOnly: true });
    await https.run("git", ["push", "origin", "x:refs/heads/b"], { cwd: "/", timeoutMs: 1 });
    expect(pushes).toEqual([["push", "origin", "x:refs/heads/b"]]);
  });
});

describe("contained Mission ports: GitHub Apps bridge (App A)", () => {
  const PUB = "ghs_PUBLISHERTOKEN0001";
  const REPO = "acme/widgets";
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const rule = (type: string, id: number) => ({ type, ruleset_id: id, ruleset_source_type: "Repository", ruleset_source: REPO });
  const missionRules = [rule("deletion", 5), rule("non_fast_forward", 5), rule("creation", 6), rule("update", 6)];
  const stripC = (args: readonly string[]) => { let i = 0; while (args[i] === "-c") i += 2; return args.slice(i); };

  async function bridged(opts: { remoteUrl?: string; repository?: string; rules?: unknown[]; disabled?: boolean; configRepository?: string } = {}) {
    const f = fixture();
    const remoteUrl = opts.remoteUrl ?? `https://github.com/${REPO}.git`;
    sh(f.repo, "remote", "add", "origin", remoteUrl);
    const key = join(f.root, "key.pem"); writeFileSync(key, privateKey.export({ type: "pkcs8", format: "pem" }).toString(), { mode: 0o600 });
    const repository = opts.repository ?? REPO;
    const inner: Array<[string, readonly string[]]> = []; const executed: Array<{ command: string; args: readonly string[]; env: NodeJS.ProcessEnv }> = [];
    const order: string[] = []; let tokenCalls = 0; let prCreated = false;
    const spec = { ...f.spec, publication: { remote: "origin", repository, base: "main", draft: false } };
    const out = (stdout = "", exitCode = 0) => ({ stdout, stderr: "", exitCode });
    const innerRunner = { run: async (command: string, args: readonly string[]) => {
      inner.push([command, args]); const a = stripC(args);
      if (command === "gh" && a[0] === "auth") return out("ok");
      if (command === "gh" && a[0] === "repo") return out(JSON.stringify({ nameWithOwner: repository }));
      if (command === "gh" && a[0] === "api") return a.some(x => x.includes("/rules/branches/")) ? out(JSON.stringify(opts.rules ?? missionRules)) : { stdout: "", stderr: "HTTP 404: Branch not protected", exitCode: 1 };
      if (command === "gh" && a[0] === "pr" && a[1] === "view") {
        if (!prCreated) return { stdout: "", stderr: "no pull requests found", exitCode: 1 };
        const all: Record<string, unknown> = { number: 9, url: `https://github.com/${repository}/pull/9`, headRefOid: f.start, state: "OPEN", isDraft: false, baseRefName: "main", headRefName: spec.branch };
        return out(JSON.stringify(Object.fromEntries(String(a[a.indexOf("--json") + 1]).split(",").map(k => [k, all[k]]))));
      }
      if (command === "git" && a[0] === "branch") return out(`${spec.branch}\n`);
      if (command === "git" && a[0] === "status") return out("");
      if (command === "git" && a[0] === "remote") return out(`${remoteUrl}\n`);
      if (command === "git" && a[0] === "rev-parse") return out(`${f.start}\n`);
      if (command === "git" && a[0] === "ls-remote") return out(`${f.start}\trefs/heads/${a[3] ?? "main"}\n`);
      return out("");
    } };
    const exec = async (command: string, args: readonly string[], options: { env: NodeJS.ProcessEnv }) => {
      executed.push({ command, args, env: options.env });
      if (command === "gh") { prCreated = true; return { stdout: `https://github.com/${repository}/pull/9\n`, stderr: "", exitCode: 0 }; }
      return { stdout: "pushed", stderr: "", exitCode: 0 };
    };
    const fetchImpl = (async (url: string, init: RequestInit) => {
      if (/access_tokens$/.test(url)) { tokenCalls++; const body = JSON.parse(String(init.body)); return new Response(JSON.stringify({ token: PUB, expires_at: new Date(1_800_003_600_000).toISOString(), permissions: { ...body.permissions, metadata: "read" }, repositories: [{ full_name: REPO }] }), { status: 201 }); }
      return new Response("{}", { status: 404 });
    }) as unknown as typeof fetch;
    const config = { repository: opts.configRepository ?? REPO, publisher: { app_id: 11, installation_id: 21, private_key_path: key }, evidence: { app_id: 12, installation_id: 22, private_key_path: key }, mission_ruleset_ids: [5, 6] };
    const ports = createContainedMissionPorts({ store: f.store, hostProcess: hostProcessOptions(f.root), now: f.now, codex: { bin: join(f.root, "no-codex"), sourceCodexHome: f.root }, runtimeRoot: join(f.root, "runtime"),
      verification: { socketPath: join(f.root, "docker.sock"), daemonId: "d", baseImageId: "sha256:" + "0".repeat(64), journalRoot: f.journalRoot }, author: AUTHOR,
      delivery: { runner: innerRunner }, bridge: { config, exec, fetchImpl, now: () => 1_800_000_000_000, ...(opts.disabled ? { disabled: true } : {}) } });
    let m = f.authorize();
    const ws = await ports.createWorkspace(spec, signal(), { mission_id: m.mission_id, fence: () => {} });
    m = f.store.transition(m.mission_id, { if_revision: m.revision, to: "workspace_ready", event: { kind: "workspace_created", payload: { worktree: ws.worktree, git_dir: ws.gitDir, config_digest: ws.configDigest } } }, f.now());
    const permit = { mission_id: m.mission_id, revision: m.revision, head: f.start, tree: "t", spec_digest: m.spec_digest };
    const publish = () => ports.publish({ mission: m, spec, permit, body: "b", beforeRemoteMutation: kind => { order.push(`fence:${kind}`); }, signal: signal() });
    const labelled = () => [...executed.map(e => e.command + ":" + stripC(e.args).slice(0, 2).join(" "))];
    return { f, publish, inner, executed, order, tokenCalls: () => tokenCalls, labelled, ports };
  }

  it("pushes and opens the PR with App A: token only in the child env, reads on host credentials, fence first", async () => {
    const b = await bridged();
    const done = await b.publish();
    expect(done.pr.number).toBe(9);
    const push = b.executed.find(e => e.command === "git")!; const create = b.executed.find(e => e.command === "gh")!;
    expect(push.args.slice(0, 2)).toEqual(["-c", "credential.helper="]);
    expect(push.args.join("\n")).not.toContain(PUB);
    expect(push.env["OSSTACK_BRIDGE_PUSH_TOKEN"]).toBe(PUB);
    expect(create.env["GH_TOKEN"]).toBe(PUB); expect(create.env["GITHUB_TOKEN"]).toBeUndefined();
    expect(b.order).toEqual(["fence:push", "fence:pr_create"]);
    // Reads never carry the token and none of them is a push or pr create.
    const innerText = JSON.stringify(b.inner);
    expect(innerText).not.toContain(PUB);
    expect(b.inner.some(([c, a]) => c === "gh" && a[0] === "auth")).toBe(true);
    expect(b.inner.some(([c, a]) => c === "gh" && a[0] === "api" && a.some(x => x.includes("/protection")))).toBe(true);
    expect(b.inner.some(([c, a]) => c === "git" && stripC(a)[0] === "push")).toBe(false);
    expect(b.inner.some(([c, a]) => c === "gh" && a[0] === "pr" && a[1] === "create")).toBe(false);
    // Remote config on disk never holds the token.
    expect(sh(b.f.repo, "config", "--list")).not.toContain(PUB);
    expect(b.tokenCalls()).toBe(1);
  });

  it("passes the Mission ruleset ids: an unregistered ruleset on the branch still refuses before any push", async () => {
    const b = await bridged({ rules: [...missionRules, rule("pull_request", 77)] });
    await expect(b.publish()).rejects.toThrow("protected candidate branch");
    expect(b.executed).toEqual([]);
    expect(b.order).toEqual([]);
  });

  it("rejects an ssh remote in App mode before anything is pushed or any token is minted", async () => {
    for (const remoteUrl of [`git@github.com:${REPO}.git`, `ssh://git@github.com/${REPO}.git`, `https://user@github.com/${REPO}.git`]) {
      const b = await bridged({ remoteUrl });
      await expect(b.publish()).rejects.toThrow("CONTAINED_BRIDGE_REQUIRES_HTTPS");
      expect(b.inner).toEqual([]); expect(b.executed).toEqual([]); expect(b.tokenCalls()).toBe(0);
    }
  });

  it("another repository is refused with CONTAINED_BRIDGE_REPOSITORY before any runner, token, push or PR", async () => {
    const b = await bridged({ repository: "o/r", remoteUrl: "git@github.com:o/r.git", rules: missionRules });
    await expect(b.publish()).rejects.toThrow("CONTAINED_BRIDGE_REPOSITORY");
    expect(b.tokenCalls()).toBe(0); expect(b.executed).toEqual([]); expect(b.inner).toEqual([]); expect(b.order).toEqual([]);
  });

  it("matches the configured repository case-insensitively", async () => {
    const b = await bridged({ repository: "Acme/Widgets" });
    await expect(b.publish()).resolves.toMatchObject({ pr: { number: 9 } });
    expect(b.tokenCalls()).toBe(1);
  });

  it("kill switch (OSSTACK_BRIDGE=0): the configured repository is refused with BRIDGE_DISABLED before any token, runner, push, PR or check", async () => {
    const b = await bridged({ disabled: true });
    await expect(b.publish()).rejects.toThrow("BRIDGE_DISABLED");
    expect(b.tokenCalls()).toBe(0); expect(b.executed).toEqual([]); expect(b.inner).toEqual([]); expect(b.order).toEqual([]);
    expect(b.ports.publishVerifyCheck).toBeUndefined();
  });

  it("kill switch: a repository outside the bridge config keeps its current refusal (CONTAINED_BRIDGE_REPOSITORY), never host credentials", async () => {
    const b = await bridged({ disabled: true, configRepository: "other/repo" });
    await expect(b.publish()).rejects.toThrow("CONTAINED_BRIDGE_REPOSITORY");
    expect(b.tokenCalls()).toBe(0); expect(b.executed).toEqual([]); expect(b.inner).toEqual([]);
  });

  it("without the kill switch the verify-check port stays present", async () => {
    const b = await bridged();
    expect(typeof b.ports.publishVerifyCheck).toBe("function");
  });
});
