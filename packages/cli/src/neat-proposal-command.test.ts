import {
  listImprovementProposals,
  openDb,
  recordKnowledgeHygieneRun,
  upsertImprovementProposal,
  type RecordKnowledgeHygieneRunInputV1,
} from "@osstack/core";
import { AgentCommandResult } from "@osstack/protocol";
import { createHash } from "node:crypto";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  handleNeatProposalCommand,
  type NeatProposalCommandDeps,
} from "./neat-proposal-command.js";

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function run(repoId: string, sequence: number): RecordKnowledgeHygieneRunInputV1 {
  return {
    report_sha256: hash(`${repoId}:${sequence}`),
    schema_version: "1",
    repo_id: repoId,
    repo_root: `/repos/${repoId}`,
    mode: "all",
    generated_at: sequence,
    complete: true,
    skipped_files: 0,
    summary: { error: 0, warning: 1, info: 0, suppressed: 0, resolved: 0 },
    findings: [{
      fingerprint: `khf_${hash(`${repoId}:README.md`)}`,
      rule_id: "contract.review_required",
      surface: "documentation",
      severity: "warning",
      confidence: "high",
      location_path: "README.md",
      rationale: "Review evidence is required.",
    }],
    resolved_findings: [],
  };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "osstack-neat-propose-"));
  const dbPath = join(root, "state.db");
  const db = openDb({ path: dbPath, minFreeBytes: 0 });
  for (const repoId of ["repo-a", "repo-b"]) {
    recordKnowledgeHygieneRun(db, run(repoId, 1));
    recordKnowledgeHygieneRun(db, run(repoId, 2));
  }
  db.close();
  const stdout: string[] = [];
  const stderr: string[] = [];
  const deps: NeatProposalCommandDeps = {
    cwd: () => root,
    stdout: (value: string) => stdout.push(value),
    stderr: (value: string) => stderr.push(value),
    now: () => new Date("2026-07-17T23:00:00.000Z"),
    authorize_write: async () => ({ allow: true }),
  };
  return {
    root,
    dbPath,
    stdout,
    stderr,
    deps,
  };
}

describe("neat propose command", () => {
  it("previews by default without writing proposals", async () => {
    const command = await fixture();

    expect(await handleNeatProposalCommand([
      "--db", command.dbPath,
      "--min-occurrences", "2",
      "--min-repositories", "2",
      "--json",
    ], command.deps)).toBe(0);

    const envelope = AgentCommandResult.parse(JSON.parse(command.stdout[0] ?? ""));
    expect(envelope).toMatchObject({
      status: "ok",
      result: { command: "knowledge_hygiene.propose", dry_run: true },
    });
    expect((envelope.result as { proposals: unknown[] }).proposals).toHaveLength(2);
    const db = openDb({ path: command.dbPath, minFreeBytes: 0 });
    expect(listImprovementProposals(db)).toEqual([]);
    db.close();
  });

  it("requires policy authorization before confirmed persistence", async () => {
    const command = await fixture();
    command.deps.authorize_write = async () => ({
      allow: false as const,
      reason: "policy_denied: observe",
    });

    expect(await handleNeatProposalCommand([
      "--db", command.dbPath,
      "--min-occurrences", "2",
      "--min-repositories", "2",
      "--yes",
      "--json",
    ], command.deps)).toBe(2);
    const envelope = AgentCommandResult.parse(JSON.parse(command.stdout[0] ?? ""));
    expect(envelope).toMatchObject({
      status: "blocked",
      error: { code: "policy_denied" },
    });
    const db = openDb({ path: command.dbPath, minFreeBytes: 0 });
    expect(listImprovementProposals(db)).toEqual([]);
    db.close();
  });

  it("persists stable drafts idempotently only with confirmation", async () => {
    const command = await fixture();
    const args = [
      "--db", command.dbPath,
      "--min-occurrences", "2",
      "--min-repositories", "2",
      "--yes",
      "--json",
    ];

    expect(await handleNeatProposalCommand(args, command.deps)).toBe(0);
    const firstDb = openDb({ path: command.dbPath, minFreeBytes: 0 });
    const reviewed = listImprovementProposals(firstDb, { limit: 10 })[0]!;
    upsertImprovementProposal(firstDb, command.dbPath, {
      proposal_id: reviewed.proposal_id,
      repo_id: reviewed.repo_id,
      source_asset_ids: reviewed.source_asset_ids,
      target: reviewed.target,
      risk: reviewed.risk,
      title: reviewed.title,
      rationale: reviewed.rationale,
      proposed_changes: reviewed.proposed_changes,
      required_gates: reviewed.required_gates,
      status: "needs_human",
    });
    firstDb.close();
    command.stdout.length = 0;
    expect(await handleNeatProposalCommand(args, command.deps)).toBe(0);

    const envelope = AgentCommandResult.parse(JSON.parse(command.stdout[0] ?? ""));
    expect(envelope).toMatchObject({
      status: "ok",
      result: { dry_run: false, persisted: 1, preserved: 1 },
    });
    const db = openDb({ path: command.dbPath, minFreeBytes: 0 });
    const proposals = listImprovementProposals(db, { limit: 10 });
    expect(proposals).toHaveLength(2);
    expect(proposals.map((proposal) => proposal.status).sort())
      .toEqual(["draft", "needs_human"]);
    expect(proposals.every((proposal) => proposal.proposed_changes.length === 0)).toBe(true);
    db.close();
  });
});
