import { isAbsolute } from "node:path";

export class KnowledgeHygienePathPatternError extends Error {
  readonly issues: readonly string[];

  constructor(value: string, issues: readonly string[]) {
    super(`invalid knowledge hygiene path '${value}': ${issues.join("; ")}`);
    this.name = "KnowledgeHygienePathPatternError";
    this.issues = issues;
  }
}

function pathIssues(value: string, allowPattern: boolean): string[] {
  const issues: string[] = [];
  if (value.length === 0) issues.push("must not be empty");
  if (value.includes("\\")) issues.push("must use POSIX separators");
  if (isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value)) {
    issues.push("must be repository-relative");
  }
  if (value.split("/").includes("..")) {
    issues.push("must not contain '..' segments");
  }
  if (
    value === "." ||
    value.startsWith("./") ||
    value.endsWith("/") ||
    value.includes("//") ||
    value.split("/").includes(".")
  ) {
    issues.push("must be normalized without '.', repeated, or trailing separators");
  }
  if (!allowPattern && value.includes("*")) {
    issues.push("must not contain wildcards");
  }
  if (allowPattern) {
    if (/[?[\]{}()]/.test(value) || value.startsWith("!")) {
      issues.push("contains unsupported pattern syntax");
    }
    for (const segment of value.split("/")) {
      if (segment.includes("**") && segment !== "**") {
        issues.push("'**' must occupy a complete path segment");
        break;
      }
    }
  }
  return issues;
}

export function assertKnowledgeHygieneRepositoryPathV1(value: string): void {
  const issues = pathIssues(value, false);
  if (issues.length > 0) {
    throw new KnowledgeHygienePathPatternError(value, issues);
  }
}

export function assertKnowledgeHygienePathPatternV1(value: string): void {
  const issues = pathIssues(value, true);
  if (issues.length > 0) {
    throw new KnowledgeHygienePathPatternError(value, issues);
  }
}

function normalizeCandidatePath(value: string): string | undefined {
  const normalized = value.replaceAll("\\", "/");
  if (pathIssues(normalized, false).length > 0) return undefined;
  return normalized;
}

function matchSegment(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^$|\\]/g, "\\$&");
  return new RegExp(`^${escaped.replaceAll("*", "[^/]*")}$`, "u").test(value);
}

export function matchesKnowledgeHygienePathPatternV1(
  pattern: string,
  candidatePath: string,
): boolean {
  assertKnowledgeHygienePathPatternV1(pattern);
  const candidate = normalizeCandidatePath(candidatePath);
  if (candidate === undefined) return false;

  const patternSegments = pattern.split("/");
  const pathSegments = candidate.split("/");
  const memo = new Map<string, boolean>();

  const matchesFrom = (patternIndex: number, pathIndex: number): boolean => {
    const key = `${patternIndex}:${pathIndex}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;

    let matches: boolean;
    if (patternIndex === patternSegments.length) {
      matches = pathIndex === pathSegments.length;
    } else if (patternSegments[patternIndex] === "**") {
      matches =
        matchesFrom(patternIndex + 1, pathIndex) ||
        (pathIndex < pathSegments.length &&
          matchesFrom(patternIndex, pathIndex + 1));
    } else {
      const patternSegment = patternSegments[patternIndex];
      const pathSegment = pathSegments[pathIndex];
      matches =
        patternSegment !== undefined &&
        pathSegment !== undefined &&
        matchSegment(patternSegment, pathSegment) &&
        matchesFrom(patternIndex + 1, pathIndex + 1);
    }
    memo.set(key, matches);
    return matches;
  };

  return matchesFrom(0, 0);
}
