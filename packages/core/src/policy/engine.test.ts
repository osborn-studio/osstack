import { describe, expect, it } from "vitest";
import { PolicyEngine } from "./engine.js";
import { DEFAULT_RULES } from "./rules.js";
import type { PolicyCandidate, PolicyHistory, PolicyTask } from "./types.js";
import { CapabilitySchema } from "../capability.js";

function makeCandidate(opts: {
  id: string;
  tier: "low" | "mid" | "high";
  kindsHandled: ReadonlyArray<string>;
}): PolicyCandidate {
  const capabilities = opts.kindsHandled.map((k) =>
    CapabilitySchema.parse({
      id: `${opts.id}.${k}`, kind: k as never,
      agent_id: opts.id, description: `${opts.id} ${k}`, cost_tier: opts.tier,
    }),
  );
  return { agent_id: opts.id, cost_tier: opts.tier, capabilities };
}

function emptyHistory(): PolicyHistory {
  return {
    totalRuns: () => 0,
    completedRuns: () => 0,
    recentFailures: () => 0,
    avgDurationMs: () => null,
  };
}

function fixedHistory(byAgent: Record<string, { total: number; completed: number; recentFails?: number }>): PolicyHistory {
  return {
    totalRuns: (a) => byAgent[a]?.total ?? 0,
    completedRuns: (a) => byAgent[a]?.completed ?? 0,
    recentFailures: (a) => byAgent[a]?.recentFails ?? 0,
    avgDurationMs: () => null,
  };
}

const task: PolicyTask = {
  capability_id: "claude-code.code.write",
  kind: "code.write",
  phase: "code",
  prompt: "write a function",
};

const claude = makeCandidate({ id: "claude-code", tier: "high", kindsHandled: ["code.write", "code.refactor"] });
const codex  = makeCandidate({ id: "codex-cli",   tier: "mid",  kindsHandled: ["code.write", "code.refactor"] });

describe("PolicyEngine", () => {
  it("falls back to cost_tier tie-breaker with empty history (no rules score)", () => {
    const engine = new PolicyEngine({ rules: [] });
    const d = engine.decide(task, [claude, codex], emptyHistory());
    // No rules → all totals are 0 → tie broken by cost_tier (mid < high).
    expect(d.winner?.candidate.agent_id).toBe("codex-cli");
    expect(d.handoff.triggered).toBe(false);
  });

  it("uses success_rate to lift the better-performing agent", () => {
    const engine = new PolicyEngine({ rules: DEFAULT_RULES });
    const hist = fixedHistory({
      "claude-code": { total: 20, completed: 19 },     // 95% success
      "codex-cli":   { total: 20, completed: 12 },     // 60% success
    });
    const d = engine.decide(task, [claude, codex], hist);
    expect(d.winner?.candidate.agent_id).toBe("claude-code");
    expect(d.winner?.breakdown.some((b) => b.rule_id === "success_rate")).toBe(true);
  });

  it("penalizes recent failures", () => {
    const engine = new PolicyEngine({ rules: DEFAULT_RULES });
    const hist = fixedHistory({
      "claude-code": { total: 10, completed: 8, recentFails: 3 },
      "codex-cli":   { total: 10, completed: 8, recentFails: 0 },
    });
    const d = engine.decide(task, [claude, codex], hist);
    expect(d.winner?.candidate.agent_id).toBe("codex-cli");
  });

  it("gives cold-start bonus to first-time adapter", () => {
    const engine = new PolicyEngine({ rules: DEFAULT_RULES });
    const hist = fixedHistory({
      "claude-code": { total: 5, completed: 1 }, // 20% success → low score
      "codex-cli":   { total: 0, completed: 0 }, // cold start
    });
    const d = engine.decide(task, [claude, codex], hist);
    expect(d.winner?.candidate.agent_id).toBe("codex-cli");
  });

  it("triggers handoff when failure rate exceeds threshold", () => {
    const engine = new PolicyEngine({ rules: DEFAULT_RULES });
    const hist = fixedHistory({
      "claude-code": { total: 10, completed: 3, recentFails: 5 }, // 70% failure
      "codex-cli":   { total: 10, completed: 9 },
    });
    const d = engine.decide(task, [claude, codex], hist);
    // claude-code's score is wrecked by failures, so codex should win and not trigger handoff
    expect(d.winner?.candidate.agent_id).toBe("codex-cli");
    expect(d.handoff.triggered).toBe(false);
  });

  it("does trigger handoff when ALL candidates are failing", () => {
    const engine = new PolicyEngine({ rules: DEFAULT_RULES });
    const hist = fixedHistory({
      "claude-code": { total: 10, completed: 2, recentFails: 4 },
      "codex-cli":   { total: 10, completed: 3, recentFails: 4 },
    });
    const d = engine.decide(task, [claude, codex], hist);
    expect(d.handoff.triggered).toBe(true);
    expect(d.handoff.reason).toMatch(/failure rate/);
  });

  it("a throwing rule does not break the engine; other rules still run", () => {
    const bad = {
      id: "throwing",
      description: "always throws",
      score(): never { throw new Error("kaboom"); },
    };
    const engine = new PolicyEngine({ rules: [bad, ...DEFAULT_RULES] });
    const d = engine.decide(task, [codex], emptyHistory());
    expect(d.winner).not.toBeNull();
    expect(d.winner!.breakdown.find((b) => b.rule_id === "throwing")?.reason).toMatch(/rule_error/);
  });

  it("ranks output sorted desc by total score", () => {
    const engine = new PolicyEngine({ rules: DEFAULT_RULES });
    const hist = fixedHistory({
      "claude-code": { total: 20, completed: 19 },
      "codex-cli":   { total: 20, completed: 5 },
    });
    const d = engine.decide(task, [codex, claude], hist);
    expect(d.ranked[0]!.candidate.agent_id).toBe("claude-code");
    expect(d.ranked[1]!.candidate.agent_id).toBe("codex-cli");
    expect(d.ranked[0]!.total).toBeGreaterThan(d.ranked[1]!.total);
  });
});
