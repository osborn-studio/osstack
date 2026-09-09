import { createHash } from "node:crypto";
import type { OutputCheck } from "@osstack/protocol";

/** A deterministic output contract, not a semantic quality or task-completion judge. */
export function checkContinuationOutput(text: string, checks: readonly OutputCheck[]) {
  let value: unknown;
  let jsonValid = false;
  try { value = JSON.parse(text); jsonValid = true; } catch { /* exact text checks remain usable */ }
  const results = checks.map((check) => {
    if (check.kind === "text_equals") return text === check.expected;
    if (!jsonValid) return false;
    let current = value;
    for (const key of check.path) {
      if (typeof current !== "object" || current === null || !Object.hasOwn(current, key)) return false;
      current = (current as Record<string, unknown>)[key];
    }
    return current === check.expected;
  });
  return {
    passed: results.length > 0 && results.every(Boolean),
    details: {
      evaluator: "frozen-output-contract-v1",
      output_sha256: createHash("sha256").update(text).digest("hex"),
      results,
    },
  };
}
