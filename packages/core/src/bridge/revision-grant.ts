import { createHash, createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { z } from "zod";

/** Signed live revision grant (bridge phase 5-A, appendix §4.3 and §5.1). Pure: no clock, no I/O, no store.
 *
 * A grant is a *preview* (every field the human confirms, including the daemon's one-time nonce) plus the issuer's
 * Ed25519 signature over the canonical preview. The signature is the authority: a client-side TTY check cannot stop a
 * process that holds the RPC credential, but it cannot sign without the host-private issuer key. */

export const GRANT_LIMITS = {
  default_rounds: 1,
  max_rounds: 2,
  default_validity_ms: 24 * 60 * 60 * 1000,
  max_validity_ms: 7 * 24 * 60 * 60 * 1000,
  default_review_deadline_ms: 24 * 60 * 60 * 1000,
  min_review_deadline_ms: 60 * 1000,
  max_review_deadline_ms: 7 * 24 * 60 * 60 * 1000,
  default_budget: { max_executor_seconds: 3600, max_container_seconds: 3600, max_wall_clock_hours: 48 },
  max_budget: { max_executor_seconds: 86_400, max_container_seconds: 86_400, max_wall_clock_hours: 168 },
  /** The nonce is valid this long after the daemon issues the preview, and is used once. */
  nonce_ttl_ms: 60 * 1000,
  /** Mirrors the chain table's `length(grant_json)<=4096`. */
  max_json_bytes: 4096,
} as const;

export const SIGNING_DOMAIN = "osstack.revision-grant.v1";

/** Live-side stop reasons (appendix §4.4). The daemon writes them through `RevisionChainStore.stopLive`, never on shadow chains. */
export const LIVE_STOP_REASONS = [
  "grant_expired", "grant_invalid", "budget_exhausted", "protected_set_changed", "child_halted", "child_cancelled",
  "child_failed", "intent_uncertain", "dispatch_failed", "base_changed", "external_write", "head_regressed",
] as const;
export type LiveStopReason = (typeof LIVE_STOP_REASONS)[number];
/** Stop reasons from which `grant-revisions --chain` may resume the chain (appendix §5.1 "可再授的停止原因"). */
export const RENEWABLE_STOP_REASONS: ReadonlySet<string> = new Set(["rounds_exhausted", "grant_expired", "grant_invalid", "budget_exhausted"]);

export type RevisionGrantErrorCode =
  | "grant_invalid" | "grant_expired" | "budget_exhausted" | "grant_terms_invalid" | "grant_signature_invalid";
export class RevisionGrantError extends Error {
  constructor(readonly code: RevisionGrantErrorCode) { super(code); this.name = "RevisionGrantError"; }
}

const HEX64 = /^[0-9a-f]{64}$/;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: grant text must not carry control characters into the ledger.
const NO_CONTROL = /^[^\u0000-\u001f\u007f]+$/;
const text = (max: number) => z.string().min(1).max(max).regex(NO_CONTROL);

export const GrantBudgetSchema = z.object({
  max_executor_seconds: z.number().int().min(1).max(GRANT_LIMITS.max_budget.max_executor_seconds),
  max_container_seconds: z.number().int().min(1).max(GRANT_LIMITS.max_budget.max_container_seconds),
  max_wall_clock_hours: z.number().int().min(1).max(GRANT_LIMITS.max_budget.max_wall_clock_hours),
}).strict();
export type GrantBudget = z.infer<typeof GrantBudgetSchema>;

const previewFields = {
  kind: z.literal("live"),
  version: z.literal(1),
  grant_id: z.string().regex(/^rg_[0-9a-f-]{36}$/),
  rounds: z.union([z.literal(1), z.literal(2)]),
  principal_id: text(256), client_session_id: text(256), scope_id: z.string().regex(HEX64),
  root_mission_id: z.string().regex(/^cm_[0-9a-f-]{36}$/),
  repository: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).max(200),
  pr_number: z.number().int().min(1),
  branch: text(255), base_ref: text(255), base_sha: z.string().regex(SHA), head_sha: z.string().regex(SHA),
  issued_at: z.number().int().min(0), expires_at: z.number().int().min(1),
  review_deadline_ms: z.number().int().min(GRANT_LIMITS.min_review_deadline_ms).max(GRANT_LIMITS.max_review_deadline_ms),
  budget: GrantBudgetSchema,
  protected_set_digest: z.string().regex(HEX64),
  nonce: z.string().regex(/^[0-9a-f]{32}$/),
  key_id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/),
  /** Present only on a re-grant: the chain it extends and the chain revision the human saw. */
  renews: z.object({ chain_id: z.string().regex(/^rc_[0-9a-f-]{36}$/), revision: z.number().int().min(1) }).strict().optional(),
};
const windowOk = (g: { issued_at: number; expires_at: number }) => g.expires_at > g.issued_at && g.expires_at - g.issued_at <= GRANT_LIMITS.max_validity_ms;

