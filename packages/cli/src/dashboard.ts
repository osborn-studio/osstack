import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AddressInfo } from "node:net";
import type Database from "better-sqlite3";
import type { KanbanRepository, CardStatus, CostTier } from "@osstack/core";
import {
  countEvents,
  countPendingTasks,
  getBoard,
  listAgentScorecards,
  listPitfallLessons,
  listProductionFreezes,
  type AgentScorecard,
} from "@osstack/core";
import {
  createAutonomyReliabilityReport,
  type AutonomyReliabilityReport,
} from "./autonomy-scorecard.js";

import { readAttentionDashboard, type AttentionDashboard, type AttentionDashboardService } from "./attention-dashboard.js";

export interface DashboardAdapter {
  id: string;
  display_name: string;
  cost_tier: CostTier;
}

export interface DashboardUrlOptions {
  host: string;
  urlHost?: string;
  port: number;
}

export interface DashboardSnapshotOptions {
  db: Database.Database;
  kanban: KanbanRepository;
  dbPath: string;
  workspacePath?: string;
  version: string;
  phase: string;
  dashboardUrl: string;
  adapters: readonly DashboardAdapter[];
  activeRuns: number;
  activeLoops?: number;
  /** Host lifecycle state; absence must not imply a running observer. */
  attentionService?: AttentionDashboardService;
  attentionAfter?: string;
  attentionLimit?: number;
  now?: () => number;
}

export interface DashboardSnapshot {
  attention: AttentionDashboard;
  dashboard: {
    title: string;
    version: string;
    phase: string;
    url: string;
    generated_at: number;
    db_path: string;
    workspace_path: string;
  };
  overview: {
    progress_percent: number;
    total_runs: number;
    completed_runs: number;
    failed_runs: number;
    cancelled_runs: number;
    active_runs: number;
    queued_tasks: number;
    active_loops: number;
    total_events: number;
    tokens_in: number;
    tokens_out: number;
  };
  board: {
    total: number;
    latest_event_id: number;
    by_status: Record<string, number>;
    columns: Array<{
      name: CardStatus;
      cards: Array<{
        card_id: string;
        title: string;
        assignee: string | null;
        priority: number;
        blocked_reason: string | null;
        age_seconds: number;
      }>;
    }>;
  };
  quality: {
    grade: "A" | "B" | "C";
    success_rate: number;
    blocked_cards: number;
    avg_duration_ms: number | null;
    dimensions: Array<{ name: string; grade: "A" | "B" | "C"; detail: string }>;
  };
  agents: DashboardAdapter[];
  agent_scorecards: AgentScorecard[];
  evidence: {
    reports: number;
    proof_packs: number;
    latest_report: DashboardArtifact | null;
    latest_proof_pack: DashboardProofPackArtifact | null;
  };
  lessons: {
    total: number;
    recent: Array<{
      pitfall_id: string;
      family: string;
      symptom: string;
      /** @deprecated Frozen legacy counter, not verified effectiveness. */
      verified_count: number;
      legacy_verified_count: number;
      observation_count: number;
    }>;
  };
  autonomy: {
    reliability: AutonomyReliabilityReport;
    deploy_freezes: Array<{
      repo_id: string;
      target: "production";
      frozen: true;
      reason: string;
      source_run_id: string;
      frozen_at: number;
    }>;
  };
  recent_runs: Array<{
    run_id: string;
    task_id: string;
    title: string;
    agent_id: string;
    capability_id: string;
    phase: string;
    outcome: string | null;
    started_at: number;
    duration_ms: number | null;
  }>;
  next_steps: Array<{
    label: string;
    detail: string;
    command: string;
    status: "ready" | "running" | "blocked";
    blockers?: ReleaseReadinessBlocker[];
  }>;
}

export interface DashboardArtifact {
  name: string;
  path: string;
  updated_at: number;
}

export interface DashboardProofPackArtifact extends DashboardArtifact {
  manifest: string | null;
}

export interface ReleaseReadinessBlocker {
  id: string;
  detail: string;
}

export interface DashboardServerHandle {
  url: string;
  host: string;
  port: number;
  close: () => Promise<void>;
}

export interface DashboardHttpSnapshotParams {
  workspacePath?: string;
  attentionAfter?: string;
  attentionLimit?: number;
}

export function dashboardUrl(opts: DashboardUrlOptions): string {
  const host = opts.urlHost ?? opts.host;
  return `http://${host}:${opts.port}/dashboard`;
}

export function dashboardUrlFromEnv(): DashboardUrlOptions {
  const defaultPort = process.env["VITEST"] === "true" ? "0" : "8799";
  return {
    host: process.env["OSSTACK_DASHBOARD_HOST"] ?? "127.0.0.1",
    urlHost: process.env["OSSTACK_DASHBOARD_URL_HOST"] ?? "localhost",
    port: Number(process.env["OSSTACK_DASHBOARD_PORT"] ?? defaultPort),
  };
}

