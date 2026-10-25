// `osstack daily` — a read-only portfolio brief and the first Agent Command
// Protocol dogfood surface (R1.4). It composes existing kernel capability:
//   1. Scan   — the supervisor portfolio maturity report over `.osstack/repos.json`.
//   2. GitHub — the read-only `@osstack/github` portfolio-status adapter (PRs/CI/release).
//   3. Stack  — the existing kanban "stack" board summary, when any cards exist.
//   4. Probe  — current open obligations, aging, and required-item completion.
//   5. Delta  — diff against the previous brief (new PRs / CI flips / maturity changes).
//   6. Render — Markdown for humans by default; `--json` emits a protocol
//               AgentCommandResult (status ok, brief in `result`, per-repo
//               evidence_refs, ≤3 owner decisions in next_actions).
//
// Read-only: the ONLY thing it writes is the dated brief JSON under
// $OSSTACK_HOME/daily-briefs/ (delta substrate). No apply, no execution.

import { readDailyAttention, renderDailyAttention, type DailyAttentionReader, type DailyAttentionSummary } from "./daily-attention.js";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { KanbanRepository, countOpenDependencyObligationsV2, getBoard, queryKnowledgeHygieneTrendV2, queryProbePortfolioSummary, type ProbePortfolioSummaryV1 } from "@osstack/core";
import { guardedOpenDb as openDb } from "./guarded-open-db.js";
import {
  fetchPortfolioGithubStatus,
  type CommandRunner,
  type RepoGithubStatus,
} from "@osstack/github";
import { PROTOCOL_VERSION } from "@osstack/protocol";
import type { AgentCommandResult } from "@osstack/protocol";
import {
  buildPortfolioReport,
  attachKnowledgeHygieneSummaries,
  readRepoRegistry,
  scanRepo,
  scanPortfolioKnowledgeHygiene,
  type PortfolioReport,
  type RepoHealth,
  type RepoRegistryEntry,
  type StructuredRecommendation,
} from "@osstack/supervisor";
import { osstackHome } from "./paths.js";
import { shQuote } from "./start-control-command.js";
import { hasFlag, resolveRegistryPath } from "./supervisor-cli-support.js";
import {
  createAutonomyReliabilityReport,
  type AutonomyReliabilityReport,
} from "./autonomy-scorecard.js";

export interface DailyCliDeps {
  attentionReader?: DailyAttentionReader;
  signal?: AbortSignal;
  /** Injectable command runner for the GitHub adapter (offline in tests). */
  runner?: CommandRunner;
  /** Clock override (tests pin the ISO date + generated_at). */
  now?: () => Date;
  out?: (line: string) => void;
}

/** Inputs to the reusable brief core (`runDailyBrief`). */
export interface RunDailyBriefDeps {
  attentionReader?: DailyAttentionReader;
  signal?: AbortSignal;
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

/**
 * A concrete, paste-ready invocation for an owner decision (R2.4). Mirrors
 * R1.5's `deliver_command` / `deliver_args` split:
 *   - `command`: the shell-safe printable line — every interpolated value is
 *     `shQuote`'d (the ONE audited quoting helper, reused from start/control),
 *     so hostile CI-status / goal / slug text cannot execute on paste.
 *   - `argv`: the raw args array for programmatic spawn (never re-parse the
 *     shell string). `argv[0]` is the PROGRAM (`osstack` | `gh`) so the payload
 *     is self-describing across the multiple binaries `daily` dispatches to
 *     (deliberate divergence from `deliver_args`, whose program is implicitly
 *     `osstack`; see the `deriveOwnerDecisions` docstring).
 */
export interface RunnableInvocation {
  command: string;
  argv: string[];
}

/** An owner decision plus its dispatchable invocation (R2.4). */
export interface OwnerDecision {
  /** Stable protocol `CommandName` category id (advisory; unchanged by R2.4). */
  command: string;
  /** Human-facing decision text. */
  reason: string;
  /** The REAL runnable invocation the owner can dispatch. */
  run: RunnableInvocation;
}

export interface DailyBrief {
  generated_at: string;
  date: string;
  portfolio: PortfolioReport;
  github: RepoGithubStatus[];
  stack?: StackBoardSummary;
  probe?: ProbePortfolioSummaryV1;
  dependency_obligations?: {
    registry_scope: string;
    open_count: number;
  };
  delta: DailyDelta;
  /**
   * ≤3 owner decisions with dispatchable `run` payloads (R2.4). Optional
   * because pre-R2.4 briefs on disk lack the field — always present on a
   * freshly built brief, but readers of a PREVIOUS brief must not assume it.
   */
  owner_decisions?: OwnerDecision[];
  autonomy?: AutonomyReliabilityReport;
  attention?: DailyAttentionSummary;
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
  const hygieneHistory = readPortfolioKnowledgeHygieneHistory(
    enabled,
    now.getTime(),
  );
  const hygieneScans = await scanPortfolioKnowledgeHygiene(enabled, {
    now: () => now,
    history: async (repoId) => hygieneHistory.byRepo.get(repoId) ?? {
      recurring_count: 0,
    },
  });
  const portfolio = buildPortfolioReport(
    attachKnowledgeHygieneSummaries(healths, hygieneScans),
    now.toISOString(),
  );

