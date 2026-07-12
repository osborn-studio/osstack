// `osstack daily` — a read-only portfolio brief and the first Agent Command
// Protocol dogfood surface (R1.4). It composes existing kernel capability:
//   1. Scan   — the supervisor portfolio maturity report over `.osstack/repos.json`.
//   2. GitHub — the read-only `@osstack/github` portfolio-status adapter (PRs/CI/release).
//   3. Stack  — the existing kanban "stack" board summary, when any cards exist.
//   4. Delta  — diff against the previous brief (new PRs / CI flips / maturity changes).
//   5. Render — Markdown for humans by default; `--json` emits a protocol
//               AgentCommandResult (status ok, brief in `result`, per-repo
//               evidence_refs, ≤3 owner decisions in next_actions).
//
// Read-only: the ONLY thing it writes is the dated brief JSON under
// $OSSTACK_HOME/daily-briefs/ (delta substrate). No apply, no execution.

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { KanbanRepository, getBoard, openDb } from "@osstack/core";
import {
  fetchPortfolioGithubStatus,
  type CommandRunner,
  type RepoGithubStatus,
} from "@osstack/github";
import { PROTOCOL_VERSION } from "@osstack/protocol";
import type { AgentCommandResult } from "@osstack/protocol";
import {
  buildPortfolioReport,
  readRepoRegistry,
  scanRepo,
  type PortfolioReport,
  type RepoHealth,
  type RepoRegistryEntry,
} from "@osstack/supervisor";
import { osstackHome } from "./paths.js";
import { hasFlag, resolveRegistryPath } from "./supervisor-cli-support.js";

export interface DailyCliDeps {
  /** Injectable command runner for the GitHub adapter (offline in tests). */
  runner?: CommandRunner;
  /** Clock override (tests pin the ISO date + generated_at). */
  now?: () => Date;
  out?: (line: string) => void;
}

/** Inputs to the reusable brief core (`runDailyBrief`). */
export interface RunDailyBriefDeps {
  /** Resolved repo registry path (absolute). The daemon resolves + stores this. */
  registryPath: string;
  /** Injectable command runner for the GitHub adapter (offline in tests). */
  runner?: CommandRunner;
  /** Clock override (tests pin the ISO date + generated_at). */
  now?: () => Date;
}

/** The full outcome of one brief composition: the brief, its write path, the
 *  strict protocol result, and the enabled registry entries used. */
export interface DailyBriefRun {
  brief: DailyBrief;
  briefPath: string;
  result: AgentCommandResult;
  entries: RepoRegistryEntry[];
}

export interface StackBoardSummary {
  board: string;
  total: number;
  columns: { name: string; count: number }[];
}

export interface DailyDelta {
  is_first_run: boolean;
  previous_brief_date?: string;
  new_prs: { repo_id: string; number: number; title: string }[];
  ci_flips: { repo_id: string; from: string; to: string }[];
  maturity_changes: { repo_id: string; from: number; to: number }[];
}

export interface DailyBrief {
  generated_at: string;
  date: string;
  portfolio: PortfolioReport;
  github: RepoGithubStatus[];
  stack?: StackBoardSummary;
  delta: DailyDelta;
  warnings: string[];
}

/** Failing CI conclusions (mirrors the stack drift taxonomy). */
const FAILING_CI = new Set(["failure", "cancelled", "timed_out", "startup_failure", "action_required"]);

/** Latest CI conclusion|status for a repo, or "none" when it has no runs. */
export function repoCiStatus(status: RepoGithubStatus): string {
  const latest = status.ci_runs[0];
  if (latest === undefined) return "none";
  return (latest.conclusion ?? latest.status ?? "unknown").toLowerCase();
}

/**
 * Compose one daily brief (steps 1–4 + persist + build the strict protocol
 * result) with no CLI concerns: no arg parsing, no rendering, no stdout. The
 * daemon runs this in-process each scheduled tick, and `handleDailyCommand`
 * wraps it for the manual CLI path — so a scheduled brief is byte-compatible
 * with a manual one (same registry read, same `$OSSTACK_HOME/daily-briefs/`
 * write, same `AgentCommandResult`).
 */
