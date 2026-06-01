// osstack daemon — Unix socket server.
//
// Wire protocol (length-prefixed JSON, see @osstack/hermes-adapter/framing):
//   Single-shot methods (version, health, agent.list, run.status, stats,
//     task.cancel): one request → one response.
//   Streaming methods (task.submit, task.observe): one request → many frames,
//     ending with a terminal HermesEvent (type "done" or "error" with
//     terminal=true).
//
// Each connection is independent; concurrent task.submit calls each get
// their own socket and event stream.

import { createServer, type Socket } from "node:net";
import { existsSync, unlinkSync, statSync, chmodSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { encodeFrame, FrameDecoder } from "@osstack/hermes-adapter";
import {
  openDb, PIIRedactor, routeCapability,
  PolicyEngine, DEFAULT_RULES, sqliteHistory,
  HermesBridge, GBrainAdapter,
  initOtel, shutdownOtel, traceSpan, otelEnabled,
  KanbanRepository, KanbanNotifier, getBoard,
  type RoutableAdapter, type PolicyDecision,
  type CardStatus, type OutboundMessage,
} from "@osstack/core";
import type Database from "better-sqlite3";
import { defaultAdapters, type AgentAdapter, type AgentTask } from "@osstack/agents";
import { appendEvent, finalizeRun, insertRun, insertTask } from "./store.js";

export const DEFAULT_SOCKET_PATH = "/tmp/osstack.sock";
const DAEMON_VERSION = "0.0.0";
const DAEMON_PHASE = "S1.5-controls";

function osstackHome(): string {
  return process.env["OSSTACK_HOME"] ?? join(process.env["HOME"] ?? "", ".osstack");
}

interface DaemonRequest {
  id: string | number;
  method: string;
  params?: unknown;
}

interface SingleResponse {
  id: string | number;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string };
}

interface DaemonContext {
  dbPath: string;
  db: Database.Database;
  redactor: PIIRedactor;
  adapters: Map<string, AgentAdapter>;
  policy: PolicyEngine;
  hermes: HermesBridge;
  gbrain: GBrainAdapter;
  /** osstack's own kanban board (borrowed from Hermes; see core/src/kanban). */
  kanban: KanbanRepository;
  /** Active runs by run_id → AbortController for cancellation. */
  activeRuns: Map<string, AbortController>;
  /** Kanban task_ids per osstack run_id, set when bridge create succeeds. */
  hermesKanbanByRun: Map<string, string>;
}

function singleOk(id: DaemonRequest["id"], result: unknown): SingleResponse {
  return { id, ok: true, result };
}
function singleErr(id: DaemonRequest["id"], code: string, message: string): SingleResponse {
  return { id, ok: false, error: { code, message } };
}

// ──────────────────────────────────────────────────────────────────────
// Single-shot methods
// ──────────────────────────────────────────────────────────────────────

