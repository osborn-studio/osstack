import { describe, expect, it } from "vitest";
import { evaluateRoutingGolden } from "./routing-evaluation.js";

const dataset = () => ({
  version: 1,
  dataset_id: "routing-regression-v1",
  cases: [{
    id: "cheap-write", rationale: "Kind routing uses the cheapest available writer.",
    entrypoint: "capability",
    request: { kind: "code.write" },
    adapters: [
      { id: "expensive", cost_tier: "high", availability: "available", capabilities: [{ id: "expensive.write", kind: "code.write" }] },
      { id: "cheap", cost_tier: "low", availability: "available", capabilities: [{ id: "cheap.write", kind: "code.write" }] },
    ],
    expected: { kind: "selected", adapter_id: "cheap", capability_id: "cheap.write", reason: "kind=code.write lowest-cost (low)" },
  }],
});

describe("real routing golden evaluation", () => {
  it("runs the real capability router, keeps the full denominator and performs no provider calls", async () => {
    const result = await evaluateRoutingGolden(dataset());
    expect(result).toMatchObject({ mode: "router_golden", status: "passed", total: 1, evaluated: 1, passed: 1, failed: 0, incomplete: 0, provider_invocations: 0 });
    expect(result.dataset_hash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.results[0]).toMatchObject({ id: "cheap-write", status: "passed", differences: [], actual: { adapter_id: "cheap" } });
  });
  it("reports mismatches without silently dropping cases", async () => {
    const input = dataset(); input.cases[0]!.expected.adapter_id = "expensive";
    const result = await evaluateRoutingGolden(input);
    expect(result).toMatchObject({ status: "failed", total: 1, evaluated: 1, failed: 1, passed: 0 });
    expect(result.results[0]!.differences).toContain("adapter_id");
  });
  it.each([
    {}, { ...dataset(), cases: [] }, { ...dataset(), cases: [...dataset().cases, ...dataset().cases] },
    { ...dataset(), cases: [undefined] },
    { ...dataset(), cases: [{ ...dataset().cases[0], expected: { kind: "anything" } }] },
    { ...dataset(), cases: [{ ...dataset().cases[0], supplied_predictions: "cheap" }] },
  ])("marks malformed/empty/duplicate data incomplete", async (input) => {
    const result = await evaluateRoutingGolden(input);
    expect(result.status).toBe("incomplete"); expect(result.evaluated).toBe(0);
    expect(result.errors.length).toBeGreaterThan(0);
  });
  it("hashes canonical input, including changed labels and adapter order", async () => {
    const input = dataset(); const same = { cases: structuredClone(input.cases), dataset_id: input.dataset_id, version: 1 };
    expect((await evaluateRoutingGolden(input)).dataset_hash).toBe((await evaluateRoutingGolden(same)).dataset_hash);
    const reversed = structuredClone(input); reversed.cases[0]!.adapters.reverse();
    expect((await evaluateRoutingGolden(reversed)).dataset_hash).not.toBe((await evaluateRoutingGolden(input)).dataset_hash);
    input.cases[0]!.rationale = "Reviewed changed rationale";
    expect((await evaluateRoutingGolden(input)).dataset_hash).not.toBe((await evaluateRoutingGolden(same)).dataset_hash);
  });
});