export async function runDailyBrief(deps: RunDailyBriefDeps): Promise<DailyBriefRun> {
  const now = deps.now?.() ?? new Date();
  // UTC ISO date, intentionally: brief filenames and delta boundaries must be
  // deterministic across machines/timezones (N4 ruling — determinism over local tz).
  const date = now.toISOString().slice(0, 10);

  const entries = await readRepoRegistry(deps.registryPath);
  const enabled = entries.filter((entry) => entry.enabled);

  // 1. Portfolio maturity scan (supervisor, existing).
  const healths: RepoHealth[] = [];
  for (const entry of enabled) healths.push(await scanRepo(entry));
  const portfolio = buildPortfolioReport(healths, now.toISOString());

  // 2. GitHub read adapter (degrades per-repo, never throws).
  const github = await fetchPortfolioGithubStatus(
    enabled.map((entry) => ({ repo_id: entry.repo_id, path: entry.path })),
    deps.runner,
  );

  // 3. Stack board summary — included only when the board actually has cards.
  const { summary: stack, warning: stackWarning } = readStackBoardSummary();

  const warnings = github.filter((g) => g.warning !== undefined).map((g) => `${g.repo_id}: ${g.warning}`);
  if (stackWarning !== undefined) warnings.push(stackWarning);

  // 4. Delta against the most recent previous brief.
  const briefsDir = join(osstackHome(), "daily-briefs");
  const previous = await readPreviousBrief(briefsDir, date);
  const delta = computeDelta(previous, { portfolio, github });

  const brief: DailyBrief = {
    generated_at: now.toISOString(),
    date,
    portfolio,
    github,
    ...(stack !== undefined ? { stack } : {}),
    delta,
    warnings,
  };

  // Persist the brief (the only write this command performs).
  const briefPath = join(briefsDir, `${date}.json`);
  await mkdir(briefsDir, { recursive: true });
  await writeFile(briefPath, `${JSON.stringify(brief, null, 2)}\n`, "utf8");

  return { brief, briefPath, result: buildDailyResult(brief, briefPath, enabled), entries: enabled };
}

export async function handleDailyCommand(args: string[], deps: DailyCliDeps = {}): Promise<number> {
  const out = deps.out ?? console.log;

  // Thin wrapper: parse flags → runDailyBrief → render. All composition lives
  // in runDailyBrief so the daemon and the CLI produce identical briefs.
  const run = await runDailyBrief({
    registryPath: resolveRegistryPath(args),
    ...(deps.runner !== undefined ? { runner: deps.runner } : {}),
    ...(deps.now !== undefined ? { now: deps.now } : {}),
  });

  if (hasFlag(args, "--json")) {
    out(JSON.stringify(run.result, null, 2));
  } else {
    out(renderDailyMarkdown(run.brief));
  }
  return 0;
}

// ── Stack board ──────────────────────────────────────────────────────────────

/**
 * Never-crash: a corrupt/locked state.db must not take `daily` down — the board
 * is one facet of the brief, so any throw degrades to an omitted section plus a
 * warning surfaced in `brief.warnings`.
 */
