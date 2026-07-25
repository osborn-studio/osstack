// `osstack supervise|feedback|adversarial|meta` — the read-mostly surface of
// the recursive control plane. register writes the repo registry; scan/report
// build the portfolio maturity view; init-loop-doc scaffolds a LOOP contract;
// feedback/adversarial/meta list persisted control-plane state.

import { existsSync } from "node:fs";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join } from "node:path";
import { listAnchorCases, listEvaluatorVersions, listFeedbackAssets, listImprovementProposals, queryProbeOutcomeMetrics } from "@osstack/core";
import { guardedOpenDb as openDb } from "./guarded-open-db.js";
import {
  RepoRole,
  addRepoRegistryEntry,
  attachProbeOutcomeMetrics,
  attachKnowledgeHygieneSummaries,
  buildPortfolioReport,
  readRepoRegistry,
  renderLoopDoc,
  scanRepo,
  scanPortfolioKnowledgeHygiene,
  type PortfolioReport,
  type RepoHealth,
} from "@osstack/supervisor";
import { osstackHome } from "./paths.js";
import {
  firstPositional,
  flag,
  flagAll,
  hasFlag,
  openStateDb,
  printJson,
  resolveRegistryPath,
} from "./supervisor-cli-support.js";

const REGISTER_FLAGS = new Set(["--repo-id", "--role", "--priority", "--verify", "--registry", "--workspace", "--owner"]);

export async function handleSuperviseCommand(args: string[]): Promise<number> {
  const sub = args[0];
  const rest = args.slice(1);

  if (sub === "register") return await superviseRegister(rest);
  if (sub === "scan") return await superviseScan(rest);
  if (sub === "report") return await superviseReport(rest);
  if (sub === "init-loop-doc") return await superviseInitLoopDoc(rest);
  if (sub === "help" || sub === "--help" || sub === "-h" || sub === undefined) {
    printSuperviseHelp();
    return 0;
  }
  console.error(`osstack: unknown supervise subcommand "${sub}"`);
  return 1;
}

async function superviseRegister(args: string[]): Promise<number> {
  const path = firstPositional(args, REGISTER_FLAGS);
  if (path === undefined) {
    console.error("osstack: supervise register requires a repo path");
    return 1;
  }
  const absPath = isAbsolute(path) ? path : join(process.cwd(), path);
  const repoId = flag(args, "--repo-id") ?? basename(absPath);
  const roleRaw = flag(args, "--role") ?? "app";
  const role = RepoRole.safeParse(roleRaw);
  if (!role.success) {
    console.error(`osstack: invalid --role "${roleRaw}" (expected ${RepoRole.options.join(", ")})`);
    return 1;
  }
  const priorityRaw = flag(args, "--priority");
  let priority = 50;
  if (priorityRaw !== undefined) {
    priority = Number(priorityRaw);
    if (!Number.isFinite(priority) || priority < 0 || priority > 100) {
      console.error("osstack: --priority must be a number between 0 and 100");
      return 1;
    }
  }
  const registryPath = resolveRegistryPath(args);
  const owner = flag(args, "--owner");
  const entries = await addRepoRegistryEntry(registryPath, {
    repo_id: repoId,
    name: repoId,
    path: absPath,
    role: role.data,
    priority,
    verify_commands: flagAll(args, "--verify"),
    ...(owner !== undefined ? { owner } : {}),
  });
  const entry = entries.find((candidate) => candidate.repo_id === repoId);
  if (hasFlag(args, "--json")) {
    printJson({ registry: registryPath, entry });
  } else {
    console.log(`registered ${repoId} (${role.data}, priority ${priority}) -> ${registryPath}`);
  }
  return 0;
}

async function superviseScan(args: string[]): Promise<number> {
  const report = await scanPortfolio(args);
  if (hasFlag(args, "--json")) {
    printJson(report);
    return 0;
  }
  console.log(`Portfolio: ${report.enabled_repo_count} enabled / ${report.repo_count} repos, avg closed-loop level ${report.average_closed_loop_level}`);
  for (const repo of report.repos) {
    console.log(`  ${repo.name} [${repo.role}] L${repo.closed_loop_level}${repo.exists ? "" : " (missing)"}${repo.findings.length > 0 ? ` — ${repo.findings.join("; ")}` : ""}`);
  }
  return 0;
}

async function superviseReport(args: string[]): Promise<number> {
  const report = await scanPortfolio(args);
  if (hasFlag(args, "--json")) {
    printJson(report);
    return 0;
  }
  console.log(renderPortfolioMarkdown(report, flag(args, "--lang") === "zh-CN" ? "zh-CN" : "en"));
  return 0;
}

