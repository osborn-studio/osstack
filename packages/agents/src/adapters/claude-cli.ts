import type { CostTier } from "@osstack/core";
import { SubprocessCliAdapter, type SubprocessCliOptions } from "./subprocess-cli.js";

const COST_TIER: CostTier = "high";

export class ClaudeCliAdapter extends SubprocessCliAdapter {
  constructor(options: SubprocessCliOptions = {}) {
    super({
      id: "claude-cli",
      displayName: "Claude CLI (login reuse)",
      costTier: COST_TIER,
      envBin: "OSSTACK_CLAUDE_CLI_BIN",
      defaultBin: "claude",
      envArgs: "OSSTACK_CLAUDE_CLI_ARGS",
      defaultArgs: ["--print", "{prompt}"],
      probeArgs: ["--version"],
      capabilities: [
        {
          kind: "code.write",
          description: "Write production code through the locally authenticated Claude CLI.",
          hints: { languages: ["typescript", "python", "rust", "go", "javascript"] },
        },
        {
          kind: "code.refactor",
          description: "Refactor existing code while reusing the user's Claude CLI login session.",
        },
        {
          kind: "code.test",
          description: "Add tests and verify local suites through the Claude CLI subprocess path.",
        },
        {
          kind: "code.review",
          description: "Review diffs and implementation plans through the Claude CLI subprocess path.",
        },
      ],
    }, options);
  }
}
