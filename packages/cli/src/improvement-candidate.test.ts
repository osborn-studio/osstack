import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentAdapter, AgentTask } from "@osstack/agents";
import {
  approveImprovementProposal, improvementProposalDigest, ImprovementExecutionRepository, ImprovementPrDeliveryRepository,
  listImprovementProposals, openDb, upsertImprovementProposal,
} from "@osstack/core";
import type { HermesEvent } from "@osstack/hermes-adapter";
import { afterEach, describe, expect, it } from "vitest";
import { executeImprovementCandidate, prepareImprovementCandidate, type ImprovementCandidateInput } from "./improvement-candidate.js";
import { deliverImprovementPr, prepareImprovementPrTarget, reconcileImprovementPr } from "./improvement-pr-delivery.js";
import { simulatedImprovementGithub } from "./improvement-pr-test-fixture.js";
import type { LoopProfileRoutingResult } from "./loop-profile-routing.js";

const exec = promisify(execFile);
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const gate = `node -e "if(require('fs').readFileSync('docs/guide.md','utf8') !== 'improved\\n') process.exit(1)"`;

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "osstack-candidate-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const repoPath = join(root, "repo");
  await mkdir(join(repoPath, "docs"), { recursive: true });
  await writeFile(join(repoPath, "docs/guide.md"), "original\n");
  await git(repoPath, ["init", "-b", "main"]);
  await git(repoPath, ["add", "."]);
  await git(repoPath, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-m", "initial"]);
  const dbPath = join(root, "state.db");
  const db = openDb({ path: dbPath });
  cleanup.push(async () => { db.close(); });
  const draft = upsertImprovementProposal(db, dbPath, {
    proposal_id: "prop-test", repo_id: "test-repo", source_asset_ids: ["asset-test"],
    target: "docs", risk: "low", title: "Improve guide", rationale: "Document the missing step",
    proposed_changes: [{ path: "docs/guide.md", action: "modify", summary: "Document the missing step" }], required_gates: [gate],
  });
  const expectedDigest = improvementProposalDigest(draft);
  const proposal = approveImprovementProposal(db, dbPath, { proposal_id: draft.proposal_id, expected_digest: expectedDigest, now: Date.now() / 1000 });
  const identity = (id: string) => ({ adapter_id: id, adapter_version: "test", auth_mode: "fixture", provider_id: id, model_id: "fixture", evidence_source: "configured" as const });
  const routing: LoopProfileRoutingResult = {
    agentId: "builder", verifierAgentIds: ["reviewer"],
    summary: { profile_name: "fixture", reason: "test", builder_agent_id: "builder", evaluator_agent_id: "reviewer",
      builder_identity: identity("builder"), evaluator_identity: identity("reviewer"), independent: true,
      independence_reason: "different adapters", overrides: {}, resolutions: {} },
  };
  const input: ImprovementCandidateInput = { executionId: "attempt-1", expectedDigest, proposal, repoPath, registryGates: [gate], routing, timeoutMs: 5_000, evidenceRoot: join(root, "evidence") };
  const repository = new ImprovementExecutionRepository(db, dbPath);
  let builders = 0;
  const adapters = [
    adapter("builder", async (task) => { builders++; await writeFile(join(String(task.context?.["repo_path"]), "docs/guide.md"), "improved\n"); }),
    adapter("reviewer"),
  ];
  return { root, db, repoPath, repository, input, adapters, builderCount: () => builders };
}

