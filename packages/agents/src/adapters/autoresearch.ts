// AutoResearchAdapter — wraps karpathy/autoresearch's autonomous ML-research
// loop as an osstack AgentAdapter.
//
// Upstream (https://github.com/karpathy/autoresearch) is a single-GPU LLM
// training harness where an agent edits ONE file (train.py), runs a fixed
// ~5-minute training budget, reads the val_bpb metric, and keeps (git commit)
// or rolls back (git reset) based on whether the metric improved. The human
// edits program.md (the "skill"); the agent edits train.py.
//
// What THIS adapter contributes: it makes that loop a routable osstack
// capability (research.ml). The deterministic harness mechanics live here —
// propose → train → parse → git keep/rollback → log results.tsv — streamed
// as HermesEvents so the run shows up on the kanban board and in stats. The
// only non-deterministic step (proposing a train.py edit) is a pluggable
// seam: by default it shells out to a coding agent in the repo; tests inject
// a deterministic proposer + runner so no GPU is required.
//
// Faithfulness to program.md:
//   - first iteration is always the baseline (no edit, run as-is)
//   - each subsequent iteration edits train.py, commits, trains, evaluates
//   - keep if val_bpb strictly improved; else git reset --hard to baseline
//   - crashes (no val_bpb parsed) are reset + logged status=crash
//   - results.tsv columns: commit, val_bpb, memory_gb, status, description
//   - per-run hard timeout (default 10 min, matching program.md's kill rule)

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CapabilitySchema, type Capability, type CostTier } from "@osstack/core";
import type { HermesEvent } from "@osstack/hermes-adapter";
import { BaseAgentAdapter, type AgentAvailability, type AgentId, type AgentTask } from "../base.js";
import { buildAgentChildEnv } from "../child-env.js";

// ── metric parsing ──────────────────────────────────────────────────────

export interface TrainResult {
  /** true if training finished and a val_bpb was produced. */
  ok: boolean;
  /** Validation bits-per-byte (lower is better); null on crash. */
  val_bpb: number | null;
  /** Peak VRAM in MB; null on crash. */
  peak_vram_mb: number | null;
  /** Last lines of run.log (for diagnostics on crash). */
  raw_tail?: string;
}

/** Parse the autoresearch summary block from a train.py run log. */
export function parseTrainLog(log: string): TrainResult {
  const bpbMatch = log.match(/^val_bpb:\s+([0-9.]+)/m);
  const vramMatch = log.match(/^peak_vram_mb:\s+([0-9.]+)/m);
  const val_bpb = bpbMatch ? Number(bpbMatch[1]) : null;
  const peak_vram_mb = vramMatch ? Number(vramMatch[1]) : null;
  const tail = log.split("\n").slice(-50).join("\n");
  return {
    ok: val_bpb !== null && Number.isFinite(val_bpb),
    val_bpb,
    peak_vram_mb,
    raw_tail: tail,
  };
}

// ── pluggable seams (real impls shell out; tests inject) ─────────────────

export interface ProposeContext {
  repo_path: string;
  iteration: number;
  best_val_bpb: number | null;
  last_result: TrainResult | null;
  /** History of prior iteration descriptions, newest last. */
  history: string[];
  signal: AbortSignal;
}

export interface ProposeResult {
  /** Short description of the experiment this edit tries (for results.tsv). */
  description: string;
  /** True if the proposer actually changed train.py. Baseline iteration = false. */
  edited: boolean;
}

export type ProposeFn = (ctx: ProposeContext) => Promise<ProposeResult>;
export type TrainFn = (repo_path: string, signal: AbortSignal) => Promise<TrainResult>;
export type GitFn = (repo_path: string, args: string[]) => Promise<{ ok: boolean; stdout: string }>;

// ── config ────────────────────────────────────────────────────────────

export interface AutoResearchConfig {
  /** Path to the autoresearch checkout (must contain train.py + prepare.py). */
  repo_path?: string;
  /** Run tag → branch autoresearch/<tag>. Default derived from date. */
  tag?: string;
  /** Bounded iteration count (program.md says "never stop"; osstack bounds it). */
  max_iterations?: number;
  /** Per-train hard timeout in seconds. Default 600 (program.md's 10-min kill). */
  time_budget_s?: number;
  /** uv binary. Default "uv". */
  uv_bin?: string;
  /** Override seams (tests). */
  hooks?: { propose?: ProposeFn; train?: TrainFn; git?: GitFn };
}

// ── event helpers (mirror codex-cli.ts) ─────────────────────────────────

