import { graphUpgradeHolds } from './graph-upgrade-guard.js';
import type { GraphRpcService, GraphRpcOptions } from './graph-rpc.js';
import type { GraphRuntime, GraphRuntimeConfiguration } from "./graph-runtime.js";
import type { GraphCheckpointResponse } from "@osstack/protocol";
import type { GraphCheckpointBinding, GraphCheckpointService } from "./graph-checkpoint-service.js";
import type { GraphActionBroker } from "./graph-action-broker.js";
import { boundedAdapterEvents, confirmAdapterStopped } from "./adapter-lifecycle.js";
import { GovernedExecution, type ExecutionLease, type AdmissionInput } from "./governed-execution.js";
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
import { readFile, rename, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, resolve as resolveWorkspacePath } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { encodeFrame, FrameDecoder, type HermesEvent } from "@osstack/hermes-adapter";
import {
  DiscoveryPolicy,
  LessonDraftConfig,
  LoopBudget,
  LoopEngine,
  LoopWaitReason,
  LoopKnowledgeTrace,
  LoopProfileRoutingEvidence,
  checkBudget,
  nextCronDelayMs,
  validateCronExpression,
  readLoopState,
  renderLoopStateMarkdown,
  type LoopBudgetStatus,
  type LoopRunCyclesOptions,
  type LoopRunCyclesResult,
  type LoopRunOptions,
  type LoopRunResult,
  type LoopKnowledgeTrace as LoopKnowledgeTraceType,
  type LoopProfileRoutingEvidence as LoopProfileRoutingEvidenceType,
  type CompletedTask,
} from "@osstack/loop";
import {
  AgentOverrideError,
  reserveSessionInstruction,
  AttentionActions,
  countEvents,
  countRuns,
  countRunsSince,
  DEFAULT_RULES,
  GBrainAdapter,
  getBoard,
  HermesBridge,
  initOtel,
  KanbanNotifier,
  KanbanRepository,
  listEventsForRun,
  otelEnabled,
  PIIRedactor,
  PolicyEngine,
  routeCapability,
  SessionMessageIdConflict,
  SessionRepository,
  SessionContinuationRepository,
  SessionVersionConflict,
  shutdownOtel,
  sqliteHistory,
  traceSpan,
  type CardStatus,
  type OutboundMessage,
  type PolicyDecision,
  type RoutableAdapter,
} from "@osstack/core";
import { guardedOpenDb as openDb } from "./guarded-open-db.js";
import { RpcLatencyRecorder, type RpcMethodLatency } from "./rpc-latency.js";
import type Database from "better-sqlite3";
import {
  AgentSessionEventSchema,
  defaultAdapters,
  createControlledSessionAdapter,
  isControlledSessionAdapter,
  isSessionCapableAdapter,
  type AgentAdapter,
  type AgentSessionEvent,
  type AgentSessionInput,
  type AgentTask,
  type SessionCapableAdapter,
} from "@osstack/agents";
import { appendEvent, finalizeRun, insertRun, insertTask } from "./store.js";
import {
  getAutonomyRun,
  listResumableAutonomyRuns,
} from "@osstack/core";
import {
  DEFAULT_READ_CONCURRENCY,
  DEFAULT_WRITE_CONCURRENCY,
  FifoSemaphore,
  SemaphoreAcquireAbortedError,
  type GuardedDeliveryResult,
} from "@osstack/autonomy";
import {
  ScopedApprovalDecision,
  SessionDecision,
  type ScopedApprovalDecision as ScopedApprovalDecisionType,
} from "@osstack/protocol";
import { makeRepositoryPolicyGate } from "./repository-policy.js";
import { SessionCollaborator, readContinuationTrust } from "./session-collaborator.js";
import { describeSessionWait } from "./session-wait.js";
import { runDailyBrief } from "./daily-command.js";
import { resolveRepositoryScope } from "@osstack/core";
import { osstackHome, pidFilePath, resolveSocketPath } from "./paths.js";
import { PROTOCOL_VERSION, VERSION } from "./version.js";
import { readUpdateCache, startUpdateChecker } from "./update-check.js";
import { acquireDaemonLock } from "./daemon-lock.js";
import {
  runAutonomyHealth,
  type AutonomyHealthReport,
} from "./autonomy-health.js";
import {
  drainAutonomyNotifications,
  type AutonomyNotificationSender,
} from "./autonomy-notification.js";
import {
  ClockJumpDetector,
  enforceAutonomyRetention,
} from "./autonomy-host.js";
import {
  createDashboardSnapshot,
  dashboardUrl,
  dashboardUrlFromEnv,
  startDashboardServer,
  type DashboardServerHandle,
} from "./dashboard.js";
import {
  runLoopNeatFinalizer,
  type LoopNeatFinalizerResultV1,
} from "./loop-neat-finalizer.js";

import { localAttentionSender } from "./attention-local-delivery.js";
import { SupervisionService } from "./supervision-service.js";

const DAEMON_VERSION = VERSION;
const DAEMON_PHASE = "S1.5-controls";
const LOOP_FAILURE_STREAK_THRESHOLD = 3;
/** Auto-stop a daily session after this many consecutive brief failures (R2.3). */
const DAILY_FAILURE_STOP_THRESHOLD = 5;

interface ArtifactVerificationOptions {
  requireGitDiff?: boolean;
  targetPaths?: string[];
  forbiddenPaths?: string[];
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
  deploymentIdentity?: import("./home-inventory.js").DeploymentIdentity;
  dbPath: string;
  loopSessionsPath: string;
  dailySessionsPath: string;
  db: Database.Database;
  redactor: PIIRedactor;
  adapters: Map<string, AgentAdapter>;
  policy: PolicyEngine;
  hermes: HermesBridge;
  gbrain: GBrainAdapter;
  /** osstack's own kanban board (borrowed from Hermes; see core/src/kanban). */
  kanban: KanbanRepository;
  /** Durable, versioned control plane for resumable agent conversations. */
  sessions: SessionRepository;
  continuations: SessionContinuationRepository;
  collaborator: SessionCollaborator | undefined;
  supervision?: SupervisionService;
  workerViews?: import("./worker-view-service.js").WorkerViewService;
  /** Local browser dashboard, returned to chat bridges as a shareable URL. */
  dashboardUrl: string | null;
  /** Active runs by run_id → AbortController for cancellation. */
  activeRuns: Map<string, AbortController>;
  admission?: GovernedExecution;
  adapterWorkspaces?: ReadonlyMap<string, string>;
  /** Sessions currently applying a non-duplicate inbound message. */
  activeSessionSends: Map<string,string>;
  /** Daemon-managed polling loop sessions, keyed by loop_session_id. */
  loopSessions: Map<string, LoopSession>;
  /** Daemon-managed daily-brief sessions, keyed by daily_session_id (R2.3). */
  dailySessions: Map<string, DailySession>;
  /** Kanban task_ids per osstack run_id, set when bridge create succeeds. */
  hermesKanbanByRun: Map<string, string>;
  /** Per-method RPC latency windows, surfaced via the stats method. */
  rpcLatency: RpcLatencyRecorder;
  /**
   * True when `draining` was raised by the autonomy health probe (low disk,
   * lost push/deploy) rather than by an operator/upgrade `daemon.drain`.
   * Only a health-raised drain may auto-clear — clearing an upgrade's drain
   * would resurrect the daemon mid-swap.
   */
  drainingFromHealth: boolean;
  /** When true (set by daemon.drain), new task.submit calls are rejected. */
  draining: boolean;
  /** Graceful shutdown trigger, wired up by startDaemon once the server is live. */
  requestShutdown: () => void;
  /** Durable guarded-delivery recovery port, configured by the product entrypoint. */
  guardedAutonomy: GuardedAutonomyDaemonRuntime | undefined;
  /** Whole-machine bounded concurrency, independent for writes and reads. */
  writeSemaphore: FifoSemaphore;
  readSemaphore: FifoSemaphore;
  /** Per-repository writer queues; file locks enforce cross-process ownership. */
  repoWriteSemaphores: Map<string, FifoSemaphore>;
  /** Latest operational gate and the probe used to refresh it. */
  autonomyHealth: () => Promise<AutonomyHealthReport>;
  lastAutonomyHealth: AutonomyHealthReport | undefined;
}

export interface GuardedAutonomyDaemonRuntime {
  resume(
    autonomyRunId: string,
    decision?: ScopedApprovalDecisionType,
    options?: { recoveryKind?: "restart" },
  ): Promise<GuardedDeliveryResult>;
}

type LoopSessionStatus = "running" | "stopping" | "stopped" | "failed";

interface LoopSession {
  loopSessionId: string;
  workspacePath: string;
  stateFilePath: string;
  intervalMs: number;
  stopWhenIdle: boolean;
  status: LoopSessionStatus;
  startedAt: number;
  updatedAt: number;
  cycleCount: number;
  discoveredTaskCount: number;
  executedTaskCount: number;
  skippedTaskCount: number;
  successfulTaskCount: number;
  failedTaskCount: number;
  escalatedTaskCount: number;
  tokensConsumed: number;
  costConsumed: number;
  totalCycleDurationMs: number;
  failureStreaks: Record<string, LoopFailureStreak>;
  /** Consecutive cycles that executed tasks without a success (budget input). */
  noProgressCycles: number;
  abort: AbortController;
  maxCycles?: number;
  /** Latest budget check when runOptions.budget is configured. */
  lastBudgetCheck?: LoopBudgetStatus;
  lastCycleDurationMs?: number;
  lastJsonPath?: string;
  lastMarkdownPath?: string;
  lastError?: string;
  stopReason?: string;
  waitReason?: LoopRunResult["state"]["wait_reason"];
  runOptions: LoopRunOptions;
  scheduleExpression?: string;
  shutdownRequested?: boolean;
  done?: Promise<void>;
}

interface LoopFailureStreak {
  capability: string;
  count: number;
  lastTaskId: string;
  updatedAt: number;
  lastEscalatedAtCount?: number;
}

interface PersistedLoopSessionsFile {
  version: 1;
  sessions: PersistedLoopSession[];
}

interface PersistedLoopSession {
  loopSessionId: string;
  status: LoopSessionStatus;
  runOptions: LoopRunOptions;
  intervalMs: number;
  stopWhenIdle: boolean;
  scheduleExpression?: string;
  startedAt: number;
  updatedAt: number;
  cycleCount: number;
  discoveredTaskCount: number;
  executedTaskCount: number;
  skippedTaskCount: number;
  successfulTaskCount?: number;
  failedTaskCount?: number;
  escalatedTaskCount?: number;
  tokensConsumed?: number;
  costConsumed?: number;
  totalCycleDurationMs?: number;
  failureStreaks?: Record<string, LoopFailureStreak>;
  noProgressCycles?: number;
  lastBudgetCheck?: LoopBudgetStatus;
  maxCycles?: number;
  lastCycleDurationMs?: number;
  lastJsonPath?: string;
  lastMarkdownPath?: string;
  lastError?: string;
  stopReason?: string;
  waitReason?: LoopRunResult["state"]["wait_reason"];
}

// ──────────────────────────────────────────────────────────────────────
// Daily-brief sessions (R2.3) — a read-only composition scheduled through the
// daemon, modeled on the loop-session pattern above (own map + JSON file +
// atomic persist + restore-on-start). NOT a LoopEngine: daily just re-runs the
// `runDailyBrief` core on an interval and records the latest result.
// ──────────────────────────────────────────────────────────────────────

type DailySessionStatus = "running" | "stopping" | "stopped" | "failed";

interface DailySession {
  dailySessionId: string;
  /** Repo registry path, resolved at schedule time and stored (survives restart). */
  registryPath: string;
  intervalMs: number;
  /** Recorded verbatim for humans; the interval is what drives execution. */
  scheduleExpression?: string;
  status: DailySessionStatus;
  startedAt: number;
  updatedAt: number;
  tickCount: number;
  lastBriefPath?: string;
  /** Status field of the latest strict AgentCommandResult (e.g. "ok"), or "error". */
  lastResultStatus?: string;
  consecutiveFailureCount: number;
  lastError?: string;
  stopReason?: string;
  abort: AbortController;
  shutdownRequested?: boolean;
  done?: Promise<void>;
}

interface PersistedDailySessionsFile {
  version: 1;
  sessions: PersistedDailySession[];
}

interface PersistedDailySession {
  dailySessionId: string;
  registryPath: string;
  intervalMs: number;
  scheduleExpression?: string;
  status: DailySessionStatus;
  startedAt: number;
  updatedAt: number;
  tickCount: number;
  lastBriefPath?: string;
  lastResultStatus?: string;
  consecutiveFailureCount: number;
  lastError?: string;
  stopReason?: string;
}

function singleOk(id: DaemonRequest["id"], result: unknown): SingleResponse {
  return { id, ok: true, result };
}
function singleErr(id: DaemonRequest["id"], code: string, message: string): SingleResponse {
  return { id, ok: false, error: { code, message } };
}

const TERMINAL_SESSION_STATES = new Set(["completed", "failed", "cancelled"]);

function publicSession(row: ReturnType<SessionRepository["getSession"]>): Record<string, unknown> | null {
  if (row === undefined) return null;
  return {
    session_id: row.session_id,
    task_id: row.task_id,
    run_id: row.run_id,
    agent_id: row.agent_id,
    runtime_id: row.agent_id,
    state: row.state,
    resume_supported: row.resume_supported,
    resume_ready: row.resume_supported
      && row.native_session_id !== null
      && !TERMINAL_SESSION_STATES.has(row.state),
    version: row.version,
    updated_at: row.updated_at,
  };
}

function publicSessionWait(ctx: DaemonContext, sessionId: string) {
  const row = ctx.sessions.getSession(sessionId);
  if (row === undefined) return null;
  const snapshot = ctx.sessions.latestSnapshot(sessionId);
  const pending = ctx.db.prepare(`
    SELECT message_id, state FROM session_messages
    WHERE session_id = ? AND direction = 'inbound'
      AND (state = 'accepted' OR (state = 'failed' AND turn_id = ?))
    ORDER BY CASE WHEN state = 'accepted' THEN 0 ELSE 1 END, created_at DESC, message_id LIMIT 1
  `).get(sessionId, snapshot.turn_id) as { message_id: string; state: "accepted" | "failed" } | undefined;
  const wait = describeSessionWait({
    state: row.state,
    decision: snapshot.decision,
    resume_ready: row.resume_supported && row.native_session_id !== null,
    applying: ctx.activeSessionSends.has(sessionId),
    ...(pending === undefined ? {} : { pending_message: pending }),
  });
  const grant = ctx.continuations.forSession(sessionId);
  if (wait?.reason === "phase_continue" && grant?.status === "active"
    && Date.parse(grant.body.expires_at) > Date.now()
    && ctx.collaborator?.isScheduled(grant.grant_id)) {
    return { ...wait, automatic_continuation: true, grant_id: grant.grant_id };
  }
  return wait;
}

function publicCollaborator(ctx: DaemonContext, sessionId: string) {
  const grant = ctx.continuations.forSession(sessionId);
  return grant === undefined ? null : {
    grant_id: grant.grant_id, status: grant.status, reason: grant.reason,
    step_index: grant.step_index, steps_total: grant.body.steps.length,
    checks_used: grant.checks_used, max_checks: grant.body.max_checks,
    resumes_used: grant.resumes_used, max_resumes: grant.body.max_resumes,
    expires_at: grant.body.expires_at,
    scheduled: ctx.collaborator?.isScheduled(grant.grant_id) ?? false,
  };
}

type DecisionRequestedEvent = Extract<AgentSessionEvent, { type: "decision.requested" }>;

function parseDecisionDirective(text: string): DecisionRequestedEvent | undefined {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof root !== "object" || root === null || Array.isArray(root)) return undefined;
  const outer = root as Record<string, unknown>;
  if (Object.keys(outer).length !== 1 || !("ostag_decision" in outer)) return undefined;
  const parsed = SessionDecision.safeParse(outer["ostag_decision"]);
  return parsed.success ? { type: "decision.requested", ...parsed.data } : undefined;
}

interface SessionSendParams {
  session_id: string;
  runtime_id: string;
  turn_id: string;
  message_id: string;
  expected_version: number;
  text: string;
  requested_by?: string;
}

interface SessionStartParams {
  request_id: string;
  prompt: string;
  title: string;
  agent_id: string;
  repo_path: string;
}

function parseSessionStartParams(value: unknown): SessionStartParams | Error {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return new Error("params must be an object");
  }
  const p = value as Record<string, unknown>;
  if (typeof p["request_id"] !== "string" || p["request_id"].trim() === "" || p["request_id"].length > 256) {
    return new Error("params.request_id must be a non-empty string of at most 256 characters");
  }
  if (typeof p["prompt"] !== "string" || p["prompt"].trim() === "" || p["prompt"].length > 16_000) {
    return new Error("params.prompt must be between 1 and 16000 characters");
  }
  if (typeof p["title"] !== "string" || p["title"].trim() === "" || p["title"].length > 160) {
    return new Error("params.title must be between 1 and 160 characters");
  }
  if (typeof p["agent_id"] !== "string" || p["agent_id"].trim() === "" || p["agent_id"].length > 256) {
    return new Error("params.agent_id must be a non-empty string of at most 256 characters");
  }
  if (typeof p["repo_path"] !== "string" || !isAbsolute(p["repo_path"]) || p["repo_path"].length > 4096) {
    return new Error("params.repo_path must be an absolute path of at most 4096 characters");
  }
  return {
    request_id: p["request_id"],
    prompt: p["prompt"],
    title: p["title"],
    agent_id: p["agent_id"],
    repo_path: p["repo_path"],
  };
}