  // 2. GitHub read adapter (degrades per-repo, never throws).
  const github = await fetchPortfolioGithubStatus(
    enabled.map((entry) => ({ repo_id: entry.repo_id, path: entry.path })),
    deps.runner,
  );

  // 3. Stack board summary — included only when the board actually has cards.
  const { summary: stack, warning: stackWarning } = readStackBoardSummary();
  const { summary: probe, warning: probeWarning } =
    readProbePortfolioSummary(enabled, now.getTime());
  const { summary: dependencyObligations, warning: dependencyWarning } =
    await readDependencyObligationSummary(deps.registryPath);
  const { summary: autonomy, warning: autonomyWarning } =
    readAutonomyReliability(now);

  const attention = await readDailyAttention(enabled, { nowMs: (deps.now?.() ?? new Date()).getTime(),
    ...(deps.attentionReader === undefined ? {} : { reader: deps.attentionReader }),
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
  });

  const warnings = github.filter((g) => g.warning !== undefined).map((g) => `${g.repo_id}: ${g.warning}`);
  if (stackWarning !== undefined) warnings.push(stackWarning);
  if (probeWarning !== undefined) warnings.push(probeWarning);
  if (dependencyWarning !== undefined) warnings.push(dependencyWarning);
  if (autonomyWarning !== undefined) warnings.push(autonomyWarning);
  if (hygieneHistory.warning !== undefined) {
    warnings.push(hygieneHistory.warning);
  }
  warnings.push(...knowledgeHygieneWarnings(portfolio));
  const incompleteAttention = attention.repos.filter(repo => repo.status !== "available").length + attention.omitted_repos;
  if (incompleteAttention > 0) warnings.push(`Attention supervision incomplete for ${incompleteAttention} repository entries; see per-repository coverage.`);

  // 4. Delta against the most recent previous brief.
  const briefsDir = join(osstackHome(), "daily-briefs");
  const previous = await readPreviousBrief(briefsDir, date);
  const delta = computeDelta(previous, { portfolio, github });

  const brief: DailyBrief = {
    generated_at: now.toISOString(),
    date,
    attention,
    portfolio,
    github,
    ...(stack !== undefined ? { stack } : {}),
    ...(probe !== undefined ? { probe } : {}),
    ...(dependencyObligations !== undefined
      ? { dependency_obligations: dependencyObligations }
      : {}),
    ...(autonomy === undefined ? {} : { autonomy }),
    delta,
    // Computed from portfolio + github below, then stored so the dispatchable
    // `run` payloads ride in `result` (= the brief) and are persisted verbatim.
    owner_decisions: [],
    warnings,
  };
  brief.owner_decisions = deriveOwnerDecisions(brief);

  // Persist the brief (the only write this command performs).
  const briefPath = join(briefsDir, `${date}.json`);
  await mkdir(briefsDir, { recursive: true });
  await writeFile(briefPath, `${JSON.stringify(brief, null, 2)}\n`, "utf8");