async function scanPortfolio(args: string[]): Promise<PortfolioReport> {
  const registryPath = resolveRegistryPath(args);
  const entries = await readRepoRegistry(registryPath);
  const enabled = entries.filter((entry) => entry.enabled);
  const healths: RepoHealth[] = [];
  for (const entry of enabled) healths.push(await scanRepo(entry));
  const hygiene = await scanPortfolioKnowledgeHygiene(enabled);
  const now = new Date();
  const report = buildPortfolioReport(
    attachKnowledgeHygieneSummaries(healths, hygiene),
    now.toISOString(),
  );
  const dbPath = join(osstackHome(), "state.db");
  if (!existsSync(dbPath)) return report;
  try {
    const db = openDb({ path: dbPath });
    try {
      return attachProbeOutcomeMetrics(report, queryProbeOutcomeMetrics(db, {
        as_of_ms: now.getTime(),
        repo_ids: enabled.map((entry) => entry.repo_id),
      }));
    } finally {
      db.close();
    }
  } catch {
    return report;
  }
}

async function superviseInitLoopDoc(args: string[]): Promise<number> {
  const repoId = flag(args, "--repo");
  if (repoId === undefined) {
    console.error("osstack: supervise init-loop-doc requires --repo <repo-id>");
    return 1;
  }
  const registryPath = resolveRegistryPath(args);
  const entries = await readRepoRegistry(registryPath);
  const entry = entries.find((candidate) => candidate.repo_id === repoId);
  if (entry === undefined) {
    console.error(`osstack: no registered repo with id ${repoId} in ${registryPath}`);
    return 1;
  }
  const docPath = isAbsolute(entry.loop_doc_path) ? entry.loop_doc_path : join(entry.path, entry.loop_doc_path);
  const exists = await pathExists(docPath);
  if (exists && !hasFlag(args, "--overwrite")) {
    console.log(`loop doc already exists: ${docPath} (use --overwrite to replace)`);
    return 0;
  }
  await mkdir(dirname(docPath), { recursive: true });
  await writeFile(docPath, renderLoopDoc(entry), "utf8");
  console.log(`wrote ${docPath}`);
  return 0;
}

// ── feedback assets ─────────────────────────────────────────────────────────