export function createDashboardSnapshot(opts: DashboardSnapshotOptions): DashboardSnapshot {
  const generatedAt = opts.now ? opts.now() : Date.now() / 1000;
  const runCounts = opts.db.prepare(`
    SELECT
      COUNT(*) AS total_runs,
      SUM(CASE WHEN outcome = 'completed' THEN 1 ELSE 0 END) AS completed_runs,
      SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) AS failed_runs,
      SUM(CASE WHEN outcome = 'cancelled' THEN 1 ELSE 0 END) AS cancelled_runs,
      SUM(tokens_in) AS tokens_in,
      SUM(tokens_out) AS tokens_out,
      AVG(duration_ms) AS avg_duration_ms
    FROM runs
  `).get() as {
    total_runs: number;
    completed_runs: number | null;
    failed_runs: number | null;
    cancelled_runs: number | null;
    tokens_in: number | null;
    tokens_out: number | null;
    avg_duration_ms: number | null;
  };
  const totalEvents = countEvents(opts.db);
  const queuedTasks = countPendingTasks(opts.db);
  const boardOptions = opts.now
    ? { includeArchived: false, now: opts.now }
    : { includeArchived: false };
  const boardView = getBoard(opts.kanban, boardOptions);
  const boardColumns = boardView.changed ? boardView.columns : [];
  const byStatus = boardView.changed ? boardView.stats.by_status : {};
  const boardTotal = boardView.changed ? boardView.stats.total : 0;
  const doneCards = byStatus["done"] ?? 0;
  const progressBase = boardTotal > 0 ? boardTotal : runCounts.total_runs;
  const progressDone = boardTotal > 0 ? doneCards : (runCounts.completed_runs ?? 0);
  const progressPercent = progressBase > 0 ? Math.round((progressDone / progressBase) * 100) : 0;
  const completed = runCounts.completed_runs ?? 0;
  const failed = runCounts.failed_runs ?? 0;
  const cancelled = runCounts.cancelled_runs ?? 0;
  const terminalRuns = completed + failed + cancelled;
  const successRate = terminalRuns > 0 ? completed / terminalRuns : 1;
  const blockedCards = byStatus["blocked"] ?? 0;
  const grade: "A" | "B" | "C" = successRate >= 0.9 && blockedCards === 0
    ? "A"
    : successRate >= 0.5
      ? "B"
      : "C";

  const recentRuns = opts.db.prepare(`
    SELECT r.run_id, r.task_id, t.title, r.agent_id, r.capability_id, r.phase,
           r.outcome, r.started_at, r.duration_ms
    FROM runs r JOIN tasks t ON t.task_id = r.task_id
    ORDER BY r.started_at DESC
    LIMIT 8
  `).all() as DashboardSnapshot["recent_runs"];
  const workspacePath = opts.workspacePath ?? dirnameOfDb(opts.dbPath);
  const reportDir = join(workspacePath, "reports");
  const releaseDir = join(workspacePath, "release");
  const reportsCount = countMarkdownFiles(reportDir, "osstack-report-");
  const proofPackCount = countProofPacks(releaseDir);
  const latestReport = latestMarkdownFile(reportDir, "osstack-report-");
  const latestProofPack = latestProofPackArtifact(releaseDir);
  const releaseReadinessBlockers = readReleaseReadinessBlockers(join(workspacePath, "release-readiness.md"));
  const lessons = listPitfallLessons(opts.db, { limit: 5 });
  const lessonCount = countActivePitfallLessons(opts.db);
  const deployFreezes = listProductionFreezes(
    opts.db,
    { active_only: true },
  );
  const autonomyReliability = createAutonomyReliabilityReport(opts.db, {
    now: () => new Date(generatedAt * 1_000),
  });

  return {
    attention: readAttentionDashboard(opts.db, {
      service: opts.attentionService ?? "unavailable",
      nowMs: generatedAt * 1_000,
      ...(opts.workspacePath === undefined ? {} : { workspacePath: opts.workspacePath }),
      ...(opts.attentionAfter === undefined ? {} : { after: opts.attentionAfter }),
      ...(opts.attentionLimit === undefined ? {} : { limit: opts.attentionLimit }),
    }),
    dashboard: {
      title: "osstack 开发驾驶舱",
      version: opts.version,
      phase: opts.phase,
      url: opts.dashboardUrl,
      generated_at: generatedAt,
      db_path: opts.dbPath,
      workspace_path: workspacePath,
    },
    overview: {
      progress_percent: progressPercent,
      total_runs: runCounts.total_runs,
      completed_runs: completed,
      failed_runs: failed,
      cancelled_runs: cancelled,
      active_runs: opts.activeRuns,
      queued_tasks: queuedTasks,
      active_loops: opts.activeLoops ?? 0,
      total_events: totalEvents,
      tokens_in: runCounts.tokens_in ?? 0,
      tokens_out: runCounts.tokens_out ?? 0,
    },
    board: {
      total: boardTotal,
      latest_event_id: boardView.latest_event_id,
      by_status: byStatus,
      columns: boardColumns.map((col) => ({
        name: col.name,
        cards: col.cards.map((card) => ({
          card_id: card.card_id,
          title: card.title,
          assignee: card.assignee,
          priority: card.priority,
          blocked_reason: card.blocked_reason,
          age_seconds: card.age_seconds,
        })),
      })),
    },
    quality: {
      grade,
      success_rate: Number(successRate.toFixed(2)),
      blocked_cards: blockedCards,
      avg_duration_ms: runCounts.avg_duration_ms,
      dimensions: [
        { name: "任务完成率", grade, detail: `${Math.round(successRate * 100)}% terminal runs completed` },
        { name: "阻塞健康", grade: blockedCards === 0 ? "A" : "B", detail: `${blockedCards} blocked card(s)` },
        { name: "事件追踪", grade: totalEvents > 0 || runCounts.total_runs === 0 ? "A" : "B", detail: `${totalEvents} persisted event(s)` },
        { name: "Agent 路由", grade: opts.adapters.length >= 2 ? "A" : "B", detail: `${opts.adapters.length} registered adapter(s)` },
      ],
    },
    agents: [...opts.adapters],
    agent_scorecards: listAgentScorecards(opts.db, { limit: 5 }),
    evidence: {
      reports: reportsCount,
      proof_packs: proofPackCount,
      latest_report: latestReport,
      latest_proof_pack: latestProofPack,
    },
    lessons: {
      total: lessonCount,
      recent: lessons.map((lesson) => ({
        pitfall_id: lesson.pitfall_id,
        family: lesson.family,
        symptom: lesson.symptom,
        verified_count: lesson.verified_count,
        legacy_verified_count: lesson.legacy_verified_count,
        observation_count: lesson.observation_count,
      })),
    },
    autonomy: {
      reliability: autonomyReliability,
      deploy_freezes: deployFreezes.map((freeze) => ({
        repo_id: freeze.repo_id,
        target: freeze.target,
        frozen: true,
        reason: freeze.reason,
        source_run_id: freeze.source_run_id,
        frozen_at: freeze.frozen_at,
      })),
    },
    recent_runs: recentRuns,
    next_steps: [
      ...releaseReadinessNextSteps(releaseReadinessBlockers, workspacePath),
      {
        label: "产品设计",
        detail: "google-stitch 2.0 primary, claude-design fallback",
        command: "osstack guide --write",
        status: "ready",
      },
      {
        label: "Coding",
        detail: "codex-cli primary, claude-code fallback",
        command: "osstack deliver \"<task>\" --auto-agent --worktree --checkpoint",
        status: opts.activeRuns > 0 ? "running" : "ready",
      },
      {
        label: "Loop Engineering",
        detail: `${opts.activeLoops ?? 0} active loop session(s)`,
        command: "osstack cockpit run --workspace <path> --json",
        status: (opts.activeLoops ?? 0) > 0 ? "running" : "ready",
      },
      {
        label: "测试验证",
        detail: "claude-code primary, codex-cli fallback",
        command: "osstack cockpit proof --workspace <path> --json",
        status: blockedCards > 0 ? "blocked" : "ready",
      },
    ],
  };
}

