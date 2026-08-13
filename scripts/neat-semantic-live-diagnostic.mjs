const providerPrefix = "deepseek-no-tools";
const providerFailureCodes = new Set([
  "cancelled",
  "transport_error",
  "request_timeout",
  "authentication_failed",
  "rate_limited",
  "http_error",
  "response_too_large",
  "invalid_provider_json",
  "invalid_provider_response",
  "model_identity_mismatch",
  "missing_completion_choice",
  "tool_activity",
  "output_token_limit_reached",
  "content_filtered",
  "insufficient_system_resource",
  "unsupported_finish_reason",
  "missing_json_content",
  "invalid_json_content",
  "missing_result",
  "provider_result_error",
  "missing_structured_output",
  "stale_nonce",
  "unknown_provider_error",
]);

const providerFailureClassifiers = [
  {
    pattern: new RegExp(`^${providerPrefix} provider request timed out$`, "u"),
    failureClass: "provider_timeout",
  },
  {
    pattern: new RegExp(`^${providerPrefix} provider request failed$`, "u"),
    failureClass: "provider_transport",
  },
  {
    pattern: new RegExp(`^${providerPrefix} response exceeds the configured byte limit$`, "u"),
    failureClass: "provider_response_too_large",
  },
  {
    pattern: new RegExp(`^${providerPrefix} returned invalid provider JSON$`, "u"),
    failureClass: "provider_invalid_json",
  },
  {
    pattern: new RegExp(`^${providerPrefix} returned an invalid provider response schema$`, "u"),
    failureClass: "provider_invalid_schema",
  },
  {
    pattern: new RegExp(`^${providerPrefix} returned an unexpected model identity$`, "u"),
    failureClass: "provider_model_mismatch",
  },
  {
    pattern: new RegExp(`^${providerPrefix} returned no completion choice$`, "u"),
    failureClass: "provider_no_choice",
  },
  {
    pattern: new RegExp(`^${providerPrefix} reported tool activity$`, "u"),
    failureClass: "provider_tool_activity",
  },
  {
    pattern: new RegExp(`^${providerPrefix} failed closed: finish_reason=.+$`, "u"),
    failureClass: "provider_finish_reason",
  },
  {
    pattern: new RegExp(`^${providerPrefix} returned no JSON content$`, "u"),
    failureClass: "provider_no_json_content",
  },
  {
    pattern: new RegExp(`^${providerPrefix} returned invalid JSON content$`, "u"),
    failureClass: "provider_invalid_json_content",
  },
];

export function summarizeProviderInvocationFailure(error) {
  const exitCode = safeExitCode(error);
  if (exitCode === "ETIMEDOUT") {
    return `provider invocation failed: runner_timeout (exit code ${exitCode})`;
  }

  const coverageFailureCode = providerCoverageFailureCode(error);
  if (coverageFailureCode !== undefined) {
    return `provider invocation failed: semantic_coverage_failed (provider_failure_code=${coverageFailureCode}; exit code ${exitCode})`;
  }

  const message = cliErrorMessage(error);
  const httpMatch = message?.match(
    new RegExp(`^${providerPrefix} provider failed: HTTP ([1-5][0-9]{2})$`, "u"),
  );
  if (httpMatch !== null && httpMatch !== undefined) {
    return `provider invocation failed: provider_http (HTTP ${httpMatch[1]}; exit code ${exitCode})`;
  }

  for (const classifier of providerFailureClassifiers) {
    if (message !== undefined && classifier.pattern.test(message)) {
      return `provider invocation failed: ${classifier.failureClass} (exit code ${exitCode})`;
    }
  }
  return `provider invocation failed: provider_runtime_failure (exit code ${exitCode})`;
}

function providerCoverageFailureCode(error) {
  const envelope = cliEnvelope(error);
  const coverage = envelope?.status === "ok"
    ? envelope?.result?.report?.coverage
    : undefined;
  if (!Array.isArray(coverage)) return undefined;
  const failed = coverage.find((entry) =>
    entry?.state === "failed"
    && Array.isArray(entry?.reason_codes)
    && entry.reason_codes.includes("provider_error")
  );
  if (failed === undefined) return undefined;
  return providerFailureCodes.has(failed.provider_failure_code)
    ? failed.provider_failure_code
    : "unknown_provider_error";
}

function cliErrorMessage(error) {
  const envelope = cliEnvelope(error);
  return envelope?.status === "error"
    && typeof envelope?.error?.message === "string"
    ? envelope.error.message
    : undefined;
}

function cliEnvelope(error) {
  if (typeof error !== "object" || error === null || !("stdout" in error)) {
    return undefined;
  }
  if (typeof error.stdout !== "string") return undefined;
  try {
    return JSON.parse(error.stdout);
  } catch {
    return undefined;
  }
}

function safeExitCode(error) {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return "unknown";
  }
  const code = error.code;
  if (Number.isSafeInteger(code)) return String(code);
  if (typeof code === "string" && /^[A-Z0-9_]{1,32}$/u.test(code)) return code;
  return "unknown";
}