export const RevisionGrantPreviewSchema = z.object(previewFields).strict().refine(windowOk, "grant_window");
export const RevisionGrantSchema = z.object({
  ...previewFields,
  preview_sha256: z.string().regex(HEX64),
  signature: z.string().regex(/^[A-Za-z0-9+/]{86}==$/),
}).strict().refine(windowOk, "grant_window");
export type RevisionGrantPreview = z.infer<typeof RevisionGrantPreviewSchema>;
export type RevisionGrant = z.infer<typeof RevisionGrantSchema>;

/** Deterministic JSON: object keys sorted, no undefined, finite numbers only. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new RevisionGrantError("grant_invalid");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  throw new RevisionGrantError("grant_invalid");
}

const sha256 = (value: string): string => createHash("sha256").update(value).digest("hex");

/** Parses and canonicalises a preview. Throws `grant_invalid`. */
export function parseRevisionGrantPreview(value: unknown): RevisionGrantPreview {
  const parsed = RevisionGrantPreviewSchema.safeParse(value);
  if (!parsed.success) throw new RevisionGrantError("grant_invalid");
  return parsed.data;
}
export function previewDigest(preview: RevisionGrantPreview): string {
  return sha256(canonicalJson(parseRevisionGrantPreview(preview)));
}
/** The exact bytes the issuer signs: domain, canonical preview and its digest. */
export function revisionGrantSigningInput(preview: RevisionGrantPreview): Buffer {
  const p = parseRevisionGrantPreview(preview);
  return Buffer.from(canonicalJson({ domain: SIGNING_DOMAIN, preview: p, preview_sha256: sha256(canonicalJson(p)) }));
}
export function signRevisionGrant(preview: RevisionGrantPreview, privateKey: KeyObject): RevisionGrant {
  if (privateKey.asymmetricKeyType !== "ed25519") throw new RevisionGrantError("grant_signature_invalid");
  const p = parseRevisionGrantPreview(preview);
  return assembleGrant(p, sign(null, revisionGrantSigningInput(p), privateKey).toString("base64"));
}
export function assembleGrant(preview: RevisionGrantPreview, signature: string): RevisionGrant {
  const p = parseRevisionGrantPreview(preview);
  const grant = RevisionGrantSchema.safeParse({ ...p, preview_sha256: previewDigest(p), signature });
  if (!grant.success) throw new RevisionGrantError("grant_signature_invalid");
  return grant.data;
}
/** Strips the signature fields. */
export function grantPreviewOf(grant: RevisionGrant): RevisionGrantPreview {
  const { preview_sha256: _digest, signature: _signature, ...preview } = grant;
  return parseRevisionGrantPreview(preview);
}

