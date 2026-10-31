import {
  decodeMissionPatch,
  type MissionPatchFile,
  type MissionPatchFileKind,
  type MissionPatchRejection,
  type MissionPatchRejectionCode,
  parseMissionPatch,
} from "./diff-parser.js";
import { compileMissionGlob, missionPathRejection } from "./path-rules.js";
import { matchMissionProtectedPath, missionProtectedSetDigest } from "./protected-set.js";
import { type MissionOutputChannel, scanForSecrets } from "./secret-scan.js";

export interface MissionPatchCaps {
  maxFiles: number;
  /** Added plus removed lines across the cumulative diff. */
  maxChangedLines: number;
  /** UTF-8 bytes of one file's added lines. */
  maxFileBytes: number;
  /** UTF-8 bytes of all added lines. */
  maxTotalBytes: number;
}

export const DEFAULT_MISSION_PATCH_CAPS: Readonly<MissionPatchCaps> = Object.freeze({
  maxFiles: 10,
  maxChangedLines: 400,
  maxFileBytes: 1_000_000,
  maxTotalBytes: 5_000_000,
});

export interface MissionPatchSpec {
  allowedPaths: readonly string[];
  /** May only tighten {@link DEFAULT_MISSION_PATCH_CAPS}. */
  caps?: Partial<MissionPatchCaps>;
}

export type MissionPatchSpecErrorCode = "ALLOWED_PATH_INVALID" | "CAPS_INVALID" | "CAPS_LOOSENED";

export class MissionPatchSpecError extends Error {
  constructor(readonly code: MissionPatchSpecErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = "MissionPatchSpecError";
  }
}

export type MissionPatchEscalationCode =
  | "DELETE_TRACKED"
  | "OUTSIDE_ALLOWED"
  | "PACKAGE_MANIFEST_CHANGED"
  | "PROTECTED_PATH"
  | "SECRET_DETECTED";

export type MissionPatchCapCode =
  | "CAP_CHANGED_LINES_EXCEEDED"
  | "CAP_FILES_EXCEEDED"
  | "CAP_FILE_BYTES_EXCEEDED"
  | "CAP_TOTAL_BYTES_EXCEEDED";

export type MissionPatchReasonCode = MissionPatchRejectionCode | MissionPatchEscalationCode | MissionPatchCapCode;

export interface MissionPatchFinding {
  code: MissionPatchReasonCode;
  path?: string;
  /** 1-based line in the new file, for a secret on an added line. */
  line?: number;
  /** 1-based line of the patch or output text. */
  patchLine?: number;
  /** Protected-set rule ids or the secret rule. */
  rules?: string[];
  /** Output channel of a secret hit. */
  channel?: MissionOutputChannel;
}

/** Other executor outputs from the same turn; a secret in any of them is T2. */
export type MissionPatchOutputs = Partial<Record<Exclude<MissionOutputChannel, "patch">, string>>;

export interface MissionPatchFileSummary {
  path: string;
  kind: MissionPatchFileKind;
  added: number;
  removed: number;
  addedBytes: number;
}

export interface MissionPatchTotals {
  files: number;
  changedLines: number;
  addedBytes: number;
}

interface ClassificationBase {
  reasons: MissionPatchReasonCode[];
  findings: MissionPatchFinding[];
  caps: MissionPatchCaps;
  protectedSetDigest: string;
}

export type MissionPatchClassification =
  | (ClassificationBase & { tier: "rejected" })
  | (ClassificationBase & {
    tier: "T0" | "T1" | "T2";
    files: MissionPatchFileSummary[];
    totals: MissionPatchTotals;
  });

/** Validates a spec's caps against the defaults; throws {@link MissionPatchSpecError}. */
export function resolveMissionPatchCaps(caps: Partial<MissionPatchCaps> = {}): MissionPatchCaps {
  const resolved = { ...DEFAULT_MISSION_PATCH_CAPS };
  for (const key of Object.keys(DEFAULT_MISSION_PATCH_CAPS) as (keyof MissionPatchCaps)[]) {
    const value = caps[key];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new MissionPatchSpecError("CAPS_INVALID", `${key} must be a non-negative integer`);
    }
    if (value > DEFAULT_MISSION_PATCH_CAPS[key]) {
      throw new MissionPatchSpecError("CAPS_LOOSENED", `${key} ${value} exceeds ${DEFAULT_MISSION_PATCH_CAPS[key]}`);
    }
    resolved[key] = value;
  }
  for (const key of Object.keys(caps)) {
    if (!(key in DEFAULT_MISSION_PATCH_CAPS)) throw new MissionPatchSpecError("CAPS_INVALID", `unknown cap ${key}`);
  }
  return resolved;
}

/**
 * Classifies a proposed Mission patch into rejected / T2 / T1 / T0 (§6.3).
 * `patch` must be the cumulative diff from the Mission start commit, so caps cannot be reset per step.
 */
