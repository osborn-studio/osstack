// docs/LOOP.md generator — the closed-loop contract template a repo declares.
// Kept generic but pre-filled with the repo's identity so it is immediately
// useful. Phase 7 expands the surrounding product documentation.

import type { RepoRegistryEntry } from "./types.js";

export function renderLoopDoc(entry: Pick<RepoRegistryEntry, "name" | "role" | "verify_commands">): string {
  const verify = entry.verify_commands.length > 0
    ? entry.verify_commands.map((command) => `- \`${command}\``).join("\n")
    : "- _(declare a deterministic verify command)_";

  return `# Closed Loop Contract

> Repo: ${entry.name} (${entry.role})

## Product/Repo Purpose
_What this repo/tool/skill/app is for._

## Inputs
_What the loop consumes._

## Judgments
_What quality means here._

## Actions
_What the loop may do._

## Verification
${verify}

## Feedback Assets
_Eval cases, pitfall lessons, knowledge memories, and runbook notes distilled from failed runs._

## Improvement Proposals
_Risk-rated changes derived from feedback assets (eval/test/docs = low, prompt/skill = medium, policy = high)._

## Self-Update Gates
- Low-risk changes may auto-apply only after deterministic gates pass.
- Prompt/skill changes require human approval.
- Policy/routing/evaluator changes require human approval and an anchor-case check.

## Human Approval Boundaries
- No destructive or irreversible action without human approval.
- No evaluator promotion without anchor cases.

## Metrics
_Loop success rate, cost, and domain outcome metrics._

## Evaluator Epochs
_Each evaluator version is frozen inside an epoch; challengers must beat the incumbent on anchor cases before promotion._

## Anchor Cases
_Human-reviewed reference cases used to keep evaluators honest._

## Adversarial Cases
_Cases where an evaluator disagreed with a human verdict._
`;
}
