import type Database from "better-sqlite3";
import { withWrite } from "./db.js";
import { ImprovementProposalRow } from "./schema.js";

export type ImprovementRisk = "low" | "medium" | "high";
export type ImprovementStatus = "draft" | "needs_human" | "approved" | "applied" | "rejected" | "blocked";

export interface ProposedChange {
  path: string;
  action: "create" | "modify" | "delete";
  summary: string;
}

export interface NewImprovementProposal {
  proposal_id: string;
  repo_id: string;
  source_asset_ids: string[];
  target: string;
  risk: ImprovementRisk;
  title: string;
  rationale: string;
  proposed_changes: ProposedChange[];
  required_gates: string[];
  status?: ImprovementStatus;
}

export interface ImprovementProposalView {
  proposal_id: string;
  repo_id: string;
  source_asset_ids: string[];
  target: string;
  risk: ImprovementRisk;
  title: string;
  rationale: string;
  proposed_changes: ProposedChange[];
  required_gates: string[];
  status: ImprovementStatus;
  created_at: number;
  updated_at: number;
}

export function upsertImprovementProposal(
  db: Database.Database,
  dbPath: string,
  proposal: NewImprovementProposal,
): ImprovementProposalView {
  const now = Date.now() / 1000;
  const existing = db.prepare("SELECT * FROM improvement_proposals WHERE proposal_id = ?").get(proposal.proposal_id) as unknown;
  const createdAt = existing !== undefined ? ImprovementProposalRow.parse(existing).created_at : now;

  const row = ImprovementProposalRow.parse({
    proposal_id: proposal.proposal_id,
    repo_id: proposal.repo_id,
    source_asset_ids_json: JSON.stringify(proposal.source_asset_ids),
    target: proposal.target,
    risk: proposal.risk,
    title: proposal.title,
    rationale: proposal.rationale,
    proposed_changes_json: JSON.stringify(proposal.proposed_changes),
    required_gates_json: JSON.stringify(proposal.required_gates),
    status: proposal.status ?? "draft",
    created_at: createdAt,
    updated_at: now,
  });

  withWrite(db, dbPath, (d) => {
    d.prepare(`
      INSERT INTO improvement_proposals (
        proposal_id, repo_id, source_asset_ids_json, target, risk, title, rationale,
        proposed_changes_json, required_gates_json, status, created_at, updated_at
      ) VALUES (
        @proposal_id, @repo_id, @source_asset_ids_json, @target, @risk, @title, @rationale,
        @proposed_changes_json, @required_gates_json, @status, @created_at, @updated_at
      )
      ON CONFLICT(proposal_id) DO UPDATE SET
        repo_id = excluded.repo_id,
        source_asset_ids_json = excluded.source_asset_ids_json,
        target = excluded.target,
        risk = excluded.risk,
        title = excluded.title,
        rationale = excluded.rationale,
        proposed_changes_json = excluded.proposed_changes_json,
        required_gates_json = excluded.required_gates_json,
        status = excluded.status,
        updated_at = excluded.updated_at
    `).run(row);
  });

  return parseImprovementProposal(row);
}

export function listImprovementProposals(
  db: Database.Database,
  opts: { repo_id?: string; status?: ImprovementStatus; limit?: number } = {},
): ImprovementProposalView[] {
  const where: string[] = ["1 = 1"];
  const params: unknown[] = [];
  if (opts.repo_id !== undefined) {
    where.push("repo_id = ?");
    params.push(opts.repo_id);
  }
  if (opts.status !== undefined) {
    where.push("status = ?");
    params.push(opts.status);
  }
  params.push(opts.limit ?? 50);
  const rows = db.prepare(`
    SELECT * FROM improvement_proposals
    WHERE ${where.join(" AND ")}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...params) as unknown[];
  return rows.map(parseImprovementProposal);
}

function parseImprovementProposal(row: unknown): ImprovementProposalView {
  const parsed = ImprovementProposalRow.parse(row);
  return {
    proposal_id: parsed.proposal_id,
    repo_id: parsed.repo_id,
    source_asset_ids: parseStringArray(parsed.source_asset_ids_json),
    target: parsed.target,
    risk: parsed.risk,
    title: parsed.title,
    rationale: parsed.rationale,
    proposed_changes: parseChanges(parsed.proposed_changes_json),
    required_gates: parseStringArray(parsed.required_gates_json),
    status: parsed.status,
    created_at: parsed.created_at,
    updated_at: parsed.updated_at,
  };
}

function parseChanges(raw: string): ProposedChange[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((entry) => {
      if (entry === null || typeof entry !== "object") return [];
      const candidate = entry as Record<string, unknown>;
      if (typeof candidate["path"] !== "string" || typeof candidate["summary"] !== "string") return [];
      const action = candidate["action"];
      if (action !== "create" && action !== "modify" && action !== "delete") return [];
      return [{ path: candidate["path"], action, summary: candidate["summary"] }];
    });
  } catch {
    return [];
  }
}

function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
