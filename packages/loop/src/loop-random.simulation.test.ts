import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { command, generate, simulate, Violation, type Command, type Mutant, type Rule } from "./loop-random.simulation.testkit.js";
import { simulationConfig } from "./seeded-simulation.testkit.js";

// Artifact verification reads the candidate path set. Process creation on
// any other path is a harness error, including a fallback to a real shell.
vi.mock("node:child_process", async importOriginal => {
  const original = await importOriginal<typeof import("node:child_process")>();
  const forbidden = () => { throw Error("Unexpected child process in loop simulation"); };
  return { ...original, spawn: forbidden, spawnSync: forbidden, execFile: forbidden, exec: forbidden,
    execSync: forbidden, fork: forbidden, execFileSync: (file: string, args: string[]) => {
      if (file === "git" && args.includes("diff") && args.includes("--name-only")) return "";
      if (file === "git" && args.includes("ls-files") && args.includes("--others")) return "output.ts\0";
      return forbidden();
    } };
});

const defaultSteps = 64;
const defaults = [78, 89, 451, 2026, 7117, 92761];
function configuration() {
  const { seed, steps } = simulationConfig(defaultSteps, defaults[0]!);
  const raw = process.env.OSSTACK_SIMULATION_SEEDS;
  let seeds = process.env.OSSTACK_PROPERTY_SEED === undefined ? defaults : [seed];
  if (raw !== undefined) {
    const numbers = raw.split(",").map(s => {
      if (!/^\d+$/.test(s.trim()) || Number(s) > 0xffffffff) throw Error("Invalid OSSTACK_SIMULATION_SEEDS");
      return Number(s);
    });
    if (numbers.length > 1) seeds = numbers;
    else {
      if (!numbers[0]) throw Error("Invalid OSSTACK_SIMULATION_SEEDS count");
      seeds = Array.from({ length: numbers[0] }, (_, i) => (seed + i) >>> 0);
    }
  }
  if (process.env.OSSTACK_PROPERTY_SEED?.trim() === "") throw Error("Invalid OSSTACK_PROPERTY_SEED");
  return { seeds, steps };
}

async function checked(seed: number, list: Command[], mutant?: Mutant) {
  async function replay(candidate: Command[]) {
    const first = await simulate(seed, candidate, mutant);
    const second = await simulate(seed, candidate, mutant);
    if (first.digest !== second.digest) throw new Violation("R3", candidate.length - 1, "seed digest differs");
    return { ...first, passes: first.passes + second.passes };
  }
  try { return await replay(list); }
  catch (cause) {
    if (!(cause instanceof Violation)) throw new Error("seed=" + seed + " replay=" + JSON.stringify(list), { cause });
    let shortest = list.slice(0, cause.step + 1);
    let failure = cause, attempts = 0;
    for (let width = Math.max(1, Math.floor(shortest.length / 2)); width >= 1; width = Math.floor(width / 2)) {
      for (let i = 0; i + width <= shortest.length && attempts < 48;) {
        const trial = [...shortest.slice(0, i), ...shortest.slice(i + width)];
        attempts++;
        try { await replay(trial); }
        catch (error) {
          if (error instanceof Violation && error.rule === cause.rule && error.detail === cause.detail) {
            shortest = trial.slice(0, error.step + 1);
            failure = error;
            continue;
          }
        }
        i++;
      }
    }
    throw Error(`seed=${seed} ${failure.message} OSSTACK_SIMULATION_REPLAY=${JSON.stringify(shortest)}`);
  }
}

const { seeds, steps } = configuration();
const raw = process.env.OSSTACK_SIMULATION_REPLAY;
const list = raw === undefined ? undefined : command.array().parse(JSON.parse(
  raw.trimStart().startsWith("[") ? raw : readFileSync(raw, "utf8")));
const selected = list ? seeds.slice(0, 1) : seeds;
// Scale 60 s by (selected seeds × steps) / (default seeds × default steps), counting an empty replay as one step.
const timeoutMs = Math.ceil(60_000 * selected.length * Math.max(1, list?.length ?? steps) / (defaults.length * defaultSteps));