export function classifyMissionPatch(
  spec: MissionPatchSpec,
  patch: string | Uint8Array,
  outputs: MissionPatchOutputs = {},
): MissionPatchClassification {
  const caps = resolveMissionPatchCaps(spec.caps);
  const allowed = compileAllowedPaths(spec.allowedPaths);
  const protectedSetDigest = missionProtectedSetDigest();
  const parsed = parseMissionPatch(patch);
  if (!parsed.ok) {
    const findings = sortFindings([...parsed.rejections.map(rejectionFinding), ...secretFindings(patch, [], outputs)]);
    return { tier: "rejected", reasons: reasonCodes(findings), findings, caps, protectedSetDigest };
  }

  const findings: MissionPatchFinding[] = [];
  let changedLines = 0;
  let addedBytes = 0;
  for (const file of parsed.files) {
    const protectedRules = matchMissionProtectedPath(file.path);
    if (protectedRules.length > 0) findings.push({ code: "PROTECTED_PATH", path: file.path, rules: protectedRules });
    if (file.kind === "delete") findings.push({ code: "DELETE_TRACKED", path: file.path });
    if (!allowed.some((pattern) => pattern.test(file.path))) findings.push({ code: "OUTSIDE_ALLOWED", path: file.path });
    if (/(?:^|\/)package\.json$/i.test(file.path)) findings.push({ code: "PACKAGE_MANIFEST_CHANGED", path: file.path });
    if (file.addedBytes > caps.maxFileBytes) findings.push({ code: "CAP_FILE_BYTES_EXCEEDED", path: file.path });
    changedLines += file.added + file.removed;
    addedBytes += file.addedBytes;
  }
  findings.push(...secretFindings(patch, parsed.files, outputs));
  if (parsed.files.length > caps.maxFiles) findings.push({ code: "CAP_FILES_EXCEEDED" });
  if (changedLines > caps.maxChangedLines) findings.push({ code: "CAP_CHANGED_LINES_EXCEEDED" });
  if (addedBytes > caps.maxTotalBytes) findings.push({ code: "CAP_TOTAL_BYTES_EXCEEDED" });

  const sorted = sortFindings(findings);
  const reasons = reasonCodes(sorted);
  const tier = reasons.some((code) => !code.startsWith("CAP_")) ? "T2" : reasons.length > 0 ? "T1" : "T0";
  return {
    tier,
    reasons,
    findings: sorted,
    caps,
    protectedSetDigest,
    files: parsed.files
      .map(({ path, kind, added, removed, addedBytes: bytes }) => ({ path, kind, added, removed, addedBytes: bytes }))
      .sort((left, right) => compare(left.path, right.path)),
    totals: { files: parsed.files.length, changedLines, addedBytes },
  };
}

function compileAllowedPaths(globs: readonly string[]): RegExp[] {
  return globs.map((glob) => {
    if (typeof glob !== "string" || glob === "" || missionPathRejection(glob.replaceAll("**", "x")) !== undefined) {
      throw new MissionPatchSpecError("ALLOWED_PATH_INVALID", JSON.stringify(glob));
    }
    return compileMissionGlob(glob);
  });
}

// The whole patch is scanned, context and removed lines included: all of it is executor output.
function secretFindings(
  patch: string | Uint8Array,
  files: readonly MissionPatchFile[],
  outputs: MissionPatchOutputs,
): MissionPatchFinding[] {
  const findings: MissionPatchFinding[] = [];
  const text = decodeMissionPatch(patch);
  if (typeof text === "string") {
    const addedByPatchLine = new Map(files.flatMap((file) => file.addedLines.map((added) => [added.patchLine, added.line] as const)));
    for (const match of scanForSecrets(text, { channel: "patch" })) {
      const file = [...files].reverse().find((candidate) => candidate.patchLine <= match.line);
      const line = addedByPatchLine.get(match.line);
      findings.push({
        code: "SECRET_DETECTED",
        channel: "patch",
        ...(file === undefined ? {} : { path: file.path }),
        ...(line === undefined ? {} : { line }),
        patchLine: match.line,
        rules: [match.rule],
      });
    }
  }
  for (const channel of ["final_message", "stdout", "stderr"] as const) {
    const output = outputs[channel];
    if (output === undefined) continue;
    for (const match of scanForSecrets(output, { channel })) {
      findings.push({ code: "SECRET_DETECTED", channel, patchLine: match.line, rules: [match.rule] });
    }
  }
  return findings;
}

function rejectionFinding(rejection: MissionPatchRejection): MissionPatchFinding {
  return {
    code: rejection.code,
    ...(rejection.path === undefined ? {} : { path: rejection.path }),
    ...(rejection.patchLine === undefined ? {} : { patchLine: rejection.patchLine }),
  };
}

function reasonCodes(findings: readonly MissionPatchFinding[]): MissionPatchReasonCode[] {
  return [...new Set(findings.map((finding) => finding.code))].sort(compare);
}

function sortFindings(findings: readonly MissionPatchFinding[]): MissionPatchFinding[] {
  return [...findings].sort((left, right) =>
    compare(left.code, right.code)
    || compare(left.channel ?? "", right.channel ?? "")
    || compare(left.path ?? "", right.path ?? "")
    || (left.patchLine ?? 0) - (right.patchLine ?? 0)
    || (left.line ?? 0) - (right.line ?? 0)
    || compare((left.rules ?? []).join(","), (right.rules ?? []).join(",")));
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