async function handleSessionStart(
  ctx: DaemonContext,
  req: DaemonRequest,
): Promise<SingleResponse> {
  const p = parseSessionStartParams(req.params);
  if (p instanceof Error) return singleErr(req.id, "bad_request", p.message);
  if (ctx.draining) return singleErr(req.id, "draining", "daemon is not accepting new sessions");

  const adapter = ctx.adapters.get(p.agent_id);
  if (adapter === undefined || !isSessionCapableAdapter(adapter)) {
    return singleErr(req.id, "resume_unsupported", "agent does not support resumable sessions");
  }
  const capabilities = adapter.sessionCapabilities();
  if (!capabilities.resume) {
    return singleErr(req.id, "resume_unsupported", "agent does not support resume");
  }
  const availability = await adapter.isAvailable();
  if (!availability.available) {
    return singleErr(req.id, "agent_unavailable", "agent is unavailable");
  }

  const now = Date.now() / 1000;
  const stableId = createHash("sha256").update(p.request_id).digest("hex").slice(0, 24);
  const taskId = `task_${stableId}`;
  const runId = `run_${stableId}`;
  const sessionId = `sess_${stableId}`;
  const turnId = `turn_${randomUUID()}`;
  const requestSha256 = createHash("sha256").update(JSON.stringify({
    request_id: p.request_id,
    prompt: p.prompt,
    title: p.title,
    agent_id: p.agent_id,
    repo_path: p.repo_path,
  })).digest("hex");
  const existing = ctx.sessions.getSession(sessionId);
  if (existing !== undefined) {
    if (existing.request_sha256 !== requestSha256) {
      return singleErr(
        req.id,
        "request_id_conflict",
        "request_id was already used for a different session request",
      );
    }
    const snapshot = ctx.sessions.latestSnapshot(sessionId);
    return singleOk(req.id, {
      ...publicSession(existing),
      ...snapshot,
      events: [],
    });
  }
  try {
    ctx.db.transaction(() => {
      insertTask(ctx.db, ctx.dbPath, { task_id: taskId, title: p.title, created_at: now });
      insertRun(ctx.db, ctx.dbPath, {
        run_id: runId,
        task_id: taskId,
        session_id: sessionId,
        agent_id: adapter.id,
        capability_id: `${adapter.id}.session`,
        phase: "code",
        started_at: now,
      });
      ctx.sessions.createSession({
        session_id: sessionId,
        task_id: taskId,
        run_id: runId,
        agent_id: adapter.id,
        request_sha256: requestSha256,
        native_session_id: null,
        repo_path: p.repo_path,
        state: "starting",
        resume_supported: true,
        version: 1,
        updated_at: now,
      });
      ctx.kanban.createCard({
        card_id: `card_${runId}`,
        task_id: taskId,
        title: p.title,
        body: `agent: ${adapter.id}\ncapability: resumable-session`,
        status: "running",
        assignee: adapter.id,
      });
    })();
  } catch {
    return singleErr(req.id, "store_write_failed", "could not create resumable session");
  }

  const controller = new AbortController();
  ctx.activeRuns.set(runId, controller);
  const task: AgentTask = {
    run_id: runId,
    task_id: taskId,
    session_id: sessionId,
    capability_id: `${adapter.id}.session`,
    prompt: p.prompt,
    context: { repo_path: p.repo_path },
  };
  const publicEvents: AgentSessionEvent[] = [];
  let nativeSessionId: string | undefined;
  let assistantText = "";
  let decision: unknown = null;
  let lease: ExecutionLease | undefined;
  let started = false;
  let settled = false;
  try {
    lease = await acquireSessionAdmission(ctx, adapter.id, p.repo_path, runId, controller.signal);
    started = true;
    for await (const rawEvent of boundedAdapterEvents(adapter.startSession(task, controller.signal), controller.signal)) {
      const event = AgentSessionEventSchema.parse(rawEvent);
      if (event.type === "native_session.started") {
        if (nativeSessionId !== undefined && nativeSessionId !== event.native_session_id) {
          throw new Error("adapter changed native session id");
        }
        nativeSessionId = event.native_session_id;
        continue;
      }
      if (nativeSessionId !== undefined && JSON.stringify(event).includes(nativeSessionId)) {
        throw new Error("adapter output contained protected session metadata");
      }
      if (event.type === "assistant.message") {
        // Controlled results are opaque data; their adapter emits decisions separately.
        const directive = isControlledSessionAdapter(adapter) ? undefined : parseDecisionDirective(event.text);
        if (directive !== undefined) {
          publicEvents.push(directive);
          decision = {
            decision_id: directive.decision_id,
            question: directive.question,
            choices: directive.choices,
            ...(directive.continuation === undefined ? {} : { continuation: directive.continuation }),
          };
          assistantText = directive.question;
          continue;
        }
        assistantText += event.text;
      }
      publicEvents.push(event);
      if (assistantText.length > 4_000) throw new Error("assistant output exceeded relay bound");
      if (event.type === "decision.requested") decision = {
        decision_id: event.decision_id,
        question: event.question,
        choices: event.choices,
        ...(event.continuation === undefined ? {} : { continuation: event.continuation }),
      };
      if (event.type === "session.terminal" && event.state !== "completed") {
        throw new Error("adapter terminated while starting the session");
      }
    }
    settled = true;
    if (nativeSessionId === undefined) throw new Error("adapter did not return a native session id");

    const confirmedNativeSessionId = nativeSessionId;
    const finalState = decision === null ? "idle" : "awaiting_decision";
    const completedAt = Date.now() / 1000;
    const updated = ctx.db.transaction(() => {
      const recorded = ctx.sessions.recordNativeSession(
        sessionId,
        confirmedNativeSessionId,
        1,
        completedAt,
      );
      ctx.sessions.appendTurn({
        turn_id: turnId,
        session_id: sessionId,
        ordinal: 1,
        state: finalState,
        assistant_text: assistantText,
        decision,
        created_at: now,
        updated_at: completedAt,
      });
      const session = ctx.sessions.setState(
        sessionId,
        finalState,
        recorded.version,
        completedAt,
      );
      finalizeRun(ctx.db, ctx.dbPath, runId, "completed", completedAt);
      ctx.kanban.moveCard(`card_${runId}`, "done", { actor: adapter.id });
      return session;
    })();
    return singleOk(req.id, {
      ...publicSession(updated),
      turn_id: turnId,
      assistant_text: assistantText,
      decision,
      events: publicEvents,
    });
  } catch {
    try {
      const current = ctx.sessions.getSession(sessionId);
      if (current !== undefined) {
        ctx.sessions.setState(sessionId, "failed", current.version, Date.now() / 1000);
      }
      finalizeRun(ctx.db, ctx.dbPath, runId, "failed", Date.now() / 1000);
      ctx.kanban.moveCard(`card_${runId}`, "blocked", { actor: adapter.id, blocked_reason: "session start failed" });
    } catch { /* preserve the original bounded failure */ }
    return singleErr(req.id, "agent_failed", "agent failed while starting the session");
  } finally {
    if (started && (!settled || controller.signal.aborted)) {
      controller.abort();
      if (await confirmAdapterStopped(adapter, runId)) await lease?.release();
      else lease?.retain("session start exit unconfirmed");
    } else await lease?.release();
    ctx.activeRuns.delete(runId);
    requestSupervisionScan(ctx, "session.start.settled");
  }
}

function parseSessionSendParams(value: unknown): SessionSendParams | Error {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return new Error("params must be an object");
  }
  const p = value as Record<string, unknown>;
  for (const key of ["session_id", "runtime_id", "turn_id", "message_id"] as const) {
    if (typeof p[key] !== "string" || p[key].trim() === "" || p[key].length > 256) {
      return new Error(`params.${key} must be a non-empty string of at most 256 characters`);
    }
  }
  if (!Number.isInteger(p["expected_version"]) || (p["expected_version"] as number) < 1) {
    return new Error("params.expected_version must be a positive integer");
  }
  if (typeof p["text"] !== "string" || p["text"].trim() === "" || p["text"].length > 16_000) {
    return new Error("params.text must be between 1 and 16000 characters");
  }
  if (p["requested_by"] !== undefined && (
    typeof p["requested_by"] !== "string"
    || p["requested_by"].trim() === ""
    || p["requested_by"].length > 256
  )) {
    return new Error("params.requested_by must be a non-empty string of at most 256 characters");
  }
  return {
    session_id: p["session_id"] as string,
    runtime_id: p["runtime_id"] as string,
    turn_id: p["turn_id"] as string,
    message_id: p["message_id"] as string,
    expected_version: p["expected_version"] as number,
    text: p["text"] as string,
    ...(p["requested_by"] === undefined ? {} : { requested_by: p["requested_by"] as string }),
  };
}

async function handleSessionSend(
  ctx: DaemonContext,
  req: DaemonRequest,
): Promise<SingleResponse> {
  const p = parseSessionSendParams(req.params);
  if (p instanceof Error) return singleErr(req.id, "bad_request", p.message);
  // Completed receipt replay remains read-only while drained; no new/retried
  // instruction may reserve a message or invoke an adapter during an upgrade.
  if (ctx.draining && ctx.sessions.getMessage(p.message_id)?.state !== "applied") {
    return singleErr(req.id, "draining", "daemon is not accepting session instructions");
  }

  const session = ctx.sessions.getSession(p.session_id);
  if (session === undefined) return singleErr(req.id, "not_found", "session not found");
  if (p.runtime_id !== session.agent_id) {
    return singleErr(req.id, "runtime_mismatch", "session belongs to another runtime");
  }
  // Idempotency wins over moving state: a retry may arrive after the first
  // delivery already appended a newer turn or completed the conversation.
  // Let the repository compare the complete canonical envelope before any
  // current-turn/current-state guards reject it.
  const existingMessage = ctx.sessions.getMessage(p.message_id);
  if (existingMessage !== undefined) {
    try {
      const replay = ctx.sessions.applyInbound({
        message_id: p.message_id,
        session_id: p.session_id,
        turn_id: p.turn_id,
        direction: "inbound",
        kind: "instruction.send",
        payload: { text: p.text, ...(p.requested_by === undefined ? {} : { requested_by: p.requested_by }) },
        state: "accepted",
        created_at: Date.now() / 1000,
      }, p.expected_version, Date.now() / 1000);
      if (existingMessage.state === "applied") {
        return singleOk(req.id, { state: replay.outcome, session_version: replay.session_version });
      }
      if (replay.session_version !== p.expected_version + 1) {
        return singleErr(req.id, "version_conflict", "accepted message cannot be recovered safely");
      }
      if (existingMessage.state === "accepted") {
        return ctx.activeSessionSends.has(session.session_id)
          ? singleErr(req.id, "session_busy", "session is already applying another instruction")
          : singleErr(
              req.id,
              "delivery_uncertain",
              "the previous delivery may have reached the agent; inspect the session before using a new message_id",
            );
      }
      if (existingMessage.state !== "failed") {
        return singleErr(req.id, "version_conflict", "reserved message is not retryable");
      }
      return singleErr(req.id, "delivery_uncertain", "Failed execution may have had side effects; reconcile the existing receipt before retrying");
    } catch (err) {
      if (err instanceof SessionMessageIdConflict) {
        return singleErr(req.id, "message_id_conflict", "message_id was already used for different content");
      }
      throw err;
    }
  }
  if (TERMINAL_SESSION_STATES.has(session.state)) {
    return singleErr(req.id, "session_terminal", `session state=${session.state}`);
  }
  if (!session.resume_supported || session.native_session_id === null) {
    return singleErr(req.id, "resume_unsupported", "session cannot be resumed");
  }
  const snapshot = ctx.sessions.latestSnapshot(p.session_id);
  if (snapshot.turn_id !== p.turn_id) {
    return singleErr(req.id, "turn_conflict", "message does not target the current turn");
  }
  const adapter = ctx.adapters.get(session.agent_id);
  if (adapter === undefined || !isSessionCapableAdapter(adapter) || !adapter.sessionCapabilities().resume) {
    return singleErr(req.id, "resume_unsupported", "agent does not support resume");
  }
  if (ctx.activeSessionSends.has(session.session_id)) {
    return singleErr(req.id, "session_busy", "session is already applying another instruction");
  }

  // Refuse busy/denied admission before minting an instruction receipt.
  let admission: Awaited<ReturnType<typeof acquireManualSessionAdmission>>;
  try { admission = await acquireManualSessionAdmission(ctx, session, p.message_id); }
  catch { return singleErr(req.id, "admission_denied", "Session execution admission was denied; no instruction was reserved"); }
  let handedOff = false;
  try {
    if (ctx.draining || admission.controller.signal.aborted) return singleErr(req.id, "admission_denied", "Session execution was cancelled; no instruction was reserved");
    let applied: { outcome: "applied" | "duplicate"; session_version: number };
    const now = Date.now() / 1000;
    try {
      applied = reserveSessionInstruction(ctx.db, ctx.dbPath, {
        message_id: p.message_id,
        session_id: p.session_id,
        turn_id: p.turn_id,
        direction: "inbound",
        kind: "instruction.send",
        payload: { text: p.text, ...(p.requested_by === undefined ? {} : { requested_by: p.requested_by }) },
        state: "accepted",
        created_at: now,
      }, p.expected_version, now);
    } catch (err) {
      if (err instanceof SessionVersionConflict) {
        return singleErr(req.id, "version_conflict", "session version changed; refresh before retrying");
      }
      if (err instanceof SessionMessageIdConflict) {
        return singleErr(req.id, "message_id_conflict", "message_id was already used for different content");
      }
      if (err instanceof Error && ["delivery_uncertain", "continuation_in_flight", "grant_owned", "signed_approval_required", "invalid_decision"].includes(err.message)) return singleErr(req.id, err.message, "Refresh the decision and use its authorized owner route");
      throw err;
    }
    if (applied.outcome === "duplicate") {
      return ctx.sessions.getMessage(p.message_id)?.state === "applied"
        ? singleOk(req.id, { state: "duplicate", session_version: applied.session_version })
        : singleErr(req.id, "delivery_uncertain", "A receipt appeared during admission; inspect it before retrying");
    }

    handedOff = true;
    return await executeReservedSessionTurn(ctx, req, p, session, adapter, applied.session_version, { admittedLease: admission.lease, controller: admission.controller });
  } finally { if (!handedOff) await admission.release(); }

}

/** Track queued manual work before awaiting admission so drain/cancel can stop it.
 * No durable receipt exists until admission succeeds; callers transfer both
 * ownership and the same cancellation signal to the reserved-turn executor.
 */
async function acquireManualSessionAdmission(
  ctx: DaemonContext,
  session: NonNullable<ReturnType<SessionRepository["getSession"]>>,
  pendingMessageId: string,
) {
  const controller = new AbortController();
  ctx.activeSessionSends.set(session.session_id, pendingMessageId);
  ctx.activeRuns.set(session.run_id, controller);
  const clear = () => {
    if (ctx.activeSessionSends.get(session.session_id) === pendingMessageId) ctx.activeSessionSends.delete(session.session_id);
    if (ctx.activeRuns.get(session.run_id) === controller) ctx.activeRuns.delete(session.run_id);
  };
  try {
    const lease = await acquireSessionAdmission(ctx, session.agent_id, session.repo_path, session.run_id, controller.signal);
    return { lease, controller, release: async () => { try { await lease.release(); } finally { clear(); } } };
  } catch (error) {
    clear();
    throw error;
  }
}

/** Private port: only an already persisted reservation may invoke the runtime. */
async function executeReservedSessionTurn(
  ctx: DaemonContext,
  req: DaemonRequest,
  p: SessionSendParams,
  session: NonNullable<ReturnType<SessionRepository["getSession"]>>,
  adapter: SessionCapableAdapter,
  reservationVersion: number,
  options: {
    admittedLease?: ExecutionLease;
    controller?: AbortController;
    completed?: (turnId: string, version: number, now: number) => void;
  } = {},
): Promise<SingleResponse> {
  const applied = { session_version: reservationVersion };
  ctx.activeSessionSends.set(session.session_id,p.message_id);
  const controller = options.controller ?? new AbortController();
  const now = Date.now() / 1000;
  ctx.activeRuns.set(session.run_id, controller);
  let lease: ExecutionLease | undefined;
  let started = false;
  let settled = false;
  try {
    lease = options.admittedLease ?? await acquireSessionAdmission(ctx, adapter.id, session.repo_path, session.run_id, controller.signal);
    const failReservedMessage = (
      code: string,
      message: string,
    ): SingleResponse => {
      try {
        ctx.sessions.markMessageFailed(p.message_id);
      } catch {
        return singleErr(
          req.id,
          "delivery_uncertain",
          "the agent failed and the reservation could not be finalized; inspect the session before retrying",
        );
      }
      return singleErr(req.id, code, message);
    };
    if (session.native_session_id === null) return failReservedMessage("resume_unsupported", "session cannot resume");
    const context: Record<string, unknown> = {};
    if (session.repo_path !== "") context["repo_path"] = session.repo_path;
    if (p.requested_by !== undefined) context["requested_by"] = p.requested_by;
    const input: AgentSessionInput = {
      session_id: session.session_id,
      task_id: session.task_id,
      run_id: session.run_id,
      turn_id: p.turn_id,
      native_session_id: session.native_session_id,
      expected_version: applied.session_version,
      message_id: p.message_id,
      prompt: p.text,
      ...(Object.keys(context).length === 0 ? {} : { context }),
    };
    const publicEvents: AgentSessionEvent[] = [];
    let assistantText = "";
    let decision: unknown = null;
    let terminalCompleted = false;
    try {
      started = true;
      for await (const rawEvent of boundedAdapterEvents(adapter.resumeSession(input, controller.signal), controller.signal)) {
        const event = AgentSessionEventSchema.parse(rawEvent);
        if (event.type === "native_session.started") {
          if (event.native_session_id !== session.native_session_id) {
            return failReservedMessage(
              "adapter_protocol",
              "agent resumed an unexpected native session",
            );
          }
          continue;
        }
        if (JSON.stringify(event).includes(session.native_session_id)) {
          return failReservedMessage(
            "adapter_protocol",
            "agent output contained protected session metadata",
          );
        }
        if (event.type === "session.terminal") {
          if (event.state !== "completed") {
            const rawCode = event.error_code ?? "unknown";
            const safeCode = /^[a-z0-9_]{1,64}$/.test(rawCode) ? rawCode : "unknown";
            return failReservedMessage(
              "agent_failed",
              `agent failed while applying the instruction (${safeCode})`,
            );
          }
          terminalCompleted = true;
        }
        if (event.type === "assistant.message") {
          // Controlled results are opaque data; their adapter emits decisions separately.
          const directive = isControlledSessionAdapter(adapter) ? undefined : parseDecisionDirective(event.text);
          if (directive !== undefined) {
            publicEvents.push(directive);
            decision = {
              decision_id: directive.decision_id,
              question: directive.question,
              choices: directive.choices,
              ...(directive.continuation === undefined ? {} : { continuation: directive.continuation }),
            };
            assistantText = directive.question;
            continue;
          }
          assistantText += event.text;
        }
        publicEvents.push(event);
        if (event.type === "decision.requested") decision = {
          decision_id: event.decision_id,
          question: event.question,
          choices: event.choices,
          ...(event.continuation === undefined ? {} : { continuation: event.continuation }),
        };
      }
      settled = true;
      if (!terminalCompleted) {
        return failReservedMessage(
          "agent_failed",
          "agent ended without completing the instruction",
        );
      }
    } catch {
      return failReservedMessage(
        "agent_failed",
        "agent failed while applying the instruction",
      );
    }

    const finalState = publicEvents.some((event) => event.type === "decision.requested")
      ? "awaiting_decision"
      : "idle";
    const completedAt = Date.now() / 1000;
    const turnId = `turn_${randomUUID()}`;
    const updatedSession = ctx.db.transaction(() => {
      const updated = ctx.sessions.completeInboundTurn({
        turn: {
          turn_id: turnId,
          session_id: session.session_id,
          ordinal: (ctx.db.prepare(
            "SELECT COALESCE(MAX(ordinal), 0) + 1 AS ordinal FROM session_turns WHERE session_id = ?",
          ).get(session.session_id) as { ordinal: number }).ordinal,
          state: finalState,
          assistant_text: assistantText,
          decision,
          created_at: now,
          updated_at: completedAt,
        },
        message_id: p.message_id,
        expected_version: applied.session_version,
        applied_at: completedAt,
      });
      options.completed?.(turnId, updated.version, completedAt);
      return updated;
    })();
    return singleOk(req.id, {
      state: "applied",
      session_version: updatedSession.version,
      events: publicEvents,
    });
  } catch {
    try { ctx.sessions.markMessageFailed(p.message_id); }
    catch {
      return singleErr(req.id, "delivery_uncertain", "Execution receipt could not be finalized; inspect persisted state before retrying");
    }
    return singleErr(req.id, started ? "delivery_uncertain" : "admission_denied", "Session execution could not be confirmed; inspect persisted state before retrying");
  } finally {
    try {
      if (started && (!settled || controller.signal.aborted)) {
        controller.abort();
        if (await confirmAdapterStopped(adapter, session.run_id)) await lease?.release();
        else lease?.retain("session resume exit unconfirmed");
      } else await lease?.release();
    } finally {
      ctx.activeSessionSends.delete(session.session_id);
      if (ctx.activeRuns.get(session.run_id) === controller) ctx.activeRuns.delete(session.run_id);
      requestSupervisionScan(ctx, "session.send.settled");
    }
  }
}

