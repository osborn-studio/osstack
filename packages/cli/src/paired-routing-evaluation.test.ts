import { describe, expect, it, vi } from "vitest";
import { evaluatePairedRouting, runControlledPairedRouting, type PairedRoutingInput } from "./paired-routing-evaluation.js";

const input = (): PairedRoutingInput => ({
  schema_version: 1, dataset_id: "heldout", split: "holdout", training_prompt_sha256: [],
  cases: [{ id: "one", excerpt: "A human must choose the next option", expected: "human_decision" },
    { id: "two", excerpt: "Waiting for authoritative execution receipt", expected: "system_wait" }],
  models: [{ id: "small", input_usd_per_million: 1, output_usd_per_million: 2, cache_creation_usd_per_million: 2, cache_read_usd_per_million: 1 },
    { id: "large", input_usd_per_million: 3, output_usd_per_million: 6, cache_creation_usd_per_million: 6, cache_read_usd_per_million: 3 }],
  pricing_source: "operator supplied fixture", seed: "fixed", repetitions: 2,
  per_call_budget_usd: 0.01, total_budget_usd: 0.08, timeout_ms: 100,
});
const response = (model: string, category = "human_decision") => ({ text: JSON.stringify({ category, explanation: "source facts" }),
  requested_model: model, reported_model: model, api_reported_model: model, policy_fingerprint: "a".repeat(64), process_exit_confirmed: true, usage: { input_tokens: 10, output_tokens: 4, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 } });
