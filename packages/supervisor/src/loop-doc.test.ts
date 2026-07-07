import { describe, expect, it } from "vitest";
import { renderLoopDoc } from "./loop-doc.js";

describe("renderLoopDoc", () => {
  it("renders the closed-loop contract with the repo identity and verify commands", () => {
    const doc = renderLoopDoc({
      name: "stock-monitor",
      role: "business_product",
      verify_commands: ["pnpm test", "pnpm typecheck"],
    });

    expect(doc).toContain("# Closed Loop Contract");
    expect(doc).toContain("> Repo: stock-monitor (business_product)");
    expect(doc).toContain("- `pnpm test`");
    expect(doc).toContain("- `pnpm typecheck`");
    // Every contract section the control plane relies on must be present.
    for (const heading of [
      "## Verification",
      "## Feedback Assets",
      "## Improvement Proposals",
      "## Self-Update Gates",
      "## Human Approval Boundaries",
      "## Evaluator Epochs",
      "## Anchor Cases",
      "## Adversarial Cases",
    ]) {
      expect(doc).toContain(heading);
    }
  });

  it("prompts for a verify command when the repo declares none", () => {
    const doc = renderLoopDoc({ name: "docs-site", role: "reference", verify_commands: [] });
    expect(doc).toContain("_(declare a deterministic verify command)_");
    // Even without gates, the human-approval boundaries must remain stated.
    expect(doc).toContain("No evaluator promotion without anchor cases.");
  });

  it("is deterministic — the same entry always renders identical text", () => {
    const entry = { name: "favis", role: "app" as const, verify_commands: ["pnpm test"] };
    expect(renderLoopDoc(entry)).toBe(renderLoopDoc(entry));
  });
});
