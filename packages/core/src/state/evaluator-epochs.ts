import type Database from "better-sqlite3";
import { withWrite } from "./db.js";
import { AnchorCaseRow, EvaluatorEpochRow, EvaluatorVersionRow, ScoreQuarantineRow } from "./schema.js";

// ── Evaluator versions ──────────────────────────────────────────────────────

export type EvaluatorStatus = "candidate" | "frozen" | "retired" | "rejected";

export interface NewEvaluatorVersion {
  evaluator_id: string;
  repo_id: string;
  kind: string;
  version: string;
  title: string;
  rubric: string;
  implementation_ref?: string | null;
  status?: EvaluatorStatus;
}

export interface EvaluatorVersionView {
  evaluator_id: string;
  repo_id: string;
  kind: string;
  version: string;
  title: string;
  rubric: string;
  implementation_ref: string | null;
  status: EvaluatorStatus;
  created_at: number;
  updated_at: number;
}

export function upsertEvaluatorVersion(
  db: Database.Database,
  dbPath: string,
  evaluator: NewEvaluatorVersion,
): EvaluatorVersionView {
  const now = Date.now() / 1000;
  const existing = db.prepare("SELECT * FROM evaluator_versions WHERE evaluator_id = ?").get(evaluator.evaluator_id) as unknown;
  const createdAt = existing !== undefined ? EvaluatorVersionRow.parse(existing).created_at : now;

  const row = EvaluatorVersionRow.parse({
    evaluator_id: evaluator.evaluator_id,
    repo_id: evaluator.repo_id,
    kind: evaluator.kind,
    version: evaluator.version,
    title: evaluator.title,
    rubric: evaluator.rubric,
    implementation_ref: evaluator.implementation_ref ?? null,
    status: evaluator.status ?? "candidate",
    created_at: createdAt,
    updated_at: now,
  });

  withWrite(db, dbPath, (d) => {
    d.prepare(`
      INSERT INTO evaluator_versions (
        evaluator_id, repo_id, kind, version, title, rubric,
        implementation_ref, status, created_at, updated_at
      ) VALUES (
        @evaluator_id, @repo_id, @kind, @version, @title, @rubric,
        @implementation_ref, @status, @created_at, @updated_at
      )
      ON CONFLICT(evaluator_id) DO UPDATE SET
        repo_id = excluded.repo_id,
        kind = excluded.kind,
        version = excluded.version,
        title = excluded.title,
        rubric = excluded.rubric,
        implementation_ref = excluded.implementation_ref,
        status = excluded.status,
        updated_at = excluded.updated_at
    `).run(row);
  });

  return { ...row };
}

export function listEvaluatorVersions(
  db: Database.Database,
  opts: { repo_id?: string; status?: EvaluatorStatus; limit?: number } = {},
): EvaluatorVersionView[] {
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
    SELECT * FROM evaluator_versions
    WHERE ${where.join(" AND ")}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...params) as unknown[];
  return rows.map((row) => ({ ...EvaluatorVersionRow.parse(row) }));
}

// ── Anchor cases ────────────────────────────────────────────────────────────

export interface NewAnchorCase {
  case_id: string;
  repo_id: string;
  source_trace_id?: string | null;
  input_summary: string;
  expected_verdict: "accept" | "reject" | "needs_human";
  expected_failure_family?: string | null;
  evidence_refs: string[];
  adversarial: boolean;
}

export interface AnchorCaseView {
  case_id: string;
  repo_id: string;
  source_trace_id: string | null;
  input_summary: string;
  expected_verdict: "accept" | "reject" | "needs_human";
  expected_failure_family: string | null;
  evidence_refs: string[];
  adversarial: boolean;
  created_at: number;
  updated_at: number;
}

