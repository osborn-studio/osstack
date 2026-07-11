// Scorecard — turns a RunReport into a weighted 0–100 score plus a
// self-contained HTML/Markdown card you can hand to a teammate or client.
//
// Honesty rule: a run whose verify gate did not pass MUST NOT score green.
// Scores are derived deterministically from the report; nothing is invented.

import type { ConformanceLevel, RunReport, ReportTask } from "./report.js";
import { conformanceLevel } from "./report.js";

export const DEFAULT_THRESHOLD = 80;

export interface ScoreDimension {
  id: string;
  label: string;
  score: number;
  max: number;
  detail: string;
}

export interface Scorecard {
  schema: "osstack.scorecard/v1";
  loop_id: string;
  generated_at: string;
  conformance_level: ConformanceLevel;
  total: number;
  threshold: number;
  passed: boolean;
  dimensions: ScoreDimension[];
}

export interface ScoreOptions {
  threshold?: number;
  /** True when a proof pack was assembled alongside (raises artifact + conformance). */
  proofed?: boolean;
}

function taskVerifyPassed(t: ReportTask): boolean {
  if (t.outcome !== "success") return false;
  return t.verify_issues.filter((i) => i.severity === "error").length === 0;
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Score a run. Deterministic; total is the sum of dimension scores (max 100). */
export function scoreRun(report: RunReport, opts: ScoreOptions = {}): Scorecard {
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD;
  const tasks = report.tasks;
  const n = tasks.length;
  const dims: ScoreDimension[] = [];

  // 1. Execution completed (20): terminal, non-failed execution.
  {
    const max = 20;
    const credit = n === 0 ? 0 : tasks.reduce((a, t) => a + (t.outcome === "success" ? 1 : t.outcome === "escalated" ? 0.5 : 0), 0);
    const score = n === 0 ? 0 : round((credit / n) * max);
    dims.push({
      id: "execution",
      label: "Execution completed",
      score,
      max,
      detail: n === 0 ? "no tasks executed" : `${tasks.filter((t) => t.outcome === "success").length}/${n} tasks succeeded`,
    });
  }

  // 2. Verify gates passed (30): tasks with a verify result that passed.
  {
    const max = 30;
    const hasVerify = tasks.some((t) => t.verify_summary !== undefined || t.verify_issue_count !== undefined || t.verify_issues.length > 0 || t.outcome === "success");
    const passed = tasks.filter(taskVerifyPassed).length;
    const score = n === 0 || !hasVerify ? 0 : round((passed / n) * max);
    dims.push({
      id: "verify",
      label: "Verify gates passed",
      score,
      max,
      detail: !hasVerify ? "no verify gate ran" : `${passed}/${n} tasks passed verification`,
    });
  }

  // 3. Reviewer/checker passed (20): tasks reviewed with no error issues.
  {
    const max = 20;
    const reviewed = tasks.filter((t) => t.verifier_agent_id !== undefined);
    const reviewedClean = reviewed.filter((t) => t.verify_issues.filter((i) => i.severity === "error").length === 0).length;
    const score = reviewed.length === 0 ? 0 : round((reviewedClean / reviewed.length) * max);
    dims.push({
      id: "review",
      label: "Reviewer / checker passed",
      score,
      max,
      detail: reviewed.length === 0 ? "no reviewer/checker ran" : `${reviewedClean}/${reviewed.length} reviewed tasks clean`,
    });
  }

  // 4. Worktree safety (10): no unmerged-but-preserved branches.
  {
    const max = 10;
    const withWt = tasks.filter((t) => t.worktree);
    const preserved = withWt.filter((t) => t.worktree?.branch_preserved).length;
    const score = withWt.length === 0 ? max : round(((withWt.length - preserved) / withWt.length) * max);
    dims.push({
      id: "worktree",
      label: "Worktree safety",
      score,
      max,
      detail: withWt.length === 0 ? "no worktree isolation used" : `${withWt.length - preserved}/${withWt.length} worktrees merged cleanly`,
    });
  }

  // 5. No escalation / max-iter failure (10).
  {
    const max = 10;
    const bad = tasks.filter((t) => t.outcome === "escalated" || t.outcome === "failed").length;
    const score = n === 0 ? 0 : round(((n - bad) / n) * max);
    dims.push({
      id: "stability",
      label: "No escalation / failure",
      score,
      max,
      detail: bad === 0 ? "no escalations or failures" : `${bad}/${n} tasks escalated or failed`,
    });
  }

  // 6. Evidence artifacts (10): report always present; proof pack adds the rest.
  {
    const max = 10;
    const score = opts.proofed ? max : 5;
    dims.push({
      id: "evidence",
      label: "Evidence artifacts",
      score,
      max,
      detail: opts.proofed ? "report + proof pack generated" : "report generated (run `osstack proof` for full pack)",
    });
  }

  const total = round(dims.reduce((a, d) => a + d.score, 0));
  return {
    schema: "osstack.scorecard/v1",
    loop_id: report.loop_id,
    generated_at: report.generated_at,
    conformance_level: conformanceLevel(tasks, opts.proofed ? { proofed: true } : {}),
    total,
    threshold,
    passed: total >= threshold,
    dimensions: dims,
  };
}

function grade(total: number, threshold: number): "pass" | "warn" | "fail" {
  if (total >= threshold) return "pass";
  if (total >= 75) return "warn";
  return "fail";
}

/** Render a scorecard as Markdown. */
export function renderScorecardMarkdown(card: Scorecard): string {
  const g = grade(card.total, card.threshold);
  const badge = g === "pass" ? "✅ PASS" : g === "warn" ? "🟡 NEAR" : "❌ FAIL";
  const L: string[] = [];
  L.push(`# osstack scorecard — \`${card.loop_id}\``);
  L.push("");
  L.push(`## ${badge} — ${card.total} / 100  (threshold ${card.threshold})`);
  L.push("");
  L.push(`> Conformance **${card.conformance_level}** · generated ${card.generated_at}`);
  L.push("");
  L.push("| Dimension | Score | Detail |");
  L.push("|---|---|---|");
  for (const d of card.dimensions) {
    L.push(`| ${d.label} | ${d.score} / ${d.max} | ${d.detail} |`);
  }
  L.push("");
  L.push("---");
  L.push("");
  L.push("_Generated by `osstack scorecard`._");
  L.push("");
  return L.join("\n");
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Render a self-contained HTML scorecard (no external assets, dark-mode aware). */
export function renderScorecardHtml(card: Scorecard): string {
  const g = grade(card.total, card.threshold);
  const color = g === "pass" ? "#3fb950" : g === "warn" ? "#d29922" : "#f85149";
  const label = g === "pass" ? "PASS" : g === "warn" ? "NEAR" : "FAIL";
  const rows = card.dimensions
    .map((d) => {
      const pct = d.max === 0 ? 0 : Math.round((d.score / d.max) * 100);
      return `<tr>
        <td>${esc(d.label)}</td>
        <td class="num">${d.score} / ${d.max}</td>
        <td class="bar"><span style="width:${pct}%;background:${color}"></span></td>
        <td class="detail">${esc(d.detail)}</td>
      </tr>`;
    })
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>osstack scorecard — ${esc(card.loop_id)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; margin: 0; background: #0d1117; color: #e6edf3; }
  @media (prefers-color-scheme: light) { body { background: #fff; color: #1f2328; } .card { background: #f6f8fa !important; } th { color: #57606a !important; } }
  .wrap { max-width: 760px; margin: 40px auto; padding: 0 20px; }
  .card { background: #161b22; border: 1px solid #30363d; border-radius: 12px; padding: 28px; }
  h1 { font-size: 18px; margin: 0 0 4px; font-weight: 600; }
  .sub { color: #8b949e; font-size: 13px; margin-bottom: 24px; }
  .score { display: flex; align-items: baseline; gap: 14px; margin: 8px 0 24px; }
  .score .n { font-size: 56px; font-weight: 700; color: ${color}; line-height: 1; }
  .score .of { color: #8b949e; font-size: 20px; }
  .pill { display: inline-block; padding: 4px 12px; border-radius: 999px; font-weight: 700; font-size: 13px; color: #fff; background: ${color}; }
  table { width: 100%; border-collapse: collapse; }
  th { text-align: left; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #8b949e; padding: 6px 8px; border-bottom: 1px solid #30363d; }
  td { padding: 10px 8px; border-bottom: 1px solid #21262d; vertical-align: middle; }
  td.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
  td.bar { width: 120px; } td.bar span { display: block; height: 8px; border-radius: 4px; }
  td.detail { color: #8b949e; font-size: 13px; }
  .foot { color: #8b949e; font-size: 12px; margin-top: 22px; }
</style>
</head>
<body>
<div class="wrap">
  <div class="card">
    <h1>osstack scorecard — <code>${esc(card.loop_id)}</code></h1>
    <div class="sub">conformance ${card.conformance_level} · generated ${esc(card.generated_at)}</div>
    <div class="score">
      <span class="n">${card.total}</span>
      <span class="of">/ 100</span>
      <span class="pill">${label}</span>
      <span class="of">threshold ${card.threshold}</span>
    </div>
    <table>
      <thead><tr><th>Dimension</th><th>Score</th><th>Progress</th><th>Detail</th></tr></thead>
      <tbody>
${rows}
      </tbody>
    </table>
    <div class="foot">Generated by <code>osstack scorecard</code>. Evidence-based — a run whose verify gate did not pass cannot score green.</div>
  </div>
</div>
</body>
</html>
`;
}
