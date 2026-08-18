import { existsSync } from "node:fs";
import type { CostTier } from "@osstack/core";
import { SubprocessCliAdapter, type SubprocessCliOptions } from "./subprocess-cli.js";

const COST_TIER: CostTier = "mid";

// Z-Code desktop ships its CLI as a node script inside the app bundle instead
// of a PATH binary; when no explicit bin is configured we run it via the
// current node executable. OSSTACK_ZCODE_CLI_BIN (a wrapper script or a real
// `zcode` on PATH) still wins over this discovery.
const DEFAULT_APP_CJS = "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs";

function appBundleCjs(): string | undefined {
  const cjs = process.env["OSSTACK_ZCODE_APP_CJS"] ?? DEFAULT_APP_CJS;
  return existsSync(cjs) ? cjs : undefined;
}

export class ZCodeCliAdapter extends SubprocessCliAdapter {
  constructor(options: SubprocessCliOptions = {}) {
    const envBinSet = (process.env["OSSTACK_ZCODE_CLI_BIN"] ?? "").trim() !== "";
    const cjs = options.bin === undefined && !envBinSet ? appBundleCjs() : undefined;
    // When we launch through the app bundle, every arg list (probe included)
    // must lead with the script path; OSSTACK_ZCODE_CLI_ARGS overrides skip
    // this prefix, so pair them with OSSTACK_ZCODE_CLI_BIN instead.
    const prefix = cjs !== undefined ? [cjs] : [];
    super({
      id: "zcode-cli",
      displayName: "Z-Code CLI (GLM login reuse)",
      costTier: COST_TIER,
      envBin: "OSSTACK_ZCODE_CLI_BIN",
      defaultBin: cjs !== undefined ? process.execPath : "zcode",
      envArgs: "OSSTACK_ZCODE_CLI_ARGS",
      defaultArgs: [...prefix, "--mode", "yolo", "--prompt", "{prompt}"],
      probeArgs: [...prefix, "doctor"],
      capabilities: [
        {
          kind: "code.write",
          description: "Write code through the locally authenticated Z-Code CLI (GLM coding plan).",
          hints: { languages: ["typescript", "python", "go", "javascript"] },
        },
        {
          kind: "code.refactor",
          description: "Refactor existing code through Z-Code's headless subprocess path.",
        },
        {
          kind: "code.test",
          description: "Create or run tests through Z-Code while preserving CLI login reuse.",
        },
        {
          kind: "code.review",
          description: "Review code and implementation diffs through Z-Code CLI.",
        },
      ],
    }, options);
  }
}