export function upsertAnchorCase(
  db: Database.Database,
  dbPath: string,
  anchorCase: NewAnchorCase,
): AnchorCaseView {
  const now = Date.now() / 1000;
  const existing = db.prepare("SELECT * FROM anchor_cases WHERE case_id = ?").get(anchorCase.case_id) as unknown;
  const createdAt = existing !== undefined ? AnchorCaseRow.parse(existing).created_at : now;

  const row = AnchorCaseRow.parse({
    case_id: anchorCase.case_id,
    repo_id: anchorCase.repo_id,
    source_trace_id: anchorCase.source_trace_id ?? null,
    input_summary: anchorCase.input_summary,
    expected_verdict: anchorCase.expected_verdict,
    expected_failure_family: anchorCase.expected_failure_family ?? null,
    evidence_refs_json: JSON.stringify(anchorCase.evidence_refs),
    adversarial: anchorCase.adversarial ? 1 : 0,
    created_at: createdAt,
    updated_at: now,
  });

  withWrite(db, dbPath, (d) => {
    d.prepare(`
      INSERT INTO anchor_cases (
        case_id, repo_id, source_trace_id, input_summary, expected_verdict,
        expected_failure_family, evidence_refs_json, adversarial, created_at, updated_at
      ) VALUES (
        @case_id, @repo_id, @source_trace_id, @input_summary, @expected_verdict,
        @expected_failure_family, @evidence_refs_json, @adversarial, @created_at, @updated_at
      )
      ON CONFLICT(case_id) DO UPDATE SET
        repo_id = excluded.repo_id,
        source_trace_id = excluded.source_trace_id,
        input_summary = excluded.input_summary,
        expected_verdict = excluded.expected_verdict,
        expected_failure_family = excluded.expected_failure_family,
        evidence_refs_json = excluded.evidence_refs_json,
        adversarial = excluded.adversarial,
        updated_at = excluded.updated_at
    `).run(row);
  });

  return parseAnchorCase(row);
}