async function handleSingle(ctx: DaemonContext, req: DaemonRequest): Promise<SingleResponse | null> {
  switch (req.method) {
    case "version":
      return singleOk(req.id, { version: DAEMON_VERSION, phase: DAEMON_PHASE });

    case "health":
      return singleOk(req.id, {
        version: DAEMON_VERSION,
        phase: DAEMON_PHASE,
        pid: process.pid,
        uptime_s: Math.round(process.uptime()),
        memory_rss_mb: Math.round(process.memoryUsage.rss() / 1024 / 1024),
        db_path: ctx.dbPath,
        adapters: Array.from(ctx.adapters.keys()),
        active_runs: ctx.activeRuns.size,
        otel_enabled: otelEnabled(),
        hermes_enabled: ctx.hermes.enabled,
        gbrain_enabled: ctx.gbrain.enabled,
      });

    case "agent.list":
      return singleOk(
        req.id,
        await Promise.all(
          Array.from(ctx.adapters.values()).map(async (a) => ({
            id: a.id,
            display_name: a.display_name,
            cost_tier: a.cost_tier,
            available: await a.isAvailable(),
            capabilities: a.capabilities().map((c) => ({ id: c.id, kind: c.kind })),
          })),
        ),
      );

    case "run.status": {
      const p = (req.params ?? {}) as { run_id?: string };
      if (typeof p.run_id !== "string") return singleErr(req.id, "bad_request", "params.run_id required");
      const row = ctx.db.prepare(
        `SELECT r.run_id, r.task_id, r.session_id, r.agent_id, r.capability_id, r.phase,
                r.outcome, r.started_at, r.completed_at, r.duration_ms,
                r.tokens_in, r.tokens_out, r.retry_count, r.human_intervention_count,
                r.pii_redacted_count, t.title, t.status AS task_status
         FROM runs r JOIN tasks t ON t.task_id = r.task_id
         WHERE r.run_id = ?`,
      ).get(p.run_id);
      if (row === undefined) return singleErr(req.id, "not_found", `no run with id=${p.run_id}`);
      const active = ctx.activeRuns.has(p.run_id);
      return singleOk(req.id, { ...(row as object), active });
    }

    case "task.cancel": {
      const p = (req.params ?? {}) as { run_id?: string };
      if (typeof p.run_id !== "string") return singleErr(req.id, "bad_request", "params.run_id required");
      const ac = ctx.activeRuns.get(p.run_id);
      if (!ac) return singleErr(req.id, "not_active", `run_id=${p.run_id} is not currently active`);
      ac.abort();
      return singleOk(req.id, { cancelled: true, run_id: p.run_id });
    }

    case "stats":
      return singleOk(req.id, computeStats(ctx.db));

    case "hermes.health":
      return singleOk(req.id, {
        enabled: ctx.hermes.enabled,
        bin: ctx.hermes.bin,
        board: ctx.hermes.board,
        check: await ctx.hermes.healthCheck(),
        active_kanban_links: ctx.hermesKanbanByRun.size,
      });

    case "killswitch.check": {
      // F4: if policy hasn't been making decisions over a meaningful window,
      // the project-manager Agent isn't earning its keep. Report TRIPPED so
      // the user can decide whether to demote osstack back to a thin proxy.
      const windowDays = 30;
      const minFires = 30;
      const cutoff = Date.now() / 1000 - windowDays * 86400;
      // "policy decision" proxy: runs with >=2 candidate adapters available
      // and an outcome recorded. For S5 we approximate by counting runs in
      // the window, since every recent task went through the policy engine.
      const observed = (ctx.db.prepare(
        "SELECT COUNT(*) AS c FROM runs WHERE started_at >= ?",
      ).get(cutoff) as { c: number }).c;
      const armed = observed >= minFires;
      const recommendation = armed
        ? "Policy is firing enough to learn from. Keep going."
        : `Only ${observed} runs in the last ${windowDays} days (need ${minFires}). Either submit more work through osstack, or consider demoting it to a thin proxy.`;
      return singleOk(req.id, {
        window_days: windowDays,
        min_fires: minFires,
        observed,
        armed,
        recommendation,
      });
    }

    // ── 7 Hermes controls: cancel (above) + approval/clarify/queue/goal ──

    case "approval.resolve": {
      const p = (req.params ?? {}) as { approval_id?: string; choice?: string };
      if (typeof p.approval_id !== "string" || typeof p.choice !== "string") {
        return singleErr(req.id, "bad_request", "params.approval_id and params.choice required");
      }
      const r = ctx.db.prepare("SELECT status FROM approvals WHERE approval_id = ?").get(p.approval_id) as { status?: string } | undefined;
      if (!r) return singleErr(req.id, "not_found", `no approval with id=${p.approval_id}`);
      if (r.status !== "pending") return singleErr(req.id, "already_resolved", `approval status=${r.status}`);
      ctx.db.prepare(
        "UPDATE approvals SET status = 'accepted', resolved_at = ?, choice = ? WHERE approval_id = ?",
      ).run(Date.now() / 1000, p.choice, p.approval_id);
      return singleOk(req.id, { resolved: true, approval_id: p.approval_id, choice: p.choice });
    }

    case "approval.list": {
      const p = (req.params ?? {}) as { run_id?: string; status?: string };
      let sql = "SELECT approval_id, run_id, status, action_summary, risk, requested_at, resolved_at, choice FROM approvals WHERE 1=1";
      const args: unknown[] = [];
      if (typeof p.run_id === "string") { sql += " AND run_id = ?"; args.push(p.run_id); }
      if (typeof p.status === "string") { sql += " AND status = ?"; args.push(p.status); }
      sql += " ORDER BY requested_at DESC LIMIT 200";
      return singleOk(req.id, ctx.db.prepare(sql).all(...args));
    }

    case "clarify.resolve": {
      const p = (req.params ?? {}) as { clarify_id?: string; answer?: string };
      if (typeof p.clarify_id !== "string" || typeof p.answer !== "string") {
        return singleErr(req.id, "bad_request", "params.clarify_id and params.answer required");
      }
      const r = ctx.db.prepare("SELECT status FROM clarifies WHERE clarify_id = ?").get(p.clarify_id) as { status?: string } | undefined;
      if (!r) return singleErr(req.id, "not_found", `no clarify with id=${p.clarify_id}`);
      if (r.status !== "pending") return singleErr(req.id, "already_resolved", `clarify status=${r.status}`);
      ctx.db.prepare(
        "UPDATE clarifies SET status = 'answered', resolved_at = ?, answer = ? WHERE clarify_id = ?",
      ).run(Date.now() / 1000, p.answer, p.clarify_id);
      return singleOk(req.id, { resolved: true, clarify_id: p.clarify_id });
    }

    case "clarify.list": {
      const p = (req.params ?? {}) as { run_id?: string; status?: string };
      let sql = "SELECT clarify_id, run_id, status, question, requested_at, resolved_at, answer FROM clarifies WHERE 1=1";
      const args: unknown[] = [];
      if (typeof p.run_id === "string") { sql += " AND run_id = ?"; args.push(p.run_id); }
      if (typeof p.status === "string") { sql += " AND status = ?"; args.push(p.status); }
      sql += " ORDER BY requested_at DESC LIMIT 200";
      return singleOk(req.id, ctx.db.prepare(sql).all(...args));
    }

    // ── Kanban (osstack's own board; the Telegram-subscribable surface) ──

    case "kanban.board": {
      const p = (req.params ?? {}) as { board?: string; assignee?: string; include_archived?: boolean; since?: number };
      const view = getBoard(ctx.kanban, {
        ...(p.board !== undefined ? { board: p.board } : {}),
        ...(p.assignee !== undefined ? { assignee: p.assignee } : {}),
        ...(p.include_archived !== undefined ? { includeArchived: p.include_archived } : {}),
        ...(p.since !== undefined ? { since: p.since } : {}),
      });
      return singleOk(req.id, view);
    }

    case "kanban.create": {
      const p = (req.params ?? {}) as { title?: string; body?: string; board?: string; priority?: number; assignee?: string; status?: CardStatus };
      if (typeof p.title !== "string" || p.title.trim() === "") {
        return singleErr(req.id, "bad_request", "params.title required");
      }
      const card = ctx.kanban.createCard({
        card_id: `card_${randomUUID().slice(0, 8)}`,
        title: p.title,
        ...(p.body !== undefined ? { body: p.body } : {}),
        ...(p.board !== undefined ? { board: p.board } : {}),
        ...(p.priority !== undefined ? { priority: p.priority } : {}),
        ...(p.assignee !== undefined ? { assignee: p.assignee } : {}),
        ...(p.status !== undefined ? { status: p.status } : {}),
      });
      return singleOk(req.id, card);
    }

    case "kanban.move": {
      const p = (req.params ?? {}) as { card_id?: string; status?: CardStatus; blocked_reason?: string; actor?: string };
      if (typeof p.card_id !== "string" || typeof p.status !== "string") {
        return singleErr(req.id, "bad_request", "params.card_id and params.status required");
      }
      try {
        const card = ctx.kanban.moveCard(p.card_id, p.status, {
          ...(p.blocked_reason !== undefined ? { blocked_reason: p.blocked_reason } : {}),
          ...(p.actor !== undefined ? { actor: p.actor } : {}),
        });
        return singleOk(req.id, card);
      } catch (err) {
        return singleErr(req.id, "move_failed", (err as Error).message);
      }
    }

    case "kanban.comment": {
      const p = (req.params ?? {}) as { card_id?: string; author?: string; body?: string };
      if (typeof p.card_id !== "string" || typeof p.body !== "string") {
        return singleErr(req.id, "bad_request", "params.card_id and params.body required");
      }
      try {
        const c = ctx.kanban.addComment(p.card_id, p.author ?? "user", p.body);
        return singleOk(req.id, c);
      } catch (err) {
        return singleErr(req.id, "comment_failed", (err as Error).message);
      }
    }

    case "kanban.subscribe": {
      const p = (req.params ?? {}) as { card_id?: string; platform?: string; chat_id?: string; thread_id?: string; user_id?: string };
      if (typeof p.card_id !== "string" || typeof p.platform !== "string" || typeof p.chat_id !== "string") {
        return singleErr(req.id, "bad_request", "params.card_id, params.platform, params.chat_id required");
      }
      try {
        const sub = ctx.kanban.subscribe({
          card_id: p.card_id, platform: p.platform, chat_id: p.chat_id,
          ...(p.thread_id !== undefined ? { thread_id: p.thread_id } : {}),
          ...(p.user_id !== undefined ? { user_id: p.user_id } : {}),
        });
        return singleOk(req.id, sub);
      } catch (err) {
        return singleErr(req.id, "subscribe_failed", (err as Error).message);
      }
    }

    case "kanban.unsubscribe": {
      const p = (req.params ?? {}) as { card_id?: string; platform?: string; chat_id?: string; thread_id?: string };
      if (typeof p.card_id !== "string" || typeof p.platform !== "string" || typeof p.chat_id !== "string") {
        return singleErr(req.id, "bad_request", "params.card_id, params.platform, params.chat_id required");
      }
      const removed = ctx.kanban.unsubscribe(p.card_id, p.platform, p.chat_id, p.thread_id ?? "");
      return singleOk(req.id, { removed });
    }

    case "kanban.events": {
      // Drain pending events per subscription; returns the messages a caller
      // (e.g. the Hermes Telegram relay) should deliver, then advances cursors.
      const p = (req.params ?? {}) as { since?: number; card_id?: string; board?: string };
      const sinceId = typeof p.since === "number" ? p.since : 0;
      const events = ctx.kanban.eventsSince(sinceId, {
        ...(p.card_id !== undefined ? { card_id: p.card_id } : {}),
        ...(p.board !== undefined ? { board: p.board } : {}),
        limit: 200,
      });
      return singleOk(req.id, {
        events,
        latest_event_id: ctx.kanban.latestEventId(p.board ?? "default"),
      });
    }

    case "kanban.subscriptions": {
      const p = (req.params ?? {}) as { card_id?: string };
      return singleOk(req.id, ctx.kanban.listSubscriptions(
        p.card_id !== undefined ? { card_id: p.card_id } : {},
      ));
    }

    case "kanban.drain": {
      // Run the notifier server-side with a COLLECTING transport: it formats
      // each subscription's pending events into a message, advances the
      // per-sub cursor, and we return the messages for the caller (the
      // Hermes Telegram relay) to deliver. This is the simplest path for
      // "push osstack board progress to a chat".
      const collected: OutboundMessage[] = [];
      const notifier = new KanbanNotifier(ctx.kanban, async (msg) => { collected.push(msg); });
      const delivered = await notifier.drain();
      return singleOk(req.id, { delivered, messages: collected });
    }

    case "task.submit":
    case "task.observe":
      // Streaming; not handled here.
      return null;

    default:
      return singleErr(req.id, "unknown_method", `unknown method: ${req.method}`);
  }
}