function readStackBoardSummary(board = "stack"): { summary?: StackBoardSummary; warning?: string } {
  const dbPath = join(osstackHome(), "state.db");
  // No state DB yet ⇒ no stack board; omit rather than create one as a side effect.
  if (!existsSync(dbPath)) return {};
  try {
    const db = openDb({ path: dbPath });
    try {
      const repo = new KanbanRepository(db, dbPath);
      const view = getBoard(repo, { board, includeArchived: true });
      if (!view.changed || view.stats.total === 0) return {};
      return {
        summary: {
          board,
          total: view.stats.total,
          columns: view.columns
            .filter((column) => column.cards.length > 0)
            .map((column) => ({ name: column.name, count: column.cards.length })),
        },
      };
    } finally {
      db.close();
    }
  } catch (err) {
    return {
      warning: `stack board unavailable (${dbPath}): ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ── Delta ──────────────────────────────────────────────────────────────────

/** Pure diff of the current scan against the previous persisted brief. */
export function computeDelta(
  previous: DailyBrief | undefined,
  current: { portfolio: PortfolioReport; github: RepoGithubStatus[] },
): DailyDelta {
  if (previous === undefined) {
    return { is_first_run: true, new_prs: [], ci_flips: [], maturity_changes: [] };
  }

  const prevPrNumbers = new Map<string, Set<number>>();
  const prevCi = new Map<string, string>();
  for (const g of previous.github) {
    prevPrNumbers.set(g.repo_id, new Set(g.pull_requests.map((pr) => pr.number)));
    prevCi.set(g.repo_id, repoCiStatus(g));
  }
  const prevMaturity = new Map<string, number>();
  for (const repo of previous.portfolio.repos) prevMaturity.set(repo.repo_id, repo.closed_loop_level);

  const new_prs: DailyDelta["new_prs"] = [];
  const ci_flips: DailyDelta["ci_flips"] = [];
  for (const g of current.github) {
    const known = prevPrNumbers.get(g.repo_id);
    for (const pr of g.pull_requests) {
      // A PR is "new" only when we had a prior brief for this repo and it was absent then.
      if (known !== undefined && !known.has(pr.number)) {
        new_prs.push({ repo_id: g.repo_id, number: pr.number, title: pr.title });
      }
    }
    const before = prevCi.get(g.repo_id);
    const after = repoCiStatus(g);
    if (before !== undefined && before !== after) {
      ci_flips.push({ repo_id: g.repo_id, from: before, to: after });
    }
  }

  const maturity_changes: DailyDelta["maturity_changes"] = [];
  for (const repo of current.portfolio.repos) {
    const before = prevMaturity.get(repo.repo_id);
    if (before !== undefined && before !== repo.closed_loop_level) {
      maturity_changes.push({ repo_id: repo.repo_id, from: before, to: repo.closed_loop_level });
    }
  }

  return {
    is_first_run: false,
    previous_brief_date: previous.date,
    new_prs,
    ci_flips,
    maturity_changes,
  };
}

async function readPreviousBrief(briefsDir: string, today: string): Promise<DailyBrief | undefined> {
  let files: string[];
  try {
    files = await readdir(briefsDir);
  } catch {
    return undefined;
  }
  // Dated `YYYY-MM-DD.json` files sort lexicographically = chronologically.
  // Exclude today's own file so a same-day re-run still diffs against the prior day.
  const dated = files
    .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f) && f !== `${today}.json`)
    .sort();
  const latest = dated.at(-1);
  if (latest === undefined) return undefined;
  try {
    return JSON.parse(await readFile(join(briefsDir, latest), "utf8")) as DailyBrief;
  } catch {
    return undefined;
  }
}

// ── Owner decisions (≤3 next_actions) ────────────────────────────────────────

/**
 * Derive at most three owner decisions, prioritized: failing CI first, then
 * repos with open non-draft PRs to review, then portfolio maturity gaps. The
 * `command` is a stable `<service>.<action>` protocol identifier (advisory — the
 * daily command never executes it), the `reason` is the human-facing decision.
 *
 * CTO ruling (R1.4): these ids are decision categories, not dispatchable
 * commands; `reason` carries the actionable payload. When R1.5 `start`/`control`
 * land, map fix_ci/review_prs to real `osstack start`/`control` invocations.
 */
export function deriveOwnerDecisions(brief: DailyBrief): { command: string; reason: string }[] {
  const decisions: { command: string; reason: string }[] = [];

  for (const g of brief.github) {
    if (FAILING_CI.has(repoCiStatus(g))) {
      decisions.push({
        command: "repo.fix_ci",
        reason: `${g.repo_id}: latest CI is ${repoCiStatus(g)} — investigate before shipping`,
      });
    }
  }
  for (const g of brief.github) {
    const openPrs = g.pull_requests.filter((pr) => !pr.isDraft);
    if (openPrs.length > 0) {
      decisions.push({
        command: "repo.review_prs",
        reason: `${g.repo_id}: ${openPrs.length} open PR(s) awaiting review`,
      });
    }
  }
  for (const rec of brief.portfolio.recommendations) {
    decisions.push({ command: "portfolio.raise_maturity", reason: rec });
  }

  return decisions.slice(0, 3);
}

// ── Protocol result ──────────────────────────────────────────────────────────

/** Assemble the strict AgentCommandResult (validated by the protocol schema in tests). */
export function buildDailyResult(
  brief: DailyBrief,
  briefPath: string,
  entries: RepoRegistryEntry[],
): AgentCommandResult {
  const pathById = new Map(entries.map((e) => [e.repo_id, e.path]));
  const evidence_refs: NonNullable<AgentCommandResult["evidence_refs"]> = [
    { kind: "report", ref: briefPath },
  ];
  for (const g of brief.github) {
    evidence_refs.push({
      kind: "external",
      ref: g.remote !== undefined ? `https://github.com/${g.remote}` : (pathById.get(g.repo_id) ?? g.repo_id),
    });
  }

  const next_actions = deriveOwnerDecisions(brief);

  const result: AgentCommandResult = {
    protocol_version: PROTOCOL_VERSION,
    status: "ok",
    result: brief as unknown as Record<string, unknown>,
    evidence_refs,
    ...(next_actions.length > 0 ? { next_actions } : {}),
  };
  return result;
}

