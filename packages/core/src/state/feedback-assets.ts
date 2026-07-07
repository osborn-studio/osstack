import type Database from "better-sqlite3";
import { withWrite } from "./db.js";
import { FeedbackAssetRow } from "./schema.js";

export type FeedbackAssetStatus = "proposed" | "accepted" | "rejected" | "superseded";

export interface NewFeedbackAsset {
  asset_id: string;
  repo_id: string;
  source_trace_id: string;
  kind: string;
  failure_family: string;
  summary: string;
  evidence: string[];
  suggested_storage_path?: string | null;
  status?: FeedbackAssetStatus;
}

export interface FeedbackAssetView {
  asset_id: string;
  repo_id: string;
  source_trace_id: string;
  kind: string;
  failure_family: string;
  summary: string;
  evidence: string[];
  suggested_storage_path: string | null;
  status: FeedbackAssetStatus;
  created_at: number;
  updated_at: number;
}

/** Insert or update a feedback asset by asset_id; created_at is preserved on update. */
export function upsertFeedbackAsset(
  db: Database.Database,
  dbPath: string,
  asset: NewFeedbackAsset,
): FeedbackAssetView {
  const now = Date.now() / 1000;
  const existing = db.prepare("SELECT * FROM feedback_assets WHERE asset_id = ?").get(asset.asset_id) as unknown;
  const createdAt = existing !== undefined ? FeedbackAssetRow.parse(existing).created_at : now;

  const row = FeedbackAssetRow.parse({
    asset_id: asset.asset_id,
    repo_id: asset.repo_id,
    source_trace_id: asset.source_trace_id,
    kind: asset.kind,
    failure_family: asset.failure_family,
    summary: asset.summary,
    evidence_json: JSON.stringify(asset.evidence),
    suggested_storage_path: asset.suggested_storage_path ?? null,
    status: asset.status ?? "proposed",
    created_at: createdAt,
    updated_at: now,
  });

  withWrite(db, dbPath, (d) => {
    d.prepare(`
      INSERT INTO feedback_assets (
        asset_id, repo_id, source_trace_id, kind, failure_family, summary,
        evidence_json, suggested_storage_path, status, created_at, updated_at
      ) VALUES (
        @asset_id, @repo_id, @source_trace_id, @kind, @failure_family, @summary,
        @evidence_json, @suggested_storage_path, @status, @created_at, @updated_at
      )
      ON CONFLICT(asset_id) DO UPDATE SET
        repo_id = excluded.repo_id,
        source_trace_id = excluded.source_trace_id,
        kind = excluded.kind,
        failure_family = excluded.failure_family,
        summary = excluded.summary,
        evidence_json = excluded.evidence_json,
        suggested_storage_path = excluded.suggested_storage_path,
        status = excluded.status,
        updated_at = excluded.updated_at
    `).run(row);
  });

  return parseFeedbackAsset(row);
}

export function listFeedbackAssets(
  db: Database.Database,
  opts: { repo_id?: string; status?: FeedbackAssetStatus; limit?: number } = {},
): FeedbackAssetView[] {
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
    SELECT * FROM feedback_assets
    WHERE ${where.join(" AND ")}
    ORDER BY created_at DESC
    LIMIT ?
  `).all(...params) as unknown[];
  return rows.map(parseFeedbackAsset);
}

function parseFeedbackAsset(row: unknown): FeedbackAssetView {
  const parsed = FeedbackAssetRow.parse(row);
  return {
    asset_id: parsed.asset_id,
    repo_id: parsed.repo_id,
    source_trace_id: parsed.source_trace_id,
    kind: parsed.kind,
    failure_family: parsed.failure_family,
    summary: parsed.summary,
    evidence: parseStringArray(parsed.evidence_json),
    suggested_storage_path: parsed.suggested_storage_path,
    status: parsed.status,
    created_at: parsed.created_at,
    updated_at: parsed.updated_at,
  };
}

function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}
