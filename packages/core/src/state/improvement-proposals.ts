import { createHash } from "node:crypto";
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

/** Digest of the reviewed definition; source evidence is an unordered set. */
export function improvementProposalDigest(proposal: NewImprovementProposal | ImprovementProposalView): string {
  return createHash("sha256").update(proposalDefinition(proposal)).digest("hex");
}

/** Records local operator confirmation, not GitHub or remote execution authority. */
export function approveImprovementProposal(
  db: Database.Database,
  dbPath: string,
  input: { proposal_id: string; expected_digest: string; now: number },
): ImprovementProposalView {
  if (!/^[a-f0-9]{64}$/.test(input.expected_digest)) throw new Error("Invalid proposal digest");
  if (!Number.isFinite(input.now) || input.now < 0) throw new Error("Invalid approval timestamp");
  return withWrite(db, dbPath, (d) => {
    const raw = d.prepare("SELECT * FROM improvement_proposals WHERE proposal_id = ?").get(input.proposal_id);
    if (raw === undefined) throw new Error(`Improvement proposal not found: ${input.proposal_id}`);
    const proposal = parseImprovementProposal(raw);
    if (improvementProposalDigest(proposal) !== input.expected_digest) throw new Error("Improvement proposal digest conflict");
    if (proposal.status === "applied" || proposal.status === "rejected") throw new Error("Cannot approve a terminal improvement proposal");
    if (proposal.status === "approved") return proposal;
    const changed = d.prepare(`UPDATE improvement_proposals SET status = 'approved', updated_at = ?
      WHERE proposal_id = ? AND status = ? AND updated_at = ?`)
      .run(input.now, input.proposal_id, proposal.status, proposal.updated_at);
    if (changed.changes !== 1) throw new Error("Improvement proposal approval CAS conflict");
    return { ...proposal, status: "approved", updated_at: input.now };
  });
}

export function upsertImprovementProposal(
  db: Database.Database,
  dbPath: string,
  proposal: NewImprovementProposal,
): ImprovementProposalView {
  return withWrite(db, dbPath, (d) => {
    const raw = d.prepare("SELECT * FROM improvement_proposals WHERE proposal_id = ?").get(proposal.proposal_id) as unknown;
    const existing = raw === undefined ? undefined : parseImprovementProposal(raw);
    if (existing !== undefined) {
      if (existing.repo_id !== proposal.repo_id
        || (sourceIdentity(existing) !== sourceIdentity(proposal) && !isLegacyDraftEvidenceExtension(existing, proposal))) {
        throw new Error(`Improvement proposal identity conflict: ${proposal.proposal_id}`);
      }
      // v2 IDs bind content. Legacy producers can refresh draft content and
      // append recurrence evidence in place; reviewed definitions stay frozen.
      if (proposalDefinition(existing) !== proposalDefinition(proposal)
        && (proposal.proposal_id.startsWith("prop_v2_") || existing.status !== "draft")) {
        throw new Error(`Improvement proposal content conflict: ${proposal.proposal_id}`);
      }
    }
    const status = existing !== undefined && (proposal.status === undefined || proposal.status === "draft")
      ? existing.status
      : proposal.status ?? "draft";
    // A gate result can arrive after another caller has closed the proposal.
    // Preserve the terminal record even when the stale writer is explicit.
    if (existing !== undefined && (existing.status === "applied" || existing.status === "rejected")
      && status !== existing.status) {
      throw new Error(`Improvement proposal status conflict: ${proposal.proposal_id}`);
    }
    if (existing !== undefined && existing.status === status
      && proposalDefinition(existing) === proposalDefinition(proposal)) return existing;

    const now = Date.now() / 1000;
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
      status,
      created_at: existing?.created_at ?? now,
      updated_at: now,
    });
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
    return parseImprovementProposal(row);
  });
}

function sourceIdentity(proposal: NewImprovementProposal): string {
  return JSON.stringify([...new Set(proposal.source_asset_ids)].sort());
}

function isLegacyDraftEvidenceExtension(existing: ImprovementProposalView, proposal: NewImprovementProposal): boolean {
  if (existing.proposal_id.startsWith("prop_v2_") || existing.status !== "draft"
    || (proposal.status !== undefined && proposal.status !== "draft")
    || existing.repo_id !== proposal.repo_id || existing.target !== proposal.target) return false;
  // NEAT uses a stable repo/rule ID as subsequent runs add evidence. Keep every
  // prior source so this compatibility path cannot replace an unrelated origin.
  const nextSources = new Set(proposal.source_asset_ids);
  return existing.source_asset_ids.every((source) => nextSources.has(source));
}

function proposalDefinition(proposal: NewImprovementProposal): string {
  return JSON.stringify({
    repo_id: proposal.repo_id,
    source_asset_ids: sourceIdentity(proposal),
    target: proposal.target,
    risk: proposal.risk,
    title: proposal.title,
    rationale: proposal.rationale,
    proposed_changes: proposal.proposed_changes.map(({ path, action, summary }) => ({ path, action, summary })),
    required_gates: proposal.required_gates,
  });
}

export function listImprovementProposals(
  db: Database.Database,
  opts: { proposal_id?: string; repo_id?: string; status?: ImprovementStatus; limit?: number } = {},
): ImprovementProposalView[] {
  const where: string[] = ["1 = 1"];
  const params: unknown[] = [];
  if (opts.proposal_id !== undefined) {
    where.push("proposal_id = ?");
    params.push(opts.proposal_id);
  }
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