// ──────────────────────────────────────────────────────────────────────
// stats query
// ──────────────────────────────────────────────────────────────────────

interface AgentStat {
  agent_id: string;
  capability_id: string;
  runs: number;
  completed: number;
  failed: number;
  cancelled: number;
  in_flight: number;
  avg_duration_ms: number | null;
  total_tokens_in: number;
  total_tokens_out: number;
  total_pii_redacted: number;
}

interface DaemonStats {
  total_runs: number;
  total_events: number;
  per_agent: AgentStat[];
  generated_at: number;
}

function computeStats(db: Database.Database): DaemonStats {
  const total_runs = (db.prepare("SELECT COUNT(*) AS c FROM runs").get() as { c: number }).c;
  const total_events = (db.prepare("SELECT COUNT(*) AS c FROM events").get() as { c: number }).c;
  const rows = db.prepare(
    `SELECT agent_id, capability_id,
            COUNT(*) AS runs,
            SUM(CASE WHEN outcome = 'completed' THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) AS failed,
            SUM(CASE WHEN outcome = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
            SUM(CASE WHEN outcome IS NULL THEN 1 ELSE 0 END) AS in_flight,
            AVG(duration_ms) AS avg_duration_ms,
            SUM(tokens_in) AS total_tokens_in,
            SUM(tokens_out) AS total_tokens_out,
            SUM(pii_redacted_count) AS total_pii_redacted
     FROM runs
     GROUP BY agent_id, capability_id
     ORDER BY agent_id, capability_id`,
  ).all() as AgentStat[];
  return { total_runs, total_events, per_agent: rows, generated_at: Date.now() / 1000 };
}