it("replays persistent random loop histories", async () => {
  const start = process.hrtime.bigint();
  let passes = 0;
  const digests: string[] = [];
  const coverage = new Set<string>();
  for (const seed of selected) {
    const result = await checked(seed, list ?? generate(seed, steps));
    passes += result.passes;
    digests.push(result.digest);
    for (const item of result.coverage) coverage.add(item);
  }
  console.log(`loop-random seeds=${selected} steps=${list?.length ?? steps} passes=${passes} elapsed_ms=${Number((process.hrtime.bigint() - start) / 1000000n)} digests=${digests}`);
  if (!list && selected === defaults && steps === defaultSteps) {
    for (const op of command.shape.op.options) expect(coverage).toContain("cmd-" + op);
    for (const observed of ["lost_response", "duplicate_submission", "restart_mid_step", "late_result",
      "clock_backwards", "net-rewind-pass", "net-rewind-cycles", "forward-after-rewind", "duplicate_answer", "delivered-duplicate_answer", "delivered-late_result",
      "repair-ok-1", "repair-ok-2", "repair-missing-2", "repair-mutation-1", "repair-unknown-1"]) {
      expect(coverage, observed).toContain(observed);
    }
  }
}, timeoutMs);

const submit: Command = { op: "submit", key: 0 };
const pass: Command = { op: "pass", key: 0 };
// These fixed probes use the same entry point, producer, persistence and
// assertions as generated histories. A pass with key zero delivers success.
it.each([
  ["R1", [submit, pass]], ["R2", [submit, { op: "restart_mid_step", key: 0 }, pass]],
  ["R3", [submit, pass, pass]], ["R4", [submit, pass]],
  ["R5", [submit, { op: "pass", key: 17 }]], ["R6", [submit, { ...pass, key: 1 }]],
  ["R7", [{ op: "cycles", key: 0, cycleTicks: [-5, 3] }]],
] satisfies [Rule, Command[]][])("kills the %s mutant", async (rule, list) => {
  await expect(checked(0, list, rule)).rejects.toThrow(new RegExp("seed=0 " + rule + " step="));
});

function expectedR4Failures(cases: [string, Command[], string][]) {
  it.fails.each(cases)("%s", async (_name, list, detail) => {
    // Rethrow only the recorded finding so any other outcome fails the test.
    try { await checked(0, list); }
    catch (error) {
      if (error instanceof Error && new RegExp("seed=0 R4 step=\\d+ " + detail).test(error.message)) throw error;
      console.error(error);
    }
  });
}

describe("runtime is monotonic under clock rewind", () => {
  it("reports zero elapsed for the seed-0 rewind", async () => {
    expect((await checked(0, [submit, { ...pass, tick: -1 }])).runtime).toBe(0);
  });
});

describe("a loop budget is cumulative across restarts (R4)", () => {
  it("detects a cycle reset on restart as R4", async () => {
    await expect(checked(0, [pass, pass], "reset-on-restart")).rejects.toThrow(/seed=0 R4 step=/);
  });

  it.each<[string, Command[]]>([
    ["retains elapsed usage", [submit, { ...pass, tick: 1 }, pass]],
    ["retains cycle usage", [{ op: "cycles", key: 0, cycleLimit: 4 }, { ...pass, cycleLimit: 4 }]],
    ["caps single passes", Array.from({ length: 3 }, () => ({ ...pass, cycleLimit: 2 }))],
    ["refuses work after a stop", [{ op: "cycles", key: 0 }, submit, { ...pass, cycleLimit: 2 }]],
    ["charges a crash, refuses a duplicate and resumes after a raise", [
      { op: "crash_after_debit", key: 0, cycleLimit: 1 }, submit, pass,
      { op: "duplicate_submission", key: 0 }, pass, { op: "raise_budget", key: 0 }, pass,
    ]],
  ])("%s", async (_name, commands) => { await checked(0, commands); });
});

// Documented limit: budget.ts:3-5 specifies a post-cycle check, so one cycle can exceed either cap.
describe("documented limit: budget is checked after the cycle (R4)", () => {
  expectedR4Failures([
    ["cost budget can overshoot in a cycle", [submit, { ...pass, costLimit: .0625 }], "budget usage differs"],
    ["token budget can overshoot in a cycle", [submit, { ...pass, tokenLimit: 1 }], "budget usage differs"],
  ]);
});