  return { brief, briefPath, result: buildDailyResult(brief, briefPath, enabled), entries: enabled };
}

function readAutonomyReliability(now: Date): {
  summary?: AutonomyReliabilityReport;
  warning?: string;
} {
  const dbPath = join(osstackHome(), "state.db");
  if (!existsSync(dbPath)) return {};
  try {
    const database = openDb({ path: dbPath, readwrite: false });
    try {
      return {
        summary: createAutonomyReliabilityReport(database, {
          now: () => now,
        }),
      };
    } finally {
      database.close();
    }
  } catch (error) {
    return {
      warning: `autonomy reliability unavailable (${dbPath}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}

async function readDependencyObligationSummary(
  registryPath: string,
): Promise<{
  summary?: { registry_scope: string; open_count: number };
  warning?: string;
}> {
  const dbPath = join(osstackHome(), "state.db");
  if (!existsSync(dbPath)) return {};
  try {
    const canonical = await realpath(registryPath);
    const registryScope = createHash("sha256").update(canonical).digest("hex");
    const database = openDb({ path: dbPath, readwrite: false });
    try {
      const openCount = countOpenDependencyObligationsV2(database, registryScope);
      return openCount === 0
        ? {}
        : { summary: { registry_scope: registryScope, open_count: openCount } };
    } finally {
      database.close();
    }
  } catch (error) {
    return {
      warning: `dependency obligations unavailable (${dbPath}): ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function handleDailyCommand(args: string[], deps: DailyCliDeps = {}): Promise<number> {
  const out = deps.out ?? console.log;

  // Thin wrapper: parse flags → runDailyBrief → render. All composition lives
  // in runDailyBrief so the daemon and the CLI produce identical briefs.
  const run = await runDailyBrief({
    registryPath: resolveRegistryPath(args),
    ...(deps.attentionReader === undefined ? {} : { attentionReader: deps.attentionReader }),
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
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
    const db = openDb({ path: dbPath, readwrite: false });
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

/** Probe state is optional context: no DB/session preserves the old brief. */
function readProbePortfolioSummary(
  entries: readonly RepoRegistryEntry[],
  asOfMs: number,
): { summary?: ProbePortfolioSummaryV1; warning?: string } {
  const dbPath = join(osstackHome(), "state.db");
  if (!existsSync(dbPath)) return {};
  try {
    const db = openDb({ path: dbPath, readwrite: false });
    try {
      const summary = queryProbePortfolioSummary(db, {
        as_of_ms: asOfMs,
        repo_ids: entries.map((entry) => entry.repo_id),
      });
      return summary.repos.length === 0 ? {} : { summary };
    } finally {
      db.close();
    }
  } catch (error) {
    return {
      warning: `probe portfolio unavailable (${dbPath}): ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

interface PortfolioKnowledgeHygieneHistory {
  byRepo: Map<string, {
    recurring_count: number;
    oldest_open_days?: number;
  }>;
  warning?: string;
}

/** Read-only from the caller's perspective: no reports are recorded here. */
function readPortfolioKnowledgeHygieneHistory(
  entries: readonly RepoRegistryEntry[],
  asOf: number,
): PortfolioKnowledgeHygieneHistory {
  const byRepo = new Map<string, {
    recurring_count: number;
    oldest_open_days?: number;
  }>();
  const dbPath = join(osstackHome(), "state.db");
  if (!existsSync(dbPath)) return { byRepo };
  try {
    const db = openDb({ path: dbPath, readwrite: false });
    try {
      for (const entry of entries) {
        const trend = queryKnowledgeHygieneTrendV2(db, entry.repo_id, {
          as_of: asOf,
        });
        byRepo.set(entry.repo_id, {
          recurring_count: trend.recurrence.warning,
          ...(trend.open.oldest_age_days === null
            ? {}
            : { oldest_open_days: trend.open.oldest_age_days }),
        });
      }
    } finally {
      db.close();
    }
    return { byRepo };
  } catch (error) {
    return {
      byRepo,
      warning: `knowledge hygiene history unavailable (${dbPath}): ${error instanceof Error ? error.message : String(error)}`,
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
// The missing-LOOP.md dispatch reads `structured_recommendations` from the
// portfolio report (kind === "add_loop_doc" + a repo_id) — no free-text wording
// coupling, no `<name>: ` prefix parsing, and no display-name ambiguity.

/**
 * Derive at most three owner decisions, prioritized: failing CI first, then
 * repos with open non-draft PRs to review, then portfolio maturity gaps. The
 * `command` is a stable `<service>.<action>` protocol identifier (advisory — the
 * daily command never executes it), the `reason` is the human-facing decision,
 * and `run` is the REAL invocation the owner can dispatch (R2.4).
 *
 * CTO ruling (R1.4) — FULFILLED by R2.4 now that R1.5 (`start`/`control`) has
 * landed. The `command` ids stay decision CATEGORIES (unchanged, so no consumer
 * breaks); the dispatchable payload rides alongside in `run { command, argv }`
 * (structured data in `result`, mirroring R1.5's `deliver_command`/`deliver_args`
 * — NOT in the strict `NextAction` protocol envelope). Mapping implemented:
 *
 *   repo.fix_ci          → `osstack start "fix failing CI on <repo_id>: latest
 *                           run is <status>" --repo-id <repo_id>` (R1.5 surface).
 *   repo.review_prs      → human review, not an osstack execution: the concrete
 *                          `gh pr list --repo <slug> --state open` when the repo
 *                          has a resolved GitHub remote, else the local repo path.
 *   portfolio.raise_maturity → `osstack supervise init-loop-doc --repo <repo_id>`
 *                          ONLY when the structured recommendation is an
 *                          `add_loop_doc` kind carrying a `repo_id` (the gap that
 *                          command fixes); every other kind (or a kind without a
 *                          repo_id, e.g. `consolidation`) stays portfolio-level:
 *                          `osstack supervise report`. Because dispatch keys on
 *                          the unique `repo_id` rather than the display name,
 *                          duplicate-named repos are no longer ambiguous — they
 *                          now dispatch (an improvement over the R2.4 name-match).
 *
 * ALL interpolated values are `shQuote`'d via the shared start/control helper —
 * CI status comes from `gh` output and repo ids/slugs are treated as untrusted
 * for quoting, so nothing in a `run.command` can execute on paste.
 */
export function deriveOwnerDecisions(brief: DailyBrief): OwnerDecision[] {
  const decisions: OwnerDecision[] = autonomyOwnerDecisions(brief);
  const pathById = new Map(brief.portfolio.repos.map((r) => [r.repo_id, r.path]));

  for (const g of brief.github) {
    const status = repoCiStatus(g);
    if (FAILING_CI.has(status)) {
      const goal = `fix failing CI on ${g.repo_id}: latest run is ${status}`;
      decisions.push({
        command: "repo.fix_ci",
        reason: `${g.repo_id}: latest CI is ${status} — investigate before shipping`,
        run: {
          command: `osstack start ${shQuote(goal)} --repo-id ${shQuote(g.repo_id)}`,
          argv: ["osstack", "start", goal, "--repo-id", g.repo_id],
        },
      });
    }
  }
  const seenScopes = new Set<string>();
  for (const repo of brief.attention?.repos ?? []) {
    for (const scope of repo.snapshot?.scopes ?? []) {
      if (seenScopes.has(scope.scope_id) || !(scope.human_waits || scope.uncertain_answers || scope.missing_source_items)) continue;
      seenScopes.add(scope.scope_id);
      // Viewing evidence is the only suggested operation; stale facts cannot grant authority.
      const subcommand = repo.status === "available" && scope.coverage === "covered" && scope.human_waits > 0 && scope.open_items > 0 ? "inbox" : "inventory";
      const argv = ["osstack", "attention", subcommand, "--scope", scope.scope_id];
      decisions.push({ command: `attention.${subcommand}`,
        reason: `Review scope ${scope.scope_id}: human waits ${scope.human_waits}, uncertain answers ${scope.uncertain_answers}, source missing ${scope.missing_source_items}; observation ${repo.status}`,
        run: { command: argv.map(shQuote).join(" "), argv },
      });
    }
  }
  for (const repo of brief.portfolio.repos) {
    const reasons = knowledgeHygieneIssues(repo);
    if (reasons.length === 0) continue;
    const argv = [
      "osstack",
      "neat",
      "check",
      "--repo",
      repo.path,
      "--all",
      "--fail-on",
      "warning",
    ];
    decisions.push({
      command: "knowledge_hygiene.check",
      reason: `${repo.repo_id}: knowledge hygiene ${reasons.join(", ")}`,
      run: {
        command: `osstack neat check --repo ${shQuote(repo.path)} --all --fail-on warning`,
        argv,
      },
    });
  }
  for (const g of brief.github) {
    const openPrs = g.pull_requests.filter((pr) => !pr.isDraft);
    if (openPrs.length > 0) {
      decisions.push({
        command: "repo.review_prs",
        reason: `${g.repo_id}: ${openPrs.length} open PR(s) awaiting review`,
        run: reviewPrsRun(g, pathById.get(g.repo_id)),
      });
    }
  }
  // Prefer the structured list (dispatch on kind + repo_id). Fresh briefs always
  // carry it; a previous brief read from disk that predates the field simply has
  // no raise_maturity decisions here (deriveOwnerDecisions only runs on the fresh
  // brief in practice, so this fallback is defensive).
  for (const rec of brief.portfolio.structured_recommendations ?? []) {
    decisions.push({
      command: "portfolio.raise_maturity",
      reason: rec.text,
      run: raiseMaturityRun(rec),
    });
  }

  return decisions.slice(0, 3);
}

function autonomyOwnerDecisions(brief: DailyBrief): OwnerDecision[] {
  const attention = brief.autonomy?.attention;
  if (attention === undefined) return [];
  const decisions: OwnerDecision[] = [];
  const seenRuns = new Set<string>();
  const addRun = (
    command: string,
    reason: string,
    runId: string,
  ): void => {
    if (seenRuns.has(runId)) return;
    seenRuns.add(runId);
    decisions.push({
      command,
      reason,
      run: {
        command: `osstack autonomy status ${shQuote(runId)} --json`,
        argv: ["osstack", "autonomy", "status", runId, "--json"],
      },
    });
  };
  for (const item of attention.rollback_failed) {
    addRun(
      "autonomy.rollback_failed",
      `${item.repo_id}: rollback failed in ${item.run_id}`,
      item.run_id,
    );
  }
  for (const freeze of attention.production_frozen) {
    decisions.push({
      command: "autonomy.production_frozen",
      reason: `${freeze.repo_id}: production frozen — ${freeze.reason}`,
      run: {
        command:
          `osstack autonomy freeze request ${shQuote(freeze.repo_id)} --json`,
        argv: [
          "osstack",
          "autonomy",
          "freeze",
          "request",
          freeze.repo_id,
          "--json",
        ],
      },
    });
  }
  for (const item of attention.delivery_evidence_failed) {
    addRun(
      "autonomy.delivery_evidence_failed",
      `${item.repo_id}: proof integrity failed in ${item.run_id}`,
      item.run_id,
    );
  }
  for (const item of attention.awaiting_approval) {
    addRun(
      "autonomy.awaiting_approval",
      `${item.repo_id}: signed Owner decision required for ${item.run_id}`,
      item.run_id,
    );
  }
  for (const item of attention.escalated) {
    addRun(
      "autonomy.escalated",
      `${item.repo_id}: ${item.run_id} escalated`,
      item.run_id,
    );
  }
  for (const item of attention.blocked_delivery) {
    addRun(
      "autonomy.blocked_delivery",
      `${item.repo_id}: ${item.run_id} is waiting for external delivery recovery`,
      item.run_id,
    );
  }
  if (
    attention.adapter_unavailable.length > 0
    && decisions.length < 3
  ) {
    decisions.push({
      command: "autonomy.adapter_unavailable",
      reason:
        `${attention.adapter_unavailable.length} autonomy run(s) require adapter recovery`,
      run: {
        command: "osstack autonomy health --json",
        argv: ["osstack", "autonomy", "health", "--json"],
      },
    });
  }
  return decisions;
}

function knowledgeHygieneWarnings(portfolio: PortfolioReport): string[] {
  return portfolio.repos.flatMap((repo) => {
    const issues = knowledgeHygieneIssues(repo);
    return issues.length === 0
      ? []
      : [`${repo.repo_id}: knowledge hygiene ${issues.join(", ")}`];
  });
}

function knowledgeHygieneIssues(
  repo: PortfolioReport["repos"][number],
): string[] {
  const scanFailed = repo.findings.some((finding) =>
    finding.startsWith("knowledge hygiene scan failed:")
  );
  const hygiene = repo.hygiene;
  if (hygiene === undefined) return scanFailed ? ["scan failed"] : [];
  return [
    ...(!hygiene.complete ? ["scan incomplete"] : []),
    ...(hygiene.health_claim === "assessment_incomplete"
      ? ["assessment incomplete"]
      : []),
    ...(hygiene.error_count > 0 ? [`${hygiene.error_count} open error(s)`] : []),
    ...(hygiene.warning_count > 0 && hygiene.recurring_count > 0
      ? [`${hygiene.recurring_count} recurring warning(s)`]
      : []),
  ];
}

/**
 * review_prs is a human action, so it maps to a read-only `gh pr list` for the
 * resolved remote. The no-remote branch is defensive: PRs only populate when a
 * GitHub slug resolved, so in practice `g.remote` is always set here — but if it
 * ever is not, we point the human at the local repo path rather than emit a
 * broken `gh` line.
 */
function reviewPrsRun(g: RepoGithubStatus, repoPath: string | undefined): RunnableInvocation {
  if (g.remote !== undefined) {
    return {
      command: `gh pr list --repo ${shQuote(g.remote)} --state open`,
      argv: ["gh", "pr", "list", "--repo", g.remote, "--state", "open"],
    };
  }
  const target = repoPath ?? g.repo_id;
  return { command: shQuote(target), argv: [target] };
}

/**
 * portfolio.raise_maturity → `init-loop-doc` ONLY for an `add_loop_doc`
 * structured recommendation that carries a `repo_id` (the gap that command
 * remedies). The `repo_id` is registry-unique, so duplicate display names are no
 * longer ambiguous. Every other kind — or an `add_loop_doc` without a repo_id —
 * stays portfolio-level `supervise report`.
 */
function raiseMaturityRun(rec: StructuredRecommendation): RunnableInvocation {
  if (rec.kind === "add_loop_doc" && rec.repo_id !== undefined) {
    const repoId = rec.repo_id;
    return {
      command: `osstack supervise init-loop-doc --repo ${shQuote(repoId)}`,
      argv: ["osstack", "supervise", "init-loop-doc", "--repo", repoId],
    };
  }
  return { command: "osstack supervise report", argv: ["osstack", "supervise", "report"] };
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

  // The strict `NextAction` envelope stays { command, reason } (A-003) — the
  // dispatchable `run` payloads ride in `result` (= the brief), never in the
  // protocol envelope, so no NextAction consumer breaks (R2.4 non-goal).
  const next_actions = (brief.owner_decisions ?? []).map((d) => ({ command: d.command, reason: d.reason }));

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
    const hygiene = repo.hygiene;
    const hygieneIssues = knowledgeHygieneIssues(repo);
    if (hygiene !== undefined && hygieneIssues.length > 0) {
      lines.push(
        `- knowledge hygiene: ${hygiene.complete ? "complete" : "incomplete"}; ${hygiene.error_count} error; ${hygiene.warning_count} warning; ${hygiene.recurring_count} recurring${hygiene.oldest_open_days === undefined ? "" : `; oldest ${hygiene.oldest_open_days}d`}`,
      );
    } else if (hygieneIssues.length > 0) {
      lines.push(`- knowledge hygiene: ${hygieneIssues.join(", ")}`);
    }
  }
  lines.push("");

  if (brief.attention !== undefined) lines.push(...renderDailyAttention(brief.attention));

  if (brief.stack !== undefined) {
    lines.push("## Stack board");
    lines.push(`- board "${brief.stack.board}": ${brief.stack.total} card(s)`);
    for (const column of brief.stack.columns) lines.push(`  - ${column.name}: ${column.count}`);
    lines.push("");
  }

  if (brief.probe !== undefined) {
    lines.push("## Probe readiness");
    for (const repo of brief.probe.repos) {
      lines.push(
        `- ${repo.repo_id}: ${repo.in_progress_session_count} in progress / ${repo.session_count} total session(s)`,
      );
      const openAge = repo.oldest_open_age_days === null
        ? "oldest n/a"
        : `oldest ${repo.oldest_open_age_days}d`;
      lines.push(
        `  - open high ${repo.open_by_severity.high}, medium ${repo.open_by_severity.medium}, low ${repo.open_by_severity.low}; ${openAge}`,
      );
      lines.push(
        `  - completion ${repo.completion_percent}% (${repo.required_disposed}/${repo.required_total} required disposed); deferred due ${repo.deferred_due}; waivers active ${repo.waived_active}, expired ${repo.waived_expired}`,
      );
    }
    lines.push("");
  }

  if (brief.dependency_obligations !== undefined) {
    lines.push("## Dependency obligations");
    lines.push(`- unread: ${brief.dependency_obligations.open_count}`);
    lines.push("");
  }

  if (brief.autonomy !== undefined) {
    const weekly = brief.autonomy.weekly.metrics;
    const attention = brief.autonomy.attention;
    lines.push("## Guarded autonomy reliability");
    lines.push(
      `- unattended completion: ${weekly.unattended_completion_rate.numerator}/${weekly.unattended_completion_rate.denominator} (${Math.round(weekly.unattended_completion_rate.value * 100)}%)`,
    );
    lines.push(
      `- avoidable human intervention: ${weekly.human_intervention_rate.numerator}/${weekly.human_intervention_rate.denominator} (${Math.round(weekly.human_intervention_rate.value * 100)}%)`,
    );
    lines.push(
      `- production deploy success: ${weekly.deploy_success_rate.numerator}/${weekly.deploy_success_rate.denominator}`,
    );
    lines.push(
      `- rollback success: ${weekly.rollback_success_rate.numerator}/${weekly.rollback_success_rate.denominator}`,
    );
    lines.push(
      `- Owner notification outbox: ${brief.autonomy.notification_outbox.pending_count} pending, ${brief.autonomy.notification_outbox.dead_letter_count} dead-letter`,
    );
    lines.push("### Owner attention");
    const attentionLines = [
      ["awaiting_approval", attention.awaiting_approval.length],
      ["escalated", attention.escalated.length],
      ["blocked_delivery", attention.blocked_delivery.length],
      [
        "delivery_evidence_failed",
        attention.delivery_evidence_failed.length,
      ],
      ["production_frozen", attention.production_frozen.length],
      ["rollback_failed", attention.rollback_failed.length],
      ["adapter_unavailable", attention.adapter_unavailable.length],
    ] as const;
    const actionable = attentionLines.filter(([, count]) => count > 0);
    if (actionable.length === 0) lines.push("- None.");
    else {
      for (const [label, count] of actionable) {
        lines.push(`- ${label}: ${count}`);
      }
    }
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

  lines.push("## Owner decisions");
  const ownerDecisions = brief.owner_decisions ?? [];
  if (ownerDecisions.length === 0) {
    const incompleteAttention = brief.attention && (brief.attention.omitted_repos > 0 || brief.attention.repos.some(repo => repo.status !== "available"));
    lines.push(incompleteAttention ? "- None suggested — supervision has incomplete coverage." : "- None — portfolio looks healthy.");
  } else {
    ownerDecisions.forEach((d, i) => {
      lines.push(`${i + 1}. [${d.command}] ${d.reason}`);
      // The paste-ready runnable line under each decision (R2.4).
      lines.push(`   run: ${d.run.command}`);
    });
  }
  return `${lines.join("\n")}\n`;
}
