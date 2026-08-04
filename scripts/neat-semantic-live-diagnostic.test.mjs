import assert from "node:assert/strict";
import test from "node:test";
import { summarizeProviderInvocationFailure } from "./neat-semantic-live-diagnostic.mjs";

function cliFailure(message, overrides = {}) {
  return {
    code: 3,
    stdout: JSON.stringify({
      protocol_version: "1.0",
      status: "error",
      error: {
        code: "internal",
        message,
        retryable: true,
      },
    }),
    stderr: "",
    ...overrides,
  };
}

test("reports an allowlisted HTTP status from the CLI error envelope", () => {
  assert.equal(
    summarizeProviderInvocationFailure(
      cliFailure("deepseek-no-tools provider failed: HTTP 401"),
    ),
    "provider invocation failed: provider_http (HTTP 401; exit code 3)",
  );
});

test("classifies safe provider failures without replaying CLI text", () => {
  assert.equal(
    summarizeProviderInvocationFailure(
      cliFailure("deepseek-no-tools returned an unexpected model identity"),
    ),
    "provider invocation failed: provider_model_mismatch (exit code 3)",
  );
});

test("fails closed for unrecognized output and never exposes arbitrary content", () => {
  const secretSentinel = "secret-sentinel-must-not-appear";
  const summary = summarizeProviderInvocationFailure(
    cliFailure(`unexpected provider body: ${secretSentinel}`, {
      stderr: `transport details ${secretSentinel}`,
    }),
  );

  assert.equal(
    summary,
    "provider invocation failed: provider_runtime_failure (exit code 3)",
  );
  assert.doesNotMatch(summary, /secret-sentinel/u);
});

test("falls back safely when the CLI output is not a JSON error envelope", () => {
  assert.equal(
    summarizeProviderInvocationFailure({
      code: "ETIMEDOUT",
      stdout: "not-json",
      stderr: "untrusted stderr",
    }),
    "provider invocation failed: runner_timeout (exit code ETIMEDOUT)",
  );
});

test("reports a failed semantic coverage reason from a successful CLI envelope", () => {
  assert.equal(
    summarizeProviderInvocationFailure({
      code: 3,
      stdout: JSON.stringify({
        protocol_version: "1.0",
        status: "ok",
        result: {
          command: "knowledge_hygiene.semantic",
          report: {
            coverage: [{
              dimension: "narrative",
              state: "failed",
              reason_codes: ["provider_error"],
            }],
          },
        },
      }),
      stderr: "",
    }),
    "provider invocation failed: semantic_coverage_failed (reason provider_error; exit code 3)",
  );
});