// ── Markdown render ──────────────────────────────────────────────────────────

export function renderDailyMarkdown(brief: DailyBrief): string {
  const githubById = new Map(brief.github.map((g) => [g.repo_id, g]));
  const lines: string[] = [];
  lines.push(`# Portfolio Daily Brief — ${brief.date}`, "");
  lines.push("## Summary");
  lines.push(`- generated_at: ${brief.generated_at}`);
  lines.push(
    `- repos: ${brief.portfolio.enabled_repo_count} enabled / ${brief.portfolio.repo_count}`,
  );
  lines.push(`- average closed-loop level: ${brief.portfolio.average_closed_loop_level}`);
  if (brief.warnings.length > 0) lines.push(`- warnings: ${brief.warnings.length}`);
  lines.push("");

  lines.push("## Repos");
  if (brief.portfolio.repos.length === 0) {
    lines.push("- No repos registered.");
  }
  for (const repo of brief.portfolio.repos) {
    const g = githubById.get(repo.repo_id);
    lines.push(`### ${repo.name} [${repo.role}] L${repo.closed_loop_level}${repo.exists ? "" : " (missing)"}`);
    if (g?.warning !== undefined) {
      lines.push(`- github: ${g.warning}`);
    } else if (g !== undefined) {
      const openPrs = g.pull_requests.length;
      lines.push(`- open PRs: ${openPrs}${openPrs > 0 ? ` (#${g.pull_requests.map((p) => p.number).join(", #")})` : ""}`);
      lines.push(`- CI: ${repoCiStatus(g)}`);
      lines.push(
        g.latest_release !== undefined
          ? `- latest release: ${g.latest_release.tagName} (${g.latest_release.publishedAt})`
          : "- latest release: none",
      );
    }
  }
  lines.push("");

  if (brief.stack !== undefined) {
    lines.push("## Stack board");
    lines.push(`- board "${brief.stack.board}": ${brief.stack.total} card(s)`);
    for (const column of brief.stack.columns) lines.push(`  - ${column.name}: ${column.count}`);
    lines.push("");
  }

  lines.push(
    brief.delta.previous_brief_date !== undefined
      ? `## Delta since ${brief.delta.previous_brief_date}`
      : "## Delta",
  );
  if (brief.delta.is_first_run) {
    lines.push("- First run — no previous brief to diff against.");
  } else {
    lines.push(
      brief.delta.new_prs.length > 0
        ? `- New PRs: ${brief.delta.new_prs.map((p) => `${p.repo_id}#${p.number}`).join(", ")}`
        : "- New PRs: none",
    );
    lines.push(
      brief.delta.ci_flips.length > 0
        ? `- CI flips: ${brief.delta.ci_flips.map((c) => `${c.repo_id} ${c.from}→${c.to}`).join(", ")}`
        : "- CI flips: none",
    );
    lines.push(
      brief.delta.maturity_changes.length > 0
        ? `- Maturity changes: ${brief.delta.maturity_changes.map((m) => `${m.repo_id} L${m.from}→L${m.to}`).join(", ")}`
        : "- Maturity changes: none",
    );
  }
  lines.push("");

  const decisions = deriveOwnerDecisions(brief);
  lines.push("## Owner decisions");
  if (decisions.length === 0) {
    lines.push("- None — portfolio looks healthy.");
  } else {
    decisions.forEach((d, i) => {
      lines.push(`${i + 1}. [${d.command}] ${d.reason}`);
    });
  }
  return `${lines.join("\n")}\n`;
}
