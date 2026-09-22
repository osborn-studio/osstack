// Internal SQL helpers: callers must own the action store's fenced transaction.
// These records bind evidence; they grant neither dispatch nor filesystem access.
import type Database from "better-sqlite3";
import { z } from "zod";
import { GraphJsonValue } from "@osstack/protocol";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const revision = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const ref = z.string().min(1).max(256).refine(v => v.trim() === v && !Array.from(v).some(c => {
  const code = c.charCodeAt(0); return code < 32 || (code >= 127 && code <= 159);
}));
const requestSchema = z.object({
  schemaVersion: z.literal(1), profile: z.literal("bounded-changeset-v1"),
  runId: ref, effectKey: digest, generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  baseRevision: revision, treeRevision: revision, programDigest: digest,
  profileDigest: digest, grantDigest: digest, policyDigest: digest, manifestDigest: digest,
  requestDigest: digest, inputArtifactRef: ref, workspaceLeaseRef: ref, provider: ref, model: ref,
}).strict();
const responseSchema = z.object({
  schemaVersion: z.literal(1), requestDigest: digest, responseDigest: digest,
  disposition: z.enum(["proposal", "cannot_complete", "rejected"]), proposalDigest: digest.nullable(),
  evidenceRef: ref, stopEvidenceRef: ref,
}).strict().refine(v => (v.disposition === "proposal") === (v.proposalDigest !== null), "proposal digest/disposition mismatch");
export type GraphInvocationRequest = z.infer<typeof requestSchema>;
export type GraphInvocationResponse = z.infer<typeof responseSchema>;
export interface GraphInvocationEvidence {
  request: GraphInvocationRequest;
  response: GraphInvocationResponse | null;
}
export const parseInvocationRequest = (value: unknown): GraphInvocationRequest => requestSchema.parse(GraphJsonValue.parse(value));
export const parseInvocationResponse = (value: unknown): GraphInvocationResponse => responseSchema.parse(GraphJsonValue.parse(value));
export function readInvocation(db: Database.Database, key: string): GraphInvocationEvidence | null {
  const row = db.prepare(`SELECT q.request_json, r.response_json FROM graph_invocation_requests q
    LEFT JOIN graph_invocation_responses r ON r.effect_key=q.effect_key WHERE q.effect_key=?`).get(key) as
    { request_json: string; response_json: string | null } | undefined;
  return row ? { request: parseInvocationRequest(JSON.parse(row.request_json)),
    response: row.response_json === null ? null : parseInvocationResponse(JSON.parse(row.response_json)) } : null;
}