function dirnameOfDb(dbPath: string): string {
  return dbPath === ":memory:" ? "." : dirname(dbPath);
}

function countActivePitfallLessons(db: Database.Database): number {
  const row = db.prepare("SELECT COUNT(*) AS total FROM pitfall_lessons WHERE status = 'active'").get() as
    | { total?: number }
    | undefined;
  return row?.total ?? 0;
}

function countMarkdownFiles(dir: string, prefix: string): number {
  try {
    return readdirSync(dir).filter((name) => name.startsWith(prefix) && name.endsWith(".md")).length;
  } catch {
    return 0;
  }
}

function countProofPacks(dir: string): number {
  try {
    return readdirSync(dir).filter((name) => {
      if (!name.startsWith("osstack-proof-")) return false;
      try {
        return statSync(join(dir, name)).isDirectory();
      } catch {
        return false;
      }
    }).length;
  } catch {
    return 0;
  }
}

function latestMarkdownFile(dir: string, prefix: string): DashboardArtifact | null {
  return latestDirectoryEntry(dir, (name) => name.startsWith(prefix) && name.endsWith(".md"));
}

function latestProofPackArtifact(dir: string): DashboardProofPackArtifact | null {
  const artifact = latestDirectoryEntry(dir, (name, path) => {
    if (!name.startsWith("osstack-proof-")) return false;
    try {
      return statSync(path).isDirectory();
    } catch {
      return false;
    }
  });
  if (artifact === null) return null;
  const manifest = join(artifact.path, "manifest.json");
  try {
    statSync(manifest);
    return { ...artifact, manifest };
  } catch {
    return { ...artifact, manifest: null };
  }
}

function latestDirectoryEntry(
  dir: string,
  accept: (name: string, path: string) => boolean,
): DashboardArtifact | null {
  try {
    let latest: DashboardArtifact | null = null;
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (!accept(name, path)) continue;
      let artifact: DashboardArtifact;
      try {
        const stats = statSync(path);
        artifact = {
          name,
          path,
          updated_at: stats.mtimeMs / 1000,
        };
      } catch {
        continue;
      }
      if (latest === null || artifact.updated_at > latest.updated_at) latest = artifact;
    }
    return latest;
  } catch {
    return null;
  }
}

