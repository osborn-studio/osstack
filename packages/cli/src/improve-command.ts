// `osstack improve propose|apply` — turn stored feedback assets into risk-rated
// proposals and (only with --yes) check their gates against the current repo.
// Candidate implementation is not available yet. Passing existing-repo gates
// must not be persisted or reported as an applied improvement.

import { spawn } from "node:child_process";
import {
  listFeedbackAssets,
  listImprovementProposals,
  upsertImprovementProposal,
  type FeedbackAssetView,
} from "@osstack/core";
import {
  FeedbackAsset,
  ImprovementProposal,
  decideProposalGate,
  proposeImprovement,
  readRepoRegistry,
} from "@osstack/supervisor";
import {
  epochToIso,
  flag,
  hasFlag,
  openStateDb,
  printJson,
  resolveRegistryPath,
} from "./supervisor-cli-support.js";

export async function handleImproveCommand(args: string[]): Promise<number> {
  const sub = args[0];
  const rest = args.slice(1);
  if (sub === "propose") return await improvePropose(rest);
  if (sub === "apply") return await improveApply(rest);
  if (sub === "help" || sub === "--help" || sub === "-h" || sub === undefined) {
    console.log(`osstack improve — proposals from feedback assets

  improve propose --repo <id> [--from-assets] [--registry P] [--json]
  improve apply --proposal <id> [--yes] [--json]   (dry-run by default)

  --yes checks gates only. Proposal changes are not implemented by this command.
`);
    return 0;
  }
  console.error(`osstack: unknown improve subcommand "${sub}"`);
  return 1;
}

async function improvePropose(args: string[]): Promise<number> {
  const repoId = flag(args, "--repo");
  if (repoId === undefined) {
    console.error("osstack: improve propose requires --repo <id>");
    return 1;
  }
  const registryPath = resolveRegistryPath(args);
  const registry = await readRepoRegistry(registryPath);
  const verifyCommands = registry.find((entry) => entry.repo_id === repoId)?.verify_commands ?? [];

  const { db, dbPath } = await openStateDb();
  try {
    const stored = listFeedbackAssets(db, { repo_id: repoId, status: "proposed", limit: 1000 });
    const assets = stored.flatMap((view) => toSupervisorAsset(view));
    const drafts = proposeImprovement({ repo_id: repoId, assets, verify_commands: verifyCommands });

    const proposals = drafts.map((proposal) => {
      const persisted = upsertImprovementProposal(db, dbPath, {
        proposal_id: proposal.proposal_id,
        repo_id: proposal.repo_id,
        source_asset_ids: proposal.source_asset_ids,
        target: proposal.target,
        risk: proposal.risk,
        title: proposal.title,
        rationale: proposal.rationale,
        proposed_changes: proposal.proposed_changes,
        required_gates: proposal.required_gates,
      });
      return toSupervisorProposal(persisted);
    });

    if (hasFlag(args, "--json")) {
      printJson({ proposals });
    } else if (proposals.length === 0) {
      console.log(`No proposable feedback assets for ${repoId}.`);
    } else {
      for (const proposal of proposals) {
        console.log(`${proposal.proposal_id} [${proposal.target}/${proposal.risk}] ${proposal.title}`);
      }
    }
    return 0;
  } finally {
    db.close();
  }
}

