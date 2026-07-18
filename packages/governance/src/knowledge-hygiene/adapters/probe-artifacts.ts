import type { Dirent } from "node:fs";
import {
  readFile,
  readdir,
  realpath,
  stat,
} from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createKnowledgeHygieneFingerprint } from "../fingerprint.js";
import {
  KnowledgeHygieneFindingV1,
  type KnowledgeHygieneFindingV1 as KnowledgeHygieneFinding,
  type KnowledgeHygieneRuleIdV1,
} from "../types.js";
import {
  ProbeRenderManifestV1,
} from "../../probe/types.js";
import {
  probeSha256,
  verifyProbeRenderArtifacts,
} from "../../probe/render.js";

const dayMs = 86_400_000;

export interface InspectProbeKnowledgeHygieneInputV1 {
  repo_root: string;
  now_ms: number;
  max_deferred_age_days?: number;
  max_waiver_age_days?: number;
}

export interface ProbeKnowledgeHygieneInspectionV1 {
  artifact_count: number;
  findings: KnowledgeHygieneFinding[];
}

function isNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error &&
    (error as { code?: unknown }).code === "ENOENT";
}

function isInside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (
    path !== ".." &&
    !path.startsWith(`..${sep}`) &&
    !isAbsolute(path)
  );
}

function portable(repoRoot: string, path: string): string {
  return relative(repoRoot, path).split(sep).join("/");
}

function finding(input: {
  rule_id: Extract<KnowledgeHygieneRuleIdV1, `probe.${string}`>;
  repo_id: string;
  path: string;
  anchor: string;
  severity: "error" | "warning";
  observed: Record<string, unknown>;
  expected: Record<string, unknown>;
  rationale: string;
  evidence_ref: string;
  evidence_sha256?: string;
}): KnowledgeHygieneFinding {
  const location = { path: input.path, anchor: input.anchor };
  return KnowledgeHygieneFindingV1.parse({
    fingerprint: createKnowledgeHygieneFingerprint({
      schema_version: "1",
      rule_id: input.rule_id,
      rule_version: "1",
      repo_identity: input.repo_id,
      location,
    }),
    rule_id: input.rule_id,
    rule_version: "1",
    surface: "documentation",
    severity: input.severity,
    confidence: "high",
    location,
    observed: input.observed,
    expected: input.expected,
    rationale: input.rationale,
    evidence_refs: [{
      kind: "proof",
      ref: input.evidence_ref,
      ...(input.evidence_sha256 === undefined
        ? {}
        : { sha256: input.evidence_sha256 }),
    }],
    remediation: { mode: "human_decision" },
  });
}

async function readArtifactFiles(
  artifactDir: string,
  rawManifest: unknown,
): Promise<ReadonlyMap<string, Uint8Array>> {
  const manifest = ProbeRenderManifestV1.parse(rawManifest);
  const files = new Map<string, Uint8Array>();
  for (const expected of manifest.files) {
    const candidate = await realpath(resolve(artifactDir, expected.path));
    if (!isInside(artifactDir, candidate) || !(await stat(candidate)).isFile()) {
      throw new Error(`artifact path escapes its manifest directory: ${expected.path}`);
    }
    files.set(expected.path, await readFile(candidate));
  }
  return files;
}

async function destinationExists(repoRoot: string, path: string): Promise<boolean> {
  try {
    const candidate = await realpath(resolve(repoRoot, path));
    return isInside(repoRoot, candidate) && (await stat(candidate)).isFile();
  } catch (error) {
    if (isNotFound(error)) return false;
    throw error;
  }
}