describe("paired routing evaluation", () => {
  it("executes both models on the same hidden-label holdout with bounded cost evidence", async () => {
    const calls: string[] = [];
    const report = await evaluatePairedRouting(input(), (model) => ({ invoke: async (prompt) => {
      calls.push(prompt); expect(prompt).not.toContain('"expected"'); expect(prompt).not.toContain('"id"');
      return response(model, prompt.includes("human must") ? "human_decision" : "system_wait");
    } }));
    expect(calls).toHaveLength(8); expect(report.status).toBe("completed");
    expect(report.paired_cases).toBe(2); expect(report.paired_accuracy_difference).toBe(0);
    expect(report.models.map(m => m.accuracy)).toEqual([1, 1]);
    expect(report.default_route_changed).toBe(false); expect(report.models[0]!.estimated_cost_usd).toBeCloseTo(0.000072);
  });
  it("rejects insufficient reservation before creating a provider", async () => {
    let calls = 0;
    await expect(evaluatePairedRouting({ ...input(), total_budget_usd: 0.01 }, () => { calls++; throw Error(); })).rejects.toThrow("budget");
    expect(calls).toBe(0);
  });
  it("rejects training leakage and duplicate prompts before invocation", async () => {
    const { createHash } = await import("node:crypto"); const value = input();
    value.training_prompt_sha256 = [createHash("sha256").update(value.cases[0]!.excerpt).digest("hex")];
    await expect(evaluatePairedRouting(value, () => { throw Error("must not create"); })).rejects.toThrow("holdout_overlap");
    const duplicate = input(); duplicate.cases[1]!.excerpt = duplicate.cases[0]!.excerpt;
    await expect(evaluatePairedRouting(duplicate, () => { throw Error(); })).rejects.toThrow("duplicate_prompt");
  });
  it("preserves incomplete calls and refuses claimed model substitution", async () => {
    const report = await evaluatePairedRouting(input(), model => ({ invoke: async () => ({ ...response(model), reported_model: "different" }) }));
    expect(report.status).toBe("incomplete"); expect(report.paired_cases).toBe(0);
    expect(report.paired_accuracy_difference).toBeNull(); expect(report.results.every(r => r.error === "model_identity_mismatch")).toBe(true);
  });
  it("stops the entire evaluation on deadline without creating another physical call", async () => {
    let calls = 0; let aborted = false;
    const report = await evaluatePairedRouting({ ...input(), timeout_ms: 10 }, () => ({ invoke: (_prompt, signal) => {
      calls++; signal.addEventListener("abort", () => { aborted = true; }); return new Promise(() => {});
    } }));
    expect(calls).toBe(1); expect(aborted).toBe(true); expect(report.status).toBe("incomplete");
    expect(report.errors).toContain("evaluation_stopped_after_timeout");
  });
  it("never publishes comparison statistics from an incomplete subset", async () => {
    let calls = 0;
    const report = await evaluatePairedRouting(input(), model => ({ invoke: async () => {
      calls++; if (calls === 7) throw Error("bad output"); return response(model);
    } }));
    expect(report.paired_cases).toBe(1); expect(report.comparison_available).toBe(false);
    expect(report.paired_accuracy_difference).toBeNull(); expect(report.paired_difference_interval_95).toBeNull();
    expect(report.models.reduce((n, m) => n + m.unknown_usage_calls, 0)).toBe(1);
    expect(report.reserved_budget_usd).toBeCloseTo(0.07);
  });
  it("includes both cache usage classes at explicit prices", async () => {
    const report = await evaluatePairedRouting(input(), model => ({ invoke: async () => ({ ...response(model), usage: {
      input_tokens: 10, output_tokens: 4, cache_creation_input_tokens: 10, cache_read_input_tokens: 20,
    } }) }));
    expect(report.models[0]!.estimated_cost_usd).toBeCloseTo(0.000232);
  });
  it("rejects a receipt without physical-exit evidence", async () => {
    const report = await evaluatePairedRouting(input(), model => ({ invoke: async () => ({ ...response(model), process_exit_confirmed: false }) }));
    expect(report.status).toBe("incomplete"); expect(report.paired_accuracy_difference).toBeNull();
    expect(report.attempted_calls).toBe(1);
  });
  it("production entrypoint reports missing authentication without claiming a comparison", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", undefined); vi.stubEnv("ANTHROPIC_BASE_URL", undefined);
    try {
      const report = await runControlledPairedRouting(input());
      expect(report.status).toBe("incomplete"); expect(report.attempted_calls).toBe(1);
      expect(report.errors).toContain("not_authenticated"); expect(report.paired_difference_interval_95).toBeNull();
    } finally { vi.unstubAllEnvs(); }
  });
  it.each(["runtime_policy_mismatch", "runtime_policy_changed", "runtime_init_unverified", "runtime_spawn_mismatch"])("stops after integrity error %s", async error => {
    let calls = 0; const report = await evaluatePairedRouting(input(), () => ({ invoke: async () => { calls++; throw Error(error); } }));
    expect(calls).toBe(1); expect(report.errors).toContain(error); expect(report.comparison_available).toBe(false);
  });
  it("accepts both excerpt and actual wire-prompt training hashes for overlap rejection", async () => {
    const { createHash } = await import("node:crypto"); const value = input();
    value.training_prompt_sha256 = [createHash("sha256").update(JSON.stringify({ excerpt: value.cases[0]!.excerpt })).digest("hex")];
    await expect(evaluatePairedRouting(value, () => { throw Error("must not create"); })).rejects.toThrow("holdout_overlap");
  });
  it("the actual attention command dispatches paired_holdout rather than supplied predictions", async () => {
    const { createScratchDir } = await import("@osstack/core"); const { writeFile, rm } = await import("node:fs/promises");
    const { join } = await import("node:path"); const { handleAttentionCommand } = await import("./attention-command.js");
    const root = await createScratchDir("tests", "paired-cli"); const path = join(root, "dataset.json"); await writeFile(path, JSON.stringify(input()));
    vi.stubEnv("ANTHROPIC_API_KEY", undefined); vi.stubEnv("ANTHROPIC_BASE_URL", undefined);
    try {
      const output: string[] = [];
      expect(await handleAttentionCommand(["routing-eval", "--mode", "paired_holdout", "--input", path], { stdout: text => output.push(text) })).toBe(1);
      expect(JSON.parse(output[0]!)).toMatchObject({ mode: "paired_holdout", status: "incomplete", errors: ["not_authenticated"] });
    } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
  });
});
