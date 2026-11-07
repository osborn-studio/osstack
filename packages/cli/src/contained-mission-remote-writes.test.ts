// W13-C2: remote writes (git push, gh pr create) through the gated launcher, App-mode transport isolation, and the static
// guarantee that no other path can write to the remote. Real pushes go to a local bare repository (no network); real-process
// cases run on macOS only (the CI machine is Linux).
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { HostProcessUnprovenError, hardenedGitEnvironment, type HostProcessProbe } from "@osstack/agents";
import { AttentionStore, ContainedMissionStore, createScratchDirSync, openDb, type ContainedMission } from "@osstack/core";
import type { DeliveryCommandRunner } from "@osstack/github";
import { afterEach, describe, expect, it } from "vitest";
import { appCredentialRunner } from "./contained-mission-bridge.js";
import { HostProcessKit } from "./contained-mission-host-process.js";
import { ensureHostProcessLedger, hostProcessOptions } from "./contained-mission-host-process.testkit.js";
import { fencedDeliveryRunner } from "./contained-mission-ports.js";
import { TransportUnsupportedError, appTransportConfig, gatedBridgeExec, gatedHostRunner, remoteBranchOf, remoteTargetOf, transportConfigOf } from "./contained-mission-remote-writes.js";

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(fn => { fn(); }); });
const env = { ...hardenedGitEnvironment(process.env), GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.invalid" };
const sh = (cwd: string, ...args: string[]) => execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();
const REAL_GIT = execFileSync("/usr/bin/which", ["git"], { encoding: "utf8" }).trim();
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const prCreate = (head: string) => ["pr", "create", "--base", "main", "--head", head, "--title", "t", "--body-file", "/dev/null"];
const darwin = process.platform === "darwin";

function rig(options: { probe?: HostProcessProbe } = {}) {
  const root = realpathSync(createScratchDirSync("tests", "remote-writes"));
  const bare = join(root, "remote.git"); mkdirSync(bare); sh(bare, "init", "-q", "--bare", "-b", "main");
  const repo = join(root, "repo"); mkdirSync(repo);
  writeFileSync(join(repo, "a.txt"), "hi\n");
  sh(repo, "init", "-q", "-b", "main"); sh(repo, "add", "-A"); sh(repo, "commit", "-q", "-m", "initial");
  sh(repo, "remote", "add", "origin", bare);
  const head = sh(repo, "rev-parse", "HEAD");
  // git double: reports the granted https URL for the destination re-check, allows the file protocol for the local bare repo,
  // logs every push it actually executes, and can be held while `hold` exists.
  const ran = join(root, "pushes.log"); const hold = join(root, "hold");
  const gitBin = join(root, "git-double.sh");
  writeFileSync(gitBin, `#!/bin/sh
for a in "$@"; do
  if [ "$a" = get-url ]; then echo https://github.com/o/r.git; exit 0; fi
  if [ "$a" = push ]; then echo "$$" >> ${JSON.stringify(ran)}; while [ -e ${JSON.stringify(hold)} ]; do sleep 0.05; done; fi
done
exec ${REAL_GIT} -c protocol.file.allow=always "$@"
`);
  chmodSync(gitBin, 0o755);
  const ghBin = join(root, "gh-double.sh");
  writeFileSync(ghBin, `#!/bin/sh\necho "$$" >> ${JSON.stringify(join(root, "gh.log"))}\necho https://github.com/o/r/pull/7\n`);
  chmodSync(ghBin, 0o755);

  const path = join(root, "state.db"); const db = openDb({ path }); db.pragma("synchronous=FULL"); ensureHostProcessLedger(db);
  cleanup.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  db.exec("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','t','running',1,1)");
  const attention = new AttentionStore(db, path); const owner = attention.claimOwner("owner");
  const scope = attention.registerScope(owner, "t", root);
  const store = new ContainedMissionStore(attention, owner);
  let clock = 1000;
  const principal = { principal_id: "human", client_session_id: "cli", read_scopes: [scope.scope_id], write_scopes: [scope.scope_id], stop_scopes: [], operator_scopes: [] };
  const mission = (branch: string): ContainedMission => {
    const spec = { goal: "g", repo_path: repo, base_ref: "main", start_commit: head, branch, worktree_path: join(root, "worktrees", branch.replace(/\//g, "_")), allowed_paths: ["src/**"], verify: { argv: ["true"] } };
    return store.authorize(principal, { scope_id: scope.scope_id, spec: spec as unknown as Record<string, unknown>, claim: { repo_identity: repo, branch, worktree_identity: spec.worktree_path } }, ++clock);
  };
  const kit = new HostProcessKit(store, hostProcessOptions(root, options.probe ? { probe: options.probe } : {}), () => ++clock);
  const binaries = { git: gitBin, gh: ghBin };
  const rows = () => db.prepare("SELECT op_id,mission_id,kind,state,remote_target,intent_id,released_at,stop_proof FROM engineering_host_processes ORDER BY created_at,op_id").all() as
    Array<{ op_id: string; mission_id: string; kind: string; state: string; remote_target: string; intent_id: string | null; released_at: number | null; stop_proof: string | null }>;
  const fenced = (missionId: string, fence: (kind: "push" | "pr_create") => void = () => {}) =>
    fencedDeliveryRunner(gatedHostRunner(kit, binaries), fence, { remote: "origin", repository: "O/R", missionId });
  const refs = () => sh(bare, "for-each-ref", "--format=%(refname) %(objectname)");
  const pushArgs = (branch: string) => ["push", "origin", `${head}:refs/heads/${branch}`];
  return { root, bare, repo, head, db, store, kit, binaries, mission, rows, fenced, refs, pushArgs, ran, hold, path, ghLog: join(root, "gh.log"), now: () => ++clock };
}

describe("remote write targets", () => {
  it("names the remote branch of a push refspec and of gh --head, and nothing else", () => {
    const sha = "a".repeat(40);
    expect(remoteBranchOf("git", ["push", "origin", `${sha}:refs/heads/osstack/mission/x`])).toBe("osstack/mission/x");
    expect(remoteBranchOf("git", ["push", "--porcelain", "--force-with-lease=refs/heads/b:" + sha, "origin", `${sha}:refs/heads/b`])).toBe("b");
    expect(remoteBranchOf("git", ["push", "origin", "b"])).toBeUndefined();
    expect(remoteBranchOf("git", ["push", "origin", `${sha}:refs/heads/a`, `${sha}:refs/heads/b`])).toBeUndefined();
    expect(remoteBranchOf("gh", ["pr", "create", "--base", "main", "--head", "topic"])).toBe("topic");
    expect(remoteTargetOf("Acme/Widgets", "Topic")).toBe("acme/widgets#refs/heads/Topic");
  });
});

describe("a gated remote write that never launches", () => {
  it("per-remote-branch uniqueness: a second Mission cannot push a branch that has an open record, and the command never runs", () => {
    const r = rig();
    const a = r.mission("osstack/mission/a"); const b = r.mission("osstack/mission/b");
    // Mission A holds an unproven, released record on the shared remote branch (a crashed daemon's push).
    r.kit.hp.launching({ op_id: "hp_" + "1".repeat(32), mission_id: a.mission_id, kind: "git_push", remote_target: "o/r#refs/heads/shared", local_target: "x", argv_digest: "d".repeat(64), boot_id: "b", marker: { path: join(r.root, "m1"), dev: "1", ino: "2" } });
    r.kit.hp.registered("hp_" + "1".repeat(32), { pid: 4242, pgid: 4242, leader_start: null });
    r.kit.hp.release("hp_" + "1".repeat(32), () => {});
    return expect((async () => {
      await expect(r.fenced(b.mission_id).run("git", r.pushArgs("shared"), { cwd: r.repo, timeoutMs: 20_000 })).rejects.toThrow("CONTAINED_REMOTE_BRANCH_BUSY");
      expect(existsSync(r.ran)).toBe(false);
      expect(r.refs()).toBe("");
      expect(r.rows().filter(row => row.mission_id === b.mission_id)).toEqual([]);
      // the same holds for the Mission's own second write, and for gh pr create on that branch
      await expect(r.fenced(b.mission_id).run("gh", prCreate("shared"), { cwd: r.repo, timeoutMs: 20_000 })).rejects.toThrow("CONTAINED_REMOTE_BRANCH_BUSY");
      expect(existsSync(r.ghLog)).toBe(false);
    })()).resolves.toBeUndefined();
  });

  it("an ungated runner is refused for writes and never runs", async () => {
    const r = rig(); const m = r.mission("osstack/mission/a");
    const calls: string[] = [];
    const ungated: DeliveryCommandRunner = { run: async (c, a) => { calls.push(`${c} ${a.join(" ")}`); return { exitCode: 0, stdout: "https://github.com/o/r.git\n", stderr: "" }; } };
    const runner = fencedDeliveryRunner(ungated, () => { calls.push("fence"); }, { remote: "origin", repository: "o/r", missionId: m.mission_id });
    await expect(runner.run("git", r.pushArgs("b"), { cwd: r.repo, timeoutMs: 1 })).rejects.toThrow("CONTAINED_PUBLICATION_UNGATED");
    await expect(runner.run("gh", ["pr", "create", "--head", "b"], { cwd: r.repo, timeoutMs: 1 })).rejects.toThrow("CONTAINED_PUBLICATION_UNGATED");
    expect(calls).toEqual([]);
    expect(r.rows()).toEqual([]);
    // the bridge launcher refuses a write that carries no gate, too
    await expect(gatedBridgeExec(r.kit, r.binaries)("git", ["push"], { cwd: r.repo, timeoutMs: 1, env: {} })).rejects.toThrow("CONTAINED_PUBLICATION_UNGATED");
  });
});

describe.skipIf(!darwin)("real remote writes (macOS, local bare repository)", () => {
  it("every remote write leaves a released and stopped row; stopped is committed before the call returns; the op id is not the intent id", { timeout: 60_000 }, async () => {
    const r = rig(); const m = r.mission("osstack/mission/a");
    const fences: string[] = [];
    const runner = r.fenced(m.mission_id, kind => { fences.push(kind); });
    const pushed = await runner.run("git", r.pushArgs("topic"), { cwd: r.repo, timeoutMs: 30_000, intentId: "ri_00000000000000000000000000000001" });
    expect(pushed.exitCode).toBe(0);
    expect(r.refs()).toBe(`refs/heads/topic ${r.head}`);
    expect(r.db.inTransaction).toBe(false);
    const created = await runner.run("gh", prCreate("topic"), { cwd: r.repo, timeoutMs: 30_000 });
    expect(created.stdout).toContain("/pull/7");
    expect(fences).toEqual(["push", "pr_create"]);
    const rows = r.rows();
    expect(rows.map(x => [x.kind, x.state, x.stop_proof, x.remote_target])).toEqual([
      ["git_push", "stopped", "group_empty+marker_unheld", "o/r#refs/heads/topic"], ["gh_pr_create", "stopped", "group_empty+marker_unheld", "o/r#refs/heads/topic"]]);
    expect(rows.every(x => x.released_at !== null)).toBe(true);
    expect(pushed.opId).toBe(rows[0]!.op_id);
    expect(rows[0]!.intent_id).toBe("ri_00000000000000000000000000000001");
    expect(rows[0]!.op_id).not.toBe(rows[0]!.intent_id);
    expect(r.kit.recordForIntent("ri_00000000000000000000000000000001")?.op_id).toBe(rows[0]!.op_id);
    expect(r.kit.remoteReleasedSince(m.mission_id, 0)).toBe(true);
    expect(r.kit.hasOpen(m.mission_id)).toBe(false);
    expect(readdirSync(join(r.root, "host-processes"))).toEqual([]);
    // an intent is bound to at most one record
    await expect(runner.run("git", r.pushArgs("topic2"), { cwd: r.repo, timeoutMs: 30_000, intentId: "ri_00000000000000000000000000000001" })).rejects.toThrow("host_process_intent_reused");
    expect(r.refs()).toBe(`refs/heads/topic ${r.head}`);
  });

  it("a repository's own push.followTags cannot widen the push beyond its one refspec", { timeout: 60_000 }, async () => {
    const r = rig(); const m = r.mission("osstack/mission/a");
    sh(r.repo, "config", "push.followTags", "true"); sh(r.repo, "tag", "-a", "v1", "-m", "release");
    await r.fenced(m.mission_id).run("git", r.pushArgs("topic"), { cwd: r.repo, timeoutMs: 30_000 });
    expect(r.refs()).toBe(`refs/heads/topic ${r.head}`);
  });

  it("fence refusal: the command never runs, the row is stopped as never released and no remote ref appears", { timeout: 60_000 }, async () => {
    const r = rig(); const m = r.mission("osstack/mission/a");
    const runner = r.fenced(m.mission_id, () => { throw Error("CONTAINED_PUBLICATION_FENCE"); });
    await expect(runner.run("git", r.pushArgs("topic"), { cwd: r.repo, timeoutMs: 30_000 })).rejects.toThrow("CONTAINED_PUBLICATION_FENCE");
    await expect(runner.run("gh", prCreate("topic"), { cwd: r.repo, timeoutMs: 30_000 })).rejects.toThrow("CONTAINED_PUBLICATION_FENCE");
    expect(existsSync(r.ran)).toBe(false); expect(existsSync(r.ghLog)).toBe(false);
    expect(r.refs()).toBe("");
    expect(r.rows().map(x => [x.kind, x.state, x.stop_proof, x.released_at])).toEqual([["git_push", "stopped", "never_released", null], ["gh_pr_create", "stopped", "never_released", null]]);
    expect(r.kit.remoteReleasedSince(m.mission_id, 0)).toBe(false);
  });

  it("abort during a push kills the process group, proves the stop and leaves a released, stopped row with nothing pushed", { timeout: 60_000 }, async () => {
    const r = rig(); const m = r.mission("osstack/mission/a");
    writeFileSync(r.hold, "");
    const controller = new AbortController();
    const running = r.fenced(m.mission_id).run("git", r.pushArgs("topic"), { cwd: r.repo, timeoutMs: 60_000, signal: controller.signal });
    for (let i = 0; i < 200 && !existsSync(r.ran); i++) await sleep(50);
    expect(existsSync(r.ran)).toBe(true);
    expect(r.rows()[0]).toMatchObject({ state: "released" });
    controller.abort();
    await expect(running).rejects.toThrow("CONTAINED_PUBLICATION_ABORTED");
    expect(r.rows()[0]).toMatchObject({ state: "stopped", stop_proof: "group_empty+marker_unheld" });
    expect(r.rows()[0]!.released_at).not.toBeNull();
    expect(r.refs()).toBe("");
    expect(r.kit.hasOpen(m.mission_id)).toBe(false);
  });

  it("an abort before the release never runs the command", { timeout: 60_000 }, async () => {
    const r = rig(); const m = r.mission("osstack/mission/a");
    const controller = new AbortController(); controller.abort();
    await expect(r.fenced(m.mission_id).run("git", r.pushArgs("topic"), { cwd: r.repo, timeoutMs: 30_000, signal: controller.signal })).rejects.toThrow("CONTAINED_PUBLICATION_ABORTED");
    expect(existsSync(r.ran)).toBe(false);
    expect(r.refs()).toBe("");
  });

  it("a stop that cannot be proven surfaces as HostProcessUnprovenError and leaves the row released (the Mission must stop in stop_unknown)", { timeout: 60_000 }, async () => {
    const probe: HostProcessProbe = { bootSession: () => null, groupPresent: () => true, leader: () => null, markerIdentity: () => "ok", markerHeld: () => false };
    const r = rig({ probe }); const m = r.mission("osstack/mission/a");
    await expect(r.fenced(m.mission_id).run("git", r.pushArgs("topic"), { cwd: r.repo, timeoutMs: 30_000 })).rejects.toBeInstanceOf(HostProcessUnprovenError);
    expect(r.rows()[0]).toMatchObject({ state: "released" });
    expect(r.kit.hasOpen(m.mission_id)).toBe(true);
    expect(r.kit.remoteReleasedSince(m.mission_id, 0)).toBe(true);
  });

  describe("T3 for a push: the daemon is SIGKILLed at each protocol step", () => {
    for (const step of ["after_launching", "after_spawn", "after_registered", "after_release_commit"] as const) {
      it(`${step}: no push is ever executed`, { timeout: 60_000 }, async () => {
        const r = rig(); const m = r.mission("osstack/mission/a");
        const script = join(r.root, "crash-child.mjs");
        writeFileSync(script, `const [core, hp, sqlite, dbPath, markerDir, git, repo, spec, missionId] = process.argv.slice(2);
const { AttentionStore, HostProcessStore } = await import(core);
const Database = (await import(sqlite)).default;
const { runGatedProcess, argvDigest, currentBootSession } = await import(hp);
const db = new Database(dbPath); db.pragma("synchronous=FULL"); db.pragma("foreign_keys=ON"); db.pragma("busy_timeout=5000");
const attention = new AttentionStore(db, dbPath); const owner = attention.claimOwner("child");
const journal = new HostProcessStore(attention, owner);
const args = ["push", "origin", spec];
await runGatedProcess(git, args, { cwd: repo, env: { PATH: process.env.PATH, HOME: process.env.HOME }, timeoutMs: 20000, maxOutputBytes: 1024, journal, markerDir,
  launch: { mission_id: missionId, kind: "git_push", remote_target: "o/r#refs/heads/topic", local_target: "t", argv_digest: argvDigest(git, args), boot_id: currentBootSession() ?? "unknown" },
  fence: () => {}, onStep: s => { if (s === process.env.CRASH_AT) process.kill(process.pid, "SIGKILL"); } });
`);
        const child = spawn(process.execPath, [script, pathToFileURL(new URL("../../core/dist/index.js", import.meta.url).pathname).href, pathToFileURL(new URL("../../agents/dist/contained-workspace/host-process.js", import.meta.url).pathname).href,
          pathToFileURL(createRequire(new URL("../../core/package.json", import.meta.url)).resolve("better-sqlite3")).href,
          r.path, join(r.root, "host-processes"), r.binaries.git, r.repo, `${r.head}:refs/heads/topic`, m.mission_id], { env: { ...process.env, CRASH_AT: step }, stdio: "ignore" });
        expect(await new Promise<string | null>(resolve => child.once("exit", (_c, s) => resolve(s)))).toBe("SIGKILL");
        await sleep(1200);
        expect(existsSync(r.ran)).toBe(false);
        expect(r.refs()).toBe("");
        const row = r.rows()[0]!;
        expect(row.state).not.toBe("stopped");
        expect(row.released_at !== null).toBe(step === "after_release_commit");
      });
    }
  });
});

describe("App mode transport isolation (preflight)", () => {
  const entry = (key: string, value: string | null = "v") => ({ scope: "global", origin: "file:/x", key, value });
  it("pins only whitelisted proxy and CA settings, global or scoped to exactly https://github.com/", () => {
    expect(transportConfigOf([entry("http.proxy", "http://proxy.local:3128"), entry("http.sslcainfo", "/etc/ca.pem"), entry("http.https://github.com/.sslcapath", "/etc/cas"), entry("user.name", "x"),
      entry("http.https://example.com/.proxy", "http://other.local")])).toEqual(["-c", "http.proxy=http://proxy.local:3128", "-c", "http.sslcainfo=/etc/ca.pem", "-c", "http.https://github.com/.sslcapath=/etc/cas"]);
    expect(transportConfigOf([])).toEqual([]);
    expect(transportConfigOf([entry("http.postbuffer", "1"), entry("http.sslverify", "false") && entry("http.https://other.example/.sslverify", "false")])).toEqual([]);
    expect(transportConfigOf([entry("http.proxy", "http://a"), entry("http.proxy", "http://b")])).toEqual(["-c", "http.proxy=http://b"]);
  });
  it.each([
    ["url_rewrite", "url.git@github.com:.insteadof", "https://github.com/"],
    ["url_rewrite", "url.https://evil.example/.pushinsteadof", "https://github.com/"],
    ["extra_header", "http.extraheader", "Authorization: x"],
    ["extra_header", "http.https://github.com/.extraheader", "X: y"],
    ["ssh_command", "core.sshcommand", "ssh -i k"],
    ["git_proxy", "core.gitproxy", "p"],
    ["scoped_transport", "http.https://github.com/o/r.proxy", "http://p"],
    ["scoped_transport", "http.https://*.com/.proxy", "http://p"],
    ["proxy_credentials", "http.proxy", "http://user:secret@proxy.local:3128"],
    ["proxy_credentials", "http.proxy", "user:secret@proxy.local:3128"],
    ["remote_proxy", "remote.origin.proxy", "http://p"],
    ["transport_setting", "http.sslverify", "false"],
    ["transport_setting", "http.sslcert", "/c.pem"],
    ["transport_setting", "http.https://github.com/.proxyauthmethod", "basic"],
  ])("refuses %s (%s)", (reason, key, value) => {
    try { transportConfigOf([entry(key, value)]); throw Error("accepted"); }
    catch (error) { expect(error).toBeInstanceOf(TransportUnsupportedError); expect((error as TransportUnsupportedError).reasons).toContain(reason); expect((error as Error).message).toContain("CONTAINED_BRIDGE_TRANSPORT_UNSUPPORTED"); expect((error as Error).message).not.toContain("secret"); }
  });
  it.skipIf(!darwin)("reads real `git config --list` output (every scope, includes expanded) through the host runner", async () => {
    const root = realpathSync(createScratchDirSync("tests", "transport")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const repo = join(root, "r"); mkdirSync(repo); execFileSync("git", ["init", "-q", repo]);
    const global = join(root, "gitconfig"); writeFileSync(global, "[http]\n\tproxy = http://proxy.local:3128\n[url \"git@github.com:\"]\n\tinsteadOf = https://github.com/\n");
    const runner: DeliveryCommandRunner = { run: async (command, args, options) => ({ stdout: execFileSync(command, [...args], { cwd: options.cwd, env: { ...process.env, GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: "1" }, encoding: "utf8" }), stderr: "", exitCode: 0 }) };
    await expect(appTransportConfig(runner, repo)).rejects.toMatchObject({ reasons: ["url_rewrite"] });
    writeFileSync(global, "[http]\n\tproxy = http://proxy.local:3128\n\tsslCAInfo = /etc/ca.pem\n");
    expect(await appTransportConfig(runner, repo)).toEqual(["-c", "http.proxy=http://proxy.local:3128", "-c", "http.sslcainfo=/etc/ca.pem"]);
    await expect(appTransportConfig({ run: async () => ({ stdout: "", stderr: "", exitCode: 128 }) }, repo)).rejects.toMatchObject({ reasons: ["config_unreadable"] });
  });
  it("applies the pinned config to push, remote get-url and ls-remote, in an isolated environment with the token only in env", async () => {
    const seen: Array<{ args: readonly string[]; env?: NodeJS.ProcessEnv }> = [];
    const inner: DeliveryCommandRunner = { run: async (_c, args) => { seen.push({ args }); return { stdout: "", stderr: "", exitCode: 0 }; } };
    const exec = Object.assign(async (_c: string, args: readonly string[], options: { env: NodeJS.ProcessEnv }) => { seen.push({ args, env: options.env }); return { stdout: "", stderr: "", exitCode: 0 }; }, { gated: true as const });
    const transport = ["-c", "http.proxy=http://proxy.local:3128"];
    const runner = appCredentialRunner(inner, async () => "ghs_TOKEN_VALUE_1234567890", exec, transport);
    expect(runner.gated).toBe(true);
    const hardened = ["-c", "core.hooksPath=/dev/null"];
    await runner.run("git", [...hardened, "remote", "get-url", "--push", "origin"], { cwd: "/", timeoutMs: 1 });
    await runner.run("git", [...hardened, "ls-remote", "origin"], { cwd: "/", timeoutMs: 1 });
    await runner.run("git", [...hardened, "push", "origin", "x"], { cwd: "/", timeoutMs: 1 });
    for (const call of seen) expect(call.args.join(" ")).toContain("http.proxy=http://proxy.local:3128");
    expect(seen.map(c => c.args.join(" ")).join("\n")).not.toContain("ghs_TOKEN");
    const pushEnv = seen[2]!.env!;
    expect(pushEnv["GIT_CONFIG_GLOBAL"]).toBe("/dev/null"); expect(pushEnv["GIT_CONFIG_NOSYSTEM"]).toBe("1"); expect(pushEnv["OSSTACK_BRIDGE_PUSH_TOKEN"]).toBe("ghs_TOKEN_VALUE_1234567890");
    expect(Object.keys(pushEnv).filter(k => /proxy/i.test(k))).toEqual([]);
    // an exec that is not gated makes the whole runner ungated
    expect(appCredentialRunner(inner, async () => "t", async () => ({ stdout: "", stderr: "", exitCode: 0 })).gated).toBeUndefined();
  });
});

describe("only the publication fence reaches a remote write (static scan, T13)", () => {
  const dir = new URL(".", import.meta.url).pathname;
  const sources = readdirSync(dir).filter(f => /^contained-mission-.*\.ts$/.test(f) && !/\.test\.ts$|testkit|fixture/.test(f));
  const text = (f: string) => readFileSync(join(dir, f), "utf8");
  it("push and pr create are named, as commands, only in the fence, the bridge runner and the gated launcher", () => {
    const naming = sources.filter(f => /args\[[^\]]*\]\s*===\s*["']push["']|\[\s*["']push["']|args\[1\]\s*===\s*["']create["']|["']pr["']\s*,\s*["']create["']/.test(text(f)));
    expect(naming.sort()).toEqual(["contained-mission-bridge.ts", "contained-mission-ports.ts"]);
  });
  it("the only process spawns on the Mission path are the gated launcher, the bridge's ungated exec (refused for writes), a read-only ps and the read-only gh GraphQL reader", () => {
    const spawning = sources.filter(f => /\b(?:execFile|execFileSync|spawn|spawnSync)\(/.test(text(f)));
    expect(spawning.sort()).toEqual(["contained-mission-bridge-reader.ts", "contained-mission-bridge.ts", "contained-mission-host.ts", "contained-mission-remote-writes.ts"]);
    expect(text("contained-mission-bridge.ts")).toContain("CONTAINED_PUBLICATION_UNGATED");
    expect(text("contained-mission-bridge-reader.ts")).not.toMatch(/["'](?:push|create|POST|PATCH|PUT|DELETE)["']/);
    expect(readFileSync(join(dir, "../../github/src/delivery.ts"), "utf8")).toContain("DELIVERY_RUNNER_UNGATED");
  });
  it("ports.publish launches through the gated host runner unless a caller injects a runner", () => {
    const ports = text("contained-mission-ports.ts");
    expect(ports).toContain("gatedHostRunner(kit");
    expect(ports).not.toMatch(/defaultDeliveryCommandRunner/);
    expect(ports).toContain("gatedBridgeExec(kit");
    expect(ports).toMatch(/kit\.guard\(mission\.mission_id/);
  });
});
