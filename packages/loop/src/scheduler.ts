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
        if (cronExpressionMatches(cronExpr, now)) {
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
export function cronExpressionMatches(expr: string, date: Date): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;

  return fieldMatches(fields[0]!, date.getMinutes())
    && fieldMatches(fields[1]!, date.getHours())
    && fieldMatches(fields[2]!, date.getDate())
    && fieldMatches(fields[3]!, date.getMonth() + 1)
    && dayOfWeekMatches(fields[4]!, date.getDay());
}

export function validateCronExpression(expr: string): Error | undefined {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return new Error("cron expression must have 5 fields");
  const ranges = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7],
  ] as const;
  for (let i = 0; i < fields.length; i++) {
    const invalid = validateCronField(fields[i]!, ranges[i]![0], ranges[i]![1]);
    if (invalid !== undefined) return new Error(`invalid cron field ${i + 1}: ${invalid}`);
  }
  return undefined;
}

export function nextCronDelayMs(
  expr: string,
  from = new Date(),
  options: { includeCurrentMinute?: boolean } = {},
): number | Error {
  const invalid = validateCronExpression(expr);
  if (invalid !== undefined) return invalid;

  const start = new Date(from);
  start.setSeconds(0, 0);
  if (options.includeCurrentMinute !== true) {
    start.setMinutes(start.getMinutes() + 1);
  }

  const maxMinutes = 366 * 24 * 60;
  for (let offset = 0; offset <= maxMinutes; offset++) {
    const candidate = new Date(start.getTime() + offset * 60_000);
    if (cronExpressionMatches(expr, candidate)) {
      return Math.max(0, candidate.getTime() - from.getTime());
    }
  }
  return new Error("cron expression did not match within 366 days");
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

function dayOfWeekMatches(field: string, day: number): boolean {
  return fieldMatches(field, day) || (day === 0 && fieldMatches(field, 7));
}

function validateCronField(field: string, min: number, max: number): string | undefined {
  if (field === "*") return undefined;
  for (const part of field.split(",")) {
    const value = Number(part.trim());
    if (!Number.isInteger(value)) return `${part} is not an integer`;
    if (value < min || value > max) return `${value} is outside ${min}-${max}`;
  }
  return undefined;
}
