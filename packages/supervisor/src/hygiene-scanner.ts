import {
  checkKnowledgeHygiene,
  type KnowledgeHygieneReportV1,
} from "@osstack/governance";
import {
  RepoHealth,
  type RepoHealth as RepoHealthValue,
  type RepoKnowledgeHygieneSummaryV1,
  type RepoRegistryEntry,
} from "./types.js";

export type RepoKnowledgeHygieneScanResultV1 =
  | {
      repo_id: string;
      status: "ok";
      hygiene: RepoKnowledgeHygieneSummaryV1;
    }
  | {
      repo_id: string;
      status: "error";
      error: string;
    };

export interface RepoKnowledgeHygieneHistorySummaryV1 {
  recurring_count: number;
  oldest_open_days?: number;
}

export interface ScanPortfolioKnowledgeHygieneOptionsV1 {
  concurrency?: number;
  check?: typeof checkKnowledgeHygiene;
  history?: (
    repoId: string,
  ) => Promise<RepoKnowledgeHygieneHistorySummaryV1>;
}

function concurrency(value: number | undefined, size: number): number {
  const selected = value ?? 4;
  if (!Number.isInteger(selected) || selected < 1 || selected > 16) {
    throw new RangeError("knowledge hygiene scan concurrency must be 1..16");
  }
  return Math.min(selected, Math.max(1, size));
}

function summary(
  report: KnowledgeHygieneReportV1,
  history: RepoKnowledgeHygieneHistorySummaryV1,
): RepoKnowledgeHygieneSummaryV1 {
  return {
    complete: report.completeness.complete,
    error_count: report.summary.error,
    warning_count: report.summary.warning,
    recurring_count: history.recurring_count,
    ...(history.oldest_open_days === undefined
      ? {}
      : { oldest_open_days: history.oldest_open_days }),
    checked_at: report.generated_at,
  };
}

export async function scanPortfolioKnowledgeHygiene(
  registry: readonly RepoRegistryEntry[],
  options: ScanPortfolioKnowledgeHygieneOptionsV1 = {},
): Promise<RepoKnowledgeHygieneScanResultV1[]> {
  const entries = registry.filter((entry) => entry.enabled);
  if (entries.length === 0) return [];
  const results = new Array<RepoKnowledgeHygieneScanResultV1>(entries.length);
  const check = options.check ?? checkKnowledgeHygiene;
  const history = options.history ?? (async () => ({ recurring_count: 0 }));
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    while (nextIndex < entries.length) {
      const index = nextIndex;
      nextIndex += 1;
      const entry = entries[index];
      if (entry === undefined) continue;
      try {
        const [report, prior] = await Promise.all([
          check({ repo_root: entry.path, mode: "all" }),
          history(entry.repo_id),
        ]);
        results[index] = {
          repo_id: entry.repo_id,
          status: "ok",
          hygiene: summary(report, prior),
        };
      } catch (error) {
        results[index] = {
          repo_id: entry.repo_id,
          status: "error",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }
  };

  await Promise.all(
    Array.from({ length: concurrency(options.concurrency, entries.length) }, worker),
  );
  return results;
}

export function attachKnowledgeHygieneSummaries(
  healths: readonly RepoHealthValue[],
  scans: readonly RepoKnowledgeHygieneScanResultV1[],
): RepoHealthValue[] {
  const byRepo = new Map(scans.map((scan) => [scan.repo_id, scan]));
  return healths.map((health) => {
    const scan = byRepo.get(health.repo_id);
    if (scan === undefined) return health;
    if (scan.status === "ok") {
      return RepoHealth.parse({ ...health, hygiene: scan.hygiene });
    }
    return RepoHealth.parse({
      ...health,
      findings: [
        ...health.findings,
        `knowledge hygiene scan failed: ${scan.error}`,
      ],
    });
  });
}
