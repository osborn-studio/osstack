import type { CostTier } from "@osstack/core";
import { SubprocessCliAdapter, type SubprocessCliOptions } from "./subprocess-cli.js";

const COST_TIER: CostTier = "mid";

export class OpenCodeCliAdapter extends SubprocessCliAdapter {
  constructor(options: SubprocessCliOptions = {}) {
    super({
      id: "opencode-cli",
      displayName: "OpenCode CLI (login reuse)",
      costTier: COST_TIER,
      envBin: "OSSTACK_OPENCODE_CLI_BIN",
      defaultBin: "opencode",
      envArgs: "OSSTACK_OPENCODE_CLI_ARGS",
      defaultArgs: ["run", "{prompt}"],
      probeArgs: ["--version"],
      capabilities: [
        {
          kind: "code.write",
          description: "Write code through the locally authenticated OpenCode CLI.",
          hints: { languages: ["typescript", "python", "go", "javascript"] },
        },
        {
          kind: "code.refactor",
          description: "Refactor existing code through OpenCode's subprocess CLI path.",
        },
        {
          kind: "code.test",
          description: "Create or run tests through OpenCode while preserving CLI login reuse.",
        },
        {
          kind: "code.review",
          description: "Review code and implementation diffs through OpenCode CLI.",
        },
      ],
    }, options);
  }
}
