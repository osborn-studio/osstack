// Portfolio report — aggregates per-repo health into a maturity view with
// actionable recommendations. Pure and deterministic.

import { PortfolioReport, type RepoHealth, type StructuredRecommendation } from "./types.js";

/** Roles excluded from the average maturity unless explicitly enabled elsewhere. */
const NON_CORE_ROLES = new Set(["reference", "archive"]);

/**
 * The missing-LOOP.md recommendation wording (recommendations are rendered as
 * `<repo.name>: <this>`).
 *
 * @deprecated Since the structured-recommendations release. `osstack daily` now
 * dispatches on `structured_recommendations` (`kind === "add_loop_doc"` + a
 * `repo_id`) instead of string-matching this wording, so the free-text coupling
 * this constant existed to protect is gone. Kept exported for one release so no
 * downstream breaks; remove it (and this docstring) in the next major.
 */
export const LOOP_DOC_RECOMMENDATION = "add docs/LOOP.md to declare closed-loop contract";

export function buildPortfolioReport(repos: RepoHealth[], now = "2026-07-07T00:00:00.000Z"): PortfolioReport {
  // "Enabled" for averaging = repos that count toward portfolio maturity:
  // exclude reference/archive roles (they are dependencies/snapshots, not
  // products we are actively driving up the ladder).
  const counted = repos.filter((repo) => !NON_CORE_ROLES.has(repo.role));
  const averageLevel = counted.length === 0
    ? 0
    : round1(counted.reduce((sum, repo) => sum + repo.closed_loop_level, 0) / counted.length);

  // Single source of truth: build the structured list, then derive the
  // free-text `recommendations` from it so the two are byte-identical and can
  // never drift (the free-text array's rendering by `supervise report` is
  // unchanged — same strings, same order).
  const structured = deriveStructuredRecommendations(repos);
  const recommendations = structured.map((rec) => rec.text);

  return PortfolioReport.parse({
    generated_at: now,
    repo_count: repos.length,
    enabled_repo_count: counted.length,
    average_closed_loop_level: averageLevel,
    repos,
    recommendations,
    structured_recommendations: structured,
  });
}

function deriveStructuredRecommendations(repos: RepoHealth[]): StructuredRecommendation[] {
  const recommendations: StructuredRecommendation[] = [];

  for (const repo of repos) {
    if (NON_CORE_ROLES.has(repo.role)) continue;

    if (!repo.exists) {
      recommendations.push({
        kind: "missing_path",
        repo_id: repo.repo_id,
        text: `${repo.name}: registered path is missing — fix the path or archive the repo`,
      });
      continue;
    }

    // Important repos below L2 need a declared loop contract + verification.
    if (repo.closed_loop_level < 2) {
      if (!repo.has_loop_doc) {
        recommendations.push({
          kind: "add_loop_doc",
          repo_id: repo.repo_id,
          text: `${repo.name}: ${LOOP_DOC_RECOMMENDATION}`,
        });
      }
      if (!repo.has_verify_command && !repo.has_tests) {
        recommendations.push({
          kind: "add_verify_command",
          repo_id: repo.repo_id,
          text: `${repo.name}: add a verify command so runs are traceable`,
        });
      }
    }

    // Failures observed but no assetization happening yet.
    if (repo.latest_loop_success_rate !== undefined
      && repo.latest_loop_success_rate < 1
      && repo.closed_loop_level < 3) {
      recommendations.push({
        kind: "enable_failure_assetization",
        repo_id: repo.repo_id,
        text: `${repo.name}: enable failure assetization — failing runs exist but no feedback assets are recorded`,
      });
    }

    // LLM judges in use but no anchor cases to keep them honest.
    if (repo.evaluator_epoch_id !== undefined
      && (repo.adversarial_case_count ?? 0) === 0) {
      recommendations.push({
        kind: "create_evaluator_anchor_set",
        repo_id: repo.repo_id,
        text: `${repo.name}: create evaluator anchor set — an evaluator epoch exists with no anchor cases`,
      });
    }

    // Evaluator drifting or weak — freeze auto-apply and improve the evaluator.
    if (repo.evaluator_anchor_accuracy !== undefined && repo.evaluator_anchor_accuracy < 0.8) {
      recommendations.push({
        kind: "freeze_evaluator",
        repo_id: repo.repo_id,
        text: `${repo.name}: freeze auto-apply and improve evaluator — anchor accuracy ${repo.evaluator_anchor_accuracy.toFixed(2)} < 0.80`,
      });
    }
  }

  // Duplicate-path / duplicate-name consolidation hints. Portfolio-level (they
  // span multiple repos), so no single `repo_id`.
  recommendations.push(...duplicateRecommendations(repos));

  return recommendations;
}

function duplicateRecommendations(repos: RepoHealth[]): StructuredRecommendation[] {
  const out: StructuredRecommendation[] = [];
  const byPath = groupBy(repos, (repo) => normalizePath(repo.path));
  for (const [path, group] of byPath) {
    if (group.length > 1) {
      out.push({
        kind: "consolidation",
        text: `consolidation: ${group.map((repo) => repo.repo_id).join(", ")} share path ${path}`,
      });
    }
  }
  const byName = groupBy(repos, (repo) => repo.name.toLowerCase());
  for (const [name, group] of byName) {
    if (group.length > 1) {
      out.push({
        kind: "consolidation",
        text: `consolidation: ${group.map((repo) => repo.repo_id).join(", ")} share name "${name}"`,
      });
    }
  }
  return out;
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    const bucket = map.get(k);
    if (bucket === undefined) map.set(k, [item]);
    else bucket.push(item);
  }
  return map;
}

function normalizePath(value: string): string {
  return value.replace(/\/+$/, "");
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
