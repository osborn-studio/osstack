// Internal SQL/validation helpers. Trusted host evidence only; these references
// do not authenticate a journal, physical lease, preimages or filesystem writes.
import type Database from "better-sqlite3";
import { z } from "zod";
import { GraphJsonValue } from "@osstack/protocol";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const ref = z.string().min(1).max(256).refine(v => v.trim() === v && !Array.from(v).some(c => {
  const code = c.charCodeAt(0); return code < 32 || (code >= 127 && code <= 159);
}));
const intentSchema = z.object({ schemaVersion: z.literal(1), requestDigest: digest,
  proposalDigest: digest, manifestDigest: digest, beforeTreeRevision: revision,
  targetTreeRevision: revision, journalRef: ref, journalDigest: digest }).strict();
const completionSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal("applied"),
  proposalDigest: digest, journalDigest: digest, treeRevision: revision, evidenceRef: ref, actualTokens: count.nullable() }).strict();
const quarantineSchema = z.object({ schemaVersion: z.literal(1), kind: z.literal("quarantined"),
  proposalDigest: digest, journalDigest: digest, evidenceRef: ref, observedTokens: count, cancelled: z.boolean() }).strict();
const resolutionSchema = z.discriminatedUnion("kind", [completionSchema, quarantineSchema]);
export type GraphApplyIntent = z.infer<typeof intentSchema>;
export type GraphApplyCompletion = z.infer<typeof completionSchema>;
export type GraphApplyQuarantine = z.infer<typeof quarantineSchema>;
export interface GraphApplyEvidence {
  generation: number;
  intent: GraphApplyIntent;
  resolution: GraphApplyCompletion | GraphApplyQuarantine | null;
}
export const parseApplyIntent = (value: unknown): GraphApplyIntent => intentSchema.parse(GraphJsonValue.parse(value));
export const parseApplyCompletion = (value: unknown): GraphApplyCompletion => completionSchema.parse(GraphJsonValue.parse(value));
export const parseApplyQuarantine = (value: unknown): GraphApplyQuarantine => quarantineSchema.parse(GraphJsonValue.parse(value));
export function readApply(db: Database.Database, key: string): GraphApplyEvidence | null {
  const row = db.prepare(`SELECT i.generation,i.intent_json,r.resolution_json FROM graph_apply_intents i
    LEFT JOIN graph_apply_resolutions r ON r.effect_key=i.effect_key WHERE i.effect_key=?`).get(key) as
    { generation: number; intent_json: string; resolution_json: string | null } | undefined;
  return row ? { generation: row.generation, intent: parseApplyIntent(JSON.parse(row.intent_json)),
    resolution: row.resolution_json === null ? null : resolutionSchema.parse(GraphJsonValue.parse(JSON.parse(row.resolution_json))) } : null;
}
export function hasPendingApply(db: Database.Database, runId: string): boolean {
  return !!db.prepare(`SELECT 1 FROM graph_apply_intents i JOIN graph_actions a ON a.effect_key=i.effect_key
    LEFT JOIN graph_apply_resolutions r ON r.effect_key=i.effect_key
    WHERE a.graph_run_id=? AND (r.kind IS NULL OR r.kind <> 'applied') LIMIT 1`).get(runId);
}