function now(): number { return Date.now() / 1000; }
function envelope(task: AgentTask, seq: number, terminal: boolean): Omit<HermesEvent, "type" | "payload"> {
  return { event_id: `${task.run_id}:${seq}`, seq, run_id: task.run_id, session_id: task.session_id, created_at: now(), terminal };
}
function runStarted(task: AgentTask, seq: number): HermesEvent {
  return { ...envelope(task, seq, false), type: "run.started", payload: { status: "running", controls: { cancel: true, approval_pending: false, clarify_pending: false, queue: false, goal: false } } };
}
function progress(task: AgentTask, seq: number, phase: string, detail?: string): HermesEvent {
  const payload: HermesEvent["payload"] = { phase };
  if (detail !== undefined) (payload as Record<string, unknown>).detail = detail;
  return { ...envelope(task, seq, false), type: "progress", payload };
}
function tokenDelta(task: AgentTask, seq: number, messageId: string, text: string): HermesEvent {
  return { ...envelope(task, seq, false), type: "token.delta", payload: { message_id: messageId, delta: text, content_type: "text" } };
}
function doneEvent(task: AgentTask, seq: number, status: "completed" | "failed" | "cancelled", lastSeq: number, summary?: string): HermesEvent {
  const payload: HermesEvent["payload"] = { status, last_seq: lastSeq };
  if (summary !== undefined) (payload as Record<string, unknown>).result_summary = summary;
  return { ...envelope(task, seq, true), type: "done", payload };
}
function errorEvent(task: AgentTask, seq: number, code: string, message: string): HermesEvent {
  return { ...envelope(task, seq, true), type: "error", payload: { code, message, terminal: true } };
}

// ── default real seams ──────────────────────────────────────────────────

function defaultGit(uvUnused?: string): GitFn {
  void uvUnused;
  return (repo_path, args) =>
    new Promise((resolve) => {
      const p = spawn("git", args, {
        cwd: repo_path,
        stdio: ["ignore", "pipe", "pipe"],
        env: buildAgentChildEnv(),
      });
      let stdout = "";
      p.stdout.on("data", (c) => { stdout += String(c); });
      p.on("error", () => resolve({ ok: false, stdout: "" }));
      p.on("exit", (code) => resolve({ ok: code === 0, stdout: stdout.trim() }));
    });
}

function defaultTrain(uvBin: string): TrainFn {
  return (repo_path, signal) =>
    new Promise((resolve) => {
      // `uv run train.py > run.log 2>&1` — capture, don't flood.
      const logPath = join(repo_path, "run.log");
      const p = spawn(uvBin, ["run", "train.py"], {
        cwd: repo_path,
        stdio: ["ignore", "pipe", "pipe"],
        env: buildAgentChildEnv(),
      });
      let buf = "";
      const onAbort = (): void => { p.kill("SIGTERM"); };
      signal.addEventListener("abort", onAbort, { once: true });
      p.stdout.on("data", (c) => { buf += String(c); });
      p.stderr.on("data", (c) => { buf += String(c); });
      p.on("error", () => {
        signal.removeEventListener("abort", onAbort);
        resolve({ ok: false, val_bpb: null, peak_vram_mb: null, raw_tail: "spawn failed" });
      });
      p.on("exit", () => {
        signal.removeEventListener("abort", onAbort);
        try { writeFileSync(logPath, buf, "utf8"); } catch { /* best-effort */ }
        resolve(parseTrainLog(buf));
      });
    });
}

/**
 * Default proposer: shell a coding agent (claude headless) in the repo with
 * program.md + the loop context, asking it to edit train.py. If `claude`
 * isn't on PATH this throws; callers without it should inject a proposer or
 * run baseline-only (max_iterations=1).
 */
function defaultPropose(): ProposeFn {
  return (ctx) =>
    new Promise((resolve, reject) => {
      if (ctx.iteration === 0) {
        // program.md: the very first run is always the baseline, no edit.
        resolve({ description: "baseline", edited: false });
        return;
      }
      const prompt = [
        "Read program.md and train.py in this repo.",
        `This is autoresearch iteration ${ctx.iteration}.`,
        ctx.best_val_bpb !== null ? `Best val_bpb so far: ${ctx.best_val_bpb}.` : "",
        ctx.history.length ? `Prior experiments: ${ctx.history.slice(-5).join("; ")}.` : "",
        "Make ONE experimental edit to train.py to try to lower val_bpb.",
        "Edit the file directly. Then reply with a one-line description of what you changed.",
      ].filter(Boolean).join(" ");
      const p = spawn("claude", ["-p", prompt], {
        cwd: ctx.repo_path,
        stdio: ["ignore", "pipe", "pipe"],
        env: buildAgentChildEnv(),
      });
      let out = "";
      const onAbort = (): void => { p.kill("SIGTERM"); };
      ctx.signal.addEventListener("abort", onAbort, { once: true });
      p.stdout.on("data", (c) => { out += String(c); });
      p.on("error", (err) => {
        ctx.signal.removeEventListener("abort", onAbort);
        reject(new Error(`autoresearch proposer (claude) unavailable: ${err.message}`));
      });
      p.on("exit", () => {
        ctx.signal.removeEventListener("abort", onAbort);
        resolve({ description: out.trim().split("\n").pop()?.slice(0, 120) || `experiment ${ctx.iteration}`, edited: true });
      });
    });
}

