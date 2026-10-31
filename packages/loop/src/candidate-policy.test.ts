import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, chmodSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { CandidatePolicy, candidateBinding, assertCandidateIndexVisible, freezeCandidate, assertCandidateFrozen, openCandidateRecord, CandidateEvidence } from "./candidate-policy.js";
import * as candidateModule from "./candidate-policy.js";
import type { AgentAdapter } from "@osstack/agents";
import type { HermesEvent } from "@osstack/hermes-adapter";
import { verifyRun } from "./verifier.js";
import { LoopEngine } from "./loop-engine.js";
import { enqueueTask, parseTaskQueueFile } from "./task-queue.js";

let previousHome: string | undefined;
beforeEach(() => { previousHome = process.env.OSSTACK_HOME; });
afterEach(() => { if (previousHome === undefined) delete process.env.OSSTACK_HOME; else process.env.OSSTACK_HOME = previousHome; });

function fixture(count = 2) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "osstack-candidate-"))), repo = join(root, "repo"), state = join(root, "state");
  mkdirSync(repo); mkdirSync(state, { mode: 0o700 }); mkdirSync(join(root, "home"), { mode: 0o700 });
  process.env.OSSTACK_HOME = join(root, "home");
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
  git("init", "-b", "codex/candidate-test"); git("config", "user.email", "synthetic@example.test"); git("config", "user.name", "Synthetic");
  writeFileSync(join(repo, "file.txt"), ""); writeFileSync(join(repo, ".gitignore"), "LOOP-STATE.json\nSTATE.md\n"); git("add", "."); git("commit", "-m", "baseline");
  const log = join(root, "order.log");
  const command = (stage: string) => `node -e 'require("fs").appendFileSync(${JSON.stringify(log)},${JSON.stringify(stage + "\n")})'`;
  const policy = CandidatePolicy.parse({ batchId: "explicit-batch", scopeId: "related-feature", branch: "codex/candidate-test", policyFingerprint: "a".repeat(64), environmentFingerprint: "b".repeat(64), testsFingerprint: "c".repeat(64), maxTasks: 2, scopePaths: ["file.txt"], stateDirectory: state, profiles: { local: [command("local")], prepush: [command("prepush")], final: [command("final")] } });
  const tasks = Array.from({ length: count }, (_, index) => ({ task_id: `part-${index}`, prompt: "related synthetic edit", capability: "code.write", priority: 50, source: "manual" as const, candidateBatch: candidateBinding(policy) }));
  const opts = { workspacePath: repo, inputTasks: tasks, executeCommand: 'node -e \'require("fs").appendFileSync("file.txt","x")\'', candidatePolicy: policy, useWorktree: true, worktreeRoot: join(root, "worktrees"), maxIterations: 1, lessonDrafts: { enabled: false } };
  const stages = () => readdirSync(state).filter(n => n.length === 64).flatMap(dir => readdirSync(join(state, dir)).map(n => JSON.parse(readFileSync(join(state, dir, n), "utf8")) as { stage: string; accepted: boolean; remoteCI: string; headSha?: string }));
  return { root, repo, state, log, policy, tasks, opts, git, stages, command };
}
describe("candidate policy actual local LoopEngine integration", () => {
  it("runs each local check, commits two related slices, freezes and verifies once per profile", async () => {
    const f = fixture();
    const result = await new LoopEngine({ ...f.opts, verifyCommands: [f.command("legacy-final")] }).runOnce();
    expect(result.completedTasks.map(t => t.outcome)).toEqual(["success", "success"]);
    expect(readFileSync(join(f.repo, "file.txt"), "utf8")).toBe("xx");
    expect(readFileSync(f.log, "utf8").trim().split("\n")).toEqual(["local", "local", "prepush", "legacy-final", "final"]);
    expect(f.stages().map(x => x.stage)).toEqual(["local_validation_pending", "candidate_commit", "candidate_commit", "candidate_frozen", "prepush_verified", "final_verified", "final_preflight_ready"]);
    expect(f.stages().at(-1)?.headSha).toBe(f.git("rev-parse", "HEAD"));
    expect(f.stages().every(x => x.accepted === false && x.remoteCI === "pending")).toBe(true);
  });
  it("keeps legacy default command verification and creates no candidate record", async () => {
    const f = fixture(1); const { candidatePolicy: _, ...opts } = f.opts;
    const result = await new LoopEngine({ ...opts, verifyCommands: [f.command("legacy")] }).runOnce();
    expect(result.completedTasks[0]?.outcome).toBe("success"); expect(f.stages()).toEqual([]);
    expect(readFileSync(f.log, "utf8")).toBe("legacy\n");
  });
  it.each(["batchId", "scopeId", "branch", "policyFingerprint", "environmentFingerprint", "testsFingerprint"] as const)("refuses mixed %s before commands or commits", async field => {
    const f = fixture(); f.tasks[1]!.candidateBatch[field] = field.endsWith("Fingerprint") ? "d".repeat(64) : "different";
    const before = f.git("rev-parse", "HEAD"); await expect(new LoopEngine(f.opts).runOnce()).rejects.toThrow("CANDIDATE_BATCH_MISMATCH");
    expect(f.git("rev-parse", "HEAD")).toBe(before); expect(readFileSync(join(f.repo, "file.txt"), "utf8")).toBe(""); expect(f.stages()).toEqual([]);
  });
  it("refuses missing bindings, oversized batches, dirty inputs and unsafe state", async () => {
    const f = fixture(); const noBinding = f.tasks.map(({ candidateBatch: _, ...t }) => t);
    await expect(new LoopEngine({ ...f.opts, inputTasks: noBinding }).runOnce()).rejects.toThrow();
    await expect(new LoopEngine({ ...f.opts, candidatePolicy: { ...f.policy, maxTasks: 1 } }).runOnce()).rejects.toThrow("CANDIDATE_BATCH_SIZE");
    writeFileSync(join(f.repo, "unexpected.txt"), "x"); await expect(new LoopEngine(f.opts).runOnce()).rejects.toThrow("CANDIDATE_DIRTY");
    const clean = fixture(1); chmodSync(clean.state, 0o755); await expect(new LoopEngine(clean.opts).runOnce()).rejects.toThrow("CANDIDATE_STATE_UNSAFE");
    const linked = fixture(1); const link = join(linked.root, "link"); symlinkSync(linked.state, link); await expect(new LoopEngine({ ...linked.opts, candidatePolicy: { ...linked.policy, stateDirectory: link } }).runOnce()).rejects.toThrow("CANDIDATE_STATE_UNSAFE");
  });
  it("refuses actual out-of-scope edits before candidate commit", async () => {
    const f = fixture(1), before = f.git("rev-parse", "HEAD");
    await expect(new LoopEngine({ ...f.opts, executeCommand: 'node -e \'require("fs").writeFileSync("foreign.txt","x")\'' }).runOnce()).rejects.toThrow("CANDIDATE_SCOPE_MISMATCH");
    expect(f.git("rev-parse", "HEAD")).toBe(before); expect(f.stages().some(x => x.stage === "final_preflight_ready")).toBe(false);
  });
  it("does not final-verify after a failed local slice", async () => {
    const f = fixture(); const result = await new LoopEngine({ ...f.opts, candidatePolicy: { ...f.policy, profiles: { ...f.policy.profiles, local: ["node -e 'process.exit(1)'"] } } }).runOnce();
    expect(result.completedTasks.map(t => t.outcome)).toEqual(["escalated"]); expect(result.completedTasks[0]?.error_summary).not.toBe("candidate final preflight failed or stale"); expect(f.stages().at(-1)?.stage).toBe("final_preflight_failed");
  });
  it("final failure cannot archive queued tasks as successful", async () => {
    const f = fixture(1); await enqueueTask({ workspacePath: f.repo, taskId: "part-0", prompt: "related", candidateBatch: f.tasks[0]!.candidateBatch }); f.git("add", "."); f.git("commit", "-m", "queue");
    const { inputTasks: _, ...opts } = f.opts;
    const result = await new LoopEngine({ ...opts, sources: ["task_queue"], archiveCompletedTasks: true, candidatePolicy: { ...f.policy, profiles: { ...f.policy.profiles, final: ["node -e 'process.exit(1)'"] } } }).runOnce();
    expect(result.completedTasks[0]?.outcome).toBe("failed"); expect(readdirSync(join(f.repo, "tasks"))).toContain("part-0.json"); expect(f.stages().at(-1)?.stage).toBe("final_preflight_failed");
  });
  it("detects real final command mutation of frozen candidate and never emits ready", async () => {
    const f = fixture(1); const result = await new LoopEngine({ ...f.opts, candidatePolicy: { ...f.policy, profiles: { ...f.policy.profiles, final: ['node -e \'require("fs").appendFileSync("file.txt","late")\''] } } }).runOnce();
    expect(result.completedTasks[0]?.outcome).toBe("failed"); expect(f.stages().at(-1)?.stage).toBe("final_preflight_failed");
  });
  it("never trusts a completed persistent record for another execution", async () => {
    const f = fixture(1); await new LoopEngine(f.opts).runOnce();
    await expect(new LoopEngine({ ...f.opts, skipCompletedTasks: false }).runOnce()).rejects.toThrow(); expect(readFileSync(join(f.repo, "file.txt"), "utf8")).toBe("x");
  });
  it("rejects unknown configuration and profile gaps; queue preserves strict bindings", () => {
    const f = fixture(1); expect(() => CandidatePolicy.parse({ ...f.policy, allowSkip: true })).toThrow(); expect(() => CandidatePolicy.parse({ ...f.policy, profiles: { ...f.policy.profiles, final: [] } })).toThrow();
    expect(parseTaskQueueFile({ task_id: "x", prompt: "x", candidateBatch: f.tasks[0]!.candidateBatch })[0]?.candidateBatch).toEqual(f.tasks[0]!.candidateBatch);
    expect(() => parseTaskQueueFile({ task_id: "x", prompt: "x", candidateBatch: { ...f.tasks[0]!.candidateBatch, extra: true } })).toThrow();
    const frozen = freezeCandidate(f.repo); writeFileSync(join(f.repo, "file.txt"), "later"); expect(() => assertCandidateFrozen(f.repo, frozen)).toThrow("CANDIDATE_DIRTY");
  });
});