export function publicKeyFromSpkiB64(spkiB64: string): KeyObject {
  try {
    const key = createPublicKey({ key: Buffer.from(spkiB64, "base64"), format: "der", type: "spki" });
    if (key.asymmetricKeyType !== "ed25519") throw new RevisionGrantError("grant_signature_invalid");
    return key;
  } catch { throw new RevisionGrantError("grant_signature_invalid"); }
}
/** True only when the digest matches the preview and the signature verifies under `publicKey`. Never throws. */
export function verifyRevisionGrantSignature(grant: RevisionGrant, publicKey: KeyObject): boolean {
  try {
    const preview = grantPreviewOf(grant);
    if (previewDigest(preview) !== grant.preview_sha256) return false;
    return verify(null, revisionGrantSigningInput(preview), publicKey, Buffer.from(grant.signature, "base64"));
  } catch { return false; }
}

/** Parses the `grant_json` column of a live chain: strict shape, ≤ 4 096 bytes. The stored `kind` is `live`. Throws `grant_invalid`. */
export function parseStoredGrant(grantJson: string): RevisionGrant {
  if (Buffer.byteLength(grantJson) > GRANT_LIMITS.max_json_bytes) throw new RevisionGrantError("grant_invalid");
  let value: unknown;
  try { value = JSON.parse(grantJson); } catch { throw new RevisionGrantError("grant_invalid"); }
  const parsed = RevisionGrantSchema.safeParse(value);
  if (!parsed.success) throw new RevisionGrantError("grant_invalid");
  return parsed.data;
}

export interface GrantTerms { rounds: 1 | 2; validity_ms: number; review_deadline_ms: number; budget: GrantBudget }
/** Owner decision 2026-11-06: default 1 round, 24h validity (max 7 days), 24h review deadline, budget 3600/3600/48h. */
export function resolveGrantTerms(input: {
  rounds?: number; expires_ms?: number; review_deadline_ms?: number; budget?: Partial<GrantBudget>;
}, issuerMaxValidityMs: number): GrantTerms {
  const rounds = input.rounds ?? GRANT_LIMITS.default_rounds;
  const validity = input.expires_ms ?? Math.min(GRANT_LIMITS.default_validity_ms, issuerMaxValidityMs);
  const review = input.review_deadline_ms ?? GRANT_LIMITS.default_review_deadline_ms;
  const budget = { ...GRANT_LIMITS.default_budget, ...Object.fromEntries(Object.entries(input.budget ?? {}).filter(([, v]) => v !== undefined)) };
  if ((rounds !== 1 && rounds !== 2) || !Number.isSafeInteger(validity) || validity < 1 || validity > Math.min(GRANT_LIMITS.max_validity_ms, issuerMaxValidityMs)
    || !Number.isSafeInteger(review) || review < GRANT_LIMITS.min_review_deadline_ms || review > GRANT_LIMITS.max_review_deadline_ms
    || !GrantBudgetSchema.safeParse(budget).success) throw new RevisionGrantError("grant_terms_invalid");
  return { rounds, validity_ms: validity, review_deadline_ms: review, budget: budget as GrantBudget };
}

/** What `mission status --json` reports about a grant. No signature, digest, nonce or identity. */
export interface GrantSummary {
  grant_id: string; rounds: number; issued_at: number; expires_at: number; review_deadline_ms: number; budget: GrantBudget; key_id: string;
}
export function grantSummary(grantJson: string): GrantSummary | null {
  try {
    const g = parseStoredGrant(grantJson);
    return { grant_id: g.grant_id, rounds: g.rounds, issued_at: g.issued_at, expires_at: g.expires_at, review_deadline_ms: g.review_deadline_ms, budget: g.budget, key_id: g.key_id };
  } catch { return null; }
}

/** The chain columns a grant binds to. */
export interface GrantBinding { root_mission_id: string; repository: string; pr_number: number; branch: string; base_ref: string }
export function grantBindsChain(grant: RevisionGrant, chain: GrantBinding): boolean {
  return grant.root_mission_id === chain.root_mission_id && grant.repository === chain.repository && grant.pr_number === chain.pr_number
    && grant.branch === chain.branch && grant.base_ref === chain.base_ref;
}