function readReleaseReadinessBlockers(path: string): ReleaseReadinessBlocker[] {
  let markdown: string;
  try {
    markdown = readFileSync(path, "utf-8");
  } catch {
    return [];
  }
  const blockers: ReleaseReadinessBlocker[] = [];
  let inBlockers = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^##\s+Blockers\s*$/i.test(line.trim())) {
      inBlockers = true;
      continue;
    }
    if (inBlockers && /^##\s+/.test(line.trim())) break;
    if (!inBlockers) continue;
    const match = line.match(/^-\s+\[([^\]]+)\]\s+(.+)$/);
    if (match) blockers.push({ id: match[1]!.trim(), detail: match[2]!.trim() });
  }
  return blockers;
}

function releaseReadinessNextSteps(
  blockers: ReleaseReadinessBlocker[],
  workspacePath: string,
): DashboardSnapshot["next_steps"] {
  if (blockers.length === 0) return [];
  const ids = blockers.map((blocker) => blocker.id).join(", ");
  return [{
    label: "Release Readiness",
    detail: `${blockers.length} blocker(s): ${ids}`,
    command: `osstack release doctor --target all --workspace ${shellArg(workspacePath)} --output release-readiness.md --json`,
    status: "blocked",
    blockers,
  }];
}

function shellArg(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function startDashboardServer(
  snapshot: (params?: DashboardHttpSnapshotParams) => DashboardSnapshot,
  opts: DashboardUrlOptions = dashboardUrlFromEnv(),
): Promise<DashboardServerHandle> {
  let url = dashboardUrl(opts);
  const server = createServer((req, res) => {
    void handleDashboardRequest(req, res, snapshot, url);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, opts.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const addr = server.address() as AddressInfo | null;
  const port = addr?.port ?? opts.port;
  const resolvedOpts = { ...opts, port };
  url = dashboardUrl(resolvedOpts);
  return {
    url,
    host: opts.host,
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function handleDashboardRequest(
  req: IncomingMessage,
  res: ServerResponse,
  snapshot: (params?: DashboardHttpSnapshotParams) => DashboardSnapshot,
  url: string,
): Promise<void> {
  const requestUrl = new URL(req.url ?? "/", url);
  const path = requestUrl.pathname;
  if (path === "/" || path === "/dashboard") {
    send(res, 200, "text/html; charset=utf-8", renderDashboardHtml());
    return;
  }
  if (path === "/api/dashboard") {
    const workspacePath = requestUrl.searchParams.get("workspace") ?? undefined;
    const attentionAfter = requestUrl.searchParams.get("attention_after") ?? undefined;
    const rawLimit = requestUrl.searchParams.get("attention_limit");
    const attentionLimit = rawLimit === null ? undefined : Number(rawLimit);
    if ((attentionAfter !== undefined && !/^[a-f0-9]{64}$/.test(attentionAfter))
      || (attentionLimit !== undefined && (!Number.isSafeInteger(attentionLimit) || attentionLimit < 1 || attentionLimit > 100))) {
      send(res, 400, "application/json; charset=utf-8", JSON.stringify({ error: "invalid_attention_page" }));
      return;
    }
    send(res, 200, "application/json; charset=utf-8", JSON.stringify(snapshot({
      ...(workspacePath === undefined ? {} : { workspacePath }),
      ...(attentionAfter === undefined ? {} : { attentionAfter }),
      ...(attentionLimit === undefined ? {} : { attentionLimit }),
    })));
    return;
  }
  if (path === "/dashboard/url") {
    send(res, 200, "application/json; charset=utf-8", JSON.stringify({
      url: dashboardUrlWithWorkspace(url, requestUrl.searchParams.get("workspace") ?? undefined),
    }));
    return;
  }
  send(res, 404, "text/plain; charset=utf-8", "not found");
}

function dashboardUrlWithWorkspace(url: string, workspacePath: string | undefined): string {
  if (workspacePath === undefined) return url;
  const nextUrl = new URL(url);
  nextUrl.searchParams.set("workspace", workspacePath);
  return nextUrl.toString();
}

function send(res: ServerResponse, status: number, contentType: string, body: string): void {
  res.writeHead(status, { "Content-Type": contentType, "Cache-Control": "no-store" });
  res.end(body);
}

type DashboardLanguage = "en" | "zh-CN";

function dashboardLanguage(value = process.env["OSSTACK_LANG"]): DashboardLanguage {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "zh-cn" || normalized === "zh" || normalized === "cn") return "zh-CN";
  return "en";
}

function dashboardText(language: DashboardLanguage): {
  htmlLang: string;
  title: string;
  subtitle: string;
  agentRoles: string;
  quality: string;
  nextSteps: string;
  evidence: string;
  scorecards: string;
  lessons: string;
  kanban: string;
  recentRuns: string;
  codeMap: string;
  attention: string;
  metrics: string[];
  successRate: string;
  blocked: string;
  reports: string;
  proofPacks: string;
  latestReport: string;
  latestProofPack: string;
  markdownReports: string;
  checksumedProofPacks: string;
  runsLabel: string;
  successLabel: string;
  observationsLabel: string;
  legacyCountLabel: string;
  commands: string;
  noAgentHistory: string;
  noLessons: string;
  noRuns: string;
  unassigned: string;
} {
  if (language === "zh-CN") {
    return {
      htmlLang: "zh-CN",
      title: "osstack 开发驾驶舱",
      subtitle: "产品设计 · 编码 · 测试验证 · 任务看板 · 质量追踪",
      agentRoles: "Agent 分工",
      quality: "质量面板",
      nextSteps: "后续计划",
      evidence: "证据资产",
      scorecards: "Agent 评分卡",
      lessons: "经验教训",
      kanban: "任务看板",
      recentRuns: "最近运行",
      codeMap: "代码地图",
      attention: "Attention · 只读监督",
      metrics: ["总体进度", "运行次数", "活动任务", "队列任务", "活动 Loops", "事件记录", "看板卡片", "质量评分"],
      successRate: "成功率",
      blocked: "阻塞",
      reports: "报告",
      proofPacks: "Proof packs",
      latestReport: "最新报告",
      latestProofPack: "最新 Proof pack",
      markdownReports: "份 Markdown 报告",
      checksumedProofPacks: "个带校验 Proof pack",
      runsLabel: "次运行",
      successLabel: "成功",
      observationsLabel: "已记录观察",
      legacyCountLabel: "历史计数（非验证）",
      commands: "命令",
      noAgentHistory: "暂无 agent 运行历史。",
      noLessons: "暂无 pitfall lessons。",
      noRuns: "暂无运行记录",
      unassigned: "未分配",
    };
  }
  return {
    htmlLang: "en",
    title: "osstack Cockpit",
    subtitle: "Product design · Coding · Test verification · Kanban · Quality tracking",
    agentRoles: "Agent Roles",
    quality: "Quality",
    nextSteps: "Next Steps",
    evidence: "Evidence Assets",
    scorecards: "Agent Scorecards",
    lessons: "Lessons",
    kanban: "Kanban Board",
    recentRuns: "Recent Runs",
    codeMap: "Code Map",
    attention: "Attention · Read-only observation",
    metrics: ["Progress", "Runs", "Active Tasks", "Queued Tasks", "Active Loops", "Events", "Board Cards", "Quality Grade"],
    successRate: "Success rate",
    blocked: "Blocked",
    reports: "Reports",
    proofPacks: "Proof packs",
    latestReport: "Latest report",
    latestProofPack: "Latest proof pack",
    markdownReports: "markdown report(s)",
    checksumedProofPacks: "checksumed proof pack(s)",
    runsLabel: "runs",
    successLabel: "success",
    observationsLabel: "tracked observations",
    legacyCountLabel: "legacy count (not validation)",
    commands: "Commands",
    noAgentHistory: "No agent run history yet.",
    noLessons: "No pitfall lessons recorded.",
    noRuns: "No recent runs",
    unassigned: "unassigned",
  };
}

export function renderDashboardHtml(language: DashboardLanguage = dashboardLanguage()): string {
  const text = dashboardText(language);
  return `<!DOCTYPE html>
<html lang="${text.htmlLang}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${text.title}</title>
<style>
  :root { color-scheme: dark; --bg:#0b1020; --panel:#111827; --panel2:#172033; --line:#263247; --text:#eef2ff; --muted:#94a3b8; --blue:#38bdf8; --green:#22c55e; --yellow:#f59e0b; --red:#ef4444; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  main { max-width:1180px; margin:0 auto; padding:28px 20px 40px; }
  header { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; margin-bottom:22px; }
  h1 { font-size:22px; margin:0 0 4px; letter-spacing:0; }
  h2 { font-size:12px; color:var(--muted); font-weight:600; margin:0 0 12px; text-transform:uppercase; }
  .sub { color:var(--muted); font-size:13px; margin:0; }
  .brand { display:flex; gap:12px; align-items:center; }
  .mark { width:38px; height:38px; border-radius:8px; background:#0ea5e9; display:grid; place-items:center; font-weight:800; }
  .pill { font-size:11px; border:1px solid var(--line); border-radius:999px; padding:5px 9px; color:var(--muted); white-space:nowrap; }
  .grid6 { display:grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap:12px; }
  .grid3 { display:grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap:14px; }
  .grid2 { display:grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap:14px; }
  .panel { background:linear-gradient(135deg,var(--panel2),var(--panel)); border:1px solid rgba(148,163,184,.12); border-radius:8px; padding:16px; }
  .metric .label { color:var(--muted); font-size:11px; }
  .metric .value { margin-top:4px; font-size:26px; font-weight:800; }
  .bar { height:6px; background:#334155; border-radius:99px; overflow:hidden; margin-top:10px; }
  .fill { height:100%; background:var(--blue); width:0; transition:width .4s ease; }
  .section { margin-top:22px; }
  .list { display:grid; gap:9px; }
  .row { display:flex; align-items:flex-start; gap:10px; font-size:12px; color:#cbd5e1; }
  .dot { width:8px; height:8px; border-radius:999px; margin-top:5px; background:var(--muted); flex:0 0 auto; }
  .ok { color:var(--green); } .warn { color:var(--yellow); } .err { color:var(--red); } .blue { color:var(--blue); }
  .dot.ok { background:var(--green); } .dot.warn { background:var(--yellow); } .dot.err { background:var(--red); } .dot.blue { background:var(--blue); }
  .tag { font-size:10px; border-radius:4px; padding:2px 6px; background:#1e293b; color:var(--muted); }
  .quality { width:38px; height:38px; border-radius:999px; display:grid; place-items:center; background:#1e293b; font-weight:800; }
  .cards { display:grid; grid-template-columns: repeat(6, minmax(128px, 1fr)); gap:10px; overflow:auto; padding-bottom:2px; }
  .lane { min-height:168px; border:1px solid var(--line); border-radius:8px; padding:10px; background:rgba(15,23,42,.45); }
  .lane-title { display:flex; justify-content:space-between; color:var(--muted); font-size:11px; margin-bottom:8px; }
  .card { border:1px solid rgba(148,163,184,.15); background:#0f172a; border-radius:6px; padding:9px; margin-bottom:8px; font-size:12px; }
  .card small { color:var(--muted); display:block; margin-top:4px; }
  table { width:100%; border-collapse:collapse; font-size:12px; }
  th, td { border-bottom:1px solid var(--line); text-align:left; padding:9px 6px; color:#cbd5e1; }
  th { color:var(--muted); font-weight:600; }
  code { display:inline-block; margin-top:4px; padding:2px 5px; border-radius:4px; background:#020617; color:#bae6fd; font-size:11px; }
  .release-blocker { display:block; margin-top:5px; color:#fca5a5; font-size:11px; line-height:1.35; }
  @media (max-width: 900px) { .grid6, .grid3, .grid2 { grid-template-columns: 1fr; } header { flex-direction:column; } }
</style>
</head>
<body>
<main>
  <header>
    <div class="brand">
      <div class="mark">OS</div>
      <div>
        <h1>${text.title}</h1>
        <p class="sub">${text.subtitle}</p>
      </div>
    </div>
    <div class="pill" id="generated">loading...</div>
  </header>

  <section class="section panel" aria-labelledby="attention-heading">
    <h2 id="attention-heading">${text.attention}</h2>
    <div id="attention" style="white-space:pre-wrap;overflow-wrap:anywhere" role="status" aria-live="polite"></div>
    <a id="attention-first" hidden>First page</a> <a id="attention-next" hidden>More watched tasks</a>
  </section>

  <section class="grid6" id="metrics"></section>

  <section class="section grid3">
    <div class="panel">
      <h2>${text.agentRoles}</h2>
      <div class="list" id="agents"></div>
    </div>
    <div class="panel">
      <h2>${text.quality}</h2>
      <div id="quality"></div>
    </div>
    <div class="panel">
      <h2>${text.nextSteps}</h2>
      <div class="list" id="next"></div>
    </div>
  </section>

  <section class="section grid3">
    <div class="panel">
      <h2>${text.evidence}</h2>
      <div class="list" id="evidence"></div>
    </div>
    <div class="panel">
      <h2>${text.scorecards}</h2>
      <div class="list" id="scorecards"></div>
    </div>
    <div class="panel">
      <h2>${text.lessons}</h2>
      <div class="list" id="lessons"></div>
    </div>
  </section>

  <section class="section panel">
    <h2>${text.kanban}</h2>
    <div class="cards" id="board"></div>
  </section>

  <section class="section grid2">
    <div class="panel">
      <h2>${text.recentRuns}</h2>
      <table>
        <thead><tr><th>Run</th><th>Agent</th><th>Phase</th><th>Status</th></tr></thead>
        <tbody id="runs"></tbody>
      </table>
    </div>
    <div class="panel">
      <h2>${text.codeMap}</h2>
      <div class="list">
        <div class="row"><span class="dot blue"></span><span>CLI / daemon: packages/cli/src</span></div>
        <div class="row"><span class="dot blue"></span><span>Agent adapters: packages/agents/src/adapters</span></div>
        <div class="row"><span class="dot blue"></span><span>Policy / state / kanban: packages/core/src</span></div>
        <div class="row"><span class="dot blue"></span><span>Hermes bridge: hermes-skill/scripts/osstack_bridge.py</span></div>
      </div>
    </div>
  </section>
</main>
<script>
const lanes = ["triage","todo","ready","running","blocked","done"];
function esc(s){ return String(s ?? "").replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function metric(label, value, color, pct){
  return '<div class="panel metric"><div class="label">'+label+'</div><div class="value '+color+'">'+value+'</div>'+(pct !== undefined ? '<div class="bar"><div class="fill" style="width:'+pct+'%"></div></div>' : '')+'</div>';
}
function statusClass(status){ return status === "done" || status === "completed" ? "ok" : status === "blocked" || status === "failed" ? "err" : status === "running" ? "warn" : "blue"; }
function releaseBlockersHtml(n){
  const blockers = Array.isArray(n.blockers) ? n.blockers : [];
  return blockers.map(b => '<span class="release-blocker">blocker '+esc(b.id)+': '+esc(b.detail)+'</span>').join('');
}
function artifactRow(label, artifact){
  if (!artifact || !artifact.path) return '';
  return '<div class="row"><span class="dot ok"></span><span><b>'+esc(label)+'</b><br><small>'+esc(artifact.path)+'</small></span></div>';
}
function renderAttention(a, zh = false) {
  const el = document.getElementById('attention');
  const label = zh ? {
    states: { available:'观测已更新', covered:'观测已更新', degraded:'监督不完整', stale:'观测已过期', unknown:'来源不确定', disabled:'监督已停用', unavailable:'监督暂不可用', not_watched:'尚未登记监督任务' },
    unknown:'统计暂不可用', repo:'当前仓库', all:'本机概览（默认租户）', open:'待答决定', uncertain:'结果不确定的回答', pending:'正在提交的回答', unmonitored:'未纳入监督的已发现任务', dead:'通知失败', human:'等待人工', system:'等待系统', unclassified:'等待原因不明', missing:'来源缺失的决定', applied:'已应用的回答', note:'仅展示监督结果；回答已应用不代表任务完成。', first:'第一页', more:'更多监督任务', sample:'上次读取'
  } : {
    states: { available:'Observation current', covered:'Observation current', degraded:'Coverage incomplete', stale:'Observation expired', unknown:'Source uncertain', disabled:'Observation disabled', unavailable:'Observation unavailable', not_watched:'No watched tasks registered' },
    unknown:'Counts unavailable', repo:'Selected repository', all:'Local overview (default tenant)', open:'Open decisions', uncertain:'Answers with uncertain outcome', pending:'Answers pending', unmonitored:'Discovered tasks outside coverage', dead:'Failed notifications', human:'Waiting for a person', system:'Waiting for the system', unclassified:'Wait reason unknown', missing:'Decisions with missing sources', applied:'Applied answers', note:'Read-only observation. An applied answer does not mean the task is complete.', first:'First page', more:'More watched tasks', sample:'Read at'
  };
  const state = value => label.states[value] || label.states.unknown;
  const lines = [state(a && a.status)];
  if (!a) { el.textContent = lines.concat(label.unknown).join('\\n'); return; }
  lines.push(a.scope_filter === 'workspace' ? label.repo + ': ' + a.workspace_path : label.all);
  if (!a.totals) lines.push(label.unknown);
  else {
    const n = a.totals;
    lines.push(label.open + ': ' + n.open_items + ' · ' + label.uncertain + ': ' + n.uncertain_answers + ' · ' + label.pending + ': ' + n.pending_answers);
    lines.push(label.missing + ': ' + n.missing_source_items + ' · ' + label.applied + ': ' + n.applied_answers);
    lines.push(label.unmonitored + ': ' + n.unmonitored_subjects + ' · ' + label.dead + ': ' + n.dead_letters);
    lines.push(label.human + ': ' + n.human_waits + ' · ' + label.system + ': ' + n.system_waits + ' · ' + label.unclassified + ': ' + n.unknown_waits);
  }
  for (const s of a.scopes || []) lines.push(s.task_title + ' · ' + state(s.coverage) + ' · scope=' + s.scope_id);
  if (a.truncated && a.totals) lines.push(label.more + ' (' + a.returned + '/' + a.totals.scopes + ')');
  lines.push(label.note);
  // Source text stays text, including angle brackets, quotes and backticks.
  el.textContent = lines.join('\\n');
  const current = new URL(window.location.href);
  const first = document.getElementById('attention-first');
  first.textContent = label.first;
  first.hidden = !current.searchParams.has('attention_after');
  current.searchParams.delete('attention_after');
  first.href = current.pathname + current.search;
  const next = document.getElementById('attention-next');
  next.textContent = label.more;
  next.hidden = !a.truncated || !/^[a-f0-9]{64}$/.test(a.next_after || '');
  if (!next.hidden) {
    current.searchParams.set('attention_after', a.next_after);
    next.href = current.pathname + current.search;
  }
}
const t = ${JSON.stringify(text)};
function dashboardSearch() {
  const query = new URLSearchParams(window.location.search);
  const after = query.get('attention_after');
  const limit = query.get('attention_limit');
  if (after !== null && !/^[a-f0-9]{64}$/.test(after)) query.delete('attention_after');
  if (limit !== null && (!Number.isSafeInteger(Number(limit)) || Number(limit) < 1 || Number(limit) > 100)) query.delete('attention_limit');
  const value = query.toString();
  return value ? '?' + value : '';
}
let latestDashboardRequest = 0;
async function load(){
  const request = ++latestDashboardRequest;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 4500);
  try {
  const res = await fetch('/api/dashboard' + dashboardSearch(), { signal: controller.signal });
  if (!res.ok) throw new Error('snapshot_unavailable');
  const d = await res.json();
  if (request !== latestDashboardRequest) return;
  renderAttention(d.attention, t.htmlLang === 'zh-CN');
  document.getElementById('generated').textContent = d.dashboard.phase + ' · ' + new Date(d.dashboard.generated_at * 1000).toLocaleString() + ' · ' + d.dashboard.workspace_path;
  document.getElementById('metrics').innerHTML = [
    metric(t.metrics[0], d.overview.progress_percent + '%', 'blue', d.overview.progress_percent),
    metric(t.metrics[1], d.overview.total_runs, 'ok'),
    metric(t.metrics[2], d.overview.active_runs, 'warn'),
    metric(t.metrics[3], d.overview.queued_tasks, d.overview.queued_tasks > 0 ? 'warn' : 'ok'),
    metric(t.metrics[4], d.overview.active_loops, 'warn'),
    metric(t.metrics[5], d.overview.total_events, 'blue'),
    metric(t.metrics[6], d.board.total, 'ok'),
    metric(t.metrics[7], d.quality.grade, d.quality.grade === 'A' ? 'ok' : d.quality.grade === 'B' ? 'warn' : 'err')
  ].join('');
  document.getElementById('agents').innerHTML = d.agents.map(a => '<div class="row"><span class="dot ok"></span><span><b>'+esc(a.id)+'</b><br><small>'+esc(a.display_name)+' · '+esc(a.cost_tier)+'</small></span></div>').join('');
  document.getElementById('quality').innerHTML = '<div class="row"><div class="quality '+statusClass(d.quality.grade)+'">'+d.quality.grade+'</div><span>'+esc(t.successRate)+' '+Math.round(d.quality.success_rate*100)+'% · '+esc(t.blocked)+' '+d.quality.blocked_cards+'</span></div><div class="list" style="margin-top:12px">'+d.quality.dimensions.map(q => '<div class="row"><span class="tag">'+q.grade+'</span><span>'+esc(q.name)+'<br><small>'+esc(q.detail)+'</small></span></div>').join('')+'</div>';
  document.getElementById('next').innerHTML = d.next_steps.map(n => '<div class="row"><span class="dot '+statusClass(n.status)+'"></span><span><b>'+esc(n.label)+'</b><br><small>'+esc(n.detail)+'</small>'+releaseBlockersHtml(n)+(n.command ? '<br><code>'+esc(n.command)+'</code>' : '')+'</span></div>').join('');
  document.getElementById('evidence').innerHTML = [
    '<div class="row"><span class="dot blue"></span><span><b>'+esc(t.reports)+'</b><br><small>'+d.evidence.reports+' '+esc(t.markdownReports)+'</small></span></div>',
    '<div class="row"><span class="dot blue"></span><span><b>'+esc(t.proofPacks)+'</b><br><small>'+d.evidence.proof_packs+' '+esc(t.checksumedProofPacks)+'</small></span></div>',
    artifactRow(t.latestReport, d.evidence.latest_report),
    artifactRow(t.latestProofPack, d.evidence.latest_proof_pack),
    '<div class="row"><span class="dot blue"></span><span><b>'+esc(t.commands)+'</b><br><small>osstack report · osstack proof · osstack pr</small></span></div>'
  ].join('');
  document.getElementById('scorecards').innerHTML = d.agent_scorecards.length ? d.agent_scorecards.map(s => '<div class="row"><span class="dot '+(s.recent_failures ? 'warn' : 'ok')+'"></span><span><b>'+esc(s.agent_id)+'</b><br><small>'+s.total_runs+' '+esc(t.runsLabel)+' · '+Math.round(s.success_rate*100)+'% '+esc(t.successLabel)+' · '+esc(s.capability_fit)+'</small></span></div>').join('') : '<div class="row"><span class="dot warn"></span><span>'+esc(t.noAgentHistory)+'</span></div>';
  document.getElementById('lessons').innerHTML = d.lessons.recent.length ? d.lessons.recent.map(l => '<div class="row"><span class="dot warn"></span><span><b>'+esc(l.family)+'</b><br><small>'+esc(l.symptom)+' · '+esc(t.observationsLabel)+' '+l.observation_count+' · '+esc(t.legacyCountLabel)+' '+l.legacy_verified_count+'</small></span></div>').join('') : '<div class="row"><span class="dot ok"></span><span>'+esc(t.noLessons)+'</span></div>';
  document.getElementById('board').innerHTML = lanes.map(lane => {
    const col = d.board.columns.find(c => c.name === lane) || { cards: [] };
    return '<div class="lane"><div class="lane-title"><span>'+lane+'</span><span>'+col.cards.length+'</span></div>'+col.cards.map(c => '<div class="card"><b>'+esc(c.title)+'</b><small>'+esc(c.assignee || t.unassigned)+(c.blocked_reason ? ' · '+esc(c.blocked_reason) : '')+'</small></div>').join('')+'</div>';
  }).join('');
  document.getElementById('runs').innerHTML = d.recent_runs.map(r => '<tr><td>'+esc(r.run_id)+'</td><td>'+esc(r.agent_id)+'</td><td>'+esc(r.phase)+'</td><td><span class="'+statusClass(r.outcome)+'">'+esc(r.outcome || 'running')+'</span></td></tr>').join('') || '<tr><td colspan="4">'+esc(t.noRuns)+'</td></tr>';
  } catch {
    if (request === latestDashboardRequest) renderAttention({ status:'unavailable', totals:null, scopes:[] }, t.htmlLang === 'zh-CN');
  } finally { clearTimeout(deadline); }
}
load();
setInterval(load, 5000);
</script>
</body>
</html>`;
}
