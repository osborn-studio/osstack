import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";
import { buildAgentChildEnv, createWorktree, type AgentAdapter } from "@osstack/agents";
import {
  improvementProposalDigest,
  type ImprovementExecutionRepository,
  type ImprovementExecutionView,
  type ImprovementProposalView,
  type ImprovementPrTarget,
} from "@osstack/core";
import { DEFAULT_REVIEW_BOUNDARY_POLICY, executePlan, planTask, Task, verifyRun } from "@osstack/loop";
import type { LoopProfileRoutingResult } from "./loop-profile-routing.js";
import {
  assertCandidateUnchanged,
  captureImprovementCandidate,
  validateImprovementPaths,
} from "./improvement-candidate-artifacts.js";

const exec = promisify(execFile);
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

export interface ImprovementCandidateInput {
  executionId: string;
  expectedDigest: string;
  proposal: ImprovementProposalView;
  repoPath: string;
  registryGates: string[];
  routing: LoopProfileRoutingResult;
  timeoutMs: number;
  evidenceRoot: string;
  prDelivery?: ImprovementPrTarget;
  prepareDeps?: "pnpm";
  buildDeps?: string[];
}

/** Local operator execution only. A session phase grant cannot call this path. */
export async function prepareImprovementCandidate(input: ImprovementCandidateInput) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(input.executionId)) {
    throw new Error("execution ID must be 1–128 letters, digits, dots, underscores or hyphens");
  }
  if (input.proposal.status !== "approved" && !(input.prDelivery !== undefined && input.proposal.status === "draft")) throw new Error("proposal is not approved");
  if (improvementProposalDigest(input.proposal) !== input.expectedDigest) {
    throw new Error("proposal digest changed; inspect and approve the current definition");
  }
  if (input.proposal.risk !== "low" || !["docs", "test", "eval"].includes(input.proposal.target)) {
    throw new Error("candidate execution currently supports approved low-risk docs/test/eval proposals");
  }
  const paths = input.proposal.proposed_changes.map((change) => change.path);
  validateImprovementPaths(paths);
  if (input.proposal.required_gates.length === 0 || input.registryGates.length === 0) {
    throw new Error("proposal and registered repository must both specify verification commands");
  }
  const commands = [...new Set([...input.proposal.required_gates, ...input.registryGates])];
  if (commands.some((command) => command.trim() === "")) throw new Error("empty verification command");
  if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1_000 || input.timeoutMs > 600_000) {
    throw new Error("timeout must be an integer between 1000 and 600000 milliseconds per stage");
  }
  if (!input.routing.summary.independent || input.routing.verifierAgentIds.length !== 1
    || input.routing.agentId === input.routing.verifierAgentIds[0]
    || input.routing.summary.builder_agent_id !== input.routing.agentId
    || input.routing.summary.evaluator_agent_id !== input.routing.verifierAgentIds[0]) {
    throw new Error("an independent Builder and Evaluator are required");
  }
  if (!isAbsolute(input.repoPath) || !isAbsolute(input.evidenceRoot)) throw new Error("repository and evidence paths must be absolute");
  const repoPath = await realpath(input.repoPath);
  const top = await git(repoPath, ["rev-parse", "--show-toplevel"]);
  if (await realpath(top) !== repoPath) throw new Error("registered path must be the repository root");
  const lexicalRelative = relative(repoPath, input.evidenceRoot);
  if (lexicalRelative === "" || (!lexicalRelative.startsWith("../") && !isAbsolute(lexicalRelative))) {
    throw new Error("evidence root must be outside the candidate repository");
  }
  await mkdir(input.evidenceRoot, { recursive: true, mode: 0o700 });
  const evidenceRoot = await realpath(input.evidenceRoot);
  const rel = relative(repoPath, evidenceRoot);
  if (rel === "" || (!rel.startsWith("../") && !isAbsolute(rel))) throw new Error("evidence root must be outside the candidate repository");
  const baseSha = await git(repoPath, ["rev-parse", "HEAD"]);
  if (input.prepareDeps !== undefined && input.prDelivery === undefined) throw new Error("Dependency preparation requires improve deliver");
  if (input.buildDeps !== undefined && input.prepareDeps !== "pnpm") throw new Error("Dependency builds require --prepare-deps pnpm");
  const environment = input.prepareDeps === undefined ? undefined
    : await (await import("./improvement-environment.js")).previewImprovementEnvironment(repoPath, baseSha, input.buildDeps);
  const request = {
    schema_version: 1,
    proposal_digest: input.expectedDigest,
    proposal: input.proposal,
    repo_path: repoPath,
    base_sha: baseSha,
    allowed_paths: paths,
    verify_commands: commands,
    profile: input.routing.summary,
    timeout_ms: input.timeoutMs,
    evidence_root: evidenceRoot,
    ...(environment === undefined ? {} : { environment }),
    mode: input.prDelivery === undefined ? "local_candidate_only" : "local_candidate_to_pr",
    ...(input.prDelivery === undefined ? {} : { pr_delivery: input.prDelivery,
      limits: { builder_invocations: 1, evaluator_invocations: 1, verification_command_runs: commands.length * 2,
        automatic_retries: 0, stage_timeout_ms: input.timeoutMs, cost_usd: null },
    }),
  };
  return freezeDeep(structuredClone({ input, request, repoPath, evidenceRoot, baseSha, paths, commands }));
}

