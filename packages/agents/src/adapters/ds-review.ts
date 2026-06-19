import { CapabilitySchema, type Capability } from "@osstack/core";
import { DeepSeekCommandAdapter, type DeepSeekCommandOptions } from "./deepseek-command.js";

const CAPABILITIES: readonly Capability[] = [
  CapabilitySchema.parse({
    id: "ds-review.review.code",
    kind: "review.code",
    agent_id: "ds-review",
    description: "Run the legacy DeepSeek code-review command against the current git diff.",
    cost_tier: "low",
  }),
  CapabilitySchema.parse({
    id: "ds-review.code.review",
    kind: "code.review",
    agent_id: "ds-review",
    description: "Compatibility capability for code-review routing.",
    cost_tier: "low",
  }),
];

export class DeepSeekReviewAdapter extends DeepSeekCommandAdapter {
  constructor(options: DeepSeekCommandOptions = {}) {
    super({
      id: "ds-review",
      displayName: "DeepSeek Review",
      envBin: "OSSTACK_DS_REVIEW_BIN",
      defaultBin: "ds-review",
      defaultOutputPath: "reviews/ds-review/latest.md",
      commandKind: "review",
      capabilities: CAPABILITIES,
    }, options);
  }
}
