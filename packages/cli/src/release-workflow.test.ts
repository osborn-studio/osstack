import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { trustedPublishingWorkflowViolations } from "./bin.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

describe("trustedPublishingWorkflowViolations", () => {
  it("accepts a tokenless Changesets publish step", () => {
    const workflow = `
      - name: Version PR / Publish
        uses: changesets/action@v1
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
    `;

    expect(trustedPublishingWorkflowViolations(workflow)).toEqual([]);
  });

  it.each(["NPM_TOKEN", "NODE_AUTH_TOKEN"])("rejects %s in the publish step", (tokenName) => {
    const workflow = `
      - name: Version PR / Publish
        uses: changesets/action@v1
        env:
          GITHUB_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          ${tokenName}: legacy-token
    `;

    expect(trustedPublishingWorkflowViolations(workflow)).toEqual([
      "Release publish step must not expose long-lived npm tokens when using Trusted Publishing.",
    ]);
  });

  it("keeps generated release artifacts and version-branch CI automatic", () => {
    const workflow = readFileSync(join(repoRoot, ".github/workflows/release.yml"), "utf8");
    const ciWorkflow = readFileSync(join(repoRoot, ".github/workflows/ci.yml"), "utf8");
    const manifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));

    expect(manifest.scripts["version:packages"]).toBe("node scripts/version-packages.mjs");
    expect(workflow).toContain("actions: write");
    expect(workflow).toContain("version: pnpm version:packages");
    expect(workflow).toContain("id: changesets");
    expect(workflow).toContain("gh workflow run ci.yml --ref changeset-release/main");
    expect(ciWorkflow).toContain("workflow_dispatch:");
  });
});