function requestSupervisionScan(ctx: DaemonContext, reason: string): void {
  if (ctx.draining || !ctx.supervision) return;
  void ctx.supervision.requestScan(reason).catch(() => {
    // The periodic pass is the recovery path; never fail a persisted session reply.
  });
}

// ──────────────────────────────────────────────────────────────────────
// Single-shot methods
// ──────────────────────────────────────────────────────────────────────

async function handleSingle(ctx: DaemonContext, req: DaemonRequest): Promise<SingleResponse | null> {
  if (req.method === "worker.list" || req.method === "worker.inspect") {
    if (ctx.draining) return singleErr(req.id, "draining", "Daemon is draining");
    try {
      const {WorkerViewService, WorkerViewError} = await import("./worker-view-service.js");
      if (ctx.draining) return singleErr(req.id, "draining", "Daemon is draining");
      ctx.workerViews ??= new WorkerViewService(ctx.db);
      try {
        return singleOk(req.id, ctx.workerViews.handle(req.method, req.params));
      } catch (error) {
        if (error instanceof WorkerViewError) return singleErr(req.id, error.code, error.message);
        throw error;
      }
    } catch {
      return singleErr(req.id, "worker_view_failed", "Worker view unavailable");
    }
  }
  if (req.method.startsWith("attention.")) {
    if (!ctx.supervision) return singleErr(req.id,"attention_disabled","Start daemon with OSSTACK_ATTENTION=1 to opt in");
    if (ctx.draining) return singleErr(req.id,"draining","Daemon is draining");
    try {
      if(req.method==="attention.abandon-receipt") {
        const p=req.params as {scope_id:string;session_id:string;message_id:string;expected_version:number;reason:string;evidence_sha256:string;acknowledge_unknown_effects:boolean};
        if(!p||p.acknowledge_unknown_effects!==true)throw new Error("explicit_unknown_effects_ack_required");
        if(ctx.activeSessionSends.has(p.session_id))throw new Error("delivery_in_flight");
        return singleOk(req.id,new AttentionActions(ctx.supervision.store,ctx.supervision.observer.owner).abandon(p));
      }
      if (req.method === "attention.answer") {
        const p=req.params as {scope_id:string;item_id:string;action_id:string;revision:number;content_hash:string;text:string;takeover:boolean};
        if (!p || typeof p.takeover!=="boolean" || typeof p.text!=="string")throw new Error("bad_request");
        const item=ctx.supervision.store.getItem(p.scope_id,p.item_id);if(!item)throw new Error("not_found");
        const actions=new AttentionActions(ctx.supervision.store,ctx.supervision.observer.owner);
        const replay=actions.replay(p,ctx.activeSessionSends.get(item.session_id));if(replay)return singleOk(req.id,replay);
        const session=ctx.sessions.getSession(item.session_id);if(!session)throw new Error("source_missing");
        const adapter=ctx.adapters.get(session.agent_id);
        if(!session.resume_supported||!session.native_session_id||!adapter||!isSessionCapableAdapter(adapter)||!adapter.sessionCapabilities().resume)throw new Error("resume_unsupported");
        if(ctx.activeSessionSends.has(session.session_id))throw new Error("session_busy");
        let admission: Awaited<ReturnType<typeof acquireManualSessionAdmission>>;
        try { admission = await acquireManualSessionAdmission(ctx, session, `pending:${p.action_id}`); }
        catch { return singleErr(req.id, "admission_denied", "Session execution admission was denied; no answer was reserved"); }
        let handedOff = false;
        try {
        if (ctx.draining || admission.controller.signal.aborted) return singleErr(req.id, "admission_denied", "Session execution was cancelled; no answer was reserved");
        const action=actions.reserve(p);
        if(action.replay)return singleOk(req.id,action);
        handedOff = true;
        const execution=await executeReservedSessionTurn(ctx,req,{session_id:session.session_id,runtime_id:session.agent_id,turn_id:item.turn_id,message_id:action.message_id,expected_version:action.reservation_version-1,text:p.text},session,adapter,action.reservation_version,{admittedLease:admission.lease,controller:admission.controller});
        return singleOk(req.id,{...actions.reconcile(action),execution_error:execution.error?.code??null});
        } finally { if (!handedOff) await admission.release(); }
      }
      return singleOk(req.id,await ctx.supervision.handle(req.method,req.params));
    } catch(error) {return singleErr(req.id,error instanceof Error?error.message:"attention_error","Attention request failed; refresh source facts before retrying");}
  }
  switch (req.method) {
    case "deployment.identity":
      return ctx.deploymentIdentity
        ? singleOk(req.id, ctx.deploymentIdentity)
        : singleErr(req.id, "identity_unavailable", "Deployment identity unavailable");
    case "version":
      return singleOk(req.id, {
        version: DAEMON_VERSION,
        phase: DAEMON_PHASE,
        protocol_version: PROTOCOL_VERSION,
      });

    case "health": {
      const update = readUpdateCache();
      return singleOk(req.id, {
        version: DAEMON_VERSION,
        phase: DAEMON_PHASE,
        protocol_version: PROTOCOL_VERSION,
        pid: process.pid,
        uptime_s: Math.round(process.uptime()),
        memory_rss_mb: Math.round(process.memoryUsage.rss() / 1024 / 1024),
        db_path: ctx.dbPath,
        adapters: Array.from(ctx.adapters.keys()),
        active_runs: ctx.activeRuns.size,
        draining: ctx.draining,
        concurrency: {
          writes: {
            limit: ctx.writeSemaphore.capacity,
            active: ctx.writeSemaphore.in_use,
            queued: ctx.writeSemaphore.pending,
          },
          reads: {
            limit: ctx.readSemaphore.capacity,
            active: ctx.readSemaphore.in_use,
            queued: ctx.readSemaphore.pending,
          },
          repository_write_queues: ctx.repoWriteSemaphores.size,
        },
        active_loops: activeLoopCount(ctx),
        otel_enabled: otelEnabled(),
        hermes_enabled: ctx.hermes.enabled,
        gbrain_enabled: ctx.gbrain.enabled,
        dashboard_url: ctx.dashboardUrl,
        update_available: update?.update_available ?? false,
        latest_version: update?.latest ?? null,
      });
    }

    case "update.status":
      return singleOk(req.id, {
        current: DAEMON_VERSION,
        cache: readUpdateCache(),
      });

    case "daemon.drain": {
      // Stop accepting new tasks, then wait (bounded) for active runs to end.
      // Used by `osstack upgrade` so a release never kills work mid-flight.
      const p = (req.params ?? {}) as { timeout_ms?: number };
      const timeoutMs = Math.min(Math.max(p.timeout_ms ?? 30_000, 0), 300_000);
      ctx.draining = true;
      ctx.drainingFromHealth = false;
      const deadline = Date.now() + timeoutMs;
      while ((ctx.activeRuns.size > 0 || graphUpgradeHolds(ctx.db) > 0) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
      }
      return singleOk(req.id, {
        draining: true,
        drained: ctx.activeRuns.size === 0 && graphUpgradeHolds(ctx.db) === 0,
        graph_holds: graphUpgradeHolds(ctx.db),
        active_runs: ctx.activeRuns.size,
      });
    }

    case "daemon.resume":
      ctx.draining = false;
      ctx.drainingFromHealth = false;
      ctx.collaborator?.resumePending();
      return singleOk(req.id, { draining: false });

    case "daemon.shutdown":
      // Respond first, then exit on the next tick so the frame gets flushed.
      setTimeout(() => ctx.requestShutdown(), 50);
      return singleOk(req.id, { shutting_down: true, pid: process.pid });

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

    case "session.list": {
      const p = (req.params ?? {}) as { limit?: number };
      const limit = p.limit ?? 100;
      if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        return singleErr(req.id, "bad_request", "params.limit must be an integer between 1 and 200");
      }
      return singleOk(req.id, {
        sessions: ctx.sessions.listSessions({ limit }).map((row) => ({
          ...publicSession(row), wait: publicSessionWait(ctx, row.session_id), collaborator: publicCollaborator(ctx, row.session_id),
        })),
      });
    }

    case "session.start":
          return await handleSessionStart(ctx, req);

    case "session.status": {
      const p = (req.params ?? {}) as { session_id?: string };
      if (typeof p.session_id !== "string" || p.session_id.trim() === "") {
        return singleErr(req.id, "bad_request", "params.session_id required");
      }
      const session = publicSession(ctx.sessions.getSession(p.session_id));
      return session === null
        ? singleErr(req.id, "not_found", "session not found")
        : singleOk(req.id, { ...session, wait: publicSessionWait(ctx, p.session_id), collaborator: publicCollaborator(ctx, p.session_id) });
    }

    case "session.snapshot": {
      const p = (req.params ?? {}) as { session_id?: string };
      if (typeof p.session_id !== "string" || p.session_id.trim() === "") {
        return singleErr(req.id, "bad_request", "params.session_id required");
      }
      if (ctx.sessions.getSession(p.session_id) === undefined) {
        return singleErr(req.id, "not_found", "session not found");
      }
      return singleOk(req.id, {
        ...ctx.sessions.latestSnapshot(p.session_id),
        wait: publicSessionWait(ctx, p.session_id),
        collaborator: publicCollaborator(ctx, p.session_id),
      });
    }

    case "collaborator.inspect": {
      const p = req.params as Record<string, unknown> | undefined;
      if (typeof p?.["session_id"] !== "string") return singleErr(req.id, "bad_request", "session_id is required");
      const session = ctx.sessions.getSession(p["session_id"]);
      if (session === undefined) return singleErr(req.id, "not_found", "session not found");
      try {
        const policy = await ctx.collaborator!.policy(session.agent_id);
        return singleOk(req.id, {
          ...ctx.sessions.latestSnapshot(session.session_id), repo_path: session.repo_path,
          runtime_policy: policy, collaborator: ctx.continuations.forSession(session.session_id) ?? null,
        });
      } catch { return singleErr(req.id, "controlled_runtime_required", "start a claude-controlled-session before installing a continuation grant"); }
    }
    case "collaborator.install": {
      try { return singleOk(req.id, await ctx.collaborator!.install(req.params)); }
      catch { return singleErr(req.id, "grant_rejected", "grant signature, runtime policy, session cursor, or time window is invalid; inspect the session and signed grant"); }
    }
    case "collaborator.status":
    case "collaborator.revoke": {
      const p = req.params as Record<string, unknown> | undefined;
      if (typeof p?.["grant_id"] !== "string") return singleErr(req.id, "bad_request", "grant_id is required");
      const grant = ctx.continuations.get(p["grant_id"]);
      if (grant === undefined) return singleErr(req.id, "not_found", "grant not found");
      return singleOk(req.id, req.method === "collaborator.revoke" ? ctx.collaborator!.revoke(p["grant_id"]) : grant);
    }

    case "session.send":
          return await handleSessionSend(ctx, req);

    case "task.cancel": {
      const p = (req.params ?? {}) as { run_id?: string };
      if (typeof p.run_id !== "string") return singleErr(req.id, "bad_request", "params.run_id required");
      const ac = ctx.activeRuns.get(p.run_id);
      if (!ac) return singleErr(req.id, "not_active", `run_id=${p.run_id} is not currently active`);
      ac.abort();
      return singleOk(req.id, { cancelled: true, run_id: p.run_id });
    }

    case "stats":
      return singleOk(req.id, computeStats(ctx.db, ctx.loopSessions, ctx.rpcLatency));

    case "autonomy.status": {
      const params = (req.params ?? {}) as { autonomy_run_id?: unknown };
      if (
        typeof params.autonomy_run_id !== "string"
        || params.autonomy_run_id.length === 0
      ) {
        return singleErr(
          req.id,
          "bad_request",
          "params.autonomy_run_id required",
        );
      }
      const row = getAutonomyRun(ctx.db, params.autonomy_run_id);
      return row === undefined
        ? singleErr(
            req.id,
            "not_found",
            `no autonomy run with id=${params.autonomy_run_id}`,
          )
        : singleOk(req.id, row);
    }

    case "autonomy.health": {
      try {
        const report = await ctx.autonomyHealth();
        ctx.lastAutonomyHealth = report;
        applyAutonomyDrainSignal(ctx, report.drain_required);
        return singleOk(req.id, report);
      } catch (error) {
        return singleErr(
          req.id,
          "autonomy_health_failed",
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    case "autonomy.resume": {
      if (ctx.guardedAutonomy === undefined) {
        return singleErr(
          req.id,
          "unavailable",
          "guarded autonomy runtime is not configured",
        );
      }
      const params = (req.params ?? {}) as {
        autonomy_run_id?: unknown;
        decision?: unknown;
      };
      if (
        typeof params.autonomy_run_id !== "string"
        || params.autonomy_run_id.length === 0
      ) {
        return singleErr(
          req.id,
          "bad_request",
          "params.autonomy_run_id required",
        );
      }
      const parsedDecision =
        params.decision === undefined
          ? undefined
          : ScopedApprovalDecision.safeParse(params.decision);
      if (
        parsedDecision !== undefined
        && !parsedDecision.success
      ) {
        return singleErr(
          req.id,
          "bad_request",
          "params.decision must be a valid signed scoped approval",
        );
      }
      try {
        return singleOk(
          req.id,
          await resumeGuardedAutonomy(
            ctx,
            params.autonomy_run_id,
            parsedDecision?.data,
          ),
        );
      } catch (error) {
        return singleErr(
          req.id,
          "autonomy_resume_failed",
          error instanceof Error ? error.message : String(error),
        );
      }
    }

    case "loop.run": {
      const parsed = parseLoopRunParams(req.params);
      if (parsed instanceof Error) return singleErr(req.id, "bad_request", parsed.message);
      const ownedOptions = withLoopAdapters(ctx, parsed.runOptions);
      let held: ExecutionLease | undefined;
      let confirmed = false;
      const acquire = ownedOptions.lifecycleLease!;
      ownedOptions.lifecycleLease = async (context) => {
        held = await acquire(context);
        return { release: async () => { confirmed = true; }, retain: (reason) => held!.retain(reason) };
      };
      try {
        const engine = new LoopEngine(ownedOptions);
        if (parsed.cyclesOptions === undefined) {
          const raw = await engine.runOnce();
          // Kernel gate (R2.2): the engine consulted the injected policy gate at
          // entry. A deny (e.g. mode: observe) refuses before any work — surface
          // it as a `policy_denied` RPC error (A-006 blocked code), no evidence.
          if (raw.policy?.denied === true) {
            return singleErr(req.id, "policy_denied", raw.policy.reason);
          }
          const knowledgeHygiene = await finalizeLoopKnowledgeHygiene(
            parsed.neatFinalize,
            parsed.runOptions.workspacePath ?? process.cwd(),
            raw,
          );
          const runId = persistLoopRunEvidence(ctx, raw);
          return singleOk(req.id, loopRunSummary(raw, runId, knowledgeHygiene));
        }
        const raw = await engine.runCycles(parsed.cyclesOptions);
        if (raw.policy?.denied === true) {
          return singleErr(req.id, "policy_denied", raw.policy.reason);
        }
        const knowledgeHygiene = await finalizeLoopKnowledgeHygiene(
          parsed.neatFinalize,
          parsed.runOptions.workspacePath ?? process.cwd(),
          raw,
        );
        const runId = persistLoopRunEvidence(ctx, raw);
        return singleOk(req.id, loopRunCyclesSummary(raw, runId, knowledgeHygiene));
      } catch (error) {
        return singleErr(req.id, "admission_denied", error instanceof Error ? error.message : String(error));
      } finally { if (confirmed) await held?.release(); }
    }

    case "loop.start": {
      const parsed = parseLoopStartParams(req.params);
      if (parsed instanceof Error) return singleErr(req.id, "bad_request", parsed.message);
      return singleOk(req.id, await startLoopSession(ctx, parsed.runOptions, parsed.schedule));
    }

    case "loop.list":
      return singleOk(req.id, {
        loops: Array.from(ctx.loopSessions.values()).map(loopSessionSummary),
      });

    case "loop.stop": {
      const p = objectParams(req.params);
      if (p instanceof Error) return singleErr(req.id, "bad_request", p.message);
      const loopSessionId = optionalString(p, "loopSessionId");
      if (loopSessionId === undefined) return singleErr(req.id, "bad_request", "params.loopSessionId required");
      const session = ctx.loopSessions.get(loopSessionId);
      if (session === undefined) return singleErr(req.id, "not_found", `no loop session with id=${loopSessionId}`);
      stopLoopSession(session, "stopped by request");
      await persistLoopSessions(ctx);
      return singleOk(req.id, loopSessionSummary(session));
    }

    case "daily.schedule": {
      const parsed = parseDailyScheduleParams(req.params);
      if (parsed instanceof Error) return singleErr(req.id, "bad_request", parsed.message);
      return singleOk(req.id, await startDailySession(ctx, parsed));
    }

    case "daily.list":
      return singleOk(req.id, {
        daily: Array.from(ctx.dailySessions.values()).map(dailySessionSummary),
      });

    case "daily.stop": {
      const p = objectParams(req.params);
      if (p instanceof Error) return singleErr(req.id, "bad_request", p.message);
      const dailySessionId = optionalString(p, "dailySessionId");
      if (dailySessionId === undefined) return singleErr(req.id, "bad_request", "params.dailySessionId required");
      const session = ctx.dailySessions.get(dailySessionId);
      if (session === undefined) return singleErr(req.id, "not_found", `no daily session with id=${dailySessionId}`);
      stopDailySession(session, "stopped by request");
      await persistDailySessions(ctx);
      return singleOk(req.id, dailySessionSummary(session));
    }

    case "loop.status": {
      const parsed = parseLoopStatusParams(req.params);
      if (parsed instanceof Error) return singleErr(req.id, "bad_request", parsed.message);
      const state = await readLoopState(parsed.stateFilePath);
      if (state !== null) {
        return singleOk(req.id, {
          state,
          state_json: parsed.stateFilePath,
          markdown: renderLoopStateMarkdown(state),
        });
      }
      const markdownPath = parsed.stateFilePath.endsWith(".json")
        ? parsed.stateFilePath.replace(/[^/]+$/, "STATE.md")
        : join(parsed.workspacePath, "STATE.md");
      try {
        return singleOk(req.id, {
          state: null,
          state_json: parsed.stateFilePath,
          state_markdown: markdownPath,
          markdown: await readFile(markdownPath, "utf-8"),
        });
      } catch {
        return singleErr(req.id, "not_found", `no loop state found at ${parsed.stateFilePath}`);
      }
    }

    case "hermes.health":
      return singleOk(req.id, {
        enabled: ctx.hermes.enabled,
        bin: ctx.hermes.bin,
        board: ctx.hermes.board,
        check: await ctx.hermes.healthCheck(),
        active_kanban_links: ctx.hermesKanbanByRun.size,
      });

    case "dashboard.url":
      return singleOk(req.id, {
        url: ctx.dashboardUrl,
        available: ctx.dashboardUrl !== null,
      });

    case "dashboard.snapshot": {
      const p = objectParams(req.params);
      if (p instanceof Error) return singleErr(req.id, "bad_request", p.message);
      const workspacePath = optionalString(p, "workspacePath");
      const attentionAfter = p["attentionAfter"];
      const attentionLimit = p["attentionLimit"];
      if ((attentionAfter !== undefined && (typeof attentionAfter !== "string" || !/^[a-f0-9]{64}$/.test(attentionAfter))) ||
          (attentionLimit !== undefined && (typeof attentionLimit !== "number" || !Number.isInteger(attentionLimit) || attentionLimit < 1 || attentionLimit > 100))) {
        return singleErr(req.id, "bad_request", "Invalid Attention pagination");
      }
      return singleOk(req.id, createDashboardSnapshot({
        attentionService: ctx.draining ? "unavailable" : ctx.supervision ? "running" : "disabled",
        ...(attentionAfter === undefined ? {} : {attentionAfter: attentionAfter as string}),
        ...(attentionLimit === undefined ? {} : {attentionLimit: attentionLimit as number}),
        db: ctx.db,
        kanban: ctx.kanban,
        dbPath: ctx.dbPath,
        ...(workspacePath === undefined ? {} : { workspacePath: resolve(workspacePath) }),
        version: DAEMON_VERSION,
        phase: DAEMON_PHASE,
        dashboardUrl: ctx.dashboardUrl ?? dashboardUrl(dashboardUrlFromEnv()),
        adapters: Array.from(ctx.adapters.values()).map((a) => ({
          id: a.id,
          display_name: a.display_name,
          cost_tier: a.cost_tier,
        })),
        activeRuns: ctx.activeRuns.size,
        activeLoops: activeLoopCount(ctx),
      }));
    }

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
      const observed = countRunsSince(ctx.db, cutoff);
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
  loops: LoopStats;
  /** Per-method socket RPC latency (p50/p95 over a recent window). */
  rpc: RpcMethodLatency[];
  generated_at: number;
}

interface LoopStats {
  total_sessions: number;
  running: number;
  stopping: number;
  stopped: number;
  failed: number;
  total_cycles: number;
  total_discovered: number;
  total_executed: number;
  total_skipped: number;
  total_successful: number;
  total_failed: number;
  total_escalated: number;
  total_tokens_consumed: number;
  total_cycle_duration_ms: number;
  avg_cycle_duration_ms: number | null;
  per_loop: LoopStat[];
}

interface LoopStat {
  loop_session_id: string;
  status: LoopSessionStatus;
  workspace_path: string;
  cycle_count: number;
  discovered_task_count: number;
  executed_task_count: number;
  skipped_task_count: number;
  successful_task_count: number;
  failed_task_count: number;
  escalated_task_count: number;
  tokens_consumed: number;
  total_cycle_duration_ms: number;
  avg_cycle_duration_ms: number | null;
  failure_streaks: LoopFailureStreak[];
  budget?: LoopBudgetStat;
  last_cycle_duration_ms?: number;
  schedule?: string;
  stop_reason?: string;
  last_error?: string;
}

/** Budget limits + latest usage for one daemon loop session. */
interface LoopBudgetStat {
  limits: NonNullable<LoopRunOptions["budget"]>;
  exceeded: boolean;
  limit?: string;
  reason?: string;
  usage?: LoopBudgetStatus["usage"];
}

function loopBudgetStat(session: LoopSession): LoopBudgetStat | undefined {
  const limits = session.runOptions.budget;
  if (limits === undefined) return undefined;
  const check = session.lastBudgetCheck;
  return {
    limits,
    exceeded: check?.exceeded ?? false,
    ...(check?.limit !== undefined ? { limit: check.limit } : {}),
    ...(check?.reason !== undefined ? { reason: check.reason } : {}),
    ...(check !== undefined ? { usage: check.usage } : {}),
  };
}

function computeStats(
  db: Database.Database,
  loopSessions: Map<string, LoopSession>,
  rpcLatency: RpcLatencyRecorder,
): DaemonStats {
  const total_runs = countRuns(db);
  const total_events = countEvents(db);
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
  return {
    total_runs,
    total_events,
    per_agent: rows,
    loops: computeLoopStats(loopSessions),
    rpc: rpcLatency.snapshot(),
    generated_at: Date.now() / 1000,
  };
}

function computeLoopStats(loopSessions: Map<string, LoopSession>): LoopStats {
  const perLoop = Array.from(loopSessions.values()).map(loopStat);
  const totalCycles = perLoop.reduce((sum, loop) => sum + loop.cycle_count, 0);
  const totalCycleDurationMs = perLoop.reduce((sum, loop) => sum + loop.total_cycle_duration_ms, 0);
  return {
    total_sessions: perLoop.length,
    running: perLoop.filter((loop) => loop.status === "running").length,
    stopping: perLoop.filter((loop) => loop.status === "stopping").length,
    stopped: perLoop.filter((loop) => loop.status === "stopped").length,
    failed: perLoop.filter((loop) => loop.status === "failed").length,
    total_cycles: totalCycles,
    total_discovered: perLoop.reduce((sum, loop) => sum + loop.discovered_task_count, 0),
    total_executed: perLoop.reduce((sum, loop) => sum + loop.executed_task_count, 0),
    total_skipped: perLoop.reduce((sum, loop) => sum + loop.skipped_task_count, 0),
    total_successful: perLoop.reduce((sum, loop) => sum + loop.successful_task_count, 0),
    total_failed: perLoop.reduce((sum, loop) => sum + loop.failed_task_count, 0),
    total_escalated: perLoop.reduce((sum, loop) => sum + loop.escalated_task_count, 0),
    total_tokens_consumed: perLoop.reduce((sum, loop) => sum + loop.tokens_consumed, 0),
    total_cycle_duration_ms: totalCycleDurationMs,
    avg_cycle_duration_ms: totalCycles === 0 ? null : totalCycleDurationMs / totalCycles,
    per_loop: perLoop,
  };
}

function loopStat(session: LoopSession): LoopStat {
  const budget = loopBudgetStat(session);
  return {
    loop_session_id: session.loopSessionId,
    status: session.status,
    workspace_path: session.workspacePath,
    cycle_count: session.cycleCount,
    discovered_task_count: session.discoveredTaskCount,
    executed_task_count: session.executedTaskCount,
    skipped_task_count: session.skippedTaskCount,
    successful_task_count: session.successfulTaskCount,
    failed_task_count: session.failedTaskCount,
    escalated_task_count: session.escalatedTaskCount,
    tokens_consumed: session.tokensConsumed,
    total_cycle_duration_ms: session.totalCycleDurationMs,
    avg_cycle_duration_ms: session.cycleCount === 0 ? null : session.totalCycleDurationMs / session.cycleCount,
    failure_streaks: Object.values(session.failureStreaks),
    ...(session.runOptions.profileRouting !== undefined
      ? { profile: session.runOptions.profileRouting }
      : {}),
    ...(budget !== undefined ? { budget } : {}),
    ...(session.lastCycleDurationMs !== undefined ? { last_cycle_duration_ms: session.lastCycleDurationMs } : {}),
    ...(session.scheduleExpression !== undefined ? { schedule: session.scheduleExpression } : {}),
    ...(session.stopReason !== undefined ? { stop_reason: session.stopReason } : {}),
    ...(session.lastError !== undefined ? { last_error: session.lastError } : {}),
  };
}

// ──────────────────────────────────────────────────────────────────────
// loop.run / loop.status
// ──────────────────────────────────────────────────────────────────────

function loopRunSummary(
  result: LoopRunResult,
  runId?: string,
  knowledgeHygiene?: LoopNeatFinalizerResultV1,
): Record<string, unknown> {
  return {
    ...(runId !== undefined ? { run_id: runId } : {}),
    loop_id: result.loop_id,
    json_path: result.jsonPath,
    markdown_path: result.markdownPath,
    completed_tasks: result.state.completed_tasks,
    metrics: result.state.key_metrics,
    events: result.events,
    state: result.state,
    ...(result.goal !== undefined ? { goal: result.goal } : {}),
    ...(result.budget !== undefined ? { budget: result.budget } : {}),
    ...(knowledgeHygiene !== undefined ? { knowledge_hygiene: knowledgeHygiene } : {}),
  };
}

function loopRunCyclesSummary(
  result: LoopRunCyclesResult,
  runId?: string,
  knowledgeHygiene?: LoopNeatFinalizerResultV1,
): Record<string, unknown> {
  return {
    ...(runId !== undefined ? { run_id: runId } : {}),
    loop_id: result.loop_id,
    json_path: result.jsonPath,
    markdown_path: result.markdownPath,
    completed_tasks: result.state.completed_tasks,
    metrics: result.state.key_metrics,
    events: result.events,
    state: result.state,
    ...(result.cycles.at(-1)?.goal !== undefined ? { goal: result.cycles.at(-1)?.goal } : {}),
    ...(result.budget !== undefined ? { budget: result.budget } : {}),
    ...(knowledgeHygiene !== undefined ? { knowledge_hygiene: knowledgeHygiene } : {}),
    cycles: result.cycles.map((cycle) => ({
      discovered_task_count: cycle.discoveredTaskCount,
      executed_task_count: cycle.executedTaskCount,
      skipped_task_count: cycle.skippedTaskCount,
      ...(cycle.goal !== undefined ? { goal: cycle.goal } : {}),
    })),
  };
}

async function finalizeLoopKnowledgeHygiene(
  enabled: boolean,
  workspacePath: string,
  result: LoopRunResult | LoopRunCyclesResult,
): Promise<LoopNeatFinalizerResultV1 | undefined> {
  return runLoopNeatFinalizer({
    enabled,
    loop_succeeded: result.state.completed_tasks.length > 0
      && result.state.completed_tasks.every((task) => task.outcome === "success")
      && result.budget?.exceeded !== true,
    workspace_path: workspacePath,
  });
}

function persistLoopRunEvidence(ctx: DaemonContext, result: LoopRunResult | LoopRunCyclesResult): string {
  const runId = `loop_run_${randomUUID().slice(0, 8)}`;
  const taskId = `loop_task_${runId}`;
  const now = Date.now() / 1000;
  const outcome = result.state.completed_tasks.some((task) => task.outcome !== "success")
    ? "failed"
    : "completed";

  insertTask(ctx.db, ctx.dbPath, {
    task_id: taskId,
    title: `Loop run ${result.loop_id}`,
    description: `Persisted evidence for loop ${result.loop_id}`,
    created_at: now,
  });
  insertRun(ctx.db, ctx.dbPath, {
    run_id: runId,
    task_id: taskId,
    session_id: result.loop_id,
    agent_id: "osstack-loop",
    capability_id: "loop.engine",
    phase: "loop",
    started_at: now,
  });

  for (const event of result.events) {
    appendEvent(ctx.db, ctx.dbPath, {
      event_id: `${runId}:${event.seq}`,
      run_id: runId,
      session_id: result.loop_id,
      seq: event.seq,
      type: event.type,
      created_at: event.created_at,
      terminal: event.type === "loop.stopped",
      payload: {
        ...(event.payload ?? {}),
        loop_event_id: event.event_id,
      },
    } as unknown as HermesEvent);
  }
  finalizeRun(ctx.db, ctx.dbPath, runId, outcome, Date.now() / 1000);
  requestSupervisionScan(ctx, "loop.run.persisted");
  return runId;
}

interface LoopStartSchedule {
  intervalMs: number;
  stopWhenIdle: boolean;
  cycles?: number;
  scheduleExpression?: string;
}

async function startLoopSession(
  ctx: DaemonContext,
  runOptions: LoopRunOptions,
  schedule: LoopStartSchedule,
): Promise<Record<string, unknown>> {
  const workspacePath = runOptions.workspacePath ?? process.cwd();
  const stateFilePath = resolveDaemonLoopPath(runOptions.stateFilePath ?? "LOOP-STATE.json", workspacePath);
  const normalizedRunOptions: LoopRunOptions = {
    ...withoutRuntimeAdapters(runOptions),
    workspacePath,
    stateFilePath,
  };
  const now = Date.now();
  const session: LoopSession = {
    loopSessionId: `loop_session_${randomUUID().slice(0, 8)}`,
    workspacePath,
    stateFilePath,
    intervalMs: schedule.intervalMs,
    stopWhenIdle: schedule.stopWhenIdle,
    status: "running",
    startedAt: now,
    updatedAt: now,
    cycleCount: 0,
    discoveredTaskCount: 0,
    executedTaskCount: 0,
    skippedTaskCount: 0,
    successfulTaskCount: 0,
    failedTaskCount: 0,
    escalatedTaskCount: 0,
    tokensConsumed: 0,
    costConsumed: 0,
    totalCycleDurationMs: 0,
    failureStreaks: {},
    noProgressCycles: 0,
    abort: new AbortController(),
    runOptions: normalizedRunOptions,
    ...(schedule.cycles !== undefined ? { maxCycles: schedule.cycles } : {}),
    ...(schedule.scheduleExpression !== undefined ? { scheduleExpression: schedule.scheduleExpression } : {}),
  };
  ctx.loopSessions.set(session.loopSessionId, session);
  await persistLoopSessions(ctx);
  session.done = runLoopSession(ctx, session);
  return loopSessionSummary(session);
}

async function runLoopSession(ctx: DaemonContext, session: LoopSession): Promise<void> {
  const budget = session.runOptions.budget;
  try {
    while (!session.abort.signal.aborted) {
      if (session.maxCycles !== undefined && session.cycleCount >= session.maxCycles) {
        await markLoopSessionStopped(ctx, session, "max cycles reached");
        return;
      }

      if (session.scheduleExpression !== undefined) {
        const delayMs = nextCronDelayMs(session.scheduleExpression, new Date(), {
          includeCurrentMinute: session.cycleCount === 0,
        });
        if (delayMs instanceof Error) throw delayMs;
        if (delayMs > 0) await sleep(delayMs, undefined, { signal: session.abort.signal });
      }

      const cycleStartedAt = Date.now();
      const result = await new LoopEngine(withLoopAdapters(ctx, session.runOptions, session.abort.signal)).runOnce();
      // Kernel gate (R2.2): the per-tick engine consulted the policy gate at
      // entry (the gate re-reads policy.yaml each consult). A mid-session flip
      // to `mode: observe` denies here — stop the session cleanly with a
      // `policy_denied` stop_reason, persisted exactly like a budget stop.
      // Checked before counters advance so a refused tick is not counted.
      if (result.policy?.denied === true) {
        // The observe reason already carries the `policy_denied:` marker; a
        // fail-closed reason (loader error) gets it prefixed so every policy
        // stop is greppable, matching the loop's own loop.stopped wording.
        const stopReason = result.policy.reason.startsWith("policy_denied")
          ? result.policy.reason
          : `policy_denied: ${result.policy.reason}`;
        await markLoopSessionStopped(ctx, session, stopReason);
        return;
      }
      const cycleDurationMs = Date.now() - cycleStartedAt;
      session.cycleCount += 1;
      session.discoveredTaskCount += result.discoveredTaskCount;
      session.executedTaskCount += result.executedTaskCount;
      session.skippedTaskCount += result.skippedTaskCount;
      for (const completedTask of result.completedTasks) {
        if (completedTask.outcome === "success") session.successfulTaskCount += 1;
        else if (completedTask.outcome === "failed") session.failedTaskCount += 1;
        else {
          session.escalatedTaskCount += 1;
          notifyLoopEscalation(ctx, session, result, completedTask);
        }
        const streak = updateLoopFailureStreak(session, completedTask);
        if (streak !== undefined) notifyLoopFailureStreak(ctx, session, streak);
      }
      session.tokensConsumed = result.state.key_metrics?.tokens_consumed ?? session.tokensConsumed;
      session.costConsumed = result.state.key_metrics?.cost_consumed ?? session.costConsumed;
      session.totalCycleDurationMs += cycleDurationMs;
      session.lastCycleDurationMs = cycleDurationMs;
      session.lastJsonPath = result.jsonPath;
      session.lastMarkdownPath = result.markdownPath;
      if (result.state.wait_reason === undefined) delete session.waitReason;
      else session.waitReason = result.state.wait_reason;
      session.updatedAt = Date.now();
      await persistLoopSessions(ctx);

      if (budget !== undefined) {
        if (result.executedTaskCount > 0) {
          const madeProgress = result.completedTasks.some((task) => task.outcome === "success");
          session.noProgressCycles = madeProgress ? 0 : session.noProgressCycles + 1;
        }
        const usage = {
          cycles: session.cycleCount,
          runtime_ms: Date.now() - session.startedAt,
          tokens: session.tokensConsumed,
          estimated_cost_usd: session.costConsumed,
          no_progress_cycles: session.noProgressCycles,
        };
        const check = checkBudget(budget, usage);
        session.lastBudgetCheck = { ...check, usage };
        await persistLoopSessions(ctx);
        if (check.exceeded) {
          await markLoopSessionStopped(ctx, session, `budget exceeded: ${check.reason}`);
          return;
        }
      }

      if (result.goal?.pass === true) {
        await markLoopSessionStopped(ctx, session, "goal command passed");
        return;
      }
      if (session.stopWhenIdle && result.executedTaskCount === 0) {
        await markLoopSessionStopped(ctx, session, result.state.wait_reason === undefined
          ? "idle cycle completed"
          : `discovery_deferred: needs_approval=${result.state.wait_reason.needs_approval}, suggest_only=${result.state.wait_reason.suggest_only}, blocked=${result.state.wait_reason.blocked}`);
        return;
      }
      if (session.maxCycles !== undefined && session.cycleCount >= session.maxCycles) {
        await markLoopSessionStopped(ctx, session, "max cycles reached");
        return;
      }

      if (session.scheduleExpression === undefined) {
        await sleep(session.intervalMs, undefined, { signal: session.abort.signal });
      }
    }
    if (!session.shutdownRequested) await markLoopSessionStopped(ctx, session, session.stopReason ?? "stopped by request");
  } catch (err) {
    if (session.abort.signal.aborted || (err as Error).name === "AbortError") {
      if (!session.shutdownRequested) await markLoopSessionStopped(ctx, session, session.stopReason ?? "stopped by request");
      return;
    }
    session.status = "failed";
    session.lastError = err instanceof Error ? err.message : String(err);
    session.updatedAt = Date.now();
    await persistLoopSessions(ctx);
  }
}

function stopLoopSession(session: LoopSession, reason: string): void {
  if (session.status === "running") session.status = "stopping";
  session.stopReason = reason;
  session.updatedAt = Date.now();
  session.abort.abort();
}

function notifyLoopEscalation(
  ctx: DaemonContext,
  session: LoopSession,
  result: LoopRunResult,
  completedTask: CompletedTask,
): void {
  const payload = result.events.find((event) => (
    event.type === "loop.escalated"
    && (event.payload as { task_id?: unknown } | undefined)?.task_id === completedTask.task_id
  ))?.payload as {
    reason?: unknown;
    iteration?: unknown;
    max_iterations?: unknown;
    escalate_to?: unknown;
    agent_id?: unknown;
  } | undefined;
  const reason = typeof payload?.reason === "string"
    ? payload.reason
    : `Loop task ${completedTask.task_id} escalated after ${completedTask.iterations} iteration(s).`;
  const cardId = loopEscalationCardId(session.loopSessionId, completedTask.task_id);
  const body = [
    `Workspace: ${session.workspacePath}`,
    `Loop session: ${session.loopSessionId}`,
    `Loop id: ${result.loop_id}`,
    `Task: ${completedTask.task_id}`,
    `Iterations: ${completedTask.iterations}`,
    `Escalate to: ${typeof payload?.escalate_to === "string" ? payload.escalate_to : "hermes"}`,
    `Reason: ${reason}`,
  ].join("\n");

  try {
    const existing = ctx.kanban.getCard(cardId);
    if (existing === undefined) {
      ctx.kanban.createCard({
        card_id: cardId,
        task_id: `loop:${session.loopSessionId}:${completedTask.task_id}`,
        title: `Loop escalation: ${completedTask.task_id}`,
        body,
        status: "triage",
        priority: 90,
        assignee: "osstack-loop",
      });
      ctx.kanban.moveCard(cardId, "blocked", {
        actor: "osstack-loop",
        blocked_reason: reason,
      });
    } else {
      ctx.kanban.patchCard(cardId, {
        body,
        priority: 90,
        assignee: "osstack-loop",
      });
      ctx.kanban.addComment(cardId, "osstack-loop", reason);
      if (existing.status !== "blocked") {
        ctx.kanban.moveCard(cardId, "blocked", {
          actor: "osstack-loop",
          blocked_reason: reason,
        });
      }
    }
  } catch (err) {
    process.stderr.write(`osstack: loop escalation kanban notification failed: ${(err as Error).message}\n`);
  }
}

function loopEscalationCardId(loopSessionId: string, taskId: string): string {
  const stable = createHash("sha1").update(`${loopSessionId}:${taskId}`).digest("hex").slice(0, 12);
  return `card_loop_${stable}`;
}

function updateLoopFailureStreak(session: LoopSession, completedTask: CompletedTask): LoopFailureStreak | undefined {
  const capability = completedTask.capability;
  if (capability === undefined || capability.trim() === "") return undefined;

  if (completedTask.outcome === "success") {
    delete session.failureStreaks[capability];
    return undefined;
  }

  const previous = session.failureStreaks[capability];
  const next: LoopFailureStreak = {
    capability,
    count: (previous?.count ?? 0) + 1,
    lastTaskId: completedTask.task_id,
    updatedAt: Date.now(),
    ...(previous?.lastEscalatedAtCount !== undefined ? { lastEscalatedAtCount: previous.lastEscalatedAtCount } : {}),
  };
  const shouldEscalate = next.count >= LOOP_FAILURE_STREAK_THRESHOLD
    && next.count % LOOP_FAILURE_STREAK_THRESHOLD === 0
    && next.lastEscalatedAtCount !== next.count;
  if (shouldEscalate) next.lastEscalatedAtCount = next.count;
  session.failureStreaks[capability] = next;
  return shouldEscalate ? next : undefined;
}

function notifyLoopFailureStreak(ctx: DaemonContext, session: LoopSession, streak: LoopFailureStreak): void {
  const cardId = loopFailureStreakCardId(session.loopSessionId, streak.capability);
  const reason = `${streak.count} consecutive ${streak.capability} loop task failures; latest task ${streak.lastTaskId}.`;
  const body = [
    `Workspace: ${session.workspacePath}`,
    `Loop session: ${session.loopSessionId}`,
    `Capability: ${streak.capability}`,
    `Consecutive failures: ${streak.count}`,
    `Latest task: ${streak.lastTaskId}`,
    `Reason: ${reason}`,
  ].join("\n");

  try {
    const existing = ctx.kanban.getCard(cardId);
    if (existing === undefined) {
      ctx.kanban.createCard({
        card_id: cardId,
        task_id: `loop-streak:${session.loopSessionId}:${streak.capability}`,
        title: `Loop failure streak: ${streak.capability}`,
        body,
        status: "triage",
        priority: 95,
        assignee: "osstack-loop",
      });
      ctx.kanban.moveCard(cardId, "blocked", {
        actor: "osstack-loop",
        blocked_reason: reason,
      });
    } else {
      ctx.kanban.patchCard(cardId, {
        body,
        priority: 95,
        assignee: "osstack-loop",
      });
      ctx.kanban.addComment(cardId, "osstack-loop", reason);
      if (existing.status !== "blocked") {
        ctx.kanban.moveCard(cardId, "blocked", {
          actor: "osstack-loop",
          blocked_reason: reason,
        });
      }
    }
  } catch (err) {
    process.stderr.write(`osstack: loop failure streak kanban notification failed: ${(err as Error).message}\n`);
  }
}

function loopFailureStreakCardId(loopSessionId: string, capability: string): string {
  const stable = createHash("sha1").update(`${loopSessionId}:${capability}`).digest("hex").slice(0, 12);
  return `card_loop_streak_${stable}`;
}

async function markLoopSessionStopped(ctx: DaemonContext, session: LoopSession, reason: string): Promise<void> {
  session.status = "stopped";
  session.stopReason = reason;
  session.updatedAt = Date.now();
  await persistLoopSessions(ctx);
}

function activeLoopCount(ctx: DaemonContext): number {
  return Array.from(ctx.loopSessions.values())
    .filter((session) => session.status === "running" || session.status === "stopping")
    .length;
}

function loopSessionSummary(session: LoopSession): Record<string, unknown> {
  const budget = loopBudgetStat(session);
  return {
    loop_session_id: session.loopSessionId,
    workspace_path: session.workspacePath,
    state_json: session.stateFilePath,
    status: session.status,
    interval_ms: session.intervalMs,
    stop_when_idle: session.stopWhenIdle,
    ...(session.scheduleExpression !== undefined ? { schedule: session.scheduleExpression } : {}),
    started_at: session.startedAt,
    updated_at: session.updatedAt,
    cycle_count: session.cycleCount,
    discovered_task_count: session.discoveredTaskCount,
    executed_task_count: session.executedTaskCount,
    skipped_task_count: session.skippedTaskCount,
    successful_task_count: session.successfulTaskCount,
    failed_task_count: session.failedTaskCount,
    escalated_task_count: session.escalatedTaskCount,
    tokens_consumed: session.tokensConsumed,
    total_cycle_duration_ms: session.totalCycleDurationMs,
    avg_cycle_duration_ms: session.cycleCount === 0 ? null : session.totalCycleDurationMs / session.cycleCount,
    failure_streaks: Object.values(session.failureStreaks),
    ...(session.runOptions.profileRouting !== undefined
      ? { profile: session.runOptions.profileRouting }
      : {}),
    ...(budget !== undefined ? { budget } : {}),
    ...(session.lastCycleDurationMs !== undefined ? { last_cycle_duration_ms: session.lastCycleDurationMs } : {}),
    ...(session.maxCycles !== undefined ? { max_cycles: session.maxCycles } : {}),
    ...(session.lastJsonPath !== undefined ? { last_json_path: session.lastJsonPath } : {}),
    ...(session.lastMarkdownPath !== undefined ? { last_markdown_path: session.lastMarkdownPath } : {}),
    ...(session.stopReason !== undefined ? { stop_reason: session.stopReason } : {}),
    ...(session.waitReason !== undefined ? { wait_reason: session.waitReason } : {}),
    ...(session.lastError !== undefined ? { last_error: session.lastError } : {}),
  };
}

async function persistLoopSessions(ctx: DaemonContext): Promise<void> {
  const payload: PersistedLoopSessionsFile = {
    version: 1,
    sessions: Array.from(ctx.loopSessions.values()).map((session) => ({
      loopSessionId: session.loopSessionId,
      status: session.status,
      runOptions: withoutRuntimeAdapters(session.runOptions),
      intervalMs: session.intervalMs,
      stopWhenIdle: session.stopWhenIdle,
      ...(session.scheduleExpression !== undefined ? { scheduleExpression: session.scheduleExpression } : {}),
      startedAt: session.startedAt,
      updatedAt: session.updatedAt,
      cycleCount: session.cycleCount,
      discoveredTaskCount: session.discoveredTaskCount,
      executedTaskCount: session.executedTaskCount,
      skippedTaskCount: session.skippedTaskCount,
      successfulTaskCount: session.successfulTaskCount,
      failedTaskCount: session.failedTaskCount,
      escalatedTaskCount: session.escalatedTaskCount,
      tokensConsumed: session.tokensConsumed,
      costConsumed: session.costConsumed,
      totalCycleDurationMs: session.totalCycleDurationMs,
      failureStreaks: session.failureStreaks,
      noProgressCycles: session.noProgressCycles,
      ...(session.lastBudgetCheck !== undefined ? { lastBudgetCheck: session.lastBudgetCheck } : {}),
      ...(session.maxCycles !== undefined ? { maxCycles: session.maxCycles } : {}),
      ...(session.lastCycleDurationMs !== undefined ? { lastCycleDurationMs: session.lastCycleDurationMs } : {}),
      ...(session.lastJsonPath !== undefined ? { lastJsonPath: session.lastJsonPath } : {}),
      ...(session.lastMarkdownPath !== undefined ? { lastMarkdownPath: session.lastMarkdownPath } : {}),
      ...(session.lastError !== undefined ? { lastError: session.lastError } : {}),
      ...(session.stopReason !== undefined ? { stopReason: session.stopReason } : {}),
      ...(session.waitReason !== undefined ? { waitReason: session.waitReason } : {}),
    })),
  };
  // Atomic write (temp + rename): loop-sessions.json is read concurrently by
  // tests and tooling while the daemon persists after every cycle; a plain
  // writeFile lets readers observe a truncated file mid-write ("Unexpected end
  // of JSON input"), and a crash mid-write would corrupt restore state. The
  // monotonic counter keeps tmp names unique across same-millisecond persists
  // (Date.now() alone can collide, making the second rename fail). Persistence
  // is a best-effort snapshot — restore tolerates a missing file — so a failed
  // write (e.g. home dir removed during shutdown) must never reject a loop
  // session's completion promise.
  const tmpPath = join(
    dirname(ctx.loopSessionsPath),
    `.${basename(ctx.loopSessionsPath)}.${process.pid}.${persistCounter++}.tmp`,
  );
  try {
    await writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
    await rename(tmpPath, ctx.loopSessionsPath);
    requestSupervisionScan(ctx, "loop.snapshot.persisted");
  } catch {
    // best-effort: swallow snapshot failures (next persist will retry)
  }
}

let persistCounter = 0;

async function restoreLoopSessions(ctx: DaemonContext): Promise<void> {
  let parsed: PersistedLoopSessionsFile;
  try {
    parsed = JSON.parse(await readFile(ctx.loopSessionsPath, "utf-8")) as PersistedLoopSessionsFile;
  } catch {
    return;
  }
  if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) return;

  for (const saved of parsed.sessions) {
    const workspacePath = saved.runOptions.workspacePath ?? process.cwd();
    const stateFilePath = resolveDaemonLoopPath(saved.runOptions.stateFilePath ?? "LOOP-STATE.json", workspacePath);
    const restoredRunOptions: LoopRunOptions = {
      ...withoutRuntimeAdapters(saved.runOptions),
      workspacePath,
      stateFilePath,
    };
    // A snapshot cannot prove the previous writer stopped or a side effect failed.
    // Preserve worktrees and pending tasks; recovery requires explicit inspection.
    const restoredWait = LoopWaitReason.safeParse(saved.waitReason);
    const session: LoopSession = {
      loopSessionId: saved.loopSessionId,
      workspacePath,
      stateFilePath,
      intervalMs: saved.intervalMs,
      stopWhenIdle: saved.stopWhenIdle,
      status: saved.status === "running" || saved.status === "stopping" ? "stopped" : saved.status,
      startedAt: saved.startedAt,
      updatedAt: Date.now(),
      cycleCount: saved.cycleCount,
      discoveredTaskCount: saved.discoveredTaskCount,
      executedTaskCount: saved.executedTaskCount,
      skippedTaskCount: saved.skippedTaskCount,
      successfulTaskCount: saved.successfulTaskCount ?? 0,
      failedTaskCount: saved.failedTaskCount ?? 0,
      escalatedTaskCount: saved.escalatedTaskCount ?? 0,
      tokensConsumed: saved.tokensConsumed ?? 0,
      costConsumed: saved.costConsumed ?? 0,
      totalCycleDurationMs: saved.totalCycleDurationMs ?? 0,
      failureStreaks: saved.failureStreaks ?? {},
      noProgressCycles: saved.noProgressCycles ?? 0,
      abort: new AbortController(),
      runOptions: restoredRunOptions,
      ...(restoredWait.success ? { waitReason: restoredWait.data } : {}),
      ...(saved.lastBudgetCheck !== undefined ? { lastBudgetCheck: saved.lastBudgetCheck } : {}),
      ...(saved.maxCycles !== undefined ? { maxCycles: saved.maxCycles } : {}),
      ...(saved.lastCycleDurationMs !== undefined ? { lastCycleDurationMs: saved.lastCycleDurationMs } : {}),
      ...(saved.scheduleExpression !== undefined ? { scheduleExpression: saved.scheduleExpression } : {}),
      ...(saved.lastJsonPath !== undefined ? { lastJsonPath: saved.lastJsonPath } : {}),
      ...(saved.lastMarkdownPath !== undefined ? { lastMarkdownPath: saved.lastMarkdownPath } : {}),
      ...(saved.lastError !== undefined ? { lastError: saved.lastError } : {}),
      ...(saved.status === "running" || saved.status === "stopping"
        ? { stopReason: "recovery_required: previous writer and side effects are unconfirmed; work retained" }
        : saved.stopReason !== undefined ? { stopReason: saved.stopReason } : {}),
    };
    ctx.loopSessions.set(session.loopSessionId, session);
  }
  await persistLoopSessions(ctx);
}

// ──────────────────────────────────────────────────────────────────────
// Daily-brief session lifecycle (R2.3)
// ──────────────────────────────────────────────────────────────────────

interface DailySchedule {
  registryPath: string;
  intervalMs: number;
  scheduleExpression?: string;
}

function parseDailyScheduleParams(params: unknown): DailySchedule | Error {
  const p = objectParams(params);
  if (p instanceof Error) return p;
  const registryPath = optionalString(p, "registryPath");
  if (registryPath === undefined) return new Error("params.registryPath required");
  const intervalMs = optionalNonNegativeInteger(p, "intervalMs");
  if (intervalMs instanceof Error) return intervalMs;
  if (intervalMs === undefined) return new Error("params.intervalMs required");
  // Unlike loop sessions (where 0 means "run cycles back-to-back on purpose"),
  // a 0-interval daily session would just hot-loop re-generating the same
  // brief — always a mistake, so refuse it here.
  if (intervalMs === 0) return new Error("params.intervalMs must be greater than 0");
  const scheduleExpression = optionalString(p, "schedule");
  return {
    registryPath,
    intervalMs,
    ...(scheduleExpression !== undefined ? { scheduleExpression } : {}),
  };
}

async function startDailySession(ctx: DaemonContext, schedule: DailySchedule): Promise<Record<string, unknown>> {
  const now = Date.now();
  const session: DailySession = {
    dailySessionId: `daily_session_${randomUUID().slice(0, 8)}`,
    registryPath: schedule.registryPath,
    intervalMs: schedule.intervalMs,
    status: "running",
    startedAt: now,
    updatedAt: now,
    tickCount: 0,
    consecutiveFailureCount: 0,
    abort: new AbortController(),
    ...(schedule.scheduleExpression !== undefined ? { scheduleExpression: schedule.scheduleExpression } : {}),
  };
  ctx.dailySessions.set(session.dailySessionId, session);
  await persistDailySessions(ctx);
  session.done = runDailySession(ctx, session);
  return dailySessionSummary(session);
}

async function runDailySession(ctx: DaemonContext, session: DailySession): Promise<void> {
  try {
    while (!session.abort.signal.aborted) {
      let stop = false;
      // Policy (R2.3): daily is a READ-ONLY composition — its only write is the
      // dated brief JSON — so it is intentionally NOT observe-gated. Observing
      // is precisely what `mode: observe` permits, so no makePolicyGate consult
      // happens here; a scheduled brief runs regardless of workspace policy.
      try {
        const {createDailyAttentionReader} = await import("./daily-attention.js");
        const run = await runDailyBrief({
          registryPath: session.registryPath,
          signal: session.abort.signal,
          attentionReader: createDailyAttentionReader(ctx.db, () => ctx.draining ? "unavailable" : ctx.supervision ? "running" : "disabled"),
        });
        session.lastBriefPath = run.briefPath;
        session.lastResultStatus = run.result.status;
        session.consecutiveFailureCount = 0;
        delete session.lastError;
      } catch (err) {
        // A tick failure must never crash the daemon or kill the session: record
        // it, count it, keep ticking — until the consecutive-failure ceiling.
        session.consecutiveFailureCount += 1;
        session.lastResultStatus = "error";
        session.lastError = err instanceof Error ? err.message : String(err);
        if (session.consecutiveFailureCount >= DAILY_FAILURE_STOP_THRESHOLD) stop = true;
      }
      session.tickCount += 1;
      session.updatedAt = Date.now();
      await persistDailySessions(ctx);
      if (stop) {
        await markDailySessionStopped(
          ctx,
          session,
          `stopped after ${DAILY_FAILURE_STOP_THRESHOLD} consecutive failures: ${session.lastError}`,
        );
        return;
      }
      await sleep(session.intervalMs, undefined, { signal: session.abort.signal });
    }
    if (!session.shutdownRequested) await markDailySessionStopped(ctx, session, session.stopReason ?? "stopped by request");
  } catch (err) {
    if (session.abort.signal.aborted || (err as Error).name === "AbortError") {
      if (!session.shutdownRequested) await markDailySessionStopped(ctx, session, session.stopReason ?? "stopped by request");
      return;
    }
    session.status = "failed";
    session.lastError = err instanceof Error ? err.message : String(err);
    session.updatedAt = Date.now();
    await persistDailySessions(ctx);
  }
}

function stopDailySession(session: DailySession, reason: string): void {
  if (session.status === "running") session.status = "stopping";
  session.stopReason = reason;
  session.updatedAt = Date.now();
  session.abort.abort();
}

async function markDailySessionStopped(ctx: DaemonContext, session: DailySession, reason: string): Promise<void> {
  session.status = "stopped";
  session.stopReason = reason;
  session.updatedAt = Date.now();
  await persistDailySessions(ctx);
}

function dailySessionSummary(session: DailySession): Record<string, unknown> {
  return {
    daily_session_id: session.dailySessionId,
    registry_path: session.registryPath,
    status: session.status,
    interval_ms: session.intervalMs,
    ...(session.scheduleExpression !== undefined ? { schedule: session.scheduleExpression } : {}),
    started_at: session.startedAt,
    updated_at: session.updatedAt,
    tick_count: session.tickCount,
    consecutive_failure_count: session.consecutiveFailureCount,
    ...(session.lastBriefPath !== undefined ? { last_brief_path: session.lastBriefPath } : {}),
    ...(session.lastResultStatus !== undefined ? { last_result_status: session.lastResultStatus } : {}),
    ...(session.stopReason !== undefined ? { stop_reason: session.stopReason } : {}),
    ...(session.lastError !== undefined ? { last_error: session.lastError } : {}),
  };
}

async function persistDailySessions(ctx: DaemonContext): Promise<void> {
  const payload: PersistedDailySessionsFile = {
    version: 1,
    sessions: Array.from(ctx.dailySessions.values()).map((session) => ({
      dailySessionId: session.dailySessionId,
      registryPath: session.registryPath,
      intervalMs: session.intervalMs,
      ...(session.scheduleExpression !== undefined ? { scheduleExpression: session.scheduleExpression } : {}),
      status: session.status,
      startedAt: session.startedAt,
      updatedAt: session.updatedAt,
      tickCount: session.tickCount,
      consecutiveFailureCount: session.consecutiveFailureCount,
      ...(session.lastBriefPath !== undefined ? { lastBriefPath: session.lastBriefPath } : {}),
      ...(session.lastResultStatus !== undefined ? { lastResultStatus: session.lastResultStatus } : {}),
      ...(session.lastError !== undefined ? { lastError: session.lastError } : {}),
      ...(session.stopReason !== undefined ? { stopReason: session.stopReason } : {}),
    })),
  };
  // Atomic write (temp + rename), same rationale as persistLoopSessions: readers
  // (tests/tooling) must never observe a truncated daily-sessions.json, and a
  // failed snapshot (e.g. home removed mid-shutdown) must never reject a tick.
  const tmpPath = join(
    dirname(ctx.dailySessionsPath),
    `.${basename(ctx.dailySessionsPath)}.${process.pid}.${persistCounter++}.tmp`,
  );
  try {
    await writeFile(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, "utf-8");
    await rename(tmpPath, ctx.dailySessionsPath);
  } catch {
    // best-effort snapshot (next persist will retry)
  }
}

async function restoreDailySessions(ctx: DaemonContext): Promise<void> {
  let parsed: PersistedDailySessionsFile;
  try {
    parsed = JSON.parse(await readFile(ctx.dailySessionsPath, "utf-8")) as PersistedDailySessionsFile;
  } catch {
    return;
  }
  if (parsed.version !== 1 || !Array.isArray(parsed.sessions)) return;

  for (const saved of parsed.sessions) {
    const session: DailySession = {
      dailySessionId: saved.dailySessionId,
      registryPath: saved.registryPath,
      intervalMs: saved.intervalMs,
      // An interrupted "stopping" session is treated as stopped on restore (its
      // abort never completed), mirroring loop-session restore semantics.
      status: saved.status === "running" || saved.status === "stopping" ? "stopped" : saved.status,
      startedAt: saved.startedAt,
      updatedAt: Date.now(),
      tickCount: saved.tickCount ?? 0,
      consecutiveFailureCount: saved.consecutiveFailureCount ?? 0,
      abort: new AbortController(),
      ...(saved.scheduleExpression !== undefined ? { scheduleExpression: saved.scheduleExpression } : {}),
      ...(saved.lastBriefPath !== undefined ? { lastBriefPath: saved.lastBriefPath } : {}),
      ...(saved.lastResultStatus !== undefined ? { lastResultStatus: saved.lastResultStatus } : {}),
      ...(saved.lastError !== undefined ? { lastError: saved.lastError } : {}),
      ...(saved.status === "running" || saved.status === "stopping"
        ? { stopReason: "recovery_required: previous writer and side effects are unconfirmed; work retained" }
        : saved.stopReason !== undefined ? { stopReason: saved.stopReason } : {}),
    };
    ctx.dailySessions.set(session.dailySessionId, session);
    // Interrupted sessions remain stopped until an explicit new schedule.
  }
  await persistDailySessions(ctx);
}

function parseLoopRunParams(
  params: unknown,
): { runOptions: LoopRunOptions; cyclesOptions?: LoopRunCyclesOptions; neatFinalize: boolean } | Error {
  const p = objectParams(params);
  if (p instanceof Error) return p;

  const workspacePath = optionalString(p, "workspacePath") ?? process.cwd();
  const stateFilePath = optionalString(p, "stateFilePath") ?? "LOOP-STATE.json";
  const markdownPath = optionalString(p, "markdownPath");
  const loopId = optionalString(p, "loopId");
  const executeCommand = optionalString(p, "executeCommand");
  const agentId = optionalString(p, "agentId");
  const goalCommand = optionalString(p, "goalCommand");
  const worktreeRoot = optionalString(p, "worktreeRoot");
  const archiveCompletedTasks = optionalBoolean(p, "archiveCompletedTasks");
  if (archiveCompletedTasks instanceof Error) return archiveCompletedTasks;
  const autoAgent = optionalBoolean(p, "autoAgent");
  if (autoAgent instanceof Error) return autoAgent;
  const useWorktree = optionalBoolean(p, "useWorktree");
  if (useWorktree instanceof Error) return useWorktree;
  const enforceRoleSeparation = optionalBoolean(p, "enforceRoleSeparation");
  if (enforceRoleSeparation instanceof Error) return enforceRoleSeparation;
  const sources = optionalStringArray(p, "sources");
  if (sources instanceof Error) return sources;
  const verifyCommands = optionalStringArray(p, "verifyCommands");
  if (verifyCommands instanceof Error) return verifyCommands;
  const verifierAgentIds = optionalStringArray(p, "verifierAgentIds");
  if (verifierAgentIds instanceof Error) return verifierAgentIds;
  const artifactVerification = optionalArtifactVerification(p, "artifactVerification");
  if (artifactVerification instanceof Error) return artifactVerification;
  const profileRouting = optionalProfileRouting(p, "profileRouting");
  if (profileRouting instanceof Error) return profileRouting;
  const maxIterations = optionalPositiveInteger(p, "maxIterations");
  if (maxIterations instanceof Error) return maxIterations;
  const commandTimeoutMs = optionalPositiveInteger(p, "commandTimeoutMs");
  if (commandTimeoutMs instanceof Error) return commandTimeoutMs;
  const outputLimit = optionalPositiveInteger(p, "outputLimit");
  if (outputLimit instanceof Error) return outputLimit;
  const cycles = optionalPositiveInteger(p, "cycles");
  if (cycles instanceof Error) return cycles;
  const intervalMs = optionalNonNegativeInteger(p, "intervalMs");
  if (intervalMs instanceof Error) return intervalMs;
  const stopWhenIdle = optionalBoolean(p, "stopWhenIdle");
  if (stopWhenIdle instanceof Error) return stopWhenIdle;
  const knowledge = optionalKnowledgeTrace(p, "knowledge");
  if (knowledge instanceof Error) return knowledge;
  const discoveryPolicy = optionalDiscoveryPolicy(p, "discoveryPolicy");
  if (discoveryPolicy instanceof Error) return discoveryPolicy;
  const budget = optionalLoopBudget(p, "budget");
  if (budget instanceof Error) return budget;
  const lessonDrafts = optionalLessonDrafts(p, "lessonDrafts");
  if (lessonDrafts instanceof Error) return lessonDrafts;
  const neatFinalize = optionalBoolean(p, "neatFinalize");
  if (neatFinalize instanceof Error) return neatFinalize;

  const runOptions: LoopRunOptions = {
    workspacePath,
    stateFilePath,
    ...(markdownPath !== undefined ? { markdownPath } : {}),
    ...(loopId !== undefined ? { loopId } : {}),
    ...(executeCommand !== undefined ? { executeCommand } : {}),
    ...(agentId !== undefined ? { agentId } : {}),
    ...(autoAgent !== undefined ? { autoAgent } : {}),
    ...(goalCommand !== undefined ? { goalCommand } : {}),
    ...(archiveCompletedTasks !== undefined ? { archiveCompletedTasks } : {}),
    ...(useWorktree !== undefined ? { useWorktree } : {}),
    ...(enforceRoleSeparation !== undefined ? { enforceRoleSeparation } : {}),
    ...(worktreeRoot !== undefined ? { worktreeRoot } : {}),
    ...(sources !== undefined ? { sources } : {}),
    ...(verifyCommands !== undefined ? { verifyCommands } : {}),
    ...(verifierAgentIds !== undefined ? { verifierAgentIds } : {}),
    ...(artifactVerification !== undefined ? { artifactVerification } : {}),
    ...(profileRouting !== undefined ? { profileRouting } : {}),
    ...(discoveryPolicy !== undefined ? { discoveryPolicy } : {}),
    ...(budget !== undefined ? { budget } : {}),
    ...(lessonDrafts !== undefined ? { lessonDrafts } : {}),
    ...(maxIterations !== undefined ? { maxIterations } : {}),
    ...(commandTimeoutMs !== undefined ? { commandTimeoutMs } : {}),
    ...(outputLimit !== undefined ? { outputLimit } : {}),
    ...(knowledge !== undefined ? { knowledge } : {}),
  };
  const cyclesOptions = cycles !== undefined || intervalMs !== undefined || stopWhenIdle !== undefined
    ? {
        ...(cycles !== undefined ? { cycles } : {}),
        ...(intervalMs !== undefined ? { intervalMs } : {}),
        ...(stopWhenIdle !== undefined ? { stopWhenIdle } : {}),
      }
    : undefined;

  return {
    runOptions,
    neatFinalize: neatFinalize === true,
    ...(cyclesOptions !== undefined ? { cyclesOptions } : {}),
  };
}

function withLoopAdapters(ctx: DaemonContext, runOptions: LoopRunOptions, signal?: AbortSignal): LoopRunOptions {
  // Kernel policy gate (R2.2): injected fresh on EVERY engine construction. The
  // gate re-reads `.osstack/policy.yaml` per consult (no caching), so a
  // long-lived session honors a mid-flight flip to `mode: observe` on its next
  // tick — the scheduler builds a new engine via this helper each cycle. Never
  // persisted into runOptions (it is a function; see withoutRuntimeAdapters).
  const freshPolicyGate = makeRepositoryPolicyGate(runOptions.workspacePath ?? process.cwd());
  let deniedReason: string | undefined;
  const policyGate: NonNullable<LoopRunOptions["policyGate"]> = async (context) =>
    deniedReason === undefined ? freshPolicyGate(context) : { allow: false, reason: deniedReason };
  const lifecycleLease: NonNullable<LoopRunOptions["lifecycleLease"]> = async ({ workspacePath }) => {
    // Local socket options identify the workspace; adapter context never does.
    // Policy denial keeps the established engine refusal result and no effects.
    const decision = await policyGate({ workspacePath });
    if (!decision.allow) {
      // A denied admission can never become an unlocked allow if the policy
      // file changes between this consult and the engine entry consult.
      deniedReason = decision.reason;
      return { release: async () => {}, retain: () => {} };
    }
    return acquireDaemonRunSlot(ctx, {
      kind: "write", runId: runOptions.loopId ?? `loop_${randomUUID()}`, workspacePath,
      ...(signal ? { signal } : {}),
      authorize: async () => { const fresh = await policyGate({ workspacePath }); if (!fresh.allow) throw new Error(fresh.reason); },
    });
  };
  if (
    runOptions.agentId === undefined
    && runOptions.autoAgent !== true
    && (runOptions.verifierAgentIds?.length ?? 0) === 0
  ) {
    return { ...runOptions, policyGate, lifecycleLease };
  }
  return {
    ...runOptions,
    adapters: Array.from(ctx.adapters.values()),
    policyEngine: ctx.policy,
    policyHistory: sqliteHistory(ctx.db),
    policyGate,
    lifecycleLease,
  };
}

function withoutRuntimeAdapters(runOptions: LoopRunOptions): LoopRunOptions {
  const copy: LoopRunOptions = { ...runOptions };
  delete copy.adapters;
  delete copy.policyEngine;
  delete copy.policyHistory;
  // Never persist the injected gate (a function): it is re-injected per engine
  // construction by withLoopAdapters, and JSON.stringify would drop it anyway.
  delete copy.policyGate;
  delete copy.lifecycleLease;
  return copy;
}

function parseLoopStartParams(
  params: unknown,
): { runOptions: LoopRunOptions; schedule: LoopStartSchedule } | Error {
  const parsed = parseLoopRunParams(params);
  if (parsed instanceof Error) return parsed;
  const p = objectParams(params);
  if (p instanceof Error) return p;
  const intervalMs = optionalNonNegativeInteger(p, "intervalMs");
  if (intervalMs instanceof Error) return intervalMs;
  const scheduleExpression = optionalString(p, "schedule");
  if (scheduleExpression !== undefined) {
    const invalid = validateCronExpression(scheduleExpression);
    if (invalid !== undefined) return new Error(`params.schedule ${invalid.message}`);
  }
  const schedule: LoopStartSchedule = {
    intervalMs: intervalMs ?? 5_000,
    stopWhenIdle: parsed.cyclesOptions?.stopWhenIdle === true,
    ...(parsed.cyclesOptions?.cycles !== undefined ? { cycles: parsed.cyclesOptions.cycles } : {}),
    ...(scheduleExpression !== undefined ? { scheduleExpression } : {}),
  };
  return { runOptions: parsed.runOptions, schedule };
}

function parseLoopStatusParams(params: unknown): { workspacePath: string; stateFilePath: string } | Error {
  const p = objectParams(params);
  if (p instanceof Error) return p;
  const workspacePath = optionalString(p, "workspacePath") ?? process.cwd();
  const stateFilePath = optionalString(p, "stateFilePath") ?? "LOOP-STATE.json";
  return {
    workspacePath,
    stateFilePath: resolveDaemonLoopPath(stateFilePath, workspacePath),
  };
}

function resolveDaemonLoopPath(path: string, cwd: string): string {
  return isAbsolute(path) ? path : join(cwd, path);
}

function objectParams(params: unknown): Record<string, unknown> | Error {
  if (params === undefined || params === null) return {};
  if (typeof params !== "object" || Array.isArray(params)) {
    return new Error("params must be an object");
  }
  return params as Record<string, unknown>;
}

function optionalLessonDrafts(
  params: Record<string, unknown>,
  key: string,
): Partial<LessonDraftConfig> | undefined | Error {
  const value = params[key];
  if (value === undefined) return undefined;
  const parsed = LessonDraftConfig.partial().safeParse(value);
  if (!parsed.success) return new Error(`params.${key} must be a valid lesson draft config`);
  return {
    ...(parsed.data.enabled !== undefined ? { enabled: parsed.data.enabled } : {}),
    ...(parsed.data.dir !== undefined ? { dir: parsed.data.dir } : {}),
  };
}

function optionalLoopBudget(params: Record<string, unknown>, key: string): LoopBudget | undefined | Error {
  const value = params[key];
  if (value === undefined) return undefined;
  const parsed = LoopBudget.safeParse(value);
  if (!parsed.success) return new Error(`params.${key} must be a valid loop budget`);
  return parsed.data;
}

function optionalDiscoveryPolicy(params: Record<string, unknown>, key: string): DiscoveryPolicy | undefined | Error {
  const value = params[key];
  if (value === undefined) return undefined;
  const parsed = DiscoveryPolicy.safeParse(value);
  if (!parsed.success) return new Error(`params.${key} must be a valid discovery policy`);
  return parsed.data;
}

function optionalKnowledgeTrace(params: Record<string, unknown>, key: string): LoopKnowledgeTraceType | undefined | Error {
  const value = params[key];
  if (value === undefined) return undefined;
  const parsed = LoopKnowledgeTrace.safeParse(value);
  if (!parsed.success) return new Error(`params.${key} must be a valid loop knowledge trace`);
  return parsed.data;
}

function optionalString(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key];
  return typeof value === "string" ? value : undefined;
}

function optionalStringArray(params: Record<string, unknown>, key: string): string[] | undefined | Error {
  const value = params[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    return new Error(`params.${key} must be an array of strings`);
  }
  return value;
}

function optionalArtifactVerification(
  params: Record<string, unknown>,
  key: string,
): ArtifactVerificationOptions | undefined | Error {
  const value = params[key];
  if (value === undefined) return undefined;
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    return new Error(`${key} must be an object`);
  }
  const object = value as Record<string, unknown>;
  const requireGitDiff = optionalBoolean(object, "requireGitDiff");
  if (requireGitDiff instanceof Error) return requireGitDiff;
  const targetPaths = optionalStringArray(object, "targetPaths");
  if (targetPaths instanceof Error) return targetPaths;
  const forbiddenPaths = optionalStringArray(object, "forbiddenPaths");
  if (forbiddenPaths instanceof Error) return forbiddenPaths;
  return {
    ...(requireGitDiff !== undefined ? { requireGitDiff } : {}),
    ...(targetPaths !== undefined ? { targetPaths } : {}),
    ...(forbiddenPaths !== undefined ? { forbiddenPaths } : {}),
  };
}

