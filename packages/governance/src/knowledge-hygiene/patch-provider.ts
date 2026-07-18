import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { KnowledgeHygieneConfigV1 } from "./config.js";
import {
  KnowledgeHygienePatchActionV1,
  KnowledgeHygienePatchPlanV1,
  type KnowledgeHygienePatchPlanV1 as KnowledgeHygienePatchPlan,
} from "./patch-types.js";
import type {
  KnowledgeHygieneFindingV1,
  KnowledgeHygieneReportV1,
} from "./types.js";

export type KnowledgeHygienePatchProviderErrorCode =
  | "report_missing_diff"
  | "instructions_unconfigured"
  | "mirror_unconfigured"
  | "unsupported_mirror_mode"
  | "target_exists"
  | "canonical_unavailable";

export class KnowledgeHygienePatchProviderError extends Error {
  readonly code: KnowledgeHygienePatchProviderErrorCode;

  constructor(code: KnowledgeHygienePatchProviderErrorCode, message: string) {
    super(message);
    this.name = "KnowledgeHygienePatchProviderError";
    this.code = code;
  }
}

export interface PlanKnowledgeHygienePatchesInputV1 {
  report: KnowledgeHygieneReportV1;
  config: KnowledgeHygieneConfigV1;
}

export type KnowledgeHygienePatchPathStateV1 = "missing" | "regular_file" | "other";

export interface KnowledgeHygienePatchProviderPortsV1 {
  now?: () => Date;
  allow_already_applied?: boolean;
  inspect_path?: (
    repoRoot: string,
    repositoryPath: string,
  ) => Promise<KnowledgeHygienePatchPathStateV1>;
  read_path?: (repoRoot: string, repositoryPath: string) => Promise<string>;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

async function inspectPath(
  repoRoot: string,
  repositoryPath: string,
): Promise<KnowledgeHygienePatchPathStateV1> {
  try {
    const metadata = await lstat(resolve(repoRoot, repositoryPath));
    return metadata.isFile() ? "regular_file" : "other";
  } catch (error) {
    if (errorCode(error) === "ENOENT") return "missing";
    throw error;
  }
}

function isInsideRoot(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot === "" || (
    !pathFromRoot.startsWith(`..${sep}`) &&
    pathFromRoot !== ".." &&
    !isAbsolute(pathFromRoot)
  );
}

async function readPath(repoRoot: string, repositoryPath: string): Promise<string> {
  const root = await realpath(resolve(repoRoot));
  const target = await realpath(resolve(root, repositoryPath));
  if (!isInsideRoot(root, target)) {
    throw new KnowledgeHygienePatchProviderError(
      "target_exists",
      `refusing existing instruction mirror outside repository: ${repositoryPath}`,
    );
  }
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function digestJson(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function digestContent(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function eligibleFindings(
  report: KnowledgeHygieneReportV1,
): KnowledgeHygieneFindingV1[] {
  return report.findings
    .filter(
      (finding) =>
        finding.rule_id === "instruction.mirror_missing" &&
        finding.remediation.mode === "safe_patch",
    )
    .sort((left, right) =>
      left.location.path.localeCompare(right.location.path) ||
      left.fingerprint.localeCompare(right.fingerprint)
    );
}

export async function planKnowledgeHygienePatches(
  input: PlanKnowledgeHygienePatchesInputV1,
  ports: KnowledgeHygienePatchProviderPortsV1 = {},
): Promise<KnowledgeHygienePatchPlan> {
  const reportDiffId = input.report.input.diff_id;
  if (reportDiffId === undefined) {
    throw new KnowledgeHygienePatchProviderError(
      "report_missing_diff",
      "knowledge hygiene report has no diff_id",
    );
  }
  const findings = eligibleFindings(input.report);
  const inspect = ports.inspect_path ?? inspectPath;
  const read = ports.read_path ?? readPath;
  const actions = [];

  for (const finding of findings) {
    const instructions = input.config.instructions;
    if (!instructions) {
      throw new KnowledgeHygienePatchProviderError(
        "instructions_unconfigured",
        "safe instruction patch requires configured instructions",
      );
    }
    const mirror = instructions.mirrors.find(
      (candidate) => candidate.path === finding.location.path,
    );
    if (!mirror) {
      throw new KnowledgeHygienePatchProviderError(
        "mirror_unconfigured",
        `finding target is not a configured instruction mirror: ${finding.location.path}`,
      );
    }
    if (mirror.mode === "symlink") {
      throw new KnowledgeHygienePatchProviderError(
        "unsupported_mirror_mode",
        `create_instruction_import does not support symlink-only mirror ${mirror.path}`,
      );
    }
    const canonicalState = await inspect(
      input.report.repo.root,
      instructions.canonical,
    );
    if (canonicalState !== "regular_file") {
      throw new KnowledgeHygienePatchProviderError(
        "canonical_unavailable",
        `canonical instruction source is not a regular file: ${instructions.canonical}`,
      );
    }

    const content = `@${instructions.canonical}\n`;
    const targetState = await inspect(input.report.repo.root, mirror.path);
    if (targetState !== "missing") {
      const alreadyApplied =
        ports.allow_already_applied === true &&
        targetState === "regular_file" &&
        await read(input.report.repo.root, mirror.path) === content;
      if (!alreadyApplied) {
        throw new KnowledgeHygienePatchProviderError(
          "target_exists",
          `refusing to replace existing instruction mirror ${mirror.path}`,
        );
      }
    }
    const afterSha = digestContent(content);
    const actionId = `kha_${digestJson([
      "1",
      "create_instruction_import",
      mirror.path,
      content,
      finding.fingerprint,
    ])}`;
    actions.push(KnowledgeHygienePatchActionV1.parse({
      schema_version: "1",
      action_id: actionId,
      kind: "create_instruction_import",
      risk: "low",
      policy_category: "docs",
      target_path: mirror.path,
      before: { exists: false, sha256: null },
      after: { content, sha256: afterSha },
      source_fingerprint: finding.fingerprint,
      source_finding: finding,
      evidence_refs: finding.evidence_refs,
    }));
  }

  return KnowledgeHygienePatchPlanV1.parse({
    schema_version: "1",
    patch_id: `khp_${digestJson([
      "1",
      reportDiffId,
      actions.map((action) => action.action_id),
    ])}`,
    generated_at: (ports.now ?? (() => new Date()))().toISOString(),
    repo: input.report.repo,
    diff_id: reportDiffId,
    actions,
  });
}
