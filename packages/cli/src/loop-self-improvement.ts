// Builds the loop's opt-in self-improvement callback (`loop run --self-improvement
// --repo-id <id>`). The loop package stays free of any @osstack/supervisor or
// SQLite dependency; all assetization + persistence lives here and is injected
// as a callback. The chain per completed task is:
//
//   CompletedTask -> RunTrace -> FeedbackAsset[] -> optional ImprovementProposal[]
//
// The returned ids/summary/level are attached back onto the CompletedTask by the
// loop engine. Persistence is additive and never destructive: assets/proposals
// are upserted into the local osstack state DB. Passing runs record only a trace
// (no assets, no proposals, nothing written).

import { upsertFeedbackAsset, upsertImprovementProposal } from "@osstack/core";
import type { SelfImprovementConfig, SelfImprovementResult } from "@osstack/loop";
import {
  assetizeFailure,
  proposeImprovement,
  readRepoRegistry,
  traceFromCompletedTask,
} from "@osstack/supervisor";
import { openStateDb } from "./supervisor-cli-support.js";

export interface SelfImprovementCliOptions {
  repoId: string;
  proposeImprovements: boolean;
  registryPath: string;
}

/**
 * Assemble the injected self-improvement config for a loop run. The callback is
 * defensive: it never throws (the loop engine also swallows errors, but keeping
 * the callback total means a DB hiccup degrades to "trace only" instead of a
 * dropped result).
 */
export function buildSelfImprovementConfig(options: SelfImprovementCliOptions): SelfImprovementConfig {
  return {
    repoId: options.repoId,
    enabled: true,
    proposeImprovements: options.proposeImprovements,
    assetize: async ({ repoId, completedTask, loopId, proposeImprovements }): Promise<SelfImprovementResult> => {
      const trace = traceFromCompletedTask({ repo_id: repoId, completedTask, loop_id: loopId });
      const assets = assetizeFailure(trace);

      const verifyCommands = proposeImprovements ? await verifyCommandsFor(repoId, options.registryPath) : [];
      const proposals = proposeImprovements && assets.length > 0
        ? proposeImprovement({ repo_id: repoId, assets, verify_commands: verifyCommands })
        : [];

      if (assets.length > 0 || proposals.length > 0) {
        const { db, dbPath } = await openStateDb();
        try {
          for (const asset of assets) {
            upsertFeedbackAsset(db, dbPath, {
              asset_id: asset.asset_id,
              repo_id: asset.repo_id,
              source_trace_id: asset.source_trace_id,
              kind: asset.kind,
              failure_family: asset.failure_family,
              summary: asset.summary,
              evidence: asset.evidence,
              ...(asset.suggested_storage_path !== undefined
                ? { suggested_storage_path: asset.suggested_storage_path }
                : {}),
            });
          }
          for (const proposal of proposals) {
            upsertImprovementProposal(db, dbPath, {
              proposal_id: proposal.proposal_id,
              repo_id: proposal.repo_id,
              source_asset_ids: proposal.source_asset_ids,
              target: proposal.target,
              risk: proposal.risk,
              title: proposal.title,
              rationale: proposal.rationale,
              proposed_changes: proposal.proposed_changes,
              required_gates: proposal.required_gates,
              status: "draft",
            });
          }
        } finally {
          db.close();
        }
      }

      return {
        trace_id: trace.trace_id,
        feedback_asset_ids: assets.map((a) => a.asset_id),
        proposal_ids: proposals.map((p) => p.proposal_id),
        assetization_summary: summarize(trace.verification.pass, assets.length, proposals.length),
        self_improvement_level: levelFor(trace.verification.pass, assets.length, proposals.length),
      };
    },
  };
}

/** Per-run self-improvement depth: 1 trace-only, 2 assets recorded, 3 proposals raised. */
function levelFor(pass: boolean, assetCount: number, proposalCount: number): number {
  if (proposalCount > 0) return 3;
  if (assetCount > 0) return 2;
  if (!pass) return 2;
  return 1;
}

function summarize(pass: boolean, assetCount: number, proposalCount: number): string {
  if (pass) return "run passed; trace recorded, no feedback assets";
  return `run failed; ${assetCount} feedback asset(s), ${proposalCount} proposal(s)`;
}

async function verifyCommandsFor(repoId: string, registryPath: string): Promise<string[]> {
  try {
    const registry = await readRepoRegistry(registryPath);
    return registry.find((entry) => entry.repo_id === repoId)?.verify_commands ?? [];
  } catch {
    return [];
  }
}