export async function executeImprovementCandidate(
  prepared: Awaited<ReturnType<typeof prepareImprovementCandidate>>,
  repository: ImprovementExecutionRepository,
  adapters: readonly AgentAdapter[] | ((workspacePath: string, homePath: string) => readonly AgentAdapter[]),
): Promise<{ replay: boolean; execution: ImprovementExecutionView }> {
  const { input, request, repoPath, evidenceRoot, baseSha, paths, commands } = prepared;
  // The repository validates the approved definition inside this same write.
  const claim = repository.claim({
    execution_id: input.executionId,
    proposal_id: input.proposal.proposal_id,
    request: JSON.parse(JSON.stringify(request)),
    ...(input.prDelivery === undefined ? {} : { approve_proposal: true }),
    now: Date.now() / 1000,
  });
  if (claim.outcome === "replay") return { replay: true, execution: claim.execution };
  const worker = claim.execution.worker!;
  const check = () => repository.assertWorker(input.executionId, worker);
  let executionUncertain = false;
  const directory = join(evidenceRoot, digest(input.executionId));
  const artifacts: Array<{ name: string; sha256: string }> = [];
  const save = async (name: string, value: unknown, raw = false) => {
    const content = raw ? String(value) : `${JSON.stringify(value, null, 2)}\n`;
    await writeFile(join(directory, name), content, { mode: 0o600, flag: "wx" });
    artifacts.push({ name, sha256: digest(content) });
  };
  try {
    check();
    await mkdir(directory, { mode: 0o700 });
    await save("request.json", request);
    check();
    const worktree = await createWorktree({
      repoPath, runId: input.executionId, baseRef: baseSha,
      branchPrefix: "codex/improve", rootPath: join(directory, "worktrees"),
    });
    repository.recordWorktree(input.executionId, worktree, Date.now() / 1000, worker);
    const task = Task.parse({
      task_id: `improvement_${input.executionId}`, capability: "code.fix", source: "manual",
      prompt: [
        "Implement this approved improvement in the provided candidate worktree.",
        "Modify only the exact allowed paths. Do not commit, merge, push, release, or modify Git/configuration/approval files.",
        "Preserve verification strength. Return an honest implementation summary.",
        JSON.stringify({ proposal: input.proposal, allowed_paths: paths, verify_commands: commands }),
      ].join("\n"),
      context: { proposal_digest: input.expectedDigest, allowed_paths: paths },
      evaluation: [{
        id: "improvement-review", mode: "semantic_review", required: true,
        description: "Independently review whether the candidate implements the proposal without weakening verification or introducing regressions. Review only; do not modify files.",
        acceptance: input.proposal.rationale,
      }],
    });
    const candidateHome = join(directory, "runtime-home");
    await mkdir(candidateHome, { mode: 0o700 });
    if (request.environment !== undefined) {
      executionUncertain = true;
      const { prepareImprovementEnvironment } = await import("./improvement-environment.js");
      const preparationDirectory = join(directory, "dependency-environment");
      await prepareImprovementEnvironment({ contract: request.environment, workspace: worktree.worktreePath,
        commit: baseSha, directory: preparationDirectory, timeoutMs: input.timeoutMs, checkActive: check });
      await save("environment.json", JSON.parse(await readFile(join(preparationDirectory, "completed.json"), "utf8")));
      executionUncertain = false;
      check();
    }
    const executionAdapters = typeof adapters === "function" ? adapters(worktree.worktreePath, candidateHome) : adapters;
    const checkedAdapters = executionAdapters.map((adapter) => requireCompletedStream(adapter, check));
    check();
    executionUncertain = true;
    const run = await executePlan(planTask(task, { agentId: input.routing.agentId, worktreePath: worktree.worktreePath, maxIterations: 1 }), {
      workspacePath: worktree.worktreePath, adapters: checkedAdapters, timeoutMs: input.timeoutMs,
    });
    await save("builder.json", run);
    if (run.outcome !== "completed") throw new Error(`builder ended ${run.outcome}: ${run.summary ?? "no summary"}`);
    executionUncertain = false;
    check();
    const before = await captureImprovementCandidate(worktree.worktreePath, baseSha, paths);
    await save("candidate.patch", before.patch, true);
    await save("candidate.json", before);
    // Our capture validates the complete diff (including staged/new files), not
    // the legacy verifier's weaker “at least one target path changed” check.
    check();
    executionUncertain = true;
    const verdict = await verifyRun(run, {
      workspacePath: worktree.worktreePath, task, commands,
      verifierAgentIds: input.routing.verifierAgentIds,
      adapters: checkedAdapters, timeoutMs: input.timeoutMs,
      ...(input.prDelivery === undefined
        ? { commandEnv: { OSSTACK_HOME: candidateHome, OSSTACK_AUTOAPPROVE: "0" } }
        : { inheritCommandEnv: false, commandEnv: request.environment !== undefined
          ? (await import("./improvement-environment.js")).improvementVerificationEnvironment(candidateHome, request.environment)
          : buildAgentChildEnv({ HOME: candidateHome, OSSTACK_HOME: candidateHome, OSSTACK_AUTOAPPROVE: "0",
          GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" }) }),
      reviewCandidate: { changed_paths: before.changed_paths, diff: before.patch },
      reviewBoundary: { allowed_extensions: [...DEFAULT_REVIEW_BOUNDARY_POLICY.allowed_extensions, ".jsonl"] },
    });
    await save("verification.json", verdict);
    // The legacy command audit folds signal exits into ordinary nonzero codes.
    // Until structured termination evidence exists, nonzero gates retain the slot.
    executionUncertain = verdict.issues.some((issue) => issue.rule === "verify.adapter_failed")
      || (verdict.verify_commands ?? []).some((command) => command.exit_code !== 0);
    check();
    const after = await captureImprovementCandidate(worktree.worktreePath, baseSha, paths);
    assertCandidateUnchanged(before, after);
    if (!verdict.pass) throw new Error(`candidate verification failed: ${verdict.summary}`);
    const result = {
      applied: false, effectiveness_proven: false, evidence_directory: directory,
      request_sha256: claim.execution.request_sha256,
      candidate_patch_sha256: after.patch_sha256, base_sha: baseSha,
      artifacts,
    };
    await save("manifest.json", { ...result, artifacts: [...artifacts] });
    return { replay: false, execution: repository.complete(input.executionId, "candidate_verified", result, Date.now() / 1000, worker) };
  } catch (error) {
    const current = repository.get(input.executionId)!;
    if (current.stop !== undefined) return { replay: false, execution: current };
    if (executionUncertain) {
      const detail = error instanceof Error ? error.message : String(error);
      return { replay: false, execution: repository.requestStop(input.executionId,
        `Execution outcome uncertain: ${detail}`.slice(0, 2000).replaceAll("\0", ""), Date.now() / 1000, "system_indeterminate") };
    }
    return { replay: false, execution: repository.complete(input.executionId, "candidate_failed", {
      applied: false, effectiveness_proven: false, evidence_directory: directory,
      error: error instanceof Error ? error.message : String(error), artifacts,
    }, Date.now() / 1000, worker) };
  }
}

// The legacy executor defaults to completed when a stream ends silently. This
// execution path requires a successful terminal receipt from each adapter. This
// does not attest to a provider-native completion or replace candidate checks.
function requireCompletedStream(adapter: AgentAdapter, check: () => void): AgentAdapter {
  return {
    id: adapter.id, display_name: adapter.display_name, cost_tier: adapter.cost_tier,
    capabilities: () => adapter.capabilities(), isAvailable: () => adapter.isAvailable(),
    async *invoke(task, signal) {
      check();
      let completed = false;
      let failed = false;
      for await (const event of adapter.invoke(task, signal)) {
        check();
        if (event.type === "error" && event.terminal) failed = true;
        if (event.type === "done") {
          completed = "status" in event.payload && event.payload.status === "completed";
          if (!completed) failed = true;
        }
        yield event;
      }
      if (!completed || failed || signal.aborted) throw new Error("agent did not produce a successful terminal receipt");
    },
  };
}

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await exec("git", ["-c", "core.hooksPath=/dev/null", ...args], { cwd, timeout: 10_000 });
  return stdout.trim();
}

function freezeDeep<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const child of Object.values(value)) freezeDeep(child);
    Object.freeze(value);
  }
  return value;
}