export async function handleFeedbackCommand(args: string[]): Promise<number> {
  const sub = args[0];
  if (sub !== "assets") {
    console.error(`osstack: unknown feedback subcommand "${sub ?? ""}" (expected: assets)`);
    return 1;
  }
  const rest = args.slice(1);
  const { db } = await openStateDb();
  try {
    const repoId = flag(rest, "--repo");
    const status = flag(rest, "--status");
    const limit = numberFlag(flag(rest, "--limit"));
    const assets = listFeedbackAssets(db, {
      ...(repoId !== undefined ? { repo_id: repoId } : {}),
      ...(status !== undefined ? { status: status as never } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    if (hasFlag(rest, "--json")) {
      printJson({ assets });
    } else if (assets.length === 0) {
      console.log("No feedback assets.");
    } else {
      for (const asset of assets) {
        console.log(`${asset.asset_id} [${asset.kind}/${asset.failure_family}] ${asset.status} — ${asset.summary}`);
      }
    }
    return 0;
  } finally {
    db.close();
  }
}

// ── adversarial list ────────────────────────────────────────────────────────

export async function handleAdversarialCommand(args: string[]): Promise<number> {
  const sub = args[0];
  if (sub !== "list") {
    console.error(`osstack: unknown adversarial subcommand "${sub ?? ""}" (expected: list)`);
    return 1;
  }
  const rest = args.slice(1);
  const { db } = await openStateDb();
  try {
    const repoId = flag(rest, "--repo");
    const limit = numberFlag(flag(rest, "--limit"));
    const cases = listAnchorCases(db, {
      ...(repoId !== undefined ? { repo_id: repoId } : {}),
      adversarial: true,
      ...(limit !== undefined ? { limit } : {}),
    });
    if (hasFlag(rest, "--json")) {
      printJson({ adversarial_cases: cases });
    } else if (cases.length === 0) {
      console.log("No adversarial anchor cases.");
    } else {
      for (const c of cases) {
        console.log(`${c.case_id} expect=${c.expected_verdict} — ${c.input_summary}`);
      }
    }
    return 0;
  } finally {
    db.close();
  }
}

// ── meta eval (advisory, read-only) ─────────────────────────────────────────

export async function handleMetaCommand(args: string[]): Promise<number> {
  const sub = args[0];
  if (sub !== "eval") {
    console.error(`osstack: unknown meta subcommand "${sub ?? ""}" (expected: eval)`);
    return 1;
  }
  const rest = args.slice(1);
  const { db } = await openStateDb();
  try {
    const repoId = flag(rest, "--repo");
    const scope = repoId !== undefined ? { repo_id: repoId } : {};
    const summary = {
      generated_at: new Date().toISOString(),
      repo_id: repoId ?? null,
      advisory: true,
      note: "L5 meta-evaluation is advisory/read-only; it never changes state or promotes evaluators.",
      counts: {
        feedback_assets: listFeedbackAssets(db, { ...scope, limit: 10_000 }).length,
        improvement_proposals: listImprovementProposals(db, { ...scope, limit: 10_000 }).length,
        evaluator_versions: listEvaluatorVersions(db, { ...scope, limit: 10_000 }).length,
        adversarial_cases: listAnchorCases(db, { ...scope, adversarial: true, limit: 10_000 }).length,
      },
    };
    if (hasFlag(rest, "--json")) {
      printJson(summary);
    } else {
      console.log(`meta eval${repoId !== undefined ? ` for ${repoId}` : ""} (advisory):`);
      console.log(`  feedback assets: ${summary.counts.feedback_assets}`);
      console.log(`  improvement proposals: ${summary.counts.improvement_proposals}`);
      console.log(`  evaluator versions: ${summary.counts.evaluator_versions}`);
      console.log(`  adversarial cases: ${summary.counts.adversarial_cases}`);
    }
    return 0;
  } finally {
    db.close();
  }
}

// ── rendering ────────────────────────────────────────────────────────────────

function renderPortfolioMarkdown(report: PortfolioReport, lang: "en" | "zh-CN"): string {
  const t = lang === "zh-CN"
    ? { title: "Osstack 组合闭环报告", summary: "摘要", repos: "仓库", probe: "Probe 结果指标", recs: "建议", level: "闭环级别" }
    : { title: "Osstack Portfolio Closed-Loop Report", summary: "Summary", repos: "Repos", probe: "Probe outcomes", recs: "Recommendations", level: "closed-loop level" };
  const lines = [
    `# ${t.title}`,
    "",
    `## ${t.summary}`,
    `- generated_at: ${report.generated_at}`,
    `- repos: ${report.enabled_repo_count} enabled / ${report.repo_count}`,
    `- average ${t.level}: ${report.average_closed_loop_level}`,
    "",
    `## ${t.repos}`,
    ...report.repos.map((repo) => `- ${repo.name} [${repo.role}] L${repo.closed_loop_level}${repo.exists ? "" : " (missing)"}`),
    "",
    ...(report.probe_outcomes === undefined
      ? []
      : [
          `## ${t.probe}`,
          `- baseline status: ${report.probe_outcomes.baseline_status}`,
          `- replay coverage: ${report.probe_outcomes.counts.sessions_replayed}/${report.probe_outcomes.counts.sessions_total} sessions (${report.probe_outcomes.counts.sessions_skipped} skipped)`,
          `- effective question rate: ${formatOutcomeRate(report.probe_outcomes.rates.effective_question_rate)}`,
          `- decision integration rate: ${formatOutcomeRate(report.probe_outcomes.rates.decision_integration_rate)}`,
          `- mid-build architecture deviation rate: ${formatOutcomeRate(report.probe_outcomes.rates.mid_build_architecture_deviation_rate)}`,
          `- stale deferral rate: ${formatOutcomeRate(report.probe_outcomes.rates.stale_deferral_rate)}`,
          `- waiver rate: ${formatOutcomeRate(report.probe_outcomes.rates.waiver_rate)}`,
          `- completion rate: ${formatOutcomeRate(report.probe_outcomes.rates.completion_rate)}`,
          "",
        ]),
    `## ${t.recs}`,
    ...(report.recommendations.length > 0 ? report.recommendations.map((rec) => `- ${rec}`) : ["- None"]),
  ];
  return `${lines.join("\n")}\n`;
}

function formatOutcomeRate(value: number | null): string {
  return value === null ? "n/a" : `${Math.round(value * 10_000) / 100}%`;
}

function printSuperviseHelp(): void {
  console.log(`osstack supervise — portfolio repo supervision

  supervise register <path> [--repo-id X] [--role R] [--priority N] [--verify CMD] [--registry P]
  supervise scan [--registry P] [--json]
  supervise report [--registry P] [--lang zh-CN] [--json]
  supervise init-loop-doc --repo <id> [--registry P] [--overwrite]

Roles: ${RepoRole.options.join(", ")}

Registry resolution: --registry, else --workspace/.osstack/repos.json, else
cwd/.osstack/repos.json when present, else $OSSTACK_HOME/repos.json when
present (machine-scoped). register WRITES to the resolved path — pass
--workspace . to force a repo-local registry.
`);
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

function numberFlag(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}
