// Repo scanner — inspects a registered repo's filesystem for closed-loop
// maturity signals. Read-only and deterministic: it stats files and runs a
// single non-mutating `git status`. Never throws on a missing repo or missing
// git; it records findings instead.

import { execFile } from "node:child_process";
import { access, readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { LoopState } from "@osstack/loop";
import { RepoHealth, type RepoRegistryEntry } from "./types.js";

const execFileAsync = promisify(execFile);

const README_NAMES = ["README.md", "README.zh.md", "README_CN.md", "README_EN.md"];

export async function scanRepo(entry: RepoRegistryEntry): Promise<RepoHealth> {
  const findings: string[] = [];
  const exists = await pathExists(entry.path);

  if (!exists) {
    findings.push(`repo path not found / does not exist: ${entry.path}`);
    return RepoHealth.parse({
      repo_id: entry.repo_id,
      name: entry.name,
      path: entry.path,
      role: entry.role,
      exists: false,
      has_readme: false,
      has_loop_doc: false,
      has_tests: false,
      has_verify_command: entry.verify_commands.length > 0,
      closed_loop_level: 0,
      findings,
    });
  }

  const gitCleanState = await checkGitClean(entry.path, findings);
  const hasReadme = await anyExists(entry.path, README_NAMES);
  const hasLoopDoc = await fileExists(join(entry.path, entry.loop_doc_path));
  const hasTests = await detectTests(entry.path);
  const hasVerifyCommand = entry.verify_commands.length > 0;
  const latestLoopSuccessRate = await readLoopSuccessRate(entry.path);

  const hasLoopArtifacts = await detectLoopArtifacts(entry.path, latestLoopSuccessRate !== undefined);
  const hasFeedbackOrLessons = await detectFeedbackOrLessons(entry.path);
  const hasProposals = await detectMarker(entry.path, [
    join(".osstack", "improvement-proposals.json"),
    "improvement-proposals",
  ]);
  const hasEvaluator = await detectMarker(entry.path, [
    join(".osstack", "evaluator-epochs.json"),
    join(".osstack", "meta-eval.json"),
    "meta-eval",
  ]);
  const hasPortfolioMarker = await detectMarker(entry.path, [
    join(".osstack", "portfolio.json"),
    "PORTFOLIO.md",
  ]);

  const closedLoopLevel = computeClosedLoopLevel({
    hasReadme,
    hasTests,
    hasVerifyCommand,
    hasLoopArtifacts,
    hasFeedbackOrLessons,
    hasProposals,
    hasEvaluator,
    hasPortfolioMarker,
  });

  if (!hasReadme) findings.push("missing README");
  if (!hasLoopDoc) findings.push(`missing ${entry.loop_doc_path}`);
  if (!hasTests && !hasVerifyCommand) findings.push("no tests and no verify command (not traceable)");

  return RepoHealth.parse({
    repo_id: entry.repo_id,
    name: entry.name,
    path: entry.path,
    role: entry.role,
    exists: true,
    ...(gitCleanState !== undefined ? { git_clean: gitCleanState } : {}),
    has_readme: hasReadme,
    has_loop_doc: hasLoopDoc,
    has_tests: hasTests,
    has_verify_command: hasVerifyCommand,
    ...(latestLoopSuccessRate !== undefined ? { latest_loop_success_rate: latestLoopSuccessRate } : {}),
    closed_loop_level: closedLoopLevel,
    findings,
  });
}

// ── Closed-loop level ladder ───────────────────────────────────────────────
//
// Conservative and contiguous: a repo cannot reach level N without the marker
// for level N and every level below it. We deliberately under-score rather
// than over-score.

interface LevelSignals {
  hasReadme: boolean;
  hasTests: boolean;
  hasVerifyCommand: boolean;
  hasLoopArtifacts: boolean;
  hasFeedbackOrLessons: boolean;
  hasProposals: boolean;
  hasEvaluator: boolean;
  hasPortfolioMarker: boolean;
}

function computeClosedLoopLevel(s: LevelSignals): number {
  // L0: deliverable only — nothing traceable.
  if (!s.hasTests && !s.hasVerifyCommand) return 0;
  let level = 1; // L1: traceable loop (tests or verify command)
  if (!s.hasLoopArtifacts) return level;
  level = 2; // L2: loop artifacts (LOOP-STATE / proof / scorecard)
  if (!s.hasFeedbackOrLessons) return level;
  level = 3; // L3: failure assetization (feedback assets / lessons)
  if (!s.hasProposals) return level;
  level = 4; // L4: improvement proposals
  if (!s.hasEvaluator) return level;
  level = 5; // L5: evaluator epochs / meta-eval
  if (s.hasPortfolioMarker) level = 6; // L6: portfolio recursive optimization
  return level;
}

// ── Detection helpers ──────────────────────────────────────────────────────

async function checkGitClean(repoPath: string, findings: string[]): Promise<boolean | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoPath, "status", "--porcelain"], {
      timeout: 10_000,
    });
    return stdout.trim() === "";
  } catch {
    findings.push("git status unavailable (not a git repo or git missing)");
    return undefined;
  }
}

