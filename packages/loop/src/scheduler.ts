// Scheduler — the heartbeat of the Loop.
//
// Three modes (from LE literature):
//   interval  — fire every N ms (simple, testable)
//   cron      — parse cron expressions and fire on schedule
//   manual    — fire exactly once, then wait for external trigger
//   goal      — keep looping until a StopCondition is met
//
// Safety guards (per LE warnings about token burn):
//   - min_interval_ms: enforced minimum between cycles
//   - max_runtime_ms:  forced stop after this much wall-clock time

import { type SchedulerConfig } from "./types.js";

export interface SchedulerTick {
  /** Unique incrementing cycle number */
  cycle: number;
  /** If mode=goal, whether the goal is currently satisfied */
  goal_met?: boolean;
}

export class Scheduler {
  private config: SchedulerConfig;
  private cycle = 0;
  private startedAt = 0;
  private lastFireAt = 0;
  private stopped = false;

  constructor(config: SchedulerConfig) {
    this.config = config;
  }

  /** Call once before the first wait(). Records the start time for max_runtime_ms. */
  start(): void {
    this.startedAt = Date.now();
    this.lastFireAt = 0;
    this.cycle = 0;
    this.stopped = false;
  }

  /**
   * Wait for the next scheduled tick.
   * Returns null when the loop should stop (max_runtime_ms exceeded, or manual mode already fired).
   */
  async wait(checkGoal?: () => Promise<boolean>): Promise<SchedulerTick | null> {
    if (this.stopped) return null;

    const elapsed = Date.now() - this.startedAt;
    const maxRt = this.config.max_runtime_ms ?? 259_200_000;

    // ── Safety: max runtime exceeded ──
    if (elapsed >= maxRt) {
      this.stopped = true;
      return null;
    }

    // ── mode=manual: fire exactly once ──
    if (this.config.mode === "manual") {
      if (this.cycle > 0) return null; // already fired
      this.cycle++;
      this.lastFireAt = Date.now();
      return { cycle: this.cycle };
    }

    // ── mode=goal: fire immediately, then loop until goal met ──
    if (this.config.mode === "goal") {
      this.cycle++;
      this.lastFireAt = Date.now();
      const goalMet = checkGoal ? await checkGoal() : false;
      if (goalMet) {
        this.stopped = true;
        return { cycle: this.cycle, goal_met: true };
      }
      return { cycle: this.cycle };
    }

    // ── mode=interval ──
    if (this.config.mode === "interval") {
      const interval = this.config.interval_ms ?? 60_000;
      const sinceLast = Date.now() - this.lastFireAt;

      if (this.lastFireAt > 0 && sinceLast < interval) {
        const waitMs = Math.max(interval - sinceLast, this.config.min_interval_ms);
        await sleep(waitMs);
      }

      this.cycle++;
      this.lastFireAt = Date.now();
      return { cycle: this.cycle };
    }

    // ── mode=cron (simplified: poll every 30s) ──
    if (this.config.mode === "cron") {
      const cronExpr = this.config.cron_expr ?? "* * * * *";
      // MVP: poll every 30s and check if current time matches cron
      while (!this.stopped) {
        const now = new Date();
        if (cronMatches(cronExpr, now)) {
          // Avoid firing multiple times in the same minute
          const lastMinute = this.lastFireAt > 0
            ? new Date(this.lastFireAt).getMinutes()
            : -1;
          if (now.getMinutes() !== lastMinute) {
            this.cycle++;
            this.lastFireAt = Date.now();
            return { cycle: this.cycle };
          }
        }
        // Check runtime limit
        if (Date.now() - this.startedAt >= maxRt) {
          this.stopped = true;
          return null;
        }
        await sleep(30_000);
      }
      return null;
    }

    return null;
  }

  /** Signal an external stop (e.g. SIGTERM). wait() will return null on next call. */
  stop(): void {
    this.stopped = true;
  }

  get currentCycle(): number {
    return this.cycle;
  }

  get isRunning(): boolean {
    return !this.stopped;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Minimal cron expression matcher (supports the common 5-field format).
 * Only handles exact numbers, "*", and comma-separated values for MVP.
 * Full cron support (ranges, steps, named months) can come later via a library.
 */
function cronMatches(expr: string, date: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;

  const values = [
    date.getMinutes(),    // minute
    date.getHours(),      // hour
    date.getDate(),       // day of month
    date.getMonth() + 1,  // month
    date.getDay(),        // day of week
  ];

  for (let i = 0; i < 5; i++) {
    if (!fieldMatches(fields[i]!, values[i]!)) return false;
  }
  return true;
}

function fieldMatches(field: string, value: number): boolean {
  if (field === "*") return true;
  // Comma-separated: "0,30"
  for (const part of field.split(",")) {
    const trimmed = part.trim();
    if (trimmed === String(value)) return true;
  }
  return false;
}