// ── the adapter ──────────────────────────────────────────────────────────

interface IterationOutcome {
  iteration: number;
  status: "keep" | "discard" | "crash" | "baseline";
  val_bpb: number | null;
  commit: string;
  description: string;
}

export class AutoResearchAdapter extends BaseAgentAdapter {
  readonly id: AgentId = "autoresearch";
  readonly display_name = "AutoResearch (Karpathy single-GPU ML loop)";
  readonly cost_tier: CostTier = "high";

  private readonly cfg: AutoResearchConfig;
  private readonly propose: ProposeFn;
  private readonly train: TrainFn;
  private readonly git: GitFn;

  constructor(cfg: AutoResearchConfig = {}) {
    super();
    this.cfg = cfg;
    const uvBin = cfg.uv_bin ?? "uv";
    this.propose = cfg.hooks?.propose ?? defaultPropose();
    this.train = cfg.hooks?.train ?? defaultTrain(uvBin);
    this.git = cfg.hooks?.git ?? defaultGit();
  }

  capabilities(): readonly Capability[] {
    return [
      CapabilitySchema.parse({
        id: "autoresearch.research.ml",
        kind: "research.ml",
        agent_id: this.id,
        description: "Autonomous single-GPU ML-research loop (karpathy/autoresearch): propose→train→eval→keep/rollback over train.py, metric=val_bpb.",
        cost_tier: "high",
        hints: { frameworks: ["pytorch"], languages: ["python"] },
      }),
    ];
  }

  /**
   * Available iff the repo path exists and looks like an autoresearch checkout
   * (train.py + prepare.py present). Does NOT probe for a GPU — forks support
   * CPU/MPS, and we don't want a false-negative on a valid setup.
   */
  async isAvailable(): Promise<AgentAvailability> {
    const repo = this.resolveRepo();
    const checkedAt = Math.floor(Date.now() / 1000);
    if (!repo) {
      return { available: false, reason: "no autoresearch repo_path configured (set OSSTACK_AUTORESEARCH_REPO)", last_checked_at: checkedAt };
    }
    if (!existsSync(join(repo, "train.py")) || !existsSync(join(repo, "prepare.py"))) {
      return { available: false, reason: `${repo} does not look like an autoresearch checkout (missing train.py/prepare.py)`, last_checked_at: checkedAt };
    }
    return { available: true, last_checked_at: checkedAt };
  }

  private resolveRepo(): string | undefined {
    return this.cfg.repo_path ?? process.env["OSSTACK_AUTORESEARCH_REPO"];
  }

