import { afterEach, expect, it, vi } from "vitest";
import * as core from "@osstack/core";
import { evaluateRoutingGolden } from "./routing-evaluation.js";
afterEach(() => vi.restoreAllMocks());
it.each([undefined, { adapter: { id: "a" }, capability: {}, reason: "broken" }])("marks a missing/malformed production capability result incomplete", async value => {
  vi.spyOn(core, "routeCapability").mockResolvedValue(value as never);
  const result = await evaluateRoutingGolden({ version: 1, dataset_id: "missing-result", cases: [{
    id: "missing", rationale: "An absent result is not the intentional no-candidate null result.",
    entrypoint: "capability", request: { kind: "code.write" }, adapters: [], expected: { kind: "none" },
  }] });
  expect(result).toMatchObject({ status: "incomplete", total: 1, evaluated: 0, passed: 0, incomplete: 1 });
  expect(result.results[0]!.error).toBe("capability_result_missing_or_invalid");
});
