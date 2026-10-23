import { join } from "node:path";
import {
  approveImprovementProposal,
  improvementProposalDigest,
  improvementExecutionRequestDigest,
  ImprovementExecutionRepository,
  ImprovementPrDeliveryRepository,
  type ImprovementPrTarget,
  listImprovementProposals,
} from "@osstack/core";
import { readRepoRegistry } from "@osstack/supervisor";
import { executeImprovementCandidate, prepareImprovementCandidate } from "./improvement-candidate.js";
import { createImprovementExecutionAdapters } from "./improvement-execution-adapters.js";
import { resolveLoopProfileRouting } from "./loop-profile-routing.js";
import { osstackHome } from "./paths.js";
import { flag, hasFlag, openStateDb, printJson, resolveRegistryPath } from "./supervisor-cli-support.js";

export async function handleImprovementExecutionCommand(sub: string, args: string[]): Promise<number> {
  const { db, dbPath } = await openStateDb();
  try {
    const repository = new ImprovementExecutionRepository(db, dbPath);
    const deliveries = new ImprovementPrDeliveryRepository(db, dbPath);
    const existingId = flag(args, "--execution");
    const existing = existingId === undefined ? undefined : repository.get(existingId);
    if (sub === "deliver" && existing !== undefined) {
      if (existing.request.mode !== "local_candidate_to_pr") throw new Error("This execution was not authorized for PR delivery; use a new execution ID");
      if (hasFlag(args, "--yes") && flag(args, "--request-digest") !== existing.request_sha256) throw new Error("Replay requires the original request digest");
      const delivery = deliveries.get(existing.execution_id);
      printJson({ replay: true, execution: existing, delivery, applied: false });
      return delivery?.state === "delivered" ? 0 : 2;
    }
    if (sub === "baseline") {
      const proposalId = flag(args, "--proposal");
      printJson(repository.baseline({ now: Date.now() / 1000,
        ...(proposalId === undefined ? {} : { proposal_id: proposalId }),
      }));
      return 0;
    }
    if (sub === "stop") {
      const id = flag(args, "--execution");
      const reason = flag(args, "--reason");
      if (id === undefined || reason === undefined || reason.trim() === "" || reason.length > 2000 || reason.includes("\0")) {
        throw new Error("improve stop requires --execution <id> and --reason <1..2000 characters>");
      }
      const current = repository.get(id);
      if (current === undefined) throw new Error(`no execution with id ${id}`);
      const dryRun = !hasFlag(args, "--yes");
      const execution = dryRun ? current : repository.requestStop(id, reason, Date.now() / 1000);
      printJson({ dry_run: dryRun, execution, delivery: deliveries.get(id), process_termination_confirmed: false,
        message: "Stop is cooperative at stage boundaries; it retains active occupancy and does not kill processes or authorize retry.",
      });
      return 0;
    }
    if (sub === "status") {
      const id = flag(args, "--execution");
      if (id === undefined) throw new Error("improve status requires --execution <id>");
      const execution = repository.get(id);
      if (execution === undefined) throw new Error(`no execution with id ${id}`);
      if (hasFlag(args, "--reconcile")) {
        const { reconcileImprovementPr } = await import("./improvement-pr-delivery.js");
        await reconcileImprovementPr(id, deliveries, osstackHome());
      }
      const delivery = deliveries.get(id);
      const environment = execution.request.environment === undefined ? undefined
        : await (await import("./improvement-environment.js")).improvementEnvironmentStatus(execution, delivery);
      printJson({ applied: false, execution, delivery, ...(environment === undefined ? {} : { environment }) });
      return 0;
    }
    const proposalId = flag(args, "--proposal");
    if (proposalId === undefined) throw new Error(`improve ${sub} requires --proposal <id>`);
    const proposal = listImprovementProposals(db, { proposal_id: proposalId })[0];
    if (proposal === undefined) throw new Error(`no proposal with id ${proposalId}`);
    const proposalDigest = improvementProposalDigest(proposal);
    if (sub === "inspect") {
      printJson({ proposal, proposal_digest: proposalDigest, executions: repository.list({ proposal_id: proposalId, limit: 20 }) });
      return 0;
    }
    const expectedDigest = flag(args, "--digest") ?? (sub === "deliver" ? proposalDigest : undefined);
    if (expectedDigest === undefined) throw new Error(`improve ${sub} requires --digest from improve inspect`);
    if (sub === "approve") {
      if (!hasFlag(args, "--yes")) {
        printJson({ dry_run: true, proposal, proposal_digest: proposalDigest, digest_matches: expectedDigest === proposalDigest });
        return expectedDigest === proposalDigest ? 0 : 2;
      }
      const approved = approveImprovementProposal(db, dbPath, {
        proposal_id: proposalId, expected_digest: expectedDigest, now: Date.now() / 1000,
      });
      printJson({ proposal: approved, proposal_digest: proposalDigest, authorization: "local_operator_candidate_only" });
      return 0;
    }
    const executionId = flag(args, "--execution");
    if (executionId === undefined) throw new Error("improve execute requires --execution <stable-id>");
    const registry = await readRepoRegistry(resolveRegistryPath(args));
    const entries = registry.filter((entry) => entry.repo_id === proposal.repo_id);
    const entry = entries[0];
    if (entries.length !== 1 || entry === undefined || !entry.enabled) {
      throw new Error("proposal repository must have exactly one enabled registry entry");
    }
    const adapters = createImprovementExecutionAdapters();
    const routing = await resolveLoopProfileRouting(["--auto-agent", ...args], undefined, [], { adapters: () => adapters });
    if (routing instanceof Error) throw routing;
    if (routing === undefined) throw new Error("candidate execution requires an execution profile");
    let prDelivery: ImprovementPrTarget | undefined;
    let expectedBase: string | undefined;
    if (sub === "deliver") {
      const { prepareImprovementPrTarget, improvementPrTransport } = await import("./improvement-pr-delivery.js");
      expectedBase = (await improvementPrTransport.run("git", ["rev-parse", "HEAD"], entry.path)).toString().trim();
      const base = flag(args, "--base");
      prDelivery = await prepareImprovementPrTarget({ repoPath: entry.path, baseSha: expectedBase, executionId,
        title: proposal.title, ...(base === undefined ? {} : { base }),
      });
    }
    const preparation = flag(args, "--prepare-deps");
    if (hasFlag(args, "--prepare-deps") && (preparation !== "pnpm" || sub !== "deliver")) throw new Error("--prepare-deps pnpm is supported only for improve deliver");
    const buildDeps = flag(args, "--build-deps");
    if (hasFlag(args, "--build-deps") && (!buildDeps || preparation !== "pnpm" || sub !== "deliver")) throw new Error("--build-deps <name@version,...> requires improve deliver --prepare-deps pnpm");
    const prepared = await prepareImprovementCandidate({
      executionId, expectedDigest, proposal, repoPath: entry.path,
      ...(buildDeps === undefined ? {} : { buildDeps: buildDeps.split(",") }),
      registryGates: entry.verify_commands, routing,
      timeoutMs: Number(flag(args, "--timeout-ms") ?? "120000"),
      evidenceRoot: join(osstackHome(), "improvement-executions"),
      ...(prDelivery === undefined ? {} : { prDelivery }),
      ...(preparation === undefined ? {} : { prepareDeps: "pnpm" as const }),
    });
    if (expectedBase !== undefined && expectedBase !== prepared.baseSha) throw new Error("Local base changed during preview");
    const requestDigest = improvementExecutionRequestDigest(prepared.request);
    if (!hasFlag(args, "--yes")) {
      printJson({ dry_run: true, applied: false, request: prepared.request, request_digest: requestDigest });
      return 0;
    }
    if (flag(args, "--request-digest") !== requestDigest) {
      throw new Error("improve execute --yes requires the current --request-digest from its preview; repository, gates or profile may have changed");
    }
    const result = await executeImprovementCandidate(prepared, repository, (workspacePath, homePath) => createImprovementExecutionAdapters({
      workspacePath, homePath, builderAgentId: routing.agentId, evaluatorAgentId: routing.verifierAgentIds[0]!,
    }));
    if (sub === "deliver") {
      if (!result.replay && result.execution.state === "candidate_verified") {
        const { deliverImprovementPr } = await import("./improvement-pr-delivery.js");
        await deliverImprovementPr(result.execution, deliveries);
      } else if (!result.replay) deliveries.recordError(executionId, "Candidate did not pass verification; no PR writes attempted", Date.now() / 1000);
      const delivery = deliveries.get(executionId);
      printJson({ applied: false, ...result, delivery });
      return delivery?.state === "delivered" ? 0 : 2;
    }
    printJson({ applied: false, ...result });
    return result.execution.state === "candidate_verified" ? 0 : 2;
  } catch (error) {
    console.error(`osstack: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  } finally {
    db.close();
  }
}
