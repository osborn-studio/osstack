// EvidenceRef — a reference to evidence a service produced/verified.
//
// Extraction (architecture §1 / Doc 15 §5.4): { kind, ref, sha256?, run_id? }.
// A service MUST attach evidence for anything it claims to have verified
// (AGENT_COMMAND_PROTOCOL_V1 A-003). `ref` is a path or URL; consumers treat
// markdown/prose only as human display, never as an API (ADR-001 D3).

import { z } from "zod";

export const EvidenceKind = z.enum([
  "report",
  "scorecard",
  "proof",
  "loop_state",
  "external",
]);
export type EvidenceKind = z.infer<typeof EvidenceKind>;

const evidenceRefShape = {
  kind: EvidenceKind,
  /** Path or URL to the evidence artifact. */
  ref: z.string().min(1),
  /** Lowercase hex SHA-256 of the artifact, when content-addressed. */
  sha256: z
    .string()
    .regex(/^[a-f0-9]{64}$/, { message: "sha256 must be 64 lowercase hex chars" })
    .optional(),
  run_id: z.string().min(1).optional(),
} as const;

export const EvidenceRef = z.object(evidenceRefShape).strict();
export type EvidenceRef = z.infer<typeof EvidenceRef>;

/**
 * Consumer-lenient EvidenceRef (A-007 deep leniency): the lenient envelope
 * parsers must tolerate unknown fields inside nested objects too, so a v1.1
 * addition to an evidence item does not break a v1.0 consumer. Producers keep
 * using the strict `EvidenceRef`.
 */
export const EvidenceRefLenient = z.object(evidenceRefShape).passthrough();
