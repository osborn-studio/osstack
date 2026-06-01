import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AutoResearchAdapter,
  parseTrainLog,
  type ProposeFn,
  type TrainFn,
  type TrainResult,
} from "./autoresearch.js";
import type { AgentTask } from "../base.js";
import type { HermesEvent } from "@osstack/hermes-adapter";

// ── a real, tiny git repo standing in for an autoresearch checkout ───────

let repo: string;

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim();
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), "autoresearch-"));
  // Minimal autoresearch-shaped checkout.
  writeFileSync(join(repo, "train.py"), "# baseline train.py\nLR = 0.01\n");
  writeFileSync(join(repo, "prepare.py"), "# fixed harness\n");
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "test"]);
  git(["add", "."]);
  git(["commit", "-q", "-m", "initial"]);
});
afterEach(() => { rmSync(repo, { recursive: true, force: true }); });

// ── deterministic seams ──────────────────────────────────────────────────

/** Proposer that bumps LR in train.py each non-baseline iteration. */
function bumpProposer(): ProposeFn {
  return async (ctx) => {
    if (ctx.iteration === 0) return { description: "baseline", edited: false };
    const path = join(ctx.repo_path, "train.py");
    const cur = readFileSync(path, "utf8");
    writeFileSync(path, cur + `\n# iter ${ctx.iteration}\n`);
    return { description: `bump experiment ${ctx.iteration}`, edited: true };
  };
}

/** Trainer driven by a fixed list of val_bpb values (null = crash). */
function scriptedTrainer(scores: Array<number | null>): TrainFn {
  let i = 0;
  return async (): Promise<TrainResult> => {
    const v = scores[i++] ?? null;
    if (v === null) return { ok: false, val_bpb: null, peak_vram_mb: null, raw_tail: "boom" };
    return { ok: true, val_bpb: v, peak_vram_mb: 44000 };
  };
}

function makeTask(context: Record<string, unknown> = {}): AgentTask {
  return { run_id: "run_t", task_id: "task_t", session_id: "sess_t", capability_id: "autoresearch.research.ml", prompt: "", context };
}

async function collect(adapter: AutoResearchAdapter, task: AgentTask): Promise<HermesEvent[]> {
  const out: HermesEvent[] = [];
  const ac = new AbortController();
  for await (const ev of adapter.invoke(task, ac.signal)) out.push(ev);
  return out;
}

function tsvRows(): string[] {
  const p = join(repo, "results.tsv");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").trim().split("\n");
}

// ── parseTrainLog ─────────────────────────────────────────────────────────

describe("parseTrainLog", () => {
  it("extracts val_bpb + peak_vram_mb from the summary block", () => {
    const log = [
      "step 00953 (100%) | loss: 1.2",
      "---",
      "val_bpb:          0.997900",
      "training_seconds: 300.1",
      "peak_vram_mb:     45060.2",
      "depth:            8",
    ].join("\n");
    const r = parseTrainLog(log);
    expect(r.ok).toBe(true);
    expect(r.val_bpb).toBeCloseTo(0.9979, 4);
    expect(r.peak_vram_mb).toBeCloseTo(45060.2, 1);
  });

  it("reports ok=false when no val_bpb (a crash)", () => {
    const r = parseTrainLog("Traceback...\nRuntimeError: CUDA out of memory");
    expect(r.ok).toBe(false);
    expect(r.val_bpb).toBeNull();
    expect(r.raw_tail).toContain("CUDA out of memory");
  });
});

// ── isAvailable ─────────────────────────────────────────────────────────

describe("isAvailable", () => {
  it("true for a valid checkout", async () => {
    const a = new AutoResearchAdapter({ repo_path: repo });
    expect((await a.isAvailable()).available).toBe(true);
  });
  it("false when repo_path missing train.py", async () => {
    const a = new AutoResearchAdapter({ repo_path: join(repo, "nope") });
    const av = await a.isAvailable();
    expect(av.available).toBe(false);
    expect(av.reason).toMatch(/train\.py|configured/);
  });
  it("declares the research.ml capability", () => {
    const a = new AutoResearchAdapter({ repo_path: repo });
    expect(a.capabilities()[0]!.kind).toBe("research.ml");
    expect(a.id).toBe("autoresearch");
  });
});

// ── the loop: keep / discard / crash ─────────────────────────────────────

