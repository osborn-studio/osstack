import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const source = readFileSync(
  new URL("../../../deploy/github-actions/osstack-verify.yml", import.meta.url),
  "utf8",
);
const { jobs, ...settings } = parse(source);
const pr = "${{ inputs.pr }}";
const head = "${{ needs.prepare.outputs.head }}";
const token = "${{ github.token }}";

describe("mission verification workflow template", () => {
  it("accepts only a PR number by dispatch and serializes runs for that input", () => {
    expect(settings).toEqual({
      name: expect.stringMatching(/^[^$]+$/),
      on: { workflow_dispatch: { inputs: { pr: { type: "string", required: true } } } },
      permissions: {},
      concurrency: { group: `osstack-verify-${pr}`, "cancel-in-progress": false },
    });
    expect(Object.keys(jobs).sort()).toEqual(["prepare", "report", "verify"]);
    expect(source).not.toMatch(/\bsecrets\s*(?:\.|\[)/i);
  });

  it("validates the live PR before writing its only output", () => {
    expect(jobs.prepare).toEqual({
      "runs-on": "ubuntu-latest",
      permissions: { "pull-requests": "read", contents: "read" },
      outputs: { head: "${{ steps.pr.outputs.head }}" },
      steps: [{
        name: expect.stringMatching(/^[^$]+$/),
        id: "pr",
        env: { GH_TOKEN: token, PR: pr },
        shell: "bash",
        run: expect.any(String),
      }],
    });
    // Keep the entire trusted script under review, including command order and error handling.
    expect(jobs.prepare.steps[0].run).toMatchInlineSnapshot(`
      "set -euo pipefail
      [[ "$PR" =~ ^[1-9][0-9]{0,8}$ ]] || exit 1
      head=$(gh api "repos/$GITHUB_REPOSITORY/pulls/$PR" | jq -er --arg repo "$GITHUB_REPOSITORY" '
        select(.state == "open" and .draft == false
          and .base.repo.full_name == $repo and .head.repo.full_name == .base.repo.full_name
          and (.head.ref | test("^osstack/mission/[A-Za-z0-9_.-]+\\\\z"))
          and (.base.repo.default_branch | type == "string" and length > 0)
          and .base.ref == .base.repo.default_branch)
        | .head.sha | select(test("^[0-9a-fA-F]{40}\\\\z"))
      ')
      printf 'head=%s\\n' "$head" >> "$GITHUB_OUTPUT"
      "
    `);
  });

  it("checks out and confirms the prepared head before running the isolated sandbox check", () => {
    const checkout = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
    expect(source.split("\n").filter((line) => /^\s*-?\s*uses:/.test(line)).map((line) => line.trim()))
      .toEqual([`- uses: ${checkout} # v7.0.1`]);
    expect(jobs.verify).toEqual({
      needs: "prepare",
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 30,
      permissions: { contents: "read" },
      steps: [
        {
          uses: checkout,
          with: { ref: head, "persist-credentials": false, "fetch-depth": 1 },
        },
        {
          name: expect.stringMatching(/^[^$]+$/),
          env: { EXPECTED_HEAD: head },
          run: 'test "$(git rev-parse HEAD)" = "$EXPECTED_HEAD"',
        },
        {
          name: "Repository verification (replace this step for another repository)",
          run: "test ! -e PROBE_FAIL",
        },
      ],
    });
  });

  it("posts one completed check using only trusted metadata and the verify job result", () => {
    expect(jobs.report).toEqual({
      needs: ["prepare", "verify"],
      if: "always() && needs.prepare.result == 'success'",
      "runs-on": "ubuntu-latest",
      permissions: { checks: "write" },
      steps: [{
        name: expect.stringMatching(/^[^$]+$/),
        env: { GH_TOKEN: token, PR: pr, HEAD_SHA: head, VERIFY_RESULT: "${{ needs.verify.result }}" },
        shell: "bash",
        run: expect.any(String),
      }],
    });
    expect(jobs.report.steps[0].run).toMatchInlineSnapshot(`
      "set -euo pipefail
      [[ "$PR" =~ ^[1-9][0-9]{0,8}$ ]] || exit 1
      conclusion=failure
      if [[ "$VERIFY_RESULT" == success ]]; then
        conclusion=success
      fi
      jq -n --arg head "$HEAD_SHA" --arg id "$PR:$HEAD_SHA" --arg conclusion "$conclusion" \\
        --arg summary "Workflow run $GITHUB_RUN_ID, attempt $GITHUB_RUN_ATTEMPT." \\
        '{name: "osstack/verify-actions", head_sha: $head, external_id: $id,
          status: "completed", conclusion: $conclusion,
          output: {title: "OSStack mission verification", summary: $summary}}' |
        gh api -X POST "repos/$GITHUB_REPOSITORY/check-runs" --input - --silent
      "
    `);
  });
});
