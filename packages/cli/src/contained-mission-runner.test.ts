import { realpathSync, rmSync } from "node:fs";
import { join } from "node:path";
import { AttentionStore, ContainedMissionStore, createScratchDirSync, openDb, type ContainedMission } from "@osstack/core";
import type { CodexProxyRun, CodexQualification } from "@osstack/agents";
import { afterEach, describe, expect, it } from "vitest";
import { ContainedMissionRunner, type ContainedMissionPorts, type ContainedMissionSpec } from "./contained-mission-runner.js";

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).forEach(fn => { fn(); }); });
const START = "a".repeat(40);
// Built by concatenation so this file itself never trips a secret scanner.
const FAKE_TOKEN = "ghp" + "_" + "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8";
const PATCH = "--- a/src/a.txt\n+++ b/src/a.txt\n@@ -1 +1 @@\n-hi\n+hello\n";
const qualified: CodexQualification = { qualified: true, version: "codex-cli 0.160.1", identity_sha256: "f".repeat(64), profile: ":read-only",
  results: { parent: { write_worktree: "denied", write_outside: "denied", write_gitdir: "denied", network: "denied" }, escaped_child: { write_worktree: "denied", write_outside: "denied", write_gitdir: "denied", network: "denied" } },
  host_observed_writes: [], reasons: [] };
const run = (over: Partial<CodexProxyRun> = {}): CodexProxyRun => ({
  launch: { pid: 4242, pgid: 4242, started_at: 1 }, exit_code: 0, signal: null, timed_out: false, cancelled: false,
  stop: { stop_proof: "group_empty+sandbox_inherited", pgid: 4242, signals: [], confirmed_at: 2 },
  patch: { ok: true, text: PATCH, bytes: PATCH.length }, stdout: "done", stderr: "", stdout_truncated: false, stderr_truncated: false, ...over,
});