async function improveApply(args: string[]): Promise<number> {
  const proposalId = flag(args, "--proposal");
  if (proposalId === undefined) {
    console.error("osstack: improve apply requires --proposal <id>");
    return 1;
  }
  const apply = hasFlag(args, "--yes");
  const json = hasFlag(args, "--json");

  const { db, dbPath } = await openStateDb();
  try {
    const view = listImprovementProposals(db, { limit: 10_000 }).find((p) => p.proposal_id === proposalId);
    if (view === undefined) {
      console.error(`osstack: no proposal with id ${proposalId}`);
      return 1;
    }
    const proposal = toSupervisorProposal(view);

    // Dry run: report intent, never run gates or modify anything.
    if (!apply) {
      if (json) {
        printJson({ dry_run: true, applied: false, implementation_status: "not_implemented", proposal_id: proposalId, risk: proposal.risk, required_gates: proposal.required_gates, files: proposal.proposed_changes.map((c) => c.path) });
      } else {
        console.log(`DRY RUN: proposal ${proposalId}`);
        console.log(`Risk: ${proposal.risk}`);
        for (const gate of proposal.required_gates) console.log(`Gate: ${gate} -> not run in dry-run`);
        console.log("Proposed files (implementation not available):");
        if (proposal.proposed_changes.length === 0) console.log("  (none recorded)");
        for (const change of proposal.proposed_changes) console.log(`  - ${change.path}`);
        console.log("No files were modified. --yes checks current-repository gates only; it does not implement the proposal.");
      }
      return 0;
    }

    if (view.status === "applied" || view.status === "rejected") {
      const reason = view.status === "applied"
        ? "Historical applied status preserved; this command cannot establish whether a candidate was implemented or verified."
        : "Rejected proposal preserved; no gates or implementation were run.";
      if (json) printJson({ applied: false, action: "unchanged", proposal_id: proposalId, stored_status: view.status, reason });
      else console.log(`unchanged ${proposalId}: ${reason}`);
      return 0;
    }

    // These gates observe the current repository, not an implemented candidate.
    const registryPath = resolveRegistryPath(args);
    const registry = await readRepoRegistry(registryPath);
    const cwd = registry.find((entry) => entry.repo_id === view.repo_id)?.path ?? process.cwd();

    const decision = await decideProposalGate(proposal, {
      runGate: async (command) => runShell(command, cwd),
    });

    if (decision.action === "auto_applicable") {
      const reason = "Current-repository gates passed. Candidate implementation is not available; no proposal changes were applied or verified.";
      if (json) printJson({ applied: false, action: "gates_passed", implementation_status: "not_implemented", proposal_id: proposalId, stored_status: view.status, reason });
      else console.log(`not applied ${proposalId}: ${reason}`);
      return 0;
    }
    if (decision.action === "needs_human") {
      upsertImprovementProposal(db, dbPath, proposalToNew(view, "needs_human"));
      if (json) printJson({ applied: false, action: "needs_human", proposal_id: proposalId, reason: decision.reason });
      else console.log(`not applied (needs human approval): ${decision.reason}`);
      return 0;
    }
    // blocked
    upsertImprovementProposal(db, dbPath, proposalToNew(view, "blocked"));
    if (json) printJson({ applied: false, action: "blocked", proposal_id: proposalId, reason: decision.reason, ...(decision.failed_gate !== undefined ? { failed_gate: decision.failed_gate } : {}) });
    else console.error(`blocked: ${decision.reason}`);
    return 2;
  } finally {
    db.close();
  }
}

// ── mapping between core rows and supervisor domain shapes ──────────────────

function toSupervisorAsset(view: FeedbackAssetView): FeedbackAsset[] {
  const parsed = FeedbackAsset.safeParse({
    asset_id: view.asset_id,
    repo_id: view.repo_id,
    source_trace_id: view.source_trace_id,
    kind: view.kind,
    failure_family: view.failure_family,
    summary: view.summary,
    evidence: view.evidence,
    ...(view.suggested_storage_path !== null ? { suggested_storage_path: view.suggested_storage_path } : {}),
    status: view.status,
    created_at: epochToIso(view.created_at),
  });
  return parsed.success ? [parsed.data] : [];
}

function toSupervisorProposal(view: ReturnType<typeof listImprovementProposals>[number]): ImprovementProposal {
  return ImprovementProposal.parse({
    proposal_id: view.proposal_id,
    repo_id: view.repo_id,
    source_asset_ids: view.source_asset_ids,
    target: view.target,
    risk: view.risk,
    title: view.title,
    rationale: view.rationale,
    proposed_changes: view.proposed_changes,
    required_gates: view.required_gates,
    status: view.status,
    created_at: epochToIso(view.created_at),
  });
}

function proposalToNew(
  view: ReturnType<typeof listImprovementProposals>[number],
  status: "needs_human" | "blocked",
) {
  return {
    proposal_id: view.proposal_id,
    repo_id: view.repo_id,
    source_asset_ids: view.source_asset_ids,
    target: view.target,
    risk: view.risk,
    title: view.title,
    rationale: view.rationale,
    proposed_changes: view.proposed_changes,
    required_gates: view.required_gates,
    status,
  };
}

function runShell(command: string, cwd: string): Promise<{ pass: boolean; summary: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c: Buffer) => { out = (out + c.toString("utf8")).slice(-2000); });
    child.stderr.on("data", (c: Buffer) => { out = (out + c.toString("utf8")).slice(-2000); });
    child.on("error", (err) => resolve({ pass: false, summary: err.message }));
    child.on("close", (code) => resolve({ pass: code === 0, summary: out.replace(/\s+/g, " ").trim().slice(0, 200) || `exit ${code}` }));
  });
}
