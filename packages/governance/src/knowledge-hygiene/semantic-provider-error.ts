import { z } from "zod";

export const SemanticProviderFailureCodeV1 = z.enum([
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
export type SemanticProviderFailureCodeV1 = z.infer<
  typeof SemanticProviderFailureCodeV1
>;

export class SemanticProviderError extends Error {
  readonly code: SemanticProviderFailureCodeV1;

  constructor(code: SemanticProviderFailureCodeV1) {
    super(`semantic provider failed: ${code}`);
    this.name = "SemanticProviderError";
    this.code = code;
  }
}