  async *invoke(task: AgentTask, signal: AbortSignal): AsyncIterable<HermesEvent> {
    let seq = 0;
    yield runStarted(task, seq++);

    const repo = this.resolveRepo();
    if (!repo || !existsSync(join(repo, "train.py"))) {
      yield errorEvent(task, seq++, "autoresearch_no_repo", "autoresearch repo not found; set repo_path or OSSTACK_AUTORESEARCH_REPO");
      return;
    }

    const ctx = (task.context ?? {}) as Record<string, unknown>;
    const maxIter = Number(ctx["max_iterations"] ?? this.cfg.max_iterations ?? 5);
    const tag = String(ctx["tag"] ?? this.cfg.tag ?? `run${new Date().toISOString().slice(5, 10).replace("-", "")}`);
    const timeoutMs = (Number(ctx["time_budget_s"] ?? this.cfg.time_budget_s ?? 600)) * 1000;

    // Set up the run branch (best-effort; if branch exists we just continue on it).
    yield progress(task, seq++, "autoresearch.setup", `branch autoresearch/${tag}`);
    await this.git(repo, ["checkout", "-B", `autoresearch/${tag}`]);

    // Initialize results.tsv with the header (untracked, per program.md).
    const tsvPath = join(repo, "results.tsv");
    try { writeFileSync(tsvPath, "commit\tval_bpb\tmemory_gb\tstatus\tdescription\n", "utf8"); } catch { /* best-effort */ }

    let best: number | null = null;
    const history: string[] = [];
    const outcomes: IterationOutcome[] = [];

    for (let i = 0; i < maxIter; i++) {
      if (signal.aborted) {
        yield doneEvent(task, seq, "cancelled", seq - 1, `cancelled after ${i} iterations; best val_bpb=${best ?? "n/a"}`);
        return;
      }

      // 1. baseline commit we can roll back to
      const baseRes = await this.git(repo, ["rev-parse", "HEAD"]);
      const baseCommit = baseRes.stdout.trim();

      // 2. propose an edit (iteration 0 = baseline, no edit)
      yield progress(task, seq++, "autoresearch.propose", `iteration ${i}`);
      let proposal: ProposeResult;
      try {
        proposal = await this.propose({ repo_path: repo, iteration: i, best_val_bpb: best, last_result: outcomes.at(-1) ? { ok: true, val_bpb: outcomes.at(-1)!.val_bpb, peak_vram_mb: null } : null, history, signal });
      } catch (err) {
        yield errorEvent(task, seq++, "autoresearch_propose_failed", (err as Error).message);
        return;
      }

      // 3. commit the edit (so we can advance or reset cleanly)
      if (proposal.edited) {
        await this.git(repo, ["add", "train.py"]);
        await this.git(repo, ["commit", "-m", `exp: ${proposal.description}`, "--no-verify"]);
      }

      // 4. train (with hard timeout)
      const toolId = `${task.run_id}:train:${i}`;
      yield progress(task, seq++, "autoresearch.train", `iteration ${i} (budget ${timeoutMs / 1000}s)`);
      const trainAc = new AbortController();
      const onParentAbort = (): void => trainAc.abort();
      signal.addEventListener("abort", onParentAbort, { once: true });
      const timer = setTimeout(() => trainAc.abort(), timeoutMs);
      let result: TrainResult;
      try {
        result = await this.train(repo, trainAc.signal);
      } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", onParentAbort);
      }
      void toolId;

      // 5. evaluate + keep/rollback
      const headRes = await this.git(repo, ["rev-parse", "--short", "HEAD"]);
      const commit = headRes.stdout.trim() || baseCommit.slice(0, 7);
      let status: IterationOutcome["status"];
      if (i === 0) {
        // baseline always kept as the reference
        status = "baseline";
        if (result.ok) best = result.val_bpb;
      } else if (!result.ok) {
        status = "crash";
        await this.git(repo, ["reset", "--hard", baseCommit]);
      } else if (best === null || (result.val_bpb !== null && result.val_bpb < best)) {
        status = "keep";
        best = result.val_bpb;
      } else {
        status = "discard";
        await this.git(repo, ["reset", "--hard", baseCommit]);
      }

      // 6. log results.tsv
      const memGb = result.peak_vram_mb !== null ? (result.peak_vram_mb / 1024).toFixed(1) : "0.0";
      const bpbStr = result.val_bpb !== null ? result.val_bpb.toFixed(6) : "0.000000";
      try {
        appendFileSync(tsvPath, `${commit}\t${bpbStr}\t${memGb}\t${status}\t${proposal.description}\n`, "utf8");
      } catch { /* best-effort */ }

      history.push(`${proposal.description} → ${status} (${bpbStr})`);
      outcomes.push({ iteration: i, status, val_bpb: result.val_bpb, commit, description: proposal.description });

      // 7. stream the iteration result
      yield tokenDelta(task, seq++, `${task.run_id}:iter:${i}`,
        `iteration ${i}: ${status} | val_bpb=${bpbStr} | ${proposal.description}`);
    }

    const kept = outcomes.filter((o) => o.status === "keep" || o.status === "baseline").length;
    const summary = `autoresearch: ${outcomes.length} iterations, ${kept} kept, best val_bpb=${best ?? "n/a"}`;
    yield progress(task, seq++, "autoresearch.summary", summary);
    yield doneEvent(task, seq, "completed", seq - 1, summary);
  }

  /** Synchronous-ish escape hatch for callers/tests that want the raw loop result. */
  async runLoop(opts: { repo_path: string; max_iterations: number; tag?: string }): Promise<IterationOutcome[]> {
    const task: AgentTask = { run_id: "direct", task_id: "direct", session_id: "direct", capability_id: "autoresearch.research.ml", prompt: "", context: opts as unknown as Record<string, unknown> };
    const ac = new AbortController();
    const outcomes: IterationOutcome[] = [];
    for await (const ev of this.invoke(task, ac.signal)) {
      if (ev.type === "token.delta") {
        const delta = (ev.payload as { delta?: string }).delta ?? "";
        const m = delta.match(/iteration (\d+): (\w+) \| val_bpb=([0-9.]+)/);
        if (m) outcomes.push({ iteration: Number(m[1]), status: m[2] as IterationOutcome["status"], val_bpb: Number(m[3]), commit: "", description: "" });
      }
    }
    return outcomes;
  }
}
