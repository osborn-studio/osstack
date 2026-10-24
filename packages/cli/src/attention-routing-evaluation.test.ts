import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createScratchDirSync } from "@osstack/core";
import { evaluateRoutingGolden, type RoutingGoldenDataset } from "@osstack/supervisor";
import * as agents from "@osstack/agents";
import * as config from "@osstack/config";
import { runProfileRoutingGolden } from "./attention-routing-evaluation.js";
import { handleAttentionPlanning } from "./attention-planning-command.js";

const fixture = (): RoutingGoldenDataset => JSON.parse(readFileSync(new URL("../../supervisor/src/fixtures/routing-golden-v1.json", import.meta.url), "utf8"));
const directories: string[] = [];
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); directories.forEach(p => { rmSync(p, { recursive: true, force: true }); }); directories.length = 0; });
function inputFile(value: unknown, raw = false) {
  const directory = createScratchDirSync("tests", "routing-golden"); directories.push(directory);
  const path = join(directory, "input.json"); writeFileSync(path, raw ? String(value) : JSON.stringify(value)); return path;
}

describe("deterministic routing production wiring", () => {
  it("passes every reviewed case through its fixed actual entrypoint without real adapters or configuration", async () => {
    const providers = vi.spyOn(agents, "defaultAdapters").mockImplementation(() => { throw Error("real_adapters_forbidden"); });
    const userConfig = vi.spyOn(config, "loadConfig").mockImplementation(() => { throw Error("user_config_forbidden"); });
    vi.stubEnv("OSSTACK_AGENT_PROFILE", "never-use-this-profile");
    vi.stubEnv("OSSTACK_PROFILE", "never-use-this-either");
    const result = await evaluateRoutingGolden(fixture(), runProfileRoutingGolden);
    expect(result.results.filter(c => c.status !== "passed")).toEqual([]);
    expect(result).toMatchObject({ status: "passed", total: 22, evaluated: 22, passed: 22, incomplete: 0, provider_invocations: 0 });
    expect(providers).not.toHaveBeenCalled(); expect(userConfig).not.toHaveBeenCalled();
  });
  it("runs through the real planning CLI entrypoint and exits nonzero on a routing mismatch", async () => {
    const input = fixture(); const output: string[] = [];
    expect(await handleAttentionPlanning(["routing-eval", "--mode", "router_golden", "--input", inputFile(input), "--json"], line => output.push(line))).toBe(0);
    expect(JSON.parse(output[0]!)).toMatchObject({ mode: "router_golden", qualification: "deterministic_regression_only", passed: 22 });
    const item = input.cases[0]!;
    if (item.expected.kind !== "selected") throw Error("fixture");
    item.expected.adapter_id = "wrong";
    expect(await handleAttentionPlanning(["routing-eval", "--mode", "router_golden", "--input", inputFile(input)], line => output.push(line))).toBe(1);
    expect(JSON.parse(output[1]!)).toMatchObject({ status: "failed", total: 22, evaluated: 22, passed: 21, failed: 1 });
  });
  it("keeps legacy aggregation compatible while clearly labeling supplied predictions", async () => {
    const path = inputFile([{ id: "one", expected: "x", intentRoute: "x", promptRoute: "y", reviewRequired: true,
      intentReview: true, promptReview: false, intentTokens: 2, promptTokens: 5 }]);
    const output: string[] = [];
    expect(await handleAttentionPlanning(["routing-eval", "--input", path], line => output.push(line))).toBe(0);
    expect(JSON.parse(output[0]!)).toMatchObject({ mode: "supplied_predictions", router_executed: false,
      qualification: "supplied_predictions_only", cases: 1, intent_accuracy: 1, prompt_accuracy: 0, intent_tokens: 2, prompt_tokens: 5 });
  });
  it.each([{}, { version: 1, dataset_id: "empty", cases: [] }, "bad json"])("fails closed with an incomplete report for bad input %j", async value => {
    const output: string[] = [];
    expect(await handleAttentionPlanning(["routing-eval", "--mode", "router_golden", "--input", inputFile(value, typeof value === "string")], line => output.push(line))).toBe(1);
    expect(JSON.parse(output[0]!)).toMatchObject({ status: "incomplete", evaluated: 0 });
    if (typeof value === "string") expect(JSON.parse(output[0]!)).toMatchObject({ dataset_hash: null, errors: ["input_unreadable_or_invalid_json"] });
  });
  it("rejects an unknown mode instead of falling back to supplied predictions", async () => {
    await expect(handleAttentionPlanning(["routing-eval", "--mode", "auto", "--input", inputFile(fixture())], () => {})).rejects.toThrow("invalid_routing_eval_mode");
  });
});