// ──────────────────────────────────────────────────────────────────────
// task.submit (streaming)
// ──────────────────────────────────────────────────────────────────────

interface TaskSubmitParams {
  prompt: string;
  title?: string;
  hermes_session_id?: string | null;
  capability_id?: string;
  /** CapabilityKind shortcut (e.g. "code.write"). Router picks the cheapest matching adapter. */
  kind?: string;
  agent_id?: string;
  /** Structured context handed to the adapter (e.g. autoresearch tag/max_iterations). */
  context?: Record<string, unknown>;
}

async function handleTaskSubmit(
  ctx: DaemonContext,
  req: DaemonRequest,
  sock: Socket,
): Promise<void> {
  const params = (req.params ?? {}) as TaskSubmitParams;
  if (typeof params.prompt !== "string" || params.prompt.length === 0) {
    sock.write(encodeFrame(singleErr(req.id, "bad_request", "params.prompt (non-empty string) required")));
    return;
  }

  // S2 router gives us a baseline candidate. S3 policy refines it.
  type RouteReq = Parameters<typeof routeCapability>[0];
  type RouteKind = NonNullable<RouteReq["kind"]>;
  const routeReq: RouteReq = {};
  if (params.capability_id !== undefined) routeReq.capability_id = params.capability_id;
  if (typeof params.kind === "string") routeReq.kind = params.kind as RouteKind;
  if (params.agent_id !== undefined) routeReq.agent_id = params.agent_id;
  const routerPick = await routeCapability(
    routeReq,
    Array.from(ctx.adapters.values()) as readonly RoutableAdapter[],
  );
  if (routerPick === null) {
    sock.write(encodeFrame(singleErr(req.id, "no_route", "no available adapter can serve this task")));
    return;
  }

  let chosenAgentId = routerPick.adapter.id;
  let chosenCapId = routerPick.capability.id;
  let routingReason = routerPick.reason;
  let policyDecision: PolicyDecision | null = null;
  let handoffNotice: string | undefined;

  // Run policy when the choice was kind-based (i.e. multiple adapters could
  // potentially have served the task). Skip for explicit overrides since
  // those represent a deliberate user choice.
  const isOverride = params.agent_id !== undefined
    || (params.capability_id !== undefined && routerPick.reason.startsWith("exact"));
  if (!isOverride) {
    const kind = routerPick.capability.kind;
    const candidates = Array.from(ctx.adapters.values()).map((a) => ({
      agent_id: a.id,
      cost_tier: a.cost_tier,
      capabilities: a.capabilities(),
    }));
    // Filter to adapters that actually advertise the kind AND are available.
    const eligible: typeof candidates = [];
    for (const c of candidates) {
      if (!c.capabilities.some((cap) => cap.kind === kind)) continue;
      const adapter = ctx.adapters.get(c.agent_id);
      if (!adapter) continue;
      const a = await adapter.isAvailable();
      if (a.available) eligible.push(c);
    }
    if (eligible.length >= 2) {
      policyDecision = ctx.policy.decide(
        { capability_id: routerPick.capability.id, kind, phase: "code", prompt: params.prompt },
        eligible,
        sqliteHistory(ctx.db),
      );
      if (policyDecision.winner) {
        chosenAgentId = policyDecision.winner.candidate.agent_id;
        // Find the capability with the matching kind on the chosen adapter.
        const chosenAdapter = ctx.adapters.get(chosenAgentId);
        const cap = chosenAdapter?.capabilities().find((c) => c.kind === kind);
        if (cap) chosenCapId = cap.id;
        const breakdownStr = policyDecision.winner.breakdown
          .map((b) => `${b.rule_id}=${b.value > 0 ? "+" : ""}${b.value.toFixed(1)}`)
          .join(", ");
        routingReason = `policy[${breakdownStr || "no rule scored"}], total=${policyDecision.winner.total.toFixed(1)}`;
        if (policyDecision.handoff.triggered) {
          handoffNotice = policyDecision.handoff.reason ?? "handoff_triggered";
        }
      }
    }
  }

  const adapter = ctx.adapters.get(chosenAgentId);
  if (!adapter) {
    sock.write(encodeFrame(singleErr(req.id, "internal", `router selected agent_id=${chosenAgentId} but no adapter found`)));
    return;
  }
  const agentId = adapter.id;
  const selectedCapId = chosenCapId;

  const redact = ctx.redactor.redact(params.prompt);
  const cleanPrompt = redact.text;
  const piiRedactedCount = Object.values(redact.stats.counts).reduce((a, b) => a + b, 0);

  const task_id = `task_${randomUUID().slice(0, 8)}`;
  const run_id = `run_${randomUUID().slice(0, 8)}`;
  const session_id = params.hermes_session_id ?? `sess_${randomUUID().slice(0, 8)}`;
  const capability_id = selectedCapId;
  const startedAt = Date.now() / 1000;

  try {
    insertTask(ctx.db, ctx.dbPath, {
      task_id,
      title: params.title ?? cleanPrompt.slice(0, 80),
      ...(params.hermes_session_id != null ? { hermes_session_id: params.hermes_session_id } : {}),
      created_at: startedAt,
    });
    insertRun(ctx.db, ctx.dbPath, {
      run_id, task_id, session_id, agent_id: agentId, capability_id,
      phase: "code", started_at: startedAt,
      ...(params.hermes_session_id != null ? { hermes_session_id: params.hermes_session_id } : {}),
    });
    if (piiRedactedCount > 0) {
      ctx.db.prepare("UPDATE runs SET pii_redacted_count = ? WHERE run_id = ?")
        .run(piiRedactedCount, run_id);
    }
  } catch (err) {
    sock.write(encodeFrame(singleErr(req.id, "store_write_failed", (err as Error).message)));
    return;
  }

  const accepted: Record<string, unknown> = {
    type: "accepted",
    task_id, run_id, session_id,
    agent_id: agentId, capability_id,
    routing_reason: routingReason,
    pii_redacted_count: piiRedactedCount,
  };
  if (handoffNotice !== undefined) accepted["handoff_notice"] = handoffNotice;
  if (policyDecision !== null) {
    accepted["policy"] = {
      breakdown: policyDecision.winner?.breakdown ?? [],
      total: policyDecision.winner?.total ?? 0,
      handoff: policyDecision.handoff,
    };
  }
  sock.write(encodeFrame({ id: req.id, ok: true, result: accepted }));

  // osstack's own kanban: create a card for this run in the `running` lane.
  // This is the board Hermes/Telegram subscribes to. Best-effort; a card
  // write must never sink the run.
  try {
    ctx.kanban.createCard({
      card_id: `card_${run_id}`,
      task_id,
      title: params.title ?? cleanPrompt.slice(0, 80),
      body: `agent: ${agentId}\ncapability: ${capability_id}\nreason: ${routingReason}`,
      status: "running",
      assignee: agentId,
    });
  } catch (err) {
    process.stderr.write(`osstack: kanban.createCard failed: ${(err as Error).message}\n`);
  }

  // S4: mirror this task to Hermes kanban (best-effort, never blocks).
  void ctx.hermes.createKanbanTask({
    title: params.title ?? cleanPrompt.slice(0, 80),
    body: `osstack run\n• run_id: ${run_id}\n• agent: ${agentId}\n• capability: ${capability_id}\n• reason: ${routingReason}`,
    idempotencyKey: `osstack:${run_id}`,
    skills: ["osstack"],
  }).then((r) => {
    if (r.ok && r.task_id) ctx.hermesKanbanByRun.set(run_id, r.task_id);
    else if (!r.ok && r.reason !== "bridge_disabled") {
      process.stderr.write(`osstack: hermes.createKanbanTask failed: ${r.reason ?? "unknown"}\n`);
    }
  });

  const task: AgentTask = {
    run_id, task_id, session_id, capability_id, prompt: cleanPrompt,
    ...(params.context && typeof params.context === "object" ? { context: params.context } : {}),
  };
  const ac = new AbortController();
  ctx.activeRuns.set(run_id, ac);
  const onClose = (): void => ac.abort();
  sock.once("close", onClose);

  let lastOutcome: "completed" | "failed" | "cancelled" = "completed";
  let lastUsageTokensIn = 0;
  let lastUsageTokensOut = 0;
  try {
    for await (const ev of adapter.invoke(task, ac.signal)) {
      try {
        appendEvent(ctx.db, ctx.dbPath, ev);
      } catch (err) {
        process.stderr.write(`osstack: event persist failed: ${(err as Error).message}\n`);
      }
      if (ev.type === "usage.final") {
        const p = ev.payload as { tokens_in?: number; tokens_out?: number };
        lastUsageTokensIn = p.tokens_in ?? 0;
        lastUsageTokensOut = p.tokens_out ?? 0;
      }
      try { sock.write(encodeFrame(ev)); } catch { break; }
      if (ev.terminal) {
        if (ev.type === "done") {
          const status = (ev.payload as { status?: string }).status;
          if (status === "completed" || status === "failed" || status === "cancelled") lastOutcome = status;
        } else if (ev.type === "error") {
          lastOutcome = "failed";
        }
        break;
      }
    }
  } catch (err) {
    try {
      sock.write(encodeFrame({
        event_id: `${run_id}:err`,
        seq: -1, run_id, session_id,
        created_at: Date.now() / 1000, terminal: true, type: "error",
        payload: { code: "adapter_threw", message: (err as Error).message, terminal: true },
      }));
    } catch { /* socket gone */ }
    lastOutcome = "failed";
  } finally {
    sock.off("close", onClose);
    ctx.activeRuns.delete(run_id);
    try {
      finalizeRun(ctx.db, ctx.dbPath, run_id, lastOutcome, Date.now() / 1000);
      if (lastUsageTokensIn || lastUsageTokensOut) {
        ctx.db.prepare("UPDATE runs SET tokens_in = ?, tokens_out = ? WHERE run_id = ?")
          .run(lastUsageTokensIn, lastUsageTokensOut, run_id);
      }
    } catch { /* keep going */ }

    // osstack kanban: move the card to its terminal lane. completed → done,
    // failed/cancelled → blocked (with the reason) so the board shows what
    // needs attention. Any subscriber (Telegram via Hermes) gets the event.
    try {
      const cardId = `card_${run_id}`;
      if (ctx.kanban.getCard(cardId)) {
        const summary = `${lastOutcome} — tokens=${lastUsageTokensIn}/${lastUsageTokensOut}`;
        if (lastOutcome === "completed") {
          ctx.kanban.moveCard(cardId, "done", { actor: agentId });
        } else {
          ctx.kanban.moveCard(cardId, "blocked", { actor: agentId, blocked_reason: summary });
        }
      }
    } catch (err) {
      process.stderr.write(`osstack: kanban move failed: ${(err as Error).message}\n`);
    }

    // S4: post terminal status to Hermes kanban if we have a tracked task.
    const kanbanId = ctx.hermesKanbanByRun.get(run_id);
    if (kanbanId !== undefined) {
      ctx.hermesKanbanByRun.delete(run_id);
      const summary = `osstack run ${lastOutcome} — tokens=${lastUsageTokensIn}/${lastUsageTokensOut}`;
      if (lastOutcome === "completed") {
        void ctx.hermes.complete(kanbanId, summary);
      } else {
        void ctx.hermes.comment(kanbanId, `[osstack] ${summary}`);
      }
    }

    // S5b: write the run to gbrain's knowledge graph (best-effort).
    const completedAt = Date.now() / 1000;
    void ctx.gbrain.writeRunPage({
      run_id,
      task_title: params.title ?? cleanPrompt.slice(0, 80),
      agent_id: agentId,
      capability_id,
      outcome: lastOutcome,
      duration_ms: (completedAt - startedAt) * 1000,
      tokens_in: lastUsageTokensIn,
      tokens_out: lastUsageTokensOut,
      started_at: startedAt,
    }).then((r) => {
      if (!r.ok && r.reason !== "gbrain_disabled") {
        process.stderr.write(`osstack: gbrain.writeRunPage failed: ${r.reason ?? "unknown"}\n`);
      }
    });
  }
}

