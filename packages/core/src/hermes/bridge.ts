// Hermes bridge — thin shell-out wrapper for the `hermes` CLI.
//
// S4 integration. Daemon uses this to mirror task lifecycle into Hermes's
// kanban + emit events into Hermes's gateway. Bridge calls are best-effort:
// any non-zero exit becomes a warning, NEVER fails the underlying osstack
// task. The kanban sync exists to give the user a single place to see what
// the daemon did across surfaces, not to be load-bearing.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface HermesBridgeOptions {
  /** Override the `hermes` binary path. Default: $HERMES_BIN, then `hermes` on PATH. */
  bin?: string;
  /** Kanban board slug. Default: $HERMES_KANBAN_BOARD, then "default". */
  board?: string;
  /** When false (default), bridge calls become no-ops and return ok=true. */
  enabled?: boolean;
}

export interface BridgeResult {
  ok: boolean;
  /** Empty when bridge is disabled. */
  stdout?: string;
  stderr?: string;
  exit_code?: number;
  /** Reason set when ok=false. */
  reason?: string;
}

const DEFAULT_BIN_FALLBACKS = [
  "/Volumes/AIMATE_WORK/projects/hermes-agent/.venv/bin/hermes",
  join(process.env["HOME"] ?? "", "hermes-agent/.venv/bin/hermes"),
];

function resolveBin(opt?: string): string {
  if (opt) return opt;
  const env = process.env["HERMES_BIN"];
  if (env && env.length > 0) return env;
  for (const candidate of DEFAULT_BIN_FALLBACKS) {
    if (existsSync(candidate)) return candidate;
  }
  return "hermes"; // fall through to PATH
}

export class HermesBridge {
  readonly bin: string;
  readonly board: string;
  readonly enabled: boolean;

  constructor(opts: HermesBridgeOptions = {}) {
    this.bin = resolveBin(opts.bin);
    this.board = opts.board ?? process.env["HERMES_KANBAN_BOARD"] ?? "default";
    // Default: enabled iff a board override was supplied OR HERMES_KANBAN_BOARD
    // is set. Otherwise off so a fresh user installation doesn't spam the
    // default board.
    this.enabled = opts.enabled
      ?? (Boolean(opts.board) || Boolean(process.env["HERMES_KANBAN_BOARD"]));
  }

  /**
   * Create a kanban task. Returns the new task_id on success. The
   * caller passes an idempotency_key (typically the osstack run_id)
   * so retries don't create duplicates.
   */
  async createKanbanTask(opts: {
    title: string;
    body?: string;
    priority?: number;
    idempotencyKey: string;
    skills?: ReadonlyArray<string>;
  }): Promise<BridgeResult & { task_id?: string }> {
    if (!this.enabled) return { ok: true, reason: "bridge_disabled" };
    const args = [
      "kanban", "--board", this.board, "create",
      "--idempotency-key", opts.idempotencyKey,
      "--json",
    ];
    if (opts.body !== undefined) args.push("--body", opts.body);
    if (opts.priority !== undefined) args.push("--priority", String(opts.priority));
    for (const s of opts.skills ?? []) args.push("--skill", s);
    args.push(opts.title);
    const res = await this.run(args);
    if (!res.ok) return res;
    // Try to parse {task_id} from the JSON output.
    try {
      const parsed = JSON.parse(res.stdout ?? "{}") as { task_id?: string; id?: string };
      const tid = parsed.task_id ?? parsed.id;
      if (typeof tid === "string") return { ...res, task_id: tid };
    } catch { /* fallthrough */ }
    return res;
  }

  async comment(taskId: string, text: string): Promise<BridgeResult> {
    if (!this.enabled) return { ok: true, reason: "bridge_disabled" };
    return await this.run(["kanban", "--board", this.board, "comment", taskId, text]);
  }

  async complete(taskId: string, summary?: string): Promise<BridgeResult> {
    if (!this.enabled) return { ok: true, reason: "bridge_disabled" };
    const args = ["kanban", "--board", this.board, "complete", taskId];
    if (summary !== undefined) args.push("--summary", summary);
    return await this.run(args);
  }

  /** Verify the bridge can find `hermes` and the chosen board. */
  async healthCheck(): Promise<BridgeResult> {
    const v = await this.run(["--version"]);
    if (!v.ok) return v;
    if (!this.enabled) {
      const r: BridgeResult = { ok: true, reason: "bridge_disabled" };
      if (v.stdout !== undefined) r.stdout = v.stdout;
      return r;
    }
    const lb = await this.run(["kanban", "boards", "list"]);
    return lb;
  }

  private run(args: ReadonlyArray<string>, timeoutMs = 15000): Promise<BridgeResult> {
    return new Promise((resolve) => {
      const p = spawn(this.bin, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      const t = setTimeout(() => {
        p.kill("SIGTERM");
        resolve({ ok: false, reason: "timeout" });
      }, timeoutMs);
      p.stdout.on("data", (c) => { stdout += String(c); });
      p.stderr.on("data", (c) => { stderr += String(c); });
      p.on("error", (err) => {
        clearTimeout(t);
        resolve({ ok: false, reason: `spawn_failed: ${err.message}` });
      });
      p.on("exit", (code) => {
        clearTimeout(t);
        resolve({
          ok: code === 0,
          stdout: stdout.trim(),
          stderr: stderr.trim(),
          exit_code: code ?? -1,
          ...(code !== 0 ? { reason: `non_zero_exit_${code}` } : {}),
        });
      });
    });
  }
}
