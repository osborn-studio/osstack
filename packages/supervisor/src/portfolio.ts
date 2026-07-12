// Portfolio report — aggregates per-repo health into a maturity view with
// actionable recommendations. Pure and deterministic.

import { PortfolioReport, type RepoHealth } from "./types.js";

/** Roles excluded from the average maturity unless explicitly enabled elsewhere. */
const NON_CORE_ROLES = new Set(["reference", "archive"]);

/**
 * The missing-LOOP.md recommendation wording (recommendations are rendered as
 * `<repo.name>: <this>`). Exported because `osstack daily` maps EXACTLY this
 * wording to a runnable `supervise init-loop-doc` dispatch — rewording it here
 * without the shared constant would silently degrade that mapping.
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

  const recommendations = deriveRecommendations(repos);

  return PortfolioReport.parse({
    generated_at: now,
    repo_count: repos.length,
    enabled_repo_count: counted.length,
    average_closed_loop_level: averageLevel,
    repos,
    recommendations,
  });
}

function deriveRecommendations(repos: RepoHealth[]): string[] {
  const recommendations: string[] = [];

  for (const repo of repos) {
    if (NON_CORE_ROLES.has(repo.role)) continue;

    if (!repo.exists) {
      recommendations.push(`${repo.name}: registered path is missing — fix the path or archive the repo`);
      continue;
    }

    // Important repos below L2 need a declared loop contract + verification.
    if (repo.closed_loop_level < 2) {
      if (!repo.has_loop_doc) {
        recommendations.push(`${repo.name}: ${LOOP_DOC_RECOMMENDATION}`);
      }
      if (!repo.has_verify_command && !repo.has_tests) {
        recommendations.push(`${repo.name}: add a verify command so runs are traceable`);
      }
    }

    // Failures observed but no assetization happening yet.
    if (repo.latest_loop_success_rate !== undefined
      && repo.latest_loop_success_rate < 1
      && repo.closed_loop_level < 3) {
      recommendations.push(`${repo.name}: enable failure assetization — failing runs exist but no feedback assets are recorded`);
    }

    // LLM judges in use but no anchor cases to keep them honest.
    if (repo.evaluator_epoch_id !== undefined
      && (repo.adversarial_case_count ?? 0) === 0) {
      recommendations.push(`${repo.name}: create evaluator anchor set — an evaluator epoch exists with no anchor cases`);
    }

    // Evaluator drifting or weak — freeze auto-apply and improve the evaluator.
    if (repo.evaluator_anchor_accuracy !== undefined && repo.evaluator_anchor_accuracy < 0.8) {
      recommendations.push(`${repo.name}: freeze auto-apply and improve evaluator — anchor accuracy ${repo.evaluator_anchor_accuracy.toFixed(2)} < 0.80`);
    }
  }

  // Duplicate-path / duplicate-name consolidation hints.
  recommendations.push(...duplicateRecommendations(repos));

  return recommendations;
}

function duplicateRecommendations(repos: RepoHealth[]): string[] {
  const out: string[] = [];
  const byPath = groupBy(repos, (repo) => normalizePath(repo.path));
  for (const [path, group] of byPath) {
    if (group.length > 1) {
      out.push(`consolidation: ${group.map((repo) => repo.repo_id).join(", ")} share path ${path}`);
    }
  }
  const byName = groupBy(repos, (repo) => repo.name.toLowerCase());
  for (const [name, group] of byName) {
    if (group.length > 1) {
      out.push(`consolidation: ${group.map((repo) => repo.repo_id).join(", ")} share name "${name}"`);
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