// ──────────────────────────────────────────────────────────────────────
// task.observe (streaming replay)
// ──────────────────────────────────────────────────────────────────────

interface TaskObserveParams {
  run_id: string;
  after_seq?: number;
  /** Alternative cursor format compatible with the Hermes Run Adapter spec. */
  last_event_id?: string;
}

function handleTaskObserve(
  ctx: DaemonContext,
  req: DaemonRequest,
  sock: Socket,
): void {
  const params = (req.params ?? {}) as TaskObserveParams;
  if (typeof params.run_id !== "string") {
    sock.write(encodeFrame(singleErr(req.id, "bad_request", "params.run_id required")));
    return;
  }

  let afterSeq = params.after_seq ?? -1;
  if (typeof params.last_event_id === "string") {
    const m = params.last_event_id.match(/:(\d+)$/);
    if (m?.[1]) afterSeq = Math.max(afterSeq, Number.parseInt(m[1], 10));
  }

  // Acknowledge first.
  sock.write(encodeFrame({
    id: req.id, ok: true,
    result: { type: "accepted", run_id: params.run_id, after_seq: afterSeq, active: ctx.activeRuns.has(params.run_id) },
  }));

  // Snapshot replay from the events log. S1 is snapshot-only; S2 will add
  // live subscription via an internal event bus. Snapshot still works for
  // terminal runs (Hermes RFC Slice-1 success criterion).
  const rows = ctx.db.prepare(
    "SELECT event_id, run_id, session_id, seq, type, created_at, terminal, payload_json FROM events WHERE run_id = ? AND seq > ? ORDER BY seq ASC",
  ).all(params.run_id, afterSeq) as Array<{
    event_id: string; run_id: string; session_id: string; seq: number;
    type: string; created_at: number; terminal: number; payload_json: string;
  }>;

  for (const row of rows) {
    const ev = {
      event_id: row.event_id,
      seq: row.seq,
      run_id: row.run_id,
      session_id: row.session_id,
      created_at: row.created_at,
      terminal: row.terminal === 1,
      type: row.type,
      payload: safeParse(row.payload_json),
    };
    try { sock.write(encodeFrame(ev)); } catch { return; }
    if (row.terminal === 1) return;
  }

  // No terminal event in the log: tell the caller whether we expect more
  // (active) or whether replay is exhausted (orphaned / interrupted run).
  if (!ctx.activeRuns.has(params.run_id)) {
    try {
      sock.write(encodeFrame({
        event_id: `${params.run_id}:replay-end`,
        seq: rows.length > 0 ? rows[rows.length - 1]!.seq + 1 : 0,
        run_id: params.run_id, session_id: "",
        created_at: Date.now() / 1000, terminal: true, type: "error",
        payload: { code: "replay_no_terminal", message: "log ended without terminal event (likely a previous daemon crash)", terminal: true },
      }));
    } catch { /* socket gone */ }
  }
  // If the run is active but we have no live subscriber, the caller can
  // re-issue task.observe with the new after_seq cursor — RFC reconnect.
}