export function listAnchorCases(
  db: Database.Database,
  opts: { repo_id?: string; adversarial?: boolean; limit?: number } = {},
): AnchorCaseView[] {
  const where: string[] = ["1 = 1"];
  const params: unknown[] = [];
  if (opts.repo_id !== undefined) {
    where.push("repo_id = ?");
    params.push(opts.repo_id);
  }
  if (opts.adversarial !== undefined) {
    where.push("adversarial = ?");
    params.push(opts.adversarial ? 1 : 0);
  }
  params.push(opts.limit ?? 100);
  const rows = db.prepare(`
    SELECT * FROM anchor_cases
    WHERE ${where.join(" AND ")}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...params) as unknown[];
  return rows.map(parseAnchorCase);
}

function parseAnchorCase(row: unknown): AnchorCaseView {
  const parsed = AnchorCaseRow.parse(row);
  return {
    case_id: parsed.case_id,
    repo_id: parsed.repo_id,
    source_trace_id: parsed.source_trace_id,
    input_summary: parsed.input_summary,
    expected_verdict: parsed.expected_verdict,
    expected_failure_family: parsed.expected_failure_family,
    evidence_refs: parseStringArray(parsed.evidence_refs_json),
    adversarial: parsed.adversarial !== 0,
    created_at: parsed.created_at,
    updated_at: parsed.updated_at,
  };
}

// ── Evaluator epochs ────────────────────────────────────────────────────────

export interface PromotionDecision {
  promoted_evaluator_id?: string;
  reason: string;
  anchor_accuracy_delta: number;
  promoted: boolean;
}

export interface NewEvaluatorEpoch {
  epoch_id: string;
  repo_id: string;
  frozen_evaluator_id: string;
  anchor_case_ids?: string[];
  challenger_evaluator_ids?: string[];
}

export interface EvaluatorEpochView {
  epoch_id: string;
  repo_id: string;
  frozen_evaluator_id: string;
  started_at: number;
  ended_at: number | null;
  anchor_case_ids: string[];
  challenger_evaluator_ids: string[];
  promotion_decision: PromotionDecision | null;
}

export function createEvaluatorEpoch(
  db: Database.Database,
  dbPath: string,
  epoch: NewEvaluatorEpoch,
): EvaluatorEpochView {
  const now = Date.now() / 1000;
  const row = EvaluatorEpochRow.parse({
    epoch_id: epoch.epoch_id,
    repo_id: epoch.repo_id,
    frozen_evaluator_id: epoch.frozen_evaluator_id,
    started_at: now,
    ended_at: null,
    anchor_case_ids_json: JSON.stringify(epoch.anchor_case_ids ?? []),
    challenger_evaluator_ids_json: JSON.stringify(epoch.challenger_evaluator_ids ?? []),
    promotion_decision_json: null,
  });

  withWrite(db, dbPath, (d) => {
    d.prepare(`
      INSERT INTO evaluator_epochs (
        epoch_id, repo_id, frozen_evaluator_id, started_at, ended_at,
        anchor_case_ids_json, challenger_evaluator_ids_json, promotion_decision_json
      ) VALUES (
        @epoch_id, @repo_id, @frozen_evaluator_id, @started_at, @ended_at,
        @anchor_case_ids_json, @challenger_evaluator_ids_json, @promotion_decision_json
      )
    `).run(row);
  });

  return parseEvaluatorEpoch(row);
}

export function closeEvaluatorEpoch(
  db: Database.Database,
  dbPath: string,
  epochId: string,
  promotionDecision: PromotionDecision,
): EvaluatorEpochView | null {
  const now = Date.now() / 1000;
  withWrite(db, dbPath, (d) => {
    d.prepare(`
      UPDATE evaluator_epochs
      SET ended_at = ?, promotion_decision_json = ?
      WHERE epoch_id = ?
    `).run(now, JSON.stringify(promotionDecision), epochId);
  });
  const row = db.prepare("SELECT * FROM evaluator_epochs WHERE epoch_id = ?").get(epochId) as unknown;
  return row === undefined ? null : parseEvaluatorEpoch(row);
}

function parseEvaluatorEpoch(row: unknown): EvaluatorEpochView {
  const parsed = EvaluatorEpochRow.parse(row);
  return {
    epoch_id: parsed.epoch_id,
    repo_id: parsed.repo_id,
    frozen_evaluator_id: parsed.frozen_evaluator_id,
    started_at: parsed.started_at,
    ended_at: parsed.ended_at,
    anchor_case_ids: parseStringArray(parsed.anchor_case_ids_json),
    challenger_evaluator_ids: parseStringArray(parsed.challenger_evaluator_ids_json),
    promotion_decision: parsePromotionDecision(parsed.promotion_decision_json),
  };
}

function parsePromotionDecision(raw: string | null): PromotionDecision | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed === null || typeof parsed !== "object") return null;
    const candidate = parsed as Record<string, unknown>;
    if (typeof candidate["reason"] !== "string"
      || typeof candidate["anchor_accuracy_delta"] !== "number"
      || typeof candidate["promoted"] !== "boolean") {
      return null;
    }
    return {
      reason: candidate["reason"],
      anchor_accuracy_delta: candidate["anchor_accuracy_delta"],
      promoted: candidate["promoted"],
      ...(typeof candidate["promoted_evaluator_id"] === "string"
        ? { promoted_evaluator_id: candidate["promoted_evaluator_id"] }
        : {}),
    };
  } catch {
    return null;
  }
}

// ── Score quarantine ────────────────────────────────────────────────────────

export interface NewScoreQuarantine {
  quarantine_id: string;
  repo_id: string;
  score_id: string;
  evaluator_id: string;
  reason: string;
}

export interface ScoreQuarantineView {
  quarantine_id: string;
  repo_id: string;
  score_id: string;
  evaluator_id: string;
  reason: string;
  created_at: number;
}

export function insertScoreQuarantine(
  db: Database.Database,
  dbPath: string,
  record: NewScoreQuarantine,
): ScoreQuarantineView {
  const now = Date.now() / 1000;
  const row = ScoreQuarantineRow.parse({ ...record, created_at: now });
  withWrite(db, dbPath, (d) => {
    d.prepare(`
      INSERT INTO score_quarantine (
        quarantine_id, repo_id, score_id, evaluator_id, reason, created_at
      ) VALUES (
        @quarantine_id, @repo_id, @score_id, @evaluator_id, @reason, @created_at
      )
      ON CONFLICT(quarantine_id) DO UPDATE SET
        reason = excluded.reason
    `).run(row);
  });
  return { ...row };
}

export function listScoreQuarantine(
  db: Database.Database,
  opts: { repo_id?: string; evaluator_id?: string; limit?: number } = {},
): ScoreQuarantineView[] {
  const where: string[] = ["1 = 1"];
  const params: unknown[] = [];
  if (opts.repo_id !== undefined) {
    where.push("repo_id = ?");
    params.push(opts.repo_id);
  }
  if (opts.evaluator_id !== undefined) {
    where.push("evaluator_id = ?");
    params.push(opts.evaluator_id);
  }
  params.push(opts.limit ?? 100);
  const rows = db.prepare(`
    SELECT * FROM score_quarantine
    WHERE ${where.join(" AND ")}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...params) as unknown[];
  return rows.map((row) => ({ ...ScoreQuarantineRow.parse(row) }));
}

function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
