import { createHash } from "node:crypto";

/** Keep this xorshift sequence identical to the original attention simulation. */
export function random(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value ^= value << 13;
    value ^= value >>> 17;
    value ^= value << 5;
    return value >>> 0;
  };
}

export function pick<T>(next: () => number, values: readonly T[]): T {
  if (!values.length) throw new Error("Cannot pick from an empty list");
  return values[next() % values.length]!;
}
export function chance(next: () => number, denominator: number): boolean {
  return next() % denominator === 0;
}
export const faults = [
  "lost_response", "duplicate_submission", "restart_mid_step",
  "late_result", "clock_backwards", "duplicate_answer",
] as const;
export type Fault = typeof faults[number];
export class FaultPlan {
  readonly next: () => number;
  constructor(seed: number) { this.next = random(seed); }
  fault(): Fault { return pick(this.next, faults); }
}

export function simulationConfig(defaultSteps: number, defaultSeed: number) {
  const steps = Number(process.env.OSSTACK_SIMULATION_STEPS ?? process.env.OSSTACK_PROPERTY_RUNS ?? defaultSteps);
  const seed = Number(process.env.OSSTACK_PROPERTY_SEED ?? defaultSeed);
  if (!Number.isSafeInteger(steps) || steps < 1) throw new Error("Invalid simulation steps");
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error("Invalid simulation seed");
  return { steps, seed };
}

export class Trace {
  private readonly last: string[] = [];
  private readonly hash = createHash("sha256");
  constructor(readonly seed: number, private readonly limit = 24) {}
  record(value: unknown): void {
    const line = JSON.stringify(value);
    this.hash.update(line).update("\n");
    this.last.push(line);
    if (this.last.length > this.limit) this.last.shift();
  }
  check(condition: unknown, invariant: string, detail: string): void {
    if (!condition) throw this.failure(new Error(`${invariant}: ${detail}`));
  }
  failure(cause: unknown): Error {
    return new Error(`seed=${this.seed} trace=${this.last.join("\n")} cause=${String(cause)}`, { cause });
  }
  digest(): string { return this.hash.copy().digest("hex"); }
}
