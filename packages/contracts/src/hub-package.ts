import { z } from "zod";

// Consumer-side mirror of the OPEN Hub Package v1 contract as published by the
// osborn-studio-skill-hub at main (contracts/hub-package-v1.schema.json). osstack
// only VALIDATES released packages against this mirror — the Hub remains the sole
// authority for producing immutable releases. Kept faithful to the released
// schema (enums, patterns) so a third party can validate without osstack.
//
// Reconciliation note (Phase 2B): the released v1 uses full SemVer for
// asset.version (not a length floor) and identifies the artifact by a logical
// release digest — never a dist/packages path. See docs/specs for the evidence
// contract osstack persists.

// Strict SemVer, mirroring the Hub schema's asset.version pattern.
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const RELEASE_DIGEST = /^sha256:[a-f0-9]{64}$/;

export const HubPackage = z.object({
  schema_version: z.literal("1.0"),
  kind: z.literal("osbornhub.package"),
  release_id: z.string().min(3),
  asset: z.object({
    type: z.enum(["skill", "agent", "pack"]),
    id: z.string().min(2),
    version: z.string().regex(SEMVER),
  }),
  namespace: z.object({
    kind: z.enum(["personal", "organization"]),
    id: z.string().min(1),
  }),
  source: z.object({
    repository: z.string().min(1),
    commit: z.string().min(7),
    path: z.string().min(1),
  }),
  rights: z.object({
    owner: z.string().min(1),
    reuse_scope: z.enum(["personal", "team", "client", "commercial"]),
    data_classification: z.enum(["public", "internal", "confidential", "restricted"]),
    client_restrictions: z.array(z.string()),
    redaction_review: z.enum(["not_required", "passed", "failed"]),
  }),
  runtime: z.record(z.string(), z.unknown()),
  evidence: z.object({
    evals: z.string(),
    security_review: z.string(),
    provenance: z.string(),
  }),
  files: z
    .array(
      z.object({
        path: z.string(),
        sha256: z.string().regex(SHA256_HEX),
        bytes: z.number().int().nonnegative(),
      }),
    )
    .min(1),
  release: z.object({
    gate: z.enum(["draft", "team", "client", "commercial", "embedded"]),
    digest: z.string().regex(RELEASE_DIGEST),
    created_at: z.string(),
  }),
});

export type HubPackage = z.infer<typeof HubPackage>;

/** Parse + validate an unknown value as a Hub Package v1. Throws on any mismatch. */
export const parseHubPackage = (value: unknown): HubPackage => HubPackage.parse(value);