function safeParse(s: string): unknown {
  try { return JSON.parse(s); } catch { return { _raw: s }; }
}

// ──────────────────────────────────────────────────────────────────────
// boot / shutdown
// ──────────────────────────────────────────────────────────────────────

function cleanupStaleSocket(path: string): void {
  if (!existsSync(path)) return;
  try {
    const st = statSync(path);
    if (!st.isSocket()) throw new Error(`Refusing to remove non-socket file at ${path}`);
    unlinkSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
    throw err;
  }
}

function buildContext(): DaemonContext {
  const home = osstackHome();
  if (!existsSync(home)) mkdirSync(home, { recursive: true });
  const dbPath = join(home, "state.db");
  if (!existsSync(dirname(dbPath))) mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDb({ path: dbPath });
  const redactor = new PIIRedactor();
  const adapters = new Map<string, AgentAdapter>();

  // Register adapters from the shared default registry (also used by the OS
  // Deck CLI, so daemon and `osstack deck` agree on which agents exist). Order
  // doesn't matter once policy ranks them; each adapter's isAvailable() gates
  // whether it's a viable route on this machine.
  for (const a of defaultAdapters()) {
    adapters.set(a.id, a);
  }

  const policy = new PolicyEngine({ rules: DEFAULT_RULES });
  const hermes = new HermesBridge();   // disabled unless HERMES_KANBAN_BOARD is set
  const gbrain = new GBrainAdapter();  // disabled unless OSSTACK_GBRAIN=1
  const kanban = new KanbanRepository(db, dbPath);
  return {
    dbPath, db, redactor, adapters, policy, hermes, gbrain, kanban,
    activeRuns: new Map(),
    hermesKanbanByRun: new Map(),
  };
}