function optionalProfileRouting(
  params: Record<string, unknown>,
  key: string,
): LoopProfileRoutingEvidenceType | undefined | Error {
  const value = params[key];
  if (value === undefined) return undefined;
  const parsed = LoopProfileRoutingEvidence.safeParse(value);
  if (!parsed.success) {
    return new Error(
      `params.${key} must be valid profile routing evidence`,
    );
  }
  const {
    designer_agent_id: designerAgentId,
    designer_identity: designerIdentity,
    ...required
  } = parsed.data;
  return {
    ...required,
    ...(designerAgentId !== undefined
      ? { designer_agent_id: designerAgentId }
      : {}),
    ...(designerIdentity !== undefined
      ? { designer_identity: designerIdentity }
      : {}),
  };
}

function optionalPositiveInteger(params: Record<string, unknown>, key: string): number | undefined | Error {
  const value = params[key];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || typeof value !== "number" || value < 1) {
    return new Error(`params.${key} must be a positive integer`);
  }
  return value;
}

function optionalNonNegativeInteger(params: Record<string, unknown>, key: string): number | undefined | Error {
  const value = params[key];
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || typeof value !== "number" || value < 0) {
    return new Error(`params.${key} must be a non-negative integer`);
  }
  return value;
}

function optionalBoolean(params: Record<string, unknown>, key: string): boolean | undefined | Error {
  const value = params[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") return new Error(`params.${key} must be a boolean`);
  return value;
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

type DaemonRunSlot = ExecutionLease;

const READ_ONLY_CAPABILITY_KINDS = new Set([
  "code.review",
  "review.code",
  "design.review",
  "doc.summarize",
  "plan.estimate",
  "research.web",
  "research.code",
  "release.check",
  "release.verify",
  "client.summarize",
  "matter.summarize",
  "risk.check",
  "verify.acceptance",
  "verify.alignment",
  "memory.read",
]);

function daemonAccessKind(capabilityKind: string): "read" | "write" {
  return READ_ONLY_CAPABILITY_KINDS.has(capabilityKind)
    ? "read"
    : "write";
}

function admissionFor(ctx: DaemonContext): GovernedExecution {
  if (ctx.admission) return ctx.admission;
  ctx.admission = new GovernedExecution({
    reads: ctx.readSemaphore, writes: ctx.writeSemaphore, repositories: ctx.repoWriteSemaphores,
    checkHealth: async () => {
      if (ctx.guardedAutonomy && !ctx.lastAutonomyHealth) throw new Error("autonomy writes are blocked until the initial health check completes");
      const health = await ctx.autonomyHealth();
      ctx.lastAutonomyHealth = health;
      if (!health.can_run_local) throw new Error(`autonomy writes are blocked by ${health.write_blockers.join(",")}`);
    },
  });
  return ctx.admission;
}

async function acquireDaemonRunSlot(ctx: DaemonContext, input: AdmissionInput): Promise<ExecutionLease> {
  return admissionFor(ctx).acquire(input);
}

async function acquireSessionAdmission(ctx: DaemonContext, agentId: string, workspacePath: string, runId: string, signal: AbortSignal): Promise<ExecutionLease> {
  const registered = ctx.adapterWorkspaces?.get(agentId);
  if (registered !== undefined) {
    const actual = await resolveRepositoryScope(workspacePath);
    const expected = await resolveRepositoryScope(registered);
    if (actual.workspacePath !== expected.workspacePath) throw new Error("session workspace does not match host registration");
  }
  return acquireDaemonRunSlot(ctx, { kind: "write", runId, workspacePath, signal,
    authorize: async () => {
      const decision = await makeRepositoryPolicyGate(workspacePath)({ workspacePath });
      if (!decision.allow) throw new Error(decision.reason);
    },
  });
}

async function resumeGuardedAutonomy(
  ctx: DaemonContext,
  autonomyRunId: string,
  decision?: ScopedApprovalDecisionType,
  recoveryKind?: "restart",
): Promise<GuardedDeliveryResult> {
  if (ctx.guardedAutonomy === undefined) {
    throw new Error("guarded autonomy runtime is not configured");
  }
  const row = getAutonomyRun(ctx.db, autonomyRunId);
  if (row === undefined) {
    throw new Error(`no autonomy run with id=${autonomyRunId}`);
  }
  const slot = await acquireDaemonRunSlot(ctx, {
    kind: "write",
    runId: autonomyRunId,
    workspacePath: row.workspace_path,
    authorize: async () => {
      const decision = await makeRepositoryPolicyGate(row.workspace_path)({ workspacePath: row.workspace_path });
      if (!decision.allow) throw new Error(decision.reason);
    },
  });
  let confirmed = false;
  try {
    const result = await ctx.guardedAutonomy.resume(
      autonomyRunId,
      decision,
      recoveryKind === undefined ? undefined : { recoveryKind },
    );
    confirmed = result.status === "completed" || result.status === "needs_approval";
    return result;
  } finally {
    if (confirmed) await slot.release();
    else slot.retain("guarded autonomy blocked or exit unconfirmed");
  }
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
  if (ctx.draining) {
    sock.write(encodeFrame(singleErr(req.id, "draining", "daemon is draining for shutdown/upgrade; retry after restart")));
    return;
  }

  // S2 router gives us a baseline candidate. S3 policy refines it.
  type RouteReq = Parameters<typeof routeCapability>[0];
  type RouteKind = NonNullable<RouteReq["kind"]>;
  const routeReq: RouteReq = {};
  if (params.capability_id !== undefined) routeReq.capability_id = params.capability_id;
  if (typeof params.kind === "string") routeReq.kind = params.kind as RouteKind;
  if (params.agent_id !== undefined) {
    // FAIL-CLOSED type boundary: a non-string/empty agent_id is a client bug,
    // never a reason to fall back to default routing (G1.1 review F3).
    if (typeof params.agent_id !== "string" || params.agent_id.length === 0) {
      sock.write(encodeFrame(singleErr(req.id, "bad_request", "params.agent_id must be a non-empty string when provided")));
      return;
    }
    routeReq.agent_id = params.agent_id;
  }
  let routerPick: Awaited<ReturnType<typeof routeCapability>>;
  try {
    routerPick = await routeCapability(
      routeReq,
      Array.from(ctx.adapters.values()) as readonly RoutableAdapter[],
    );
  } catch (err) {
    // Explicit agent_id override could not be honored — FAIL-CLOSED to the
    // client; no run is created and no silent fallback occurs (G1.1).
    if (err instanceof AgentOverrideError) {
      sock.write(encodeFrame(singleErr(req.id, "agent_override_failed", err.message)));
      return;
    }
    throw err;
  }
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
  const selectedCapability = adapter.capabilities().find(
    (capability) => capability.id === selectedCapId,
  );
  if (selectedCapability === undefined) {
    sock.write(encodeFrame(singleErr(
      req.id,
      "internal",
      `selected capability ${selectedCapId} is not advertised by ${agentId}`,
    )));
    return;
  }

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
  let executionSlot: DaemonRunSlot | undefined;
  let producerStarted = false;
  let producerSettled = false;
  try {
    const repoId =
      typeof params.context?.["repo_id"] === "string"
      && params.context["repo_id"].length > 0
        ? params.context["repo_id"]
        : undefined;
    const accessKind = daemonAccessKind(selectedCapability.kind);
    const trustedPath = ctx.adapterWorkspaces?.get(agentId);
    const requestedPath = typeof task.context?.["repo_path"] === "string" ? task.context["repo_path"] : undefined;
    if (accessKind === "write" && trustedPath !== undefined && requestedPath !== undefined) {
      const [trusted, requested] = await Promise.all([resolveRepositoryScope(trustedPath), resolveRepositoryScope(requestedPath)]);
      if (trusted.workspacePath !== requested.workspacePath) throw new Error("requested workspace does not match host registration");
    }
    const admissionPath = accessKind === "write" ? trustedPath : requestedPath;
    executionSlot = await acquireDaemonRunSlot(ctx, {
      kind: accessKind,
      runId: run_id,
      ...(admissionPath === undefined ? {} : { workspacePath: admissionPath }),
      ...(repoId === undefined ? {} : { repoId }),
      authorize: async () => {
        const path = accessKind === "write" ? trustedPath : undefined;
        if (path) { const decision = await makeRepositoryPolicyGate(path)({ workspacePath: path }); if (!decision.allow) throw new Error(decision.reason); }
      },
      signal: ac.signal,
    });
    const registeredPath = ctx.adapterWorkspaces?.get(agentId);
    if (accessKind === "write" && registeredPath) task.context = { ...task.context, repo_path: registeredPath };
    producerStarted = true;
    for await (const ev of boundedAdapterEvents(adapter.invoke(task, ac.signal), ac.signal)) {
      try {
        appendEvent(ctx.db, ctx.dbPath, ev);
        if (ev.terminal || ["run.started", "status", "approval.requested", "approval.resolved", "clarify.requested", "clarify.resolved", "error"].includes(ev.type)) requestSupervisionScan(ctx, "run.fact.persisted");
      } catch (err) {
        process.stderr.write(`osstack: event persist failed: ${(err as Error).message}\n`);
      }
      if (ev.type === "usage.final") {
        const p = ev.payload as { tokens_in?: number; tokens_out?: number };
        lastUsageTokensIn = p.tokens_in ?? 0;
        lastUsageTokensOut = p.tokens_out ?? 0;
      }
      try { sock.write(encodeFrame(ev)); } catch { ac.abort(); }
      if (ev.terminal) {
        if (ev.type === "done") {
          const status = (ev.payload as { status?: string }).status;
          if (status === "completed" || status === "failed" || status === "cancelled") lastOutcome = status;
        } else if (ev.type === "error") {
          lastOutcome = "failed";
        }
      }
    }
    producerSettled = true;
  } catch (err) {
    try {
      sock.write(encodeFrame({
        event_id: `${run_id}:err`,
        seq: -1, run_id, session_id,
        created_at: Date.now() / 1000, terminal: true, type: "error",
        payload: {
          code:
            err instanceof SemaphoreAcquireAbortedError
              ? "cancelled"
              : "adapter_threw",
          message: (err as Error).message,
          terminal: true,
        },
      }));
    } catch { /* socket gone */ }
    lastOutcome =
      err instanceof SemaphoreAcquireAbortedError
        ? "cancelled"
        : "failed";
  } finally {
    try {
      if (producerStarted && (ac.signal.aborted || !producerSettled)) {
        ac.abort();
        if (await confirmAdapterStopped(adapter, run_id)) await executionSlot?.release();
        else executionSlot?.retain("adapter cancellation exit unconfirmed");
      } else await executionSlot?.release();
    } catch (error) {
      process.stderr.write(
        `osstack: execution lock release failed for ${run_id}: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
    sock.off("close", onClose);
    ctx.activeRuns.delete(run_id);
    try {
      finalizeRun(ctx.db, ctx.dbPath, run_id, lastOutcome, Date.now() / 1000);
      requestSupervisionScan(ctx, "run.finalized");
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
  const rows = listEventsForRun(ctx.db, params.run_id, { afterSeq });

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

function configuredConcurrency(
  value: number | undefined,
  envName: string,
  fallback: number,
): number {
  const raw = value ?? (
    process.env[envName] === undefined
      ? fallback
      : Number(process.env[envName])
  );
  if (!Number.isInteger(raw) || raw < 1 || raw > 128) {
    throw new Error(`${envName} must be an integer between 1 and 128`);
  }
  return raw;
}

function buildContext(
  options: {
    writeConcurrency?: number;
    readConcurrency?: number;
    socketPath?: string;
    adapters?: readonly AgentAdapter[];
  } = {},
): DaemonContext {
  const home = osstackHome();
  if (!existsSync(home)) mkdirSync(home, { recursive: true });
  const dbPath = join(home, "state.db");
  const loopSessionsPath = join(home, "loop-sessions.json");
  const dailySessionsPath = join(home, "daily-sessions.json");
  if (!existsSync(dirname(dbPath))) mkdirSync(dirname(dbPath), { recursive: true });
  const db = openDb({ path: dbPath });
  try {
  const redactor = new PIIRedactor();
  const adapters = new Map<string, AgentAdapter>();

  // Register adapters from the shared default registry (also used by the OS
  // Deck CLI, so daemon and `osstack deck` agree on which agents exist). Order
  // doesn't matter once policy ranks them; each adapter's isAvailable() gates
  // whether it's a viable route on this machine.
  for (const a of options.adapters ?? [...defaultAdapters(), createControlledSessionAdapter({ state_directory: join(home, "controlled-sessions") })]) {
    adapters.set(a.id, a);
  }

  const policy = new PolicyEngine({ rules: DEFAULT_RULES });
  const hermes = new HermesBridge();   // disabled unless HERMES_KANBAN_BOARD is set
  const gbrain = new GBrainAdapter();  // disabled unless OSSTACK_GBRAIN=1
  const kanban = new KanbanRepository(db, dbPath);
  const sessions = new SessionRepository(db, dbPath);
  const continuations = new SessionContinuationRepository(db, dbPath);
  return {
    dbPath, loopSessionsPath, dailySessionsPath, db, redactor, adapters, policy, hermes, gbrain, kanban, sessions, continuations, collaborator: undefined,
    dashboardUrl: null,
    activeRuns: new Map(),
    activeSessionSends: new Map(),
    loopSessions: new Map(),
    dailySessions: new Map(),
    hermesKanbanByRun: new Map(),
    rpcLatency: new RpcLatencyRecorder(),
    draining: false,
    drainingFromHealth: false,
    requestShutdown: () => { /* wired up in startDaemon */ },
    guardedAutonomy: undefined,
    writeSemaphore: new FifoSemaphore(configuredConcurrency(
      options.writeConcurrency,
      "OSSTACK_WRITE_CONCURRENCY",
      DEFAULT_WRITE_CONCURRENCY,
    )),
    readSemaphore: new FifoSemaphore(configuredConcurrency(
      options.readConcurrency,
      "OSSTACK_READ_CONCURRENCY",
      DEFAULT_READ_CONCURRENCY,
    )),
    repoWriteSemaphores: new Map(),
    autonomyHealth: async () => await runAutonomyHealth({
      db,
      db_path: dbPath,
      home,
      socket_path: options.socketPath ?? resolveSocketPath(),
      power_policy:
        process.env["OSSTACK_POWER_POLICY"] === "process_assertion"
          ? "process_assertion"
          : "none",
      clock_monitor:
        process.env["OSSTACK_CLOCK_MONITOR"] === "monotonic-v1",
      require_launchd:
        process.platform === "darwin"
        && process.env["OSSTACK_AGENT_PROFILE"] === "mac-mini",
    }),
    lastAutonomyHealth: undefined,
  };
  } catch (error) { db.close(); throw error; }
}

export interface DaemonHandles {
  /** Trusted in-process checkpoint channel; no public worker RPC is exposed yet. */
  executeGraphCheckpoint: (connection: object, request: unknown) => Promise<GraphCheckpointResponse>;
  /** Trusted in-process port; await once, then register immutable worker bindings synchronously. */
  graphActionBroker: () => Promise<GraphActionBroker>;
  /** Explicit trusted experimental assembly, configured once; no public graph RPC. */
  graphRuntime: (configuration: GraphRuntimeConfiguration) => Promise<GraphRuntime>;
  close: () => Promise<void>;
  socketPath: string;
  dbPath: string;
  /** In-process only. Identity must be the registered object, never worker fields. */
  acquireGraphAdmission: (identity: object, input: { runId: string; repoId?: string; signal?: AbortSignal }) => Promise<ExecutionLease>;
}

export interface StartDaemonOptions {
  /** Trusted host registry and actual socket authentication; never RPC fields. */
  graphRpc?: Pick<GraphRpcOptions, 'registrations' | 'resolveCaller'>;
  graphCheckpointBindings?: ReadonlyMap<object, GraphCheckpointBinding>;
  /** Host launch configuration for direct adapter writes. */
  workspacePath?: string;
  adapterWorkspaces?: ReadonlyMap<string, string>;
  graphIdentities?: ReadonlyMap<object, { workspacePath: string; authorize: () => Promise<void> }>;

  /** Trusted owner public keys only; absent means read continuation-trust.json. */
  continuationTrustedPublicKeys?: ReadonlyMap<string, string>;
  socketPath?: string;
  /** Test/embedding hook; production continues to use the default registry. */
  adapters?: readonly AgentAdapter[];
  writeConcurrency?: number;
  readConcurrency?: number;
  autonomyHealth?: () => Promise<AutonomyHealthReport>;
  healthPollIntervalMs?: number;
  notificationSender?: AutonomyNotificationSender;
  wallClockMs?: () => number;
  monotonicClockMs?: () => number;
  clockJumpThresholdMs?: number;
  guardedAutonomyFactory?: (
    db: Database.Database,
    dbPath: string,
  ) =>
    | GuardedAutonomyDaemonRuntime
    | Promise<GuardedAutonomyDaemonRuntime>;
}

function environmentPositiveInteger(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(raw)) {
    throw new Error(`${name} must be a positive integer`);
  }
  return Number(raw);
}

async function restoreGuardedAutonomy(
  ctx: DaemonContext,
  health: AutonomyHealthReport | undefined = ctx.lastAutonomyHealth,
): Promise<void> {
  if (ctx.guardedAutonomy === undefined) return;
  if (health?.can_run_local === false) return;
  const githubRecoveryStates = new Set([
    "blocked_delivery",
    "pushing",
    "opening_pr",
    "waiting_ci",
    "merging",
  ]);
  await Promise.all(
    listResumableAutonomyRuns(ctx.db)
      .filter((row) => row.state !== "awaiting_approval")
      .filter(
        (row) =>
          health?.can_push_deploy !== false
          || !githubRecoveryStates.has(row.state),
      )
      .map(async (row) => {
        try {
          await resumeGuardedAutonomy(
            ctx,
            row.autonomy_run_id,
            undefined,
            "restart",
          );
        } catch (error) {
          process.stderr.write(
            `osstack: autonomy recovery failed for ${row.autonomy_run_id}: ${
              error instanceof Error ? error.message : String(error)
            }\n`,
          );
        }
      }),
  );
}

async function refreshAutonomyHealthAndRecover(
  ctx: DaemonContext,
  recover: boolean,
  notificationSender?: AutonomyNotificationSender,
): Promise<void> {
  try {
    const maxLogBytes = environmentPositiveInteger(
      "OSSTACK_LOG_MAX_BYTES",
    );
    const maxLogFiles = environmentPositiveInteger(
      "OSSTACK_LOG_MAX_FILES",
    );
    const proofRetentionDays = environmentPositiveInteger(
      "OSSTACK_PROOF_RETENTION_DAYS",
    );
    const proofMinKeep = environmentPositiveInteger(
      "OSSTACK_PROOF_MIN_KEEP",
    );
    await enforceAutonomyRetention({
      home: osstackHome(),
      db: ctx.db,
      ...(maxLogBytes === undefined
        ? {}
        : { max_log_bytes: maxLogBytes }),
      ...(maxLogFiles === undefined
        ? {}
        : { max_log_files: maxLogFiles }),
      ...(proofRetentionDays === undefined
        ? {}
        : { proof_retention_days: proofRetentionDays }),
      ...(proofMinKeep === undefined
        ? {}
        : { proof_min_keep: proofMinKeep }),
    });
  } catch (error) {
    process.stderr.write(
      `osstack: autonomy retention failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
  }
  if (notificationSender !== undefined) {
    try {
      await drainAutonomyNotifications({
        db: ctx.db,
        db_path: ctx.dbPath,
        sender: notificationSender,
      });
    } catch (error) {
      process.stderr.write(
        `osstack: autonomy notification drain failed: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
  }
  if (ctx.guardedAutonomy === undefined) return;
  const previous = ctx.lastAutonomyHealth;
  let current: AutonomyHealthReport;
  try {
    current = await ctx.autonomyHealth();
  } catch (error) {
    process.stderr.write(
      `osstack: autonomy health probe failed: ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    return;
  }
  ctx.lastAutonomyHealth = current;
  applyAutonomyDrainSignal(ctx, current.drain_required);
  ctx.collaborator?.resumePending();
  const externalRecovered =
    previous !== undefined
    && !previous.can_push_deploy
    && current.can_push_deploy;
  if (recover || externalRecovered) {
    await restoreGuardedAutonomy(ctx, current);
  }
}

/**
 * Raise or clear `draining` from an autonomy health verdict.
 *
 * The drain used to be a one-way latch: a dip below the 2 GiB autonomy floor
 * set `draining` and nothing ever cleared it, so the daemon kept refusing
 * work long after the disk recovered and only a restart brought it back
 * (observed 2026-08-13 — 19 GB of unpruned shadow checkpoints filled the
 * disk, and the daemon stayed drained for 12 h after space was freed).
 * An operator/upgrade drain is never auto-cleared.
 */
function applyAutonomyDrainSignal(ctx: DaemonContext, drainRequired: boolean): void {
  if (drainRequired) {
    // Only claim ownership on the transition INTO draining. Marking an
    // already-draining daemon would relabel an operator/upgrade drain as
    // health-raised, and the next healthy probe would then lift it — the
    // exact sequence (operator drain → bad probe → good probe) that Kimi K3
    // reproduced against the first cut of this fix.
    if (!ctx.draining) ctx.drainingFromHealth = true;
    ctx.draining = true;
    return;
  }
  if (ctx.draining && ctx.drainingFromHealth) {
    ctx.draining = false;
    ctx.drainingFromHealth = false;
    ctx.collaborator?.resumePending();
    process.stderr.write("osstack: autonomy health recovered — daemon resumed accepting work\n");
  }
}

function collaboratorPaused(ctx: DaemonContext): boolean {
  return ctx.draining || (ctx.guardedAutonomy !== undefined
    && (ctx.lastAutonomyHealth === undefined || !ctx.lastAutonomyHealth.can_run_local || ctx.lastAutonomyHealth.drain_required));
}

export async function startDaemon(
  opts: StartDaemonOptions = {},
): Promise<DaemonHandles> {
  let checkpointService: Promise<GraphCheckpointService> | undefined;
  let checkpointClosed = false;
  const checkpointBindings = new Map(Array.from(opts.graphCheckpointBindings ?? [], ([key, binding]) => {
    const { authorize, ...data } = binding;
    return [key, { ...structuredClone(data), authorize }] as const;
  }));
  let graphBroker: Promise<GraphActionBroker> | undefined;
  let graphRuntime: Promise<GraphRuntime> | undefined;
  let graphRpc: Promise<GraphRpcService> | undefined;
  const graphSockets = new WeakSet<object>();
  const registeredWorkspace = opts.workspacePath === undefined ? undefined : (await resolveRepositoryScope(opts.workspacePath)).workspacePath;
  const socketPath = opts.socketPath ?? resolveSocketPath();
  const continuationTrust = new Map(opts.continuationTrustedPublicKeys
    ?? await readContinuationTrust(join(osstackHome(), "continuation-trust.json")));
  // Refuse to start when another daemon already owns the pidfile — two
  // daemons would race for the socket and share the SQLite writer.
  const releaseLock = acquireDaemonLock(pidFilePath());
  let failedContext: DaemonContext | undefined;
  let stopUpdates: (() => void) | undefined;
  let failedServer: ReturnType<typeof createServer> | undefined;
  try {
  cleanupStaleSocket(socketPath);
  // Bring up OTel before the daemon context so spans capture everything.
  await initOtel({ serviceVersion: DAEMON_VERSION });
  const ctx = buildContext({
    socketPath,
    ...(opts.adapters === undefined ? {} : { adapters: opts.adapters }),
    ...(opts.writeConcurrency === undefined
      ? {}
      : { writeConcurrency: opts.writeConcurrency }),
    ...(opts.readConcurrency === undefined
      ? {}
      : { readConcurrency: opts.readConcurrency }),
  });
  failedContext = ctx;
  // Initialize only after the authorized home/database startup. Read-only
  // inventory never creates an identity and malformed records are not repaired.
  try {
    const {ensureDeploymentHomeId} = await import("./home-inventory.js");
    ctx.deploymentIdentity = {
      schema_version: 1, home_id: await ensureDeploymentHomeId(osstackHome()),
      generation: `instance_${randomUUID().replaceAll("-", "")}`,
      version: DAEMON_VERSION, protocol_version: PROTOCOL_VERSION,
      database_schema: ctx.db.pragma("user_version", {simple:true}) as number,
      started_at_ms: Date.now(), deployment_kind: "unknown",
      build_digest: null, build_evidence: "unavailable",
    };
  } catch { /* retain unavailable identity; never guess or overwrite a pin */ }

  const getGraphRpc = (): Promise<GraphRpcService> => {
    if (checkpointClosed) return Promise.reject(new Error('GRAPH_SERVICE_CLOSED'));
    graphRpc ??= import('./graph-rpc.js').then(async ({ GraphRpcService, loadLocalGraphRegistration }) => {
      const configured = opts.graphRpc;
      const local = configured ? undefined : await loadLocalGraphRegistration(join(osstackHome(), 'graph-host.json'), ctx.adapters);
      const service = new GraphRpcService({ db: ctx.db, root: join(osstackHome(), 'graph-delivery'),
        registrations: (configured?.registrations ?? [local!]).map(registration => ({ ...registration,
          admitNewRuns: () => !ctx.draining && (registration.admitNewRuns ? registration.admitNewRuns() : true),
        })),
        resolveCaller: connection => {
          if (!graphSockets.has(connection)) return null;
          if (configured) return configured.resolveCaller(connection);
          const socket = statSync(socketPath);
          return socket.isSocket() && socket.uid === process.getuid?.() && (socket.mode & 0o077) === 0 ? local!.id : null;
        },
        acquire: input => admissionFor(ctx).acquire(input),
        authorizePolicy: async ({ policyRoot, workspacePath }) => {
          const source = await makeRepositoryPolicyGate(policyRoot, true)({ workspacePath: policyRoot });
          if (!source.allow) throw new Error('POLICY_DENIED');
          if (workspacePath !== policyRoot) {
            const candidate = await makeRepositoryPolicyGate(workspacePath, false)({ workspacePath });
            if (!candidate.allow) throw new Error('POLICY_DENIED');
          }
        } });
      if (checkpointClosed) { void service.close(); throw new Error('GRAPH_SERVICE_CLOSED'); }
      return service;
    }).catch(error => { graphRpc = undefined; throw error; });
    return graphRpc;
  };
  const getCheckpoints = async (): Promise<GraphCheckpointService> => {
    if (checkpointClosed) throw new Error("CHECKPOINT_SERVICE_CLOSED");
    checkpointService ??= Promise.all([import("./graph-checkpoint-service.js"), import("@osstack/core")])
      .then(([{ GraphCheckpointService }, { GraphRunStore, GraphCheckpointStore }]) =>
        new GraphCheckpointService({ runs: new GraphRunStore(ctx.db), checkpoints: new GraphCheckpointStore(ctx.db), bindings: checkpointBindings }));
    const service = await checkpointService;
    if (checkpointClosed) { service.close(); throw new Error("CHECKPOINT_SERVICE_CLOSED"); }
    return service;
  };
  const getBroker = (): Promise<GraphActionBroker> => {
    if (checkpointClosed) return Promise.reject(new Error("GRAPH_RUNTIME_CLOSED"));
    graphBroker ??= import("./graph-action-broker.js").then(({ GraphActionBroker }) => new GraphActionBroker(ctx.db, {
      acquire: (input) => admissionFor(ctx).acquire(input),
      authorizePolicy: async (workspacePath) => {
        const decision = await makeRepositoryPolicyGate(workspacePath, true)({ workspacePath });
        if (!decision.allow) throw new Error(decision.reason);
      },
    }));
    return graphBroker;
  };
  if (process.env["OSSTACK_ATTENTION"] === "1") { ctx.supervision = new SupervisionService(ctx.db, ctx.dbPath, process.env["OSSTACK_ATTENTION_NOTIFY"] === "local" ? localAttentionSender(osstackHome()) : undefined); ctx.supervision.start(); }
  ctx.collaborator = new SessionCollaborator({
    repository: ctx.continuations,
    adapters: ctx.adapters,
    trustedPublicKeys: continuationTrust,
    draining: () => collaboratorPaused(ctx),
    send: async (reservation, controller) => {
      const session = ctx.sessions.getSession(reservation.grant.body.session_id);
      const adapter = ctx.adapters.get(reservation.grant.body.runtime_id);
      if (collaboratorPaused(ctx) || controller.signal.aborted) return { ok: false, error: { code: "continuation_cancelled" } };
      if (session === undefined || adapter === undefined || !isSessionCapableAdapter(adapter)) {
        return { ok: false, error: { code: "resume_unsupported" } };
      }
      if (ctx.activeSessionSends.has(session.session_id)) return { ok: false, error: { code: "session_busy" } };
      return await executeReservedSessionTurn(ctx, { id: reservation.attempt.attempt_id, method: "collaborator.resume" }, {
        session_id: session.session_id,
        runtime_id: session.agent_id,
        turn_id: reservation.message.turn_id,
        message_id: reservation.message.message_id,
        expected_version: reservation.reservation_version - 1,
        text: reservation.prompt,
        requested_by: `agent:collaborator:${reservation.grant.body.grant_id}`,
      }, session, adapter, reservation.reservation_version, {
        controller,
        completed: (turnId, version, now) => {
          // Timers are cooperative: a blocked event loop can deliver completion
          // before an overdue abort callback. Keep the real receipt, but expire
          // the delegation inside this same completion transaction.
          const grant = reservation.grant;
          if (now * 1000 >= Date.parse(grant.body.expires_at)) ctx.continuations.block(grant.grant_id, "expired", now);
          else if ((now - reservation.message.created_at) * 1000 >= grant.body.turn_timeout_ms) ctx.continuations.block(grant.grant_id, "turn_timeout", now);
          ctx.continuations.completeAttempt(reservation.attempt.attempt_id, turnId, version, now);
        },
      });
    },
  });
  if (registeredWorkspace !== undefined || opts.adapterWorkspaces !== undefined) {
    ctx.adapterWorkspaces = new Map([
      ...(registeredWorkspace === undefined ? [] : [...ctx.adapters.keys()].map(id => [id, registeredWorkspace] as const)),
      ...(opts.adapterWorkspaces ?? []),
    ]);
  }
  if (opts.autonomyHealth !== undefined) {
    ctx.autonomyHealth = opts.autonomyHealth;
  }
  if (opts.guardedAutonomyFactory !== undefined) {
    ctx.guardedAutonomy = await opts.guardedAutonomyFactory(
      ctx.db,
      ctx.dbPath,
    );
  }
  const stopUpdateChecker = startUpdateChecker();
  stopUpdates = stopUpdateChecker;
  let dashboard: DashboardServerHandle | null = null;

  const server = createServer((sock: Socket) => {
    graphSockets.add(sock);
    sock.once('close', () => graphSockets.delete(sock));
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

          // Wall-clock per request, recorded into the per-method latency
          // window that `osstack stats` reports. For the streaming methods
          // (task.submit/task.observe) this measures the full handler
          // lifetime, not time-to-first-byte.
          const startedAt = performance.now();
          const recordLatency = (): void => {
            ctx.rpcLatency.record(req.method, performance.now() - startedAt);
          };
          const reportFailure = (error: unknown): void => {
            try { sock.write(encodeFrame(singleErr(req.id, "execution_failed", error instanceof Error ? error.message : String(error)))); } catch { /* disconnected */ }
          };

          if (['graph.validate', 'graph.start', 'graph.submit', 'graph.status', 'graph.result', 'graph.cancel', 'graph.reconcile', 'graph.resume'].includes(req.method)) {
            void getGraphRpc().then(service => service.handle(sock, req.method, req.params)).then(result => {
              try { sock.write(encodeFrame(singleOk(req.id, result))); } catch { /* disconnected */ }
            }).catch(async error => {
              const { graphRpcError } = await import('./graph-rpc.js');
              const failure = graphRpcError(error);
              try { sock.write(encodeFrame(singleErr(req.id, failure.code, failure.message))); } catch { /* disconnected */ }
            }).finally(recordLatency);
            continue;
          }
          if (req.method === "task.submit") {
            void traceSpan(
              "osstack.task.submit",
              { "osstack.method": req.method },
              () => handleTaskSubmit(ctx, req, sock),
            ).catch(reportFailure).finally(recordLatency);
            continue;
          }
          if (req.method === "task.observe") {
            void traceSpan(
              "osstack.task.observe",
              { "osstack.method": req.method },
              async () => handleTaskObserve(ctx, req, sock),
            ).catch(reportFailure).finally(recordLatency);
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
          ).catch(reportFailure).finally(recordLatency);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        try { sock.write(encodeFrame({ id: 0, ok: false, error: { code: "framing", message } })); } catch { /* socket dead */ }
        sock.destroy();
      }
    });

    sock.on("error", () => { /* don't crash on client hangups */ });
  });

  failedServer = server;
  ctx.collaborator?.recover();
  return await new Promise((resolve, reject) => {
    server.once("error", reject);
    void Promise.all([restoreLoopSessions(ctx), restoreDailySessions(ctx)]).then(() => {
      server.listen(socketPath, () => {
      try { chmodSync(socketPath, 0o600); } catch { /* best effort */ }

      let healthPollPending = true;
      let guardedRecovery = refreshAutonomyHealthAndRecover(
        ctx,
        true,
        opts.notificationSender,
      )
        .finally(() => {
          healthPollPending = false;
        });
      const healthPollIntervalMs = Math.max(
        10,
        opts.healthPollIntervalMs ?? 30_000,
      );
      const wallClockMs = opts.wallClockMs ?? Date.now;
      const monotonicClockMs =
        opts.monotonicClockMs ?? (() => performance.now());
      const clockDetector = new ClockJumpDetector(
        opts.clockJumpThresholdMs ?? 120_000,
      );
      clockDetector.observe(wallClockMs(), monotonicClockMs());
      const healthMonitor =
        ctx.guardedAutonomy === undefined
          && opts.notificationSender === undefined
          ? undefined
          : setInterval(() => {
              if (healthPollPending) return;
              healthPollPending = true;
              const clock = clockDetector.observe(
                wallClockMs(),
                monotonicClockMs(),
              );
              if (clock.jump_detected) {
                process.stderr.write(
                  `osstack: clock jump detected drift_ms=${clock.drift_ms}; re-running external health and recovery probes\n`,
                );
              }
              guardedRecovery = refreshAutonomyHealthAndRecover(
                ctx,
                clock.jump_detected,
                opts.notificationSender,
              )
                .catch((error) => {
                  process.stderr.write(
                    `osstack: autonomy recovery monitor failed: ${
                      error instanceof Error ? error.message : String(error)
                    }\n`,
                  );
                })
                .finally(() => {
                  healthPollPending = false;
                });
            }, healthPollIntervalMs);
      healthMonitor?.unref();
      let shutdownPromise: Promise<void> | undefined;
      const shutdown = async (): Promise<void> => {
        checkpointClosed = true;
        if (checkpointService) {
          try { (await checkpointService).close(); } catch { /* Initialization failure created no service. */ }
        }
        if (shutdownPromise !== undefined) return await shutdownPromise;
        process.off("SIGTERM", onSig);
        process.off("SIGINT", onSig);
        try { stopUpdateChecker(); } catch { /* cleanup must continue */ }
        if (healthMonitor !== undefined) clearInterval(healthMonitor);
        shutdownPromise = (async () => {
          ctx.draining = true;
          await ctx.supervision?.stop();
          if (graphRpc) {
            try { await (await graphRpc).close(); } catch { /* Initialization may have failed. */ }
          }
          if (graphRuntime) {
            try { const runtime = await graphRuntime; await runtime.close(); await runtime.drainDatabaseUsers(); } catch { /* Failed initialization launched no graph worker. */ }
          }
          const collaboratorStopped = Promise.resolve().then(() => ctx.collaborator?.stop());
          // Abort any active runs so adapters get a chance to clean up.
          for (const ac of ctx.activeRuns.values()) ac.abort();
          for (const session of ctx.loopSessions.values()) {
            session.shutdownRequested = true;
            session.abort.abort();
          }
          for (const session of ctx.dailySessions.values()) {
            session.shutdownRequested = true;
            session.abort.abort();
          }
          const loopCompletions = Array.from(ctx.loopSessions.values())
            .map((session) => session.done)
            .filter((done): done is Promise<void> => done !== undefined);
          const dailyCompletions = Array.from(ctx.dailySessions.values())
            .map((session) => session.done)
            .filter((done): done is Promise<void> => done !== undefined);
          await Promise.allSettled([
            ...loopCompletions,
            ...dailyCompletions,
            guardedRecovery,
            collaboratorStopped,
          ]);
          await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
          try { if (dashboard !== null) await dashboard.close(); }
          finally {
            try { ctx.db.close(); }
            finally {
              try { cleanupStaleSocket(socketPath); } catch { /* diagnostics only */ }
              try { await shutdownOtel(); } finally { releaseLock(); }
            }
          }
        })();
        return await shutdownPromise;
      };
      const onSig = (): void => { void shutdown().then(() => process.exit(0)); };
      process.once("SIGTERM", onSig);
      process.once("SIGINT", onSig);
      ctx.requestShutdown = onSig;

      const dashOpts = dashboardUrlFromEnv();
      void startDashboardServer(
        (params) => createDashboardSnapshot({
          attentionService: ctx.draining ? "unavailable" : ctx.supervision ? "running" : "disabled",
          ...(params?.workspacePath === undefined ? {} : {workspacePath: resolveWorkspacePath(params.workspacePath)}),
          ...(params?.attentionAfter === undefined ? {} : {attentionAfter: params.attentionAfter}),
          ...(params?.attentionLimit === undefined ? {} : {attentionLimit: params.attentionLimit}),
          db: ctx.db,
          kanban: ctx.kanban,
          dbPath: ctx.dbPath,
          version: DAEMON_VERSION,
          phase: DAEMON_PHASE,
          dashboardUrl: ctx.dashboardUrl ?? dashboardUrl(dashOpts),
          adapters: Array.from(ctx.adapters.values()).map((a) => ({
            id: a.id,
            display_name: a.display_name,
            cost_tier: a.cost_tier,
          })),
          activeRuns: ctx.activeRuns.size,
          activeLoops: activeLoopCount(ctx),
        }),
        dashOpts,
      ).then((handle) => {
        dashboard = handle;
        ctx.dashboardUrl = handle.url;
      }).catch((err) => {
        process.stderr.write(`osstack: dashboard server failed: ${(err as Error).message}\n`);
      });

      resolve({ close: shutdown, socketPath, dbPath: ctx.dbPath,
        executeGraphCheckpoint: async (connection, request) => (await getCheckpoints()).execute(connection, request),
        graphActionBroker: getBroker,
        graphRuntime: (configuration) => {
          if (checkpointClosed) return Promise.reject(new Error("GRAPH_RUNTIME_CLOSED"));
          if (graphRuntime) return Promise.reject(new Error("GRAPH_RUNTIME_ALREADY_CONFIGURED"));
          // Snapshot trusted launch settings before dynamic import. Program bytes are
          // verified/snapshotted by the manager; the SDK stays in its child process.
          const fixed = structuredClone(configuration);
          graphRuntime = Promise.all([import("./graph-runtime.js"), getBroker(), getCheckpoints()])
            .then(async ([{ GraphRuntime }, broker, checkpoints]) => {
              const runtime = new GraphRuntime({ ...fixed, db: ctx.db, broker, checkpoints });
              if (checkpointClosed) { await runtime.close(); throw new Error("GRAPH_RUNTIME_CLOSED"); }
              return runtime;
            });
          return graphRuntime;
        },
        acquireGraphAdmission: async (identity, input) => {
          const trusted = opts.graphIdentities?.get(identity);
          if (!trusted || typeof trusted.authorize !== "function") throw new Error("trusted graph identity and authorization required");
          return admissionFor(ctx).acquire({ ...input, kind: "write",
            workspacePath: trusted.workspacePath, authorize: async () => {
              const decision = await makeRepositoryPolicyGate(trusted.workspacePath, true)({ workspacePath: trusted.workspacePath });
              if (!decision.allow) throw new Error(decision.reason);
              await trusted.authorize();
            } });
        },
      });
      });
    }).catch(reject);
  });
  } catch (error) {
    // Preserve the startup error; every acquired resource gets its own cleanup.
    try { stopUpdates?.(); } catch { /* continue cleanup */ }
    if (failedContext) {
      failedContext.draining = true;
      await failedContext.supervision?.stop();
      const stopped = Promise.resolve().then(() => failedContext!.collaborator?.stop());
      for (const session of [...failedContext.dailySessions.values(), ...failedContext.loopSessions.values()]) {
        session.shutdownRequested = true; session.abort.abort();
      }
      await Promise.allSettled([stopped, ...[...failedContext.dailySessions.values(), ...failedContext.loopSessions.values()].map((session) => session.done)]);
    }
    try { if (failedServer) await new Promise<void>((done) => failedServer!.close(() => done())); } catch { /* unbound */ }
    try { failedContext?.db.close(); } catch { /* continue cleanup */ }
    try { await shutdownOtel(); } catch { /* preserve original error */ }
    finally { releaseLock(); }
    throw error;
  }
}