export async function inspectProbeKnowledgeHygiene(
  input: InspectProbeKnowledgeHygieneInputV1,
): Promise<ProbeKnowledgeHygieneInspectionV1> {
  const repoRoot = await realpath(input.repo_root);
  const artifactsRoot = resolve(repoRoot, "docs/probe/sessions");
  let entries: Dirent[];
  try {
    entries = await readdir(artifactsRoot, { withFileTypes: true });
  } catch (error) {
    if (isNotFound(error)) return { artifact_count: 0, findings: [] };
    throw error;
  }
  const findings: KnowledgeHygieneFinding[] = [];
  let artifactCount = 0;
  const deferredAge = (input.max_deferred_age_days ?? 14) * dayMs;
  const waiverAge = (input.max_waiver_age_days ?? 30) * dayMs;

  for (const entry of entries.filter((candidate) => candidate.isDirectory())
    .sort((left, right) => left.name.localeCompare(right.name))) {
    const artifactDir = await realpath(resolve(artifactsRoot, entry.name));
    if (!isInside(artifactsRoot, artifactDir)) continue;
    const manifestPath = resolve(artifactDir, "render-manifest.json");
    let manifestContent: Buffer;
    try {
      manifestContent = await readFile(manifestPath);
    } catch (error) {
      if (isNotFound(error)) continue;
      throw error;
    }
    artifactCount += 1;
    const manifestPortable = portable(repoRoot, manifestPath);
    let verified: ReturnType<typeof verifyProbeRenderArtifacts>;
    try {
      const rawManifest = JSON.parse(manifestContent.toString("utf8")) as unknown;
      verified = verifyProbeRenderArtifacts(
        rawManifest,
        await readArtifactFiles(artifactDir, rawManifest),
      );
    } catch (error) {
      findings.push(finding({
        rule_id: "probe.artifact_integrity",
        repo_id: entry.name,
        path: manifestPortable,
        anchor: "manifest-ledger-binding",
        severity: "error",
        observed: { valid: false, error: error instanceof Error ? error.message : String(error) },
        expected: { valid: true },
        rationale: "The portable probe ledger set failed its manifest or ledger hash binding.",
        evidence_ref: manifestPortable,
        evidence_sha256: probeSha256(manifestContent),
      }));
      continue;
    }
    const ledger = verified.ledger;
    const ledgerPath = portable(repoRoot, resolve(artifactDir, "ledger.json"));
    const ledgerSha = verified.manifest.files.find((file) => file.path === "ledger.json")?.sha256;
    for (const item of ledger.items) {
      if (
        item.state === "resolved" &&
        item.destination.role !== "session_profile" &&
        !(await destinationExists(repoRoot, item.destination.path))
      ) {
        findings.push(finding({
          rule_id: "probe.destination_missing",
          repo_id: ledger.session.repo_id,
          path: ledgerPath,
          anchor: item.item_id,
          severity: "warning",
          observed: { destination: item.destination.path, exists: false },
          expected: { exists: true },
          rationale: "A resolved probe decision points to a destination that no longer exists.",
          evidence_ref: ledgerPath,
          ...(ledgerSha === undefined ? {} : { evidence_sha256: ledgerSha }),
        }));
      }
      if (item.state === "deferred") {
        const stale =
          (item.deferral.review_after_ms !== undefined &&
            item.deferral.review_after_ms <= input.now_ms) ||
          input.now_ms - item.deferral.deferred_at_ms >= deferredAge;
        if (stale) {
          findings.push(finding({
            rule_id: "probe.deferred_stale",
            repo_id: ledger.session.repo_id,
            path: ledgerPath,
            anchor: item.item_id,
            severity: "warning",
            observed: { deferred_at_ms: item.deferral.deferred_at_ms, review_after_ms: item.deferral.review_after_ms ?? null },
            expected: { review_due: false, max_age_days: input.max_deferred_age_days ?? 14 },
            rationale: "A deferred probe question is due for review.",
            evidence_ref: ledgerPath,
            ...(ledgerSha === undefined ? {} : { evidence_sha256: ledgerSha }),
          }));
        }
      }
      if (item.state === "waived") {
        const expired =
          (item.waiver.expires_at_ms !== undefined &&
            item.waiver.expires_at_ms <= input.now_ms) ||
          input.now_ms - item.waiver.approved_at_ms >= waiverAge;
        if (expired) {
          findings.push(finding({
            rule_id: "probe.waiver_expired",
            repo_id: ledger.session.repo_id,
            path: ledgerPath,
            anchor: item.item_id,
            severity: "error",
            observed: { approved_at_ms: item.waiver.approved_at_ms, expires_at_ms: item.waiver.expires_at_ms ?? null },
            expected: { expired: false, max_age_days: input.max_waiver_age_days ?? 30 },
            rationale: "A probe waiver has expired and requires an owner decision.",
            evidence_ref: ledgerPath,
            ...(ledgerSha === undefined ? {} : { evidence_sha256: ledgerSha }),
          }));
        }
      }
    }
  }
  return { artifact_count: artifactCount, findings };
}