async function detectTests(repoPath: string): Promise<boolean> {
  const pkg = await readJson(join(repoPath, "package.json"));
  if (pkg !== undefined) {
    const scripts = (pkg as { scripts?: Record<string, unknown> }).scripts;
    if (scripts !== undefined && typeof scripts["test"] === "string") return true;
  }
  const pyproject = await readTextSafe(join(repoPath, "pyproject.toml"));
  if (pyproject !== undefined && /pytest/i.test(pyproject)) return true;
  return await dirExists(join(repoPath, "tests"));
}

async function readLoopSuccessRate(repoPath: string): Promise<number | undefined> {
  const json = await readJson(join(repoPath, "LOOP-STATE.json"));
  if (json === undefined) return undefined;
  const parsed = LoopState.safeParse(json);
  const tasks = parsed.success
    ? parsed.data.completed_tasks
    : Array.isArray((json as { completed_tasks?: unknown }).completed_tasks)
      ? ((json as { completed_tasks: Array<{ outcome?: unknown }> }).completed_tasks)
      : [];
  if (tasks.length === 0) return undefined;
  const successes = tasks.filter((task) => (task as { outcome?: unknown }).outcome === "success").length;
  return successes / tasks.length;
}

async function detectLoopArtifacts(repoPath: string, hasLoopState: boolean): Promise<boolean> {
  if (hasLoopState) return true;
  if (await fileExists(join(repoPath, "LOOP-STATE.json"))) return true;
  return await hasChildMatching(join(repoPath, "release"), /osstack-(scorecard|proof)/)
    || await hasChildMatching(join(repoPath, "reports"), /osstack-report/);
}

async function detectFeedbackOrLessons(repoPath: string): Promise<boolean> {
  return await dirExists(join(repoPath, "loop-lessons"))
    || await fileExists(join(repoPath, ".osstack", "feedback-assets.json"))
    || await fileExists(join(repoPath, "LESSONS.md"));
}

async function detectMarker(repoPath: string, relCandidates: string[]): Promise<boolean> {
  for (const rel of relCandidates) {
    const full = join(repoPath, rel);
    if (await pathExists(full)) return true;
  }
  return false;
}

// ── Filesystem primitives ──────────────────────────────────────────────────

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

async function dirExists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function anyExists(base: string, names: string[]): Promise<boolean> {
  for (const name of names) {
    if (await fileExists(join(base, name))) return true;
  }
  return false;
}

async function hasChildMatching(dir: string, pattern: RegExp): Promise<boolean> {
  try {
    const entries = await readdir(dir);
    return entries.some((entry) => pattern.test(entry));
  } catch {
    return false;
  }
}

async function readTextSafe(p: string): Promise<string | undefined> {
  try {
    return await readFile(p, "utf8");
  } catch {
    return undefined;
  }
}

async function readJson(p: string): Promise<unknown> {
  const text = await readTextSafe(p);
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}
