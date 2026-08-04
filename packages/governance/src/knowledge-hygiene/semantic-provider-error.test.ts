import { describe, expect, it } from "vitest";
import {
  SemanticProviderError,
  SemanticProviderFailureCodeV1,
} from "./semantic-provider-error.js";

describe("semantic provider failure contract", () => {
  it("accepts only the closed provider failure registry", () => {
    expect(SemanticProviderFailureCodeV1.parse("request_timeout")).toBe(
      "request_timeout",
    );
    expect(SemanticProviderFailureCodeV1.safeParse("raw_provider_message").success)
      .toBe(false);
  });

  it("exposes only a fixed code and never accepts provider text", () => {
    const error = new SemanticProviderError("model_identity_mismatch");

    expect(error).toMatchObject({
      name: "SemanticProviderError",
      code: "model_identity_mismatch",
      message: "semantic provider failed: model_identity_mismatch",
    });
    expect(JSON.stringify(error)).not.toContain("provider response");
  });
});
