import { describe, expect, it } from "vitest";
import { checkContinuationOutput } from "./continuation-output-checks.js";

describe("frozen continuation output checks", () => {
  it("requires all checks and binds evidence to the exact persisted output", () => {
    const checks = [{ kind: "json_value_equals" as const, path: ["status"], expected: "ready" }];
    const passed = checkContinuationOutput('{"status":"ready"}', checks);
    expect(passed.passed).toBe(true);
    expect(passed.details.output_sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(checkContinuationOutput('{"status":"ready"} ', checks).details.output_sha256).not.toBe(passed.details.output_sha256);
    expect(checkContinuationOutput('{"status":"ready"}', [...checks, { kind: "text_equals", expected: "ready" }]).passed).toBe(false);
  });
  it("never interprets scripts, inherited properties, missing values, or prose as proof", () => {
    for (const [text, path, expected] of [
      ['{}', ["toString"], "ready"], ['{}', ["missing"], null],
      ['ready', [], "ready"], ['{"value":"1"}', ["value"], 1],
    ] as const) {
      expect(checkContinuationOutput(text, [{ kind: "json_value_equals", path: [...path], expected }]).passed).toBe(false);
    }
    expect(checkContinuationOutput('null', [{ kind: "json_value_equals", path: [], expected: null }]).passed).toBe(true);
    expect(checkContinuationOutput('go\n', [{ kind: "text_equals", expected: "go" }]).passed).toBe(false);
    expect(checkContinuationOutput('[]', []).passed).toBe(false);
  });
});