describe("invoke — propose→train→eval→keep/rollback", () => {
  it("baseline first, then KEEPS an improvement", async () => {
    // baseline=1.00, iter1=0.95 (improves → keep)
    const a = new AutoResearchAdapter({
      repo_path: repo, max_iterations: 2, tag: "t",
      hooks: { propose: bumpProposer(), train: scriptedTrainer([1.0, 0.95]) },
    });
    const events = await collect(a, makeTask());
    expect(events[0]!.type).toBe("run.started");
    expect(events.at(-1)!.type).toBe("done");
    const rows = tsvRows();
    expect(rows[0]).toBe("commit\tval_bpb\tmemory_gb\tstatus\tdescription");
    expect(rows[1]).toContain("baseline");
    expect(rows[2]).toContain("keep");
    // train.py edit was kept (the iter-1 marker survives on the branch)
    expect(readFileSync(join(repo, "train.py"), "utf8")).toContain("# iter 1");
  });

  it("ROLLS BACK a regression (git reset, train.py reverted)", async () => {
    // baseline=1.00, iter1=1.10 (worse → discard + reset)
    const a = new AutoResearchAdapter({
      repo_path: repo, max_iterations: 2, tag: "t",
      hooks: { propose: bumpProposer(), train: scriptedTrainer([1.0, 1.1]) },
    });
    await collect(a, makeTask());
    const rows = tsvRows();
    expect(rows[2]).toContain("discard");
    // The discarded edit must be gone after git reset --hard.
    expect(readFileSync(join(repo, "train.py"), "utf8")).not.toContain("# iter 1");
  });

  it("handles a CRASH (null metric) → reset + status=crash", async () => {
    const a = new AutoResearchAdapter({
      repo_path: repo, max_iterations: 2, tag: "t",
      hooks: { propose: bumpProposer(), train: scriptedTrainer([1.0, null]) },
    });
    await collect(a, makeTask());
    const rows = tsvRows();
    expect(rows[2]).toContain("crash");
    expect(rows[2]).toContain("0.000000"); // crash logs 0.000000 per program.md
    expect(readFileSync(join(repo, "train.py"), "utf8")).not.toContain("# iter 1");
  });

  it("keeps only the best across several iterations", async () => {
    // baseline 1.00, then 0.98(keep), 0.99(discard), 0.95(keep)
    const a = new AutoResearchAdapter({
      repo_path: repo, max_iterations: 4, tag: "t",
      hooks: { propose: bumpProposer(), train: scriptedTrainer([1.0, 0.98, 0.99, 0.95]) },
    });
    const events = await collect(a, makeTask());
    const summary = events.at(-1)!.payload as { result_summary?: string };
    expect(summary.result_summary).toContain("best val_bpb=0.95");
    const statuses = tsvRows().slice(1).map((r) => r.split("\t")[3]);
    expect(statuses).toEqual(["baseline", "keep", "discard", "keep"]);
  });

  it("emits a token.delta per iteration with the result", async () => {
    const a = new AutoResearchAdapter({
      repo_path: repo, max_iterations: 2, tag: "t",
      hooks: { propose: bumpProposer(), train: scriptedTrainer([1.0, 0.9]) },
    });
    const events = await collect(a, makeTask());
    const deltas = events.filter((e) => e.type === "token.delta")
      .map((e) => (e.payload as { delta: string }).delta);
    expect(deltas.length).toBe(2);
    expect(deltas[0]).toContain("iteration 0: baseline");
    expect(deltas[1]).toContain("iteration 1: keep");
  });

  it("respects pre-emptive cancellation", async () => {
    const a = new AutoResearchAdapter({
      repo_path: repo, max_iterations: 5, tag: "t",
      hooks: { propose: bumpProposer(), train: scriptedTrainer([1.0, 0.9, 0.8, 0.7, 0.6]) },
    });
    const ac = new AbortController();
    ac.abort();
    const events: HermesEvent[] = [];
    for await (const ev of a.invoke(makeTask(), ac.signal)) events.push(ev);
    const final = events.at(-1)!;
    expect(final.type).toBe("done");
    expect((final.payload as { status: string }).status).toBe("cancelled");
  });

  it("errors cleanly when repo is missing", async () => {
    const a = new AutoResearchAdapter({ repo_path: join(repo, "ghost") });
    const events = await collect(a, makeTask());
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  it("respects max_iterations from task.context over config", async () => {
    const a = new AutoResearchAdapter({
      repo_path: repo, max_iterations: 5, tag: "t",
      hooks: { propose: bumpProposer(), train: scriptedTrainer([1.0, 0.9, 0.8]) },
    });
    await collect(a, makeTask({ max_iterations: 1 }));
    // only the baseline row
    expect(tsvRows().slice(1).length).toBe(1);
  });
});