describe("approved improvement candidate execution", () => {
  it("builds and verifies a real external-worktree patch, preserves main, and replays without running again", async () => {
    const f = await fixture();
    const head = await git(f.repoPath, ["rev-parse", "HEAD"]);
    const prepared = await prepareImprovementCandidate(f.input);
    const result = await executeImprovementCandidate(prepared, f.repository, f.adapters);
    expect(result.execution.state).toBe("candidate_verified");
    expect(result.execution.result).toMatchObject({ applied: false, effectiveness_proven: false });
    const worktree = result.execution.worktree!;
    expect(worktree.branch).toMatch(/^codex\/improve\//);
    expect(await readFile(join(worktree.worktreePath, "docs/guide.md"), "utf8")).toBe("improved\n");
    expect(await readFile(join(f.repoPath, "docs/guide.md"), "utf8")).toBe("original\n");
    expect(await git(f.repoPath, ["rev-parse", "HEAD"])).toBe(head);
    expect(await git(f.repoPath, ["status", "--porcelain"])).toBe("");
    expect(listImprovementProposals(f.db)[0]?.status).toBe("approved");
    const evidence = result.execution.result as { evidence_directory: string; artifacts: Array<{ name: string; sha256: string }> };
    for (const file of evidence.artifacts) {
      const content = await readFile(join(evidence.evidence_directory, file.name));
      expect(createHash("sha256").update(content).digest("hex")).toBe(file.sha256);
    }
    expect(await readFile(join(evidence.evidence_directory, "candidate.patch"), "utf8")).toContain("+improved");
    const manifest = JSON.parse(await readFile(join(evidence.evidence_directory, "manifest.json"), "utf8"));
    expect(manifest).toMatchObject({ base_sha: head, request_sha256: result.execution.request_sha256 });
    await expect(executeImprovementCandidate(prepared, f.repository, f.adapters)).resolves.toMatchObject({ replay: true, execution: { state: "candidate_verified" } });
    expect(f.builderCount()).toBe(1);
  }, 15_000);

  it.each(["empty", "outside", "gate", "reviewer_mutation", "missing_judgment", "silent_builder"])("fails closed for %s and retains the attempt", async (mode) => {
    const f = await fixture();
    let adapters = f.adapters;
    if (mode === "empty") adapters = [adapter("builder"), adapter("reviewer")];
    if (mode === "outside") adapters = [adapter("builder", async (task) => {
      await writeFile(join(String(task.context?.["repo_path"]), "outside.txt"), "unexpected\n");
    }), adapter("reviewer")];
    if (mode === "gate") f.input.registryGates = ["false"];
    if (mode === "reviewer_mutation") adapters = [f.adapters[0]!, adapter("reviewer", async (task) => {
      await writeFile(join(String(task.context?.["repo_path"]), "docs/guide.md"), "changed after verification\n");
    })];
    if (mode === "missing_judgment") adapters = [f.adapters[0]!, adapter("reviewer", undefined, false)];
    if (mode === "silent_builder") adapters = [{ ...f.adapters[0]!, async *invoke() { /* no terminal event */ } }, adapter("reviewer")];
    const prepared = await prepareImprovementCandidate(f.input);
    const result = await executeImprovementCandidate(prepared, f.repository, adapters);
    const uncertain = mode === "gate" || mode === "silent_builder";
    expect(result.execution.state).toBe(uncertain ? "running" : "candidate_failed");
    if (uncertain) {
      expect(result.execution.stop?.reason).toMatch(/uncertain/i);
      expect(result.execution.result).toBeUndefined();
    } else expect(result.execution.result).toMatchObject({ applied: false, error: expect.any(String) });
    expect(result.execution.worktree).toBeDefined();
    expect(await readFile(join(f.repoPath, "docs/guide.md"), "utf8")).toBe("original\n");
    expect(listImprovementProposals(f.db)[0]?.status).toBe("approved");
    await expect(executeImprovementCandidate(prepared, f.repository, adapters)).resolves.toMatchObject({ replay: true, execution: { state: uncertain ? "running" : "candidate_failed" } });
  }, 15_000);

  it("reports an unfinished claim without guessing whether its worker died", async () => {
    const f = await fixture();
    const prepared = await prepareImprovementCandidate(f.input);
    f.repository.claim({ execution_id: f.input.executionId, proposal_id: f.input.proposal.proposal_id, request: prepared.request, now: Date.now() / 1000 });
    expect(await executeImprovementCandidate(prepared, f.repository, f.adapters)).toMatchObject({ replay: true, execution: { state: "claimed" } });
    expect(f.builderCount()).toBe(0);
  });

  it.each(["builder", "reviewer"])("retains a stop requested during %s without publishing a terminal result", async (stage) => {
    const f = await fixture();
    let reviews = 0;
    const adapters = [
      adapter("builder", async (task) => {
        await writeFile(join(String(task.context?.["repo_path"]), "docs/guide.md"), "improved\n");
        if (stage === "builder") f.repository.requestStop(f.input.executionId, "operator stop", Date.now() / 1000);
      }),
      adapter("reviewer", async () => {
        reviews++;
        if (stage === "reviewer") f.repository.requestStop(f.input.executionId, "operator stop", Date.now() / 1000);
      }),
    ];
    const prepared = await prepareImprovementCandidate(f.input);
    const result = await executeImprovementCandidate(prepared, f.repository, adapters);
    expect(result.execution).toMatchObject({ state: "running", worker: { generation: 2 }, stop: { reason: "operator stop" } });
    expect(result.execution.result).toBeUndefined();
    expect(reviews).toBe(stage === "builder" ? 0 : 1);
    expect(await executeImprovementCandidate(prepared, f.repository, adapters)).toMatchObject({ replay: true, execution: result.execution });
  });

  it("freezes caller data before giving instructions to adapters", async () => {
    const f = await fixture();
    const prepared = await prepareImprovementCandidate(f.input);
    f.input.proposal.proposed_changes[0]!.path = "outside.txt";
    f.input.routing.verifierAgentIds[0] = "builder";
    expect(prepared.paths).toEqual(["docs/guide.md"]);
    expect(() => prepared.paths.push("outside.txt")).toThrow();
    expect(prepared.input.routing.verifierAgentIds).toEqual(["reviewer"]);
    const result = await executeImprovementCandidate(prepared, f.repository, f.adapters);
    expect(result.execution.state).toBe("candidate_verified");
  }, 15_000);

  it.each(["digest", "status", "risk", "paths", "gates", "reviewer", "timeout", "evidence"])("rejects invalid %s before claiming or executing", async (mode) => {
    const f = await fixture();
    if (mode === "digest") f.input.expectedDigest = "0".repeat(64);
    if (mode === "status") f.input.proposal = { ...f.input.proposal, status: "draft" };
    if (mode === "risk") f.input.proposal = { ...f.input.proposal, risk: "high" };
    if (mode === "paths") f.input.proposal = { ...f.input.proposal, proposed_changes: [] };
    if (mode === "risk" || mode === "paths") f.input.expectedDigest = improvementProposalDigest(f.input.proposal);
    if (mode === "gates") f.input.registryGates = [];
    if (mode === "reviewer") f.input.routing.verifierAgentIds = ["builder"];
    if (mode === "timeout") f.input.timeoutMs = 0;
    if (mode === "evidence") f.input.evidenceRoot = join(f.repoPath, "evidence");
    await expect(prepareImprovementCandidate(f.input)).rejects.toThrow();
    expect(f.repository.list({})).toEqual([]);
    expect(f.builderCount()).toBe(0);
  });
});

function adapter(id: string, run?: (task: AgentTask) => Promise<void>, judgments = true): AgentAdapter {
  return {
    id, display_name: id, cost_tier: "low", capabilities: () => [],
    isAvailable: async () => ({ available: true, last_checked_at: 0 }),
    async *invoke(task) {
      await run?.(task);
      const event: HermesEvent = {
        event_id: `${task.run_id}:1`, seq: 1, run_id: task.run_id, session_id: task.session_id,
        created_at: Date.now() / 1000, terminal: true, type: "done",
        payload: { status: "completed", last_seq: 1, result_summary: "fixture completed",
          ...(id === "reviewer" && judgments ? { evaluation_judgments: [{ id: "improvement-review", pass: true, severity: "error" as const, summary: "implements approved proposal" }] } : {}),
        },
      };
      yield event;
    },
  };
}

async function git(cwd: string, args: string[]) {
  return (await exec("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd })).stdout.trim();
}


describe("one authorization to a real Git commit and simulated GitHub draft PR", () => {
  async function setup(drop?: "push" | "pr") {
    const f = await fixture();
    const { remote, base, writes, pulls, transport } = await simulatedImprovementGithub(f.root, f.repoPath, drop);
    const target = await prepareImprovementPrTarget({ repoPath: f.repoPath, baseSha: base, executionId: f.input.executionId, title: "Improve guide" }, transport);
    f.db.prepare("UPDATE improvement_proposals SET status = 'draft'").run();
    f.input.proposal.status = "draft";
    f.input.prDelivery = target;
    const prepared = await prepareImprovementCandidate(f.input);
    return { ...f, remote, base, transport, writes, pulls, target, prepared, ledger: new ImprovementPrDeliveryRepository(f.db, join(f.root, "state.db")) };
  }

  it("approves once and delivers only the saved verified patch, ignoring later builder edits", async () => {
    const f = await setup();
    expect(listImprovementProposals(f.db)[0]?.status).toBe("draft");
    const result = await executeImprovementCandidate(f.prepared, f.repository, f.adapters);
    expect(listImprovementProposals(f.db)[0]?.status).toBe("approved");
    expect(result.execution.state).toBe("candidate_verified");
    await writeFile(join(result.execution.worktree!.worktreePath, "docs/guide.md"), "unreviewed late edit\n");
    await deliverImprovementPr(result.execution, f.ledger, f.transport);
    const delivered = f.ledger.get(f.input.executionId)!;
    expect(delivered).toMatchObject({ state: "delivered", pr: { url: "https://github.com/studio/project/pull/17" } });
    expect(f.writes).toEqual(["push", "pr"]);
    expect(await git(f.remote, ["show", `${delivered.commit!.commit_sha}:docs/guide.md`])).toBe("improved");
    expect(await git(f.repoPath, ["rev-parse", "HEAD"])).toBe(f.base);
    expect(await executeImprovementCandidate(f.prepared, f.repository, f.adapters)).toMatchObject({ replay: true });
    await deliverImprovementPr(result.execution, f.ledger, f.transport);
    expect(f.writes).toEqual(["push", "pr"]);
    expect(f.builderCount()).toBe(1);
  }, 20_000);

  it.each(["push", "pr"] as const)("reconciles a lost %s response without sending a second write", async (drop) => {
    const f = await setup(drop);
    const result = await executeImprovementCandidate(f.prepared, f.repository, f.adapters);
    await deliverImprovementPr(result.execution, f.ledger, f.transport);
    expect(f.ledger.get(f.input.executionId)?.state).toBe(drop === "push" ? "push_dispatched" : "pr_dispatched");
    const writes = [...f.writes];
    await reconcileImprovementPr(f.input.executionId, f.ledger, f.repoPath, f.transport);
    expect(f.ledger.get(f.input.executionId)?.state).toBe(drop === "push" ? "pushed" : "delivered");
    await deliverImprovementPr(result.execution, f.ledger, f.transport);
    expect(f.writes).toEqual(writes);
  }, 20_000);

  it("refuses tampered artifacts before any GitHub write", async () => {
    const f = await setup();
    const result = await executeImprovementCandidate(f.prepared, f.repository, f.adapters);
    const directory = (result.execution.result as { evidence_directory: string }).evidence_directory;
    await writeFile(join(directory, "candidate.patch"), "tampered");
    await deliverImprovementPr(result.execution, f.ledger, f.transport);
    expect(f.ledger.get(f.input.executionId)?.error).toMatch(/digest/);
    expect(f.writes).toEqual([]);
  });
  it("refuses a moved remote base without rebasing or writing", async () => {
    const f = await setup();
    const result = await executeImprovementCandidate(f.prepared, f.repository, f.adapters);
    await git(f.repoPath, ["-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "--allow-empty", "-m", "base advanced"]);
    await git(f.repoPath, ["push", f.remote, "HEAD:main"]);
    await deliverImprovementPr(result.execution, f.ledger, f.transport);
    expect(f.ledger.get(f.input.executionId)?.error).toContain("base moved");
    expect(f.writes).toEqual([]);
  });

  it("never overwrites an existing delivery branch", async () => {
    const f = await setup();
    const result = await executeImprovementCandidate(f.prepared, f.repository, f.adapters);
    await git(f.remote, ["update-ref", `refs/heads/${f.target.branch}`, f.base]);
    await deliverImprovementPr(result.execution, f.ledger, f.transport);
    expect(f.ledger.get(f.input.executionId)?.state).toBe("push_dispatched");
    expect(await git(f.remote, ["rev-parse", `refs/heads/${f.target.branch}`])).toBe(f.base);
    expect(f.writes).toEqual([]);
    await expect(reconcileImprovementPr(f.input.executionId, f.ledger, f.repoPath, f.transport)).rejects.toThrow("differs");
  });

  it.each(["head", "base", "draft"])("does not report delivery when the observed PR %s binding differs", async (field) => {
    const f = await setup("pr");
    const result = await executeImprovementCandidate(f.prepared, f.repository, f.adapters);
    await deliverImprovementPr(result.execution, f.ledger, f.transport);
    const pr = f.pulls[0] as { head: { sha: string }; base: { sha: string }; draft: boolean };
    if (field === "draft") pr.draft = false;
    else if (field === "head") pr.head.sha = f.base;
    else pr.base.sha = "a".repeat(40);
    await expect(reconcileImprovementPr(f.input.executionId, f.ledger, f.repoPath, f.transport)).rejects.toThrow("could not be confirmed");
    expect(f.ledger.get(f.input.executionId)?.state).toBe("pr_dispatched");
    expect(f.writes).toEqual(["push", "pr"]);
  });

  it.each(["before push", "after push"])("honors a stop %s without issuing the next external action", async (when) => {
    const f = await setup();
    const result = await executeImprovementCandidate(f.prepared, f.repository, f.adapters);
    if (when === "before push") {
      f.repository.requestStop(f.input.executionId, "operator stop", Date.now() / 1000);
      await expect(deliverImprovementPr(result.execution, f.ledger, f.transport)).rejects.toThrow("stop");
      expect(f.writes).toEqual([]);
    } else {
      const transport = { run: async (...args: Parameters<typeof f.transport.run>) => {
        const value = await f.transport.run(...args);
        if (args[0] === "git" && args[1].includes("push")) f.repository.requestStop(f.input.executionId, "operator stop", Date.now() / 1000);
        return value;
      } };
      await deliverImprovementPr(result.execution, f.ledger, transport);
      expect(f.ledger.get(f.input.executionId)).toMatchObject({ state: "pushed", stop: { reason: "operator stop" } });
      expect(f.writes).toEqual(["push"]);
    }
  });

  it("requires clean reconstruction gates to pass, even if the candidate gate passed", async () => {
    const f = await setup();
    const command = `node -e "if(process.cwd().includes('osstack-pr-rebuild-')) process.exit(1)"`;
    f.input.registryGates = [command];
    const prepared = await prepareImprovementCandidate(f.input);
    const result = await executeImprovementCandidate(prepared, f.repository, f.adapters);
    expect(result.execution.state).toBe("candidate_verified");
    await deliverImprovementPr(result.execution, f.ledger, f.transport);
    expect(f.ledger.get(f.input.executionId)).toMatchObject({ state: "preparing", error: expect.stringContaining("Clean reconstruction verification failed") });
    expect(f.writes).toEqual([]);
    await deliverImprovementPr(result.execution, f.ledger, f.transport);
    expect(f.builderCount()).toBe(1);
  });

});
