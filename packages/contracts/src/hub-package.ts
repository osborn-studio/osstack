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

// Patterns mirror the Hub schema exactly.
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?$/;
const SHA256_HEX = /^[a-f0-9]{64}$/;
const RELEASE_DIGEST = /^sha256:[a-f0-9]{64}$/;
const ASSET_ID = /^[a-z0-9][a-z0-9._-]+$/;
const NAMESPACE_ID = /^[a-z0-9][a-z0-9-]+$/;

// asset + namespace are CLOSED in the released schema (additionalProperties:false)
// -> .strict(); other objects are open, matching the schema.
const HubPackageBase = z.object({
  schema_version: z.literal("1.0"),
  kind: z.literal("osbornhub.package"),
  release_id: z.string().min(3),
  asset: z.object({
    type: z.enum(["skill", "agent", "pack"]),
    id: z.string().regex(ASSET_ID),
    version: z.string().regex(SEMVER),
  }).strict(),
  namespace: z.object({
    kind: z.enum(["personal", "organization"]),
    id: z.string().regex(NAMESPACE_ID),
  }).strict(),
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
    evals: z.string().min(1),
    security_review: z.string().min(1),
    provenance: z.string().min(1),
  }),
  files: z
    .array(
      z.object({
        path: z.string().min(1),
        sha256: z.string().regex(SHA256_HEX),
        bytes: z.number().int().nonnegative(),
      }),
    )
    .min(1),
  release: z.object({
    gate: z.enum(["draft", "team", "client", "commercial", "embedded"]),
    digest: z.string().regex(RELEASE_DIGEST),
    created_at: z.string().datetime({ offset: true }),
  }),
});

// Released schema's conditional: a client-scope release MUST carry >= 1
// client_restriction (if reuse_scope === "client" then minItems: 1).
export const HubPackage = HubPackageBase.refine(
  (pkg) => pkg.rights.reuse_scope !== "client" || pkg.rights.client_restrictions.length >= 1,
  { message: "client-scope release requires at least one client_restriction", path: ["rights", "client_restrictions"] },
);

export type HubPackage = z.infer<typeof HubPackage>;

/** Parse + validate an unknown value as a Hub Package v1. Throws on any mismatch. */
export const parseHubPackage = (value: unknown): HubPackage => HubPackage.parse(value);