export interface DaemonHandles {
  close: () => Promise<void>;
  socketPath: string;
  dbPath: string;
}

export function startDaemon(opts: { socketPath?: string } = {}): Promise<DaemonHandles> {
  const socketPath = opts.socketPath ?? process.env["OSSTACK_SOCKET"] ?? DEFAULT_SOCKET_PATH;
  cleanupStaleSocket(socketPath);
  // Bring up OTel before the daemon context so spans capture everything.
  initOtel({ serviceVersion: DAEMON_VERSION });
  const ctx = buildContext();

  const server = createServer((sock: Socket) => {
    const decoder = new FrameDecoder();

    sock.on("data", (chunk) => {
      try {
        const frames = decoder.push(chunk);
        for (const raw of frames) {
          const req = raw as DaemonRequest;
          if (typeof req !== "object" || req === null || typeof req.method !== "string") {
            sock.write(encodeFrame(singleErr(req?.id ?? 0, "bad_request", "request must have a 'method' string")));
            continue;
          }

          if (req.method === "task.submit") {
            void traceSpan(
              "osstack.task.submit",
              { "osstack.method": req.method },
              () => handleTaskSubmit(ctx, req, sock),
            );
            continue;
          }
          if (req.method === "task.observe") {
            void traceSpan(
              "osstack.task.observe",
              { "osstack.method": req.method },
              async () => handleTaskObserve(ctx, req, sock),
            );
            continue;
          }

          void traceSpan(
            "osstack.rpc",
            { "osstack.method": req.method },
            async () => {
              const resp = await handleSingle(ctx, req);
              if (resp === null) return;
              try { sock.write(encodeFrame(resp)); } catch { /* socket gone */ }
            },
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        try { sock.write(encodeFrame({ id: 0, ok: false, error: { code: "framing", message } })); } catch { /* socket dead */ }
        sock.destroy();
      }
    });

    sock.on("error", () => { /* don't crash on client hangups */ });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      try { chmodSync(socketPath, 0o600); } catch { /* best effort */ }

      const shutdown = async (): Promise<void> => {
        // Abort any active runs so adapters get a chance to clean up.
        for (const ac of ctx.activeRuns.values()) ac.abort();
        await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
        try { ctx.db.close(); } catch { /* swallow */ }
        try { cleanupStaleSocket(socketPath); } catch { /* swallow */ }
        await shutdownOtel();
      };
      const onSig = (): void => { void shutdown().then(() => process.exit(0)); };
      process.once("SIGTERM", onSig);
      process.once("SIGINT", onSig);

      resolve({ close: shutdown, socketPath, dbPath: ctx.dbPath });
    });
  });
}
