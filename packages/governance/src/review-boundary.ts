import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { scanText } from "./scanner.js";

export type ReviewBoundaryFileKind = "text" | "binary" | "unread";

export interface ReviewBoundaryFile {
  path: string;
  resolved_path: string;
  size_bytes: number;
  kind: ReviewBoundaryFileKind;
  content?: string;
  is_symlink: boolean;
}

export interface ReviewBoundaryInput {
  workspace_path: string;
  changed_paths: string[];
  files: ReviewBoundaryFile[];
  diff_bytes: number;
  diff_content?: string;
  forbidden_paths: string[];
  max_file_bytes: number;
  max_total_bytes: number;
  allowed_extensions: string[];
}

export interface ReviewBoundaryFinding {
  rule_id:
    | "review.secret_detected"
    | "review.forbidden_path"
    | "review.symlink_escape"
    | "review.file_too_large"
    | "review.diff_too_large"
    | "review.binary_disallowed"
    | "review.path_outside_workspace";
  severity: "error";
  path?: string;
  message: string;
}

export interface ReviewBoundaryResult {
  pass: boolean;
  findings: ReviewBoundaryFinding[];
  changed_paths: string[];
  total_bytes: number;
}

export function evaluateReviewBoundary(
  input: ReviewBoundaryInput,
): ReviewBoundaryResult {
  const workspace = resolve(input.workspace_path);
  const changedPaths = [...new Set(input.changed_paths)].sort();
  const findings: ReviewBoundaryFinding[] = [];
  const allowedExtensions = new Set(
    input.allowed_extensions.map((extension) => extension.toLowerCase()),
  );
  const forbiddenPaths = input.forbidden_paths.map(normalizeRepositoryPath);

  if (input.diff_bytes > input.max_total_bytes) {
    findings.push({
      rule_id: "review.diff_too_large",
      severity: "error",
      message: `Review diff is ${input.diff_bytes} bytes; limit is ${input.max_total_bytes}.`,
    });
  }
  if (input.diff_content !== undefined) {
    const diffSecrets = scanText(input.diff_content)
      .findings
      .filter((finding) => finding.category === "secret");
    if (diffSecrets.length > 0) {
      findings.push({
        rule_id: "review.secret_detected",
        severity: "error",
        message: `Review diff contains ${diffSecrets.length} possible secret finding(s).`,
      });
    }
  }

  for (const changedPath of changedPaths) {
    const normalized = normalizeRepositoryPath(changedPath);
    if (!isRepositoryRelative(normalized)) {
      findings.push({
        rule_id: "review.path_outside_workspace",
        severity: "error",
        path: changedPath,
        message: "Changed path is not repository-relative.",
      });
    }
    if (matchesForbiddenPath(normalized, forbiddenPaths)) {
      findings.push({
        rule_id: "review.forbidden_path",
        severity: "error",
        path: changedPath,
        message: "Changed path is excluded from reviewer input.",
      });
    }
  }

  let totalBytes = 0;
  for (const file of input.files) {
    totalBytes += Math.max(0, file.size_bytes);
    const normalized = normalizeRepositoryPath(file.path);
    const resolvedInside = isInside(workspace, resolve(file.resolved_path));
    const resolvedRelative = resolvedInside
      ? normalizeRepositoryPath(relative(workspace, resolve(file.resolved_path)))
      : undefined;

    if (!isRepositoryRelative(normalized) || !resolvedInside) {
      findings.push({
        rule_id: "review.path_outside_workspace",
        severity: "error",
        path: file.path,
        message: "Changed file resolves outside the review workspace.",
      });
    }
    if (file.is_symlink && !resolvedInside) {
      findings.push({
        rule_id: "review.symlink_escape",
        severity: "error",
        path: file.path,
        message: "Changed symlink resolves outside the review workspace.",
      });
    }
    if (
      matchesForbiddenPath(normalized, forbiddenPaths)
      || (
        resolvedRelative !== undefined
        && matchesForbiddenPath(resolvedRelative, forbiddenPaths)
      )
    ) {
      findings.push({
        rule_id: "review.forbidden_path",
        severity: "error",
        path: file.path,
        message: "Changed file or resolved target is excluded from reviewer input.",
      });
    }
    if (file.size_bytes > input.max_file_bytes) {
      findings.push({
        rule_id: "review.file_too_large",
        severity: "error",
        path: file.path,
        message: `Changed file is ${file.size_bytes} bytes; limit is ${input.max_file_bytes}.`,
      });
    }
    if (
      file.kind === "binary"
      || !allowedExtensions.has(extname(normalized).toLowerCase())
    ) {
      findings.push({
        rule_id: "review.binary_disallowed",
        severity: "error",
        path: file.path,
        message: "Changed file is binary or has a non-allowlisted extension.",
      });
    }
    if (file.kind === "text" && file.content !== undefined) {
      const secretFindings = scanText(file.content, { file: file.path })
        .findings
        .filter((finding) => finding.category === "secret");
      if (secretFindings.length > 0) {
        findings.push({
          rule_id: "review.secret_detected",
          severity: "error",
          path: file.path,
          message: `Changed text contains ${secretFindings.length} possible secret finding(s).`,
        });
      }
    }
  }

  return {
    pass: findings.length === 0,
    findings: deduplicateFindings(findings),
    changed_paths: changedPaths,
    total_bytes: totalBytes,
  };
}

function normalizeRepositoryPath(path: string): string {
  return path
    .replaceAll("\\", "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "");
}

function isRepositoryRelative(path: string): boolean {
  if (path === "" || isAbsolute(path) || /^[A-Za-z]:\//.test(path)) return false;
  return !path.split("/").includes("..");
}

function matchesForbiddenPath(
  path: string,
  forbiddenPaths: readonly string[],
): boolean {
  return forbiddenPaths.some((forbidden) => (
    path === forbidden
    || path.startsWith(`${forbidden}/`)
    || path.endsWith(`/${forbidden}`)
    || path.includes(`/${forbidden}/`)
  ));
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

function deduplicateFindings(
  findings: ReviewBoundaryFinding[],
): ReviewBoundaryFinding[] {
  const seen = new Set<string>();
  return findings.filter((finding) => {
    const key = `${finding.rule_id}\0${finding.path ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