const profileDataset = () => ({ version: 1, dataset_id: "profile", cases: [{
  id: "profile", rationale: "The CLI supplies the actual profile entrypoint.", entrypoint: "profile",
  roles: { coding: { primary: "a", fallback: [] }, "test-verify": { primary: "b", fallback: [] }, design: { primary: "c", fallback: [] } },
  explicit_evaluators: [], role_overrides: {}, adapters: [{ id: "a", cost_tier: "low", availability: "available", capabilities: [] }],
  expected: { kind: "profile_rejected", message: "no Builder is available" },
}] });
it("counts a missing profile runner as incomplete, never a passing rejection", async () => {
  expect(await evaluateRoutingGolden(profileDataset())).toMatchObject({ status: "incomplete", total: 1, evaluated: 0, incomplete: 1 });
});
it.each([undefined, {}, { kind: "profile_selected", builder: "a" }])("counts a missing/malformed profile result as incomplete", async value => {
  const result = await evaluateRoutingGolden(profileDataset(), async () => value);
  expect(result).toMatchObject({ status: "incomplete", total: 1, evaluated: 0, incomplete: 1 });
  expect(result.results[0]!.error).toBe("profile_result_missing_or_invalid");
});
it("records and rejects provider invocation even when the caller swallows its exception", async () => {
  const result = await evaluateRoutingGolden(profileDataset(), async (_item, adapters) => {
    try { adapters[0]!.invoke(); } catch { /* Attempt must still be detected. */ }
    return { kind: "profile_rejected", message: "no Builder is available" };
  });
  expect(result).toMatchObject({ status: "incomplete", provider_invocations: 1, evaluated: 0 });
  expect(result.results[0]!.error).toBe("provider_invocation_forbidden");
});
it("rejects malformed capabilities and repeated adapters before execution", async () => {
  const input = dataset(); input.cases[0]!.adapters[0]!.capabilities[0]!.kind = "not-a-real-kind";
  expect((await evaluateRoutingGolden(input)).status).toBe("incomplete");
  const duplicate = dataset(); duplicate.cases[0]!.adapters.push(duplicate.cases[0]!.adapters[0]!);
  expect((await evaluateRoutingGolden(duplicate)).status).toBe("incomplete");
});
it("retains the full mixed-entrypoint denominator when one result is missing", async () => {
  const input = { version: 1, dataset_id: "mixed", cases: [...dataset().cases, ...profileDataset().cases] };
  const result = await evaluateRoutingGolden(input, async () => undefined);
  expect(result).toMatchObject({ status: "incomplete", total: 2, evaluated: 1, passed: 1, incomplete: 1 });
  expect(result.results.map(c => c.status)).toEqual(["passed", "incomplete"]);
});
it("does not turn an unexpected entrypoint exception into an expected rejection", async () => {
  const result = await evaluateRoutingGolden(profileDataset(), async () => { throw Error("unexpected_failure"); });
  expect(result).toMatchObject({ status: "incomplete", total: 1, evaluated: 0, passed: 0, incomplete: 1 });
});
it("rejects role override IDs that the production argv parser would truncate", async () => {
  const input = profileDataset(); input.cases[0]!.role_overrides = { "test-verify": "backup=x" };
  let called = false;
  const result = await evaluateRoutingGolden(input, async () => { called = true; return undefined; });
  expect(result.status).toBe("incomplete"); expect(called).toBe(false);
  expect(result.errors.join()).toContain("role_override_id_cannot_contain_equals");
});
it("rejects ambiguous capability IDs shared by different adapters", async () => {
  const input = dataset(); input.cases[0]!.adapters[1]!.capabilities[0]!.id = input.cases[0]!.adapters[0]!.capabilities[0]!.id;
  const result = await evaluateRoutingGolden(input);
  expect(result.status).toBe("incomplete"); expect(result.errors.join()).toContain("duplicate_capability_id_across_adapters");
});
it("compares against a snapshot even if trusted bridge code mutates its input expectation", async () => {
  const result = await evaluateRoutingGolden(profileDataset(), async item => {
    item.expected = { kind: "profile_rejected", message: "changed" };
    return item.expected;
  });
  expect(result).toMatchObject({ status: "failed", failed: 1 });
  expect(result.results[0]!.expected).toEqual({ kind: "profile_rejected", message: "no Builder is available" });
});
it("returns a report snapshot that retained adapters cannot mutate", async () => {
  let invoke: (() => never) | undefined;
  const result = await evaluateRoutingGolden(profileDataset(), async (_item, adapters) => {
    invoke = adapters[0]!.invoke;
    return { kind: "profile_rejected", message: "no Builder is available" };
  });
  expect(() => invoke!()).toThrow("provider_invocation_forbidden");
  expect(result.provider_invocations).toBe(0);
});