describe("candidate preservation of full gates and actual scope", () => {
  const committedForeign = 'node -e \'require("fs").writeFileSync("foreign.txt","bad")\' && git add foreign.txt && git commit -m foreign && node -e \'require("fs").appendFileSync("file.txt","x")\'';
  it("rejects executor-committed foreign changes; a HEAD-only scope mutant actually leaks them", async () => {
    const valid = fixture(1); expect((await new LoopEngine(valid.opts).runOnce()).completedTasks[0]?.outcome).toBe("success");
    const safe = fixture(1), before = safe.git("rev-parse", "HEAD");
    await expect(new LoopEngine({ ...safe.opts, executeCommand: committedForeign }).runOnce()).rejects.toThrow("CANDIDATE_SCOPE_MISMATCH");
    expect(safe.git("rev-parse", "HEAD")).toBe(before);
    const mutant = fixture(1), original = candidateModule.assertCandidateScope;
    const spy = vi.spyOn(candidateModule, "assertCandidateScope").mockImplementation((workspace, policy) => original(workspace, policy, execFileSync("git", ["-C", workspace, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()));
    try {
      // With the scope anchor mutated away, the executor's own commit passes the
      // scope gate; the landing guard (D6) is now the second layer that keeps it
      // out of the main checkout and preserves it on the task branch.
      const before = mutant.git("rev-parse", "HEAD");
      await expect(new LoopEngine({ ...mutant.opts, executeCommand: committedForeign }).runOnce()).rejects.toThrow("executor-made commits");
      expect(spy).toHaveBeenCalled();
      expect(mutant.git("rev-parse", "HEAD")).toBe(before);
      expect(() => readFileSync(join(mutant.repo, "foreign.txt"), "utf8")).toThrow();
      expect(mutant.git("branch", "--list", "--format=%(refname:short)", "osstack/loop/*")).toContain("osstack/loop/");
    } finally { spy.mockRestore(); }
  });
  it("checks deletion source when an out-of-scope tracked file is renamed to an allowed target", async () => {
    const f = fixture(1); writeFileSync(join(f.repo, "foreign.txt"), "foreign"); f.git("add", "."); f.git("commit", "-m", "foreign baseline");
    await expect(new LoopEngine({ ...f.opts, executeCommand: "git mv -f foreign.txt file.txt" }).runOnce()).rejects.toThrow("CANDIDATE_SCOPE_MISMATCH");
  });
  it("keeps context, explicit artifact and independent adapter evaluations in all three stages", async () => {
    const f = fixture(); const calls: string[] = [];
    const adapter: AgentAdapter = { id: "synthetic-independent-reviewer", display_name: "Synthetic reviewer", cost_tier: "low", capabilities: () => [], isAvailable: async () => ({ available: true, last_checked_at: 0 }), async *invoke(task) {
      calls.push(task.task_id);
      yield { event_id: task.run_id + ":1", seq: 1, run_id: task.run_id, session_id: task.session_id, created_at: Date.now() / 1000, terminal: true, type: "done", payload: { status: "completed", last_seq: 1, result_summary: "synthetic only", evaluation_judgments: [{ id: "review", pass: true }] } } as unknown as HermesEvent;
    } };
    const tasks = f.tasks.map(t => ({ ...t, context: { require_git_diff: true, target_paths: ["file.txt"] }, evaluation: [{ id: "artifact", mode: "artifact" as const, description: "required exact artifact", required: true, target_paths: ["file.txt"], forbidden_paths: ["foreign.txt"], weight: 1 }, { id: "review", mode: "semantic_review" as const, description: "required independent synthetic review", required: true, target_paths: [], forbidden_paths: [], weight: 1 }] }));
    const result = await new LoopEngine({ ...f.opts, inputTasks: tasks, artifactVerification: { requireGitDiff: true, targetPaths: ["file.txt"], forbiddenPaths: ["foreign.txt"] }, adapters: [adapter], verifierAgentIds: [adapter.id] }).runOnce();
    expect(result.completedTasks.map(t => t.outcome)).toEqual(["success", "success"]);
    expect(calls).toHaveLength(6); // Each task independently reviewed locally and again at prepush/final.
    expect(f.git("status", "--porcelain")).toBe("");
  });
  it("fails every current slice when the final full profile fails", async () => {
    const f = fixture(); const result = await new LoopEngine({ ...f.opts, verifyCommands: ["node -e 'process.exit(23)'"] }).runOnce();
    expect(result.completedTasks.map(t => t.outcome)).toEqual(["failed", "failed"]);
    expect(result.completedTasks.every(t => t.candidate_evidence?.stage === "final_preflight_failed")).toBe(true);
  });
  it("reexecutes the complete explicit batch even when a prior legacy run completed the same task ID", async () => {
    const f = fixture(); const { candidatePolicy: _, ...legacy } = f.opts;
    await new LoopEngine({ ...legacy, localLanding: { targetBranch: f.policy.branch }, inputTasks: [f.tasks[0]!], stateFilePath: join(f.state, "loop-explicit-batch.json"), markdownPath: join(f.state, "loop-explicit-batch.md") }).runOnce();
    chmodSync(join(f.state, "loop-explicit-batch.json"), 0o600); chmodSync(join(f.state, "loop-explicit-batch.md"), 0o600);
    const result = await new LoopEngine(f.opts).runOnce();
    expect(result.executedTaskCount).toBe(2); expect(result.completedTasks.map(t => t.task_id)).toEqual(["part-0", "part-1"]);
    expect(readFileSync(join(f.repo, "file.txt"), "utf8")).toBe("xxx");
  });
  it("rejects clean but changed HEAD during final verification", async () => {
    const f = fixture(1); const result = await new LoopEngine({ ...f.opts, candidatePolicy: { ...f.policy, profiles: { ...f.policy.profiles, final: ["git commit --allow-empty -m late"] } } }).runOnce();
    expect(result.completedTasks[0]?.outcome).toBe("failed"); expect(f.stages().at(-1)?.stage).toBe("final_preflight_failed");
  });
  it("binds the ordered actual payload and policy, fixes record fields and rejects inside-workspace state", async () => {
    const f = fixture(1); const a = await openCandidateRecord(f.policy, f.repo, f.tasks);
    await expect(openCandidateRecord(f.policy, f.repo, f.tasks.map(t => ({ ...t, prompt: "different" })))).rejects.toThrow("CANDIDATE_BATCH_ALREADY_CLAIMED");
    await a.record("candidate_frozen", { accepted: true, stage: "invented", tupleHash: "wrong" });
    const records = f.stages(); expect(records.every(x => x.accepted === false)).toBe(true); expect(records.some(x => x.stage === "invented")).toBe(false);
    const inside = join(f.repo, "..state"); mkdirSync(inside, { mode: 0o700 });
    await expect(openCandidateRecord({ ...f.policy, stateDirectory: inside }, f.repo, f.tasks)).rejects.toThrow("CANDIDATE_STATE_INSIDE_WORKSPACE");
    chmodSync(f.state, 0o755); await expect(a.record("candidate_frozen")).rejects.toThrow("CANDIDATE_STATE_CHANGED");
    expect(() => CandidateEvidence.parse({ stage: "final_preflight_ready", headSha: "a".repeat(41), treeSha: "a".repeat(40), tupleHash: "a".repeat(64), policyHash: "a".repeat(64), recordDirectory: f.state, accepted: false, remoteCI: "pending" })).toThrow();
  });
  it("refuses post-freeze write hooks before execution", () => {
    const f = fixture(1);
    expect(() => new LoopEngine({ ...f.opts, goalCommand: "touch late" })).toThrow("CANDIDATE_POST_HOOK_FORBIDDEN");
    expect(() => new LoopEngine({ ...f.opts, stateFilePath: join(f.repo, "state.json") })).toThrow("CANDIDATE_POST_HOOK_FORBIDDEN");
  });
});

it("gives the structured reviewer the committed base-to-candidate patch at final stages", async () => {
  const f = fixture(1); f.git("mv", "file.txt", "file.ts"); f.git("commit", "-m", "typescript artifact");
  const changes: string[][] = [];
  const adapter: AgentAdapter = { id: "kimi-code", display_name: "Synthetic structured review", cost_tier: "low", capabilities: () => [], isAvailable: async () => ({ available: true, last_checked_at: 0 }), async *invoke(task) {
    const input = task.context?.["kimi_review_input"] as { changed_paths: string[] }; changes.push(input.changed_paths);
    yield { event_id: task.run_id + ":1", seq: 1, run_id: task.run_id, session_id: task.session_id, created_at: Date.now() / 1000, terminal: true, type: "done", payload: { status: "completed", last_seq: 0, result_summary: "synthetic only", review: { schema_version: 1, verdict: "approved", risk: "read_only", markdown: "# Synthetic review", judgments: [{ id: "correctness", pass: true, severity: "error", summary: "Criterion passed." }], findings: [], recommended_actions: [], evidence_refs: [], runtime_identity: { adapter_id: "kimi-code", adapter_version: "0.29.1", auth_mode: "subprocess/login-reuse", provider_id: "kimi", model_id: "kimi-code/k3", agent_profile: "osstack-reviewer", evidence_source: "configured" } } } } as unknown as HermesEvent;
  } };
  const tasks = f.tasks.map(t => ({ ...t, evaluation: [{ id: "correctness", mode: "semantic_review" as const, description: "required structured synthetic review", required: true, target_paths: [], forbidden_paths: [], weight: 1 }] }));
  const result = await new LoopEngine({ ...f.opts, inputTasks: tasks, executeCommand: 'node -e \'require("fs").appendFileSync("file.ts","export const x = 1;\\n")\'', candidatePolicy: { ...f.policy, scopePaths: ["file.ts"] }, adapters: [adapter], verifierAgentIds: [adapter.id] }).runOnce();
  expect(result.completedTasks[0]?.outcome).toBe("success");
  expect(changes).toEqual([["file.ts"], ["file.ts"], ["file.ts"]]);
});

it("retains queue files after successful preflight and keeps candidate HEAD clean", async () => {
  const f = fixture(1); await enqueueTask({ workspacePath: f.repo, taskId: "part-0", prompt: "related", candidateBatch: f.tasks[0]!.candidateBatch }); f.git("add", "."); f.git("commit", "-m", "queue");
  const { inputTasks: _, ...opts } = f.opts;
  const result = await new LoopEngine({ ...opts, sources: ["task_queue"], archiveCompletedTasks: true }).runOnce();
  expect(result.completedTasks[0]?.candidate_evidence).toMatchObject({ stage: "final_preflight_ready", accepted: false, remoteCI: "pending" });
  expect(readdirSync(join(f.repo, "tasks"))).toContain("part-0.json"); expect(f.git("status", "--porcelain")).toBe("");
});

it("allows only one selected bounded batch per runCycles invocation", async () => {
  const f = fixture(1); await expect(new LoopEngine(f.opts).runCycles({ cycles: 2 })).rejects.toThrow("CANDIDATE_SINGLE_BATCH_RUN");
  expect(f.git("log", "--oneline").split("\n")).toHaveLength(1); expect(f.stages()).toEqual([]);
});

it("refuses aliased or non-private existing state files before local mutation", async () => {
  const f = fixture(1); const state = join(f.state, "loop-explicit-batch.json");
  symlinkSync(join(f.repo, "file.txt"), state);
  await expect(new LoopEngine(f.opts).runOnce()).rejects.toThrow("CANDIDATE_STATE_FILE_UNSAFE");
  expect(readFileSync(join(f.repo, "file.txt"), "utf8")).toBe(""); expect(f.stages()).toEqual([]);
});

it("does not declare a partial selected batch ready after discovery governance defers a member", async () => {
  const f = fixture(); f.tasks[1]!.priority = 90;
  await expect(new LoopEngine({ ...f.opts, discoveryPolicy: { default_authorization: "needs_approval", auto_execute_capabilities: ["code.write"], max_auto_priority: 80, blocked_capabilities: [], blocked_paths: [], source_authorization: {} } }).runOnce()).rejects.toThrow("CANDIDATE_BATCH_DEFERRED");
  expect(readFileSync(join(f.repo, "file.txt"), "utf8")).toBe(""); expect(f.stages()).toEqual([]);
});

it("rejects clean foreign commits made directly to the main checkout", async () => {
  const valid = fixture(1); expect((await new LoopEngine(valid.opts).runOnce()).completedTasks[0]?.outcome).toBe("success");
  const f = fixture(1);
  const script = `const fs=require("fs"),cp=require("child_process");fs.writeFileSync(${JSON.stringify(join(f.repo,"foreign.txt"))},"foreign-main");cp.execFileSync("git",["-C",${JSON.stringify(f.repo)},"add","foreign.txt"]);cp.execFileSync("git",["-C",${JSON.stringify(f.repo)},"commit","-m","foreign-main"]);fs.appendFileSync("file.txt","x")`;
  await expect(new LoopEngine({ ...f.opts, executeCommand: "node -e '" + script + "'" }).runOnce()).rejects.toThrow("merge --ff-only");
  expect(f.git("status", "--porcelain")).toBe(""); expect(readFileSync(join(f.repo,"foreign.txt"),"utf8")).toBe("foreign-main");
  expect(f.stages().some(s => s.stage === "final_preflight_ready")).toBe(false);
});

it("preserves original local failure diagnostics when final preflight also refuses", async () => {
  const f = fixture(1);
  const result = await new LoopEngine({ ...f.opts, executeCommand: "node -e 'console.error(\"synthetic-original-failure\");process.exit(7)'" }).runOnce();
  expect(result.completedTasks[0]?.outcome).not.toBe("success");
  expect(result.completedTasks[0]?.error_summary).not.toBe("candidate final preflight failed or stale");
  expect(result.completedTasks[0]?.candidate_evidence?.stage).toBe("final_preflight_failed");
});

it("rejects a clean foreign main commit in the post-merge window; deleting the final gate yields observable ready", async () => {
  const positive = fixture(1); expect((await new LoopEngine(positive.opts).runOnce()).completedTasks[0]?.outcome).toBe("success");
  for (const omitFinalGate of [false, true]) {
    const f = fixture(1), originalFreeze = candidateModule.freezeCandidate, originalScope = candidateModule.assertCandidateScope; let injected = 0;
    const freezeSpy = vi.spyOn(candidateModule, "freezeCandidate").mockImplementation(workspace => {
      if (workspace === f.repo && injected === 0 && readFileSync(join(f.repo,"file.txt"),"utf8") === "x") {
        execFileSync(process.execPath, ["-e", `const fs=require('fs'),cp=require('child_process');fs.writeFileSync(${JSON.stringify(join(f.repo,"foreign.txt"))},'late-main');cp.execFileSync('git',['-C',${JSON.stringify(f.repo)},'add','foreign.txt']);cp.execFileSync('git',['-C',${JSON.stringify(f.repo)},'commit','-m','late-main'])`]); injected++;
      }
      return originalFreeze(workspace);
    });
    const scopeSpy = vi.spyOn(candidateModule, "assertCandidateScope").mockImplementation((workspace, policy, start) => { if (!(omitFinalGate && workspace === f.repo)) originalScope(workspace, policy, start); });
    try {
      const result = await new LoopEngine(f.opts).runOnce();
      expect(injected).toBe(1); expect(readFileSync(join(f.repo,"foreign.txt"),"utf8")).toBe("late-main");
      expect(result.completedTasks[0]?.candidate_evidence?.stage).toBe(omitFinalGate ? "final_preflight_ready" : "final_preflight_failed");
    } finally { scopeSpy.mockRestore(); freezeSpy.mockRestore(); }
  }
}, 20_000); // Three complete real-Git candidate pipelines, including the mutation control.

it("never truncates the committed artifact file list even with a tiny log limit", async () => {
  const f = fixture(1), base = f.git("rev-parse", "HEAD");
  const forbidden = "000-forbidden.txt"; writeFileSync(join(f.repo, forbidden), "forbidden");
  for (let i = 0; i < 500; i++) writeFileSync(join(f.repo, String(i).padStart(4,"0") + "x".repeat(60) + ".txt"), "allowed");
  f.git("add", "."); f.git("commit", "-m", "large candidate");
  const result = await verifyRun({ run_id: "synthetic", plan_id: "synthetic", task_id: "synthetic", agent_id: "local-command", outcome: "completed", started_at: new Date().toISOString(), completed_at: new Date().toISOString(), duration_ms: 0, command_results: [] }, { workspacePath: f.repo, artifactBaseCommit: base, outputLimit: 16, artifactVerification: { requireGitDiff: true, forbiddenPaths: [forbidden] } });
  expect(result.pass).toBe(false); expect(result.issues).toContainEqual(expect.objectContaining({ rule: "verify.artifact_forbidden_path", file: forbidden }));
});

it("atomically claims one batch ID across differing task tuples and never steals its retained claim", async () => {
  const f = fixture(1);
  const attempts = await Promise.allSettled([openCandidateRecord(f.policy, f.repo, f.tasks), openCandidateRecord(f.policy, f.repo, f.tasks.map(t => ({ ...t, prompt: "other concurrent tuple" })))]);
  expect(attempts.filter(x => x.status === "fulfilled")).toHaveLength(1);
  expect(attempts.filter(x => x.status === "rejected")).toHaveLength(1);
  await expect(openCandidateRecord(f.policy, f.repo, f.tasks)).rejects.toThrow("CANDIDATE_BATCH_ALREADY_CLAIMED");
  const record = attempts.find(x => x.status === "fulfilled"); if (record?.status !== "fulfilled") throw Error("missing positive record");
  chmodSync(join(f.state, "batch-" + f.policy.batchId), 0o755);
  await expect(record.value.record("candidate_frozen")).rejects.toThrow("CANDIDATE_BATCH_CLAIM_CHANGED");
});

it("preserves execution-unconfirmed escalation and stop evidence through candidate refusal", async () => {
  const f = fixture(1); const { executeCommand: _, ...opts } = f.opts;
  const adapter: AgentAdapter = { id: "synthetic-unconfirmed-builder", display_name: "Synthetic abnormal stream", cost_tier: "low", capabilities: () => [{ id: "synthetic-unconfirmed-builder.code.write", kind: "code.write", agent_id: "synthetic-unconfirmed-builder", description: "Synthetic only", cost_tier: "low", hints: {}, version: "0.0.0" }], isAvailable: async () => ({ available: true, last_checked_at: 0 }), async *invoke() {} };
  const result = await new LoopEngine({ ...opts, agentId: adapter.id, adapters: [adapter] }).runOnce();
  expect(result.completedTasks[0]).toMatchObject({ outcome: "escalated", implementation_unconfirmed: true, error_summary: expect.stringContaining("execution_unconfirmed:") });
  expect(result.completedTasks[0]?.candidate_evidence?.stage).toBe("final_preflight_failed");
  expect(f.stages().some(s => s.stage === "final_preflight_ready")).toBe(false);
});

it.each(["--assume-unchanged", "--skip-worktree"])("refuses freezing hidden builder edits under %s", flag => {
  const f = fixture(1);
  f.git("update-index", flag, "file.txt");
  writeFileSync(join(f.repo, "file.txt"), "hidden builder edit");
  expect(f.git("status", "--porcelain")).toBe("");
  expect(() => freezeCandidate(f.repo)).toThrow("CANDIDATE_HIDDEN_INDEX_ENTRY");
});

it("refuses candidate freeze for a sparse checkout with omitted tracked entries", () => {
  const f = fixture(1);
  mkdirSync(join(f.repo, "nested")); writeFileSync(join(f.repo, "nested", "app.ts"), "tracked");
  f.git("add", "."); f.git("commit", "-m", "nested baseline");
  f.git("sparse-checkout", "init", "--cone"); f.git("sparse-checkout", "set", "other-directory");
  expect(() => freezeCandidate(f.repo)).toThrow("CANDIDATE_HIDDEN_INDEX_ENTRY");
});

it("checks a real index whose path listing exceeds the old 1 MiB limit", () => {
  const f = fixture(1);
  const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], { cwd: f.repo, input: "shared-content", encoding: "utf8" }).trim();
  const entries = Array.from({ length: 25000 }, (_, i) => `100644 ${blob}\tlarge-index/${String(i).padStart(6, "0")}-${"x".repeat(48)}.ts\n`).join("");
  execFileSync("git", ["update-index", "--index-info"], { cwd: f.repo, input: entries });
  const listed = execFileSync("git", ["ls-files", "-v", "-z"], { cwd: f.repo, maxBuffer: 64 * 1024 * 1024 });
  expect(listed.byteLength).toBeGreaterThan(1_048_576);
  expect(() => assertCandidateIndexVisible(f.repo)).not.toThrow();
});
it("distinguishes an unavailable index observation from a hidden entry", () => {
  const f = fixture(1);
  expect(() => assertCandidateIndexVisible(join(f.root, "missing"))).toThrow("CANDIDATE_INDEX_OBSERVATION_UNAVAILABLE");
});
