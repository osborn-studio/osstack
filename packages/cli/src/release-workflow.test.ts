import { describe, expect, it } from "vitest";
import { trustedPublishingWorkflowViolations } from "./bin.js";

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
});
