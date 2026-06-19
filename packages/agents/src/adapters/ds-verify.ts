import { CapabilitySchema, type Capability } from "@osstack/core";
import { DeepSeekCommandAdapter, type DeepSeekCommandOptions } from "./deepseek-command.js";

const CAPABILITIES: readonly Capability[] = [
  CapabilitySchema.parse({
    id: "ds-verify.verify.alignment",
    kind: "verify.alignment",
    agent_id: "ds-verify",
    description: "Run the legacy DeepSeek alignment verifier over project docs, sprint state, and git diff.",
    cost_tier: "low",
  }),
  CapabilitySchema.parse({
    id: "ds-verify.release.verify",
    kind: "release.verify",
    agent_id: "ds-verify",
    description: "Compatibility capability for release verification routing.",
    cost_tier: "low",
  }),
  CapabilitySchema.parse({
    id: "ds-verify.verify.acceptance",
    kind: "verify.acceptance",
    agent_id: "ds-verify",
    description: "Compatibility capability for acceptance verification routing.",
    cost_tier: "low",
  }),
];

export class DeepSeekVerifyAdapter extends DeepSeekCommandAdapter {
  constructor(options: DeepSeekCommandOptions = {}) {
    super({
      id: "ds-verify",
      displayName: "DeepSeek Verify",
      envBin: "OSSTACK_DS_VERIFY_BIN",
      defaultBin: "ds-verify",
      defaultOutputPath: "reviews/ds-verify/latest.md",
      commandKind: "verify",
      capabilities: CAPABILITIES,
    }, options);
  }
}
