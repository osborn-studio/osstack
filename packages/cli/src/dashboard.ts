import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type Database from "better-sqlite3";
import type { KanbanRepository, CardStatus, CostTier } from "@osstack/core";
import { getBoard } from "@osstack/core";

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
  version: string;
  phase: string;
  dashboardUrl: string;
  adapters: readonly DashboardAdapter[];
  activeRuns: number;
  activeLoops?: number;
  now?: () => number;
}

export interface DashboardSnapshot {
  dashboard: {
    title: string;
    version: string;
    phase: string;
    url: string;
    generated_at: number;
    db_path: string;
  };
  overview: {
    progress_percent: number;
    total_runs: number;
    completed_runs: number;
    failed_runs: number;
    cancelled_runs: number;
    active_runs: number;
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
  next_steps: Array<{ label: string; detail: string; status: "ready" | "running" | "blocked" }>;
}

export interface DashboardServerHandle {
  url: string;
  host: string;
  port: number;
  close: () => Promise<void>;
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
  const totalEvents = (opts.db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number }).c;
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

  return {
    dashboard: {
      title: "osstack 开发驾驶舱",
      version: opts.version,
      phase: opts.phase,
      url: opts.dashboardUrl,
      generated_at: generatedAt,
      db_path: opts.dbPath,
    },
    overview: {
      progress_percent: progressPercent,
      total_runs: runCounts.total_runs,
      completed_runs: completed,
      failed_runs: failed,
      cancelled_runs: cancelled,
      active_runs: opts.activeRuns,
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
    recent_runs: recentRuns,
    next_steps: [
      { label: "产品设计", detail: "google-stitch 2.0 primary, claude-design fallback", status: "ready" },
      { label: "Coding", detail: "codex-cli primary, claude-code fallback", status: opts.activeRuns > 0 ? "running" : "ready" },
      { label: "Loop Engineering", detail: `${opts.activeLoops ?? 0} active loop session(s)`, status: (opts.activeLoops ?? 0) > 0 ? "running" : "ready" },
      { label: "测试验证", detail: "claude-code primary, codex-cli fallback", status: blockedCards > 0 ? "blocked" : "ready" },
    ],
  };
}

export async function startDashboardServer(
  snapshot: () => DashboardSnapshot,
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
  snapshot: () => DashboardSnapshot,
  url: string,
): Promise<void> {
  const path = new URL(req.url ?? "/", url).pathname;
  if (path === "/" || path === "/dashboard") {
    send(res, 200, "text/html; charset=utf-8", renderDashboardHtml());
    return;
  }
  if (path === "/api/dashboard") {
    send(res, 200, "application/json; charset=utf-8", JSON.stringify(snapshot()));
    return;
  }
  if (path === "/dashboard/url") {
    send(res, 200, "application/json; charset=utf-8", JSON.stringify({ url }));
    return;
  }
  send(res, 404, "text/plain; charset=utf-8", "not found");
}

function send(res: ServerResponse, status: number, contentType: string, body: string): void {
  res.writeHead(status, { "Content-Type": contentType, "Cache-Control": "no-store" });
  res.end(body);
}

export function renderDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>osstack 开发驾驶舱</title>
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
  @media (max-width: 900px) { .grid6, .grid3, .grid2 { grid-template-columns: 1fr; } header { flex-direction:column; } }
</style>
</head>
<body>
<main>
  <header>
    <div class="brand">
      <div class="mark">OS</div>
      <div>
        <h1>osstack 开发驾驶舱</h1>
        <p class="sub">产品设计 · 编码 · 测试验证 · 任务看板 · 质量追踪</p>
      </div>
    </div>
    <div class="pill" id="generated">loading...</div>
  </header>

  <section class="grid6" id="metrics"></section>

  <section class="section grid3">
    <div class="panel">
      <h2>Agent 分工</h2>
      <div class="list" id="agents"></div>
    </div>
    <div class="panel">
      <h2>质量面板</h2>
      <div id="quality"></div>
    </div>
    <div class="panel">
      <h2>后续计划</h2>
      <div class="list" id="next"></div>
    </div>
  </section>

  <section class="section panel">
    <h2>任务看板</h2>
    <div class="cards" id="board"></div>
  </section>

  <section class="section grid2">
    <div class="panel">
      <h2>最近运行</h2>
      <table>
        <thead><tr><th>Run</th><th>Agent</th><th>Phase</th><th>Status</th></tr></thead>
        <tbody id="runs"></tbody>
      </table>
    </div>
    <div class="panel">
      <h2>代码地图</h2>
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
async function load(){
  const res = await fetch('/api/dashboard');
  const d = await res.json();
  document.getElementById('generated').textContent = d.dashboard.phase + ' · ' + new Date(d.dashboard.generated_at * 1000).toLocaleString();
  document.getElementById('metrics').innerHTML = [
    metric('总体进度', d.overview.progress_percent + '%', 'blue', d.overview.progress_percent),
    metric('运行次数', d.overview.total_runs, 'ok'),
    metric('活动任务', d.overview.active_runs, 'warn'),
    metric('活动 Loops', d.overview.active_loops, 'warn'),
    metric('事件记录', d.overview.total_events, 'blue'),
    metric('看板卡片', d.board.total, 'ok'),
    metric('质量评分', d.quality.grade, d.quality.grade === 'A' ? 'ok' : d.quality.grade === 'B' ? 'warn' : 'err')
  ].join('');
  document.getElementById('agents').innerHTML = d.agents.map(a => '<div class="row"><span class="dot ok"></span><span><b>'+esc(a.id)+'</b><br><small>'+esc(a.display_name)+' · '+esc(a.cost_tier)+'</small></span></div>').join('');
  document.getElementById('quality').innerHTML = '<div class="row"><div class="quality '+statusClass(d.quality.grade)+'">'+d.quality.grade+'</div><span>成功率 '+Math.round(d.quality.success_rate*100)+'% · 阻塞 '+d.quality.blocked_cards+'</span></div><div class="list" style="margin-top:12px">'+d.quality.dimensions.map(q => '<div class="row"><span class="tag">'+q.grade+'</span><span>'+esc(q.name)+'<br><small>'+esc(q.detail)+'</small></span></div>').join('')+'</div>';
  document.getElementById('next').innerHTML = d.next_steps.map(n => '<div class="row"><span class="dot '+statusClass(n.status)+'"></span><span><b>'+esc(n.label)+'</b><br><small>'+esc(n.detail)+'</small></span></div>').join('');
  document.getElementById('board').innerHTML = lanes.map(lane => {
    const col = d.board.columns.find(c => c.name === lane) || { cards: [] };
    return '<div class="lane"><div class="lane-title"><span>'+lane+'</span><span>'+col.cards.length+'</span></div>'+col.cards.map(c => '<div class="card"><b>'+esc(c.title)+'</b><small>'+esc(c.assignee || 'unassigned')+(c.blocked_reason ? ' · '+esc(c.blocked_reason) : '')+'</small></div>').join('')+'</div>';
  }).join('');
  document.getElementById('runs').innerHTML = d.recent_runs.map(r => '<tr><td>'+esc(r.run_id)+'</td><td>'+esc(r.agent_id)+'</td><td>'+esc(r.phase)+'</td><td><span class="'+statusClass(r.outcome)+'">'+esc(r.outcome || 'running')+'</span></td></tr>').join('') || '<tr><td colspan="4">暂无运行记录</td></tr>';
}
load();
setInterval(load, 5000);
</script>
</body>
</html>`;
}