function setup(over: Partial<ContainedMissionPorts> = {}, specOver: Partial<ContainedMissionSpec> = {}) {
  const root = realpathSync(createScratchDirSync("tests", "contained-runner"));
  const path = join(root, "state.db"); const db = openDb({ path }); db.pragma("synchronous=FULL");
  cleanup.push(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  db.exec("INSERT INTO tasks(task_id,title,status,created_at,updated_at) VALUES('t','t','running',1,1)");
  const attention = new AttentionStore(db, path); const owner = attention.claimOwner("owner");
  const scope = attention.registerScope(owner, "t", root);
  const store = new ContainedMissionStore(attention, owner);
  const files = new Map<string, string>([["src/a.txt", "hi\n"]]);
  const calls = { execute: [] as string[], commit: [] as unknown[], verify: 0, cumulative: [] as unknown[] };
  // Default cumulative diff: concatenate every turn's patch (enough for the fakes' single-file edits).
  const turns: string[] = [];
  let clock = 1000; let head = START; let verifyExit = 0; let cumulativeText: string | undefined;
  const ports: ContainedMissionPorts = {
    store, now: () => ++clock,
    createWorkspace: async () => ({ worktree: join(root, "wt"), gitDir: join(root, "repo", ".git"), head: START, configDigest: "sha256:" + "0".repeat(64) }),
    qualify: async () => qualified,
    execute: async input => { calls.execute.push(input.prompt); input.onLaunched({ pid: 4242, pgid: 4242, started_at: 1 }); return run(); },
    readFile: async (_wt, p) => files.get(p) ?? null,
    commit: async input => { calls.commit.push(input); head = (head === START ? "b" : "c").repeat(40); return { head, tree: "d".repeat(40) }; },
    verify: async () => { calls.verify++; return { exit_code: verifyExit, output: verifyExit === 0 ? "ok" : "1 failed", cancelled: false, evidence: "docker-removed:x", stopped: true }; },
    cumulativeDiff: async input => { calls.cumulative.push(input); return cumulativeText ?? PATCH; },
    ...over,
  };
  const spec: ContainedMissionSpec = { goal: "fix it", repo_path: join(root, "repo"), base_ref: "main", start_commit: START, branch: "osstack/m/1",
    worktree_path: join(root, "wt"), allowed_paths: ["src/**"], verify: { argv: ["pnpm", "test"] }, max_repair_cycles: 1, ...specOver };
  const mission = store.authorize({ principal_id: "human", client_session_id: "cli", read_scopes: [scope.scope_id], write_scopes: [scope.scope_id], stop_scopes: [], operator_scopes: [] },
    { scope_id: scope.scope_id, spec: spec as unknown as Record<string, unknown>, claim: { repo_identity: "repo", branch: spec.branch, worktree_identity: spec.worktree_path } }, 1000);
  const runner = new ContainedMissionRunner(ports);
  const kinds = () => store.events(mission.mission_id, 0, 500).map(e => e.kind);
  const allPayloads = () => store.events(mission.mission_id, 0, 500).map(e => e.payload_json).join("\n");
  void turns;
  return { store, runner, mission, calls, kinds, allPayloads, setVerifyExit: (n: number) => { verifyExit = n; }, setCumulative: (t: string) => { cumulativeText = t; } };
}
async function drive(f: ReturnType<typeof setup>, steps: number): Promise<ContainedMission> {
  let m = f.store.get(f.mission.mission_id);
  for (let i = 0; i < steps; i++) m = await f.runner.step(m.mission_id);
  return m;
}

describe("ContainedMissionRunner", () => {
  it("drives a Mission to verified, then waits for a publication decision", async () => {
    const f = setup();
    let m = await drive(f, 3);
    expect(m).toMatchObject({ state: "verified", candidate_head: "b".repeat(40), candidate_verified: 1, stop_obligation: 0 });
    expect(f.calls.commit).toEqual([expect.objectContaining({ expectedHead: START, files: [{ path: "src/a.txt", action: "write", content: "hello\n" }] })]);
    const kinds = f.kinds();
    expect(kinds.indexOf("executor_started")).toBeLessThan(kinds.indexOf("executor_output"));
    expect(kinds).toEqual(expect.arrayContaining(["qualification_probe", "executor_launch_intent", "executor_stopped", "t0_intent", "candidate_committed", "verify_intent", "verify_receipt", "t0_receipt"]));
    const receipt = JSON.parse(f.store.events(m.mission_id, 0, 500).find(e => e.kind === "t0_receipt")!.payload_json);
    expect(receipt).toMatchObject({ head_before: START, head_after: "b".repeat(40), verify_command: ["pnpm", "test"], verify_exit: 0 });
    m = await f.runner.step(m.mission_id);
    expect(m.state).toBe("awaiting_decision");
    m = await f.runner.decide(m.mission_id, { kind: "approve_publication" });
    expect(m.state).toBe("revalidating");
  });

  it("stops before persisting anything when a channel carries a secret, and stores only redacted text", async () => {
    const f = setup({ execute: async input => { input.onLaunched({ pid: 1, pgid: 4242, started_at: 1 }); return run({ stdout: `read ~/.config/gh/hosts.yml: ${FAKE_TOKEN}` }); } });
    const m = await drive(f, 2);
    expect(m.state).toBe("awaiting_decision");
    expect(f.calls.commit).toEqual([]);
    expect(f.allPayloads()).not.toContain(FAKE_TOKEN);
    expect(f.allPayloads()).toContain("secret_detected");
  });

  it("never records a patch that carries a secret", async () => {
    const leaking = `--- a/src/a.txt\n+++ b/src/a.txt\n@@ -1 +1 @@\n-hi\n+token=${FAKE_TOKEN}\n`;
    const f = setup({ execute: async input => { input.onLaunched({ pid: 1, pgid: 4242, started_at: 1 }); return run({ patch: { ok: true, text: leaking, bytes: leaking.length } }); } });
    const m = await drive(f, 2);
    expect(m.state).toBe("awaiting_decision"); expect(f.calls.commit).toEqual([]);
    expect(f.allPayloads()).not.toContain(FAKE_TOKEN);
  });

  it("escalates a protected path to a decision without writing", async () => {
    const patch = "--- a/package.json\n+++ b/package.json\n@@ -1 +1 @@\n-{}\n+{\"scripts\":{}}\n";
    const f = setup({ execute: async input => { input.onLaunched({ pid: 1, pgid: 4242, started_at: 1 }); return run({ patch: { ok: true, text: patch, bytes: patch.length } }); } }, { allowed_paths: ["**"] });
    const m = await drive(f, 2);
    expect(m.state).toBe("awaiting_decision"); expect(f.calls.commit).toEqual([]);
    expect(f.allPayloads()).toContain("tier_escalated");
    await expect(f.runner.decide(m.mission_id, { kind: "approve_publication" })).rejects.toThrow("CONTAINED_DECISION_NOT_ALLOWED");
    expect((await f.runner.decide(m.mission_id, { kind: "abandon" })).state).toBe("abandoned");
  });

  it("holds stop_unknown when the executor group was not proven empty", async () => {
    const f = setup({ execute: async input => { input.onLaunched({ pid: 1, pgid: 4242, started_at: 1 }); const r = run(); delete (r as { stop?: unknown }).stop; return r; } });
    const m = await drive(f, 2);
    expect(m).toMatchObject({ state: "stop_unknown", stop_obligation: 1 });
    expect(f.calls.commit).toEqual([]);
  });

  it("clears the stop obligation when nothing was ever spawned", async () => {
    const f = setup({ execute: async () => { throw new Error("codex_proxy_spawn_failed: ENOENT"); } });
    const m = await drive(f, 2);
    expect(m).toMatchObject({ state: "awaiting_decision", stop_obligation: 0 });
  });

  it("does not execute when qualification fails", async () => {
    const f = setup({ qualify: async () => ({ ...qualified, qualified: false, reasons: ["HOST_OBSERVED_WRITE"] }) });
    const m = await drive(f, 2);
    expect(m.state).toBe("awaiting_decision"); expect(f.calls.execute).toEqual([]);
  });

  it("repairs within the budget, feeds back only the exit code and output, then asks for more", async () => {
    const f = setup(); f.setVerifyExit(1);
    let m = await drive(f, 3);
    expect(m.state).toBe("verify_failed");
    m = await f.runner.step(m.mission_id);
    expect(m).toMatchObject({ state: "candidate_ready", repair_cycles: 1 });
    expect(f.calls.execute[1]).toContain("failed verification (exit 1)");
    m = await drive(f, 2);
    expect(m.state).toBe("awaiting_decision");
    m = await f.runner.decide(m.mission_id, { kind: "extra_repair" });
    expect(m).toMatchObject({ state: "candidate_ready", repair_cycles: 2 });
  });

  it("states the proxy patch protocol on every executor turn", async () => {
    const f = setup(); f.setVerifyExit(1);
    await drive(f, 4);
    expect(f.calls.execute).toHaveLength(2);
    for (const prompt of f.calls.execute) { expect(prompt).toContain("unified diff"); expect(prompt.trimEnd()).toMatch(/END-OF-PATCH/); expect(prompt).toContain("fix it"); }
  });

  it("never writes a path that only appears inside hunk text", async () => {
    const smuggle = "--- a/src/a.txt\n+++ b/src/a.txt\n@@ -1 +1,3 @@\n-hi\n+hello\n+--- /dev/null\n++++ b/package.json\n";
    const f = setup({ execute: async input => { input.onLaunched({ pid: 1, pgid: 4242, started_at: 1 }); return run({ patch: { ok: true, text: smuggle, bytes: smuggle.length } }); } });
    const m = await drive(f, 2);
    expect(m.state).toBe("candidate_ready");
    const files = (f.calls.commit[0] as { files: Array<{ path: string }> }).files;
    expect(files.map(x => x.path)).toEqual(["src/a.txt"]);
  });

  it("does not commit after a cancel that arrives during the host write", async () => {
    let unblock!: () => void; let reading!: () => void;
    const reached = new Promise<void>(resolve => { reading = resolve; });
    const f = setup({ readFile: async () => { reading(); await new Promise<void>(resolve => { unblock = resolve; }); return "hi\n"; } });
    let m = await f.runner.step(f.mission.mission_id);
    const pending = f.runner.step(m.mission_id);
    await reached;
    m = await f.runner.cancel(m.mission_id);
    expect(m.state).toBe("cancel_requested");
    unblock();
    m = await pending;
    expect(m.state).toBe("cancelled");
    expect(f.calls.commit).toEqual([]);
  });

  it("classifies the cumulative diff since start_commit, not one repair turn", async () => {
    const f = setup({}, { caps: { maxChangedLines: 3 } }); f.setVerifyExit(1);
    let m = await drive(f, 3);
    expect(m.state).toBe("verify_failed");
    const big = "--- a/src/a.txt\n+++ b/src/a.txt\n@@ -1 +1,4 @@\n-hi\n+h1\n+h2\n+h3\n+h4\n";
    f.setCumulative(big);
    m = await f.runner.step(m.mission_id);
    const intents = f.store.events(m.mission_id, 0, 500).filter(e => e.kind === "t0_intent").map(e => JSON.parse(e.payload_json) as { tier: string });
    expect(intents.map(i => i.tier)).toEqual(["T0", "T1"]);
    m = await drive(f, 2);
    expect(m.state).toBe("awaiting_decision");
    // A later turn whose own patch is clean but whose cumulative diff reaches a protected path.
    f.setCumulative("--- a/package.json\n+++ b/package.json\n@@ -1 +1 @@\n-{}\n+{\"x\":1}\n");
    m = await f.runner.decide(m.mission_id, { kind: "extra_repair" });
    expect(m.state).toBe("awaiting_decision");
    expect(f.allPayloads()).toContain('"cumulative":true');
    expect(f.calls.commit).toHaveLength(2);
  });

  it("keeps the stop obligation when the verifier cannot prove its container stopped", async () => {
    const f = setup({ verify: async () => ({ exit_code: 0, output: "ok", cancelled: false, evidence: "", stopped: false }) });
    const m = await drive(f, 3);
    expect(m).toMatchObject({ state: "stop_unknown", stop_obligation: 1 });
    await expect(f.runner.cancel(m.mission_id).then(x => x.state)).resolves.toBe("cancel_requested");
    const thrown = setup({ verify: async () => { throw new Error("docker_unreachable"); } });
    expect(await drive(thrown, 3)).toMatchObject({ state: "stop_unknown", stop_obligation: 1 });
  });

  it("waits for workspace creation to settle before a cancel completes", async () => {
    let finish!: () => void;
    const f = setup({ createWorkspace: async () => { await new Promise<void>(resolve => { finish = resolve; }); return { worktree: "w", gitDir: "g", head: START, configDigest: "d" }; } });
    const pending = f.runner.step(f.mission.mission_id);
    await new Promise(resolve => setTimeout(resolve, 10));
    const requested = await f.runner.cancel(f.mission.mission_id);
    expect(requested.state).toBe("cancel_requested");
    finish();
    expect((await pending).state).toBe("cancelled");
  });

  it("cancels a live executor and settles once it is proven stopped", async () => {
    let release!: () => void;
    const f = setup({ execute: async input => {
      input.onLaunched({ pid: 1, pgid: 4242, started_at: 1 });
      await new Promise<void>(resolve => { release = resolve; input.signal.addEventListener("abort", () => resolve()); });
      return run({ cancelled: true, patch: { ok: false, reason: "PATCH_MISSING" } });
    } });
    let m = await f.runner.step(f.mission.mission_id);
    const pending = f.runner.step(m.mission_id);
    await new Promise(resolve => setTimeout(resolve, 10));
    m = await f.runner.cancel(m.mission_id);
    expect(m.state).toBe("cancel_requested");
    m = await pending; release();
    expect(m).toMatchObject({ state: "cancelled", stop_obligation: 0 });
  });
});
